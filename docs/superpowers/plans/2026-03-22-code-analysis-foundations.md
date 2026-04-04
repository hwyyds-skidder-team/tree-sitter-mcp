# Code Analysis Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared code-analysis engine with `analyze_symbol`, `summarize_module`, and `analyze_change_impact`, while tightening MCP schemas so runtime behavior and contracts always match.

**Architecture:** Keep the persistent semantic index as the source of truth, add a request-scoped `AnalysisSnapshot` layer under `tree-sitter-mcp/src/analysis/`, and expose thin MCP tool adapters that reuse canonical Zod contracts plus deterministic summary rules. Clean up existing tool contracts first, then layer in symbol/module graphs, shared traversal, and the three new tools so every response carries consistent freshness and diagnostics.

**Tech Stack:** TypeScript, Node 22, `@modelcontextprotocol/sdk`, `zod`, Tree-sitter, `tsx --test`

---

## Working Notes

- All commands below run from the repository root unless the command explicitly `cd`s into `tree-sitter-mcp/`.
- Follow TDD exactly: write the failing test first, run it and confirm the failure, then implement the minimum code to pass.
- Keep commits small and aligned with the task boundary.
- Do not add compatibility aliases for old tool contracts; this milestone intentionally allows breaking changes.
- If a failing regression exposes extra schema drift outside the named files, fix it in the same task that surfaced it.

## File Structure / Responsibility Map

### New files to create

- `tree-sitter-mcp/src/server/toolCatalog.ts`
  - Canonical list of registered tool names and registration functions so `toolRegistry`, `get_capabilities`, and `get_health` all read the same source.
- `tree-sitter-mcp/src/tools/getServerInfoTool.ts`
  - Dedicated bootstrap/server-info tool module so the tool catalog can register it without circular imports.
- `tree-sitter-mcp/src/analysis/analysisTypes.ts`
  - Shared analysis node/edge/path/summary schemas and TypeScript types.
- `tree-sitter-mcp/src/analysis/analysisQueryCatalog.ts`
  - Query-type names for analysis capabilities reporting.
- `tree-sitter-mcp/src/analysis/buildAnalysisSnapshot.ts`
  - Builds `AnalysisSnapshot` from fresh indexed records, including symbol/module maps and evidence indexes.
- `tree-sitter-mcp/src/analysis/graphTraversal.ts`
  - Shared BFS/path traversal, hop limiting, and de-duplication utilities.
- `tree-sitter-mcp/src/analysis/summaryRules.ts`
  - Deterministic summary/risk/suggested-query derivation.
- `tree-sitter-mcp/src/analysis/analyzeSymbol.ts`
  - Symbol-centric analysis service.
- `tree-sitter-mcp/src/analysis/summarizeModule.ts`
  - Module/file-centric analysis service.
- `tree-sitter-mcp/src/analysis/analyzeChangeImpact.ts`
  - Seed-based impact propagation service.
- `tree-sitter-mcp/src/tools/analyzeSymbolTool.ts`
  - MCP adapter for `analyze_symbol`.
- `tree-sitter-mcp/src/tools/summarizeModuleTool.ts`
  - MCP adapter for `summarize_module`.
- `tree-sitter-mcp/src/tools/analyzeChangeImpactTool.ts`
  - MCP adapter for `analyze_change_impact`.
- `tree-sitter-mcp/test/helpers/createAnalysisWorkspaceFixture.ts`
  - Shared fixture generator for the new analysis E2E and unit tests.
- `tree-sitter-mcp/test/contractAlignment.test.ts`
  - Regression coverage for tool schemas, required fields, and canonical naming.
- `tree-sitter-mcp/test/analysisSnapshot.test.ts`
  - Unit tests for snapshot construction and graph membership.
- `tree-sitter-mcp/test/analysisSummary.test.ts`
  - Unit tests for traversal, risk flags, and summary rules.
- `tree-sitter-mcp/test/analysisTools.e2e.test.ts`
  - End-to-end MCP coverage for the three new analysis tools.

### Existing files to modify

- `tree-sitter-mcp/src/server/toolRegistry.ts`
  - Register tools through the canonical catalog and add the three new analysis tools.
- `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts`
  - Pull canonical tool names and add analysis query types.
- `tree-sitter-mcp/src/tools/getHealthTool.ts`
  - Same canonical tool name/query type reporting as capabilities.
- `tree-sitter-mcp/src/tools/resolveDefinitionTool.ts`
  - Enforce one-of input requirements at the schema level.
- `tree-sitter-mcp/src/tools/searchReferencesTool.ts`
  - Align the input schema with supported runtime fields and canonical naming.
