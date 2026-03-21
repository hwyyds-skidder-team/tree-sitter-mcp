import fs from "node:fs/promises";
import type { RuntimeConfig } from "../config/runtimeConfig.js";
import type { Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { IndexedFileSemanticRecord } from "../indexing/indexTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import { buildWorkspaceIndex } from "./buildWorkspaceIndex.js";
import {
  PersistedIndexedFileRecordSchema,
  PersistedIndexedFileRecordsSchema,
  type PersistedIndexedFileRecord,
} from "./collectIndexedFileSemantics.js";
import {
  createEmptyWorkspaceIndexSummary,
  summarizeWorkspaceIndexManifest,
  type FreshnessState,
  type WorkspaceIndexSummary,
  WorkspaceIndexSummarySchema,
} from "./indexTypes.js";
import {
  loadWorkspaceIndex as defaultLoadWorkspaceIndex,
  saveWorkspaceIndex as defaultSaveWorkspaceIndex,
  type LoadWorkspaceIndexResult,
} from "./indexStorage.js";
import { createWorkspaceFingerprint } from "./workspaceFingerprint.js";

export interface SemanticIndexWorkspaceInput {
  root: string;
  exclusions: string[];
}

export interface SemanticIndexCoordinatorDependencies {
  loadWorkspaceIndex?: typeof defaultLoadWorkspaceIndex;
  saveWorkspaceIndex?: typeof defaultSaveWorkspaceIndex;
  now?: () => string;
  onSummaryChange?: (summary: WorkspaceIndexSummary) => void;
}

export interface SemanticIndexCoordinator {
  loadPersistedIndex(): Promise<LoadWorkspaceIndexResult>;
  replaceWorkspace(workspace: SemanticIndexWorkspaceInput): WorkspaceIndexSummary;
  markBuilding(): WorkspaceIndexSummary;
  markFresh(records: IndexedFileSemanticRecord[]): Promise<WorkspaceIndexSummary>;
  markRefreshed(
    records: IndexedFileSemanticRecord[],
    degradedFiles?: string[],
  ): Promise<WorkspaceIndexSummary>;
  markDegraded(degradedFiles?: string[]): WorkspaceIndexSummary;
  ensureReady(context: ServerContext): Promise<WorkspaceIndexSummary>;
  ensureFresh(context: ServerContext): Promise<FreshRecordsResult>;
  getFreshRecords(context: ServerContext): Promise<FreshRecordsResult>;
  getSummary(): WorkspaceIndexSummary;
  clear(): WorkspaceIndexSummary;
}

interface ActiveWorkspaceState {
  root: string | null;
  exclusions: string[];
  fingerprint: string | null;
}

export interface FreshRecordsResult {
  records: PersistedIndexedFileRecord[];
  degradedFiles: string[];
  diagnostics: Diagnostic[];
  summary: WorkspaceIndexSummary;
}

function cloneRecords(records: PersistedIndexedFileRecord[]): PersistedIndexedFileRecord[] {
  return records.map((record) => ({
    ...record,
    symbols: [...record.symbols],
    definitions: [...record.definitions],
    references: [...record.references],
    diagnostics: [...record.diagnostics],
  }));
}

function normalizeDegradedFiles(degradedFiles: string[]): string[] {
  return [...new Set(
    degradedFiles
      .map((file) => file.trim())
      .filter((file) => file.length > 0),
  )].sort();
}

export function createSemanticIndexCoordinator(
  config: RuntimeConfig,
  dependencies: SemanticIndexCoordinatorDependencies = {},
): SemanticIndexCoordinator {
  const loadWorkspaceIndex = dependencies.loadWorkspaceIndex ?? defaultLoadWorkspaceIndex;
  const saveWorkspaceIndex = dependencies.saveWorkspaceIndex ?? defaultSaveWorkspaceIndex;
  const now = dependencies.now ?? (() => new Date().toISOString());

  let activeWorkspace: ActiveWorkspaceState = {
    root: null,
    exclusions: [],
    fingerprint: null,
  };
  let records: PersistedIndexedFileRecord[] = [];
  let degradedFiles: string[] = [];
  let lastBuiltAt: string | null = null;
  let lastRefreshedAt: string | null = null;
  let summary: WorkspaceIndexSummary = createEmptyWorkspaceIndexSummary();
  let readyPromise: Promise<WorkspaceIndexSummary> | null = null;
  let refreshPromise: Promise<FreshRecordsResult> | null = null;

  function publishSummary(nextSummary: WorkspaceIndexSummary): WorkspaceIndexSummary {
    summary = WorkspaceIndexSummarySchema.parse(nextSummary);
    dependencies.onSummaryChange?.({ ...summary });
    return { ...summary };
  }

  function getWorkspaceFingerprint(): string {
    if (activeWorkspace.root === null || activeWorkspace.fingerprint === null) {
      throw new Error("Semantic index workspace is not configured.");
    }

    return activeWorkspace.fingerprint;
  }

  function createSummary(
    state: WorkspaceIndexSummary["state"],
    indexedFileCount: number,
  ): WorkspaceIndexSummary {
    return {
      enabled: true,
      storageMode: "disk",
      state,
      workspaceFingerprint: activeWorkspace.fingerprint,
      indexedFileCount,
      degradedFileCount: degradedFiles.length,
      lastBuiltAt,
      lastRefreshedAt,
    };
  }

  function syncActiveWorkspace(context: Pick<ServerContext, "workspace">): void {
    if (!context.workspace.root) {
      return;
    }

    const workspaceFingerprint = createWorkspaceFingerprint({
      root: context.workspace.root,
      exclusions: context.workspace.exclusions,
      indexSchemaVersion: config.indexSchemaVersion,
    });

    if (activeWorkspace.fingerprint === workspaceFingerprint) {
      return;
    }

    coordinator.replaceWorkspace({
      root: context.workspace.root,
      exclusions: context.workspace.exclusions,
    });
  }

  async function persistRecords(
    state: "fresh" | "refreshed",
    nextRecordsInput: IndexedFileSemanticRecord[],
    nextDegradedFiles: string[] = [],
  ): Promise<WorkspaceIndexSummary> {
    const persistedAt = now();
    const nextRecords = nextRecordsInput.map((record) => normalizePersistedRecord(record, persistedAt));

    if (state === "fresh") {
      lastBuiltAt = persistedAt;
      lastRefreshedAt = null;
    } else {
      lastBuiltAt ??= persistedAt;
      lastRefreshedAt = persistedAt;
    }

    degradedFiles = normalizeDegradedFiles(nextDegradedFiles);
    records = cloneRecords(nextRecords);
    const persistedState: FreshnessState = state === "fresh"
      ? "fresh"
      : degradedFiles.length > 0
        ? "degraded"
        : "refreshed";

    try {
      const location = await saveWorkspaceIndex(config, {
        manifest: {
          schemaVersion: config.indexSchemaVersion,
          workspaceFingerprint: getWorkspaceFingerprint(),
          workspaceRoot: activeWorkspace.root ?? "",
          exclusions: [...activeWorkspace.exclusions],
          lastBuiltAt,
          lastRefreshedAt,
          state: persistedState,
          indexedFileCount: records.length,
          degradedFiles: [...degradedFiles],
        },
        records: records.map(projectLegacyRecord),
      });
      await fs.writeFile(location.recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

      return publishSummary(createSummary(persistedState, records.length));
    } catch {
      return coordinator.markDegraded(records.map((record) => record.relativePath));
    }
  }

  const coordinator: SemanticIndexCoordinator = {
    async loadPersistedIndex(): Promise<LoadWorkspaceIndexResult> {
      const result = await loadWorkspaceIndex(config, getWorkspaceFingerprint());

      if (result.status === "loaded") {
        try {
          const rawRecords = JSON.parse(await fs.readFile(result.recordsPath, "utf8")) as unknown;
          records = cloneRecords(PersistedIndexedFileRecordsSchema.parse(rawRecords));
        } catch (error) {
          records = [];
          degradedFiles = [];
          lastBuiltAt = null;
          lastRefreshedAt = null;
          publishSummary(createSummary("rebuilding", 0));

          return {
            status: "invalid",
            reason: error instanceof Error ? error.message : String(error),
            directory: result.directory,
            manifestPath: result.manifestPath,
            recordsPath: result.recordsPath,
          };
        }

        degradedFiles = normalizeDegradedFiles(result.manifest.degradedFiles);
        lastBuiltAt = result.manifest.lastBuiltAt;
        lastRefreshedAt = result.manifest.lastRefreshedAt;
        publishSummary(summarizeWorkspaceIndexManifest(result.manifest));
        return result;
      }

      records = [];
      degradedFiles = [];
      lastBuiltAt = null;
      lastRefreshedAt = null;
      publishSummary(createSummary("rebuilding", 0));

      return result;
    },

    replaceWorkspace(workspace: SemanticIndexWorkspaceInput): WorkspaceIndexSummary {
      const fingerprint = createWorkspaceFingerprint({
        root: workspace.root,
        exclusions: workspace.exclusions,
        indexSchemaVersion: config.indexSchemaVersion,
      });

      if (activeWorkspace.fingerprint === fingerprint) {
        activeWorkspace = {
          root: workspace.root,
          exclusions: [...workspace.exclusions],
          fingerprint,
        };
        return publishSummary(createSummary(summary.state, records.length));
      }

      activeWorkspace = {
        root: workspace.root,
        exclusions: [...workspace.exclusions],
        fingerprint,
      };
      records = [];
      degradedFiles = [];
      lastBuiltAt = null;
      lastRefreshedAt = null;

      return coordinator.markBuilding();
    },

    markBuilding(): WorkspaceIndexSummary {
      return publishSummary(createSummary("rebuilding", records.length));
    },

    async markFresh(nextRecords: IndexedFileSemanticRecord[]): Promise<WorkspaceIndexSummary> {
      return persistRecords("fresh", nextRecords);
    },

    async markRefreshed(
      nextRecords: IndexedFileSemanticRecord[],
      nextDegradedFiles: string[] = [],
    ): Promise<WorkspaceIndexSummary> {
      return persistRecords("refreshed", nextRecords, nextDegradedFiles);
    },

    markDegraded(nextDegradedFiles: string[] = records.map((record) => record.relativePath)): WorkspaceIndexSummary {
      degradedFiles = normalizeDegradedFiles(nextDegradedFiles);
      return publishSummary(createSummary("degraded", records.length));
    },

    async ensureReady(context: ServerContext): Promise<WorkspaceIndexSummary> {
      syncActiveWorkspace(context);

      if (activeWorkspace.root === null) {
        return coordinator.getSummary();
      }

      if (records.length > 0 && summary.state !== "rebuilding") {
        return coordinator.getSummary();
      }

      if (readyPromise) {
        return readyPromise;
      }

      readyPromise = (async () => {
        const loadResult = await coordinator.loadPersistedIndex();
        if (loadResult.status === "loaded" && records.length > 0) {
          return coordinator.getSummary();
        }

        const buildResult = await buildWorkspaceIndex(context);
        return buildResult.summary;
      })();

      try {
        return await readyPromise;
      } finally {
        readyPromise = null;
      }
    },

    async ensureFresh(context: ServerContext): Promise<FreshRecordsResult> {
      syncActiveWorkspace(context);
      await coordinator.ensureReady(context);

      if (refreshPromise) {
        return refreshPromise;
      }

      refreshPromise = (async () => {
        const { refreshWorkspaceIndex } = await import("./refreshWorkspaceIndex.js");
        const refreshResult = await refreshWorkspaceIndex(context, records);

        return {
          records: cloneRecords(refreshResult.records),
          degradedFiles: [...refreshResult.degradedFiles],
          diagnostics: collectDiagnostics(refreshResult.records),
          summary: refreshResult.summary,
        };
      })();

      try {
        return await refreshPromise;
      } finally {
        refreshPromise = null;
      }
    },

    async getFreshRecords(context: ServerContext): Promise<FreshRecordsResult> {
      return coordinator.ensureFresh(context);
    },

    getSummary(): WorkspaceIndexSummary {
      return { ...summary };
    },

    clear(): WorkspaceIndexSummary {
      activeWorkspace = {
        root: null,
        exclusions: [],
        fingerprint: null,
      };
      records = [];
      degradedFiles = [];
      lastBuiltAt = null;
      lastRefreshedAt = null;
      readyPromise = null;
      refreshPromise = null;
      return publishSummary(createEmptyWorkspaceIndexSummary());
    },
  };

  return coordinator;
}

function normalizePersistedRecord(
  record: IndexedFileSemanticRecord,
  persistedAt: string,
): PersistedIndexedFileRecord {
  const candidate = record as Partial<PersistedIndexedFileRecord>;
  return PersistedIndexedFileRecordSchema.parse({
    path: record.path,
    relativePath: record.relativePath,
    languageId: record.languageId,
    grammarName: record.grammarName,
    contentHash: record.contentHash,
    symbolCount: candidate.symbolCount ?? candidate.symbols?.length ?? 0,
    updatedAt: candidate.updatedAt ?? persistedAt,
    mtimeMs: candidate.mtimeMs ?? 0,
    sizeBytes: candidate.sizeBytes ?? 0,
    symbols: candidate.symbols ?? [],
    definitions: candidate.definitions ?? [],
    references: candidate.references ?? [],
    diagnostics: candidate.diagnostics ?? [],
  });
}

function projectLegacyRecord(record: PersistedIndexedFileRecord): IndexedFileSemanticRecord {
  return {
    path: record.path,
    relativePath: record.relativePath,
    languageId: record.languageId,
    grammarName: record.grammarName,
    contentHash: record.contentHash,
    symbolCount: record.symbolCount,
    updatedAt: record.updatedAt,
  };
}

function collectDiagnostics(records: readonly PersistedIndexedFileRecord[]): Diagnostic[] {
  return records.flatMap((record) => record.diagnostics);
}
