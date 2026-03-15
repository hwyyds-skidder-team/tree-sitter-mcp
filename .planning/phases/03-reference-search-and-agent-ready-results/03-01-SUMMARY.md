---
phase: 03-reference-search-and-agent-ready-results
plan: 01
subsystem: api
tags: [tree-sitter, references, call-sites, semantic-search]
requires:
  - phase: 02-definition-search-core
    provides: definition resolution, normalized ranges, and stdio-exposed definition workflows
provides:
  - on-demand reference and call-site query catalog for builtin languages
  - reusable file reference extraction pipeline
  - workspace reference search service anchored by definition resolution
affects: [context-shaping, reference-tools]
tech-stack:
  added: []
  patterns: [on-demand-reference-pipeline, definition-anchored-reference-search, lexical-callsite-classification]
key-files:
  created:
    - tree-sitter-mcp/src/queries/referenceQueryCatalog.ts
    - tree-sitter-mcp/src/references/referenceTypes.ts
    - tree-sitter-mcp/src/references/referencePipeline.ts
    - tree-sitter-mcp/src/references/searchReferences.ts
    - tree-sitter-mcp/test/referencePipeline.test.ts
    - tree-sitter-mcp/test/referenceSearch.test.ts
  modified:
    - tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts
    - tree-sitter-mcp/src/queries/queryCatalog.ts
key-decisions:
  - "Anchor direct lookup reference search through the existing definition resolver so Phase 3 stays layered on top of the Phase 2 symbol pipeline."
  - "Classify call sites from Tree-sitter ancestry instead of separate call-only queries so identifier matching stays language-specific but implementation remains simple and on-demand."
patterns-established:
  - "Reference search scans only the active workspace snapshot and treats TypeScript and TSX as one compatible search family for definition-anchored usage lookup."
  - "Reference results exclude declaration sites, surface `reference_not_found` when a resolved symbol has no usages, and continue to propagate parse diagnostics."
requirements-completed: [SEM-02]
duration: 35min
completed: 2026-03-15
---

# Phase 3 Plan 01: Reference Backend Summary

**On-demand reference and call-site query catalog, reusable extraction pipeline, and definition-anchored workspace reference search backend.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-03-15T18:50:00+08:00
- **Completed:** 2026-03-15T19:25:00+08:00
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Added a dedicated reference query catalog for JavaScript, TypeScript, TSX, and Python identifier and call-site captures.
- Implemented reusable services for per-file reference extraction and workspace-wide reference search anchored by Phase 2 definition resolution.
- Added regression coverage for multi-language reference extraction, parse-failure propagation, structured missing-target diagnostics, and snapshot-only on-demand behavior.

## Task Commits

1. **Reference query catalog, extraction pipeline, and workspace search backend** - `27192e9` (feat)

## Files Created/Modified
- `tree-sitter-mcp/src/queries/referenceQueryCatalog.ts` - reference and call-site Tree-sitter query catalog
- `tree-sitter-mcp/src/references/referenceTypes.ts` - shared reference schemas and request types
- `tree-sitter-mcp/src/references/referencePipeline.ts` - per-file reference extraction pipeline
- `tree-sitter-mcp/src/references/searchReferences.ts` - definition-anchored workspace reference search service
- `tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts` - added reference-not-found diagnostic code
- `tree-sitter-mcp/src/queries/queryCatalog.ts` - widened shared query compilation helper for reference catalogs
- `tree-sitter-mcp/test/referencePipeline.test.ts` - multi-language reference extraction coverage
- `tree-sitter-mcp/test/referenceSearch.test.ts` - reference search coverage for direct lookup and discovered symbols

## Decisions Made
- Kept reference search layered on top of the workspace snapshot and definition resolver rather than building any persisted symbol graph.
- Treated TypeScript and TSX as one compatible search family so definition-to-reference chaining works across `.ts` and `.tsx` source files.

## Deviations from Plan

None.

## Issues Encountered
- None.

## User Setup Required

None.

## Next Phase Readiness
- Raw reference matches and call-site classification now exist for context enrichment and pagination work.
- Phase 03-02 can focus on enclosing scope metadata, snippet shaping, and page-window semantics without reworking backend scanning.

## Self-Check: PASSED
- `cd tree-sitter-mcp && npm run build` passes.
- `cd tree-sitter-mcp && npm test -- --test-reporter=spec` passes with new reference backend suites.
- Reference search remains local, read-only, and snapshot-based with no persistent index.

---
*Phase: 03-reference-search-and-agent-ready-results*
*Completed: 2026-03-15*
