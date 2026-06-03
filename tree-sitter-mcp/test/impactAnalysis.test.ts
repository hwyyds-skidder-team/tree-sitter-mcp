import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { analyzeImpact } from "../src/impact/impactAnalysis.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverConfiguredWorkspaces } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createImpactWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-impact-analysis-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "core.ts"), [
    "export function baseValidator(name: string): string {",
    "  return name.trim();",
    "}",
    "",
    "export function formatOutput(name: string): string {",
    "  return baseValidator(name).toUpperCase();",
    "}",
    "",
    "export function computeResult(name: string): string {",
    "  const validated = baseValidator(name);",
    "  return formatOutput(validated);",
    "}",
    "",
    "export function processInput(name: string): string {",
    "  return computeResult(name);",
    "}",
    "",
    "export function externalBridge(name: string): string {",
    "  const formatter = formatOutput;",
    "  const validator = baseValidator;",
    "  return formatter(validator(name));",
    "}",
    "",
    "export function deepChain1(name: string): string {",
    "  return processInput(name);",
    "}",
    "",
    "export function deepChain2(name: string): string {",
    "  return deepChain1(name);",
    "}",
    "",
    "export function isolatedFunction(name: string): string {",
    "  return name.toLowerCase();",
    "}",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "consumers.ts"), [
    "import { baseValidator, formatOutput, computeResult, isolatedFunction } from './core';",
    "",
    "export function topLevelCaller(name: string): string {",
    "  return formatOutput(name);",
    "}",
    "",
    "export function midLevelCaller(name: string): string {",
    "  const result = topLevelCaller(name);",
    "  return result + '_suffix';",
    "}",
    "",
    "export function referenceOnly(name: string): string {",
    "  const ref = formatOutput;",
    "  return ref(name);",
    "}",
    "",
    "export function multiDependency(name: string): string {",
    "  const a = baseValidator(name);",
    "  const b = computeResult(name);",
    "  return a + b;",
    "}",
    "",
    "export function callsIsolated(name: string): string {",
    "  return isolatedFunction(name);",
    "}",
    "",
  ].join("\n"));

  return workspaceRoot;
}

async function createPreparedContext(workspaceRoot: string) {
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-impact-index-"));
  const context = createServerContext(loadRuntimeConfig({
    ...process.env,
    TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
  }));
  const discovery = await discoverConfiguredWorkspaces(
    [workspaceRoot],
    context.config.defaultExclusions,
    context.languageRegistry,
  );

  applyWorkspaceSnapshot(context.workspace, {
    root: workspaceRoot,
    roots: [workspaceRoot],
    workspaces: discovery.workspaces.map((workspace) => ({
      root: workspace.root,
      exclusions: context.config.defaultExclusions,
      searchableFileCount: workspace.searchableFiles.length,
      unsupportedFileCount: workspace.unsupportedFiles.length,
    })),
    exclusions: context.config.defaultExclusions,
    searchableFiles: discovery.searchableFiles,
    unsupportedFiles: discovery.unsupportedFiles,
  });
  context.semanticIndex.replaceWorkspaces([
    {
      root: workspaceRoot,
      exclusions: context.config.defaultExclusions,
    },
  ]);
  await context.semanticIndex.ensureReady(context);

  return context;
}

