---
phase: 06-relationship-views-and-impact-discovery
plan: 01
subsystem: search
tags: [tree-sitter, mcp, relationships, zod, diagnostics]
requires:
  - phase: 05-02
    provides: workspace-aware definition/reference contracts and shared filter normalization
  - phase: 05-03
    provides: deterministic federated search metadata and workspace-aware result shaping
provides:
  - relationship view schemas built on definition/reference primitives
  - normalized relationship filters for workspace, language, kind, pagination, and depth
  - relationship_view query registration and contract regression tests
affects: [06-02, 06-03, relationship traversal, tool wiring, capabilities]
tech-stack:
  added: []
  patterns: [schema-first relationship contracts, canonical relationship kind ordering, read-only impact-depth normalization]
key-files:
  created:
    - tree-sitter-mcp/src/relationships/relationshipTypes.ts
    - tree-sitter-mcp/src/relationships/relationshipFilters.ts
    - tree-sitter-mcp/src/queries/relationshipQueryCatalog.ts
    - tree-sitter-mcp/test/relationshipFilters.test.ts
  modified:
    - tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts
key-decisions:
  - "Reuse DefinitionMatchSchema and ReferenceMatchSchema inside relationship edges so workspace attribution and source evidence stay identical to existing search payloads."
  - "Constrain relationship maxDepth to 1..2 and default it to 1 so Phase 6 stays read-only and neighborhood-scoped."
  - "Normalize relationshipKinds into canonical enum order so future traversal output remains deterministic regardless of caller input order."
patterns-established:
  - "Relationship payloads are composed from existing definition/reference primitives instead of inventing parallel symbol or evidence shapes."
  - "Relationship filter normalization mirrors multi-workspace search semantics for workspaceRoots and language."
requirements-completed: [REL-02, REL-03]
duration: 9 min
completed: 2026-03-21
---

# Phase 06 Plan 01: Relationship contract foundations Summary

**Relationship-view schemas, deterministic filter normalization, and `relationship_view` contract tests built on existing definition/reference primitives**

## Performance

- **Duration:** 9 min
- **Started:** 2026-03-21T14:44:30Z
- **Completed:** 2026-03-21T14:53:21Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- Added a canonical Phase 6 schema module for relationship kinds, edges, request filters, and paginated relationship-view results.
- Introduced shared relationship filter normalization that aligns workspace/language handling with existing definition/reference search behavior and constrains `maxDepth` to a small read-only neighborhood.
- Registered the `relationship_view` query type and locked the new contract with focused regression coverage for defaults, dedupe behavior, diagnostics, and depth validation.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define the canonical relationship schemas and request contract** - `3dd2c5a` (feat)
2. **Task 2: Normalize relationship filters with the existing multi-workspace conventions** - `fa71211` (feat)
3. **Task 3: Register the relationship query type and lock the schema/filter contract with tests** - `1f1c4cc` (feat)

_Plan metadata commit is created after summary/state updates._

## Files Created/Modified
- `tree-sitter-mcp/src/relationships/relationshipTypes.ts` - Defines canonical relationship kinds plus request, filter, edge, and result schemas for Phase 6.
- `tree-sitter-mcp/src/relationships/relationshipFilters.ts` - Normalizes workspace/language/kind/depth/pagination inputs and filters relationship edges deterministically.
- `tree-sitter-mcp/src/queries/relationshipQueryCatalog.ts` - Registers the additive `relationship_view` semantic query type for future capability/tool wiring.
- `tree-sitter-mcp/test/relationshipFilters.test.ts` - Verifies relationshipKinds defaults, canonical dedupe, workspace/language diagnostics, and `maxDepth` validation.
- `tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts` - Adds a precise diagnostic code for invalid relationship depth requests.

## Decisions Made
- Reused `DefinitionMatchSchema` for related symbols and `ReferenceMatchSchema` for edge evidence to preserve exact workspace/source-location metadata without creating a second symbol model.
- Made `relationshipKinds` default to all four canonical kinds and reordered partial inputs canonically so future traversal output stays stable across callers and workspaces.
- Kept relationship filtering intentionally narrow to workspace roots, language, relationship kind, pagination, and `maxDepth`, deferring broader graph controls until later plans.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added a dedicated diagnostic code for invalid relationship depth**
- **Found during:** Task 2 (Normalize relationship filters with the existing multi-workspace conventions)
- **Issue:** The existing diagnostic enum had no precise code for actionable `maxDepth` validation failures, which would have forced the new relationship filter layer to mislabel out-of-range depth requests.
- **Fix:** Extended `diagnosticFactory` with `relationship_depth_invalid` and used it in `normalizeRelationshipFilters`.
- **Files modified:** `tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts`, `tree-sitter-mcp/src/relationships/relationshipFilters.ts`
- **Verification:** `cd tree-sitter-mcp && npm test`
- **Committed in:** `fa71211` (part of Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** The auto-fix was required for precise contract diagnostics and did not widen scope beyond the planned read-only relationship filter layer.

## Issues Encountered
- Sandbox restrictions blocked `git commit` until the task commit commands were rerun with escalation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 06-02 can implement traversal and payload shaping against a locked request/result contract instead of inventing schemas ad hoc.
- Relationship tool wiring can now advertise `relationship_view` and reuse deterministic workspace/language normalization from the shared filter layer.

## Self-Check: PASSED
- Found `.planning/phases/06-relationship-views-and-impact-discovery/06-01-SUMMARY.md`
- Found commit `3dd2c5a`
- Found commit `fa71211`
- Found commit `1f1c4cc`

---
*Phase: 06-relationship-views-and-impact-discovery*
*Completed: 2026-03-21*
