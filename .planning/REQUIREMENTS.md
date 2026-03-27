# Requirements: tree-sitter-mcp

**Defined:** 2026-03-27
**Core Value:** An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.

## v1.2 Requirements

### Dependency Analysis

- [ ] **DEPS-01**: Agent can request multi-hop dependency analysis for a symbol and receive structured incoming/outgoing relationships beyond the current one-hop model.
- [x] **DEPS-02**: Agent can bound dependency analysis by traversal depth and relationship kinds so results stay scoped and usable.
- [x] **DEPS-03**: Agent can inspect an explanation path that shows how a returned symbol is connected to the requested seed.
- [x] **DEPS-04**: Agent receives stable workspace/file attribution for analyzed symbols and relationships so results stay actionable in local repos.

### Impact Analysis

- [ ] **IMPA-01**: Agent can request impact analysis for a symbol and receive a summarized blast-radius view of likely affected code.
- [ ] **IMPA-02**: Agent receives prioritized impact targets so the most important likely downstream effects appear first.
- [ ] **IMPA-03**: Agent receives confidence metadata for each impact result so uncertain inferences are explicit.
- [ ] **IMPA-04**: Agent receives a short reasoned summary explaining the main affected areas and why they were included.

## Future Requirements

### Analysis Shape

- **MODL-01**: Agent can view advanced analysis aggregated at file/module boundaries instead of symbol-only output.
- **XWS-01**: Agent can run first-class federated impact traversal across multiple workspace roots as an explicit advanced-analysis mode.

### Other Directions

- **HTTP-01**: Agent can connect to `tree-sitter-mcp` over Streamable HTTP as an alternative to local stdio.
- **WRITE-01**: Agent can drive safe semantic edits or refactors after the read-only search workflow proves valuable.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Streamable HTTP transport in v1.2 | Transport expansion is not the focus of this milestone |
| Automated code mutation or refactor execution | This milestone stays on the read-only side of the boundary |
| Whole-program architecture dashboards | Broader visualization is larger than the agent-first analysis scope |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DEPS-01 | Phase 7 | Pending |
| DEPS-02 | Phase 7 | Complete |
| DEPS-03 | Phase 7 | Complete |
| DEPS-04 | Phase 7 | Complete |
| IMPA-01 | Phase 8 | Pending |
| IMPA-02 | Phase 8 | Pending |
| IMPA-03 | Phase 8 | Pending |
| IMPA-04 | Phase 8 | Pending |

**Coverage:**
- v1.2 requirements: 8 total
- Mapped to phases: 8
- Unmapped: 0

---
*Requirements defined: 2026-03-27*
*Last updated: 2026-03-27 after roadmap creation*
