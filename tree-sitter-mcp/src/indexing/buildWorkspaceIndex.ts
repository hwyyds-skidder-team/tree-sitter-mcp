import type { Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { ServerContext } from "../server/serverContext.js";
import type { WorkspaceIndexSummary } from "./indexTypes.js";
import {
  collectIndexedFileSemantics,
  type PersistedIndexedFileRecord,
} from "./collectIndexedFileSemantics.js";

export interface BuildWorkspaceIndexResult {
  records: PersistedIndexedFileRecord[];
  diagnostics: Diagnostic[];
  summary: WorkspaceIndexSummary;
}

export async function buildWorkspaceIndex(
  context: ServerContext,
): Promise<BuildWorkspaceIndexResult> {
  const records: PersistedIndexedFileRecord[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const file of context.workspace.searchableFiles) {
    const record = await collectIndexedFileSemantics(context, file);
    records.push(record);
    diagnostics.push(...record.diagnostics);
  }

  records.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  // Full builds persist manifest.json and records.json through markFresh.
  const summary = await context.semanticIndex.markFresh(records);

  return {
    records,
    diagnostics,
    summary,
  };
}
