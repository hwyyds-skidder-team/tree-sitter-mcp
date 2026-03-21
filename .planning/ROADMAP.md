# Roadmap: tree-sitter-mcp

## Milestones

- ✅ **v1.0 Semantic Search** — Phases 1-3 (implementation completed 2026-03-15; archived/tagged 2026-03-21) — [archive](milestones/v1.0-ROADMAP.md)
- 🚧 **v1.1 Scale, Transport, and Workspace Reach** — Phases 4-6 (planned 2026-03-21)

## Current Status

Phase 04 is ready for discussion/planning. `v1.1` maps 10 requirements across 3 phases with 100% coverage.

## Overview

`v1.1` strengthens the shipped semantic-search core in three steps: first by adding reusable cache state plus multi-workspace awareness, then by exposing the same read-only tool surface over Streamable HTTP, and finally by layering relationship-centric retrieval on top of the richer workspace model. The milestone keeps the product local-first, read-only, and agent-friendly while addressing the largest gaps left by `v1.0`.

## Phases

- [ ] **Phase 4: Cache and Workspace Federation** - Add reusable semantic cache state, freshness diagnostics, and multi-root search foundations.
- [ ] **Phase 5: Streamable HTTP Transport Parity** - Expose the shipped read-only server over HTTP without regressing the proven stdio workflow.
- [ ] **Phase 6: Relationship Views and Advanced Retrieval** - Layer relationship-centric retrieval and large-result controls on top of the richer workspace model.

## Phase Details

### Phase 4: Cache and Workspace Federation
**Goal**: Introduce reusable semantic cache state, explicit freshness diagnostics, and multi-workspace search support without breaking the existing read-only search contract.
**Depends on**: Phase 3
**Requirements**: [CACHE-01, CACHE-02, CACHE-03, REACH-01]
**Success Criteria** (what must be TRUE):
  1. User can reuse semantic cache data across repeated queries for one or more configured workspaces.
  2. Changed files or workspaces trigger refresh behavior before stale results are returned.
  3. Health/capability output exposes cache mode, freshness, and coverage diagnostics.
  4. Search results include workspace attribution when a request spans multiple roots.
**Plans**: 3 plans

Plans:
- [ ] 04-01: Design shared cache/workspace state, configuration, and diagnostic surfaces.
- [ ] 04-02: Implement persistent cache lifecycle with freshness checks and targeted refresh.
- [ ] 04-03: Extend workspace targeting and semantic search pipelines to support multi-root results.

### Phase 5: Streamable HTTP Transport Parity
**Goal**: Add transport abstraction and a Streamable HTTP launch path while keeping stdio the trusted default for local agent workflows.
**Depends on**: Phase 4
**Requirements**: [HTTP-01, HTTP-02, HTTP-03]
**Success Criteria** (what must be TRUE):
  1. User can launch the same server over stdio or Streamable HTTP from documented entrypoints.
  2. HTTP exposes the same read-only tools, schemas, and error contracts as stdio.
  3. Operator can configure safe local HTTP listener settings without disturbing stdio defaults.
  4. Server info and health output clearly report the active transport for debugging.
**Plans**: 3 plans

Plans:
- [ ] 05-01: Refactor runtime bootstrapping around transport selection and shared server creation.
- [ ] 05-02: Add HTTP listener configuration, validation, and lifecycle management.
- [ ] 05-03: Add parity tests and docs for stdio and HTTP launch flows.

### Phase 6: Relationship Views and Advanced Retrieval
**Goal**: Build relationship-centric retrieval on top of the cached multi-workspace search foundation and keep large result sets usable for agents.
**Depends on**: Phase 5
**Requirements**: [REACH-02, REACH-03, REACH-04]
**Success Criteria** (what must be TRUE):
  1. User can request a relationship view for a resolved symbol with direct incoming and outgoing links.
  2. Each related symbol includes workspace attribution and precise source locations for follow-up navigation.
  3. Users can filter and paginate relationship results by workspace, language, and relationship kind.
  4. Advanced retrieval remains read-only and behaves consistently across stdio and HTTP.
**Plans**: 3 plans

Plans:
- [ ] 06-01: Model relationship queries and result schemas on top of existing definition/reference data.
- [ ] 06-02: Implement filters, pagination, and workspace-aware result shaping for relationship views.
- [ ] 06-03: Validate end-to-end advanced-retrieval workflows across large and multi-workspace repositories.

## Progress

**Execution Order:**
Phases execute in numeric order: 4 → 5 → 6

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 4. Cache and Workspace Federation | v1.1 | 0/3 | Not started | - |
| 5. Streamable HTTP Transport Parity | v1.1 | 0/3 | Not started | - |
| 6. Relationship Views and Advanced Retrieval | v1.1 | 0/3 | Not started | - |

---
*For shipped milestone details, see `.planning/milestones/v1.0-ROADMAP.md`.*
