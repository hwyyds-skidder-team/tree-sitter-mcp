import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { searchReferences } from "../src/references/searchReferences.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverWorkspaceFiles } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createReferenceWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-reference-context-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export function greetUser(name: string): string {",
    "  return name;",
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

test("searchReferences enriches matches with enclosing context metadata and concise snippets", async () => {
  const workspaceRoot = await createReferenceWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const result = await searchReferences(context, {
    lookup: {
      name: "greetUser",
      languageId: "typescript",
      kind: "function",
    },
  });

  const methodCall = result.results.find((reference) => reference.relativePath === "src/app.ts");
  assert.ok(methodCall?.enclosingContext);
  assert.equal(methodCall.enclosingContext.kind, "method");
  assert.equal(methodCall.enclosingContext.name, "sayHello");
  assert.ok(methodCall.contextSnippet);
  assert.match(methodCall.contextSnippet.text, /greetUser/);
  assert.ok(methodCall.contextSnippet.text.length <= 160);

  const tsxCall = result.results.find((reference) => reference.relativePath === "src/view.tsx" && reference.referenceKind === "call");
  assert.ok(tsxCall?.enclosingContext);
  assert.equal(tsxCall.enclosingContext.kind, "function");
  assert.equal(tsxCall.enclosingContext.name, "Panel");
});
