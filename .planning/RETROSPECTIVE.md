# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.1 — Search Depth and Scale

**Shipped:** 2026-03-22
**Phases:** 3 | **Plans:** 9 | **Sessions:** 1

### What Was Built
- Persistent semantic indexing with workspace fingerprinting, targeted refresh, degraded-file handling, and explicit freshness metadata.
- Federated multi-workspace search with workspace attribution, narrowing controls, deterministic ranking, and per-workspace breakdown payloads.
- Read-only relationship retrieval with direct incoming/outgoing semantic links, one extra impact hop, and realistic single-root plus federated E2E coverage.

### What Worked
- Sequencing the milestone as speed → scale → depth created a clean dependency chain and kept each phase legible.
- Reusing shared definition/reference/index backends prevented the new relationship workflows from forking contract logic.
- Regression coverage caught real multi-workspace edge cases, especially duplicate-name relationship disambiguation and freshness propagation.

### What Was Inefficient
- No formal milestone audit artifact was produced before archival, so completion still required human judgment even with 100% plan and requirement completion.
- Summary frontmatter still does not include machine-readable one-liners, which forced milestone accomplishments to be curated manually.
- Several git/test operations still needed sandbox escalation during execution, creating avoidable workflow friction.

### Patterns Established
- Treat freshness metadata as a first-class contract across every indexed search workflow.
- Carry `workspaceRoot` through every result and follow-up navigation surface before federating search across repositories.
- Validate new search primitives through both in-process backend tests and compiled stdio E2E fixtures before calling a milestone done.

### Key Lessons
1. Search quality improvements compound well when each phase extends shared backend contracts instead of inventing new parallel pipelines.
2. Federated search and relationship retrieval need explicit same-workspace disambiguation rules as soon as duplicate names enter the fixture set.
3. Milestone archival remains partially manual until summary metadata conventions are tightened.

### Cost Observations
- Model mix: Not tracked precisely in repository artifacts (project config remained on the balanced profile).
- Sessions: 1 concentrated milestone completion session after the v1.1 implementation/verification push.
- Notable: The milestone shipped quickly once Phase 4 primitives existed, because Phase 5 and 6 reused the same index, workspace, and diagnostics backbone.

---

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
| v1.1 | 1 | 3 | Added persistent-index, federated-search, and relationship-validation workflows on top of the same shared backend contracts |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | 15 suites | Not tracked | 0 |
| v1.1 | 54 passing tests at archival | Not tracked | 0 |

### Top Lessons (Verified Across Milestones)

1. Local-first, read-only tool surfaces are a good proving ground before broader transports or write capabilities.
2. Shared backend services plus thin MCP adapters scale well across search workflows.
3. Archive automation still needs better summary metadata and audit discipline to stay truly low-friction.
