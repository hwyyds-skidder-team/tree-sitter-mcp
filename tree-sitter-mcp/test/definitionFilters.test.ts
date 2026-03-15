import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { normalizeDefinitionFilters } from "../src/definitions/definitionFilters.js";
import { resolveDefinition } from "../src/definitions/resolveDefinition.js";
import { searchDefinitions } from "../src/definitions/searchDefinitions.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverWorkspaceFiles } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createDefinitionWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-definition-filters-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export function greet(name: string): string {",
    "  return name;",
    "}",
    "const helper = (): number => 1;",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "secondary.ts"), [
    "export function greet(): string {",
    "  return 'secondary';",
    "}",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "scripts", "tool.py"), [
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

test("normalizeDefinitionFilters normalizes separators, deduplicates symbol kinds, and lowercases languages", async () => {
  const context = createServerContext(loadRuntimeConfig());
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-filters-normalize-"));
  await fs.mkdir(path.join(workspaceRoot, "src", "nested"), { recursive: true });

  const result = normalizeDefinitionFilters({
    workspaceRoot,
    languageRegistry: context.languageRegistry,
    input: {
      language: "TypeScript",
      pathPrefix: ".\\src\\nested",
      symbolKinds: ["function", "function", "class"],
    },
  });

  assert.equal(result.diagnostic, null);
  assert.deepEqual(result.filters, {
    language: "typescript",
    pathPrefix: "src/nested",
    symbolKinds: ["function", "class"],
  });
});

test("normalizeDefinitionFilters rejects paths outside the workspace root", async () => {
  const context = createServerContext(loadRuntimeConfig());
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-filters-oos-"));

  const result = normalizeDefinitionFilters({
    workspaceRoot,
    languageRegistry: context.languageRegistry,
    input: {
      pathPrefix: "..\\outside",
    },
  });

  assert.equal(result.diagnostic?.code, "workspace_path_out_of_scope");
});

test("searchDefinitions and resolveDefinition reuse the same normalized filter semantics", async () => {
  const workspaceRoot = await createDefinitionWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const searchResult = await searchDefinitions(context, {
    query: "greet",
    language: "TypeScript",
    pathPrefix: ".\\src\\app.ts",
    symbolKinds: ["function", "function"],
  });

  assert.equal(searchResult.diagnostics.length, 0);
  assert.deepEqual(searchResult.filters, {
    language: "typescript",
    pathPrefix: "src/app.ts",
    symbolKinds: ["function"],
  });
  assert.deepEqual(searchResult.results.map((definition) => `${definition.relativePath}:${definition.name}`), [
    "src/app.ts:greet",
  ]);

  const resolveResult = await resolveDefinition(context, {
    lookup: {
      name: "greet",
      languageId: "TypeScript",
      relativePath: ".\\src\\app.ts",
      kind: "function",
    },
  });

  assert.equal(resolveResult.diagnostic, null);
  assert.deepEqual(resolveResult.filters, {
    language: "typescript",
    pathPrefix: "src/app.ts",
    symbolKinds: ["function"],
  });
  assert.equal(resolveResult.match?.relativePath, "src/app.ts");
  assert.equal(resolveResult.match?.name, "greet");
});
