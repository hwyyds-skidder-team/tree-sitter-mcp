# Code Analysis Foundations Design

- **Date:** 2026-03-22
- **Project:** `tree-sitter-mcp`
- **Status:** Approved for planning
- **Primary outcome:** define the next milestone around a shared analysis engine plus strict MCP contract cleanup

## 1. Context

`tree-sitter-mcp` already ships read-only semantic search over local workspaces with persistent freshness-aware indexing, multi-workspace search, definition/reference lookup, and relationship-aware inspection with one extra impact hop. The next milestone should deepen the server's code-understanding value without expanding into write operations.

The user wants two things in parallel:

1. stronger code analysis, especially:
   - higher-level code understanding outputs
   - deeper relationship and impact-chain analysis
2. stricter MCP schema correctness because schema/runtime drift reduces model tool-call success rates

The user explicitly chose:

- focus on the **analysis engine first**, not only one UI/tool flow
- support **symbol-level, module-level, and change-impact workflows** from shared internals
- expose **specialized tools** rather than one generic analysis tool
- ship `analyze_symbol`, `summarize_module`, and `analyze_change_impact`
- support `analyze_change_impact` v1 for hypothetical symbol/file changes and multi-file change sets, but **not** real diff/patch ingestion yet
- treat schema cleanup as part of the **same milestone**
- allow **breaking changes** instead of maintaining a compatibility layer

## 2. Problem Statement

The current tool surface is strong at retrieval, but weaker at synthesis:

- relationship traversal is limited to direct edges plus one extra hop
- module-level understanding is not a first-class output
- change impact must be inferred by the caller across multiple tools
- tool contracts have drifted from runtime behavior in ways that can mislead MCP clients and models

Known drift examples already visible in the current codebase include:

- `resolve_definition` accepts `symbol` and `lookup` as optional in the schema, but runtime behavior effectively requires one of them
- `search_references` runtime accepts `offset` and `includeContext`, while shared request schema coverage is incomplete
- `get_relationship_view` returns a resolved target under the output field `seed`, which is inconsistent with the intended semantics and with other tool naming
- tool name lists are hand-maintained and can drift when the surface changes

## 3. Goals

### 3.1 Product goals

1. Add a reusable analysis layer that produces both:
   - structured graph facts
   - derived summaries grounded in those facts
2. Support three first-class workflows:
   - analyze one symbol
   - summarize one module/file
   - estimate impact from symbol/file change seeds
3. Increase model tool-call success by making tool schemas and runtime behavior strictly align.

### 3.2 Engineering goals

1. Keep the existing semantic index as the source of truth.
2. Reuse current freshness semantics rather than inventing a second freshness model for analysis.
3. Keep analysis read-only.
4. Make future deeper analysis and write-safe workflows easier to add.

## 4. Non-Goals

This milestone does **not** include:

- code mutation, refactoring, or write workflows
- HTTP or other transport expansion
- ingestion of raw git diff or patch content for change impact
- unbounded whole-program graph analysis
- speculative natural-language summaries not backed by structured facts
- broad compatibility shims for old MCP contracts

## 5. Approaches Considered

### Approach A: compose analysis directly from existing tools

Build the new workflows mostly as adapters over `resolve_definition`, `search_references`, `get_relationship_view`, and `list_file_symbols`.

- **Pros:** fastest to ship, smallest initial change set
- **Cons:** logic becomes duplicated across tools, module/change analysis remains awkward, and contract cleanup risks staying fragmented

### Approach B: add a unified internal analysis layer (**recommended**)

Add `src/analysis/` as a shared engine that derives symbol and module graphs from fresh indexed records. New MCP tools become thin wrappers over this engine.

- **Pros:** best fit for shared symbol/module/change analysis, clean layering, single place for traversal/aggregation/summary logic, easier contract consistency
- **Cons:** larger change than adapter-only work

### Approach C: persist analysis graphs in the index

Precompute analysis graphs and summaries during workspace setup or refresh.

- **Pros:** faster query time later
- **Cons:** higher freshness complexity, heavier milestone scope, more operational risk right now

### Decision

Adopt **Approach B**.

## 6. Proposed Architecture

### 6.1 Layering

Keep the existing index and retrieval code as the semantic fact source. Add a new internal layer:

- `src/analysis/` — builds and queries analysis snapshots
- `src/tools/` — validates MCP contracts and calls the analysis layer
- existing `src/indexing/`, `src/definitions/`, `src/references/`, `src/relationships/` — remain fact providers and reusable lower-level primitives

### 6.2 New internal concept: `AnalysisSnapshot`

Each analysis request operates on a freshness-checked snapshot derived from the current indexed records for the selected workspace roots.

The snapshot contains:

- symbol graph
- module graph
- symbol-to-module membership mapping
- edge evidence lookup
- traversal caches needed within the request

### 6.3 Build model

