# Roadmap: tree-sitter-mcp

## Milestones

- ✅ **v1.0 Semantic Search** — Phases 1-3 (implementation completed 2026-03-15; archived/tagged 2026-03-21) — [archive](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Search Depth and Scale** — Phases 4-6 (implementation completed 2026-03-21; archived/tagged 2026-03-22) — [archive](milestones/v1.1-ROADMAP.md)

## Current Status

`tree-sitter-mcp` now ships a read-only semantic search surface with persistent indexed freshness, federated multi-workspace retrieval, and relationship-aware impact inspection. v1.1 is archived, and the project is ready to define the next milestone rather than continue Phase 6 work.

## Next Milestone

No next milestone is defined yet.

Run `$gsd-new-milestone` to capture fresh requirements, decide the next product focus, and create the next roadmap slice.

## Candidate Directions

- Streamable HTTP transport that preserves the existing read-only MCP tool contracts.
- Deeper relationship and impact analysis beyond the current direct-links-plus-one-hop model.
- Safe semantic write/refactor workflows after the read-only retrieval surface proves stable enough.
- Broader language support and scale improvements for larger repositories.

---
*For shipped milestone details, see `.planning/milestones/v1.0-ROADMAP.md` and `.planning/milestones/v1.1-ROADMAP.md`.*
