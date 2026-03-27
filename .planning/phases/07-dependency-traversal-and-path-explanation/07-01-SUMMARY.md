---
phase: 07-dependency-traversal-and-path-explanation
plan: 01
subsystem: search
tags: [tree-sitter, mcp, dependencies, zod, diagnostics]
requires:
  - phase: 06-01
    provides: relationship contract patterns, canonical relationship kind ordering, and workspace-aware filter normalization
  - phase: 06-02
    provides: read-only relationship traversal constraints and metadata expectations for later dependency tooling
provides:
  - additive dependency analysis schemas built on definition and reference primitives
  - normalized dependency filters with bounded depth diagnostics and canonical relationship kind handling
  - dependency_analysis query registration and focused contract regression tests
affects: [07-02, 07-03, dependency traversal, tool wiring, capabilities]
tech-stack:
  added: []
  patterns: [schema-first dependency contracts, canonical relationship kind reuse, bounded dependency filter normalization]
key-files:
  created:
    - tree-sitter-mcp/src/dependencies/dependencyTypes.ts
    - tree-sitter-mcp/src/dependencies/dependencyFilters.ts
    - tree-sitter-mcp/src/queries/dependencyQueryCatalog.ts
    - tree-sitter-mcp/test/dependencyFilters.test.ts
  modified:
    - tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts
key-decisions:
  - "Keep Phase 7 additive by introducing dedicated dependency request/result contracts and a separate dependency_analysis query type instead of widening get_relationship_view."
  - "Reuse DefinitionMatchSchema and ReferenceMatchSchema for every dependency path step so symbol endpoints and hop evidence keep stable workspace attribution."
  - "Default dependency maxDepth to 2, cap it at 4, and surface dependency_depth_invalid so future traversal stays bounded before backend code lands."
patterns-established:
  - "Dependency payloads compose existing definition and reference primitives instead of inventing a parallel symbol or evidence model."
  - "Dependency filter normalization mirrors relationship-view workspace, language, canonical kind ordering, pagination, and bounded depth semantics."
requirements-completed: [DEPS-02, DEPS-03, DEPS-04]
duration: 5 min
completed: 2026-03-27
---

# Phase 07 Plan 01: Dependency contract foundations Summary

**Additive dependency_analysis schemas with bounded depth filters, explanation-path attribution, and focused contract tests**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-27T14:17:01Z
- **Completed:** 2026-03-27T14:21:47Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- Added Phase 7 dependency request, filter, result, and explanation-path schemas without changing the shipped Phase 6 relationship-view contract.
- Introduced reusable dependency filter normalization with canonical relationship kind ordering, workspace/language validation, pagination defaults, and a dedicated invalid-depth diagnostic.
- Registered `dependency_analysis` and locked the new contract with focused regression tests for defaults, dedupe behavior, workspace/language diagnostics, and depth validation.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define dependency-analysis schemas and explanation-path contracts** - `09f3fbb` (feat)
2. **Task 2: Normalize dependency filters and add a dedicated depth diagnostic** - `2b777ad` (feat)
3. **Task 3: Register `dependency_analysis` and lock the contract with focused tests** - `797d890` (feat)

_Plan metadata commit is created after summary/state updates._

## Files Created/Modified
- `tree-sitter-mcp/src/dependencies/dependencyTypes.ts` - Defines the additive dependency seed, filter, explanation-path, request, and paginated result schemas for Phase 7.
- `tree-sitter-mcp/src/dependencies/dependencyFilters.ts` - Normalizes dependency workspace/language/kind/depth/pagination inputs and filters dependency results deterministically.
- `tree-sitter-mcp/src/queries/dependencyQueryCatalog.ts` - Registers the additive `dependency_analysis` semantic query type for future capability and tool wiring.
- `tree-sitter-mcp/test/dependencyFilters.test.ts` - Verifies dependency filter defaults, canonical dedupe, workspace/language diagnostics, and depth validation.
- `tree-sitter-mcp/src/diagnostics/diagnosticFactory.ts` - Adds the precise `dependency_depth_invalid` diagnostic code for out-of-range dependency requests.

## Decisions Made
- Kept dependency analysis additive so current `get_relationship_view` callers remain stable while later Phase 7 plans build a separate traversal surface.
- Reused existing definition/reference schemas inside explanation paths to preserve actionable symbol and evidence attribution across local workspaces.
- Matched relationship normalization conventions but widened dependency depth to a bounded `1..4` range with a default of `2` to support future multi-hop traversal.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `state advance-plan` could not parse the initial `STATE.md` body because the phase had only `Plan: Not started`; I normalized the state fields to explicit plan counters and reran the tooling successfully.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 07-02 can implement bounded traversal and explanation-path selection against locked request/result contracts instead of inventing payloads ad hoc.
- Phase 07-03 can wire MCP tooling and capability metadata against the already-registered `dependency_analysis` query surface.

## Self-Check: PASSED
- Found `.planning/phases/07-dependency-traversal-and-path-explanation/07-01-SUMMARY.md`
- Found commit `09f3fbb`
- Found commit `2b777ad`
- Found commit `797d890`

---
*Phase: 07-dependency-traversal-and-path-explanation*
*Completed: 2026-03-27*
