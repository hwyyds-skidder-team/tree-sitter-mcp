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

The server runs over stdio and is intended to be launched by an MCP client.

## Phase 1 tool surface

- `tree_sitter_get_server_info` - bootstrap and transport info
- `set_workspace` - resolve a workspace root and discover supported files
- `get_capabilities` - report supported languages, query types, and parser mode
- `get_health` - inspect active workspace state, exclusions, and skipped unsupported files
- `list_file_symbols` - extract file-level symbols from a supported source file on demand
- `search_workspace_symbols` - search discovered workspace symbols by name without a persistent index

## Notes

- Transport: stdio only in v1.
- Parser mode: on-demand Tree-sitter parsing.
- No persistent semantic index is created at startup or during queries.
