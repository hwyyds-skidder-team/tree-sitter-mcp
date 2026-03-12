# Roadmap: tree-sitter-mcp

## Overview

Build `tree-sitter-mcp` as a standalone, AI-agent-first MCP server that starts with local stdio transport, on-demand Tree-sitter parsing, and a minimal but genuinely useful semantic-search workflow. The roadmap moves from bootable server foundations and workspace awareness, to definition-centric retrieval, and finally to reference/context search with agent-ready response shaping.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Server Foundation and Workspace Discovery** - Boot the standalone MCP server and make it understand a local workspace.
- [ ] **Phase 2: Definition Search Core** - Deliver precise definition lookup and filtered symbol discovery on top of Tree-sitter parsing.
- [ ] **Phase 3: Reference Search and Agent-Ready Results** - Complete the semantic retrieval loop with references, context, and paginated structured output.

## Phase Details

### Phase 1: Server Foundation and Workspace Discovery
**Goal**: Deliver a runnable `tree-sitter-mcp` package with stdio-based MCP connectivity, workspace targeting, grammar awareness, exclusion handling, and actionable diagnostics.
**Depends on**: Nothing (first phase)
**Requirements**: MCP-01, MCP-02, WORK-01, WORK-02, WORK-03, WORK-04, RES-03
**Success Criteria** (what must be TRUE):
  1. User can launch `tree-sitter-mcp` from its dedicated directory and connect to it from an MCP client over local transport.
  2. User can inspect server capabilities/health and see supported languages, available query types, and active workspace constraints.
  3. User can point the server at a workspace and have unsupported files or parse failures return actionable diagnostics instead of silent skips.
  4. User can exclude generated, dependency, or vendored paths so semantic search only considers intended source files.
**Plans**: 3 plans

Plans:
- [ ] 01-01: Scaffold the TypeScript MCP server package, runtime configuration, and SDK adapter boundary in `tree-sitter-mcp`.
- [ ] 01-02: Implement workspace discovery, ignore/exclusion rules, and grammar/language registration.
- [ ] 01-03: Add capability/health tooling plus parse and unsupported-language diagnostics.

### Phase 2: Definition Search Core
**Goal**: Turn Tree-sitter parses into reliable definition-oriented semantic search tools with precise locations and useful filters.
**Depends on**: Phase 1
**Requirements**: SEM-01, SEM-03, SEM-04, RES-01
**Success Criteria** (what must be TRUE):
  1. User can search symbol definitions by name across the workspace and receive symbol kind, file path, and exact source range.
  2. User can resolve the definition target for a discovered symbol or lookup request.
  3. User can narrow semantic searches by path, language, and symbol kind to reduce noise.
  4. Every result includes stable line/column boundaries so another tool can jump directly to the location.
**Plans**: 3 plans

Plans:
- [ ] 02-01: Build the on-demand parse and query pipeline for definition extraction.
- [ ] 02-02: Normalize symbol metadata, source ranges, and filter handling across languages.
- [ ] 02-03: Expose definition-search MCP tools with read-only semantics and structured payloads.

### Phase 3: Reference Search and Agent-Ready Results
**Goal**: Complete the v1 semantic-search experience with reference lookup, surrounding syntax context, pagination, and MCP responses tuned for AI agents.
**Depends on**: Phase 2
**Requirements**: MCP-03, SEM-02, SEM-05, RES-02
**Success Criteria** (what must be TRUE):
  1. User can find references or call sites for a symbol within the workspace.
  2. User can request enclosing scope plus short code snippets for each semantic match.
  3. User can page through large result sets and know whether more results remain.
  4. MCP tool responses include concise text plus structured content that AI agents can chain into later steps.
**Plans**: 3 plans

Plans:
- [ ] 03-01: Implement reference and call-site retrieval on top of the definition pipeline.
- [ ] 03-02: Add context extraction, snippet shaping, and pagination metadata.
- [ ] 03-03: Validate end-to-end agent workflows and package the server for standalone use.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Server Foundation and Workspace Discovery | 0/3 | Not started | - |
| 2. Definition Search Core | 0/3 | Not started | - |
| 3. Reference Search and Agent-Ready Results | 0/3 | Not started | - |
