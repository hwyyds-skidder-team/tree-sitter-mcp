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

async function createFederatedWorkspaceFixtures(): Promise<[string, string]> {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-capabilities-first-"));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-capabilities-second-"));

  await fs.mkdir(path.join(firstRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(secondRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(firstRoot, "src", "app.ts"), "export const app = 'first';\n");
  await fs.writeFile(path.join(secondRoot, "src", "app.ts"), "export const app = 'second';\n");
  await fs.writeFile(path.join(firstRoot, "README.md"), "first docs\n");
  await fs.writeFile(path.join(secondRoot, "README.md"), "second docs\n");

  return [firstRoot, secondRoot];
}

test("capabilities and health expose parser mode, languages, workspace root, and exclusion constraints", async () => {
  const workspaceRoot = await createWorkspaceFixture();
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-capabilities-index-"));
  const client = new Client({
    name: "tree-sitter-mcp-capabilities-test",
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

    const capabilitiesResult = await client.callTool({
      name: "get_capabilities",
      arguments: {},
    });
    const capabilities = capabilitiesResult.structuredContent as {
      parserMode: string;
      indexMode: string;
      supportedLanguages: Array<{ id: string }>;
      supportedQueryTypes: string[];
      toolNames: string[];
      workspace: {
        root: string | null;
        roots: string[];
        workspaceCount: number;
        index: { indexMode: string; workspaceFingerprint: string | null };
      };
    };
    assert.equal(capabilities.parserMode, "on_demand");
    assert.equal(capabilities.indexMode, "persistent_disk");
    assert.deepEqual(capabilities.supportedLanguages.map((language) => language.id), [
      "c",
      "cpp",
      "javascript",
      "python",
      "rust",
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
      "relationship_view",
    ]);
    assert.ok(capabilities.toolNames.includes("search_definitions"));
    assert.ok(capabilities.toolNames.includes("resolve_definition"));
    assert.ok(capabilities.toolNames.includes("search_references"));
    assert.ok(capabilities.toolNames.includes("get_relationship_view"));
    assert.equal(capabilities.workspace.root, null);
    assert.deepEqual(capabilities.workspace.roots, []);
    assert.equal(capabilities.workspace.workspaceCount, 0);
    assert.equal(capabilities.workspace.index.indexMode, "persistent_disk");
    assert.equal(capabilities.workspace.index.workspaceFingerprint, null);

    const bootstrapResult = await client.callTool({
      name: "tree_sitter_get_server_info",
      arguments: {},
    });
    const bootstrap = bootstrapResult.structuredContent as {
      eagerIndexing: boolean;
      index: { indexMode: string; workspaceFingerprint: string | null };
    };
    assert.equal(bootstrap.eagerIndexing, true);
    assert.equal(bootstrap.index.indexMode, "persistent_disk");
    assert.equal(bootstrap.index.workspaceFingerprint, null);

    const initialHealthResult = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    const initialHealth = initialHealthResult.structuredContent as {
      status: string;
      indexMode: string;
      supportedQueryTypes: string[];
      toolNames: string[];
      diagnostics: Array<{ code: string }>;
    };
    assert.equal(initialHealth.status, "workspace_not_set");
    assert.equal(initialHealth.indexMode, "persistent_disk");
    assert.deepEqual(initialHealth.supportedQueryTypes, [
      "file_symbols",
      "workspace_symbols",
      "definition_search",
      "definition_resolve",
      "reference_search",
      "call_site_search",
      "relationship_view",
    ]);
    assert.ok(initialHealth.toolNames.includes("get_relationship_view"));
    assert.equal(initialHealth.diagnostics[0]?.code, "workspace_not_set");

    const setWorkspaceResult = await client.callTool({
      name: "set_workspace",
      arguments: {
        root: workspaceRoot,
        additionalExclusions: ["generated"],
      },
    });
    const workspacePayload = setWorkspaceResult.structuredContent as {
      workspace: {
        root: string | null;
        roots: string[];
        workspaceCount: number;
        workspaces: Array<{ root: string }>;
        searchableFileCount: number;
        unsupportedFileCount: number;
        exclusions: string[];
        index: {
          indexMode: string;
          workspaceFingerprint: string | null;
          state: string;
          lastBuiltAt: string | null;
        };
      };
    };
    assert.equal(workspacePayload.workspace.root, workspaceRoot);
    assert.deepEqual(workspacePayload.workspace.roots, [workspaceRoot]);
    assert.equal(workspacePayload.workspace.workspaceCount, 1);
    assert.deepEqual(workspacePayload.workspace.workspaces.map((workspace) => workspace.root), [workspaceRoot]);
    assert.equal(workspacePayload.workspace.searchableFileCount, 1);
    assert.equal(workspacePayload.workspace.unsupportedFileCount, 1);
    assert.ok(workspacePayload.workspace.exclusions.includes("generated"));
    assert.equal(workspacePayload.workspace.index.indexMode, "persistent_disk");
    assert.ok(workspacePayload.workspace.index.workspaceFingerprint);
    assert.notEqual(workspacePayload.workspace.index.state, "rebuilding");
    assert.ok(workspacePayload.workspace.index.lastBuiltAt);

    const readyHealthResult = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    const readyHealth = readyHealthResult.structuredContent as {
      status: string;
      indexMode: string;
      supportedQueryTypes: string[];
      toolNames: string[];
      workspace: {
        root: string | null;
        roots: string[];
        workspaceCount: number;
        searchableFileCount: number;
        unsupportedFileCount: number;
        index: { workspaceFingerprint: string | null; indexMode: string };
      };
      unsupportedFilesSample: Array<{ relativePath: string }>;
    };
    assert.equal(readyHealth.status, "ready");
    assert.equal(readyHealth.indexMode, "persistent_disk");
    assert.deepEqual(readyHealth.supportedQueryTypes, [
      "file_symbols",
      "workspace_symbols",
      "definition_search",
      "definition_resolve",
      "reference_search",
      "call_site_search",
      "relationship_view",
    ]);
    assert.ok(readyHealth.toolNames.includes("get_relationship_view"));
    assert.equal(readyHealth.workspace.root, workspaceRoot);
    assert.deepEqual(readyHealth.workspace.roots, [workspaceRoot]);
    assert.equal(readyHealth.workspace.workspaceCount, 1);
    assert.equal(readyHealth.workspace.searchableFileCount, 1);
    assert.equal(readyHealth.workspace.unsupportedFileCount, 1);
    assert.equal(readyHealth.workspace.index.indexMode, "persistent_disk");
    assert.equal(
      readyHealth.workspace.index.workspaceFingerprint,
      workspacePayload.workspace.index.workspaceFingerprint,
    );
    assert.deepEqual(readyHealth.unsupportedFilesSample.map((file) => file.relativePath), ["README.md"]);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});

test("capabilities and health expose ordered roots for multi-root set_workspace bootstraps", async () => {
  const [firstRoot, secondRoot] = await createFederatedWorkspaceFixtures();
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-capabilities-index-"));
  const client = new Client({
    name: "tree-sitter-mcp-capabilities-multi-root-test",
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
    const workspacePayload = setWorkspaceResult.structuredContent as {
      workspace: {
        root: string | null;
        roots: string[];
        workspaceCount: number;
        index: { workspaceFingerprint: string | null };
        workspaces: Array<{
          root: string;
          searchableFileCount: number;
          index: { workspaceFingerprint: string | null; indexedFileCount: number };
        }>;
        searchableFileCount: number;
        unsupportedFileCount: number;
      };
      searchableFilesSample: Array<{ workspaceRoot: string; relativePath: string }>;
    };

    assert.equal(workspacePayload.workspace.root, firstRoot);
    assert.deepEqual(workspacePayload.workspace.roots, [firstRoot, secondRoot]);
    assert.equal(workspacePayload.workspace.workspaceCount, 2);
    assert.ok(workspacePayload.workspace.index.workspaceFingerprint);
    assert.deepEqual(
      workspacePayload.workspace.workspaces.map((workspace) => workspace.root),
      [firstRoot, secondRoot],
    );
    assert.deepEqual(
      workspacePayload.workspace.workspaces.map((workspace) => workspace.searchableFileCount),
      [1, 1],
    );
    assert.ok(workspacePayload.workspace.workspaces.every((workspace) => workspace.index.workspaceFingerprint));
    assert.deepEqual(
      workspacePayload.workspace.workspaces.map((workspace) => workspace.index.indexedFileCount),
      [1, 1],
    );
    assert.equal(workspacePayload.workspace.searchableFileCount, 2);
    assert.equal(workspacePayload.workspace.unsupportedFileCount, 2);
    assert.deepEqual(
      workspacePayload.searchableFilesSample.map((file) => ({
        workspaceRoot: file.workspaceRoot,
        relativePath: file.relativePath,
      })),
      [
        { workspaceRoot: firstRoot, relativePath: "src/app.ts" },
        { workspaceRoot: secondRoot, relativePath: "src/app.ts" },
      ],
    );

    const capabilitiesResult = await client.callTool({
      name: "get_capabilities",
      arguments: {},
    });
    const capabilities = capabilitiesResult.structuredContent as {
      workspace: {
        root: string | null;
        roots: string[];
        workspaceCount: number;
        workspaces: Array<{ root: string; index: { workspaceFingerprint: string | null } }>;
      };
      supportedQueryTypes: string[];
      toolNames: string[];
    };
    assert.equal(capabilities.workspace.root, firstRoot);
    assert.deepEqual(capabilities.workspace.roots, [firstRoot, secondRoot]);
    assert.equal(capabilities.workspace.workspaceCount, 2);
    assert.deepEqual(
      capabilities.workspace.workspaces.map((workspace) => workspace.root),
      [firstRoot, secondRoot],
    );
    assert.ok(capabilities.workspace.workspaces.every((workspace) => workspace.index.workspaceFingerprint));
    assert.ok(capabilities.supportedQueryTypes.includes("relationship_view"));
    assert.ok(capabilities.toolNames.includes("get_relationship_view"));

    const healthResult = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    const health = healthResult.structuredContent as {
      supportedQueryTypes: string[];
      toolNames: string[];
      workspace: {
        root: string | null;
        roots: string[];
        workspaceCount: number;
        index: { workspaceFingerprint: string | null };
        workspaces: Array<{ root: string; index: { workspaceFingerprint: string | null } }>;
      };
    };
    assert.equal(health.workspace.root, firstRoot);
    assert.deepEqual(health.workspace.roots, [firstRoot, secondRoot]);
    assert.equal(health.workspace.workspaceCount, 2);
    assert.ok(health.workspace.index.workspaceFingerprint);
    assert.deepEqual(
      health.workspace.workspaces.map((workspace) => workspace.root),
      [firstRoot, secondRoot],
    );
    assert.ok(health.workspace.workspaces.every((workspace) => workspace.index.workspaceFingerprint));
    assert.ok(health.supportedQueryTypes.includes("relationship_view"));
    assert.ok(health.toolNames.includes("get_relationship_view"));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
