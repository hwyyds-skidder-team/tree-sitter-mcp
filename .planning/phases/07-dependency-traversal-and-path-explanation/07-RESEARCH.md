# Phase 07 Research: Dependency Traversal and Path Explanation

**Generated:** 2026-03-27
**Status:** Ready for planning
**Inputs:** `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, Phase 04-06 summaries, current relationship/index source files

## Scope

Phase 7 should deepen the shipped Phase 6 relationship surface into bounded multi-hop dependency analysis while keeping the server read-only, workspace-aware, and freshness-explicit.

## Current Baseline

- Phase 4 already guarantees freshness-checked indexed records through `getFreshRecords()`.
- Phase 5 already guarantees stable `workspaceRoot` attribution and federated narrowing.
- Phase 6 already exposes direct incoming/outgoing relationships through `get_relationship_view`, but intentionally caps traversal at `maxDepth` `1..2` and returns raw relationship edges rather than a per-result explanation path.

## Options Considered

### Option A — Extend `get_relationship_view`

**Pros**
- Reuses an existing tool name.
- Minimal MCP-surface growth.

**Cons**
- Changes the semantics of a shipped Phase 6 contract that is explicitly neighborhood-scoped.
- Makes path-explanation output harder to add without breaking existing edge-oriented callers.
- Forces Phase 6 tests/tool descriptions to change even though the new capability is a milestone-level expansion.

### Option B — Add additive `dependency_analysis` / `get_dependency_analysis` surface **(recommended)**

**Pros**
- Preserves the shipped Phase 6 relationship workflow unchanged.
- Gives Phase 7 room to return per-symbol dependency results with canonical explanation paths.
- Matches the project pattern of additive query catalogs and thin MCP adapters over shared backend helpers.

**Cons**
- Adds one more MCP tool/query type to advertise and test.

## Recommended Architecture

1. **Keep `get_relationship_view` stable.** Do not widen its public contract beyond the Phase 6 direct-links-plus-one-extra-hop behavior.
2. **Create a dedicated dependency contract** under `src/dependencies/` with:
   - a request schema seeded by `symbol` or `lookup`
   - `workspaceRoots`, `language`, `relationshipKinds`, `maxDepth`, `limit`, and `offset` filters
   - per-result explanation paths composed of attributed path steps
3. **Extract shared one-hop edge collection** from `getRelationshipView.ts` into a reusable relationship traversal helper so Phase 6 and Phase 7 use identical direct-edge semantics.
4. **Build Phase 7 results as unique reachable symbols, not raw edges.** Each returned symbol should carry one canonical shortest explanation path from the seed.
5. **Keep traversal bounded.** Recommended contract: `maxDepth` range `1..4`, default `2`.
6. **Carry attribution through every step.** Each explanation step should include `fromSymbol`, `toSymbol`, `relationshipKind`, and `evidence`, all with stable `workspaceRoot`/`relativePath` metadata.

## Key Risks and Mitigations

| Risk | Why it matters | Mitigation |
|------|----------------|------------|
| Cycle explosion | Multi-hop traversal can revisit the same symbols forever | Use BFS with visited/result keys scoped by direction + stable symbol identity |
| Duplicate-name cross-root bleed | Phase 5/6 already showed duplicate names across roots are common | Reuse same-file → same-workspace → global resolution order and assert `workspaceRoot` on every step |
| Drift between relationship and dependency semantics | Two traversal surfaces could classify edges differently | Extract and share one-hop edge collection helpers rather than reimplementing them |
| Stale or hidden refresh behavior | Deep traversal can chain many lookups | Reuse one fresh-index snapshot/state per request and propagate freshness/diagnostics into the final payload |

## Validation Focus

- Backend tests must prove bounded multi-hop BFS, shortest-path explanation selection, cycle handling, and `relationshipKinds` / `workspaceRoots` filtering.
- Stdio E2E tests must prove read-only behavior, tool discovery, and explanation-path payloads.
- Federated E2E tests must prove no cross-root attribution bleed when roots share names and relative paths.
- Freshness tests must prove edited/degraded files refresh or degrade dependency analysis instead of leaking stale paths.

## Planning Implications

- Phase 7 should stay split into three sequential plans:
  1. contract + filter foundations
  2. shared traversal refactor + backend implementation
  3. MCP wiring + E2E/freshness validation
- No new external dependencies are required.
- Discovery level is satisfied from existing codebase patterns and shipped summaries; no separate external-library research is needed.
