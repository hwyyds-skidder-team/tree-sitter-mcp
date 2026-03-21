import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLanguageRegistry } from "../src/languages/languageRegistry.js";
import { registerBuiltinGrammars } from "../src/languages/registerBuiltinGrammars.js";
import { discoverConfiguredWorkspaces, discoverWorkspaceFiles } from "../src/workspace/discoverFiles.js";
import {
  findContainingWorkspaceRoot,
  resolveConfiguredWorkspacePath,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  resolveWorkspaceRoots,
} from "../src/workspace/resolveWorkspace.js";
import { mergeExclusions } from "../src/workspace/workspaceState.js";

async function createWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-workspace-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "generated"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "export function greet() { return 'hi'; }\n");
  await fs.writeFile(path.join(workspaceRoot, "src", "view.tsx"), "export const View = () => <div />;\n");
  await fs.writeFile(path.join(workspaceRoot, "scripts", "job.py"), "def run():\n    return 1\n");
  await fs.writeFile(path.join(workspaceRoot, "docs", "notes.txt"), "plain text\n");
  await fs.writeFile(path.join(workspaceRoot, "generated", "artifact.ts"), "export const generated = true;\n");
  await fs.writeFile(path.join(workspaceRoot, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  return workspaceRoot;
}

async function createDuplicatePathWorkspaceFixture(label: string): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `tree-sitter-mcp-workspace-${label}-`));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), `export const app = ${JSON.stringify(label)};\n`);
  await fs.writeFile(path.join(workspaceRoot, "docs", "notes.txt"), `${label} docs\n`);
  return workspaceRoot;
}

test("workspace discovery keeps supported files, classifies unsupported files, and honors exclusions", async () => {
  const registry = createLanguageRegistry();
  registerBuiltinGrammars(registry);
  const workspaceRoot = await createWorkspaceFixture();

  const discovery = await discoverWorkspaceFiles(
    workspaceRoot,
    mergeExclusions(["node_modules", "generated"]),
    registry,
  );

  const searchablePaths = discovery.searchableFiles.map((file) => file.relativePath);
  assert.deepEqual(searchablePaths, ["scripts/job.py", "src/index.ts", "src/view.tsx"]);

  const unsupportedPaths = discovery.unsupportedFiles.map((file) => file.relativePath);
  assert.deepEqual(unsupportedPaths, ["docs/notes.txt"]);
});

test("workspace resolution rejects out-of-scope paths", async () => {
  const workspaceRoot = await createWorkspaceFixture();
  const resolvedRoot = await resolveWorkspaceRoot(workspaceRoot);
  const insideFile = resolveWorkspacePath(resolvedRoot, "src/index.ts");
  assert.ok(insideFile.endsWith(path.join("src", "index.ts")));

  assert.throws(
    () => resolveWorkspacePath(resolvedRoot, path.join("..", "outside.ts")),
    /escapes the configured workspace root/,
  );
});

test("configured workspace discovery preserves workspaceRoot ownership for duplicate relative paths", async () => {
  const registry = createLanguageRegistry();
  registerBuiltinGrammars(registry);
  const firstRoot = await createDuplicatePathWorkspaceFixture("first");
  const secondRoot = await createDuplicatePathWorkspaceFixture("second");

  const discovery = await discoverConfiguredWorkspaces(
    [firstRoot, secondRoot],
    mergeExclusions(["node_modules"]),
    registry,
  );

  assert.deepEqual(discovery.workspaces.map((workspace) => workspace.root), [firstRoot, secondRoot]);
  assert.deepEqual(
    discovery.searchableFiles.map((file) => ({
      workspaceRoot: file.workspaceRoot,
      relativePath: file.relativePath,
    })),
    [
      { workspaceRoot: firstRoot, relativePath: "src/app.ts" },
      { workspaceRoot: secondRoot, relativePath: "src/app.ts" },
    ],
  );
  assert.deepEqual(
    discovery.unsupportedFiles.map((file) => ({
      workspaceRoot: file.workspaceRoot,
      relativePath: file.relativePath,
    })),
    [
      { workspaceRoot: firstRoot, relativePath: "docs/notes.txt" },
      { workspaceRoot: secondRoot, relativePath: "docs/notes.txt" },
    ],
  );
});

test("configured workspace resolution normalizes roots and resolves owned paths safely", async () => {
  const firstRoot = await createWorkspaceFixture();
  const secondRoot = await createDuplicatePathWorkspaceFixture("owned");
  const resolvedRoots = await resolveWorkspaceRoots({
    root: firstRoot,
    roots: [secondRoot, firstRoot],
  });

  assert.deepEqual(resolvedRoots, [firstRoot, secondRoot]);
  assert.equal(
    findContainingWorkspaceRoot(resolvedRoots, path.join(secondRoot, "src", "app.ts")),
    secondRoot,
  );
  assert.equal(
    resolveConfiguredWorkspacePath(resolvedRoots, path.join(secondRoot, "src", "app.ts")),
    path.join(secondRoot, "src", "app.ts"),
  );
  assert.equal(
    resolveConfiguredWorkspacePath(resolvedRoots, "src/index.ts"),
    path.join(firstRoot, "src", "index.ts"),
  );
  assert.throws(
    () => resolveConfiguredWorkspacePath(resolvedRoots, path.join(firstRoot, "..", "outside.ts")),
    /escapes the configured workspace roots/,
  );
});
