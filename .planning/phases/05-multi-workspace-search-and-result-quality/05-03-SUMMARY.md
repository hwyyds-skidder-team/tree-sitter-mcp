---
phase: 05-multi-workspace-search-and-result-quality
plan: 03
subsystem: search
tags: [tree-sitter, mcp, multi-workspace, ranking, e2e]
requires:
  - phase: 05-01
    provides: ordered multi-root workspace state and per-root persistent index ownership
  - phase: 05-02
    provides: workspace-aware definition/reference filters and follow-up navigation
provides:
  - deterministic exact/prefix/contains ranking before federated truncation
  - additive `workspaceRoots` and `workspaceBreakdown` metadata on broad search tools
  - dedicated federated regression coverage plus single-root compatibility proof
affects: [phase-05 verification, phase-06 relationship search, tool payload shaping, federated narrowing]
tech-stack:
  added: []
  patterns: [shared ranking helpers, per-workspace result breakdowns, federated end-to-end coverage]
key-files:
  created:
    - tree-sitter-mcp/src/results/searchRanking.ts
    - tree-sitter-mcp/src/results/workspaceBreakdown.ts
    - tree-sitter-mcp/test/multiWorkspaceSearch.e2e.test.ts
  modified:
    - tree-sitter-mcp/src/definitions/searchDefinitions.ts
    - tree-sitter-mcp/src/references/searchReferences.ts
    - tree-sitter-mcp/src/tools/searchWorkspaceSymbolsTool.ts
    - tree-sitter-mcp/src/tools/searchDefinitionsTool.ts
    - tree-sitter-mcp/src/tools/searchReferencesTool.ts
    - tree-sitter-mcp/test/semanticTools.e2e.test.ts
    - tree-sitter-mcp/test/definitionTools.e2e.test.ts
    - tree-sitter-mcp/test/referenceTools.e2e.test.ts
    - tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
    - tree-sitter-mcp/test/searchIndexIntegration.test.ts
key-decisions:
  - "Use one shared exact/prefix/contains ranking contract before truncation so federated search ordering does not depend on discovery order."
  - "Expose `workspaceBreakdown` as additive metadata instead of replacing existing top-level result counts or text summaries."
  - "Keep single-root callers concise while locking multi-root attribution through dedicated federated E2E coverage."
patterns-established:
  - "Broad search tools echo selected `workspaceRoots` and machine-readable per-root breakdowns."
  - "Federated ranking and truncation happen after workspace/path/language/kind narrowing, not before."
requirements-completed: [SEARCH-02, SEARCH-03]
duration: 3 hr 30 min
completed: 2026-03-21
---

# Phase 05 Plan 03: Federated search quality Summary

**Deterministic federated ranking, explainable per-workspace result breakdowns, and dedicated multi-root end-to-end coverage**

## Performance

- **Duration:** 3 hr 30 min
- **Started:** 2026-03-21T09:31:47Z
- **Completed:** 2026-03-21T13:01:33Z
- **Tasks:** 3
- **Files modified:** 13

## Accomplishments
- Added a shared ranking helper so symbol and definition search now apply one exact/prefix/contains ordering contract before federated truncation.
- Extended broad search tools to echo selected `workspaceRoots`, report `workspaceBreakdown`, and keep single-root text concise while multi-root responses stay explainable.
- Added realistic federated regression coverage across duplicate roots, workspace filters, symbol-kind narrowing, deterministic ranking, and legacy one-root compatibility.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add deterministic cross-workspace ranking before truncation** - `a8707d9` (feat)
2. **Task 2: Wire broad-search tool payloads for federated narrowing and per-workspace breakdowns** - `b9b1022` (feat)
3. **Task 3: Add federated regression coverage and single-root compatibility assertions** - `82ef692` (test)

_Plan metadata is captured in this summary and the updated planning documents._

## Files Created/Modified
- `tree-sitter-mcp/src/results/searchRanking.ts` - Centralizes exact/prefix/contains scoring plus workspace-aware tie-breaking for federated search.
- `tree-sitter-mcp/src/results/workspaceBreakdown.ts` - Shapes per-root `searchedFiles`, `matchedFiles`, and `returnedResults` metadata for broad search payloads.
- `tree-sitter-mcp/src/definitions/searchDefinitions.ts` - Applies shared ranking after workspace/path/language/kind narrowing and before truncation.
- `tree-sitter-mcp/src/references/searchReferences.ts` - Stabilizes multi-root reference ordering with configured workspace-root precedence.
- `tree-sitter-mcp/src/tools/searchWorkspaceSymbolsTool.ts` - Echoes selected workspaces, preserves kind narrowing, and returns machine-readable breakdowns for symbol search.
- `tree-sitter-mcp/src/tools/searchDefinitionsTool.ts` - Adds federated workspace metadata and concise multi-root summary text for definition search.
- `tree-sitter-mcp/src/tools/searchReferencesTool.ts` - Adds workspace filters/output metadata and per-root breakdowns for reference search.
- `tree-sitter-mcp/test/multiWorkspaceSearch.e2e.test.ts` - Proves duplicate-root attribution, workspace filtering, deterministic ranking, and legacy one-root compatibility over stdio.
- `tree-sitter-mcp/test/semanticTools.e2e.test.ts` - Locks the single-root `workspaceRoots`/`workspaceBreakdown` symbol-search contract.
- `tree-sitter-mcp/test/definitionTools.e2e.test.ts` - Locks definition search output metadata for single-root callers.
- `tree-sitter-mcp/test/referenceTools.e2e.test.ts` - Locks reference search output metadata for single-root callers.
- `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts` - Verifies multi-root summaries expose per-workspace fingerprint metadata.
- `tree-sitter-mcp/test/searchIndexIntegration.test.ts` - Verifies persisted records are reused independently per workspace root.

## Decisions Made
- Shared ranking logic lives in `src/results/` so symbol and definition search cannot drift on exact/prefix/contains behavior.
- `workspaceBreakdown` reports returned results after truncation, which keeps payload attribution aligned with what the caller actually received.
- Dedicated federated E2E coverage was added instead of relying only on unit tests, because workspace attribution and backward compatibility are tool-level promises.

## Deviations from Plan

None - the plan goals were completed without introducing HTTP transport or any write-path expansion.

## Issues Encountered
- Task 2 work already existed partially in the working tree from the interrupted earlier execution attempt, so the remaining implementation was resumed inline and then validated before commit.
- Sandbox restrictions blocked `git commit` and `npm test` until the commands were rerun with escalation.
- An unrelated `tree-sitter-mcp/package.json` version drift was reverted before finalizing the plan so the search-quality work stayed cleanly scoped.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 05 is now ready for verification with explicit proof for ranking, workspace attribution, narrowing, and one-root compatibility.
- Phase 06 can build relationship-aware retrieval on top of stable federated search payloads instead of inventing another attribution model.

## Self-Check: PASSED
- Found `.planning/phases/05-multi-workspace-search-and-result-quality/05-03-SUMMARY.md`
- Found commit `a8707d9`
- Found commit `b9b1022`
- Found commit `82ef692`
