import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { searchDefinitions } from "../src/definitions/searchDefinitions.js";
import { searchReferences } from "../src/references/searchReferences.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverWorkspaceFiles } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createPreparedContext(workspaceRoot: string, indexRootDir: string) {
  const context = createServerContext(loadRuntimeConfig({
    ...process.env,
    TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
  }));
  const discovery = await discoverWorkspaceFiles(
    workspaceRoot,
    context.config.defaultExclusions,
    context.languageRegistry,
  );

  applyWorkspaceSnapshot(context.workspace, {
    root: workspaceRoot,
    exclusions: context.config.defaultExclusions,
    searchableFiles: discovery.searchableFiles,
    unsupportedFiles: discovery.unsupportedFiles,
  });
  context.semanticIndex.replaceWorkspace({
    root: workspaceRoot,
    exclusions: context.config.defaultExclusions,
  });
  await context.semanticIndex.ensureReady(context);

  return context;
}

async function readPersistedRecords(indexRootDir: string, workspaceFingerprint: string) {
  const recordsPath = path.join(indexRootDir, workspaceFingerprint, "records.json");
  const records = JSON.parse(await fs.readFile(recordsPath, "utf8")) as Array<{
    relativePath: string;
    contentHash: string;
    definitions: Array<{ name: string }>;
  }>;

  return {
    recordsPath,
    records,
  };
}

test("indexed definition search reuses cached records until a changed file is refreshed", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-index-refresh-"));
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-index-store-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export function greet(name: string): string {",
    "  return name;",
    "}",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(workspaceRoot, "src", "helper.ts"), [
    "export function helperName(): string {",
    "  return 'helper';",
    "}",
    "",
  ].join("\n"));

  const context = await createPreparedContext(workspaceRoot, indexRootDir);
  const workspaceFingerprint = context.workspace.index.workspaceFingerprint;
  assert.ok(workspaceFingerprint);

  const firstResult = await searchDefinitions(context, {
    query: "greet",
    language: "typescript",
  });
  assert.deepEqual(firstResult.results.map((result) => result.relativePath), ["src/app.ts"]);

  const beforeRepeated = await readPersistedRecords(indexRootDir, workspaceFingerprint ?? "");
  const repeatedResult = await searchDefinitions(context, {
    query: "greet",
    language: "typescript",
  });
  const afterRepeated = await readPersistedRecords(indexRootDir, workspaceFingerprint ?? "");

  assert.deepEqual(repeatedResult.results.map((result) => result.relativePath), ["src/app.ts"]);
  assert.deepEqual(afterRepeated.records, beforeRepeated.records);
  assert.equal(context.workspace.index.lastRefreshedAt, null);

  await fs.writeFile(path.join(workspaceRoot, "src", "helper.ts"), [
    "export function refreshedHelper(): string {",
    "  return 'refreshed';",
    "}",
    "",
  ].join("\n"));

  const refreshedResult = await searchDefinitions(context, {
    query: "refreshed",
    language: "typescript",
  });
  const afterRefresh = await readPersistedRecords(indexRootDir, workspaceFingerprint ?? "");
  const beforeByPath = new Map(beforeRepeated.records.map((record) => [record.relativePath, record]));
  const afterByPath = new Map(afterRefresh.records.map((record) => [record.relativePath, record]));

  assert.deepEqual(refreshedResult.results.map((result) => result.relativePath), ["src/helper.ts"]);
  assert.notEqual(
    afterByPath.get("src/helper.ts")?.contentHash,
    beforeByPath.get("src/helper.ts")?.contentHash,
  );
  assert.deepEqual(afterByPath.get("src/app.ts"), beforeByPath.get("src/app.ts"));
  assert.equal(context.workspace.index.state, "refreshed");
  assert.ok(context.workspace.index.lastRefreshedAt);
});

test("degraded refresh drops stale definitions and references for a broken changed file", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-index-degraded-"));
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-index-store-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export function greetUser(name: string): string {",
    "  return name;",
    "}",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(workspaceRoot, "src", "use.ts"), [
    "import { greetUser } from './app';",
    "export function run(): string {",
    "  return greetUser('ok');",
    "}",
    "",
  ].join("\n"));

  const context = await createPreparedContext(workspaceRoot, indexRootDir);

  const initialDefinitions = await searchDefinitions(context, {
    query: "greetUser",
    language: "typescript",
  });
  assert.deepEqual(initialDefinitions.results.map((result) => result.relativePath), ["src/app.ts"]);

  const initialReferences = await searchReferences(context, {
    lookup: {
      name: "greetUser",
      languageId: "typescript",
      kind: "function",
    },
  });
  assert.deepEqual(
    initialReferences.results.map((result) => `${result.relativePath}:${result.referenceKind}`),
    [
      "src/use.ts:call",
      "src/use.ts:reference",
    ],
  );

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), "export function greetUser( {\n");

  const degradedDefinitions = await searchDefinitions(context, {
    query: "greetUser",
    language: "typescript",
  });
  assert.equal(degradedDefinitions.results.length, 0);
  assert.ok(degradedDefinitions.diagnostics.some((diagnostic) =>
    diagnostic.code === "parse_failed" && diagnostic.relativePath === "src/app.ts"));

  const degradedReferences = await searchReferences(context, {
    lookup: {
      name: "greetUser",
      languageId: "typescript",
      kind: "function",
    },
  });
  assert.equal(degradedReferences.target, null);
  assert.equal(degradedReferences.diagnostic?.code, "definition_not_found");
  assert.ok(degradedReferences.diagnostics.some((diagnostic) =>
    diagnostic.code === "parse_failed" && diagnostic.relativePath === "src/app.ts"));
  assert.equal(context.workspace.index.state, "degraded");
});
