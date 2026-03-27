import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { getDependencyAnalysis } from "../src/dependencies/getDependencyAnalysis.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverConfiguredWorkspaces } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createDependencyWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-dependency-analysis-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "graph.ts"), [
    "export function sharedTarget(name: string): string {",
    "  return name.trim();",
    "}",
    "",
    "export function finalTarget(name: string): string {",
    "  return sharedTarget(name).toUpperCase();",
    "}",
    "",
    "export function stageTwo(name: string): string {",
    "  return finalTarget(name);",
    "}",
    "",
    "export function shortBridge(name: string): string {",
    "  return sharedTarget(name) + stageTwo(name);",
    "}",
    "",
    "export function midBridge(name: string): string {",
    "  return sharedTarget(name);",
    "}",
    "",
    "export function longBridge(name: string): string {",
    "  return midBridge(name);",
    "}",
    "",
    "export function cycleB(name: string): string {",
    "  return sharedTarget(name);",
    "}",
    "",
    "export function cycleA(name: string): string {",
    "  return cycleB(name);",
    "}",
    "",
    "export function refSink(name: string): string {",
    "  return name.toLowerCase();",
    "}",
    "",
    "export function start(name: string): string {",
    "  const keepReference = refSink;",
    "  return shortBridge(name) + longBridge(name) + cycleA(name) + keepReference(name);",
    "}",
    "",
    "export function caller(name: string): string {",
    "  return start(name);",
    "}",
    "",
    "export function upstream(name: string): string {",
    "  return caller(name);",
    "}",
    "",
  ].join("\n"));

  return workspaceRoot;
}

async function createPreparedContext(workspaceRoot: string) {
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-dependency-index-"));
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

test("getDependencyAnalysis uses maxDepth to include third-hop dependencies only when requested", async () => {
  const workspaceRoot = await createDependencyWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const shallow = await getDependencyAnalysis(context, {
    lookup: {
      name: "start",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 1,
  });
  const deep = await getDependencyAnalysis(context, {
    lookup: {
      name: "start",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 3,
  });

  assert.equal(shallow.results.some((result) => result.symbol.name === "finalTarget"), false);
  const thirdHop = deep.results.find((result) => result.symbol.name === "finalTarget");
  assert.ok(thirdHop);
  assert.equal(thirdHop?.depth, 3);
  assert.equal(thirdHop?.path.length, 3);
});

test("getDependencyAnalysis keeps one canonical shortest path when a target is reachable by multiple routes", async () => {
  const workspaceRoot = await createDependencyWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await getDependencyAnalysis(context, {
    lookup: {
      name: "start",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 3,
  });

  const sharedTarget = result.results.find((entry) => entry.symbol.name === "sharedTarget");
  assert.ok(sharedTarget);
  assert.equal(sharedTarget?.depth, 2);
  assert.equal(sharedTarget?.path.length, 2);
  assert.equal(sharedTarget?.path[0]?.toSymbol.name, "shortBridge");
  assert.equal(sharedTarget?.path[1]?.toSymbol.name, "sharedTarget");
});

test("getDependencyAnalysis preserves workspace attribution and relationshipKind metadata in every path step", async () => {
  const workspaceRoot = await createDependencyWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await getDependencyAnalysis(context, {
    lookup: {
      name: "start",
      languageId: "typescript",
      workspaceRoot,
      kind: "function",
    },
    maxDepth: 3,
  });

  assert.equal(result.diagnostic, null);
  assert.ok(result.results.some((entry) => entry.direction === "incoming"));
  assert.ok(result.results.some((entry) => entry.direction === "outgoing"));

  for (const entry of result.results) {
    for (const step of entry.path) {
      assert.equal(step.fromSymbol.workspaceRoot, workspaceRoot);
      assert.equal(step.toSymbol.workspaceRoot, workspaceRoot);
      assert.equal(step.evidence.workspaceRoot, workspaceRoot);
      assert.ok(step.fromSymbol.relativePath.length > 0);
      assert.ok(step.toSymbol.relativePath.length > 0);
      assert.ok(step.relationshipKind.length > 0);
    }
  }
});
