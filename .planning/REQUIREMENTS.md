# Requirements: tree-sitter-mcp

**Defined:** 2026-03-12
**Core Value:** An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.

## v1 Requirements

### MCP Interface

- [x] **MCP-01**: User can run `tree-sitter-mcp` as a standalone MCP server from the dedicated `tree-sitter-mcp` directory.
- [x] **MCP-02**: User can call read-only semantic code search tools from an MCP client over local transport without setting up a persistent index first.
- [ ] **MCP-03**: User receives structured tool results that include machine-readable fields plus concise text summaries suitable for AI-agent workflows.

### Workspace Discovery

- [x] **WORK-01**: User can target a workspace root for analysis and limit searches to supported source files inside that workspace.
- [x] **WORK-02**: User can configure or inspect path exclusions so generated, vendored, and dependency directories do not dominate results.
- [x] **WORK-03**: User can see which languages/grammars are available for the current server instance and which files were skipped as unsupported.
- [x] **WORK-04**: User gets actionable errors when parsing fails or when a requested language/file is unsupported.

### Semantic Search

- [x] **SEM-01**: User can search for symbol definitions by name across the workspace and receive symbol kind, file path, and source location.
- [ ] **SEM-02**: User can find references or call sites for a symbol within the workspace.
- [x] **SEM-03**: User can retrieve the definition for a discovered symbol or reference target.
- [x] **SEM-04**: User can restrict semantic searches by path, language, and symbol kind to reduce noise.
- [ ] **SEM-05**: User can request surrounding syntax context for each match, including enclosing scope and a short source snippet.

### Result Handling

- [x] **RES-01**: User receives stable line/column ranges for every semantic match so another tool can open the exact location.
- [ ] **RES-02**: User can paginate large result sets and see whether more matches remain.
- [x] **RES-03**: User can inspect server capabilities or health before searching, including supported query types and current workspace constraints.

## v2 Requirements

### Advanced Retrieval

- **ADV-01**: User can build and reuse a persistent semantic index for faster repeated queries.
- **ADV-02**: User can ask for higher-level relationship views such as call graphs, dependency chains, or impact analysis.
- **ADV-03**: User can search across multiple repositories or configured workspace roots in one request.

### Transports and Integrations

- **INT-01**: User can expose the server over Streamable HTTP in addition to local stdio transport.
- **INT-02**: User can install editor-specific integrations that wrap the standalone MCP server.

### Write Workflows

- **WR-01**: User can drive safe semantic edits or refactors after read-only search proves valuable.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Persistent background indexer in v1 | User chose on-demand parsing first to reduce setup and operational complexity |
| Code mutation or automated refactoring in v1 | Initial release focuses on trustworthy search and discovery |
| Full LSP replacement | Broader IDE features are not required to validate the MCP value proposition |
| Embedding/vector semantic search | Tree-sitter structural search is the core differentiator for the first milestone |
| Remote SaaS search service | Initial scope is a local standalone MCP plugin/server |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| MCP-01 | Phase 1 | Complete |
| MCP-02 | Phase 1 | Complete |
| MCP-03 | Phase 3 | Pending |
| WORK-01 | Phase 1 | Complete |
| WORK-02 | Phase 1 | Complete |
| WORK-03 | Phase 1 | Complete |
| WORK-04 | Phase 1 | Complete |
| SEM-01 | Phase 2 | Complete |
| SEM-02 | Phase 3 | Pending |
| SEM-03 | Phase 2 | Complete |
| SEM-04 | Phase 2 | Complete |
| SEM-05 | Phase 3 | Pending |
| RES-01 | Phase 2 | Complete |
| RES-02 | Phase 3 | Pending |
| RES-03 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 15 total
- Mapped to phases: 15
- Unmapped: 0

---
*Requirements defined: 2026-03-12*
*Last updated: 2026-03-15 after Phase 2 execution*
