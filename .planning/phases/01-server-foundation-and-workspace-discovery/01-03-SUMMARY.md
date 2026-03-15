---
phase: 01-server-foundation-and-workspace-discovery
plan: 03
subsystem: api
tags: [mcp, tree-sitter, diagnostics, semantic-search]
requires:
  - phase: 01-server-foundation-and-workspace-discovery
    provides: standalone MCP bootstrap package and shared server context
  - phase: 01-server-foundation-and-workspace-discovery
    provides: workspace discovery, exclusion policy, and language registry
provides:
  - workspace, capability, and health MCP tools
  - on-demand file-symbol and workspace-symbol semantic queries
  - shared structured diagnostics for unsupported and parse-failure paths
affects: [phase-2-definition-search, phase-3-reference-search]
tech-stack:
  added: []
  patterns: [on-demand-parse, shared-diagnostic-factory, read-only-mcp-tools]
key-files:
  created:
    - tree-sitter-mcp/src/tools/setWorkspaceTool.ts
    - tree-sitter-mcp/src/tools/getCapabilitiesTool.ts
    - tree-sitter-mcp/src/tools/getHealthTool.ts
    - tree-sitter-mcp/src/tools/listFileSymbolsTool.ts
    - tree-sitter-mcp/src/tools/searchWorkspaceSymbolsTool.ts
    - tree-sitter-mcp/src/queries/queryCatalog.ts
    - tree-sitter-mcp/src/parsing/parseWithDiagnostics.ts
    - tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts
    - tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
    - tree-sitter-mcp/test/semanticTools.e2e.test.ts
  modified: []
key-decisions:
  - "Keep semantic search strictly on-demand; no persistent index or background crawler is introduced."
  - "Route unsupported files, unsupported languages, and parse failures through one structured diagnostic shape."
patterns-established:
  - "Capability and health payloads always expose parser mode, query types, workspace root, and exclusion state."
  - "Semantic query tools read from discovered workspace files and respect exclusions before parsing."
requirements-completed: [MCP-02, WORK-01, WORK-02, WORK-03, WORK-04, RES-03]
duration: 35min
completed: 2026-03-15
---

# Phase 1 Plan 03: Tool Surface and Diagnostics Summary

**Read-only MCP workspace/introspection tools plus on-demand Tree-sitter symbol queries with actionable structured diagnostics**

## Performance

- **Duration:** 35 min
- **Started:** 2026-03-15T16:50:00+08:00
- **Completed:** 2026-03-15T17:25:00+08:00
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- Added `set_workspace`, `get_capabilities`, and `get_health` for explicit workspace control and introspection.
- Implemented `list_file_symbols` and `search_workspace_symbols` on top of on-demand Tree-sitter parsing.
- Standardized structured diagnostics for unsupported files, unsupported languages, missing workspace state, and parse failures.

## Task Commits

1. **Capability, health, diagnostics, and semantic symbol tools** - `20004ec` (feat)

## Files Created/Modified
- `tree-sitter-mcp/src/tools/setWorkspaceTool.ts` - workspace discovery MCP tool
- `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts` - capability reporting tool
- `tree-sitter-mcp/src/tools/getHealthTool.ts` - health/state reporting tool
- `tree-sitter-mcp/src/tools/listFileSymbolsTool.ts` - per-file semantic symbol listing
- `tree-sitter-mcp/src/tools/searchWorkspaceSymbolsTool.ts` - workspace-wide symbol search
- `tree-sitter-mcp/src/queries/queryCatalog.ts` - language-specific symbol query definitions and extraction
- `tree-sitter-mcp/src/parsing/parseWithDiagnostics.ts` - on-demand parse wrapper with diagnostics
- `tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts` - shared diagnostic structure and ranges
- `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts` - stdio introspection coverage
- `tree-sitter-mcp/test/semanticTools.e2e.test.ts` - stdio semantic search and diagnostic coverage

## Decisions Made
- Search uses name-based semantic matching across discovered workspace files and returns diagnostics alongside partial results.
- Health responses surface unsupported files so clients can inspect what was skipped without scraping logs.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 1 now exposes a debuggable tool surface for workspace setup and symbol search over stdio.
- Phase 2 can focus on richer definition search and filtering on top of the same parse/query pipeline.

## Self-Check: PASSED
- Required files exist on disk.
- `npm test -- --test-reporter=spec` passes end-to-end stdio capability, health, and semantic-tool coverage.
- Commit `20004ec` records the user-facing Phase 1 tool surface.

---
*Phase: 01-server-foundation-and-workspace-discovery*
*Completed: 2026-03-15*
