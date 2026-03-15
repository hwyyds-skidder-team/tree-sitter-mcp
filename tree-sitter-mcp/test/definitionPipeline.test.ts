import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { collectFileDefinitions } from "../src/definitions/definitionPipeline.js";
import { searchDefinitions } from "../src/definitions/searchDefinitions.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverWorkspaceFiles } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createDefinitionWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-definitions-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "lib"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export interface Person { name: string }",
    "export function greet(name: string): string {",
    "  return name;",
    "}",
    "class Greeter {",
    "  sayHello(): string { return 'hi'; }",
    "}",
    "const helper = (): number => 1;",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "panel.tsx"), [
    "export function Panel(): JSX.Element {",
    "  return <section />;",
    "}",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "lib", "util.js"), [
    "function makeCounter() {",
    "  return 0;",
    "}",
    "const buildLabel = function buildLabel() {",
    "  return 'label';",
    "};",
    "class Helper {",
    "  run() {}",
    "}",
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
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "broken.ts"), "export function broken( {\n");

  return workspaceRoot;
}

async function createPreparedContext(workspaceRoot: string) {
  const context = createServerContext(loadRuntimeConfig());
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

  return context;
}

test("collectFileDefinitions extracts definitions across builtin languages with exact ranges", async () => {
  const workspaceRoot = await createDefinitionWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const fileResults = await Promise.all(context.workspace.searchableFiles
    .filter((file) => ["src/app.ts", "src/panel.tsx", "lib/util.js", "scripts/tool.py"].includes(file.relativePath))
    .map((file) => collectFileDefinitions(context, file)));

  const definitions = fileResults.flatMap((result) => result.definitions.map((definition) => `${definition.relativePath}:${definition.kind}:${definition.name}`));
  assert.deepEqual(definitions.sort(), [
    "lib/util.js:class:Helper",
    "lib/util.js:function:makeCounter",
    "lib/util.js:method:run",
    "lib/util.js:variable:buildLabel",
    "scripts/tool.py:class:Runner",
    "scripts/tool.py:function:greet_python",
    "scripts/tool.py:method:execute",
    "src/app.ts:class:Greeter",
    "src/app.ts:function:greet",
    "src/app.ts:interface:Person",
    "src/app.ts:method:sayHello",
    "src/app.ts:variable:helper",
    "src/panel.tsx:function:Panel",
  ].sort());

  for (const definition of fileResults.flatMap((result) => result.definitions)) {
    assert.ok(definition.range.start.line >= 1);
    assert.ok(definition.range.start.column >= 1);
    assert.ok(definition.selectionRange.start.offset >= definition.range.start.offset);
  }
});

test("searchDefinitions finds definitions on demand and reports parse diagnostics", async () => {
  const workspaceRoot = await createDefinitionWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await searchDefinitions(context, {
    query: "greet",
  });

  assert.deepEqual(result.results.map((definition) => `${definition.relativePath}:${definition.name}`), [
    "src/app.ts:greet",
    "src/app.ts:Greeter",
    "scripts/tool.py:greet_python",
  ]);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "parse_failed" && diagnostic.relativePath === "src/broken.ts"));
  assert.equal(result.searchedFiles, context.workspace.searchableFiles.length);
});

test("searchDefinitions uses the workspace snapshot rather than recrawling the filesystem", async () => {
  const workspaceRoot = await createDefinitionWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  await fs.writeFile(path.join(workspaceRoot, "src", "late.ts"), "export function lateDefinition() { return 1; }\n");

  const result = await searchDefinitions(context, {
    query: "lateDefinition",
  });

  assert.equal(result.results.length, 0);
  assert.equal(result.searchedFiles, context.workspace.searchableFiles.length);
});
