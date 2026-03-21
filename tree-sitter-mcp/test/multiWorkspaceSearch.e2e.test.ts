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

async function createFederatedWorkspaceFixture(label: "first" | "second"): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `tree-sitter-mcp-federated-${label}-`));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "shared.ts"), [
    "export function greet(): string {",
    `  return '${label}';`,
    "}",
    "export function greetBridge(): string {",
    "  return greet();",
    "}",
    "export function helperForGreet(): string {",
    "  return greet();",
    "}",
    "export class SharedWidget {",
    "  render(): string {",
    "    return greet();",
    "  }",
    "}",
    "export function sharedWidgetFactory(): SharedWidget {",
    "  return new SharedWidget();",
    "}",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "usage.ts"), [
    "import { greet, SharedWidget } from './shared';",
    "export const direct = greet();",
    "const widget = new SharedWidget();",
    "widget.render();",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "README.md"), `${label} docs\n`);

  return workspaceRoot;
}

function sumReturnedResults(workspaceBreakdown: Array<{ returnedResults: number }>): number {
  return workspaceBreakdown.reduce((sum, workspace) => sum + workspace.returnedResults, 0);
}

test("federated multi-workspace search stays deterministic, attributable, and backward-compatible", async () => {
  const firstRoot = await createFederatedWorkspaceFixture("first");
  const secondRoot = await createFederatedWorkspaceFixture("second");
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-federated-index-"));
  const client = new Client({
    name: "tree-sitter-mcp-federated-search-test",
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
        roots: [firstRoot, secondRoot],
      },
    });
    assert.notEqual(setWorkspaceResult.isError, true);
    const setWorkspacePayload = setWorkspaceResult.structuredContent as {
      workspace: {
        root: string | null;
        roots: string[];
        workspaceCount: number;
      };
    };
    assert.equal(setWorkspacePayload.workspace.root, firstRoot);
    assert.deepEqual(setWorkspacePayload.workspace.roots, [firstRoot, secondRoot]);
    assert.equal(setWorkspacePayload.workspace.workspaceCount, 2);

    const symbolSearchResult = await client.callTool({
      name: "search_workspace_symbols",
      arguments: {
        query: "greet",
        limit: 6,
      },
    });
    assert.notEqual(symbolSearchResult.isError, true);
    const symbolSearchPayload = symbolSearchResult.structuredContent as {
      workspaceRoot: string | null;
      workspaceRoots: string[];
      filters: { workspaceRoots?: string[]; symbolKinds: string[] };
      results: Array<{ name: string; workspaceRoot: string; relativePath: string }>;
      workspaceBreakdown: Array<{
        workspaceRoot: string;
        searchedFiles: number;
        matchedFiles: number;
        returnedResults: number;
      }>;
    };
    assert.equal(symbolSearchPayload.workspaceRoot, firstRoot);
    assert.deepEqual(symbolSearchPayload.workspaceRoots, [firstRoot, secondRoot]);
    assert.deepEqual(symbolSearchPayload.filters.symbolKinds, []);
    assert.deepEqual(
      symbolSearchPayload.results.map((symbol) => `${symbol.workspaceRoot}:${symbol.name}`),
      [
        `${firstRoot}:greet`,
        `${secondRoot}:greet`,
        `${firstRoot}:greetBridge`,
        `${secondRoot}:greetBridge`,
        `${firstRoot}:helperForGreet`,
        `${secondRoot}:helperForGreet`,
      ],
    );
    assert.deepEqual(symbolSearchPayload.workspaceBreakdown, [
      {
        workspaceRoot: firstRoot,
        searchedFiles: 2,
        matchedFiles: 1,
        returnedResults: 3,
      },
      {
        workspaceRoot: secondRoot,
        searchedFiles: 2,
        matchedFiles: 1,
        returnedResults: 3,
      },
    ]);
    assert.equal(sumReturnedResults(symbolSearchPayload.workspaceBreakdown), symbolSearchPayload.results.length);

    const filteredSymbolSearchResult = await client.callTool({
      name: "search_workspace_symbols",
      arguments: {
        query: "greet",
        workspaceRoots: [secondRoot],
        limit: 10,
      },
    });
    assert.notEqual(filteredSymbolSearchResult.isError, true);
    const filteredSymbolPayload = filteredSymbolSearchResult.structuredContent as {
      workspaceRoots: string[];
      results: Array<{ workspaceRoot: string }>;
      workspaceBreakdown: Array<{ workspaceRoot: string; returnedResults: number }>;
    };
    assert.deepEqual(filteredSymbolPayload.workspaceRoots, [secondRoot]);
    assert.ok(filteredSymbolPayload.results.length > 0);
    assert.ok(filteredSymbolPayload.results.every((symbol) => symbol.workspaceRoot === secondRoot));
    assert.deepEqual(filteredSymbolPayload.workspaceBreakdown, [
      {
        workspaceRoot: secondRoot,
        searchedFiles: 2,
        matchedFiles: 1,
        returnedResults: filteredSymbolPayload.results.length,
      },
    ]);

    const classSymbolSearchResult = await client.callTool({
      name: "search_workspace_symbols",
      arguments: {
        query: "shared",
        symbolKinds: ["class"],
        limit: 10,
      },
    });
    assert.notEqual(classSymbolSearchResult.isError, true);
    const classSymbolPayload = classSymbolSearchResult.structuredContent as {
      filters: { symbolKinds: string[] };
      results: Array<{ name: string; kind: string; workspaceRoot: string }>;
      workspaceBreakdown: Array<{ workspaceRoot: string; returnedResults: number }>;
    };
    assert.deepEqual(classSymbolPayload.filters.symbolKinds, ["class"]);
    assert.deepEqual(
      classSymbolPayload.results.map((symbol) => `${symbol.workspaceRoot}:${symbol.kind}:${symbol.name}`),
      [
        `${firstRoot}:class:SharedWidget`,
        `${secondRoot}:class:SharedWidget`,
      ],
    );
    assert.equal(sumReturnedResults(classSymbolPayload.workspaceBreakdown), classSymbolPayload.results.length);

    const classDefinitionSearchResult = await client.callTool({
      name: "search_definitions",
      arguments: {
        query: "shared",
        symbolKinds: ["class"],
        limit: 10,
      },
    });
    assert.notEqual(classDefinitionSearchResult.isError, true);
    const classDefinitionPayload = classDefinitionSearchResult.structuredContent as {
      workspaceRoots: string[];
      filters: { symbolKinds: string[] };
      results: Array<{ name: string; kind: string; workspaceRoot: string }>;
      workspaceBreakdown: Array<{ workspaceRoot: string; returnedResults: number }>;
    };
    assert.deepEqual(classDefinitionPayload.workspaceRoots, [firstRoot, secondRoot]);
    assert.deepEqual(classDefinitionPayload.filters.symbolKinds, ["class"]);
    assert.deepEqual(
      classDefinitionPayload.results.map((definition) => `${definition.workspaceRoot}:${definition.kind}:${definition.name}`),
      [
        `${firstRoot}:class:SharedWidget`,
        `${secondRoot}:class:SharedWidget`,
      ],
    );
    assert.equal(sumReturnedResults(classDefinitionPayload.workspaceBreakdown), classDefinitionPayload.results.length);

    const exactDefinitionSearchResult = await client.callTool({
      name: "search_definitions",
      arguments: {
        query: "greet",
        symbolKinds: ["function"],
        limit: 2,
      },
    });
    assert.notEqual(exactDefinitionSearchResult.isError, true);
    const exactDefinitionPayload = exactDefinitionSearchResult.structuredContent as {
      workspaceRoots: string[];
      filters: { symbolKinds: string[] };
      results: Array<{ name: string; kind: string; workspaceRoot: string; relativePath: string }>;
      workspaceBreakdown: Array<{
        workspaceRoot: string;
        searchedFiles: number;
        matchedFiles: number;
        returnedResults: number;
      }>;
    };
    assert.deepEqual(exactDefinitionPayload.workspaceRoots, [firstRoot, secondRoot]);
    assert.deepEqual(exactDefinitionPayload.filters.symbolKinds, ["function"]);
    assert.deepEqual(
      exactDefinitionPayload.results.map((definition) => `${definition.workspaceRoot}:${definition.relativePath}:${definition.name}`),
      [
        `${firstRoot}:src/shared.ts:greet`,
        `${secondRoot}:src/shared.ts:greet`,
      ],
    );
    assert.deepEqual(exactDefinitionPayload.workspaceBreakdown, [
      {
        workspaceRoot: firstRoot,
        searchedFiles: 2,
        matchedFiles: 1,
        returnedResults: 1,
      },
      {
        workspaceRoot: secondRoot,
        searchedFiles: 2,
        matchedFiles: 1,
        returnedResults: 1,
      },
    ]);

    const resolveDefinitionResult = await client.callTool({
      name: "resolve_definition",
      arguments: {
        symbol: exactDefinitionPayload.results[1],
      },
    });
    assert.notEqual(resolveDefinitionResult.isError, true);
    const resolveDefinitionPayload = resolveDefinitionResult.structuredContent as {
      match: { workspaceRoot: string; relativePath: string; name: string } | null;
      diagnostic: { code: string } | null;
    };
    assert.equal(resolveDefinitionPayload.diagnostic, null);
    assert.equal(resolveDefinitionPayload.match?.workspaceRoot, secondRoot);
    assert.equal(resolveDefinitionPayload.match?.relativePath, "src/shared.ts");
    assert.equal(resolveDefinitionPayload.match?.name, "greet");

    const referenceSearchResult = await client.callTool({
      name: "search_references",
      arguments: {
        symbol: exactDefinitionPayload.results[1],
        workspaceRoots: [secondRoot],
        limit: 20,
      },
    });
    assert.notEqual(referenceSearchResult.isError, true);
    const referenceSearchPayload = referenceSearchResult.structuredContent as {
      workspaceRoots: string[];
      results: Array<{ workspaceRoot: string }>;
      workspaceBreakdown: Array<{
        workspaceRoot: string;
        searchedFiles: number;
        matchedFiles: number;
        returnedResults: number;
      }>;
    };
    assert.deepEqual(referenceSearchPayload.workspaceRoots, [secondRoot]);
    assert.ok(referenceSearchPayload.results.length > 0);
    assert.ok(referenceSearchPayload.results.every((reference) => reference.workspaceRoot === secondRoot));
    assert.equal(sumReturnedResults(referenceSearchPayload.workspaceBreakdown), referenceSearchPayload.results.length);
    assert.equal(referenceSearchPayload.workspaceBreakdown[0]?.workspaceRoot, secondRoot);
    assert.equal(referenceSearchPayload.workspaceBreakdown[0]?.searchedFiles, 2);

    const legacySetWorkspaceResult = await client.callTool({
      name: "set_workspace",
      arguments: {
        root: firstRoot,
      },
    });
    assert.notEqual(legacySetWorkspaceResult.isError, true);

    const legacySearchResult = await client.callTool({
      name: "search_workspace_symbols",
      arguments: {
        query: "greet",
      },
    });
    assert.notEqual(legacySearchResult.isError, true);
    const legacySearchPayload = legacySearchResult.structuredContent as {
      workspaceRoot: string | null;
      workspaceRoots: string[];
      results: Array<{ workspaceRoot: string }>;
      workspaceBreakdown: Array<{ workspaceRoot: string; returnedResults: number }>;
    };
    assert.equal(legacySearchPayload.workspaceRoot, firstRoot);
    assert.deepEqual(legacySearchPayload.workspaceRoots, [firstRoot]);
    assert.ok(legacySearchPayload.results.length > 0);
    assert.ok(legacySearchPayload.results.every((symbol) => symbol.workspaceRoot === firstRoot));
    assert.deepEqual(legacySearchPayload.workspaceBreakdown, [
      {
        workspaceRoot: firstRoot,
        searchedFiles: 2,
        matchedFiles: 1,
        returnedResults: legacySearchPayload.results.length,
      },
    ]);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
