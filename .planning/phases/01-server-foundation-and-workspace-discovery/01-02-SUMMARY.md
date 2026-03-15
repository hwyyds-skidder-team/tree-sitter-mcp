---
phase: 01-server-foundation-and-workspace-discovery
plan: 02
subsystem: infra
tags: [workspace, tree-sitter, discovery, exclusions]
requires:
  - phase: 01-server-foundation-and-workspace-discovery
    provides: standalone MCP bootstrap package and shared server context
provides:
  - normalized workspace root resolution with boundary checks
  - deterministic exclusion policy for dependency, generated, and vendored paths
  - builtin language registry and supported-file discovery pipeline
affects: [semantic-search, capabilities, diagnostics]
tech-stack:
  added: [tree-sitter, tree-sitter-javascript, tree-sitter-typescript, tree-sitter-python]
  patterns: [workspace-root-guardrails, deterministic-discovery, explicit-unsupported-classification]
key-files:
  created:
    - tree-sitter-mcp/src/workspace/workspaceState.ts
    - tree-sitter-mcp/src/workspace/resolveWorkspace.ts
    - tree-sitter-mcp/src/workspace/exclusionPolicy.ts
    - tree-sitter-mcp/src/workspace/discoverFiles.ts
    - tree-sitter-mcp/src/languages/languageRegistry.ts
    - tree-sitter-mcp/src/languages/registerBuiltinGrammars.ts
    - tree-sitter-mcp/test/workspaceDiscovery.test.ts
    - tree-sitter-mcp/test/languageRegistry.test.ts
  modified: []
key-decisions:
  - "Use deterministic segment/prefix exclusion matching instead of ad hoc ignore checks."
  - "Classify unsupported files explicitly so later tools can report skips instead of dropping them silently."
patterns-established:
  - "Workspace paths are always normalized and checked against the configured root."
  - "Language support is extension-driven through a registry instead of hard-coded conditionals in tools."
requirements-completed: [WORK-01, WORK-02, WORK-03]
duration: 25min
completed: 2026-03-15
---

# Phase 1 Plan 02: Workspace Discovery Summary

**Normalized workspace targeting, deterministic exclusion handling, and builtin Tree-sitter grammar registration for supported-file discovery**

## Performance

- **Duration:** 25 min
- **Started:** 2026-03-15T16:25:00+08:00
- **Completed:** 2026-03-15T16:50:00+08:00
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Added a persistent in-memory workspace model with normalized root resolution and boundary checks.
- Implemented deterministic exclusion handling for dependency, build, generated, and vendored paths.
- Registered builtin JavaScript, TypeScript, TSX, and Python grammars and discovered supported files explicitly.

## Task Commits

1. **Workspace state, exclusions, discovery, and builtin grammar registry** - `ca139f0` (feat)

## Files Created/Modified
- `tree-sitter-mcp/src/workspace/workspaceState.ts` - workspace snapshot, summary, and exclusion merge helpers
- `tree-sitter-mcp/src/workspace/resolveWorkspace.ts` - root resolution and in-root path guards
- `tree-sitter-mcp/src/workspace/exclusionPolicy.ts` - deterministic path/segment exclusion evaluation
- `tree-sitter-mcp/src/workspace/discoverFiles.ts` - supported-file enumeration and unsupported-file classification
- `tree-sitter-mcp/src/languages/languageRegistry.ts` - registry for language metadata and extension mapping
- `tree-sitter-mcp/src/languages/registerBuiltinGrammars.ts` - builtin grammar registration
- `tree-sitter-mcp/test/workspaceDiscovery.test.ts` - exclusion, discovery, and root-boundary coverage
- `tree-sitter-mcp/test/languageRegistry.test.ts` - deterministic registry coverage

## Decisions Made
- Pinned a compatible Tree-sitter dependency set around `tree-sitter@0.21.1` to satisfy grammar peer dependency constraints.
- Represented supported languages with extension maps and query-type metadata to feed later capability reporting.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Resolved tree-sitter package peer dependency conflicts**
- **Found during:** Task 2 (Build searchable file discovery and language registry)
- **Issue:** Latest package versions conflicted across `tree-sitter-typescript` and the core parser package.
- **Fix:** Installed a compatible pinned set: `tree-sitter@0.21.1`, `tree-sitter-javascript@0.21.4`, `tree-sitter-typescript@0.21.2`, `tree-sitter-python@0.21.0`.
- **Files modified:** `tree-sitter-mcp/package.json`, `tree-sitter-mcp/package-lock.json`
- **Verification:** `cd tree-sitter-mcp && npm run build && npm test -- --test-reporter=spec`
- **Committed in:** `ca139f0`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required for a buildable grammar stack. No scope creep beyond restoring compatibility.

## Issues Encountered
- Tree-sitter grammar packages did not share a common latest peer dependency version, so a compatible pinned set was required.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- The server can now target a workspace safely and discover supported files deterministically.
- User-facing capability, health, and semantic query tools can be built on top of explicit workspace and language services.

## Self-Check: PASSED
- Required files exist on disk.
- `npm test` covers discovery, exclusions, unsupported-file classification, and registry enumeration.
- Commit `ca139f0` records the workspace/discovery implementation.

---
*Phase: 01-server-foundation-and-workspace-discovery*
*Completed: 2026-03-15*
