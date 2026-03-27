import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const serverEntry = path.join(packageRoot, "dist", "index.js");

test("compiled server bootstraps over stdio and lists tools", async () => {
  const client = new Client({
    name: "tree-sitter-mcp-bootstrap-test",
    version: "0.1.0",
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: packageRoot,
    env: {
      ...process.env,
      TREE_SITTER_MCP_VERSION: "0.1.0-test",
    },
  });

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    assert.ok(Array.isArray(listed.tools));
    assert.ok(listed.tools.length >= 10);

    const toolNames = new Set(listed.tools.map((tool) => tool.name));
    assert.ok(toolNames.has("tree_sitter_get_server_info"));
    assert.ok(toolNames.has("set_workspace"));
    assert.ok(toolNames.has("get_capabilities"));
    assert.ok(toolNames.has("get_health"));
    assert.ok(toolNames.has("list_file_symbols"));
    assert.ok(toolNames.has("search_workspace_symbols"));
    assert.ok(toolNames.has("search_definitions"));
    assert.ok(toolNames.has("resolve_definition"));
    assert.ok(toolNames.has("search_references"));
    assert.ok(toolNames.has("get_relationship_view"));
    const setWorkspaceTool = listed.tools.find((tool) => tool.name === "set_workspace");
    assert.equal(setWorkspaceTool?.name, "set_workspace");
    assert.deepEqual(Object.keys(setWorkspaceTool?.inputSchema.properties ?? {}).sort(), [
      "additionalExclusions",
      "root",
      "roots",
    ]);
    const relationshipTool = listed.tools.find((tool) => tool.name === "get_relationship_view");
    assert.equal(relationshipTool?.name, "get_relationship_view");
    assert.match(relationshipTool?.description ?? "", /read-only impact hop/i);
    assert.deepEqual(Object.keys(relationshipTool?.inputSchema.properties ?? {}).sort(), [
      "language",
      "limit",
      "lookup",
      "maxDepth",
      "offset",
      "relationshipKinds",
      "symbol",
      "workspaceRoots",
    ]);

    const invalidWorkspaceCall = await client.callTool({
      name: "set_workspace",
      arguments: {},
    });
    assert.equal(invalidWorkspaceCall.isError, true);
    assert.match(invalidWorkspaceCall.content[0]?.type === "text" ? invalidWorkspaceCall.content[0].text : "", /Either root or roots is required/);

    const invalidRelationshipCall = await client.callTool({
      name: "get_relationship_view",
      arguments: {},
    });
    assert.equal(invalidRelationshipCall.isError, true);
    assert.match(
      invalidRelationshipCall.content[0]?.type === "text" ? invalidRelationshipCall.content[0].text : "",
      /Provide a relationship seed via symbol or lookup/,
    );

    const callResult = await client.callTool({
      name: "tree_sitter_get_server_info",
      arguments: {},
    });
    const payload = callResult.structuredContent as {
      eagerIndexing: boolean;
      parserMode: string;
      index: { indexMode: string; workspaceFingerprint: string | null };
    };
    assert.equal(payload.eagerIndexing, true);
    assert.equal(payload.parserMode, "on_demand");
    assert.equal(payload.index.indexMode, "persistent_disk");
    assert.equal(payload.index.workspaceFingerprint, null);

    const textBlock = callResult.content.find((item) => item.type === "text");
    assert.ok(textBlock && "text" in textBlock);
    assert.match(textBlock.text, /stdio/);
    assert.match(textBlock.text, /on_demand/);
    assert.match(textBlock.text, /eagerIndexing/);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
