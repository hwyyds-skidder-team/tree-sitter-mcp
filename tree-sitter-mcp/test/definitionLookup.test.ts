import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { resolveDefinition } from "../src/definitions/resolveDefinition.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverWorkspaceFiles } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createDefinitionWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-definition-lookup-"));
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
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-definition-index-"));
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

test("resolveDefinition prefers the matching symbol descriptor context", async () => {
  const workspaceRoot = await createDefinitionWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await resolveDefinition(context, {
    symbol: {
      name: "greet",
      languageId: "typescript",
      relativePath: "src/app.ts",
      kind: "function",
    },
  });

  assert.equal(result.diagnostic, null);
  assert.equal(result.match?.relativePath, "src/app.ts");
  assert.equal(result.match?.kind, "function");
  assert.equal(result.match?.name, "greet");
});

test("resolveDefinition supports direct lookup requests", async () => {
  const workspaceRoot = await createDefinitionWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await resolveDefinition(context, {
    lookup: {
      name: "greet_python",
      languageId: "python",
    },
  });

  assert.equal(result.diagnostic, null);
  assert.equal(result.match?.relativePath, "scripts/tool.py");
  assert.equal(result.match?.name, "greet_python");
});

test("resolveDefinition returns a structured diagnostic when the target is missing", async () => {
  const workspaceRoot = await createDefinitionWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await resolveDefinition(context, {
    lookup: {
      name: "missing_symbol",
    },
  });

  assert.equal(result.match, null);
  assert.equal(result.diagnostic?.code, "definition_not_found");
});

test("resolveDefinition excludes degraded stale indexed records after a changed file breaks", async () => {
  const workspaceRoot = await createDefinitionWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const initialResult = await resolveDefinition(context, {
    lookup: {
      name: "greet",
      languageId: "typescript",
      relativePath: "src/app.ts",
    },
  });
  assert.equal(initialResult.match?.relativePath, "src/app.ts");

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), "export function greet( {\n");

  const degradedResult = await resolveDefinition(context, {
    lookup: {
      name: "greet",
      languageId: "typescript",
      kind: "function",
    },
  });

  assert.equal(degradedResult.match?.relativePath, "src/secondary.ts");
  assert.ok(degradedResult.diagnostics.some((diagnostic) =>
    diagnostic.code === "parse_failed" && diagnostic.relativePath === "src/app.ts"));
  assert.equal(context.workspace.index.state, "degraded");
});