- `tree-sitter-mcp/src/tools/getRelationshipViewTool.ts`
  - Rename output field `seed` to `target` and keep the schema/output payload aligned.
- `tree-sitter-mcp/src/references/referenceTypes.ts`
  - Canonical schema for reference search filters and request fields, including `offset` and `includeContext`.
- `tree-sitter-mcp/src/relationships/relationshipTypes.ts`
  - Canonical relationship request/filter schema shared by the tool and engine.
- `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts`
  - Assert new tool names/query types are surfaced through the canonical catalog.
- `tree-sitter-mcp/test/referenceTools.e2e.test.ts`
  - Assert `search_references` accepts the documented fields and paginates correctly.
- `tree-sitter-mcp/test/relationshipTools.e2e.test.ts`
  - Assert `get_relationship_view` returns `target` instead of `seed`.
- `tree-sitter-mcp/README.md`
  - Update the tool surface and analysis capability description.

---

### Task 1: Add a canonical tool catalog and contract regression harness

**Files:**
- Create: `tree-sitter-mcp/src/server/toolCatalog.ts`
- Create: `tree-sitter-mcp/src/tools/getServerInfoTool.ts`
- Create: `tree-sitter-mcp/test/contractAlignment.test.ts`
- Modify: `tree-sitter-mcp/src/server/toolRegistry.ts`
- Modify: `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts`
- Modify: `tree-sitter-mcp/src/tools/getHealthTool.ts`
- Test: `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts`

- [ ] **Step 1: Write the failing contract/catalog tests**

```ts
// tree-sitter-mcp/test/contractAlignment.test.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listRegisteredToolNames } from "../src/server/toolCatalog.js";

const packageRoot = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
const serverEntry = path.join(packageRoot, "dist", "index.js");

async function listLiveTools() {
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-contract-index-"));
  const client = new Client({ name: "tree-sitter-mcp-contract-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: packageRoot,
    env: { ...(process.env as Record<string, string>), TREE_SITTER_MCP_INDEX_DIR: indexRootDir },
  });

  await client.connect(transport);
  const tools = await client.listTools();
  await client.close();
  await transport.close();
  return tools;
}

test("tool catalog matches the live MCP tool list", async () => {
  const tools = await listLiveTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), listRegisteredToolNames().sort());
});
```

```ts
// tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
import { listRegisteredToolNames } from "../src/server/toolCatalog.js";

assert.deepEqual(capabilities.toolNames.sort(), listRegisteredToolNames().sort());
assert.deepEqual(readyHealth.toolNames.sort(), listRegisteredToolNames().sort());
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `cd tree-sitter-mcp && npx tsx --test test/contractAlignment.test.ts test/capabilitiesAndHealth.test.ts`
Expected: FAIL because tool names are still hand-maintained and there is no shared catalog yet.

- [ ] **Step 3: Implement the canonical tool catalog**

```ts
// tree-sitter-mcp/src/tools/getServerInfoTool.ts
export function registerGetServerInfoTool(server: McpServer, context: ServerContext): void {
  server.registerTool("tree_sitter_get_server_info", {
    title: "Get Tree-sitter MCP Server Info",
    outputSchema: BootstrapInfoSchema,
  }, async () => ({ structuredContent: buildBootstrapPayload(context), content: [] }));
}
```

```ts
// tree-sitter-mcp/src/server/toolCatalog.ts
export const TOOL_CATALOG = [
  { name: "tree_sitter_get_server_info", register: registerGetServerInfoTool },
  { name: "set_workspace", register: registerSetWorkspaceTool },
  // ...existing tools...
] as const;

export function listRegisteredToolNames(): string[] {
  return TOOL_CATALOG.map((entry) => entry.name);
}
```

```ts
// tree-sitter-mcp/src/server/toolRegistry.ts
for (const entry of TOOL_CATALOG) {
  entry.register(server, context);
}
```

- [ ] **Step 4: Re-run the targeted tests and confirm they pass**

Run: `cd tree-sitter-mcp && npx tsx --test test/contractAlignment.test.ts test/capabilitiesAndHealth.test.ts`
Expected: PASS with capabilities/health tool lists matching the shared catalog.

- [ ] **Step 5: Commit**

```bash
git add \
  tree-sitter-mcp/src/server/toolCatalog.ts \
  tree-sitter-mcp/src/tools/getServerInfoTool.ts \
  tree-sitter-mcp/src/server/toolRegistry.ts \
  tree-sitter-mcp/src/tools/getCapabilitiesTool.ts \
  tree-sitter-mcp/src/tools/getHealthTool.ts \
  tree-sitter-mcp/test/contractAlignment.test.ts \
  tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
