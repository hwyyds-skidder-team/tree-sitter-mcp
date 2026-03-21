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
import { discoverConfiguredWorkspaces } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createDefinitionWorkspaceFixture(label = "primary"): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `tree-sitter-mcp-definition-filters-${label}-`));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "src", "nested"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export function greet(name: string): string {",
    `  return '${label}:' + name;`,
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

  await fs.writeFile(path.join(workspaceRoot, "src", "nested", "feature.ts"), [
    `export class ${label === "primary" ? "PrimaryFeature" : "SecondaryFeature"} {}`,
    "",
  ].join("\n"));

  return workspaceRoot;
}

async function createPreparedContext(workspaceRoots: string | string[]) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [workspaceRoots];
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-definition-index-"));
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

test("normalizeDefinitionFilters normalizes workspace roots, separators, deduplicates symbol kinds, and lowercases languages", async () => {
  const context = createServerContext(loadRuntimeConfig());
  const primaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-filters-normalize-primary-"));
  const secondaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-filters-normalize-secondary-"));
  await fs.mkdir(path.join(primaryRoot, "src", "nested"), { recursive: true });
  await fs.mkdir(path.join(secondaryRoot, "src", "nested"), { recursive: true });

  const result = normalizeDefinitionFilters({
    workspaceRoot: primaryRoot,
    configuredRoots: [primaryRoot, secondaryRoot],
    languageRegistry: context.languageRegistry,
    input: {
      workspaceRoots: [secondaryRoot, secondaryRoot],
      language: "TypeScript",
      pathPrefix: ".\\src\\nested",
      symbolKinds: ["function", "function", "class"],
    },
  });

  assert.equal(result.diagnostic, null);
  assert.deepEqual(result.filters, {
    workspaceRoots: [secondaryRoot],
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
  const primaryRoot = await createDefinitionWorkspaceFixture("primary");
  const secondaryRoot = await createDefinitionWorkspaceFixture("secondary");
  const context = await createPreparedContext([primaryRoot, secondaryRoot]);

  const searchResult = await searchDefinitions(context, {
    query: "greet",
    workspaceRoots: [secondaryRoot, secondaryRoot],
    language: "TypeScript",
    pathPrefix: ".\\src\\app.ts",
    symbolKinds: ["function", "function"],
  });

  assert.equal(searchResult.diagnostics.length, 0);
  assert.deepEqual(searchResult.filters, {
    workspaceRoots: [secondaryRoot],
    language: "typescript",
    pathPrefix: "src/app.ts",
    symbolKinds: ["function"],
  });
  assert.deepEqual(searchResult.results.map((definition) => `${definition.workspaceRoot}:${definition.relativePath}:${definition.name}`), [
    `${secondaryRoot}:src/app.ts:greet`,
  ]);

  const resolveResult = await resolveDefinition(context, {
    lookup: {
      name: "greet",
      languageId: "TypeScript",
      workspaceRoot: secondaryRoot,
      relativePath: ".\\src\\app.ts",
      kind: "function",
    },
  });

  assert.equal(resolveResult.diagnostic, null);
  assert.deepEqual(resolveResult.filters, {
    workspaceRoots: [secondaryRoot],
    language: "typescript",
    pathPrefix: "src/app.ts",
    symbolKinds: ["function"],
  });
  assert.equal(resolveResult.match?.workspaceRoot, secondaryRoot);
  assert.equal(resolveResult.match?.relativePath, "src/app.ts");
  assert.equal(resolveResult.match?.name, "greet");
});
