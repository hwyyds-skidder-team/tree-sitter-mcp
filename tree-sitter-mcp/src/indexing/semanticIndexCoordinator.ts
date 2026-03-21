import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { RuntimeConfig } from "../config/runtimeConfig.js";
import type { Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { IndexedFileSemanticRecord } from "../indexing/indexTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import { buildWorkspaceIndex } from "./buildWorkspaceIndex.js";
import {
  createWorkspaceRecordKey,
  parseWorkspaceRecordKey,
  PersistedIndexedFileRecordSchema,
  PersistedIndexedFileRecordsSchema,
  resolveIndexedRecordWorkspaceRoot,
  type PersistedIndexedFileRecord,
} from "./collectIndexedFileSemantics.js";
import {
  createEmptyWorkspaceIndexSummary,
  createSearchFreshness,
  summarizeWorkspaceIndexManifest,
  type FreshnessState,
  type SearchFreshness,
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
  replaceWorkspaces(workspaces: SemanticIndexWorkspaceInput[]): WorkspaceIndexSummary;
  markBuilding(): WorkspaceIndexSummary;
  markFresh(
    records: IndexedFileSemanticRecord[],
    workspaceRoots?: readonly string[],
  ): Promise<WorkspaceIndexSummary>;
  markRefreshed(
    records: IndexedFileSemanticRecord[],
    degradedFiles?: string[],
    workspaceRoots?: readonly string[],
  ): Promise<WorkspaceIndexSummary>;
  markDegraded(degradedFiles?: string[]): WorkspaceIndexSummary;
  ensureReady(context: ServerContext): Promise<WorkspaceIndexSummary>;
  ensureFresh(context: ServerContext): Promise<FreshRecordsResult>;
  getFreshRecords(context: ServerContext): Promise<FreshRecordsResult>;
  getLastLoadResult(): LoadWorkspaceIndexResult | null;
  getLastLoadResults(): Array<{ root: string; result: LoadWorkspaceIndexResult | null }>;
  getWorkspaceSummaries(): Array<{ root: string; summary: WorkspaceIndexSummary }>;
  getSummary(): WorkspaceIndexSummary;
  clear(): WorkspaceIndexSummary;
}

interface ActiveWorkspaceState {
  root: string;
  exclusions: string[];
  fingerprint: string;
  records: PersistedIndexedFileRecord[];
  degradedFiles: string[];
  lastBuiltAt: string | null;
  lastRefreshedAt: string | null;
  summary: WorkspaceIndexSummary;
  lastLoadResult: LoadWorkspaceIndexResult | null;
}

export interface FreshRecordsResult {
  records: PersistedIndexedFileRecord[];
  refreshedFiles: string[];
  degradedFiles: string[];
  checkedAt: string;
  freshness: SearchFreshness;
  diagnostics: Diagnostic[];
  summary: WorkspaceIndexSummary;
}

function cloneRecords(records: readonly PersistedIndexedFileRecord[]): PersistedIndexedFileRecord[] {
  return records.map((record) => ({
    ...record,
    symbols: [...record.symbols],
    definitions: [...record.definitions],
    references: [...record.references],
    diagnostics: [...record.diagnostics],
  }));
}

function normalizeRelativePaths(relativePaths: string[]): string[] {
  return [...new Set(
    relativePaths
      .map((file) => file.trim())
      .filter((file) => file.length > 0),
  )].sort();
}

function createWorkspaceState(
  workspace: SemanticIndexWorkspaceInput,
  fingerprint: string,
  existing?: ActiveWorkspaceState,
): ActiveWorkspaceState {
  if (existing) {
    return {
      ...existing,
      root: workspace.root,
      exclusions: [...workspace.exclusions],
      fingerprint,
      records: cloneRecords(existing.records),
      degradedFiles: [...existing.degradedFiles],
      summary: { ...existing.summary, workspaceFingerprint: fingerprint },
    };
  }

  const nextWorkspace: ActiveWorkspaceState = {
    root: workspace.root,
    exclusions: [...workspace.exclusions],
    fingerprint,
    records: [],
    degradedFiles: [],
    lastBuiltAt: null,
    lastRefreshedAt: null,
    summary: createEmptyWorkspaceIndexSummary(),
    lastLoadResult: null,
  };
  nextWorkspace.summary = createWorkspaceSummary(nextWorkspace, "rebuilding");
  return nextWorkspace;
}

function createWorkspaceSummary(
  workspace: ActiveWorkspaceState,
  state: WorkspaceIndexSummary["state"],
): WorkspaceIndexSummary {
  return {
    enabled: true,
    indexMode: "persistent_disk",
    storageMode: "disk",
    state,
    workspaceFingerprint: workspace.fingerprint,
    indexedFileCount: workspace.records.length,
    degradedFileCount: workspace.degradedFiles.length,
    lastBuiltAt: workspace.lastBuiltAt,
    lastRefreshedAt: workspace.lastRefreshedAt,
  };
}

function summarizeAggregateState(states: WorkspaceIndexSummary["state"][]): WorkspaceIndexSummary["state"] {
  if (states.length === 0) {
    return "rebuilding";
  }

  if (states.includes("rebuilding")) {
    return "rebuilding";
  }

  if (states.includes("degraded")) {
    return "degraded";
  }

  if (states.includes("refreshed")) {
    return "refreshed";
  }

  return "fresh";
}

function latestTimestamp(values: Array<string | null>): string | null {
  const normalized = values.filter((value): value is string => Boolean(value)).sort();
  return normalized.at(-1) ?? null;
}

function createAggregateWorkspaceFingerprint(workspaces: readonly ActiveWorkspaceState[]): string | null {
  if (workspaces.length === 0) {
    return null;
  }

  if (workspaces.length === 1) {
    return workspaces[0].summary.workspaceFingerprint;
  }

  return createHash("sha1")
    .update(JSON.stringify(workspaces.map((workspace) => workspace.fingerprint)))
    .digest("hex");
}

function createAggregateSummary(workspaces: readonly ActiveWorkspaceState[]): WorkspaceIndexSummary {
  if (workspaces.length === 0) {
    return createEmptyWorkspaceIndexSummary();
  }

  return {
    enabled: true,
    indexMode: "persistent_disk",
    storageMode: "disk",
    state: summarizeAggregateState(workspaces.map((workspace) => workspace.summary.state)),
    workspaceFingerprint: createAggregateWorkspaceFingerprint(workspaces),
    indexedFileCount: workspaces.reduce(
      (sum, workspace) => sum + workspace.summary.indexedFileCount,
      0,
    ),
    degradedFileCount: workspaces.reduce(
      (sum, workspace) => sum + workspace.summary.degradedFileCount,
      0,
    ),
    lastBuiltAt: latestTimestamp(workspaces.map((workspace) => workspace.summary.lastBuiltAt)),
    lastRefreshedAt: latestTimestamp(workspaces.map((workspace) => workspace.summary.lastRefreshedAt)),
  };
}

function groupRecordsByWorkspaceRoot(
  records: readonly IndexedFileSemanticRecord[],
): Map<string, IndexedFileSemanticRecord[]> {
  const grouped = new Map<string, IndexedFileSemanticRecord[]>();

  for (const record of records) {
    const workspaceRoot = resolveIndexedRecordWorkspaceRoot(record as PersistedIndexedFileRecord);
    const existing = grouped.get(workspaceRoot);
    if (existing) {
      existing.push(record);
      continue;
    }

    grouped.set(workspaceRoot, [record]);
  }

  return grouped;
}

function groupDegradedFilesByWorkspaceRoot(
  degradedFiles: readonly string[],
  workspaces: readonly ActiveWorkspaceState[],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  const fallbackRoot = workspaces[0]?.root ?? null;
  const workspaceRoots = new Set(workspaces.map((workspace) => workspace.root));

  for (const degradedFile of degradedFiles) {
    const trimmedFile = degradedFile.trim();
    if (trimmedFile.length === 0) {
      continue;
    }

    try {
      const parsed = parseWorkspaceRecordKey(trimmedFile);
      if (workspaceRoots.has(parsed.workspaceRoot)) {
        const existing = grouped.get(parsed.workspaceRoot) ?? [];
        existing.push(parsed.relativePath);
        grouped.set(parsed.workspaceRoot, existing);
        continue;
      }
    } catch {
      // Fall through to single-workspace compatibility.
    }

    if (fallbackRoot) {
      const existing = grouped.get(fallbackRoot) ?? [];
      existing.push(trimmedFile);
      grouped.set(fallbackRoot, existing);
    }
  }

  for (const [root, relativePaths] of grouped) {
    grouped.set(root, normalizeRelativePaths(relativePaths));
  }

  return grouped;
}

function resolveTargetRoots(
  workspaces: readonly ActiveWorkspaceState[],
  groupedRecords: ReadonlyMap<string, IndexedFileSemanticRecord[]>,
  workspaceRoots?: readonly string[],
): string[] {
  if (workspaceRoots && workspaceRoots.length > 0) {
    return [...workspaceRoots];
  }

  if (groupedRecords.size > 0) {
    return [...groupedRecords.keys()];
  }

  return workspaces.map((workspace) => workspace.root);
}

function sortRecordsByWorkspaceOrder(
  records: PersistedIndexedFileRecord[],
  workspaceRoots: readonly string[],
): void {
  const workspaceOrder = new Map(workspaceRoots.map((root, index) => [root, index] as const));

  records.sort((left, right) => {
    const leftRoot = resolveIndexedRecordWorkspaceRoot(left);
    const rightRoot = resolveIndexedRecordWorkspaceRoot(right);
    const rootOrder = (workspaceOrder.get(leftRoot) ?? Number.MAX_SAFE_INTEGER)
      - (workspaceOrder.get(rightRoot) ?? Number.MAX_SAFE_INTEGER);

    if (rootOrder !== 0) {
      return rootOrder;
    }

    return left.relativePath.localeCompare(right.relativePath);
  });
}

export function createSemanticIndexCoordinator(
  config: RuntimeConfig,
  dependencies: SemanticIndexCoordinatorDependencies = {},
): SemanticIndexCoordinator {
  const loadWorkspaceIndex = dependencies.loadWorkspaceIndex ?? defaultLoadWorkspaceIndex;
  const saveWorkspaceIndex = dependencies.saveWorkspaceIndex ?? defaultSaveWorkspaceIndex;
  const now = dependencies.now ?? (() => new Date().toISOString());

  let activeWorkspaces: ActiveWorkspaceState[] = [];
  let summary: WorkspaceIndexSummary = createEmptyWorkspaceIndexSummary();
  let readyPromise: Promise<WorkspaceIndexSummary> | null = null;
  let refreshPromise: Promise<FreshRecordsResult> | null = null;

  function publishSummary(nextSummary: WorkspaceIndexSummary): WorkspaceIndexSummary {
    summary = WorkspaceIndexSummarySchema.parse(nextSummary);
    dependencies.onSummaryChange?.({ ...summary });
    return { ...summary };
  }

  function publishCurrentSummary(): WorkspaceIndexSummary {
    return publishSummary(createAggregateSummary(activeWorkspaces));
  }

  function syncActiveWorkspaces(context: Pick<ServerContext, "workspace">): void {
    const configuredRoots = context.workspace.roots.length > 0
      ? context.workspace.roots
      : context.workspace.root
        ? [context.workspace.root]
        : [];
    const nextWorkspaces = configuredRoots.map((root) => ({
      root,
      exclusions: [...context.workspace.exclusions],
    }));
    const currentFingerprints = activeWorkspaces.map((workspace) => workspace.fingerprint);
    const nextFingerprints = nextWorkspaces.map((workspace) => createWorkspaceFingerprint({
      root: workspace.root,
      exclusions: workspace.exclusions,
      indexSchemaVersion: config.indexSchemaVersion,
    }));

    const unchanged = currentFingerprints.length === nextFingerprints.length
      && currentFingerprints.every((fingerprint, index) => fingerprint === nextFingerprints[index]);

    if (unchanged) {
      return;
    }

    coordinator.replaceWorkspaces(nextWorkspaces);
  }

  function getRecordsInOrder(): PersistedIndexedFileRecord[] {
    const records = activeWorkspaces.flatMap((workspace) => cloneRecords(workspace.records));
    sortRecordsByWorkspaceOrder(records, activeWorkspaces.map((workspace) => workspace.root));
    return records;
  }

  async function loadWorkspaceState(
    workspace: ActiveWorkspaceState,
  ): Promise<LoadWorkspaceIndexResult> {
    const result = await loadWorkspaceIndex(config, workspace.fingerprint);
    workspace.lastLoadResult = result;

    if (result.status === "loaded") {
      try {
        const rawRecords = JSON.parse(await fs.readFile(result.recordsPath, "utf8")) as unknown;
        const parsedRecords = PersistedIndexedFileRecordsSchema.parse(rawRecords).map((record) => ({
          ...record,
          workspaceRoot: record.workspaceRoot ?? workspace.root,
        }));
        workspace.records = cloneRecords(parsedRecords);
      } catch (error) {
        workspace.records = [];
        workspace.degradedFiles = [];
        workspace.lastBuiltAt = null;
        workspace.lastRefreshedAt = null;
        workspace.summary = createWorkspaceSummary(workspace, "rebuilding");

        workspace.lastLoadResult = {
          status: "invalid",
          reason: error instanceof Error ? error.message : String(error),
          directory: result.directory,
          manifestPath: result.manifestPath,
          recordsPath: result.recordsPath,
        };
        return workspace.lastLoadResult;
      }

      workspace.degradedFiles = normalizeRelativePaths(result.manifest.degradedFiles);
      workspace.lastBuiltAt = result.manifest.lastBuiltAt;
      workspace.lastRefreshedAt = result.manifest.lastRefreshedAt;
      workspace.summary = summarizeWorkspaceIndexManifest(result.manifest);
      workspace.summary.workspaceFingerprint = workspace.fingerprint;
      return result;
    }

    workspace.records = [];
    workspace.degradedFiles = [];
    workspace.lastBuiltAt = null;
    workspace.lastRefreshedAt = null;
    workspace.summary = createWorkspaceSummary(workspace, "rebuilding");
    return result;
  }

  async function persistWorkspaceRecords(
    workspace: ActiveWorkspaceState,
    state: "fresh" | "refreshed",
    nextRecordsInput: readonly IndexedFileSemanticRecord[],
    nextDegradedFiles: string[] = [],
  ): Promise<void> {
    const persistedAt = now();
    const nextRecords = nextRecordsInput.map((record) => normalizePersistedRecord(record, workspace.root, persistedAt));

    if (state === "fresh") {
      workspace.lastBuiltAt = persistedAt;
      workspace.lastRefreshedAt = null;
    } else {
      workspace.lastBuiltAt ??= persistedAt;
      workspace.lastRefreshedAt = persistedAt;
    }

    workspace.degradedFiles = normalizeRelativePaths(nextDegradedFiles);
    workspace.records = cloneRecords(nextRecords);
    const persistedState: FreshnessState = state === "fresh"
      ? "fresh"
      : workspace.degradedFiles.length > 0
        ? "degraded"
        : "refreshed";

    try {
      const location = await saveWorkspaceIndex(config, {
        manifest: {
          schemaVersion: config.indexSchemaVersion,
          workspaceFingerprint: workspace.fingerprint,
          workspaceRoot: workspace.root,
          exclusions: [...workspace.exclusions],
          lastBuiltAt: workspace.lastBuiltAt,
          lastRefreshedAt: workspace.lastRefreshedAt,
          state: persistedState,
          indexedFileCount: workspace.records.length,
          degradedFiles: [...workspace.degradedFiles],
        },
        records: workspace.records.map(projectLegacyRecord),
      });
      await fs.writeFile(location.recordsPath, `${JSON.stringify(workspace.records, null, 2)}\n`, "utf8");
      workspace.summary = createWorkspaceSummary(workspace, persistedState);
    } catch {
      workspace.degradedFiles = normalizeRelativePaths(workspace.records.map((record) => record.relativePath));
      workspace.summary = createWorkspaceSummary(workspace, "degraded");
    }
  }

  const coordinator: SemanticIndexCoordinator = {
    async loadPersistedIndex(): Promise<LoadWorkspaceIndexResult> {
      if (activeWorkspaces.length === 0) {
        throw new Error("Semantic index workspace is not configured.");
      }

      let firstResult: LoadWorkspaceIndexResult | null = null;
      for (const workspace of activeWorkspaces) {
        const result = await loadWorkspaceState(workspace);
        firstResult ??= result;
      }

      publishCurrentSummary();
      return firstResult ?? await loadWorkspaceState(activeWorkspaces[0]);
    },

    replaceWorkspace(workspace: SemanticIndexWorkspaceInput): WorkspaceIndexSummary {
      return coordinator.replaceWorkspaces([workspace]);
    },

    replaceWorkspaces(workspaces: SemanticIndexWorkspaceInput[]): WorkspaceIndexSummary {
      const previousByFingerprint = new Map(
        activeWorkspaces.map((workspace) => [workspace.fingerprint, workspace] as const),
      );

      activeWorkspaces = workspaces.map((workspace) => {
        const fingerprint = createWorkspaceFingerprint({
          root: workspace.root,
          exclusions: workspace.exclusions,
          indexSchemaVersion: config.indexSchemaVersion,
        });

        return createWorkspaceState(workspace, fingerprint, previousByFingerprint.get(fingerprint));
      });

      readyPromise = null;
      refreshPromise = null;

      return publishCurrentSummary();
    },

    markBuilding(): WorkspaceIndexSummary {
      activeWorkspaces = activeWorkspaces.map((workspace) => ({
        ...workspace,
        summary: createWorkspaceSummary(workspace, "rebuilding"),
      }));

      return publishCurrentSummary();
    },

    async markFresh(
      nextRecords: IndexedFileSemanticRecord[],
      workspaceRoots?: readonly string[],
    ): Promise<WorkspaceIndexSummary> {
      const groupedRecords = groupRecordsByWorkspaceRoot(nextRecords);
      const targetRoots = new Set(resolveTargetRoots(activeWorkspaces, groupedRecords, workspaceRoots));

      for (const workspace of activeWorkspaces) {
        if (!targetRoots.has(workspace.root)) {
          continue;
        }

        await persistWorkspaceRecords(workspace, "fresh", groupedRecords.get(workspace.root) ?? []);
      }

      return publishCurrentSummary();
    },

    async markRefreshed(
      nextRecords: IndexedFileSemanticRecord[],
      nextDegradedFiles: string[] = [],
      workspaceRoots?: readonly string[],
    ): Promise<WorkspaceIndexSummary> {
      const groupedRecords = groupRecordsByWorkspaceRoot(nextRecords);
      const groupedDegradedFiles = groupDegradedFilesByWorkspaceRoot(nextDegradedFiles, activeWorkspaces);
      const targetRoots = new Set(resolveTargetRoots(activeWorkspaces, groupedRecords, workspaceRoots));

      for (const workspace of activeWorkspaces) {
        if (!targetRoots.has(workspace.root)) {
          continue;
        }

        await persistWorkspaceRecords(
          workspace,
          "refreshed",
          groupedRecords.get(workspace.root) ?? [],
          groupedDegradedFiles.get(workspace.root) ?? [],
        );
      }

      return publishCurrentSummary();
    },

    markDegraded(
      nextDegradedFiles: string[] = activeWorkspaces.flatMap((workspace) => workspace.records.map((record) => createWorkspaceRecordKey(record))),
    ): WorkspaceIndexSummary {
      const groupedDegradedFiles = groupDegradedFilesByWorkspaceRoot(nextDegradedFiles, activeWorkspaces);

      activeWorkspaces = activeWorkspaces.map((workspace) => {
        workspace.degradedFiles = groupedDegradedFiles.get(workspace.root)
          ?? normalizeRelativePaths(workspace.records.map((record) => record.relativePath));
        workspace.summary = createWorkspaceSummary(workspace, "degraded");
        return workspace;
      });

      return publishCurrentSummary();
    },

    async ensureReady(context: ServerContext): Promise<WorkspaceIndexSummary> {
      syncActiveWorkspaces(context);

      if (activeWorkspaces.length === 0) {
        return coordinator.getSummary();
      }

      if (activeWorkspaces.every((workspace) => workspace.summary.state !== "rebuilding")) {
        return coordinator.getSummary();
      }

      if (readyPromise) {
        return readyPromise;
      }

      readyPromise = (async () => {
        for (const workspace of activeWorkspaces) {
          if (workspace.summary.state !== "rebuilding") {
            continue;
          }

          const loadResult = await loadWorkspaceState(workspace);
          publishCurrentSummary();

          if (loadResult.status === "loaded") {
            continue;
          }

          await buildWorkspaceIndex(context, [workspace.root]);
        }

        return coordinator.getSummary();
      })();

      try {
        return await readyPromise;
      } finally {
        readyPromise = null;
      }
    },

    async ensureFresh(context: ServerContext): Promise<FreshRecordsResult> {
      syncActiveWorkspaces(context);
      await coordinator.ensureReady(context);

      if (refreshPromise) {
        return refreshPromise;
      }

      refreshPromise = (async () => {
        const checkedAt = now();
        const { refreshWorkspaceIndex } = await import("./refreshWorkspaceIndex.js");
        const refreshResult = await refreshWorkspaceIndex(context, getRecordsInOrder());
        const freshness = createSearchFreshness({
          state: summarizeFreshnessState(refreshResult),
          checkedAt,
          refreshedFiles: [...refreshResult.refreshedFiles],
          degradedFiles: [...refreshResult.degradedFiles],
          workspaceFingerprint: refreshResult.summary.workspaceFingerprint,
        });

        return {
          records: getRecordsInOrder(),
          refreshedFiles: [...refreshResult.refreshedFiles],
          degradedFiles: [...refreshResult.degradedFiles],
          checkedAt,
          freshness,
          diagnostics: collectDiagnostics(getRecordsInOrder()),
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

    getLastLoadResult(): LoadWorkspaceIndexResult | null {
      return activeWorkspaces[0]?.lastLoadResult ?? null;
    },

    getLastLoadResults(): Array<{ root: string; result: LoadWorkspaceIndexResult | null }> {
      return activeWorkspaces.map((workspace) => ({
        root: workspace.root,
        result: workspace.lastLoadResult,
      }));
    },

    getWorkspaceSummaries(): Array<{ root: string; summary: WorkspaceIndexSummary }> {
      return activeWorkspaces.map((workspace) => ({
        root: workspace.root,
        summary: { ...workspace.summary },
      }));
    },

    getSummary(): WorkspaceIndexSummary {
      return { ...summary };
    },

    clear(): WorkspaceIndexSummary {
      activeWorkspaces = [];
      readyPromise = null;
      refreshPromise = null;
      return publishSummary(createEmptyWorkspaceIndexSummary());
    },
  };

  return coordinator;
}

function normalizePersistedRecord(
  record: IndexedFileSemanticRecord,
  workspaceRoot: string,
  persistedAt: string,
): PersistedIndexedFileRecord {
  const candidate = record as Partial<PersistedIndexedFileRecord>;
  return PersistedIndexedFileRecordSchema.parse({
    workspaceRoot: candidate.workspaceRoot ?? workspaceRoot,
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

function summarizeFreshnessState(
  refreshResult: {
    refreshedFiles: string[];
    degradedFiles: string[];
    summary: WorkspaceIndexSummary;
  },
): FreshnessState {
  if (refreshResult.summary.state === "rebuilding") {
    return "rebuilding";
  }

  if (refreshResult.degradedFiles.length > 0) {
    return "degraded";
  }

  if (refreshResult.refreshedFiles.length > 0) {
    return "refreshed";
  }

  return "fresh";
}
