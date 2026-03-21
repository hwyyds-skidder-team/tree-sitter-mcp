import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { searchReferences } from "../src/references/searchReferences.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverConfiguredWorkspaces } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createReferenceWorkspaceFixture(label = "primary"): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `tree-sitter-mcp-reference-search-${label}-`));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export function greetUser(name: string): string {",
    `  return '${label}:' + name;`,
    "}",
    "export function lonely(): string {",
    "  return 'solo';",
    "}",
    "class Greeter {",
    "  sayHello(): string {",
    "    return greetUser('hi');",
    "  }",
    "}",
    "const greeter = new Greeter();",
    "greeter.sayHello();",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "view.tsx"), [
    "import { greetUser } from './app';",
    "export function Panel(): JSX.Element {",
    "  return <button onClick={() => greetUser('tsx')}>Run</button>;",
    "}",
    "render(greetUser);",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "scripts", "tool.py"), [
    "class Runner:",
    "    def execute(self):",
    "        return 1",
    "",
    "def greet_python(name):",
    "    return name",
    "",
    "def use():",
    "    greet_python('hi')",
    "    runner = Runner()",
    "    runner.execute()",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "broken.ts"), "export function broken( {\n");

  return workspaceRoot;
}

async function createPreparedContext(workspaceRoots: string | string[]) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [workspaceRoots];
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-reference-index-"));
  const context = createServerContext(loadRuntimeConfig({
    ...process.env,
    TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
  }));
  const discovery = await discoverConfiguredWorkspaces(
    roots,
    context.config.defaultExclusions,
    context.languageRegistry,
  );

  applyWorkspaceSnapshot(context.workspace, {
    root: roots[0] ?? null,
    roots,
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
  context.semanticIndex.replaceWorkspaces(
    roots.map((root) => ({
      root,
      exclusions: context.config.defaultExclusions,
    })),
  );
  await context.semanticIndex.ensureReady(context);

  return context;
}

test("searchReferences resolves a symbol target and finds workspace-wide usages with parse diagnostics", async () => {
  const workspaceRoot = await createReferenceWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await searchReferences(context, {
    lookup: {
      name: "greetUser",
      languageId: "typescript",
      kind: "function",
    },
  });

  assert.equal(result.diagnostic, null);
  assert.equal(result.target?.name, "greetUser");
  assert.deepEqual(result.results.map((reference) => `${reference.relativePath}:${reference.referenceKind}`).sort(), [
    "src/app.ts:call",
    "src/view.tsx:call",
    "src/view.tsx:reference",
    "src/view.tsx:reference",
  ].sort());
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "parse_failed" && diagnostic.relativePath === "src/broken.ts"));
  assert.equal(result.searchedFiles, 3);
});

test("searchReferences narrows multi-workspace results by workspaceRoots, language, and pathPrefix while preserving omitted-filter breadth", async () => {
  const primaryRoot = await createReferenceWorkspaceFixture("primary");
  const secondaryRoot = await createReferenceWorkspaceFixture("secondary");
  const context = await createPreparedContext([primaryRoot, secondaryRoot]);

  const baseline = await searchReferences(context, {
    lookup: {
      name: "greetUser",
      languageId: "typescript",
      workspaceRoot: primaryRoot,
      kind: "function",
    },
  });

  assert.equal(baseline.diagnostic, null);
  assert.ok(baseline.results.some((reference) => reference.workspaceRoot === primaryRoot));
  assert.ok(baseline.results.some((reference) => reference.workspaceRoot === secondaryRoot));

  const filtered = await searchReferences(context, {
    lookup: {
      name: "greetUser",
      languageId: "typescript",
      workspaceRoot: primaryRoot,
      kind: "function",
    },
    workspaceRoots: [primaryRoot],
    language: "tsx",
    pathPrefix: ".\\src\\view.tsx",
  });

  assert.equal(filtered.diagnostic, null);
  assert.equal(filtered.searchedFiles, 1);
  assert.ok(baseline.results.length > filtered.results.length);
  assert.deepEqual(
    filtered.results.map((reference) => `${reference.workspaceRoot}:${reference.relativePath}:${reference.referenceKind}`).sort(),
    [
      `${primaryRoot}:src/view.tsx:call`,
      `${primaryRoot}:src/view.tsx:reference`,
      `${primaryRoot}:src/view.tsx:reference`,
    ].sort(),
  );
});

