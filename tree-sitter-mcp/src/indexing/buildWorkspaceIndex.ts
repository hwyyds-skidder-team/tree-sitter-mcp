import type { Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { ServerContext } from "../server/serverContext.js";
import { processBatch } from "../parsing/parallelParser.js";
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

  const filesToProcess = context.workspace.searchableFiles.filter((file) => {
    const workspaceRoot = resolveIndexedRecordWorkspaceRoot(file);
    return targetRootSet.has(workspaceRoot);
  });

  const { results: records, errors } = await processBatch(
    filesToProcess,
    async (file) => {
      const record = await collectIndexedFileSemantics(context, file);
      return record;
    },
    4,
  );

  const diagnostics: Diagnostic[] = [];
  for (const record of records) {
    diagnostics.push(...record.diagnostics);
  }
  for (const { error } of errors) {
    diagnostics.push({
      code: "parse_failed",
      message: error.message,
      reason: "File parsing failed during index build.",
      nextStep: "Check the file for syntax errors.",
      severity: "warning",
    });
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
