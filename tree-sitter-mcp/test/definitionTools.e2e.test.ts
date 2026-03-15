import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const serverEntry = path.join(packageRoot, "dist", "index.js");

async function createWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-definitions-e2e-"));
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
    "class Runner:",
    "    def execute(self):",
    "        return 1",
    "",
    "def greet_python(name):",
    "    return name",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "broken.ts"), "export function broken( {\n");
  await fs.writeFile(path.join(workspaceRoot, "README.md"), "docs\n");

  return workspaceRoot;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await listWorkspaceFiles(entryPath);
      files.push(...nestedFiles.map((nested) => path.join(entry.name, nested)));
      continue;
    }

    files.push(entry.name);
  }

  return files.sort();
}

test("definition tools search and resolve definitions over stdio without mutating the workspace", async () => {
  const workspaceRoot = await createWorkspaceFixture();
  const beforeFiles = await listWorkspaceFiles(workspaceRoot);
  const beforeSource = await fs.readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  const client = new Client({
    name: "tree-sitter-mcp-definition-tools-test",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: packageRoot,
    env: process.env as Record<string, string>,
  });

  try {
    await client.connect(transport);

    const setWorkspaceResult = await client.callTool({
      name: "set_workspace",
      arguments: {
        root: workspaceRoot,
      },
    });
    assert.notEqual(setWorkspaceResult.isError, true);

    const searchResult = await client.callTool({
      name: "search_definitions",
      arguments: {
        query: "greet",
      },
    });
    assert.notEqual(searchResult.isError, true);
    const searchPayload = searchResult.structuredContent as {
      filters: { language: string | null; pathPrefix: string | null; symbolKinds: string[]; limit: number };
      results: Array<{
        name: string;
        kind: string;
        relativePath: string;
        range: { start: { line: number; offset: number }; end: { offset: number } };
        selectionRange: { start: { offset: number }; end: { offset: number } };
      }>;
      diagnostics: Array<{ code: string; relativePath?: string }>;
    };
    assert.deepEqual(searchPayload.filters, {
      language: null,
      pathPrefix: null,
      symbolKinds: [],
      limit: 50,
    });
    assert.deepEqual(searchPayload.results.map((definition) => `${definition.relativePath}:${definition.name}`).sort(), [
      "scripts/tool.py:greet_python",
      "src/app.ts:Greeter",
      "src/app.ts:greet",
      "src/secondary.ts:greet",
    ].sort());
    assert.ok(searchPayload.results.every((definition) => definition.range.start.line >= 1));
    assert.ok(searchPayload.results.every((definition) => definition.selectionRange.start.offset >= definition.range.start.offset));
    assert.ok(searchPayload.results.every((definition) => definition.selectionRange.end.offset <= definition.range.end.offset));
    assert.ok(searchPayload.diagnostics.some((diagnostic) => diagnostic.code === "parse_failed" && diagnostic.relativePath === "src/broken.ts"));

    const filteredSearchResult = await client.callTool({
      name: "search_definitions",
      arguments: {
        query: "greet",
        language: "TypeScript",
        pathPrefix: ".\\src\\app.ts",
        symbolKinds: ["function", "function"],
      },
    });
    assert.notEqual(filteredSearchResult.isError, true);
    const filteredSearchPayload = filteredSearchResult.structuredContent as {
      filters: { language: string | null; pathPrefix: string | null; symbolKinds: string[]; limit: number };
      results: Array<{ name: string; relativePath: string; languageId: string; kind: string }>;
    };
    assert.deepEqual(filteredSearchPayload.filters, {
      language: "typescript",
      pathPrefix: "src/app.ts",
      symbolKinds: ["function"],
      limit: 50,
    });
    assert.deepEqual(filteredSearchPayload.results.map((definition) => `${definition.relativePath}:${definition.name}`), [
      "src/app.ts:greet",
    ]);

    const resolveFromSymbolResult = await client.callTool({
      name: "resolve_definition",
      arguments: {
        symbol: filteredSearchPayload.results[0],
      },
    });
    assert.notEqual(resolveFromSymbolResult.isError, true);
    const resolveFromSymbolPayload = resolveFromSymbolResult.structuredContent as {
      filters: { language: string | null; pathPrefix: string | null; symbolKinds: string[] };
      match: { name: string; relativePath: string; kind: string } | null;
      diagnostic: { code: string } | null;
    };
    assert.deepEqual(resolveFromSymbolPayload.filters, {
      language: "typescript",
      pathPrefix: "src/app.ts",
      symbolKinds: ["function"],
    });
    assert.equal(resolveFromSymbolPayload.diagnostic, null);
    assert.equal(resolveFromSymbolPayload.match?.relativePath, "src/app.ts");
    assert.equal(resolveFromSymbolPayload.match?.name, "greet");

    const missingResolveResult = await client.callTool({
      name: "resolve_definition",
      arguments: {
        lookup: {
          name: "missing_symbol",
        },
      },
    });
    assert.equal(missingResolveResult.isError, true);
    const missingResolvePayload = missingResolveResult.structuredContent as {
      diagnostic: { code: string } | null;
      diagnostics: Array<{ code: string }>;
    };
    assert.equal(missingResolvePayload.diagnostic?.code, "definition_not_found");
    assert.equal(missingResolvePayload.diagnostics.at(-1)?.code, "definition_not_found");

    const invalidPathSearchResult = await client.callTool({
      name: "search_definitions",
      arguments: {
        query: "greet",
        pathPrefix: "..\\outside",
      },
    });
    assert.equal(invalidPathSearchResult.isError, true);
    const invalidPathPayload = invalidPathSearchResult.structuredContent as {
      diagnostics: Array<{ code: string }>;
    };
    assert.equal(invalidPathPayload.diagnostics[0]?.code, "workspace_path_out_of_scope");

    const afterFiles = await listWorkspaceFiles(workspaceRoot);
    const afterSource = await fs.readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
    assert.deepEqual(afterFiles, beforeFiles);
    assert.equal(afterSource, beforeSource);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
