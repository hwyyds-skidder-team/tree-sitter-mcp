import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { createSearchFreshness, type SearchFreshness, type WorkspaceIndexSummary } from "../indexing/indexTypes.js";

export function createDefaultFreshness(summary: WorkspaceIndexSummary): SearchFreshness {
  return createSearchFreshness({
    state: summary.state,
    checkedAt: new Date().toISOString(),
    refreshedFiles: [],
    degradedFiles: [],
    workspaceFingerprint: summary.workspaceFingerprint,
  });
}

export function createFreshnessDiagnostics(freshness: SearchFreshness): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (freshness.degradedFiles.length > 0 && freshness.refreshedFiles.length > 0) {
    diagnostics.push(createDiagnostic({
      code: "index_refresh_failed",
      severity: "warning",
      message: `Failed to refresh ${freshness.degradedFiles.length} file(s) before searching.`,
      reason: "Changed files could not be reparsed cleanly, so their stale indexed records were excluded from the result set.",
      nextStep: "Fix the changed files and rerun the search to restore complete coverage.",
      details: {
        refreshedFileCount: freshness.refreshedFiles.length,
        degradedFileCount: freshness.degradedFiles.length,
        workspaceFingerprint: freshness.workspaceFingerprint,
      },
    }));
  }

  if (freshness.degradedFiles.length > 0) {
    diagnostics.push(createDiagnostic({
      code: "index_degraded",
      severity: "warning",
      message: `Search results exclude ${freshness.degradedFiles.length} degraded file(s).`,
      reason: "The persistent index does not have confirmed-fresh semantic data for every file in the active workspace snapshot.",
      nextStep: "Inspect the degraded files, repair them, and rerun the search when complete coverage matters.",
      details: {
        degradedFileCount: freshness.degradedFiles.length,
        workspaceFingerprint: freshness.workspaceFingerprint,
      },
    }));
  }

  return diagnostics;
}
