# Phase 4: Persistent Indexing and Query Freshness - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Introduce persistent semantic state so repeated queries become faster without returning stale answers or hiding freshness details from the caller. This phase covers index/cache lifecycle, invalidation, and freshness diagnostics for the existing read-only search workflow. It does not add multi-workspace federation, relationship views, or HTTP transport.

</domain>

<decisions>
## Implementation Decisions

### Freshness policy
- Detect file/workspace changes before serving search results and refresh affected data first rather than knowingly returning stale results.
- Prefer incremental refresh when only a small set of files changes instead of rebuilding the entire workspace index.
- Include freshness metadata in structured search responses by default while keeping human-readable text concise.
- If refresh fails, return only the subset of results that is still confirmed fresh and attach diagnostics describing the degraded state.

### Build lifecycle
- Start building the persistent index during `set_workspace` rather than waiting for the first search request.
- The initial build should aim to cover the full configured workspace before search tools return results.
- If the workspace root or exclusion set changes, treat that as a rebuild boundary and regenerate the index for the new configuration.
- Search requests should wait for index readiness instead of falling back to the old on-demand parse path during initial bootstrap.

### Persistence scope
- Persist the index/cache to local disk so it survives server restarts.
- Store persistent state per workspace rather than in one shared global pool.
- When index schema or version expectations change, invalidate old data and rebuild instead of attempting migration.
- Keep disk retention pragmatic: preserve reusable indexes when safe, but optimize for reliable rebuilds rather than permanent cache retention.

### Status and degraded behavior
- Expose index/cache status inside search-result structured metadata, not only through `get_health` and `get_capabilities`.
- Keep default text responses terse even when a refresh or rebuild happened, unless the operation was slow or degraded enough that the user needs to notice it.
- Treat partial/degraded freshness situations as warnings when trustworthy partial results still exist.
- Freshness states should distinguish at least `fresh`, `refreshed`, `rebuilding`, and `degraded`.

### Claude's Discretion
- Exact on-disk index format, file naming, and storage directory layout.
- The mechanism used to detect changed files/workspaces and decide whether a refresh can stay incremental.
- The exact structured metadata shape for freshness details, as long as it stays machine-readable and consistent across search tools.
- Thresholds for when a refresh remains incremental versus forcing a full rebuild.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone and phase planning
- `.planning/PROJECT.md` — Milestone goal, product constraints, and the decision to prioritize search improvements over transport expansion.
- `.planning/REQUIREMENTS.md` — Phase 4 requirements `PERF-01` through `PERF-03` plus the out-of-scope boundary for v1.1.
- `.planning/ROADMAP.md` — Phase 4 goal, success criteria, and current plan breakdown (`04-01` through `04-03`).
- `.planning/STATE.md` — Current milestone position and the handoff point after context capture.

### Additional specs
- No external ADR/spec files currently exist for this phase; requirements are fully captured in the planning docs above and the decisions in this context file.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `tree-sitter-mcp/src/workspace/workspaceState.ts`: current shared workspace snapshot and summary schema; best extension point for index/cache summary data.
- `tree-sitter-mcp/src/tools/setWorkspaceTool.ts`: existing workspace bootstrap flow; natural trigger for initial index build and rebuild on root/exclusion changes.
- `tree-sitter-mcp/src/tools/getHealthTool.ts`: existing diagnostic/status surface for exposing freshness, degraded state, and cache/index coverage.
- `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts`: current capability payload can advertise parser/index mode and available freshness signals.
- `tree-sitter-mcp/src/parsing/parseWithDiagnostics.ts`: current parse path and diagnostics that refresh/index rebuild logic can reuse when files fail to parse.

### Established Patterns
- Shared mutable server state lives on `ServerContext`; new persistent-index coordination should fit that model rather than creating disconnected singletons.
- Search tools are thin MCP adapters over backend modules (`searchDefinitions`, `resolveDefinition`, `searchReferences`), so freshness-aware indexing should plug into shared backend paths.
- Diagnostics are always structured via `createDiagnostic`, which should remain the source of truth for degraded/refresh failure reporting.
- The shipped architecture is explicitly read-only and local-first; any index layer must preserve that contract.

### Integration Points
- `tree-sitter-mcp/src/server/serverContext.ts`: add or initialize index/cache coordination alongside workspace state.
- `tree-sitter-mcp/src/tools/setWorkspaceTool.ts`: kick off initial build and rebuilds when workspace configuration changes.
- `tree-sitter-mcp/src/definitions/searchDefinitions.ts` and `tree-sitter-mcp/src/definitions/resolveDefinition.ts`: route definition flows through freshness-aware indexed data.
- `tree-sitter-mcp/src/references/searchReferences.ts` and related pipelines: gate reference results on fresh indexed state and expose degraded diagnostics consistently.
- `tree-sitter-mcp/src/tools/getHealthTool.ts` and `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts`: surface status/freshness metadata and coverage summaries.

</code_context>

<specifics>
## Specific Ideas

- Prioritize trust and consistency over first-query speed: initial searches may wait if that avoids serving stale data.
- Repeated searches should feel substantially faster once the workspace has been indexed.
- Freshness details should be easy for agent callers to read programmatically without cluttering the default text UX.
- If the system cannot fully refresh, it should prefer trustworthy partial results plus warnings over silently serving outdated answers.

</specifics>

<deferred>
## Deferred Ideas

- Multi-workspace search/federation details belong to Phase 5.
- Relationship views and impact analysis belong to Phase 6.
- Streamable HTTP transport remains a future milestone item, not Phase 4 scope.

</deferred>

---

*Phase: 04-persistent-indexing-and-query-freshness*
*Context gathered: 2026-03-21*
