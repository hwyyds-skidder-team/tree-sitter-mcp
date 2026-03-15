---
phase: 01-server-foundation-and-workspace-discovery
plan: 01
subsystem: infra
tags: [mcp, typescript, stdio, bootstrap]
requires: []
provides:
  - standalone tree-sitter-mcp package with local build, start, and test scripts
  - stdio MCP bootstrap through a server factory and tool registry boundary
  - smoke-tested server launch path for local MCP clients
affects: [workspace, semantic-search, diagnostics]
tech-stack:
  added: [@modelcontextprotocol/sdk, typescript, tsx, zod]
  patterns: [stdio-first transport, server-factory-boundary, structured-tool-output]
key-files:
  created:
    - tree-sitter-mcp/package.json
    - tree-sitter-mcp/tsconfig.json
    - tree-sitter-mcp/src/index.ts
    - tree-sitter-mcp/src/server/createServer.ts
    - tree-sitter-mcp/src/server/toolRegistry.ts
    - tree-sitter-mcp/src/server/serverContext.ts
    - tree-sitter-mcp/src/config/runtimeConfig.ts
    - tree-sitter-mcp/test/serverBootstrap.test.ts
    - tree-sitter-mcp/README.md
    - tree-sitter-mcp/.gitignore
  modified: []
key-decisions:
  - "Keep the server in a standalone tree-sitter-mcp package so MCP clients can launch it without repo-root glue."
  - "Separate transport bootstrap, server construction, and tool registration so workspace/search logic can evolve independently."
patterns-established:
  - "Bootstrap boundary: src/index.ts owns stdio transport only."
  - "Agent-ready responses: tools return concise text plus structuredContent."
requirements-completed: [MCP-01]
duration: 20min
completed: 2026-03-15
---

# Phase 1 Plan 01: Bootstrap Package Summary

**Standalone TypeScript MCP server package with stdio bootstrap, isolated server factory wiring, and automated client launch smoke coverage**

## Performance

- **Duration:** 20 min
- **Started:** 2026-03-15T16:05:00+08:00
- **Completed:** 2026-03-15T16:25:00+08:00
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- Created `tree-sitter-mcp/` as an independently runnable npm package.
- Wired stdio MCP bootstrap behind a server factory and registry boundary.
- Added smoke coverage that launches the compiled server as an MCP subprocess.

## Task Commits

1. **Bootstrap package, runtime config, and stdio server shell** - `5e67eec` (feat)

## Files Created/Modified
- `tree-sitter-mcp/package.json` - package metadata, scripts, and MCP/tree-sitter dependencies
- `tree-sitter-mcp/tsconfig.json` - standalone TypeScript build configuration
- `tree-sitter-mcp/src/index.ts` - stdio entrypoint
- `tree-sitter-mcp/src/server/createServer.ts` - MCP server factory
- `tree-sitter-mcp/src/server/toolRegistry.ts` - registry boundary for bootstrap and later tools
- `tree-sitter-mcp/src/server/serverContext.ts` - shared runtime/server state container
- `tree-sitter-mcp/src/config/runtimeConfig.ts` - runtime defaults including exclusion seeds
- `tree-sitter-mcp/test/serverBootstrap.test.ts` - subprocess bootstrap smoke test
- `tree-sitter-mcp/README.md` - quickstart and Phase 1 tool surface
- `tree-sitter-mcp/.gitignore` - excludes generated artifacts and dependencies

## Decisions Made
- Used stdio as the only transport for v1.
- Kept startup free of workspace crawling and persistent index creation.
- Added package-local `.gitignore` so generated artifacts do not pollute repo state.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added package-local ignore rules**
- **Found during:** Task 1 (Scaffold the standalone TypeScript package)
- **Issue:** Generated `dist/` output and `node_modules/` would otherwise be committed accidentally.
- **Fix:** Added `tree-sitter-mcp/.gitignore`.
- **Files modified:** `tree-sitter-mcp/.gitignore`
- **Verification:** `git status` no longer surfaces generated artifacts.
- **Committed in:** `5e67eec`

**2. [Rule 1 - Bug] Closed the stdio transport explicitly in bootstrap tests**
- **Found during:** Task 3 (Add bootstrap smoke tests)
- **Issue:** `client.close()` alone left the child process alive, causing test hangs.
- **Fix:** Added explicit `transport.close()` in `finally`.
- **Files modified:** `tree-sitter-mcp/test/serverBootstrap.test.ts`
- **Verification:** `cd tree-sitter-mcp && npm test -- --test-reporter=spec`
- **Committed in:** `5e67eec`

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug)
**Impact on plan:** Both fixes were required for a reliable standalone package and repeatable test execution. No scope creep.

## Issues Encountered
- MCP stdio child processes stayed open during tests until the client transport was explicitly closed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- The server boots locally over stdio and exposes a clean registration boundary.
- Workspace discovery and grammar registration can now be added without touching transport bootstrap.

## Self-Check: PASSED
- Required files exist on disk.
- `npm run build` and `npm test` pass.
- Commit `5e67eec` records the bootstrap package work.

---
*Phase: 01-server-foundation-and-workspace-discovery*
*Completed: 2026-03-15*
