# Roadmap: tree-sitter-mcp

## Milestones

- ✅ **v1.0 Semantic Search** — Phases 1-3 (implementation completed 2026-03-15; archived/tagged 2026-03-21) — [archive](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Search Depth and Scale** — Phases 4-6 (implementation completed 2026-03-21; archived/tagged 2026-03-22) — [archive](milestones/v1.1-ROADMAP.md)
- 🚧 **v1.2 Advanced Analysis** — Phases 7-8 (active)

## Current Status

`tree-sitter-mcp` shipped v1.1 through Phase 6. v1.2 is now defined as a two-phase milestone focused on deeper dependency traversal and confidence-aware impact analysis while preserving the existing read-only MCP boundary.

## Current Milestone

**Milestone**: v1.2 Advanced Analysis
**Goal**: Deepen the server from shallow relationship lookup into higher-value dependency and impact analysis for AI agents.
**Granularity**: Coarse
**Coverage**: 8/8 v1.2 requirements mapped
**Starting Phase**: 7

## Phases

- [ ] **Phase 7: Dependency Traversal and Path Explanation** - Agents can explore bounded multi-hop dependency structure with explanation paths and stable attribution.
- [ ] **Phase 8: Impact Prioritization and Confidence Summaries** - Agents can estimate likely blast radius with prioritized results, confidence signals, and short reasons.

## Phase Details

### Phase 7: Dependency Traversal and Path Explanation
**Goal**: Agents can inspect deeper dependency structure around a seed symbol without leaving the read-only MCP surface.
**Depends on**: Phase 6
**Requirements**: DEPS-01, DEPS-02, DEPS-03, DEPS-04
**Success Criteria** (what must be TRUE):
  1. Agent can request dependency analysis for a symbol and receive multi-hop incoming and outgoing relationships beyond the current one-hop model.
  2. Agent can bound dependency analysis by traversal depth and relationship kinds, and returned results stay inside those requested limits.
  3. Agent can inspect an explanation path for a returned symbol that shows how it connects back to the requested seed.
  4. Agent can use stable workspace and file attribution on analyzed symbols and relationships to act on the results inside local repositories.
**Plans**: 3 plans

Plans:
- [ ] 07-01-PLAN.md — Define additive dependency-analysis contracts, filter normalization, and diagnostics.
- [ ] 07-02-PLAN.md — Implement bounded multi-hop traversal and explanation-path backend on shared relationship primitives.
- [ ] 07-03-PLAN.md — Wire the dependency-analysis MCP tool and validate stdio, federated, and freshness behavior.

### Phase 8: Impact Prioritization and Confidence Summaries
**Goal**: Agents can estimate likely blast radius around a symbol through prioritized, confidence-aware impact analysis.
**Depends on**: Phase 7
**Requirements**: IMPA-01, IMPA-02, IMPA-03, IMPA-04
**Success Criteria** (what must be TRUE):
  1. Agent can request impact analysis for a symbol and receive a summarized blast-radius assessment of likely affected code.
  2. Agent can review prioritized impact targets so the most important likely downstream effects appear first.
  3. Agent can distinguish stronger and weaker impact inferences because each result includes explicit confidence metadata.
  4. Agent can read a short reasoned summary that explains the main affected areas and why they were included.
**Plans**: TBD

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 7. Dependency Traversal and Path Explanation | 0/3 | Not started | - |
| 8. Impact Prioritization and Confidence Summaries | 0/0 | Not started | - |

---
*Archived milestone details remain in `.planning/milestones/v1.0-ROADMAP.md` and `.planning/milestones/v1.1-ROADMAP.md`.*
