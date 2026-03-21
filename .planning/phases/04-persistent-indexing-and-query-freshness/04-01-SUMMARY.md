---
phase: 04-persistent-indexing-and-query-freshness
plan: 01
subsystem: infra
tags: [indexing, persistence, freshness, zod, workspace-state]
requires:
  - phase: 03-reference-search-and-agent-ready-results
    provides: read-only search pipelines and shared workspace/server state
provides:
  - disk-backed runtime configuration for persistent semantic indexes
  - versioned manifest and record schemas for workspace index snapshots
  - server-owned semantic index coordination with freshness lifecycle summaries
affects: [phase-04-02, workspace-state, diagnostics]
tech-stack:
  added: []
  patterns: [fingerprinted-index-storage, schema-validated-cache-manifests, coordinator-summary-sync]
key-files:
  created:
    - tree-sitter-mcp/src/indexing/indexTypes.ts
    - tree-sitter-mcp/src/indexing/workspaceFingerprint.ts
    - tree-sitter-mcp/src/indexing/indexStorage.ts
    - tree-sitter-mcp/src/indexing/semanticIndexCoordinator.ts
    - tree-sitter-mcp/test/indexStorage.test.ts
    - tree-sitter-mcp/test/semanticIndexCoordinator.test.ts
  modified:
    - tree-sitter-mcp/src/config/runtimeConfig.ts
    - tree-sitter-mcp/src/server/serverContext.ts
    - tree-sitter-mcp/src/workspace/workspaceState.ts
key-decisions:
  - "Fingerprint each workspace from normalized root, exclusions, and schema version so persisted indexes invalidate cleanly on configuration changes."
  - "Store each workspace snapshot as manifest.json plus records.json under a shared index root outside the target workspace."
  - "Keep workspace summaries in sync by letting the semantic index coordinator push WorkspaceIndexSummary-shaped state into WorkspaceState."
patterns-established:
  - "Persistent index metadata flows through shared Zod schemas before touching disk or tool-facing summaries."
  - "ServerContext owns one semantic index coordinator and mirrors its summary into WorkspaceState for read-only consumers."
requirements-completed: [PERF-01, PERF-02]
duration: 3 min
completed: 2026-03-21
---

# Phase 04 Plan 01: Persistent Index Foundation Summary

**Disk-backed semantic index manifests, schema-versioned workspace fingerprints, and coordinator-managed freshness state for repeated search reuse.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-21T14:23:24+08:00
- **Completed:** 2026-03-21T06:27:20Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments
- Added runtime configuration for persistent semantic indexing with `TREE_SITTER_MCP_INDEX_DIR`, a default home-directory cache root, and explicit `indexSchemaVersion`.
- Introduced shared manifest, record, and summary schemas plus deterministic workspace fingerprinting and disk storage with schema-mismatch invalidation.
- Wired a semantic index coordinator into `ServerContext` and `WorkspaceState`, then locked lifecycle behavior with storage and coordinator regression tests.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define persistent index schemas and runtime configuration** - `aa2ec99` (feat)
2. **Task 2: Implement workspace fingerprinting and disk-backed index storage** - `546d2a2` (feat)
3. **Task 3: Wire a semantic-index coordinator into server and workspace state** - `7d7f362` (feat)

## Files Created/Modified
- `tree-sitter-mcp/src/config/runtimeConfig.ts` - adds persistent index root and schema version runtime settings
- `tree-sitter-mcp/src/workspace/workspaceState.ts` - extends workspace summaries/state with `WorkspaceIndexSummarySchema` metadata
- `tree-sitter-mcp/src/indexing/indexTypes.ts` - defines freshness, manifest, record, and summary Zod schemas
- `tree-sitter-mcp/src/indexing/workspaceFingerprint.ts` - hashes normalized workspace identity with `createHash("sha1")`
- `tree-sitter-mcp/src/indexing/indexStorage.ts` - persists `manifest.json` and `records.json` per workspace fingerprint
- `tree-sitter-mcp/src/indexing/semanticIndexCoordinator.ts` - coordinates persistent index lifecycle state and storage writes
- `tree-sitter-mcp/src/server/serverContext.ts` - owns the semantic index coordinator beside workspace state
- `tree-sitter-mcp/test/indexStorage.test.ts` - verifies disk persistence and schema-version invalidation
- `tree-sitter-mcp/test/semanticIndexCoordinator.test.ts` - verifies rebuilding, refreshed, and degraded lifecycle transitions

## Decisions Made
- Used per-workspace fingerprint directories under a shared cache root instead of one global index file, keeping invalidation and reuse isolated.
- Invalidated schema-mismatched persisted data during load rather than attempting in-place migration.
- Mirrored coordinator summaries into `WorkspaceState` through a callback so read-only summaries can carry index metadata without extra global state.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Sandbox restrictions blocked direct `git` index writes and `tsx` IPC socket creation for `npm test`; rerunning those commands with approval resolved execution without code changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 04 now has versioned persistent-index primitives, freshness-state summaries, and regression coverage for storage/coordinator behavior.
- Ready for `04-02` to build and refresh actual indexed semantic content on top of this foundation.

---
*Phase: 04-persistent-indexing-and-query-freshness*
*Completed: 2026-03-21*

## Self-Check: PASSED
- Verified key indexing modules, tests, and summary file exist on disk.
- Verified task commits `aa2ec99`, `546d2a2`, and `7d7f362` exist in git history.
