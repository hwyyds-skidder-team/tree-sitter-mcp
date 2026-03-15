---
phase: 02-definition-search-core
plan: 01
subsystem: api
tags: [tree-sitter, definitions, semantic-search, ranges]
requires:
  - phase: 01-server-foundation-and-workspace-discovery
    provides: workspace snapshots, on-demand parsing, diagnostics, and symbol query helpers
provides:
  - on-demand definition query catalog for builtin languages
  - reusable file definition extraction pipeline
  - workspace definition search and direct definition resolution services
affects: [definition-normalization, definition-tools]
tech-stack:
  added: []
  patterns: [on-demand-definition-pipeline, shared-query-helpers, definition-resolution-service]
key-files:
  created:
    - tree-sitter-mcp/src/queries/definitionQueryCatalog.ts
    - tree-sitter-mcp/src/definitions/definitionPipeline.ts
    - tree-sitter-mcp/src/definitions/searchDefinitions.ts
    - tree-sitter-mcp/src/definitions/resolveDefinition.ts
    - tree-sitter-mcp/test/definitionPipeline.test.ts
    - tree-sitter-mcp/test/definitionLookup.test.ts
  modified:
    - tree-sitter-mcp/src/queries/queryCatalog.ts
    - tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts
key-decisions:
  - "Reuse Phase 1 SymbolMatch payloads for initial definition results, then normalize further in 02-02."
  - "Rank definition search results by exactness before path ordering so exact and near-exact matches surface first."
patterns-established:
  - "Definition services consume workspace.searchableFiles and never re-crawl the filesystem."
  - "Resolution returns a best match plus structured diagnostics instead of null-only failures."
requirements-completed: [SEM-01, SEM-03, RES-01]
duration: 30min
completed: 2026-03-15
---

# Phase 2 Plan 01: Definition Backend Summary

**On-demand definition query catalog, reusable definition extraction pipeline, and direct resolution services built on top of the Phase 1 workspace snapshot**

## Performance

- **Duration:** 30 min
- **Started:** 2026-03-15T18:10:00+08:00
- **Completed:** 2026-03-15T18:40:00+08:00
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Added a dedicated definition query catalog for JavaScript, TypeScript, TSX, and Python.
- Implemented reusable services for file definition extraction, workspace definition search, and best-match resolution.
- Added regression tests for multi-language definitions, parse-failure propagation, and snapshot-only on-demand behavior.

## Task Commits

1. **Definition query catalog, extraction pipeline, and lookup services** - `PENDING` (feat)

## Files Created/Modified
- `tree-sitter-mcp/src/queries/definitionQueryCatalog.ts` - definition-oriented Tree-sitter query catalog
- `tree-sitter-mcp/src/definitions/definitionPipeline.ts` - per-file definition extraction pipeline
- `tree-sitter-mcp/src/definitions/searchDefinitions.ts` - workspace definition search service
- `tree-sitter-mcp/src/definitions/resolveDefinition.ts` - best-match definition resolution service
- `tree-sitter-mcp/src/queries/queryCatalog.ts` - exported shared query helper functions for reuse
- `tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts` - added definition-not-found diagnostic code
- `tree-sitter-mcp/test/definitionPipeline.test.ts` - multi-language definition extraction/search coverage
- `tree-sitter-mcp/test/definitionLookup.test.ts` - definition resolution coverage

## Decisions Made
- Kept definition search on top of the existing workspace snapshot rather than recrawling or indexing.
- Used exact/prefix/contains scoring for search relevance so direct name hits beat fuzzier matches.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added a dedicated diagnostic code for unresolved definitions**
- **Found during:** Task 2 (Build on-demand definition extraction, workspace search, and resolution services)
- **Issue:** Existing diagnostics had no specific code for failed definition resolution.
- **Fix:** Added `definition_not_found` to the shared diagnostic factory.
- **Files modified:** `tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts`
- **Verification:** `cd tree-sitter-mcp && npm test -- --test-reporter=spec`
- **Committed in:** `PENDING`

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Necessary to keep definition-resolution failures structured and actionable. No scope creep.

## Issues Encountered
- None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Definition search and resolution backends now exist for normalization/filter work.
- Phase 02-02 can centralize result schemas and filter semantics without reworking extraction logic.

## Self-Check: PASSED
- Required backend files exist on disk.
- `cd tree-sitter-mcp && npm test -- --test-reporter=spec` passes with new definition suites.
- A commit containing `02-01` will record this plan’s code and summary.

---
*Phase: 02-definition-search-core*
*Completed: 2026-03-15*