git commit -m "refactor: centralize MCP tool catalog"
```

### Task 2: Fix existing MCP contract drift before adding new analysis tools

**Files:**
- Modify: `tree-sitter-mcp/src/tools/resolveDefinitionTool.ts`
- Modify: `tree-sitter-mcp/src/tools/searchReferencesTool.ts`
- Modify: `tree-sitter-mcp/src/tools/getRelationshipViewTool.ts`
- Modify: `tree-sitter-mcp/src/references/referenceTypes.ts`
- Modify: `tree-sitter-mcp/src/relationships/relationshipTypes.ts`
- Modify: `tree-sitter-mcp/test/contractAlignment.test.ts`
- Modify: `tree-sitter-mcp/test/referenceTools.e2e.test.ts`
- Modify: `tree-sitter-mcp/test/relationshipTools.e2e.test.ts`

- [ ] **Step 1: Write failing regression tests for the known drift cases**

```ts
// tree-sitter-mcp/test/contractAlignment.test.ts
test("resolve_definition requires symbol or lookup", async () => {
  const tools = await listLiveTools();
  const resolveDefinition = tools.tools.find((tool) => tool.name === "resolve_definition");
  assert.ok(resolveDefinition);
  assert.match(JSON.stringify(resolveDefinition.inputSchema), /symbol|lookup/);
});
```

```ts
// tree-sitter-mcp/test/referenceTools.e2e.test.ts
const pagedReferenceResult = await client.callTool({
  name: "search_references",
  arguments: {
    symbol: definition,
    limit: 1,
    offset: 1,
    includeContext: false,
  },
});
assert.notEqual(pagedReferenceResult.isError, true);
```

```ts
// tree-sitter-mcp/test/relationshipTools.e2e.test.ts
assert.equal(relationshipPayload.target?.name, "helper");
assert.equal("seed" in relationshipPayload, false);
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `cd tree-sitter-mcp && npx tsx --test test/contractAlignment.test.ts test/referenceTools.e2e.test.ts test/relationshipTools.e2e.test.ts`
Expected: FAIL because the current schema/output payloads do not match the asserted contract.

- [ ] **Step 3: Implement the contract cleanup with canonical naming**

```ts
// tree-sitter-mcp/src/tools/resolveDefinitionTool.ts
const ResolveDefinitionInputSchema = z.object({
  symbol: DefinitionLookupSchema.optional(),
  lookup: DefinitionLookupSchema.optional(),
}).refine((input) => input.symbol || input.lookup, {
  message: "Provide a definition target via symbol or lookup.",
  path: ["symbol"],
});
```

```ts
// tree-sitter-mcp/src/references/referenceTypes.ts
export const SearchReferencesRequestSchema = z.object({
  symbol: ReferenceSearchTargetSchema.optional(),
  lookup: ReferenceSearchTargetSchema.optional(),
  workspaceRoots: z.array(z.string().min(1)).min(1).optional(),
  language: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
  includeContext: z.boolean().optional(),
}).refine((input) => input.symbol || input.lookup, {
  message: "Provide a reference target via symbol or lookup.",
  path: ["symbol"],
});
```

```ts
// tree-sitter-mcp/src/tools/getRelationshipViewTool.ts
const payload = {
  // ...
  target: result.target,
  results: result.edges,
};
```

- [ ] **Step 4: Re-run the targeted tests and confirm they pass**

Run: `cd tree-sitter-mcp && npx tsx --test test/contractAlignment.test.ts test/referenceTools.e2e.test.ts test/relationshipTools.e2e.test.ts`
Expected: PASS with `resolve_definition`, `search_references`, and `get_relationship_view` all matching the documented schema.

- [ ] **Step 5: Commit**

```bash
git add \
  tree-sitter-mcp/src/tools/resolveDefinitionTool.ts \
  tree-sitter-mcp/src/tools/searchReferencesTool.ts \
  tree-sitter-mcp/src/tools/getRelationshipViewTool.ts \
  tree-sitter-mcp/src/references/referenceTypes.ts \
  tree-sitter-mcp/src/relationships/relationshipTypes.ts \
  tree-sitter-mcp/test/contractAlignment.test.ts \
  tree-sitter-mcp/test/referenceTools.e2e.test.ts \
  tree-sitter-mcp/test/relationshipTools.e2e.test.ts
git commit -m "fix: align MCP tool contracts with runtime behavior"
```

### Task 3: Build the shared analysis snapshot and graph model

