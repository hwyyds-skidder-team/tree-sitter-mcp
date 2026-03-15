---
phase: 03-reference-search-and-agent-ready-results
plan: 03
subsystem: api
tags: [mcp, references, stdio, packaging, tree-sitter]
requires:
  - phase: 03-reference-search-and-agent-ready-results
    provides: context-rich reference search backend with deterministic pagination
  - phase: 02-definition-search-core
    provides: definition discovery and resolution workflows for tool chaining
provides:
  - read-only MCP reference search tool for discovered symbols and direct lookups
  - capability and health reporting that advertises reference-search support
  - standalone stdio packaging and end-to-end MCP workflow coverage
affects: [reference-tools, agent-workflows, packaging]
tech-stack:
  added: []
  patterns: [mcp-tool-adapter, stdio-reference-e2e, capability-derived-query-types]
key-files:
  created:
    - tree-sitter-mcp/src/tools/searchReferencesTool.ts
    - tree-sitter-mcp/test/referenceTools.e2e.test.ts
  modified:
    - tree-sitter-mcp/src/server/toolRegistry.ts
    - tree-sitter-mcp/src/tools/getCapabilitiesTool.ts
    - tree-sitter-mcp/src/tools/getHealthTool.ts
    - tree-sitter-mcp/src/languages/registerBuiltinGrammars.ts
    - tree-sitter-mcp/package.json
    - tree-sitter-mcp/README.md
    - tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
    - tree-sitter-mcp/test/serverBootstrap.test.ts
key-decisions:
  - "Expose reference search as a thin MCP adapter over the shared backend so pagination, context payloads, and diagnostics stay consistent with direct library usage."
  - "Package the server with a `bin` entry and keep stdio as the only documented launch path instead of introducing unsupported transports."
patterns-established:
  - "Capabilities, health, and grammar registration derive reference query support from the same catalogs so tool discovery stays synchronized with backend coverage."
  - "End-to-end MCP tests chain definition discovery into reference search and assert the workspace remains read-only throughout the flow."
requirements-completed: [MCP-03, SEM-02, SEM-05, RES-02]
duration: 15min
completed: 2026-03-15
---

# Phase 3 Plan 03: MCP Reference Tooling and Packaging Summary

**Read-only stdio MCP reference search with definition-to-reference chaining, standalone CLI packaging, and end-to-end workflow coverage.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-15T18:58:00+08:00
- **Completed:** 2026-03-15T19:13:46+08:00
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- Added `search_references` as a read-only MCP tool that accepts either a discovered symbol descriptor or a direct lookup and returns structured pagination, context, and diagnostics.
- Updated capabilities, health, grammar registration, and bootstrap coverage so the server advertises the finished Phase 3 reference-search surface consistently.
- Packaged the built server as a standalone CLI entry and added stdio end-to-end tests for definition-to-reference chaining, direct lookup, pagination, and missing-target diagnostics.

## Task Commits

1. **Reference MCP tool wiring, packaging, and end-to-end workflow coverage** - `702bfa4` (feat)

## Files Created/Modified
- `tree-sitter-mcp/src/tools/searchReferencesTool.ts` - MCP adapter for backend reference search with structured schemas and concise text summaries
- `tree-sitter-mcp/src/server/toolRegistry.ts` - registers `search_references` on the MCP server
- `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts` - exposes reference query types and tool discovery metadata
- `tree-sitter-mcp/src/tools/getHealthTool.ts` - advertises reference-search readiness in workspace health responses
- `tree-sitter-mcp/src/languages/registerBuiltinGrammars.ts` - keeps builtin grammar query-type coverage aligned with definition and reference catalogs
- `tree-sitter-mcp/package.json` - adds `tree-sitter-mcp` CLI packaging metadata
- `tree-sitter-mcp/README.md` - documents the full Phase 3 tool surface and stdio launch flow
- `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts` - verifies capabilities and health include reference-search support
- `tree-sitter-mcp/test/serverBootstrap.test.ts` - verifies compiled stdio bootstrap exposes the full tool list
- `tree-sitter-mcp/test/referenceTools.e2e.test.ts` - validates definition-to-reference chaining, pagination, diagnostics, and read-only behavior over stdio

## Decisions Made
- Kept `search_references` as a thin MCP boundary over `searchReferences()` instead of duplicating search logic inside the tool layer.
- Exposed standalone startup through package metadata only; transport remains stdio-first and local-only.

## Deviations from Plan

None.

## Issues Encountered
- The new reference-tool E2E test initially asserted stale pagination metadata and omitted the backend `total` field. Updated the assertion to match the stable pagination contract from 03-02.

## User Setup Required

None.

## Next Phase Readiness
- Phase 3 now has complete user-facing MCP coverage for symbol discovery, definition resolution, and reference search.
- The remaining work is phase-level verification and roadmap/state closure.

## Self-Check: PASSED
- `cd tree-sitter-mcp && npm run build` passes.
- `cd tree-sitter-mcp && npm test -- --test-reporter=spec` passes with the packaged stdio reference workflow coverage.
- The server remains stdio-first, local-only, read-only, and on-demand with no persistent index.

---
*Phase: 03-reference-search-and-agent-ready-results*
*Completed: 2026-03-15*
