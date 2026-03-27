# tree-sitter-mcp

## What This Is

`tree-sitter-mcp` is a standalone MCP server/CLI for AI coding agents that need semantic code search over local workspaces. After shipping v1.1, the product now supports persistent indexed retrieval, federated multi-workspace search, and relationship-aware impact inspection over a read-only, stdio-first MCP surface.

## Core Value

An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.

## Current State

- **Shipped milestones:** `v1.0 Semantic Search` archived/tagged on 2026-03-21; `v1.1 Search Depth and Scale` archived/tagged on 2026-03-22.
- **Product surface:** standalone MCP server with capability/health inspection, persistent index reuse, freshness-aware payloads, multi-workspace symbol/definition/reference search, deterministic federated ranking, workspace breakdown metadata, and read-only relationship views with one extra impact hop.
- **Codebase shape:** TypeScript package under `tree-sitter-mcp/` with regression coverage across bootstrap, indexing, workspace discovery, multi-root search, restart reuse, degraded refresh handling, and relationship retrieval.
- **Planning status:** no active milestone is defined; the next step is to create fresh requirements and roadmap scope for the next milestone.

## Current Milestone: v1.2 Advanced Analysis

**Goal:** Deepen the server from semantic search into higher-value analysis so an AI agent can understand dependency structure and likely change impact around a symbol.

**Target features:**
- Deeper dependency and relationship analysis beyond the current direct-links-plus-one-hop model.
- Impact analysis that summarizes likely blast radius for a symbol or change target.
- Path explanations that show why one symbol, file, or module influences another.
- Confidence and uncertainty metadata so agents can distinguish reliable links from weaker inferences.
- High-signal analysis summaries that remain easy for MCP clients to consume.

## Requirements

### Validated

- ✓ Expose read-only MCP search tools for symbol-aware code discovery in a local workspace — v1.0
- ✓ Use Tree-sitter parsing to power definitions, references, snippets, and stable source ranges for semantic search — v1.0
- ✓ Keep the first release optimized for AI-agent workflows with structured payloads, pagination, and low operational complexity — v1.0
- ✓ Reuse persistent semantic state so repeated searches stay fast without hiding freshness from the caller — v1.1
- ✓ Expand search across multiple workspaces while preserving clear workspace attribution and narrowing controls — v1.1
- ✓ Add relationship-aware retrieval so agents can inspect direct dependencies and likely impact around a symbol — v1.1

### Active

- [ ] Deepen symbol analysis from shallow relationship lookup into richer dependency traversal.
- [ ] Help agents estimate likely impact before making or proposing code changes.
- [ ] Surface structured explanations and confidence signals instead of raw relationship edges alone.

### Out of Scope

- Streamable HTTP transport is still deferred until it is selected as the explicit focus of a future milestone.
- Automated refactors or code mutation remain out of scope until read-only search workflows prove enough value to justify write operations.
- Full IDE UX or editor-bundled integrations remain secondary to the standalone server.
- Remote SaaS search or shared hosted indexing stays out of scope while the product validates local-first MCP workflows.

## Context

`tree-sitter-mcp` now ships as a dedicated Node 22+/TypeScript package built on `@modelcontextprotocol/sdk`, `tree-sitter`, builtin JavaScript/TypeScript/TSX/Python grammars, and `zod` schemas for tool contracts. The shipped product can bootstrap over stdio, discover and filter workspaces, reuse persisted semantic records safely, search across multiple roots with explicit attribution, and let an MCP client inspect direct semantic relationships around a symbol without mutating the workspace.

## Constraints

- **Architecture**: Keep the server standalone in `tree-sitter-mcp` so MCP clients can launch it without repo-root coupling.
- **Parsing Engine**: Tree-sitter remains the semantic source of truth; avoid falling back to grep-style heuristics as the primary workflow.
- **Primary User**: AI agents; tool naming, pagination, and payloads should continue to optimize for MCP client consumption.
- **Read/Write Boundary**: Maintain read-only semantic search until a future milestone explicitly validates safe write workflows.
- **Operational Model**: Preserve a low-setup local experience even if later milestones add caching or alternate transports.
- **Freshness**: Any cache or index layer must make staleness and refresh behavior explicit so agents do not trust outdated semantic answers.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Start with a standalone MCP server/package in `tree-sitter-mcp` | Matches the requested deliverable and keeps the integration reusable across MCP clients | ✓ Shipped in v1.0 |
| Prefer stdio-first local transport for v1 | Best fit for local AI-agent workflows and lowest initial deployment complexity | ✓ Shipped in v1.0 |
| Use on-demand parsing instead of a persistent index for the first release | Reduced setup complexity before real usage patterns were proven | ✓ Shipped in v1.0, expanded in v1.1 |
| Refocus v1.1 on search improvements before transport expansion | User priority stayed on stronger search rather than adding more connection options | ✓ Validated in v1.1 |
| Pair persistent indexing with multi-workspace search in v1.1 | Both features required shared workspace-state and freshness-tracking primitives | ✓ Validated in v1.1 |
| Start relationship views with direct semantic links instead of whole-program graphs | Reuse the definition/reference pipeline before attempting heavier analysis | ✓ Shipped in v1.1 |
| Prefer same-file and same-workspace relationship resolution before global fallback | Prevent duplicate names across roots from leaking into the wrong relationship view | ✓ Validated in v1.1 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check - still the right priority?
3. Audit Out of Scope - reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-27 after starting v1.2 milestone*