**Files:**
- Create: `tree-sitter-mcp/src/analysis/analysisTypes.ts`
- Create: `tree-sitter-mcp/src/analysis/analysisQueryCatalog.ts`
- Create: `tree-sitter-mcp/src/analysis/buildAnalysisSnapshot.ts`
- Create: `tree-sitter-mcp/test/helpers/createAnalysisWorkspaceFixture.ts`
- Create: `tree-sitter-mcp/test/analysisSnapshot.test.ts`

- [ ] **Step 1: Write the failing snapshot/graph unit tests**

```ts
// tree-sitter-mcp/test/analysisSnapshot.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisSnapshot } from "../src/analysis/buildAnalysisSnapshot.js";
import { createIndexedRecordsFixture } from "./helpers/createAnalysisWorkspaceFixture.js";

test("buildAnalysisSnapshot creates symbol and module nodes from indexed records", async () => {
  const records = await createIndexedRecordsFixture();
  const snapshot = buildAnalysisSnapshot(records, { workspaceRoots: [records[0]!.workspaceRoot] });

  assert.ok(snapshot.symbolsById.size > 0);
  assert.ok(snapshot.modulesById.size > 0);
  assert.ok(snapshot.belongsToEdges.length > 0);
});
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisSnapshot.test.ts`
Expected: FAIL because the analysis snapshot files do not exist yet.

- [ ] **Step 3: Implement the minimal shared analysis model**

```ts
// tree-sitter-mcp/src/analysis/analysisTypes.ts
export const AnalysisRiskFlagSchema = z.enum([
  "high_impact_symbol",
  "boundary_sensitive_module",
  "cross_workspace_propagation",
  "analysis_incomplete",
]);

export interface AnalysisSnapshot {
  workspaceRoots: string[];
  symbolsById: Map<string, SymbolNode>;
  modulesById: Map<string, ModuleNode>;
  outgoingEdgesBySymbolId: Map<string, AnalysisEdge[]>;
  incomingEdgesBySymbolId: Map<string, AnalysisEdge[]>;
  belongsToEdges: AnalysisEdge[];
}
```

```ts
// tree-sitter-mcp/src/analysis/buildAnalysisSnapshot.ts
export function buildAnalysisSnapshot(
  records: IndexedFileSemanticRecord[],
  options: { workspaceRoots?: string[] },
): AnalysisSnapshot {
  // filter records, assign stable symbol IDs, index symbols/modules, and capture evidence-backed edges
}
```

- [ ] **Step 4: Re-run the targeted tests and confirm they pass**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisSnapshot.test.ts`
Expected: PASS with symbol/module graph membership built from indexed records.

- [ ] **Step 5: Commit**

```bash
git add \
  tree-sitter-mcp/src/analysis/analysisTypes.ts \
  tree-sitter-mcp/src/analysis/analysisQueryCatalog.ts \
  tree-sitter-mcp/src/analysis/buildAnalysisSnapshot.ts \
  tree-sitter-mcp/test/helpers/createAnalysisWorkspaceFixture.ts \
  tree-sitter-mcp/test/analysisSnapshot.test.ts
git commit -m "feat: add shared analysis snapshot model"
```

### Task 4: Add traversal utilities and deterministic summary rules

**Files:**
- Create: `tree-sitter-mcp/src/analysis/graphTraversal.ts`
- Create: `tree-sitter-mcp/src/analysis/summaryRules.ts`
- Create: `tree-sitter-mcp/test/analysisSummary.test.ts`
- Modify: `tree-sitter-mcp/src/analysis/analysisTypes.ts`
- Modify: `tree-sitter-mcp/src/analysis/buildAnalysisSnapshot.ts`

- [ ] **Step 1: Write the failing traversal/summary tests**

```ts
// tree-sitter-mcp/test/analysisSummary.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { collectTraversalPaths } from "../src/analysis/graphTraversal.js";
import { deriveSummary } from "../src/analysis/summaryRules.js";
import { createSyntheticSnapshot } from "./helpers/createAnalysisWorkspaceFixture.js";

