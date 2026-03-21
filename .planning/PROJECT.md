# tree-sitter-mcp

## What This Is

`tree-sitter-mcp` is a standalone MCP server/CLI for AI coding agents that need semantic code search over local workspaces. After shipping v1.0 read-only semantic search over stdio, the project is now expanding toward reusable query performance, alternate transport access, and broader retrieval across multiple workspaces.

## Core Value

An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.

## Current State

- **Shipped milestone:** `v1.0 Semantic Search` archived and tagged on 2026-03-21 after implementation completed on 2026-03-15.
- **Planning status:** `v1.1 Scale, Transport, and Workspace Reach` defined on 2026-03-21 and ready for Phase 04 planning.
- **Product surface:** standalone MCP server with local stdio transport, workspace discovery, exclusion controls, capability/health inspection, symbol listing, definition search/resolution, and reference search.
- **Codebase shape:** ~5,428 lines of TypeScript across `tree-sitter-mcp/src/` and `tree-sitter-mcp/test/`, with 15 test suites and a packaged `tree-sitter-mcp` CLI entrypoint.
- **Execution history:** 3 phases, 9 recorded plans, and 27 recorded plan tasks completed for the first shipped milestone.

## Current Milestone: v1.1 Scale, Transport, and Workspace Reach

**Goal:** Make repeated semantic search faster, expose the same read-only server over Streamable HTTP, and expand retrieval across multiple workspaces and symbol relationships without giving up the local-first experience.

**Target features:**
- Persistent cache/index reuse with freshness diagnostics for repeated semantic queries.
- Streamable HTTP transport with parity to the existing stdio tool surface.
- Multi-workspace search and relationship views that stay structured, filterable, and read-only.

## Requirements

### Validated

- ✓ Expose read-only MCP search tools for symbol-aware code discovery in a local workspace — v1.0
- ✓ Use Tree-sitter parsing to power definitions, references, snippets, and stable source ranges for semantic search — v1.0
- ✓ Keep the first release optimized for AI-agent workflows with structured payloads, pagination, and low operational complexity — v1.0

### Active

- [ ] Reuse cached semantic data across repeated queries while surfacing freshness and cache health clearly.
- [ ] Expose Streamable HTTP transport with safe local defaults and contract parity with stdio.
- [ ] Add multi-workspace and relationship-aware retrieval on top of the existing semantic search pipeline.

### Out of Scope

- Automated refactors or code mutation remain out of scope until read-only search workflows prove enough value to justify write operations.
- Full IDE UX or editor-bundled integrations remain secondary to the standalone server.
- Remote SaaS search or shared hosted indexing stays out of scope while the product validates local-first MCP workflows.

## Context

`tree-sitter-mcp` now ships as a dedicated Node 22+/TypeScript package built on `@modelcontextprotocol/sdk`, `tree-sitter`, builtin JavaScript/TypeScript/TSX/Python grammars, and `zod` schemas for tool contracts. The shipped v1 architecture is intentionally local-first and index-free: a client sets a workspace root, the server discovers supported files with deterministic exclusions, and semantic tools parse only the files needed for the current request.

No formal external user-feedback log exists yet, but the shipped milestone validated the core workflow the project set out to prove: an MCP client can bootstrap the server, inspect its capabilities, search for definitions or references, and chain structured results into later agent steps without mutating the workspace. The next milestone is about strengthening the same workflow rather than changing product direction: repeated-query performance on larger repositories, transport flexibility for clients that prefer HTTP, and broader retrieval across multiple workspace roots while preserving explicit diagnostics and low setup cost.

## Constraints

- **Architecture**: Keep the server standalone in `tree-sitter-mcp` so MCP clients can launch it without repo-root coupling.
- **Parsing Engine**: Tree-sitter remains the semantic source of truth; avoid falling back to grep-style heuristics as the primary workflow.
- **Primary User**: AI agents; tool naming, pagination, and payloads should continue to optimize for MCP client consumption.
- **Read/Write Boundary**: Maintain read-only semantic search until future milestones explicitly validate safe write workflows.
- **Operational Model**: Preserve a low-setup local experience even if later milestones add caching or alternate transports.
- **Transport**: Streamable HTTP must be additive to the shipped stdio workflow, not a replacement for it.
- **Freshness**: Any cache or index layer must make staleness and refresh behavior explicit so agents do not trust outdated semantic answers.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Start with a standalone MCP server/package in `tree-sitter-mcp` | Matches the requested deliverable and keeps the integration reusable across MCP clients | ✓ Shipped in v1.0 |
| Prefer stdio-first local transport for v1 | Best fit for local AI-agent workflows and lowest initial deployment complexity | ✓ Shipped in v1.0 |
| Use on-demand parsing instead of a persistent index | Reduces setup and state-management complexity for the first release | ⚠ Revisit when repeated-query performance becomes a bottleneck |
| Enforce deterministic workspace exclusions before semantic queries | Keeps dependency, vendored, and generated paths out of user-facing results | ✓ Shipped in v1.0 |
| Expose capabilities and health as explicit MCP tools | Makes the server debuggable before deeper semantic workflows exist | ✓ Shipped in v1.0 |
| Return structured diagnostics for unsupported files and parse failures | Prevents silent skips and keeps agent workflows actionable | ✓ Shipped in v1.0 |
| Keep definition search layered on the Phase 1 parser and workspace snapshot | Preserves the no-index, local-only architecture while adding richer retrieval | ✓ Shipped in v1.0 |
| Normalize definition payloads through a dedicated schema and shared filter layer | Keeps tool-facing metadata and narrowing semantics consistent across languages | ✓ Shipped in v1.0 |
| Expose `search_definitions` and `resolve_definition` as read-only tools | Completes the user-facing definition workflow without introducing writes or indexing | ✓ Shipped in v1.0 |
| Keep `search_references` as a thin MCP adapter over the shared backend | Preserves one source of truth for diagnostics, context shaping, and pagination | ✓ Shipped in v1.0 |
| Package startup through a `bin` entry while keeping docs stdio-first | Makes local launch easier without implying unsupported transports | ✓ Shipped in v1.0 |
| Pair persistent cache reuse with multi-workspace support in v1.1 | Both features need shared workspace-state and freshness-tracking primitives | — Pending |
| Keep Streamable HTTP additive rather than replacing stdio | Broader transport reach should not regress the proven local agent workflow | — Pending |
| Start relationship views with direct semantic links, not whole-program graphs | Reuse the existing definition/reference pipeline before attempting heavier analysis | — Pending |

---
*Last updated: 2026-03-21 after defining the v1.1 milestone*
