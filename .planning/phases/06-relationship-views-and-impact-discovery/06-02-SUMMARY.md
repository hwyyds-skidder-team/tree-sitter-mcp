---
phase: 06-relationship-views-and-impact-discovery
plan: 02
subsystem: search
tags: [tree-sitter, mcp, relationships, indexing, testing]
requires:
  - phase: 06-01
    provides: locked relationship schemas, filter normalization, and relationship_view query registration
  - phase: 05-03
    provides: workspace-aware result shaping, freshness messaging, and federated search metadata patterns
provides:
  - indexed relationship traversal for direct incoming and outgoing semantic links
  - read-only get_relationship_view MCP tool with workspace breakdown, freshness, and pagination metadata
  - capabilities, health, and bootstrap-visible relationship discovery surfaces plus focused pipeline coverage
affects: [06-03, relationship traversal, tool registry, capabilities, health, bootstrap]
tech-stack:
  added: []
  patterns: [breadth-first relationship expansion over indexed evidence, owner-resolution from enclosing context, workspace-aware MCP payload shaping]
key-files:
  created:
    - tree-sitter-mcp/src/relationships/getRelationshipView.ts
    - tree-sitter-mcp/src/tools/getRelationshipViewTool.ts
    - tree-sitter-mcp/test/relationshipPipeline.test.ts
  modified:
    - tree-sitter-mcp/src/server/toolRegistry.ts
    - tree-sitter-mcp/src/tools/getCapabilitiesTool.ts
    - tree-sitter-mcp/src/tools/getHealthTool.ts
    - tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
    - tree-sitter-mcp/test/serverBootstrap.test.ts
key-decisions:
  - "Incoming relationship edges reuse searchReferences evidence and then resolve the enclosing owner symbol in the same file so relationship payloads stay aligned with indexed reference semantics."
  - "Outgoing relationship edges inspect only fresh indexed references inside the resolved definition range, then breadth-first expand at most one additional hop with deterministic edge sorting and dedupe."
  - "Relationship metadata reuses the existing workspace breakdown and freshness warning patterns, and health now mirrors capabilities by exposing toolNames alongside supportedQueryTypes."
patterns-established:
  - "Relationship traversal stays read-only by composing resolveDefinition, searchReferences, and semanticIndex.getFreshRecords instead of introducing a second parsing or transport path."
  - "Workspace-aware MCP search tools return identical freshness and workspaceBreakdown shapes even when the underlying result type changes from definitions/references to relationship edges."
requirements-completed: [REL-01, REL-02, REL-03, REL-04]
duration: 15 min
completed: 2026-03-21
---

# Phase 06 Plan 02: Relationship retrieval and MCP tool Summary

**Indexed relationship traversal with one-hop impact expansion, a read-only `get_relationship_view` tool, and metadata surfaces that advertise relationship discovery consistently**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-21T15:02:00Z
- **Completed:** 2026-03-21T15:17:12Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Added a relationship backend that resolves a seed symbol, gathers direct incoming/outgoing evidence from indexed workflows, and expands one additional hop with stable dedupe.
- Exposed `get_relationship_view` as a read-only MCP tool with workspace-aware results, pagination, workspace breakdown, freshness metadata, and relationship discovery text tailored for multi-root workspaces.
- Updated capabilities/health/bootstrap-facing surfaces and locked the new relationship pipeline with focused regression coverage plus metadata assertions.

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement relationship traversal for direct links and one extra impact hop** - `3d2eb7f` (feat)
2. **Task 2: Expose `get_relationship_view` with workspace-aware payload shaping and metadata** - `99c1c0d` (feat)
3. **Task 3: Add focused backend coverage for traversal, filtering, and pagination** - `a49532b` (test)

_Plan metadata commit is created after summary/state updates._

## Files Created/Modified
- `tree-sitter-mcp/src/relationships/getRelationshipView.ts` - Resolves seed definitions, traverses indexed incoming/outgoing relationship evidence, dedupes edges, and combines freshness/diagnostic metadata.
- `tree-sitter-mcp/src/tools/getRelationshipViewTool.ts` - Registers the read-only `get_relationship_view` MCP tool and shapes workspace-aware relationship payloads.
- `tree-sitter-mcp/src/server/toolRegistry.ts` - Registers the new relationship-view tool with the MCP server.
- `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts` - Advertises `relationship_view` and `get_relationship_view` through capabilities metadata.
- `tree-sitter-mcp/src/tools/getHealthTool.ts` - Adds relationship discovery metadata and toolNames to health output.
- `tree-sitter-mcp/test/relationshipPipeline.test.ts` - Verifies direct edges, filters, pagination, hop expansion, dedupe, and malformed-edge diagnostics.
- `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts` - Updates metadata assertions for the new relationship query type and tool.
- `tree-sitter-mcp/test/serverBootstrap.test.ts` - Verifies bootstrap tool listing includes `get_relationship_view`.

## Decisions Made
- Reused `searchReferences` for incoming relationship evidence instead of duplicating reference classification logic, then mapped enclosing contexts back to owner definitions for the related symbol side of each edge.
- Limited traversal to breadth-first `maxDepth` 1..2 and sorted results by hop, relationship kind, workspace order, and source offsets so pagination stays deterministic.
- Kept the public tool payload parallel to existing indexed search tools by returning `workspaceRoots`, `workspaceBreakdown`, `freshness`, `diagnostic`, and `diagnostics` instead of inventing a relationship-only wrapper.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated metadata-facing tests to match the new relationship discovery surface**
- **Found during:** Task 3 (Add focused backend coverage for traversal, filtering, and pagination)
- **Issue:** Existing capabilities/health/bootstrap assertions hard-coded the pre-relationship query and tool lists, so `npm test` would fail once `relationship_view` and `get_relationship_view` were wired in.
- **Fix:** Extended `capabilitiesAndHealth.test.ts` and `serverBootstrap.test.ts` to assert the additive relationship query type and tool registration alongside the new relationship pipeline suite.
- **Files modified:** `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts`, `tree-sitter-mcp/test/serverBootstrap.test.ts`, `tree-sitter-mcp/test/relationshipPipeline.test.ts`
- **Verification:** `cd tree-sitter-mcp && npm test`
- **Committed in:** `a49532b` (part of Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The auto-fix kept the intended metadata changes verifiable without widening Phase 6 beyond read-only relationship discovery.

## Issues Encountered
- Sandbox restrictions blocked `git add` / `git commit` until the task commit commands were rerun with escalation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 06-03 can exercise `get_relationship_view` end-to-end against realistic federated repositories instead of first proving backend correctness.
- Relationship discovery is now visible through tool registration, capabilities, and health metadata, so client validation can focus on workflow quality rather than contract gaps.

## Self-Check: PASSED
- Found `.planning/phases/06-relationship-views-and-impact-discovery/06-02-SUMMARY.md`
- Found commit `3d2eb7f`
- Found commit `99c1c0d`
- Found commit `a49532b`

---
*Phase: 06-relationship-views-and-impact-discovery*
*Completed: 2026-03-21*