test("searchReferences supports a discovered symbol descriptor and call-site lookup", async () => {
  const workspaceRoot = await createReferenceWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await searchReferences(context, {
    symbol: {
      name: "sayHello",
      languageId: "typescript",
      relativePath: "src/app.ts",
      kind: "method",
    },
  });

  assert.equal(result.diagnostic, null);
  assert.equal(result.target?.name, "sayHello");
  assert.deepEqual(result.results.map((reference) => `${reference.relativePath}:${reference.referenceKind}:${reference.name}`), [
    "src/app.ts:call:sayHello",
  ]);
});

test("searchReferences returns a structured diagnostic when the target cannot be resolved or has no usages", async () => {
  const workspaceRoot = await createReferenceWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const missingTarget = await searchReferences(context, {
    lookup: {
      name: "missing_symbol",
    },
  });

  assert.equal(missingTarget.target, null);
  assert.equal(missingTarget.diagnostic?.code, "definition_not_found");

  const noUsages = await searchReferences(context, {
    lookup: {
      name: "lonely",
      languageId: "typescript",
      kind: "function",
    },
  });

  assert.equal(noUsages.target?.name, "lonely");
  assert.equal(noUsages.results.length, 0);
  assert.equal(noUsages.diagnostic?.code, "reference_not_found");
});

test("searchReferences refreshes the workspace snapshot and picks up newly added files", async () => {
  const workspaceRoot = await createReferenceWorkspaceFixture();
  await fs.rm(path.join(workspaceRoot, "src", "broken.ts"));
  const context = await createPreparedContext(workspaceRoot);

  await fs.writeFile(path.join(workspaceRoot, "src", "late.ts"), [
    "import { greetUser } from './app';",
    "greetUser('late');",
    "",
  ].join("\n"));

  const result = await searchReferences(context, {
    lookup: {
      name: "greetUser",
      languageId: "typescript",
      kind: "function",
    },
  });

  assert.ok(result.results.some((reference) => reference.relativePath === "src/late.ts"));
  assert.deepEqual(result.results.map((reference) => `${reference.relativePath}:${reference.referenceKind}`).sort(), [
    "src/app.ts:call",
    "src/late.ts:call",
    "src/late.ts:reference",
    "src/view.tsx:call",
    "src/view.tsx:reference",
    "src/view.tsx:reference",
  ].sort());
  assert.equal(result.searchedFiles, 3);
  assert.equal(context.workspace.index.state, "refreshed");
});

test("searchReferences excludes degraded stale references after a changed file breaks", async () => {
  const workspaceRoot = await createReferenceWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const initialResult = await searchReferences(context, {
    lookup: {
      name: "greetUser",
      languageId: "typescript",
      kind: "function",
    },
  });
  assert.ok(initialResult.results.some((reference) => reference.relativePath === "src/view.tsx"));

  await fs.writeFile(path.join(workspaceRoot, "src", "view.tsx"), "export function Panel( {\n");

  const degradedResult = await searchReferences(context, {
    lookup: {
      name: "greetUser",
      languageId: "typescript",
      kind: "function",
    },
  });

  assert.equal(degradedResult.diagnostic, null);
  assert.deepEqual(degradedResult.results.map((reference) => `${reference.relativePath}:${reference.referenceKind}`), [
    "src/app.ts:call",
  ]);
  assert.ok(degradedResult.diagnostics.some((diagnostic) =>
    diagnostic.code === "parse_failed" && diagnostic.relativePath === "src/view.tsx"));
  assert.equal(context.workspace.index.state, "degraded");
});
