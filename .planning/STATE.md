---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Search Depth and Scale
current_phase: 04
current_phase_name: Persistent Indexing and Query Freshness
current_plan: 02
total_plans_in_phase: 3
status: executing
stopped_at: Completed 04-01-PLAN.md
last_updated: "2026-03-21T06:28:18.943Z"
last_activity: 2026-03-21 - Completed 04-01 Persistent Index Foundation.
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 3
  completed_plans: 1
  percent: 33
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-21)

**Core Value:** An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.
**Current Focus:** Phase 04 — Persistent Indexing and Query Freshness

## Current Position

**Current Phase:** 04
**Current Phase Name:** Persistent Indexing and Query Freshness
**Total Phases:** 3
**Current Plan:** 2
**Total Plans in Phase:** 3
**Status:** Executing
**Last Activity:** 2026-03-21 - Completed 04-01 Persistent Index Foundation.
**Progress:** [███░░░░░░░] 33%

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

## Pending Todos

None yet.

## Blockers

None.

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files | Completed |
|-------|------|----------|-------|-------|-----------|
| 04 | 01 | 3 min | 3 | 9 | 2026-03-21 |

## Session

**Last Date:** 2026-03-21T06:28:18.939Z
**Stopped At:** Completed 04-01-PLAN.md
**Resume File:** .planning/phases/04-persistent-indexing-and-query-freshness/04-02-PLAN.md
