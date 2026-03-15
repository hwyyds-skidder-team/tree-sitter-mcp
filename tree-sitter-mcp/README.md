# tree-sitter-mcp

Standalone MCP server for AI-agent-first semantic code search powered by Tree-sitter.

## Quickstart

```bash
cd tree-sitter-mcp
npm install
npm run build
npm start
```

For local development:

```bash
cd tree-sitter-mcp
npm install
npm run dev
```

The server runs over stdio and is intended to be launched by an MCP client. After `npm run build`, the package also exposes a `tree-sitter-mcp` CLI entry via the `bin` field.

## Tool surface

- `tree_sitter_get_server_info` - bootstrap and transport info
- `set_workspace` - resolve a workspace root and discover supported files
- `get_capabilities` - report supported languages, query types, and parser mode
- `get_health` - inspect active workspace state, exclusions, and skipped unsupported files
- `list_file_symbols` - extract file-level symbols from a supported source file on demand
- `search_workspace_symbols` - search discovered workspace symbols by name without a persistent index
- `search_definitions` - search workspace definitions with language/path/kind filters
- `resolve_definition` - resolve one discovered symbol or direct lookup request to a definition
- `search_references` - search references or call sites for a resolved symbol with context and pagination metadata

## MCP launch flow

Typical local workflow:

1. Launch the built server over stdio:

```bash
cd tree-sitter-mcp
node dist/index.js
```

Or, after installing/linking the package, use:

```bash
tree-sitter-mcp
```

2. From an MCP client:
   - call `set_workspace`
   - use `search_definitions` or `resolve_definition`
   - chain into `search_references` for usage lookup, snippets, and pagination

## Design guarantees

- Transport: stdio only in v1.
- Parser mode: on-demand Tree-sitter parsing.
- Read-only MCP tools only.
- No persistent semantic index is created at startup or during queries.
