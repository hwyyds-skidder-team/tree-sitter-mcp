---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Search Depth and Scale
status: executing
stopped_at: Completed 05-02-PLAN.md
last_updated: "2026-03-21T09:12:21Z"
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 6
  completed_plans: 3
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-21)

**Core Value:** An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.
**Current Focus:** Phase 05 — multi-workspace-search-and-result-quality

## Current Position

Phase: 05 (multi-workspace-search-and-result-quality) — EXECUTING
Plan: 3 of 3

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
| Init | Start with a standalone MCP server in `tree-sitter-mcp` | Matches the requested deliverable and keeps the integration reusable across MCP clients |
| Init | Prefer stdio-first local transport for v1 | Best fit for local AI-agent workflows and lowest initial deployment complexity |
| Init | Use on-demand parsing instead of a persistent index | Reduces setup and state-management complexity for the first release |
| Phase 1 | Enforce deterministic workspace exclusions before semantic queries | Keeps dependency, vendored, and generated paths out of user-facing results |
| Phase 1 | Expose capabilities and health as explicit MCP tools | Makes the server debuggable before deeper semantic workflows exist |
| Phase 1 | Return structured diagnostics for unsupported files and parse failures | Prevents silent skips and keeps agent workflows actionable |
| Phase 2 | Keep definition search layered on top of the Phase 1 on-demand parser and workspace snapshot | Preserves the no-index, local-only architecture while adding definition workflows |
| Phase 2 | Normalize definition payloads through a dedicated schema and shared filter layer | Keeps tool-facing metadata and narrowing semantics consistent across languages |
| Phase 2 | Expose `search_definitions` and `resolve_definition` as read-only stdio tools | Completes the user-facing definition workflow without introducing writes or persistent indexing |
| Phase 3 | Continue planning without CONTEXT.md or RESEARCH.md | User invoked planning directly and workflow config disables research for this project |
| Phase 3 | Keep `search_references` as a thin MCP adapter over the shared backend | Preserves one source of truth for diagnostics, context shaping, and pagination |
| Phase 3 | Package standalone startup through a `bin` entry while keeping stdio-only docs | Makes local launch easier without implying unsupported transports |
| Init | Refocus v1.1 on search improvements before transport expansion | User priority is stronger search, not more connection options |
| Init | Pair persistent indexing with multi-workspace search in v1.1 | Both features need shared workspace state and freshness tracking |
| Init | Start relationship views with direct semantic links instead of whole-program graphs | Reuse the existing definition/reference pipeline before heavier analysis |

- [Phase 04]: Fingerprint each workspace from normalized root, exclusions, and schema version so persisted indexes invalidate cleanly on configuration changes. — This keeps cache reuse deterministic while forcing rebuilds when workspace scope or on-disk schema expectations change.
- [Phase 04]: Store each workspace snapshot as manifest.json plus records.json under a shared index root outside the target workspace. — Separating persisted index state from the workspace preserves the read-only boundary while keeping per-workspace data easy to invalidate and reload.
- [Phase 04]: Keep workspace summaries in sync by letting the semantic index coordinator push WorkspaceIndexSummary-shaped state into WorkspaceState. — This gives read-only tool payloads one source of truth for index freshness metadata without adding another mutable singleton.
- [Phase 05]: Treat root as shorthand for an ordered roots list while keeping workspace.root as the legacy first-root view.
- [Phase 05]: Persist and refresh indexes per real workspace root, then expose one aggregate index summary for backward-compatible callers.
- [Phase 05]: Use workspaceRoot ownership plus { workspaceRoot, relativePath } record identity so duplicate paths stay distinct across repositories.
- [Phase 05]: Normalize `workspaceRoots` filtering centrally so definition and reference backends preserve the same path/language/kind narrowing behavior across multiple roots.
- [Phase 05]: Require explicit `workspaceRoot` for ambiguous follow-up navigation instead of guessing the first configured root. — This keeps `list_file_symbols` and `resolve_definition` precise when two repositories share the same relative path or symbol name.

## Pending Todos

None yet.

## Blockers

None.

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files | Completed |
|-------|------|----------|-------|-------|-----------|
| 04 | 01 | 3 min | 3 | 9 | 2026-03-21 |
| 05 | 01 | 22 min | 3 | 12 | 2026-03-21 |
| 05 | 02 | 16 min | 3 | 14 | 2026-03-21 |

## Session

**Last Date:** 2026-03-21T09:12:21Z
**Stopped At:** Completed 05-02-PLAN.md
**Resume File:** .planning/phases/05-multi-workspace-search-and-result-quality/05-03-PLAN.md
