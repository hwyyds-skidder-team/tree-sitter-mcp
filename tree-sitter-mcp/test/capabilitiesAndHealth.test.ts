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
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-capabilities-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "generated"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "export function greet() { return 'hi'; }\n");
  await fs.writeFile(path.join(workspaceRoot, "README.md"), "docs\n");
  await fs.writeFile(path.join(workspaceRoot, "generated", "artifact.ts"), "export const generated = true;\n");
  return workspaceRoot;
}

test("capabilities and health expose parser mode, languages, workspace root, and exclusion constraints", async () => {
  const workspaceRoot = await createWorkspaceFixture();
  const client = new Client({
    name: "tree-sitter-mcp-capabilities-test",
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

    const capabilitiesResult = await client.callTool({
      name: "get_capabilities",
      arguments: {},
    });
    const capabilities = capabilitiesResult.structuredContent as {
      parserMode: string;
      supportedLanguages: Array<{ id: string }>;
      supportedQueryTypes: string[];
      toolNames: string[];
      workspace: { root: string | null };
    };
    assert.equal(capabilities.parserMode, "on_demand");
    assert.deepEqual(capabilities.supportedLanguages.map((language) => language.id), [
      "javascript",
      "python",
      "tsx",
      "typescript",
    ]);
    assert.deepEqual(capabilities.supportedQueryTypes, [
      "file_symbols",
      "workspace_symbols",
      "definition_search",
      "definition_resolve",
      "reference_search",
      "call_site_search",
    ]);
    assert.ok(capabilities.toolNames.includes("search_definitions"));
    assert.ok(capabilities.toolNames.includes("resolve_definition"));
    assert.ok(capabilities.toolNames.includes("search_references"));
    assert.equal(capabilities.workspace.root, null);

    const initialHealthResult = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    const initialHealth = initialHealthResult.structuredContent as {
      status: string;
      supportedQueryTypes: string[];
      diagnostics: Array<{ code: string }>;
    };
    assert.equal(initialHealth.status, "workspace_not_set");
    assert.deepEqual(initialHealth.supportedQueryTypes, [
      "file_symbols",
      "workspace_symbols",
      "definition_search",
      "definition_resolve",
      "reference_search",
      "call_site_search",
    ]);
    assert.equal(initialHealth.diagnostics[0]?.code, "workspace_not_set");

    const setWorkspaceResult = await client.callTool({
      name: "set_workspace",
      arguments: {
        root: workspaceRoot,
        additionalExclusions: ["generated"],
      },
    });
    const workspacePayload = setWorkspaceResult.structuredContent as {
      workspace: { root: string | null; searchableFileCount: number; unsupportedFileCount: number; exclusions: string[] };
    };
    assert.equal(workspacePayload.workspace.root, workspaceRoot);
    assert.equal(workspacePayload.workspace.searchableFileCount, 1);
    assert.equal(workspacePayload.workspace.unsupportedFileCount, 1);
    assert.ok(workspacePayload.workspace.exclusions.includes("generated"));

    const readyHealthResult = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    const readyHealth = readyHealthResult.structuredContent as {
      status: string;
      supportedQueryTypes: string[];
      workspace: { root: string | null; searchableFileCount: number; unsupportedFileCount: number };
      unsupportedFilesSample: Array<{ relativePath: string }>;
    };
    assert.equal(readyHealth.status, "ready");
    assert.deepEqual(readyHealth.supportedQueryTypes, [
      "file_symbols",
      "workspace_symbols",
      "definition_search",
      "definition_resolve",
      "reference_search",
      "call_site_search",
    ]);
    assert.equal(readyHealth.workspace.root, workspaceRoot);
    assert.equal(readyHealth.workspace.searchableFileCount, 1);
    assert.equal(readyHealth.workspace.unsupportedFileCount, 1);
    assert.deepEqual(readyHealth.unsupportedFilesSample.map((file) => file.relativePath), ["README.md"]);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