test("deriveSummary flags high-impact and incomplete analysis states", () => {
  const snapshot = createSyntheticSnapshot();
  const paths = collectTraversalPaths(snapshot, { seedSymbolIds: ["helper"], maxDepth: 3 });
  const summary = deriveSummary({
    snapshot,
    paths,
    freshness: { state: "degraded", refreshedFiles: [], degradedFiles: ["src/broken.ts"], checkedAt: new Date().toISOString(), workspaceFingerprint: "fp" },
  });

  assert.ok(summary.riskFlags.includes("high_impact_symbol"));
  assert.ok(summary.riskFlags.includes("analysis_incomplete"));
});
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisSummary.test.ts`
Expected: FAIL because traversal and summary rules are not implemented yet.

- [ ] **Step 3: Implement traversal and summary derivation**

```ts
// tree-sitter-mcp/src/analysis/graphTraversal.ts
export function collectTraversalPaths(
  snapshot: AnalysisSnapshot,
  options: { seedSymbolIds: string[]; maxDepth: number },
): AnalysisPath[] {
  // breadth-first traversal with hop limit, path de-duplication, and stable ordering
}
```

```ts
// tree-sitter-mcp/src/analysis/summaryRules.ts
export function deriveSummary(input: DeriveSummaryInput): DerivedSummary {
  return {
    overview: buildOverview(input),
    keyPoints: buildKeyPoints(input),
    riskFlags: buildRiskFlags(input),
    suggestedNextQueries: buildSuggestedNextQueries(input),
  };
}
```

- [ ] **Step 4: Re-run the targeted tests and confirm they pass**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisSummary.test.ts`
Expected: PASS with deterministic traversal ordering and rule-based summaries.

- [ ] **Step 5: Commit**

```bash
git add \
  tree-sitter-mcp/src/analysis/graphTraversal.ts \
  tree-sitter-mcp/src/analysis/summaryRules.ts \
  tree-sitter-mcp/src/analysis/analysisTypes.ts \
  tree-sitter-mcp/src/analysis/buildAnalysisSnapshot.ts \
  tree-sitter-mcp/test/analysisSummary.test.ts
git commit -m "feat: add traversal and summary rules for analysis"
```

### Task 5: Ship `analyze_symbol`

**Files:**
- Create: `tree-sitter-mcp/src/analysis/analyzeSymbol.ts`
- Create: `tree-sitter-mcp/src/tools/analyzeSymbolTool.ts`
- Modify: `tree-sitter-mcp/src/server/toolCatalog.ts`
- Modify: `tree-sitter-mcp/src/server/toolRegistry.ts`
- Modify: `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts`
- Modify: `tree-sitter-mcp/src/tools/getHealthTool.ts`
- Create: `tree-sitter-mcp/test/analysisTools.e2e.test.ts`
- Modify: `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts`

- [ ] **Step 1: Write the failing `analyze_symbol` tests**

```ts
// tree-sitter-mcp/test/analysisTools.e2e.test.ts
const analyzeSymbolResult = await client.callTool({
  name: "analyze_symbol",
  arguments: {
    target: { name: "helper", kind: "function", relativePath: "src/core.ts" },
    maxDepth: 2,
  },
});
assert.notEqual(analyzeSymbolResult.isError, true);
const analyzeSymbolPayload = analyzeSymbolResult.structuredContent as {
  target: { name: string; relativePath: string };
  graph: { symbols: Array<{ name: string }>; paths: Array<{ hopCount: number }> };
  summary: { overview: string; keyPoints: string[]; riskFlags: string[] };
};
assert.equal(analyzeSymbolPayload.target.name, "helper");
assert.ok(analyzeSymbolPayload.graph.symbols.some((symbol) => symbol.name === "formatName"));
assert.ok(analyzeSymbolPayload.summary.keyPoints.length > 0);
```

```ts
// tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
assert.ok(capabilities.toolNames.includes("analyze_symbol"));
assert.ok(capabilities.supportedQueryTypes.includes("symbol_analysis"));
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisTools.e2e.test.ts test/capabilitiesAndHealth.test.ts`
Expected: FAIL because `analyze_symbol` is not registered yet.

- [ ] **Step 3: Implement the symbol analysis service and MCP adapter**

```ts
// tree-sitter-mcp/src/analysis/analyzeSymbol.ts
export async function analyzeSymbol(
  context: ServerContext,
  request: AnalyzeSymbolRequest,
): Promise<AnalyzeSymbolResult> {
  const freshIndex = await context.semanticIndex.getFreshRecords(context);
  const snapshot = buildAnalysisSnapshot(freshIndex.records, { workspaceRoots: request.workspaceRoots });
  const target = await resolveAnalysisTarget(context, request.target);
  const paths = collectTraversalPaths(snapshot, { seedSymbolIds: [target.symbolId], maxDepth: request.maxDepth ?? 2 });
  return shapeAnalyzeSymbolResult({ target, snapshot, paths, freshness: freshIndex.freshness });
}
```

