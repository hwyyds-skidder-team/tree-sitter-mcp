import type { Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { ServerContext } from "../server/serverContext.js";
import { processBatch } from "../parsing/parallelParser.js";
import { discoverConfiguredWorkspaces } from "../workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../workspace/workspaceState.js";
import type { WorkspaceIndexSummary } from "./indexTypes.js";
import {
  createWorkspaceRecordKey,
  collectIndexedFileSemantics,
  parseWorkspaceRecordKey,
  readIndexedFileSnapshot,
  resolveIndexedRecordWorkspaceRoot,
  type IndexedFileSnapshot,
  type PersistedIndexedFileRecord,
} from "./collectIndexedFileSemantics.js";

export interface RefreshWorkspaceIndexResult {
  records: PersistedIndexedFileRecord[];
  diagnostics: Diagnostic[];
  degradedFiles: string[];
  refreshedFiles: string[];
  refreshed: boolean;
  summary: WorkspaceIndexSummary;
}

export async function refreshWorkspaceIndex(
  context: ServerContext,
  existingRecords: readonly PersistedIndexedFileRecord[],
): Promise<RefreshWorkspaceIndexResult> {
  const configuredRoots = resolveConfiguredWorkspaceRoots(context);
  if (configuredRoots.length === 0) {
    return {
      records: [...existingRecords],
      diagnostics: [],
      degradedFiles: [],
      refreshedFiles: [],
      refreshed: false,
      summary: context.semanticIndex.getSummary(),
    };
  }

  const discovery = await discoverConfiguredWorkspaces(
    configuredRoots,
    context.workspace.exclusions,
    context.languageRegistry,
  );
  applyWorkspaceSnapshot(context.workspace, {
    root: configuredRoots[0] ?? null,
    roots: configuredRoots,
    exclusions: context.workspace.exclusions,
    searchableFiles: discovery.searchableFiles,
    unsupportedFiles: discovery.unsupportedFiles,
  });

  const descriptors = new Map<string, WorkspaceRecordDescriptor>();
  for (const record of existingRecords) {
    descriptors.set(createWorkspaceRecordKey(record), createWorkspaceRecordDescriptor(record));
  }
  for (const file of context.workspace.searchableFiles) {
    descriptors.set(createWorkspaceRecordKey(file), createWorkspaceRecordDescriptor(file));
  }

  const remainingRecords = new Map(existingRecords.map((record) => [createWorkspaceRecordKey(record), record]));
  const degradedFiles = new Set(existingRecords
    .filter((record) => record.diagnostics.length > 0)
    .map((record) => createWorkspaceRecordKey(record)));
  let refreshed = false;

  const filesToRefresh: { file: typeof context.workspace.searchableFiles[0]; existingRecord?: PersistedIndexedFileRecord }[] = [];

  for (const file of context.workspace.searchableFiles) {
    const recordKey = createWorkspaceRecordKey(file);
    const existingRecord = remainingRecords.get(recordKey);
    remainingRecords.delete(recordKey);

    const snapshot = await readIndexedFileSnapshot(file);
    if (existingRecord && isUnchanged(existingRecord, snapshot)) {
      continue;
    }

    refreshed = true;
    filesToRefresh.push({ file, existingRecord });
  }

  const { results: refreshedRecords, errors } = await processBatch(
    filesToRefresh,
    async ({ file }) => {
      const snapshot = await readIndexedFileSnapshot(file);
      return collectIndexedFileSemantics(context, file, snapshot);
    },
    4,
  );

  const nextRecords: PersistedIndexedFileRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const refreshedFiles: string[] = [];

  for (const file of context.workspace.searchableFiles) {
    const recordKey = createWorkspaceRecordKey(file);
    const existingRecord = remainingRecords.get(recordKey) ?? existingRecords.find(
      (r) => createWorkspaceRecordKey(r) === recordKey
    );

    if (existingRecord && !filesToRefresh.some((f) => createWorkspaceRecordKey(f.file) === recordKey)) {
      nextRecords.push(existingRecord);
    }
  }

  for (const refreshedRecord of refreshedRecords) {
    nextRecords.push(refreshedRecord);
    diagnostics.push(...refreshedRecord.diagnostics);
    const recordKey = createWorkspaceRecordKey(refreshedRecord);
    refreshedFiles.push(recordKey);
    descriptors.set(recordKey, createWorkspaceRecordDescriptor(refreshedRecord));

    if (refreshedRecord.diagnostics.length > 0) {
      degradedFiles.add(recordKey);
    } else {
      degradedFiles.delete(recordKey);
    }
  }

  for (const { error } of errors) {
    diagnostics.push({
      code: "parse_failed",
      message: error.message,
      reason: "File parsing failed during index refresh.",
      nextStep: "Check the file for syntax errors.",
      severity: "warning",
    });
  }

  if (remainingRecords.size > 0) {
    refreshed = true;
    refreshedFiles.push(...remainingRecords.keys());
    for (const removedKey of remainingRecords.keys()) {
      degradedFiles.delete(removedKey);
    }
  }

  sortWorkspaceRecords(nextRecords, configuredRoots);

  if (!refreshed) {
    return {
      records: nextRecords,
      diagnostics,
      degradedFiles: formatWorkspaceRecordLabels([...degradedFiles], descriptors),
      refreshedFiles: [],
      refreshed: false,
      summary: context.semanticIndex.getSummary(),
    };
  }

  // Refresh writes the updated manifest.json and records.json for the active snapshot.
  const summary = await context.semanticIndex.markRefreshed(
    nextRecords,
    uniqueSortedWorkspaceRecordKeys([...degradedFiles]),
    configuredRoots,
  );

  return {
    records: nextRecords,
    diagnostics,
    degradedFiles: formatWorkspaceRecordLabels([...degradedFiles], descriptors),
    refreshedFiles: formatWorkspaceRecordLabels(refreshedFiles, descriptors),
    refreshed: true,
    summary,
  };
}

function isUnchanged(
  record: Pick<PersistedIndexedFileRecord, "mtimeMs" | "sizeBytes" | "contentHash">,
  nextFile: Pick<IndexedFileSnapshot, "mtimeMs" | "sizeBytes" | "contentHash">,
): boolean {
  return record.mtimeMs === nextFile.mtimeMs
    && record.sizeBytes === nextFile.sizeBytes
    && record.contentHash === nextFile.contentHash;
}

function resolveConfiguredWorkspaceRoots(context: Pick<ServerContext, "workspace">): string[] {
  if (context.workspace.roots.length > 0) {
    return [...context.workspace.roots];
  }

  if (context.workspace.root) {
    return [context.workspace.root];
  }

  return [];
}

interface WorkspaceRecordDescriptor {
  path: string;
  relativePath: string;
  workspaceRoot: string;
}

function createWorkspaceRecordDescriptor(
  record: Pick<PersistedIndexedFileRecord, "path" | "relativePath" | "workspaceRoot">
    | Pick<ServerContext["workspace"]["searchableFiles"][number], "path" | "relativePath" | "workspaceRoot">,
): WorkspaceRecordDescriptor {
  return {
    path: record.path,
    relativePath: record.relativePath,
    workspaceRoot: resolveIndexedRecordWorkspaceRoot(record),
  };
}

function sortWorkspaceRecords(
  records: PersistedIndexedFileRecord[],
  configuredRoots: readonly string[],
): void {
  const workspaceOrder = new Map(configuredRoots.map((root, index) => [root, index] as const));

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

function uniqueSortedWorkspaceRecordKeys(recordKeys: string[]): string[] {
  return [...new Set(
    recordKeys
      .map((recordKey) => recordKey.trim())
      .filter((recordKey) => recordKey.length > 0),
  )].sort();
}

function formatWorkspaceRecordLabels(
  recordKeys: string[],
  descriptors: ReadonlyMap<string, WorkspaceRecordDescriptor>,
): string[] {
  const uniqueRecordKeys = uniqueSortedWorkspaceRecordKeys(recordKeys);
  const relativePathCounts = new Map<string, number>();

  for (const descriptor of descriptors.values()) {
    relativePathCounts.set(
      descriptor.relativePath,
      (relativePathCounts.get(descriptor.relativePath) ?? 0) + 1,
    );
  }

  return uniqueRecordKeys.map((recordKey) => {
    const descriptor = descriptors.get(recordKey);
    if (!descriptor) {
      return parseWorkspaceRecordKey(recordKey).relativePath;
    }

    return (relativePathCounts.get(descriptor.relativePath) ?? 0) > 1
      ? descriptor.path
      : descriptor.relativePath;
  });
}
