import type { Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { ServerContext } from "../server/serverContext.js";
import type { WorkspaceIndexSummary } from "./indexTypes.js";
import {
  collectIndexedFileSemantics,
  resolveIndexedRecordWorkspaceRoot,
  type PersistedIndexedFileRecord,
} from "./collectIndexedFileSemantics.js";

export interface BuildWorkspaceIndexResult {
  records: PersistedIndexedFileRecord[];
  diagnostics: Diagnostic[];
  summary: WorkspaceIndexSummary;
}

export async function buildWorkspaceIndex(
  context: ServerContext,
  workspaceRoots?: readonly string[],
): Promise<BuildWorkspaceIndexResult> {
  const targetRoots = resolveTargetWorkspaceRoots(context, workspaceRoots);
  const targetRootSet = new Set(targetRoots);
  const records: PersistedIndexedFileRecord[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const file of context.workspace.searchableFiles) {
    const workspaceRoot = resolveIndexedRecordWorkspaceRoot(file);
    if (!targetRootSet.has(workspaceRoot)) {
      continue;
    }

    const record = await collectIndexedFileSemantics(context, file);
    records.push(record);
    diagnostics.push(...record.diagnostics);
  }

  sortWorkspaceRecords(records, targetRoots);

  // Full builds persist manifest.json and records.json through markFresh.
  const summary = await context.semanticIndex.markFresh(records, targetRoots);

  return {
    records,
    diagnostics,
    summary,
  };
}

function resolveTargetWorkspaceRoots(
  context: Pick<ServerContext, "workspace">,
  workspaceRoots?: readonly string[],
): string[] {
  if (workspaceRoots && workspaceRoots.length > 0) {
    return [...workspaceRoots];
  }

  if (context.workspace.roots.length > 0) {
    return [...context.workspace.roots];
  }

  if (context.workspace.root) {
    return [context.workspace.root];
  }

  return [];
}

function sortWorkspaceRecords(
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