```ts
// tree-sitter-mcp/src/tools/analyzeSymbolTool.ts
server.registerTool("analyze_symbol", {
  title: "Analyze Symbol",
  description: "Inspect a symbol's role, neighbors, and likely impact paths.",
  inputSchema: AnalyzeSymbolRequestSchema,
  outputSchema: AnalyzeSymbolOutputSchema,
}, async (input) => ({
  content: [{ type: "text", text: result.summary.overview }],
  structuredContent: result,
}));
```

- [ ] **Step 4: Re-run the targeted tests and confirm they pass**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisTools.e2e.test.ts test/capabilitiesAndHealth.test.ts`
Expected: PASS with `analyze_symbol` registered and reporting canonical graph + summary output.

- [ ] **Step 5: Commit**

```bash
git add \
  tree-sitter-mcp/src/analysis/analyzeSymbol.ts \
  tree-sitter-mcp/src/tools/analyzeSymbolTool.ts \
  tree-sitter-mcp/src/server/toolCatalog.ts \
  tree-sitter-mcp/src/server/toolRegistry.ts \
  tree-sitter-mcp/src/tools/getCapabilitiesTool.ts \
  tree-sitter-mcp/src/tools/getHealthTool.ts \
  tree-sitter-mcp/test/analysisTools.e2e.test.ts \
  tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
git commit -m "feat: add analyze_symbol MCP tool"
```

### Task 6: Ship `summarize_module`

**Files:**
- Create: `tree-sitter-mcp/src/analysis/summarizeModule.ts`
- Create: `tree-sitter-mcp/src/tools/summarizeModuleTool.ts`
- Modify: `tree-sitter-mcp/src/server/toolCatalog.ts`
- Modify: `tree-sitter-mcp/src/server/toolRegistry.ts`
- Modify: `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts`
- Modify: `tree-sitter-mcp/src/tools/getHealthTool.ts`
- Modify: `tree-sitter-mcp/test/analysisTools.e2e.test.ts`
- Modify: `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts`

- [ ] **Step 1: Write the failing `summarize_module` tests**

```ts
// tree-sitter-mcp/test/analysisTools.e2e.test.ts
const summarizeModuleResult = await client.callTool({
  name: "summarize_module",
  arguments: {
    target: { workspaceRoot, relativePath: "src/core.ts" },
    dependencyDepth: 1,
  },
});
assert.notEqual(summarizeModuleResult.isError, true);
const summarizeModulePayload = summarizeModuleResult.structuredContent as {
  target: { relativePath: string };
  containedSymbols: Array<{ name: string }>;
  incomingDependencies: Array<{ relativePath: string }>;
  outgoingDependencies: Array<{ relativePath: string }>;
  summary: { overview: string; keyPoints: string[] };
};
assert.equal(summarizeModulePayload.target.relativePath, "src/core.ts");
assert.ok(summarizeModulePayload.containedSymbols.some((symbol) => symbol.name === "helper"));
assert.ok(summarizeModulePayload.summary.overview.length > 0);
```

```ts
// tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
assert.ok(capabilities.toolNames.includes("summarize_module"));
assert.ok(capabilities.supportedQueryTypes.includes("module_summary"));
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisTools.e2e.test.ts test/capabilitiesAndHealth.test.ts`
Expected: FAIL because `summarize_module` is not registered yet.

- [ ] **Step 3: Implement the module summary service and MCP adapter**

```ts
// tree-sitter-mcp/src/analysis/summarizeModule.ts
export async function summarizeModule(
  context: ServerContext,
  request: SummarizeModuleRequest,
): Promise<SummarizeModuleResult> {
  const freshIndex = await context.semanticIndex.getFreshRecords(context);
  const snapshot = buildAnalysisSnapshot(freshIndex.records, { workspaceRoots: request.workspaceRoots });
  const moduleNode = resolveModuleNode(snapshot, request.target);
  return shapeSummarizeModuleResult({ snapshot, moduleNode, freshness: freshIndex.freshness });
}
```

```ts
// tree-sitter-mcp/src/tools/summarizeModuleTool.ts
server.registerTool("summarize_module", {
  title: "Summarize Module",
  description: "Summarize one module's role, entry points, and dependencies.",
  inputSchema: SummarizeModuleRequestSchema,
  outputSchema: SummarizeModuleOutputSchema,
}, async (input) => ({
  content: [{ type: "text", text: result.summary.overview }],
  structuredContent: result,
}));
```

- [ ] **Step 4: Re-run the targeted tests and confirm they pass**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisTools.e2e.test.ts test/capabilitiesAndHealth.test.ts`
Expected: PASS with module summaries returning contained symbols, dependency views, and deterministic summaries.

- [ ] **Step 5: Commit**

