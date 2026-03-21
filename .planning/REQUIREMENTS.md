# Requirements: tree-sitter-mcp

**Defined:** 2026-03-21
**Core Value:** An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.

## v1.1 Requirements

### Search Performance

- [x] **PERF-01**: User can reuse a persistent semantic index or cache across repeated queries instead of reparsing every request from scratch.
- [x] **PERF-02**: User can trust indexed search results because changed files or workspaces are detected and refreshed before stale answers are returned.
- [ ] **PERF-03**: User can inspect index/cache mode, freshness, and coverage through explicit diagnostics or health output.

### Search Reach

- [x] **SEARCH-01**: User can search across multiple configured workspace roots in one request.
- [ ] **SEARCH-02**: User can see which workspace every result came from and filter by workspace when narrowing results.
- [ ] **SEARCH-03**: User can rank or narrow broad search results by symbol kind, language, and path/workspace scope so large repositories stay usable.

### Search Depth

- [ ] **REL-01**: User can request a relationship view for a resolved symbol that shows direct incoming and outgoing semantic links.
- [ ] **REL-02**: User can see precise source locations and workspace attribution for each related symbol.
- [ ] **REL-03**: User can filter and paginate relationship results by workspace, language, and relationship kind.
- [ ] **REL-04**: User can inspect a small impact-oriented neighborhood around a symbol (for example callers, callees, imports, or references) without leaving read-only search workflows.

## Future Requirements

### Transport and Integrations

- **HTTP-01**: User can connect to `tree-sitter-mcp` over Streamable HTTP as an alternative to local stdio.
- **HTTP-02**: User gets the same read-only tool surface and structured response contracts over HTTP as over stdio.
- **HTTP-03**: User can configure safe HTTP listener settings without breaking the zero-config stdio path.
- **INT-01**: User can install editor-specific integrations that wrap the standalone MCP server.

### Retrieval Depth

- **REL-05**: User can generate deeper impact-analysis or call-graph style relationship reports beyond direct semantic links.
- **PERF-04**: User can warm or refresh caches proactively in the background for very large repositories.

### Write Workflows

- **WRITE-01**: User can drive safe semantic edits or refactors after the read-only search workflow proves valuable.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Streamable HTTP transport in v1.1 | User priority is improving search first rather than adding a second transport |
| Shared hosted index service | Local-first validation remains the product focus |
| Whole-program static analysis or full exported call graphs | Start with direct relationship views on top of existing semantic-search primitives |
| Automated code mutation or refactoring | Keep the milestone read-only while retrieval depth expands |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PERF-01 | Phase 4 | Complete |
| PERF-02 | Phase 4 | Complete |
| PERF-03 | Phase 4 | Pending |
| SEARCH-01 | Phase 5 | Complete |
| SEARCH-02 | Phase 5 | Pending |
| SEARCH-03 | Phase 5 | Pending |
| REL-01 | Phase 6 | Pending |
| REL-02 | Phase 6 | Pending |
| REL-03 | Phase 6 | Pending |
| REL-04 | Phase 6 | Pending |

**Coverage:**
- v1.1 requirements: 10 total
- Mapped to phases: 10
- Unmapped: 0

---
*Requirements defined: 2026-03-21*
*Last updated: 2026-03-21 after refocusing milestone v1.1 on search improvements*