test("analyzeImpact returns prioritized targets with critical outgoing callees first", async () => {
  const workspaceRoot = await createImpactWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await analyzeImpact(context, {
    lookup: {
      name: "computeResult",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 2,
  });

  assert.ok(result.seed);
  assert.equal(result.seed?.name, "computeResult");
  assert.ok(result.targets.length > 0);

  // Direct outgoing callees should be critical
  const criticalTargets = result.targets.filter((t) => t.severity === "critical");
  assert.ok(criticalTargets.length > 0, "Should have at least one critical target");
  assert.ok(criticalTargets.every((t) => t.direction === "outgoing" && t.depth === 1));
  assert.ok(criticalTargets.some((t) => t.symbol.name === "baseValidator"));
  assert.ok(criticalTargets.some((t) => t.symbol.name === "formatOutput"));

  // Direct incoming callers should be high severity
  const highTargets = result.targets.filter((t) => t.severity === "high");
  assert.ok(highTargets.length > 0, "Should have at least one high-severity target");
  assert.ok(highTargets.some((t) => t.symbol.name === "processInput"));

  // Each target should have confidence, severity, and reason
  for (const target of result.targets) {
    assert.ok(["high", "medium", "low"].includes(target.confidence));
    assert.ok(["critical", "high", "medium", "low"].includes(target.severity));
    assert.ok(target.reason.length > 0);
    assert.ok(target.path.length > 0);
  }
});

test("analyzeImpact assigns high confidence to direct call relationships", async () => {
  const workspaceRoot = await createImpactWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await analyzeImpact(context, {
    lookup: {
      name: "baseValidator",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 2,
  });

  // Direct callers of baseValidator should have high confidence
  const directTargets = result.targets.filter((t) => t.depth === 1);
  for (const target of directTargets) {
    const isCall = target.relationshipKind === "incoming_call" || target.relationshipKind === "outgoing_call";
    if (isCall) {
      assert.equal(target.confidence, "high", `${target.symbol.name} (depth 1 call) should have high confidence`);
    }
  }

  // Depth 2 targets should have at most medium confidence
  const deepTargets = result.targets.filter((t) => t.depth >= 2);
  assert.ok(deepTargets.every((t) => t.confidence !== "high"));
});

test("analyzeImpact generates reasoned blast radius summary", async () => {
  const workspaceRoot = await createImpactWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await analyzeImpact(context, {
    lookup: {
      name: "computeResult",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 2,
  });

  assert.ok(result.blastRadius.summary.length > 0);
  assert.ok(result.blastRadius.summary.includes("critical"));
  assert.ok(result.blastRadius.summary.includes("file"));
  assert.equal(result.blastRadius.totalTargets, result.targets.length);
  assert.equal(
    result.blastRadius.criticalCount + result.blastRadius.highCount
    + result.blastRadius.mediumCount + result.blastRadius.lowCount,
    result.targets.length,
  );

  // Should have affected files categorized by severity
  assert.ok(result.blastRadius.affectedFiles.length > 0);
  assert.ok(result.blastRadius.affectedFiles.every((f) => f.targetCount > 0));
});

test("analyzeImpact sorts by priority: severity then confidence then direction then depth", async () => {
  const workspaceRoot = await createImpactWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await analyzeImpact(context, {
    lookup: {
      name: "computeResult",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 3,
  });

  // Verify sort order: critical before high before medium before low
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  for (let i = 1; i < result.targets.length; i++) {
    const prev = result.targets[i - 1];
    const curr = result.targets[i];
    const prevSev = severityOrder[prev.severity] ?? 99;
    const currSev = severityOrder[curr.severity] ?? 99;
    assert.ok(prevSev <= currSev, `Target #${i} (${curr.symbol.name}, ${curr.severity}) should not come before #${i - 1} (${prev.symbol.name}, ${prev.severity})`);
  }
});

test("analyzeImpact handles isolated symbols with no connections", async () => {
  const workspaceRoot = await createImpactWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await analyzeImpact(context, {
    lookup: {
      name: "isolatedFunction",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 2,
  });

  assert.ok(result.seed);
  // isolatedFunction is called by callsIsolated in consumers.ts,
  // so it DOES have one incoming relationship — verify the blast radius works
  assert.ok(result.targets.length >= 1);
  assert.ok(result.blastRadius.summary.length > 0);
  assert.ok(result.blastRadius.affectedFiles.length > 0);
});

test("analyzeImpact paginates results", async () => {
  const workspaceRoot = await createImpactWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const fullResult = await analyzeImpact(context, {
    lookup: {
      name: "computeResult",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 3,
    limit: 200,
  });

  if (fullResult.targets.length < 3) {
    // Not enough targets to paginate meaningfully, skip
    return;
  }

  const page1 = await analyzeImpact(context, {
    lookup: {
      name: "computeResult",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 3,
    limit: 2,
    offset: 0,
  });

  assert.equal(page1.targets.length, 2);
  assert.equal(page1.pagination.hasMore, true);
  assert.equal(page1.pagination.nextOffset, 2);

  const page2 = await analyzeImpact(context, {
    lookup: {
      name: "computeResult",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 3,
    limit: 2,
    offset: 2,
  });

  assert.equal(page2.targets.length, 2);
  // Pages should not overlap
  const page1Names = new Set(page1.targets.map((t) => `${t.symbol.relativePath}:${t.symbol.name}`));
  const page2Names = new Set(page2.targets.map((t) => `${t.symbol.relativePath}:${t.symbol.name}`));
  for (const name of page1Names) {
    assert.ok(!page2Names.has(name), `${name} appears in both pages`);
  }
});

test("analyzeImpact filters by relationshipKinds", async () => {
  const workspaceRoot = await createImpactWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const callsOnlyResult = await analyzeImpact(context, {
    lookup: {
      name: "externalBridge",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 2,
    relationshipKinds: ["outgoing_call", "incoming_call"],
  });

  for (const target of callsOnlyResult.targets) {
    assert.ok(
      target.relationshipKind === "outgoing_call" || target.relationshipKind === "incoming_call",
      `${target.symbol.name} should only have call relationship kind, got ${target.relationshipKind}`,
    );
  }
});
