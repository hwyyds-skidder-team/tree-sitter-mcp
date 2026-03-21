---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Search Depth and Scale
status: planning
stopped_at: Completed 04-VERIFICATION.md
last_updated: "2026-03-21T13:53:35Z"
progress:
  total_phases: 3
  completed_phases: 2
  total_plans: 6
  completed_plans: 6
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-21)

**Core Value:** An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.
**Current Focus:** Phase 06 — relationship-views-and-impact-discovery

## Current Position

Phase: 06 (relationship-views-and-impact-discovery) — READY TO PLAN
Plan: 0 of 3

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
| Init | Start with a standalone MCP server in `tree-sitter-mcp` | Matches the requested deliverable and keeps the integration reusable across MCP clients |
| Init | Prefer stdio-first local transport for v1 | Best fit for local AI-agent workflows and lowest initial deployment complexity |
| Init | Use on-demand parsing instead of a persistent index | Reduced setup complexity for the first release, then expanded once repeated-query performance mattered |
| Phase 1 | Enforce deterministic workspace exclusions before semantic queries | Keeps dependency, vendored, and generated paths out of user-facing results |
| Phase 1 | Expose capabilities and health as explicit MCP tools | Makes the server debuggable before deeper semantic workflows exist |
| Phase 1 | Return structured diagnostics for unsupported files and parse failures | Prevents silent skips and keeps agent workflows actionable |
| Phase 2 | Keep definition search layered on top of the Phase 1 parser and workspace snapshot | Preserves the local-first architecture while adding definition workflows |
| Phase 2 | Normalize definition payloads through a dedicated schema and shared filter layer | Keeps tool-facing metadata and narrowing semantics consistent across languages |
| Phase 2 | Expose `search_definitions` and `resolve_definition` as read-only stdio tools | Completes the user-facing definition workflow without introducing writes |
| Phase 3 | Keep `search_references` as a thin MCP adapter over the shared backend | Preserves one source of truth for diagnostics, context shaping, and pagination |
| Init | Refocus v1.1 on search improvements before transport expansion | User priority is stronger search, not more connection options |
| Init | Pair persistent indexing with multi-workspace search in v1.1 | Both features need shared workspace state and freshness tracking |
| Init | Start relationship views with direct semantic links instead of whole-program graphs | Reuse the existing definition/reference pipeline before heavier analysis |

- [Phase 04]: Fingerprint each workspace from normalized root, exclusions, and schema version so persisted indexes invalidate cleanly on configuration changes.
- [Phase 04]: Build persisted semantic records with hashes, file metadata, definitions, references, and diagnostics so repeated semantic searches reuse one stored source of truth.
- [Phase 04]: Refresh only changed files before indexed search answers, and degrade broken changed files instead of serving stale records.
- [Phase 04]: Surface index mode, workspace fingerprint, refreshed files, and degraded files through bootstrap, metadata tools, and search payloads.
- [Phase 05]: Treat root as shorthand for an ordered roots list while keeping workspace.root as the legacy first-root view.
- [Phase 05]: Persist and refresh indexes per real workspace root, then expose one aggregate index summary for backward-compatible callers.
- [Phase 05]: Use workspaceRoot ownership plus { workspaceRoot, relativePath } record identity so duplicate paths stay distinct across repositories.
- [Phase 05]: Normalize `workspaceRoots` filtering centrally so definition and reference backends preserve the same path/language/kind narrowing behavior across multiple roots.
- [Phase 05]: Apply one shared exact/prefix/contains ranking helper before truncation so federated symbol and definition searches stay deterministic across roots.
- [Phase 05]: Expose additive `workspaceRoots` and `workspaceBreakdown` metadata on broad search tools while keeping single-workspace text compact for existing callers.
- [Next]: Plan Phase 06 on top of the now-verified persistent-index and multi-workspace search foundation.

## Pending Todos

None yet.

## Blockers

None.

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files | Completed |
|-------|------|----------|-------|-------|-----------|
| 04 | 01 | 3 min | 3 | 9 | 2026-03-21 |
| 04 | 02 | 1 min | 3 | 19 | 2026-03-21 |
| 04 | 03 | 1 min | 3 | 21 | 2026-03-21 |
| 05 | 01 | 22 min | 3 | 12 | 2026-03-21 |
| 05 | 02 | 16 min | 3 | 15 | 2026-03-21 |
| 05 | 03 | 3 hr 30 min | 3 | 13 | 2026-03-21 |

## Session

**Last Date:** 2026-03-21T13:53:35Z
**Stopped At:** Completed Phase 04 persistent indexing verification
**Resume File:** not created yet — plan Phase 06 next (`$gsd-plan-phase 6`)
