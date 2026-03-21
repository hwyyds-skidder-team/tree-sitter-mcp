---
phase: 04-persistent-indexing-and-query-freshness
plan: 02
subsystem: indexing
tags: [persistent-index, refresh, definitions, references, search]
requires:
  - phase: 04-01
    provides: persistent index coordinator, manifest/record schemas, workspace fingerprinting
provides:
  - persisted semantic records for symbols, definitions, references, and diagnostics
  - incremental refresh plus readiness gating before indexed search runs
  - workspace-wide semantic search backed by freshness-checked indexed records
affects: [04-03, search pipelines, freshness handling, regression coverage]
tech-stack:
  added: []
  patterns: [persisted semantic records, incremental refresh, freshness-checked indexed queries]
key-files:
  created:
    - tree-sitter-mcp/src/indexing/collectIndexedFileSemantics.ts
    - tree-sitter-mcp/src/indexing/buildWorkspaceIndex.ts
    - tree-sitter-mcp/src/indexing/refreshWorkspaceIndex.ts
    - tree-sitter-mcp/test/searchIndexIntegration.test.ts
  modified:
    - tree-sitter-mcp/src/index.ts
    - tree-sitter-mcp/src/indexing/semanticIndexCoordinator.ts
    - tree-sitter-mcp/src/indexing/indexTypes.ts
    - tree-sitter-mcp/src/tools/setWorkspaceTool.ts
    - tree-sitter-mcp/src/tools/searchWorkspaceSymbolsTool.ts
    - tree-sitter-mcp/src/definitions/definitionFilters.ts
    - tree-sitter-mcp/src/definitions/searchDefinitions.ts
    - tree-sitter-mcp/src/definitions/resolveDefinition.ts
    - tree-sitter-mcp/src/references/searchReferences.ts
    - tree-sitter-mcp/test/definitionLookup.test.ts
    - tree-sitter-mcp/test/definitionPipeline.test.ts
    - tree-sitter-mcp/test/indexStorage.test.ts
    - tree-sitter-mcp/test/referenceSearch.test.ts
    - tree-sitter-mcp/test/semanticIndexCoordinator.test.ts
    - tree-sitter-mcp/test/semanticTools.e2e.test.ts
key-decisions:
  - "Build one persisted semantic record shape that already contains symbols, definitions, references, snippets, and diagnostics so search backends can stop reparsing files."
  - "Gate `set_workspace` on coordinator readiness so the first indexed search never races an unfinished build."
  - "Exclude stale records from changed files whose refresh fails instead of serving previously indexed data as if it were current."
patterns-established:
  - "Workspace-wide semantic searches use `getFreshRecords()` rather than reparsing `workspace.searchableFiles`."
  - "Incremental refresh compares file metadata and updates only changed, added, or deleted files before returning indexed results."
requirements-completed: [PERF-01, PERF-02]
duration: 1 min
completed: 2026-03-21
---

# Phase 04 Plan 02: Indexed search backend Summary

**Persisted semantic records, incremental refresh, and freshness-checked indexed search paths for workspace-wide semantic queries**

## Performance

- **Duration:** 1 min
- **Started:** 2026-03-21T15:05:23+08:00
- **Completed:** 2026-03-21T15:05:54+08:00
- **Tasks:** 3
- **Files modified:** 19

## Accomplishments
- Added full-workspace semantic record collection so every searchable file can be persisted with hashes, metadata, symbols, definitions, references, and diagnostics.
- Implemented incremental refresh plus readiness gating so `set_workspace` waits for index readiness and changed files refresh before indexed searches answer.
- Switched workspace symbol, definition, definition resolution, and reference flows to freshness-checked indexed records while adding regression coverage for reuse, refresh, and stale-file exclusion.

## Task Commits

Each task was committed atomically:

1. **Task 1: Build indexed semantic records for every searchable file** - `ee71e74` (feat)
2. **Task 2: Add incremental refresh and block search until the index is ready** - `684a61f` (feat)
3. **Task 3: Route semantic searches through freshness-checked indexed records** - `0a72584` (feat)

Follow-up alignment during execute-phase catch-up:

