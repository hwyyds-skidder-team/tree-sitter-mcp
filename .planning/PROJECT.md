# tree-sitter-mcp

## What This Is

`tree-sitter-mcp` is a standalone MCP server/CLI for AI coding agents that need semantic code search over local workspaces. After shipping v1.0 read-only semantic search over stdio, the current milestone is focused on making search itself faster, broader, and more insightful before any HTTP expansion.

## Core Value

An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.

## Current State

- **Shipped milestone:** `v1.0 Semantic Search` archived and tagged on 2026-03-21 after implementation completed on 2026-03-15.
- **Planning status:** `v1.1 Search Depth and Scale` is in active execution; Phase 05 multi-workspace search completed on 2026-03-21 while Phase 04 freshness diagnostics still has remaining work.
- **Product surface:** standalone MCP server with local stdio transport, persistent index reuse, capability/health inspection, workspace discovery, multi-workspace symbol/definition/reference search, workspace-aware narrowing, deterministic federated ranking, and machine-readable per-workspace result breakdowns.
- **Codebase shape:** TypeScript package under `tree-sitter-mcp/` with dedicated regression coverage for stdio tools, indexing, workspace discovery, and federated multi-workspace search behavior.
- **Execution history:** v1.0 shipped end-to-end, Phase 04 began the persistent-index milestone work, and Phase 05 is now fully implemented and verified ahead of relationship-view planning.

## Current Milestone: v1.1 Search Depth and Scale

**Goal:** Improve semantic search itself by making repeated queries faster, expanding search across multiple workspaces, and adding relationship-aware retrieval that helps agents understand impact instead of only finding locations.

**Target features:**
- Persistent index/cache reuse with explicit freshness diagnostics for repeated semantic queries.
- Multi-workspace search with workspace-aware narrowing and result attribution.
- Relationship and impact-oriented retrieval built on top of the existing definition/reference pipeline.

## Requirements

### Validated

- ✓ Expose read-only MCP search tools for symbol-aware code discovery in a local workspace — v1.0
- ✓ Use Tree-sitter parsing to power definitions, references, snippets, and stable source ranges for semantic search — v1.0
- ✓ Keep the first release optimized for AI-agent workflows with structured payloads, pagination, and low operational complexity — v1.0
- ✓ Expand search across multiple workspaces while preserving clear workspace attribution and narrowing controls — Validated in Phase 05 on 2026-03-21

### Active

- [ ] Reuse persistent semantic state so repeated searches stay fast without hiding freshness from the caller.
- [ ] Add relationship-aware retrieval so agents can inspect direct dependencies and likely impact around a symbol.

### Out of Scope

- Streamable HTTP transport is deferred until search improvements land; transport breadth is not the focus of this milestone.
- Automated refactors or code mutation remain out of scope until read-only search workflows prove enough value to justify write operations.
- Full IDE UX or editor-bundled integrations remain secondary to the standalone server.
- Remote SaaS search or shared hosted indexing stays out of scope while the product validates local-first MCP workflows.

## Context

`tree-sitter-mcp` now ships as a dedicated Node 22+/TypeScript package built on `@modelcontextprotocol/sdk`, `tree-sitter`, builtin JavaScript/TypeScript/TSX/Python grammars, and `zod` schemas for tool contracts. The v1 foundation already proved that an MCP client can bootstrap the server, inspect its capabilities, search for definitions or references, and chain structured results into later agent steps without mutating the workspace.

The active milestone stays intentionally search-centric: persistent semantic state improves repeat-query performance, Phase 05 now proves federated search across multiple roots with stable ranking and explainable payloads, and the remaining milestone work can build relationship-aware retrieval on top of that stronger base.

## Constraints

- **Architecture**: Keep the server standalone in `tree-sitter-mcp` so MCP clients can launch it without repo-root coupling.
- **Parsing Engine**: Tree-sitter remains the semantic source of truth; avoid falling back to grep-style heuristics as the primary workflow.
- **Primary User**: AI agents; tool naming, pagination, and payloads should continue to optimize for MCP client consumption.
- **Read/Write Boundary**: Maintain read-only semantic search until future milestones explicitly validate safe write workflows.
- **Operational Model**: Preserve a low-setup local experience even if later milestones add caching or alternate transports.
- **Freshness**: Any cache or index layer must make staleness and refresh behavior explicit so agents do not trust outdated semantic answers.
- **Scope**: Search quality and retrieval depth take priority over transport expansion in v1.1.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Start with a standalone MCP server/package in `tree-sitter-mcp` | Matches the requested deliverable and keeps the integration reusable across MCP clients | ✓ Shipped in v1.0 |
| Prefer stdio-first local transport for v1 | Best fit for local AI-agent workflows and lowest initial deployment complexity | ✓ Shipped in v1.0 |
| Use on-demand parsing instead of a persistent index | Reduced setup complexity for the first release | ✓ Shipped in v1.0, later expanded with persistent indexing in v1.1 |
| Enforce deterministic workspace exclusions before semantic queries | Keeps dependency, vendored, and generated paths out of user-facing results | ✓ Shipped in v1.0 |
| Expose capabilities and health as explicit MCP tools | Makes the server debuggable before deeper semantic workflows exist | ✓ Shipped in v1.0 |
| Return structured diagnostics for unsupported files and parse failures | Prevents silent skips and keeps agent workflows actionable | ✓ Shipped in v1.0 |
| Keep definition/reference workflows layered on shared backend normalization | Preserves one source of truth for ranking, diagnostics, and narrowing semantics | ✓ Validated across v1.0 and v1.1 |
| Refocus v1.1 on search improvements before transport expansion | User priority is stronger search, not more connection options | ✓ Confirmed by completing Phase 05 before any HTTP work |
| Pair persistent indexing with multi-workspace search in v1.1 | Both features need shared workspace-state and freshness-tracking primitives | ⚠ Phase 05 complete; remaining Phase 04 freshness diagnostics still need completion |
| Start relationship views with direct semantic links instead of whole-program graphs | Reuse the existing definition/reference pipeline before attempting heavier analysis | — Pending Phase 06 |

---
*Last updated: 2026-03-21 after completing Phase 05 multi-workspace search quality verification*
