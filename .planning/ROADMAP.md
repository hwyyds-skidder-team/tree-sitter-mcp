# Roadmap: tree-sitter-mcp

## Milestones

- ✅ **v1.0 Semantic Search** — Phases 1-3 (implementation completed 2026-03-15; archived/tagged 2026-03-21) — [archive](milestones/v1.0-ROADMAP.md)
- 🚧 **v1.1 Search Depth and Scale** — Phases 4-6 (revised 2026-03-21)

## Current Status

Phases 04 and 05 are now both complete and verified. The next milestone step is Phase 06 relationship-view planning, building on the verified persistent-index and multi-workspace search foundation.

## Overview

`v1.1` focuses on search itself in three layers: first make repeated semantic queries fast and trustworthy with persistent state, then widen the search surface across multiple workspaces while keeping results navigable, and finally add relationship-aware retrieval so agents can inspect impact instead of only raw matches. HTTP transport is intentionally deferred until these search improvements land.

## Phases

- [x] **Phase 4: Persistent Indexing and Query Freshness** - Add reusable semantic state, invalidation, and explicit freshness diagnostics.
- [x] **Phase 5: Multi-Workspace Search and Result Quality** - Expand search across workspace roots and improve narrowing/ranking for large result sets.
- [ ] **Phase 6: Relationship Views and Impact Discovery** - Layer direct semantic relationships and impact-oriented retrieval on top of the stronger search foundation.

## Phase Details

### Phase 4: Persistent Indexing and Query Freshness
**Goal**: Introduce reusable semantic state so repeated queries become faster without returning stale answers or hiding freshness details from the caller.
**Depends on**: Phase 3
**Requirements**: [PERF-01, PERF-02, PERF-03]
**Success Criteria** (what must be TRUE):
  1. User can rerun semantic searches without reparsing the whole workspace each time.
  2. File or workspace changes trigger invalidation/refresh before stale search results are returned.
  3. Health or capability output clearly reports index/cache mode, freshness, and coverage.
  4. The new persistent state keeps the current read-only MCP contract intact.
**Plans**: 3 plans

Plans:
- [x] 04-01: Design persistent semantic state, storage boundaries, and invalidation rules.
- [x] 04-02: Implement index/cache build, reuse, and targeted refresh paths for repeated queries.
- [x] 04-03: Surface freshness diagnostics and add regression coverage for stale-result prevention.

### Phase 5: Multi-Workspace Search and Result Quality
**Goal**: Let agents search across multiple workspace roots while keeping large result sets understandable, attributable, and filterable.
**Depends on**: Phase 4
**Requirements**: [SEARCH-01, SEARCH-02, SEARCH-03]
**Success Criteria** (what must be TRUE):
  1. User can issue one semantic search against multiple configured workspace roots.
  2. Every result identifies its source workspace so follow-up navigation stays precise.
  3. User can narrow broad results by workspace, path, language, or symbol kind to reduce noise.
  4. Search behavior stays backward-compatible for single-workspace callers.
**Plans**: 3 plans

Plans:
- [x] 05-01: Extend workspace configuration and discovery to support multiple active roots.
- [x] 05-02: Make search pipelines and result payloads workspace-aware with stronger narrowing controls.
- [x] 05-03: Validate search quality on larger or federated repositories and refine result shaping.

### Phase 6: Relationship Views and Impact Discovery
**Goal**: Build relationship-aware retrieval on top of the stronger search foundation so agents can inspect direct links and likely impact around a symbol.
**Depends on**: Phase 5
**Requirements**: [REL-01, REL-02, REL-03, REL-04]
**Success Criteria** (what must be TRUE):
  1. User can request a relationship view for a symbol with direct incoming and outgoing semantic links.
  2. Each related symbol includes precise source locations and workspace attribution.
  3. Relationship results can be filtered and paginated by workspace, language, and relationship kind.
  4. User can inspect a small impact-oriented neighborhood around a symbol without leaving read-only search workflows.
**Plans**: 3 plans

Plans:
- [ ] 06-01: Model relationship queries and schemas using existing definition/reference primitives.
- [ ] 06-02: Implement relationship traversal, filtering, pagination, and workspace-aware payload shaping.
- [ ] 06-03: Validate relationship and impact workflows against realistic multi-workspace repositories.

## Progress

**Execution Order:**
Phases execute in numeric order: 4 → 5 → 6

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 4. Persistent Indexing and Query Freshness | v1.1 | 3/3 | Complete | 2026-03-21 |
| 5. Multi-Workspace Search and Result Quality | v1.1 | 3/3 | Complete | 2026-03-21 |
| 6. Relationship Views and Impact Discovery | v1.1 | 0/3 | Not started | - |

---
*For shipped milestone details, see `.planning/milestones/v1.0-ROADMAP.md`.*
