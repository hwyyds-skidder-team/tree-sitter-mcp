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
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-references-e2e-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export function greetUser(name: string): string {",
    "  return name;",
    "}",
    "export function lonely(): string {",
    "  return 'solo';",
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

test("reference tools chain definition discovery into reference search over stdio without mutating the workspace", async () => {
  const workspaceRoot = await createWorkspaceFixture();
  const beforeFiles = await listWorkspaceFiles(workspaceRoot);
  const beforeSource = await fs.readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  const client = new Client({
    name: "tree-sitter-mcp-reference-tools-test",
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

    await client.callTool({
      name: "set_workspace",
      arguments: {
        root: workspaceRoot,
      },
    });

    const definitionResult = await client.callTool({
      name: "search_definitions",
      arguments: {
        query: "greetUser",
        language: "TypeScript",
        pathPrefix: ".\\src\\app.ts",
      },
    });
    assert.notEqual(definitionResult.isError, true);

    const definitionPayload = definitionResult.structuredContent as {
      results: Array<{ name: string; languageId: string; relativePath: string; kind: string }>;
    };
    assert.equal(definitionPayload.results.length, 1);

    const firstPage = await client.callTool({
      name: "search_references",
      arguments: {
        symbol: definitionPayload.results[0],
        limit: 2,
        offset: 0,
      },
    });
    assert.notEqual(firstPage.isError, true);
    const firstPagePayload = firstPage.structuredContent as {
      target: { name: string; relativePath: string } | null;
      pagination: { limit: number; offset: number; returned: number; total: number; hasMore: boolean; nextOffset: number | null };
      results: Array<{
        relativePath: string;
        referenceKind: string;
        enclosingContext: { kind: string; name: string | null } | null;
        contextSnippet: { text: string; truncated: boolean } | null;
      }>;
      diagnostics: Array<{ code: string; relativePath?: string }>;
    };
    assert.equal(firstPagePayload.target?.name, "greetUser");
    assert.equal(firstPagePayload.target?.relativePath, "src/app.ts");
    assert.deepEqual(firstPagePayload.pagination, {
      limit: 2,
      offset: 0,
      returned: 2,
      total: 4,
      hasMore: true,
      nextOffset: 2,
    });
    assert.ok(firstPagePayload.results.every((reference) => reference.contextSnippet?.text.includes("greetUser")));
    assert.ok(firstPagePayload.results.some((reference) => reference.enclosingContext?.name === "sayHello"));
    assert.ok(firstPagePayload.diagnostics.some((diagnostic) => diagnostic.code === "parse_failed" && diagnostic.relativePath === "src/broken.ts"));

    const secondPage = await client.callTool({
      name: "search_references",
      arguments: {
        lookup: {
          name: "greetUser",
          languageId: "typescript",
          kind: "function",
        },
        limit: 2,
        offset: firstPagePayload.pagination.nextOffset ?? 0,
      },
    });
    assert.notEqual(secondPage.isError, true);
    const secondPagePayload = secondPage.structuredContent as {
      pagination: { offset: number; returned: number; hasMore: boolean; nextOffset: number | null };
      results: Array<{ relativePath: string }>;
    };
    assert.equal(secondPagePayload.pagination.offset, 2);
    assert.equal(secondPagePayload.results.length, 2);

    const methodLookup = await client.callTool({
      name: "search_references",
      arguments: {
        lookup: {
          name: "sayHello",
          languageId: "typescript",
          relativePath: "src/app.ts",
          kind: "method",
        },
      },
    });
    assert.notEqual(methodLookup.isError, true);
    const methodPayload = methodLookup.structuredContent as {
      results: Array<{ relativePath: string; referenceKind: string; name: string }>;
    };
    assert.deepEqual(methodPayload.results.map((reference) => `${reference.relativePath}:${reference.referenceKind}:${reference.name}`), [
      "src/app.ts:call:sayHello",
    ]);

    const noUsageResult = await client.callTool({
      name: "search_references",
      arguments: {
        lookup: {
          name: "lonely",
          languageId: "typescript",
          kind: "function",
        },
      },
    });
    assert.equal(noUsageResult.isError, true);
    const noUsagePayload = noUsageResult.structuredContent as {
      diagnostic: { code: string } | null;
    };
    assert.equal(noUsagePayload.diagnostic?.code, "reference_not_found");

    const missingTargetResult = await client.callTool({
      name: "search_references",
      arguments: {
        lookup: {
          name: "missing_symbol",
        },
      },
    });
    assert.equal(missingTargetResult.isError, true);
    const missingTargetPayload = missingTargetResult.structuredContent as {
      diagnostic: { code: string } | null;
    };
    assert.equal(missingTargetPayload.diagnostic?.code, "definition_not_found");

    const afterFiles = await listWorkspaceFiles(workspaceRoot);
    const afterSource = await fs.readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
    assert.deepEqual(afterFiles, beforeFiles);
    assert.equal(afterSource, beforeSource);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
