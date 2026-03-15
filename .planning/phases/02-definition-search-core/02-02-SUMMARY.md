---
phase: 02-definition-search-core
plan: 02
subsystem: api
tags: [tree-sitter, definitions, normalization, filters]
requires:
  - phase: 02-definition-search-core
    provides: on-demand definition extraction, search, and resolution backends
provides:
  - shared definition schemas and normalized payload contracts
  - reusable workspace-aware definition filter normalization
  - regression coverage for range stability and path/language/kind narrowing
affects: [definition-tools, reference-search]
tech-stack:
  added: []
  patterns: [definition-payload-normalization, shared-filter-layer, workspace-relative-path-guards]
key-files:
  created:
    - tree-sitter-mcp/src/definitions/definitionTypes.ts
    - tree-sitter-mcp/src/definitions/normalizeDefinitionMatch.ts
    - tree-sitter-mcp/src/definitions/definitionFilters.ts
    - tree-sitter-mcp/test/definitionNormalization.test.ts
    - tree-sitter-mcp/test/definitionFilters.test.ts
  modified:
    - tree-sitter-mcp/src/definitions/searchDefinitions.ts
    - tree-sitter-mcp/src/definitions/resolveDefinition.ts
    - tree-sitter-mcp/src/workspace/resolveWorkspace.ts
key-decisions:
  - "Normalize definition results through a Phase 2-specific schema instead of reusing SymbolMatch directly so MCP tools can depend on a stable contract."
  - "Treat relativePath-based resolution as pathPrefix normalization so search and resolve share one workspace-aware narrowing layer."
patterns-established:
  - "Definition filters lowercase language IDs, deduplicate symbol kinds, and normalize mixed path separators before any scan starts."
  - "Selection ranges are validated against definition ranges and fall back to the full range if a capture drifts out of bounds."
requirements-completed: [SEM-04, RES-01]
duration: 35min
completed: 2026-03-15
---

# Phase 2 Plan 02: Definition Normalization Summary

**Shared definition schemas, metadata normalizers, and deterministic workspace-aware filter semantics for search and resolution.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-03-15T18:55:00+08:00
- **Completed:** 2026-03-15T19:30:00+08:00
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Extracted shared definition schemas and normalization helpers for language IDs, relative paths, snippets, and selection ranges.
- Centralized language/path/symbol-kind filter normalization so search and resolution use one deterministic narrowing layer.
- Added regression coverage for cross-language metadata normalization, mixed-separator path prefixes, and out-of-scope filter rejection.

## Task Commits

1. **Definition payload normalization and filter reuse** - `640b457` (feat)

## Files Created/Modified
- `tree-sitter-mcp/src/definitions/definitionTypes.ts` - shared definition schemas and filter types
- `tree-sitter-mcp/src/definitions/normalizeDefinitionMatch.ts` - metadata and range normalization helpers
- `tree-sitter-mcp/src/definitions/definitionFilters.ts` - reusable filter normalization and matching helpers
- `tree-sitter-mcp/src/definitions/searchDefinitions.ts` - normalized search results and shared filter application
- `tree-sitter-mcp/src/definitions/resolveDefinition.ts` - normalized resolution results and shared filter application
- `tree-sitter-mcp/src/workspace/resolveWorkspace.ts` - mixed-separator workspace path normalization helpers
- `tree-sitter-mcp/test/definitionNormalization.test.ts` - normalized payload and range regression coverage
- `tree-sitter-mcp/test/definitionFilters.test.ts` - filter normalization and path guard regression coverage

## Decisions Made
- Introduced a dedicated Phase 2 definition schema instead of binding tool-facing payloads to the generic symbol schema.
- Reused normalized relative-path prefixes for both search narrowing and direct definition resolution to avoid filter forks.

## Deviations from Plan

None.

## Issues Encountered
- None.

## User Setup Required

None.

## Next Phase Readiness
- Definition payloads and narrowing semantics are stable enough for MCP exposure.
- Phase 02-03 can focus on tool wiring, capability/health updates, and end-to-end stdio coverage.

## Self-Check: PASSED
- `cd tree-sitter-mcp && npm run build` passes.
- `cd tree-sitter-mcp && npm test -- --test-reporter=spec` passes with new normalization and filter suites.
- Search and resolution now report the same normalized filter payloads.

---
*Phase: 02-definition-search-core*
*Completed: 2026-03-15*
