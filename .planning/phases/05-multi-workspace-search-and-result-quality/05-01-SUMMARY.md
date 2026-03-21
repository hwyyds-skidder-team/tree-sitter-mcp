---
phase: 05-multi-workspace-search-and-result-quality
plan: 01
subsystem: search
tags: [tree-sitter, mcp, multi-workspace, indexing, zod]
requires:
  - phase: 04-persistent-indexing-and-query-freshness
    provides: persistent workspace fingerprints, disk-backed index manifests, and freshness-aware search bootstrap
provides:
  - ordered multi-root workspace state with per-workspace summaries
  - workspace-aware discovery and persisted record ownership via workspaceRoot
  - backward-compatible set_workspace support for root and additive roots inputs
affects: [05-02, 05-03, multi-workspace search, result shaping, relationship views]
tech-stack:
  added: []
  patterns: [ordered workspace root normalization, per-root persistent index federation, additive backward-compatible tool schemas]
key-files:
  created: []
  modified:
    - tree-sitter-mcp/src/workspace/workspaceState.ts
    - tree-sitter-mcp/src/workspace/resolveWorkspace.ts
    - tree-sitter-mcp/src/workspace/discoverFiles.ts
    - tree-sitter-mcp/src/indexing/collectIndexedFileSemantics.ts
    - tree-sitter-mcp/src/indexing/buildWorkspaceIndex.ts
    - tree-sitter-mcp/src/indexing/refreshWorkspaceIndex.ts
    - tree-sitter-mcp/src/indexing/semanticIndexCoordinator.ts
    - tree-sitter-mcp/src/server/serverContext.ts
    - tree-sitter-mcp/src/tools/setWorkspaceTool.ts
    - tree-sitter-mcp/test/workspaceDiscovery.test.ts
    - tree-sitter-mcp/test/semanticIndexCoordinator.test.ts
    - tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
key-decisions:
  - "Treat root as shorthand for an ordered roots list while keeping workspace.root as the legacy first-root view."
  - "Persist and refresh indexes per real workspace root, then expose one aggregate index summary for backward-compatible callers."
  - "Use workspaceRoot ownership plus { workspaceRoot, relativePath } record identity so duplicate paths stay distinct across repositories."
patterns-established:
  - "Workspace snapshots are aggregate-first but keep ordered per-root summaries in workspace.workspaces."
  - "Persistent indexing is federated: each configured root loads, builds, and refreshes independently under its own fingerprint."
requirements-completed: [SEARCH-01]
duration: 22 min
completed: 2026-03-21
---

# Phase 05 Plan 01: Multi-workspace foundation Summary

**Ordered multi-root workspace snapshots with per-root persistent indexes and backward-compatible `set_workspace` `root`/`roots` support**

## Performance

- **Duration:** 22 min
- **Started:** 2026-03-21T08:19:01Z
- **Completed:** 2026-03-21T08:41:01Z
- **Tasks:** 3
- **Files modified:** 12

## Accomplishments
- Added canonical multi-workspace state with `roots`, `workspaceCount`, and ordered `workspaces` summaries while preserving the legacy `workspace.root` aggregate view.
- Federated discovery, persisted indexing, and refresh logic by real workspace root so duplicate paths like `src/app.ts` no longer collide across repositories.
- Extended `set_workspace` to accept legacy `root` and additive `roots`, then locked the contract with single-root and multi-root regression coverage.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define multi-workspace state and root/path normalization** - `ef467a2` (feat)
2. **Task 2: Discover and index each configured workspace without cross-root collisions** - `7a80c7c` (feat)
3. **Task 3: Make `set_workspace` bootstrap multiple roots and lock the contract with tests** - `23ddca1` (feat)

_Plan metadata commit is created after summary/state updates._

## Files Created/Modified
- `tree-sitter-mcp/src/workspace/workspaceState.ts` - Adds additive multi-root schemas, workspace entry summaries, and state helpers for aggregate plus per-root index views.
- `tree-sitter-mcp/src/workspace/resolveWorkspace.ts` - Normalizes ordered `root`/`roots` input and resolves configured paths safely across multiple workspace roots.
- `tree-sitter-mcp/src/workspace/discoverFiles.ts` - Discovers one or many configured roots and stamps every file record with its owning `workspaceRoot`.
- `tree-sitter-mcp/src/indexing/collectIndexedFileSemantics.ts` - Persists `workspaceRoot` ownership on indexed records and exposes helpers for workspace-aware record keys.
- `tree-sitter-mcp/src/indexing/buildWorkspaceIndex.ts` - Builds indexes for one or many target roots while preserving configured-root ordering.
- `tree-sitter-mcp/src/indexing/refreshWorkspaceIndex.ts` - Refreshes all configured roots with workspace-aware record identity so duplicate relative paths stay separate.
- `tree-sitter-mcp/src/indexing/semanticIndexCoordinator.ts` - Replaces single-root coordination with federated `replaceWorkspaces`, per-root persistence, and aggregate summary/freshness views.
- `tree-sitter-mcp/src/server/serverContext.ts` - Keeps aggregate and per-workspace index summaries synchronized in shared workspace state.
- `tree-sitter-mcp/src/tools/setWorkspaceTool.ts` - Accepts `root` or `roots`, deduplicates normalized roots, waits for all configured indexes, and returns additive workspace metadata.
- `tree-sitter-mcp/test/workspaceDiscovery.test.ts` - Covers duplicate-path discovery ownership and configured-root path resolution helpers.
- `tree-sitter-mcp/test/semanticIndexCoordinator.test.ts` - Verifies `replaceWorkspaces` persists duplicate relative paths independently per root.
- `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts` - Confirms health/capabilities and stdio `set_workspace` expose ordered roots without breaking single-root assertions.

## Decisions Made
- Used an additive schema change for `set_workspace` instead of replacing `root`, so existing single-root callers still receive the same primary root field.
- Kept one aggregate top-level `workspace.index` summary for compatibility, while storing authoritative per-root index summaries in `workspace.workspaces`.
- Qualified refresh/build identity by `workspaceRoot` plus `relativePath`, but kept user-facing single-root freshness strings unchanged whenever paths are unique.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Sandbox restrictions blocked git index writes and `tsx` IPC setup for tests; resolved by rerunning the required git commit and `npm test` commands with escalation.
- `gsd-tools state advance-plan` could not parse the repository’s current STATE position line, so STATE/ROADMAP position fields were repaired manually after the other automated planning updates ran.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 05-02 can now make search payloads, filters, and ranking workspace-aware using `workspaceRoot`, ordered `workspace.roots`, and `workspace.workspaces`.
- Persistent index bootstrap and refresh are already per-root, so follow-up result-shaping work can focus on query semantics instead of storage correctness.

## Self-Check: PASSED
- Found `.planning/phases/05-multi-workspace-search-and-result-quality/05-01-SUMMARY.md`
- Found commit `ef467a2`
- Found commit `7a80c7c`
- Found commit `23ddca1`
