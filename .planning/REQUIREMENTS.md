# Requirements: tree-sitter-mcp

**Defined:** 2026-03-21
**Core Value:** An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.

## v1.1 Requirements

### Multi-Transport Access

- [ ] **HTTP-01**: User can connect to `tree-sitter-mcp` over Streamable HTTP as an alternative to local stdio.
- [ ] **HTTP-02**: User gets the same read-only tool surface and structured response contracts over HTTP as over stdio.
- [ ] **HTTP-03**: User can configure safe HTTP listener settings (for example host and port) without breaking the zero-config stdio path.

### Query Reuse and Workspace Federation

- [ ] **CACHE-01**: User can reuse persistent semantic cache data across repeated queries instead of reparsing every request from scratch.
- [ ] **CACHE-02**: User can trust cached search results because changed files or workspaces are detected and refreshed before stale answers are returned.
- [ ] **CACHE-03**: User can inspect cache mode, freshness, and coverage through explicit diagnostics or health output.
- [ ] **REACH-01**: User can search across multiple configured workspace roots in one request and see which workspace each result came from.

### Relationship Retrieval

- [ ] **REACH-02**: User can request a relationship view for a resolved symbol that shows direct incoming and outgoing semantic links.
- [ ] **REACH-03**: User can see precise source locations and workspace attribution for each related symbol so the result can drive navigation or impact analysis.
- [ ] **REACH-04**: User can filter and paginate relationship results by workspace, language, and relationship kind to keep large result sets usable.

## Future Requirements

### Transport and Integrations

- **HTTP-04**: Operator can protect HTTP deployments with auth/TLS and other remote-facing hardening when local-only mode is no longer enough.
- **INT-01**: User can install editor-specific integrations that wrap the standalone MCP server.

### Retrieval Depth

- **CACHE-04**: User can warm or refresh caches proactively in the background for very large repositories.
- **REACH-05**: User can generate deeper impact-analysis or call-graph style relationship reports beyond direct semantic links.

### Write Workflows

- **WRITE-01**: User can drive safe semantic edits or refactors after the read-only search workflow proves valuable.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Shared hosted index service | Local-first validation remains the product focus for v1.1 |
| Full remote deployment security/auth stack | Local-only or trusted-network HTTP is enough for this milestone |
| Whole-program static analysis or exported call graphs | Start with direct relationship views on top of existing semantic-search primitives |
| Automated code mutation or refactoring | Keep the milestone read-only while retrieval and transport expand |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CACHE-01 | Phase 4 | Pending |
| CACHE-02 | Phase 4 | Pending |
| CACHE-03 | Phase 4 | Pending |
| REACH-01 | Phase 4 | Pending |
| HTTP-01 | Phase 5 | Pending |
| HTTP-02 | Phase 5 | Pending |
| HTTP-03 | Phase 5 | Pending |
| REACH-02 | Phase 6 | Pending |
| REACH-03 | Phase 6 | Pending |
| REACH-04 | Phase 6 | Pending |

**Coverage:**
- v1.1 requirements: 10 total
- Mapped to phases: 10
- Unmapped: 0

---
*Requirements defined: 2026-03-21*
*Last updated: 2026-03-21 after defining milestone v1.1 requirements*