The analysis snapshot is built **on demand from fresh indexed records**.

Reasons:

- it matches the existing freshness-aware index model
- it avoids introducing a second persisted artifact with separate staleness semantics
- it keeps v1 focused on correctness and contract quality

### 6.4 Caching model

Use **request-scoped caches** only in v1, such as:

- resolved symbol lookup cache
- symbol ID mapping cache
- module aggregation cache
- traversal/path deduplication cache

Do not persist analysis graphs across requests in this milestone.

## 7. Core Data Model

The analysis layer should introduce shared types that both the engine and MCP tools reuse.

### 7.1 `SymbolNode`

Represents one analyzable symbol.

Fields should include:

- stable `symbolId`
- all key `DefinitionMatch` identity fields
- optional normalized metadata needed for ranking, graph traversal, and summary generation

This should extend current definition identity rather than invent an unrelated model.

### 7.2 `ModuleNode`

Represents one module/file.

Identity:

- `workspaceRoot`
- `relativePath`

Fields should include:

- language ID
- exported/declared symbols
- entry symbols
- incoming/outgoing dependency counts
- summary-oriented aggregates

### 7.3 `AnalysisEdge`

Represents a relationship with evidence.

Requirements:

- every edge must keep evidence
- every edge must be attributable to workspace/path context
- edges must support hop count and path reconstruction

Expected edge families:

- symbol graph:
  - `incoming_call`
  - `outgoing_call`
  - `incoming_reference`
  - `outgoing_reference`
- module graph:
  - `imports`
  - `imported_by`
  - `calls_into`
  - `called_by`
- cross-layer:
  - `declares`
  - `belongs_to`

### 7.4 `DerivedSummary`

Represents deterministic analysis summaries derived from structured facts, not free-form speculation.

Expected shape:

- `overview`
- `keyPoints`
- `riskFlags`
- `suggestedNextQueries`

## 8. Tool Surface

The milestone adds three MCP tools.

### 8.1 `analyze_symbol`

#### Purpose
Explain what a symbol does, what it depends on, who depends on it, and where its likely impact hotspots are.

#### Input
- `target`
  - `name`
  - optional `kind`
  - optional `languageId`
  - optional `workspaceRoot`
  - optional `relativePath`
- optional `workspaceRoots`
- optional `maxDepth` (v1 constrained, recommended cap: 3)
- optional pagination/limit fields where appropriate for graph/path output

#### Output
- resolved `target`
- symbol-focused graph facts
- nearby module context
- derived summary
- freshness and diagnostics

### 8.2 `summarize_module`

#### Purpose
Describe a module's role, main entry points, exports, dependencies, and likely risk areas.

#### Input
- `target`
  - `workspaceRoot`
  - `relativePath`
- optional `workspaceRoots`
- optional `dependencyDepth` (recommended v1 cap: 2)

#### Output
- resolved module target
- contained symbols
- exports/entry points
- incoming and outgoing dependencies
- derived summary
- freshness and diagnostics

### 8.3 `analyze_change_impact`

#### Purpose
Estimate what symbols and modules are likely impacted if specified seeds change.

#### Input
- `seeds[]`
  - symbol seeds and/or module/file seeds
- optional `workspaceRoots`
- optional `maxDepth`

v1 supports:

- hypothetical symbol change seeds
- hypothetical file/module change seeds
- multi-file change sets

v1 does **not** support:

- raw diff/patch ingestion
- semantic write plans

#### Output
- resolved and unresolved seeds
- impacted symbols
- impacted modules
- propagation paths
- derived summary
- freshness and diagnostics

## 9. Contract Design Rules

Schema/runtime alignment is a first-class deliverable of the milestone.

### 9.1 Naming rules

Use these names consistently across old and new tools after cleanup:

- single target: `target`
- multiple targets: `seeds`
- graph payload: `graph`
- explanation payload: `summary`
- standard metadata: `freshness`, `diagnostic`, `diagnostics`

### 9.2 Single source of truth

Tool contracts must be defined once and reused.

Implementation rule:

- input and output schemas are the authoritative contract source
- runtime normalization and payload shaping must not silently accept or produce fields missing from those schemas
- TypeScript types for tool handlers should derive from those schemas or shared contract modules rather than hand-maintained parallel shapes

### 9.3 Existing tools to clean up in this milestone

At minimum, audit and align:

- `resolve_definition`
- `search_references`
- `get_relationship_view`
- `get_capabilities` / `get_health` tool name reporting

The audit should also cover the rest of `src/tools/` so the project ends the milestone with one consistent contract standard.

### 9.4 Breaking-change stance

This milestone intentionally allows breaking changes.

That means:

- no compatibility aliases are required
- old field names may be removed
- schema should describe the new canonical contract only

## 10. Analysis Flow

### 10.1 Common request flow

