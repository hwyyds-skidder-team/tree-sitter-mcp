---
phase: 02-definition-search-core
plan: 03
subsystem: mcp
tags: [mcp, definitions, stdio, e2e]
requires:
  - phase: 02-definition-search-core
    provides: normalized definition payloads and reusable filter semantics
provides:
  - read-only MCP tools for definition search and direct resolution
  - capability and health reporting for definition query types
  - end-to-end stdio verification for Phase 2 workflows
affects: [agent-workflows, reference-search]
tech-stack:
  added: []
  patterns: [definition-tool-registration, structured-mcp-payloads, stdio-e2e-verification]
key-files:
  created:
    - tree-sitter-mcp/src/tools/searchDefinitionsTool.ts
    - tree-sitter-mcp/src/tools/resolveDefinitionTool.ts
    - tree-sitter-mcp/test/definitionTools.e2e.test.ts
  modified:
    - tree-sitter-mcp/src/server/toolRegistry.ts
    - tree-sitter-mcp/src/tools/getCapabilitiesTool.ts
    - tree-sitter-mcp/src/tools/getHealthTool.ts
    - tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
key-decisions:
  - "Treat filter-validation failures as tool errors only when the search/resolution cannot start, while still returning structured payloads for agent chaining."
  - "Verify read-only, on-demand behavior from the MCP client boundary by asserting workspace files remain unchanged after tool calls."
patterns-established:
  - "Definition MCP tools delegate to the shared Phase 2 services instead of duplicating parsing, ranking, or filter logic."
  - "Capabilities and health advertise definition query types by extending the existing query-type inventory rather than forking separate server metadata endpoints."
requirements-completed: [SEM-01, SEM-03, SEM-04, RES-01]
duration: 35min
completed: 2026-03-15
---

# Phase 2 Plan 03: Definition Tools Summary

**Read-only MCP tools for workspace definition search and direct definition resolution, plus capability/health updates and end-to-end stdio proof.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-03-15T19:35:00+08:00
- **Completed:** 2026-03-15T20:10:00+08:00
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- Added `search_definitions` and `resolve_definition` as structured, read-only MCP tools on top of the shared backend services.
- Updated capabilities and health responses so clients can discover definition query support without implying persistent indexing or write access.
- Added stdio end-to-end coverage for filtered definition search, direct resolution, actionable diagnostics, and workspace immutability.

## Task Commits

1. **Definition MCP tool wiring and end-to-end coverage** - `a475b99` (feat)

## Files Created/Modified
- `tree-sitter-mcp/src/tools/searchDefinitionsTool.ts` - read-only definition search MCP tool
- `tree-sitter-mcp/src/tools/resolveDefinitionTool.ts` - direct definition resolution MCP tool
- `tree-sitter-mcp/src/server/toolRegistry.ts` - server registration for definition tools
- `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts` - definition query types and tool discovery updates
- `tree-sitter-mcp/src/tools/getHealthTool.ts` - definition workflow visibility in health reporting
- `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts` - capability/health coverage for definition query types
- `tree-sitter-mcp/test/definitionTools.e2e.test.ts` - stdio end-to-end coverage for search, resolution, diagnostics, and read-only behavior

## Decisions Made
- Preserved the existing tool contract pattern: concise text plus structured content, with `isError` only when no usable result can be produced.
- Verified read-only behavior by asserting the workspace file set and source contents remain unchanged after definition tool calls.

## Deviations from Plan

None.

## Issues Encountered
- None.

## User Setup Required

None.

## Next Phase Readiness
- Phase 2 user-facing definition workflow is complete from MCP bootstrap through stdio invocation.
- Phase 3 can build reference search and richer result shaping on the same normalized payload and tool conventions.

## Self-Check: PASSED
- `cd tree-sitter-mcp && npm run build` passes.
- `cd tree-sitter-mcp && npm test -- --test-reporter=spec` passes with the new definition tool end-to-end suite.
- MCP clients can now discover and call definition search/resolution over stdio without mutating the workspace.

---
*Phase: 02-definition-search-core*
*Completed: 2026-03-15*
