---
phase: 04-persistent-indexing-and-query-freshness
plan: 03
subsystem: observability
tags: [freshness, diagnostics, health, capabilities, e2e]
requires:
  - phase: 04-01
    provides: persistent index summaries and workspace-coordinator state
  - phase: 04-02
    provides: indexed search backends, readiness gating, and incremental refresh
provides:
  - persistent-index metadata in server/bootstrap/capability/health tool payloads
  - structured search freshness blocks plus degraded warning diagnostics
  - end-to-end proof for restart reuse, refreshed state, and degraded exclusion behavior
affects: [phase-04 verification, phase-05 search diagnostics, agent observability]
tech-stack:
  added: []
  patterns: [shared freshness helper, index metadata serialization, restart-reuse e2e coverage]
key-files:
  created:
    - tree-sitter-mcp/src/tools/indexFreshness.ts
  modified:
    - tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts
    - tree-sitter-mcp/src/indexing/indexTypes.ts
    - tree-sitter-mcp/src/indexing/refreshWorkspaceIndex.ts
    - tree-sitter-mcp/src/indexing/semanticIndexCoordinator.ts
    - tree-sitter-mcp/src/server/toolRegistry.ts
    - tree-sitter-mcp/src/tools/getCapabilitiesTool.ts
    - tree-sitter-mcp/src/tools/getHealthTool.ts
    - tree-sitter-mcp/src/tools/setWorkspaceTool.ts
    - tree-sitter-mcp/src/tools/searchWorkspaceSymbolsTool.ts
    - tree-sitter-mcp/src/tools/searchDefinitionsTool.ts
    - tree-sitter-mcp/src/tools/searchReferencesTool.ts
    - tree-sitter-mcp/src/definitions/searchDefinitions.ts
    - tree-sitter-mcp/src/references/searchReferences.ts
    - tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
    - tree-sitter-mcp/test/serverBootstrap.test.ts
    - tree-sitter-mcp/test/definitionPipeline.test.ts
    - tree-sitter-mcp/test/definitionTools.e2e.test.ts
    - tree-sitter-mcp/test/referenceSearch.test.ts
    - tree-sitter-mcp/test/referenceTools.e2e.test.ts
    - tree-sitter-mcp/test/semanticTools.e2e.test.ts
key-decisions:
  - "Expose persistent-index mode and workspace fingerprint through normal tool payloads instead of requiring logs or hidden debug flags."
  - "Keep search calls successful in degraded states, but attach explicit warning diagnostics and freshness metadata when changed files are excluded."
  - "Use end-to-end restart-reuse coverage to prove persistent indexes survive server restarts for the same workspace fingerprint."
patterns-established:
  - "Freshness metadata is shaped once and reused across symbol, definition, and reference search tools."
  - "Server info, capabilities, health, and workspace setup all serialize the same persistent index summary contract."
requirements-completed: [PERF-03]
duration: 1 min
completed: 2026-03-21
---

# Phase 04 Plan 03: Freshness and index observability Summary

**Persistent-index metadata, search freshness payloads, and end-to-end proof for restart reuse plus degraded safety**

## Performance

- **Duration:** 1 min
- **Started:** 2026-03-21T15:32:44+08:00
- **Completed:** 2026-03-21T15:33:13+08:00
- **Tasks:** 3
- **Files modified:** 21

## Accomplishments
- Added explicit persistent-index diagnostic codes and exposed index summary metadata through bootstrap, capabilities, health, and workspace setup tools.
- Added structured `freshness` payloads plus degraded warning behavior to workspace-wide search tools while keeping fresh responses concise.
- Added end-to-end coverage for index reuse across restarts, refreshed searches after file edits, and degraded searches that omit stale matches from broken changed files.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add diagnostic codes and index summaries to server metadata tools** - `797375d` (feat)
2. **Task 2: Add freshness metadata and warning behavior to search tool payloads** - `35f4c38` (feat)
3. **Task 3: Add end-to-end coverage for restart reuse, refresh, and degraded results** - `28dcc34` (test)

## Files Created/Modified
- `tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts` - adds persistent-index build, refresh, degraded, and schema-mismatch diagnostic codes.
- `tree-sitter-mcp/src/indexing/indexTypes.ts` - expands the shared persistent-index summary and freshness schemas used across tools.
- `tree-sitter-mcp/src/server/toolRegistry.ts` - exposes `eagerIndexing` and the current index summary through server bootstrap info.
- `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts` - reports persistent index mode and workspace metadata in the capability payload.
- `tree-sitter-mcp/src/tools/getHealthTool.ts` - reports persistent-index coverage and degraded diagnostics for agent callers.
- `tree-sitter-mcp/src/tools/setWorkspaceTool.ts` - returns `lastBuiltAt`, `lastRefreshedAt`, and related index summary details with workspace setup.
- `tree-sitter-mcp/src/tools/indexFreshness.ts` - centralizes freshness shaping and warning diagnostics for search tools.
- `tree-sitter-mcp/src/tools/searchWorkspaceSymbolsTool.ts` - includes `freshness` metadata in symbol-search payloads and concise refreshed/degraded text.
- `tree-sitter-mcp/src/tools/searchDefinitionsTool.ts` - includes `freshness` metadata in definition-search payloads.
- `tree-sitter-mcp/src/tools/searchReferencesTool.ts` - includes `freshness` metadata plus degraded warning behavior in reference-search payloads.
- `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts` - verifies workspace fingerprint, index mode, and per-tool metadata exposure.
- `tree-sitter-mcp/test/serverBootstrap.test.ts` - verifies bootstrap payloads expose `eagerIndexing` and index metadata.
- `tree-sitter-mcp/test/definitionTools.e2e.test.ts` - verifies definition-tool freshness payloads over stdio.
- `tree-sitter-mcp/test/referenceTools.e2e.test.ts` - verifies restart reuse and degraded freshness behavior over stdio.
- `tree-sitter-mcp/test/semanticTools.e2e.test.ts` - verifies refreshed-state behavior after supported-file edits.

## Decisions Made
- Observability lives in normal response payloads so agents can reason about freshness without out-of-band debugging.
- Degraded states remain successful reads when partial results are still trustworthy, but they never silently pretend to be fresh.
- Restart reuse is treated as a product-level contract and therefore covered end-to-end instead of only unit-tested.

## Deviations from Plan

### Retrospective execution catch-up
- During this `$gsd-execute-phase 4` run, the implementation commits for 04-03 were already present on `main`.
- This execution pass therefore verified the existing commits, preserved them as the task record of truth, and added the missing summary/state bookkeeping instead of redoing the code.

## Issues Encountered
- Sandbox restrictions required escalated `npm test` execution because `tsx` needs an IPC pipe outside the sandbox.
- The code already existed before this summary pass, so the execution record was reconstructed from the committed task history plus the current full test suite.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 04 now covers both performance and observability: indexed search is active, freshness is explicit, and degraded states are visible to callers.
- Phase 05 and later relationship work can assume persistent-index metadata and freshness contracts are already stable across the MCP tool surface.

## Self-Check: PASSED
- Verified task commits `797375d`, `35f4c38`, and `28dcc34` exist in git history.
- Verified the current full test suite passes with restart-reuse, refreshed-state, and degraded-state coverage.
- Verified this summary file exists on disk.
