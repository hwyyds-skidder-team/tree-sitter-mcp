# Milestones

## v1.0 Semantic Search (Shipped: 2026-03-21)

**Phases completed:** 3 phases, 9 plans, 27 tasks

**Timeline:** 2026-03-12 → 2026-03-15 implementation, archived/tagged 2026-03-21

**Key accomplishments:**
- Shipped `tree-sitter-mcp` as a standalone TypeScript MCP server/CLI with stdio bootstrap and smoke-tested local launch.
- Added deterministic workspace targeting, exclusion handling, builtin grammar registration, and explicit capability/health inspection.
- Delivered read-only semantic symbol discovery plus normalized definition search and direct definition resolution.
- Implemented definition-anchored reference search with enclosing context, short snippets, and deterministic pagination metadata.
- Exposed `search_definitions`, `resolve_definition`, and `search_references` as structured MCP tools tuned for AI-agent workflows.
- Finished end-to-end stdio coverage across bootstrap, workspace, definition, and reference workflows while keeping the workspace read-only.

**Known gaps:**
- No standalone `v1.0-MILESTONE-AUDIT.md` file was present at archival time; requirements traceability was nevertheless 15/15 complete.

---
