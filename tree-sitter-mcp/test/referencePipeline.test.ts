import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { collectFileReferences } from "../src/references/referencePipeline.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverWorkspaceFiles } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createReferenceWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-references-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "lib"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });

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

  await fs.writeFile(path.join(workspaceRoot, "lib", "util.js"), [
    "function makeCounter() {",
    "  return 0;",
    "}",
    "makeCounter();",
    "const alias = makeCounter;",
    "class Helper {",
    "  run() { return makeCounter(); }",
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
    "def use():",
    "    greet_python('hi')",
    "    runner = Runner()",
    "    runner.execute()",
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

test("collectFileReferences extracts references and call sites across builtin languages with exact ranges", async () => {
  const workspaceRoot = await createReferenceWorkspaceFixture();
  const context = await createPreparedContext(workspaceRoot);

  const targets = [
    { relativePath: "src/app.ts", targetName: "greetUser", kind: "function" as const },
    { relativePath: "src/view.tsx", targetName: "greetUser", kind: "function" as const },
    { relativePath: "lib/util.js", targetName: "makeCounter", kind: "function" as const },
    { relativePath: "scripts/tool.py", targetName: "execute", kind: "method" as const },
  ];

  const fileResults = await Promise.all(targets.map(async (target) => {
    const file = context.workspace.searchableFiles.find((record) => record.relativePath === target.relativePath);
    assert.ok(file);
    return collectFileReferences(context, file, {
      targetName: target.targetName,
      symbolKind: target.kind,
    });
  }));

  const summaries = fileResults.flatMap((result) => result.references.map((reference) => `${reference.relativePath}:${reference.referenceKind}:${reference.name}`));
  assert.ok(summaries.includes("src/app.ts:call:greetUser"));
  assert.ok(summaries.includes("src/view.tsx:call:greetUser"));
  assert.ok(summaries.includes("lib/util.js:call:makeCounter"));
  assert.ok(summaries.includes("lib/util.js:reference:makeCounter"));
  assert.ok(summaries.includes("scripts/tool.py:call:execute"));

  for (const reference of fileResults.flatMap((result) => result.references)) {
    assert.ok(reference.range.start.line >= 1);
    assert.ok(reference.range.start.column >= 1);
    assert.ok(reference.selectionRange.start.offset >= reference.range.start.offset);
    assert.ok(reference.selectionRange.end.offset <= reference.range.end.offset);
  }
});
