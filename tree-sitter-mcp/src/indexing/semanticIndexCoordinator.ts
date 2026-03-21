import type { RuntimeConfig } from "../config/runtimeConfig.js";
import {
  createEmptyWorkspaceIndexSummary,
  type IndexedFileSemanticRecord,
  summarizeWorkspaceIndexManifest,
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
  markRefreshed(records: IndexedFileSemanticRecord[]): Promise<WorkspaceIndexSummary>;
  markDegraded(degradedFiles?: string[]): WorkspaceIndexSummary;
  getSummary(): WorkspaceIndexSummary;
  clear(): WorkspaceIndexSummary;
}

interface ActiveWorkspaceState {
  root: string | null;
  exclusions: string[];
  fingerprint: string | null;
}

function cloneRecords(records: IndexedFileSemanticRecord[]): IndexedFileSemanticRecord[] {
  return records.map((record) => ({ ...record }));
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
  let records: IndexedFileSemanticRecord[] = [];
  let degradedFiles: string[] = [];
  let lastBuiltAt: string | null = null;
  let lastRefreshedAt: string | null = null;
  let summary: WorkspaceIndexSummary = createEmptyWorkspaceIndexSummary();

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

  async function persistRecords(
    state: "fresh" | "refreshed",
    nextRecords: IndexedFileSemanticRecord[],
  ): Promise<WorkspaceIndexSummary> {
    const persistedAt = now();

    if (state === "fresh") {
      lastBuiltAt = persistedAt;
      lastRefreshedAt = null;
    } else {
      lastBuiltAt ??= persistedAt;
      lastRefreshedAt = persistedAt;
    }

    degradedFiles = [];
    records = cloneRecords(nextRecords);

    try {
      await saveWorkspaceIndex(config, {
        manifest: {
          schemaVersion: config.indexSchemaVersion,
          workspaceFingerprint: getWorkspaceFingerprint(),
          workspaceRoot: activeWorkspace.root ?? "",
          exclusions: [...activeWorkspace.exclusions],
          lastBuiltAt,
          lastRefreshedAt,
          state,
          indexedFileCount: records.length,
          degradedFiles: [...degradedFiles],
        },
        records,
      });

      return publishSummary(createSummary(state, records.length));
    } catch {
      return coordinator.markDegraded(records.map((record) => record.relativePath));
    }
  }

  const coordinator: SemanticIndexCoordinator = {
    async loadPersistedIndex(): Promise<LoadWorkspaceIndexResult> {
      const result = await loadWorkspaceIndex(config, getWorkspaceFingerprint());

      if (result.status === "loaded") {
        records = cloneRecords(result.records);
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
      activeWorkspace = {
        root: workspace.root,
        exclusions: [...workspace.exclusions],
        fingerprint: createWorkspaceFingerprint({
          root: workspace.root,
          exclusions: workspace.exclusions,
          indexSchemaVersion: config.indexSchemaVersion,
        }),
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

    async markRefreshed(nextRecords: IndexedFileSemanticRecord[]): Promise<WorkspaceIndexSummary> {
      return persistRecords("refreshed", nextRecords);
    },

    markDegraded(nextDegradedFiles: string[] = records.map((record) => record.relativePath)): WorkspaceIndexSummary {
      degradedFiles = normalizeDegradedFiles(nextDegradedFiles);
      return publishSummary(createSummary("degraded", records.length));
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
      return publishSummary(createEmptyWorkspaceIndexSummary());
    },
  };

  return coordinator;
}
