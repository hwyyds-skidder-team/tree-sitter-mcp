---
phase: 05-multi-workspace-search-and-result-quality
plan: 02
subsystem: search
tags: [tree-sitter, mcp, multi-workspace, definitions, references, zod]
requires:
  - phase: 05-01
    provides: ordered multi-root workspace state, workspaceRoot-aware discovery, and federated per-root indexing
provides:
  - workspaceRoot attribution on definition/reference matches and follow-up targets
  - normalized workspaceRoots/path/language/symbol-kind narrowing for backend search flows
  - precise list_file_symbols and resolve_definition navigation across duplicate paths and roots
affects: [05-03, multi-workspace search, result shaping, follow-up navigation, relationship views]
tech-stack:
  added: []
  patterns: [workspaceRoot-first follow-up descriptors, shared workspace filter normalization, ambiguity diagnostics for duplicate relative paths]
key-files:
  created:
    - tree-sitter-mcp/src/references/referenceFilters.ts
  modified:
    - tree-sitter-mcp/src/queries/queryCatalog.ts
    - tree-sitter-mcp/src/queries/definitionQueryCatalog.ts
    - tree-sitter-mcp/src/indexing/collectIndexedFileSemantics.ts
    - tree-sitter-mcp/src/definitions/definitionTypes.ts
    - tree-sitter-mcp/src/definitions/definitionFilters.ts
    - tree-sitter-mcp/src/definitions/normalizeDefinitionMatch.ts
    - tree-sitter-mcp/src/definitions/searchDefinitions.ts
    - tree-sitter-mcp/src/definitions/resolveDefinition.ts
    - tree-sitter-mcp/src/references/referenceTypes.ts
    - tree-sitter-mcp/src/references/searchReferences.ts
    - tree-sitter-mcp/src/tools/listFileSymbolsTool.ts
    - tree-sitter-mcp/src/tools/resolveDefinitionTool.ts
    - tree-sitter-mcp/test/definitionFilters.test.ts
    - tree-sitter-mcp/test/definitionTools.e2e.test.ts
    - tree-sitter-mcp/test/referenceSearch.test.ts
key-decisions:
  - "Use additive `workspaceRoots` filters instead of replacing existing `language`, `pathPrefix`, or `symbolKinds` narrowing semantics."
  - "Require callers to pass `workspaceRoot` for ambiguous follow-up navigation instead of silently choosing the first configured root."
  - "Keep backend normalization shared between definition and reference flows so workspace/path filtering behaves the same across follow-up tools."
patterns-established:
  - "Definition/reference backends accept selected workspace roots but preserve single-root behavior when omitted."
  - "Follow-up descriptor payloads carry `workspaceRoot` to disambiguate duplicate symbol names and relative paths across roots."
requirements-completed: [SEARCH-02, SEARCH-03]
duration: 16 min
completed: 2026-03-21
---

# Phase 05 Plan 02: Workspace-aware search contracts Summary

**Workspace-attributed definition/reference contracts with normalized workspace filtering and exact multi-root follow-up navigation**

## Performance

- **Duration:** 16 min
- **Started:** 2026-03-21T08:56:21Z
- **Completed:** 2026-03-21T09:12:21Z
- **Tasks:** 3
- **Files modified:** 15

## Accomplishments
- Added `workspaceRoot` attribution to definition/reference matches and follow-up descriptors so duplicate symbols stay attributable across roots.
- Normalized `workspaceRoots`, `pathPrefix`, `language`, and `symbolKinds` handling for definition/reference backend flows without breaking single-root callers.
- Made `list_file_symbols` and `resolve_definition` precise across multiple configured roots, including explicit ambiguity diagnostics for duplicate relative paths.

## Task Commits

Each task was committed atomically:

1. **Task 1: Carry `workspaceRoot` through every symbol, definition, and reference schema** - `5aafccc` (feat)
2. **Task 2: Normalize workspace-aware filters and exact follow-up navigation** - `e589a8c` (feat)
3. **Task 3: Lock backend workspace and kind narrowing with focused regression coverage** - `ff9e2ff` (test)

_Plan metadata commit is created after summary/state updates._

