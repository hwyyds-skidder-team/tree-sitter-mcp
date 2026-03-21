import type { Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { ServerContext } from "../server/serverContext.js";
import { discoverWorkspaceFiles } from "../workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../workspace/workspaceState.js";
import type { WorkspaceIndexSummary } from "./indexTypes.js";
import {
  collectIndexedFileSemantics,
  readIndexedFileSnapshot,
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
  if (!context.workspace.root) {
    return {
      records: [...existingRecords],
      diagnostics: [],
      degradedFiles: [],
      refreshedFiles: [],
      refreshed: false,
      summary: context.semanticIndex.getSummary(),
    };
  }

  const discovery = await discoverWorkspaceFiles(
    context.workspace.root,
    context.workspace.exclusions,
    context.languageRegistry,
  );
  applyWorkspaceSnapshot(context.workspace, {
    root: context.workspace.root,
    exclusions: context.workspace.exclusions,
    searchableFiles: discovery.searchableFiles,
    unsupportedFiles: discovery.unsupportedFiles,
  });

  const remainingRecords = new Map(existingRecords.map((record) => [record.relativePath, record]));
  const nextRecords: PersistedIndexedFileRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const degradedFiles = new Set(existingRecords
    .filter((record) => record.diagnostics.length > 0)
    .map((record) => record.relativePath));
  const refreshedFiles: string[] = [];
  let refreshed = false;

  for (const file of context.workspace.searchableFiles) {
    const existingRecord = remainingRecords.get(file.relativePath);
    remainingRecords.delete(file.relativePath);

    const snapshot = await readIndexedFileSnapshot(file);
    if (existingRecord && isUnchanged(existingRecord, snapshot)) {
      nextRecords.push(existingRecord);
      continue;
    }

    refreshed = true;
    refreshedFiles.push(file.relativePath);
    const refreshedRecord = await collectIndexedFileSemantics(context, file, snapshot);
    nextRecords.push(refreshedRecord);
    diagnostics.push(...refreshedRecord.diagnostics);

    if (refreshedRecord.diagnostics.length > 0) {
      degradedFiles.add(refreshedRecord.relativePath);
    } else {
      degradedFiles.delete(refreshedRecord.relativePath);
    }
  }

  if (remainingRecords.size > 0) {
    refreshed = true;
    refreshedFiles.push(...remainingRecords.keys());
    for (const removedRelativePath of remainingRecords.keys()) {
      degradedFiles.delete(removedRelativePath);
    }
  }

  nextRecords.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  if (!refreshed) {
    return {
      records: nextRecords,
      diagnostics,
      degradedFiles: uniqueSortedRelativePaths([...degradedFiles]),
      refreshedFiles: [],
      refreshed: false,
      summary: context.semanticIndex.getSummary(),
    };
  }

  // Refresh writes the updated manifest.json and records.json for the active snapshot.
  const summary = await context.semanticIndex.markRefreshed(
    nextRecords,
    uniqueSortedRelativePaths([...degradedFiles]),
  );

  return {
    records: nextRecords,
    diagnostics,
    degradedFiles: uniqueSortedRelativePaths([...degradedFiles]),
    refreshedFiles: uniqueSortedRelativePaths(refreshedFiles),
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

function uniqueSortedRelativePaths(relativePaths: string[]): string[] {
  return [...new Set(
    relativePaths
      .map((relativePath) => relativePath.trim())
      .filter((relativePath) => relativePath.length > 0),
  )].sort();
}