```bash
git add \
  tree-sitter-mcp/src/analysis/summarizeModule.ts \
  tree-sitter-mcp/src/tools/summarizeModuleTool.ts \
  tree-sitter-mcp/src/server/toolCatalog.ts \
  tree-sitter-mcp/src/server/toolRegistry.ts \
  tree-sitter-mcp/src/tools/getCapabilitiesTool.ts \
  tree-sitter-mcp/src/tools/getHealthTool.ts \
  tree-sitter-mcp/test/analysisTools.e2e.test.ts \
  tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
git commit -m "feat: add summarize_module MCP tool"
```

### Task 7: Ship `analyze_change_impact`

**Files:**
- Create: `tree-sitter-mcp/src/analysis/analyzeChangeImpact.ts`
- Create: `tree-sitter-mcp/src/tools/analyzeChangeImpactTool.ts`
- Modify: `tree-sitter-mcp/src/server/toolCatalog.ts`
- Modify: `tree-sitter-mcp/src/server/toolRegistry.ts`
- Modify: `tree-sitter-mcp/src/tools/getCapabilitiesTool.ts`
- Modify: `tree-sitter-mcp/src/tools/getHealthTool.ts`
- Modify: `tree-sitter-mcp/test/analysisTools.e2e.test.ts`
- Modify: `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts`

- [ ] **Step 1: Write the failing `analyze_change_impact` tests**

```ts
// tree-sitter-mcp/test/analysisTools.e2e.test.ts
const changeImpactResult = await client.callTool({
  name: "analyze_change_impact",
  arguments: {
    seeds: [
      { type: "symbol", target: { name: "helper", relativePath: "src/core.ts", kind: "function" } },
      { type: "module", target: { workspaceRoot, relativePath: "src/view.tsx" } },
    ],
    maxDepth: 2,
  },
});
assert.notEqual(changeImpactResult.isError, true);
const changeImpactPayload = changeImpactResult.structuredContent as {
  resolvedSeeds: Array<{ type: string }>;
  unresolvedSeeds: Array<{ type: string }>;
  impactedSymbols: Array<{ name: string }>;
  impactedModules: Array<{ relativePath: string }>;
  propagationPaths: Array<{ hopCount: number }>;
  summary: { riskFlags: string[] };
};
assert.equal(changeImpactPayload.resolvedSeeds.length, 2);
assert.ok(changeImpactPayload.impactedModules.some((module) => module.relativePath === "src/core.ts"));
assert.ok(changeImpactPayload.propagationPaths.length > 0);
```

```ts
// tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
assert.ok(capabilities.toolNames.includes("analyze_change_impact"));
assert.ok(capabilities.supportedQueryTypes.includes("change_impact_analysis"));
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisTools.e2e.test.ts test/capabilitiesAndHealth.test.ts`
Expected: FAIL because `analyze_change_impact` is not registered yet.

- [ ] **Step 3: Implement the change-impact service and MCP adapter**

```ts
// tree-sitter-mcp/src/analysis/analyzeChangeImpact.ts
export async function analyzeChangeImpact(
  context: ServerContext,
  request: AnalyzeChangeImpactRequest,
): Promise<AnalyzeChangeImpactResult> {
  const freshIndex = await context.semanticIndex.getFreshRecords(context);
  const snapshot = buildAnalysisSnapshot(freshIndex.records, { workspaceRoots: request.workspaceRoots });
  const resolvedSeeds = resolveImpactSeeds(snapshot, request.seeds);
  const propagationPaths = collectTraversalPaths(snapshot, {
    seedSymbolIds: resolvedSeeds.symbolIds,
    maxDepth: request.maxDepth ?? 2,
  });
  return shapeAnalyzeChangeImpactResult({ snapshot, resolvedSeeds, propagationPaths, freshness: freshIndex.freshness });
}
```

```ts
// tree-sitter-mcp/src/tools/analyzeChangeImpactTool.ts
server.registerTool("analyze_change_impact", {
  title: "Analyze Change Impact",
  description: "Estimate symbol and module impact for hypothetical symbol/file changes.",
  inputSchema: AnalyzeChangeImpactRequestSchema,
  outputSchema: AnalyzeChangeImpactOutputSchema,
}, async (input) => ({
  content: [{ type: "text", text: result.summary.overview }],
  structuredContent: result,
}));
```

- [ ] **Step 4: Re-run the targeted tests and confirm they pass**

Run: `cd tree-sitter-mcp && npx tsx --test test/analysisTools.e2e.test.ts test/capabilitiesAndHealth.test.ts`
Expected: PASS with mixed symbol/module seeds, partial-resolution handling, and propagation paths returned.