## Files Created/Modified
- `tree-sitter-mcp/src/queries/queryCatalog.ts` - Carries `workspaceRoot` through symbol match shaping for downstream tool responses.
- `tree-sitter-mcp/src/queries/definitionQueryCatalog.ts` - Propagates workspace ownership into extracted definition matches.
- `tree-sitter-mcp/src/indexing/collectIndexedFileSemantics.ts` - Persists workspace ownership into indexed definition/reference records.
- `tree-sitter-mcp/src/definitions/definitionTypes.ts` - Adds `workspaceRoots` to normalized definition filter contracts.
- `tree-sitter-mcp/src/definitions/definitionFilters.ts` - Centralizes workspace-root validation plus shared path/language/kind normalization.
- `tree-sitter-mcp/src/definitions/normalizeDefinitionMatch.ts` - Normalizes/derives `workspaceRoot` when converting symbol matches into definition matches.
- `tree-sitter-mcp/src/definitions/searchDefinitions.ts` - Supports backend workspace narrowing while preserving existing ranking semantics.
- `tree-sitter-mcp/src/definitions/resolveDefinition.ts` - Uses `workspaceRoot`-scoped lookup requests to disambiguate duplicate symbol names.
- `tree-sitter-mcp/src/references/referenceTypes.ts` - Defines workspace-aware reference filters and follow-up target schemas.
- `tree-sitter-mcp/src/references/referenceFilters.ts` - Shares normalized workspace/path/language filtering for reference search.
- `tree-sitter-mcp/src/references/searchReferences.ts` - Applies normalized workspace filters and preserves stable reference ordering across roots.
- `tree-sitter-mcp/src/tools/listFileSymbolsTool.ts` - Resolves files across configured roots and returns an ambiguity diagnostic when a relative path matches multiple workspaces.
- `tree-sitter-mcp/src/tools/resolveDefinitionTool.ts` - Forwards exact `workspaceRoot` scope and returns the resolved workspace alongside the match.
- `tree-sitter-mcp/test/definitionFilters.test.ts` - Verifies workspaceRoots normalization plus deduped kind/path/language semantics.
- `tree-sitter-mcp/test/definitionTools.e2e.test.ts` - Locks the workspace-aware `resolve_definition` payload contract over stdio.
- `tree-sitter-mcp/test/referenceSearch.test.ts` - Verifies backend reference narrowing by workspace, language, and path.

## Decisions Made
- Chose centralized filter normalization helpers over per-tool ad hoc validation so workspace filtering errors stay consistent.
- Preserved `relativePath` as workspace-relative and added `workspaceRoot` as the disambiguator instead of inventing global synthetic paths.
- Treated ambiguous relative file lookups as user-facing diagnostics, because auto-selecting the first root would make follow-up navigation unreliable.

## Deviations from Plan

### Auto-fixed Issues

**1. Definition normalization needed explicit workspaceRoot derivation**
- **Found during:** Task 2 (workspace-aware filter and navigation wiring)
- **Issue:** `normalizeDefinitionMatch` still assumed workspace ownership was already normalized everywhere, which could leave definition matches without a stable `workspaceRoot`.
- **Fix:** Added workspace-root normalization/derivation in `tree-sitter-mcp/src/definitions/normalizeDefinitionMatch.ts`.
- **Files modified:** `tree-sitter-mcp/src/definitions/normalizeDefinitionMatch.ts`
- **Verification:** Focused tests and full `npm test` passed with workspace-aware definition results.
- **Committed in:** `e589a8c` (part of Task 2 commit)

**2. Existing definition tool E2E expectations needed the new workspace-aware payload**
- **Found during:** Task 3 (focused regression coverage)
- **Issue:** `definitionTools.e2e.test.ts` still asserted the pre-Phase-5 resolve payload shape and did not check the returned `workspaceRoot`.
- **Fix:** Updated the E2E assertions to require normalized `filters.workspaceRoots` and `match.workspaceRoot`.
- **Files modified:** `tree-sitter-mcp/test/definitionTools.e2e.test.ts`
- **Verification:** `npm test` passed with the updated stdio definition-tool assertions.
- **Committed in:** `ff9e2ff` (part of Task 3 commit)

---

**Total deviations:** 2 auto-fixed (contract propagation + regression alignment)
**Impact on plan:** Both changes were necessary to keep the new workspace-aware contract consistent end-to-end. No HTTP or out-of-scope search-surface expansion was introduced.

## Issues Encountered
- The original 05-02 executor stopped reporting after the first task commit. The remaining work was resumed inline from the existing partial state without losing the completed `5aafccc` task commit.
- Sandbox restrictions blocked git index writes and `tsx` IPC setup for tests; resolved by rerunning the affected git and `npm test` commands with escalation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- 05-03 can now expose `workspaceRoots` and `workspaceBreakdown` on the broad search tool surface using the backend contracts established here.
- Federated ranking work can assume definition/reference primitives already preserve workspace ownership and narrowing semantics.

## Self-Check: PASSED
- Found `.planning/phases/05-multi-workspace-search-and-result-quality/05-02-SUMMARY.md`
- Found commit `5aafccc`
- Found commit `e589a8c`
- Found commit `ff9e2ff`
