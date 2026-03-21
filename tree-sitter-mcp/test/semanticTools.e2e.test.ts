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
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-semantic-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export interface Person { name: string }",
    "export function greet(name: string): string { return name; }",
    "class Greeter {",
    "  sayHello(): string { return 'hi'; }",
    "}",
    "const helper = (): number => 1;",
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
  await fs.writeFile(path.join(workspaceRoot, "node_modules", "pkg", "ignored.ts"), "export const ignored = true;\n");
  return workspaceRoot;
}

test("semantic tools search supported files, respect exclusions, and return actionable diagnostics", async () => {
  const workspaceRoot = await createWorkspaceFixture();
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-semantic-index-"));
  const client = new Client({
    name: "tree-sitter-mcp-semantic-test",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: packageRoot,
    env: {
      ...(process.env as Record<string, string>),
      TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
    },
  });

  try {
    await client.connect(transport);

    const setWorkspaceResult = await client.callTool({
      name: "set_workspace",
      arguments: {
        root: workspaceRoot,
      },
    });
    const setWorkspacePayload = setWorkspaceResult.structuredContent as {
      workspace: {
        root: string | null;
        searchableFileCount: number;
        unsupportedFileCount: number;
        index: { state: string; workspaceFingerprint: string | null };
      };
    };
    assert.equal(setWorkspacePayload.workspace.root, workspaceRoot);
    assert.equal(setWorkspacePayload.workspace.searchableFileCount, 3);
    assert.equal(setWorkspacePayload.workspace.unsupportedFileCount, 1);
    assert.notEqual(setWorkspacePayload.workspace.index.state, "rebuilding");
    assert.ok(setWorkspacePayload.workspace.index.workspaceFingerprint);
    await fs.access(path.join(
      indexRootDir,
      setWorkspacePayload.workspace.index.workspaceFingerprint ?? "",
      "manifest.json",
    ));
    await fs.access(path.join(
      indexRootDir,
      setWorkspacePayload.workspace.index.workspaceFingerprint ?? "",
      "records.json",
    ));

    const listFileSymbolsResult = await client.callTool({
      name: "list_file_symbols",
      arguments: {
        path: "src/app.ts",
      },
    });
    const fileSymbolsPayload = listFileSymbolsResult.structuredContent as {
      languageId: string | null;
      symbols: Array<{ name: string; kind: string }>;
    };
    assert.equal(fileSymbolsPayload.languageId, "typescript");
    assert.deepEqual(fileSymbolsPayload.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`), [
      "interface:Person",
      "function:greet",
      "class:Greeter",
      "method:sayHello",
      "variable:helper",
    ]);

    const searchWorkspaceSymbolsResult = await client.callTool({
      name: "search_workspace_symbols",
      arguments: {
        query: "greet",
      },
    });
    const searchPayload = searchWorkspaceSymbolsResult.structuredContent as {
      results: Array<{ name: string; relativePath: string }>;
      diagnostics: Array<{ code: string; relativePath?: string }>;
    };
    assert.deepEqual(searchPayload.results.map((symbol) => `${symbol.relativePath}:${symbol.name}`).sort(), [
      "scripts/tool.py:greet_python",
      "src/app.ts:Greeter",
      "src/app.ts:greet",
    ].sort());
    assert.ok(searchPayload.diagnostics.some((diagnostic) => diagnostic.code === "parse_failed" && diagnostic.relativePath === "src/broken.ts"));
    assert.ok(searchPayload.diagnostics.every((diagnostic) => diagnostic.relativePath !== "node_modules/pkg/ignored.ts"));

    const pythonOnlyResult = await client.callTool({
      name: "search_workspace_symbols",
      arguments: {
        query: "greet",
        language: "python",
      },
    });
    const pythonOnlyPayload = pythonOnlyResult.structuredContent as {
      results: Array<{ relativePath: string; name: string }>;
    };
    assert.deepEqual(pythonOnlyPayload.results.map((symbol) => `${symbol.relativePath}:${symbol.name}`), [
      "scripts/tool.py:greet_python",
    ]);

    const unsupportedFileResult = await client.callTool({
      name: "list_file_symbols",
      arguments: {
        path: "README.md",
      },
    });
    assert.equal(unsupportedFileResult.isError, true);
    const unsupportedFilePayload = unsupportedFileResult.structuredContent as {
      diagnostics: Array<{ code: string }>;
    };
    assert.equal(unsupportedFilePayload.diagnostics[0]?.code, "unsupported_file");

    const parseFailureResult = await client.callTool({
      name: "list_file_symbols",
      arguments: {
        path: "src/broken.ts",
      },
    });
    assert.equal(parseFailureResult.isError, true);
    const parseFailurePayload = parseFailureResult.structuredContent as {
      diagnostics: Array<{ code: string }>;
    };
    assert.equal(parseFailurePayload.diagnostics[0]?.code, "parse_failed");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
