# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Semantic Search

**Shipped:** 2026-03-21
**Phases:** 3 | **Plans:** 9 | **Sessions:** 4

### What Was Built
- A standalone TypeScript MCP server/CLI with stdio bootstrap and workspace targeting.
- Read-only semantic definition and reference search workflows backed by on-demand Tree-sitter parsing.
- Agent-ready results with structured diagnostics, enclosing context, snippets, and deterministic pagination.

### What Worked
- Breaking the milestone into three tightly scoped phases kept execution predictable and composable.
- Reusing shared backend services behind thin MCP tool adapters prevented logic drift across the tool surface.
- Structured diagnostics and deterministic exclusions made it easier to validate agent-facing workflows end to end.

### What Was Inefficient
- No formal milestone audit artifact was produced before archival, so readiness had to be inferred from summaries and requirements traceability.
- Summary frontmatter did not include `one-liner` values, which meant automation underreported milestone accomplishments.

### Patterns Established
- Keep workspace discovery, parsing, normalization, and MCP adapter layers separate.
- Use explicit pagination metadata and structured diagnostic payloads as default contracts for agent-facing tools.
- Treat standalone packaging and end-to-end stdio coverage as first-class release criteria.

### Key Lessons
1. On-demand semantic search is a strong v1 strategy when workspace boundaries and diagnostics are explicit from the start.
2. Archive automation is only as good as the summary metadata it consumes; summary conventions should be tightened before the next milestone.

### Cost Observations
- Model mix: Not tracked in repository artifacts (project config used the balanced profile).
- Sessions: 4 milestone work sessions captured in git/planning history.
- Notable: Shipping in 3 focused phases kept planning overhead low while still enabling end-to-end verification.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | 4 | 3 | Established the standalone MCP + on-demand parsing workflow and summary-driven phase execution pattern |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | 15 suites | Not tracked | 0 |

### Top Lessons (Verified Across Milestones)

1. Local-first, read-only tool surfaces are a good proving ground before broader transports or write capabilities.
2. Shared backend services plus thin MCP adapters scale well across search workflows.