4. **Schema/storage follow-up: Persist full indexed semantic records in the shared schema** - `fef1e09` (feat)

## Files Created/Modified
- `tree-sitter-mcp/src/indexing/collectIndexedFileSemantics.ts` - parses one file into a persisted record with metadata, symbols, definitions, references, snippets, and diagnostics.
- `tree-sitter-mcp/src/indexing/buildWorkspaceIndex.ts` - builds a full semantic snapshot for the active searchable workspace files and persists it.
- `tree-sitter-mcp/src/indexing/indexTypes.ts` - defines the shared indexed-record schema used for persisted storage round trips.
- `tree-sitter-mcp/src/indexing/refreshWorkspaceIndex.ts` - refreshes changed files incrementally, prunes deleted files, and tracks degraded files safely.
- `tree-sitter-mcp/src/indexing/semanticIndexCoordinator.ts` - coordinates readiness, freshness checks, and refresh/build transitions for indexed search.
- `tree-sitter-mcp/src/tools/setWorkspaceTool.ts` - blocks successful workspace setup until the persistent index is ready.
- `tree-sitter-mcp/src/tools/searchWorkspaceSymbolsTool.ts` - reads indexed symbol records through `getFreshRecords()`.
- `tree-sitter-mcp/src/definitions/searchDefinitions.ts` - reuses indexed definition records instead of reparsing workspace files.
- `tree-sitter-mcp/src/definitions/resolveDefinition.ts` - resolves definitions against freshness-checked indexed records.
- `tree-sitter-mcp/src/references/searchReferences.ts` - reads indexed reference data while excluding stale changed files after refresh failures.
- `tree-sitter-mcp/test/searchIndexIntegration.test.ts` - locks repeated-query reuse, incremental refresh, and degraded stale-file exclusion.
- `tree-sitter-mcp/test/indexStorage.test.ts` - verifies persisted records round-trip full semantic payloads and file metadata safely.
- `tree-sitter-mcp/test/semanticIndexCoordinator.test.ts` - verifies coordinator persistence still preserves workspace-rooted semantic records.
- `tree-sitter-mcp/test/definitionLookup.test.ts` - verifies indexed definition resolution behavior stays compatible.
- `tree-sitter-mcp/test/referenceSearch.test.ts` - verifies indexed reference search respects freshness and degraded-file handling.
- `tree-sitter-mcp/test/semanticTools.e2e.test.ts` - proves stdio workspace setup waits for index readiness before search tools answer.

## Decisions Made
- Persisted record extraction reuses the existing symbol/definition/reference helpers so indexed and on-demand semantics stay aligned.
- Readiness gating happens at `set_workspace`, not lazily in each tool, so callers get a ready workspace contract immediately.
- Refresh failures degrade only the affected changed files rather than poisoning the whole index.

## Deviations from Plan

### Retrospective execution catch-up
- During this `$gsd-execute-phase 4` run, the implementation commits for 04-02 were already present on `main`.
- This execution pass therefore verified the existing commits, preserved them as the task record of truth, and added the missing summary/state bookkeeping instead of redoing the code.

### Auto-fixed follow-up
- While reconciling execution state, a schema/storage drift was noticed between the shared indexed-record schema and the persisted semantic-record payload.
- That was fixed in follow-up commit `fef1e09`, which stores full workspace-rooted semantic payloads in the shared schema and tightens storage/coordinator round-trip tests.

## Issues Encountered
- Sandbox restrictions required escalated `git` and `npm test` commands during the broader Phase 4/5 execution work.
- The plan implementation had already landed before summary generation, so this summary was reconstructed from the committed task history and current passing test suite.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- 04-03 can now surface persistent-index status and freshness data through MCP metadata/search payloads instead of keeping that information implicit.
- Phase 5 multi-workspace search can safely build on indexed search because freshness, readiness, and stale-file exclusion are already in place.

## Self-Check: PASSED
- Verified task commits `ee71e74`, `684a61f`, `0a72584`, and follow-up fix `fef1e09` exist in git history.
- Verified indexed-search regression coverage passes in the current full test suite.
- Verified this summary file exists on disk.
