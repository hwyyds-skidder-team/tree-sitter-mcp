import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { normalizeDefinitionMatch } from "../src/definitions/normalizeDefinitionMatch.js";
import { searchDefinitions } from "../src/definitions/searchDefinitions.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverWorkspaceFiles } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createDefinitionWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-definition-normalization-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export function greet(name: string): string {",
    "  return name;",
    "}",
    "class Greeter {",
    "  sayHello(): string { return 'hi'; }",
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

test("normalizeDefinitionMatch standardizes path separators, case, snippet text, and selection ranges", () => {
  const normalized = normalizeDefinitionMatch({
    name: "greet",
    kind: "function",
    languageId: "TypeScript",
    filePath: path.join("tmp", "repo", "src", "app.ts"),
    relativePath: ".\\src\\app.ts",
    range: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 3, column: 2, offset: 32 },
    },
    selectionRange: {
      start: { line: 10, column: 1, offset: 500 },
      end: { line: 10, column: 6, offset: 505 },
    },
    containerName: "  Greeter  ",
    snippet: "  export   function   greet() {}\n",
  });

  assert.equal(normalized.languageId, "typescript");
  assert.equal(normalized.relativePath, "src/app.ts");
  assert.equal(normalized.containerName, "Greeter");
  assert.equal(normalized.snippet, "export function greet() {}");
  assert.deepEqual(normalized.selectionRange, normalized.range);
});

test("searchDefinitions returns normalized cross-language metadata with stable ranges", async () => {
  const workspaceRoot = await createDefinitionWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await searchDefinitions(context, {
    query: "e",
    symbolKinds: ["function", "method", "class"],
  });

  const summaries = result.results.map((definition) => `${definition.languageId}:${definition.kind}:${definition.relativePath}:${definition.name}:${definition.containerName ?? "-"}`);
  assert.ok(summaries.includes("python:method:scripts/tool.py:execute:Runner"));
  assert.ok(summaries.includes("typescript:function:src/app.ts:greet:-"));
  assert.ok(summaries.includes("typescript:class:src/app.ts:Greeter:-"));

  for (const definition of result.results) {
    assert.ok(definition.range.start.line >= 1);
    assert.ok(definition.range.start.column >= 1);
    assert.ok(definition.selectionRange.start.offset >= definition.range.start.offset);
    assert.ok(definition.selectionRange.end.offset <= definition.range.end.offset);
    assert.equal(definition.relativePath.includes("\\"), false);
    assert.equal(definition.languageId, definition.languageId.toLowerCase());
  }
});