- [ ] **Step 5: Commit**

```bash
git add \
  tree-sitter-mcp/src/analysis/analyzeChangeImpact.ts \
  tree-sitter-mcp/src/tools/analyzeChangeImpactTool.ts \
  tree-sitter-mcp/src/server/toolCatalog.ts \
  tree-sitter-mcp/src/server/toolRegistry.ts \
  tree-sitter-mcp/src/tools/getCapabilitiesTool.ts \
  tree-sitter-mcp/src/tools/getHealthTool.ts \
  tree-sitter-mcp/test/analysisTools.e2e.test.ts \
  tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
git commit -m "feat: add analyze_change_impact MCP tool"
```

### Task 8: Update docs and run full verification

**Files:**
- Modify: `tree-sitter-mcp/README.md`
- Modify: `tree-sitter-mcp/test/contractAlignment.test.ts`
- Modify: `tree-sitter-mcp/test/capabilitiesAndHealth.test.ts`
- Modify: `tree-sitter-mcp/test/semanticTools.e2e.test.ts`

- [ ] **Step 1: Write the failing final metadata assertions**

```ts
// tree-sitter-mcp/test/contractAlignment.test.ts
assert.ok(listRegisteredToolNames().includes("analyze_symbol"));
assert.ok(listRegisteredToolNames().includes("summarize_module"));
assert.ok(listRegisteredToolNames().includes("analyze_change_impact"));
```

```ts
// tree-sitter-mcp/test/capabilitiesAndHealth.test.ts
assert.ok(capabilities.supportedQueryTypes.includes("symbol_analysis"));
assert.ok(capabilities.supportedQueryTypes.includes("module_summary"));
assert.ok(capabilities.supportedQueryTypes.includes("change_impact_analysis"));
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `cd tree-sitter-mcp && npx tsx --test test/contractAlignment.test.ts test/capabilitiesAndHealth.test.ts test/semanticTools.e2e.test.ts`
Expected: FAIL until the final tool catalog, query type reporting, and docs are all updated for the new analysis surface.

- [ ] **Step 3: Update docs and any remaining metadata**

```ts
// tree-sitter-mcp/src/tools/getCapabilitiesTool.ts
const supportedQueryTypes = [...new Set([
  ...context.queryTypes,
  ...listDefinitionQueryTypes(),
  ...listReferenceQueryTypes(),
  ...listRelationshipQueryTypes(),
  ...listAnalysisQueryTypes(),
])];
```

```md
## Tool surface
- `analyze_symbol` - inspect a symbol's role, neighbors, and likely impact paths
- `summarize_module` - summarize one module's responsibilities, entry points, and dependencies
- `analyze_change_impact` - estimate symbol/module impact for hypothetical changes
```

- [ ] **Step 4: Run full verification**

Run: `cd tree-sitter-mcp && npm test`
Expected: PASS with build + all unit/E2E tests green.

- [ ] **Step 5: Commit**

```bash
git add \
  tree-sitter-mcp/README.md \
  tree-sitter-mcp/test/contractAlignment.test.ts \
  tree-sitter-mcp/test/capabilitiesAndHealth.test.ts \
  tree-sitter-mcp/test/semanticTools.e2e.test.ts
git commit -m "docs: document analysis tools and final metadata"
```

## Final Verification Checklist

- [ ] `cd tree-sitter-mcp && npm run build`
- [ ] `cd tree-sitter-mcp && npx tsx --test test/contractAlignment.test.ts`
- [ ] `cd tree-sitter-mcp && npx tsx --test test/analysisSnapshot.test.ts test/analysisSummary.test.ts`
- [ ] `cd tree-sitter-mcp && npx tsx --test test/analysisTools.e2e.test.ts`
- [ ] `cd tree-sitter-mcp && npm test`
- [ ] Confirm `get_capabilities` and `get_health` report the same tool names and include the new analysis query types.
- [ ] Confirm `get_relationship_view` returns `target` and no longer returns `seed`.
- [ ] Confirm `search_references` accepts `offset` and `includeContext` through its published schema.
- [ ] Confirm `analyze_change_impact` handles mixed symbol/module seeds and surfaces unresolved seeds without dropping resolved results.

## Implementation Handoff Notes

- Prefer adding small, focused helpers rather than expanding the existing tool files with analysis logic.
- Keep summary derivation deterministic and testable; do not embed model-generated language into the server.
- When in doubt, favor explicit diagnostics over silent omission.
- If a new contract question appears during implementation, update the canonical schema first, then the handler, then the regression test.
