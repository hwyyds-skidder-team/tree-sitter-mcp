# tree-sitter-mcp

## What This Is

`tree-sitter-mcp` is a standalone MCP plugin/server that gives AI coding agents semantic code search over a local workspace using Tree-sitter parsing instead of plain text matching. It is aimed first at MCP clients such as Codex/Claude-style agents that need reliable symbol-, reference-, and structure-aware code discovery inside repositories.

## Core Value

An AI agent can quickly find the right code symbols, definitions, references, and related source regions in a workspace without relying on brittle grep-style text search.

## Requirements

### Validated

(None yet - ship to validate)

### Active

- [ ] Expose MCP search tools for symbol-aware code discovery in a local workspace.
- [ ] Use Tree-sitter parsing to power semantic search over definitions, references, and structural code regions.
- [ ] Keep v1 optimized for AI-agent usage with read-oriented tools and low operational complexity.

### Out of Scope

- Persistent distributed indexing service - v1 favors on-demand parsing to reduce state management and setup burden.
- Automated refactors or code mutation - the initial milestone focuses on search and discovery, not edits.
- Full IDE UX or editor plugin bundle - the first deliverable is a standalone MCP server/plugin in `tree-sitter-mcp`.

## Context

The project is greenfield and will live in a dedicated `tree-sitter-mcp` directory inside this repository. The intended use case is semantic code retrieval for MCP-compatible AI agents working against source trees where text search is too noisy or misses code structure. The user explicitly wants Tree-sitter as the parsing engine, a separate plugin/server package, and a v1 that emphasizes symbol/reference lookup with on-demand analysis instead of a persistent index.

This project sits at the intersection of MCP server design and code intelligence. Early planning needs to cover workspace traversal, parser/language loading, normalized symbol/location results, search ergonomics for agents, and the minimum set of read-only tools that make the server genuinely useful in multi-step coding workflows.

## Constraints

- **Architecture**: Build as a standalone MCP plugin/server in `tree-sitter-mcp` - the deliverable should be separable from other repo contents.
- **Parsing Engine**: Tree-sitter - semantic search must be driven by syntax trees rather than regex/grep heuristics.
- **Primary User**: AI agents - tool naming, outputs, and pagination should optimize for MCP client consumption.
- **Search Mode**: On-demand parsing for v1 - avoid persistent index complexity unless later evidence demands it.
- **Scope**: Read-focused semantic search first - do not let refactoring or write workflows dilute the initial milestone.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Start with an MCP server/plugin rather than an editor-specific integration | The user asked for a standalone MCP deliverable and AI-agent-first workflow | Pending |
| Use Tree-sitter as the semantic engine | It provides structural parsing needed for symbol/reference-aware search | Pending |
| Prioritize symbol/reference tools over broader code intelligence features | This is the clearest v1 value and matches the user's stated focus | Pending |
| Default to on-demand analysis instead of persistent indexing | Lower implementation and ops complexity for an initial release | Pending |

---
*Last updated: 2026-03-12 after initialization*