1. MCP tool validates the request against the canonical input schema.
2. The tool normalizes selected workspace scope and analysis options.
3. The tool obtains fresh indexed records.
4. The analysis layer builds an `AnalysisSnapshot` for the request.
5. The tool-specific analyzer runs on the snapshot.
6. The analyzer returns:
   - structured facts
   - deterministic summary output
   - diagnostics/freshness
7. The tool returns a schema-valid MCP payload.

### 10.2 Shared analyzers

Implement shared analysis services so the three tools remain different views over one engine:

- symbol analysis service
- module summary service
- change impact service
- shared graph traversal/path service
- shared summary derivation service

## 11. Error Handling and Degradation

The server should prefer **partial useful output plus explicit diagnostics** over all-or-nothing failure, except for contract-invalid requests.

### 11.1 Error classes

1. **Contract errors**
   - invalid schema input
   - fail immediately with `isError: true`
2. **Resolution errors**
   - workspace not set, target unresolved, module path invalid
   - return empty/partial result with actionable diagnostics
3. **Coverage degradation**
   - degraded files, rebuild in progress, incomplete evidence
   - return partial analysis and expose uncertainty clearly

### 11.2 Tool-specific behavior

#### `analyze_symbol`
- unresolved target: empty graph plus actionable error diagnostic
- partial traversal coverage: partial graph plus warning diagnostics

#### `summarize_module`
- valid module but incomplete contained-symbol analysis: still return module summary with explicit coverage warning

#### `analyze_change_impact`
- if some seeds cannot resolve, keep analyzing the resolved seeds and return both `resolvedSeeds` and `unresolvedSeeds`

## 12. Summary Derivation Rules

Summaries must stay grounded in structural facts.

### 12.1 Principles

- summaries may summarize facts, not invent facts
- every notable conclusion should be traceable to graph data or diagnostics
- summaries should expose uncertainty when freshness/coverage is degraded

### 12.2 Example rule outputs

- mark a symbol as higher impact when many external callers or dependents converge on it
- mark a module as boundary-sensitive when it has both high incoming and high outgoing dependency weight
- mark cross-workspace propagation when paths span more than one configured root
- include an explicit incompleteness warning when freshness is `degraded` or `rebuilding`

## 13. Testing Strategy

### 13.1 Contract tests

Add regression coverage that ensures handler behavior and schemas match.

Coverage should include:

- required-field enforcement
- output payload schema validation
- cleanup regressions for the current drift cases
- new tool input/output shape tests

### 13.2 Analysis unit tests

Add unit tests for:

- symbol graph construction
- module graph construction
- symbol-to-module mapping
- traversal logic
- propagation path reconstruction
- summary rule derivation

### 13.3 Tool integration tests

Add integration coverage for:

- `analyze_symbol`
- `summarize_module`
- `analyze_change_impact`
- unresolved targets
- partial coverage and degraded freshness
- multi-workspace behavior

### 13.4 End-to-end semantic tests

Validate that a caller can:

- pass the documented fields successfully
- chain outputs into follow-up tool requests
- rely on stable naming conventions across tools
- distinguish complete from degraded analysis

## 14. Phased Delivery Plan

### Phase 1: contract cleanup

- align existing tool schemas with runtime behavior
- standardize naming where practical within the breaking-change window
- derive tool name reporting from the registered tool surface
- add contract regression tests

### Phase 2: analysis foundations

- add `src/analysis/`
- implement `AnalysisSnapshot`
- build symbol graph and module graph
- add cross-layer mappings and shared traversal utilities

### Phase 3: new analysis tools

- ship `analyze_symbol`
- ship `summarize_module`
- ship `analyze_change_impact`
- return structured facts plus deterministic summaries

### Phase 4: hardening

- expand degraded/multi-workspace coverage
- improve path ranking and result shaping
- ensure model-facing payload clarity and consistency

## 15. Acceptance Criteria

The milestone is done when:

1. the repository has a shared internal analysis layer used by all three new tools
2. `analyze_symbol`, `summarize_module`, and `analyze_change_impact` are available over MCP
3. current schema/runtime drift issues are corrected under the new canonical contract rules
4. contract regression tests prevent future schema drift from silently reappearing
5. results consistently expose freshness and diagnostics for partial or degraded analysis
6. derived summaries remain deterministic and traceable to structured facts

## 16. Open Questions Deferred Intentionally

These are intentionally postponed beyond this milestone so they do not block planning:

- whether to persist analysis graphs across requests
- how to ingest raw diff/patch inputs for impact analysis
- how far beyond v1 depth caps traversal should go
- whether future write-safe workflows should reuse the same analysis contracts directly

## 17. Planning Readiness

This spec is ready to drive implementation planning for a single milestone centered on analysis foundations and MCP contract cleanup. It is intentionally scoped to one shared engine, three new tools, and one contract-hardening pass rather than multiple independent subsystems.
