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
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-relationships-e2e-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "core.ts"), [
    "export function sanitizeName(name: string): string {",
    "  return name.trim();",
    "}",
    "",
    "export function formatName(name: string): string {",
    "  return name.toUpperCase();",
    "}",
    "",
    "export function helper(name: string): string {",
    "  const formatter = formatName;",
    "  helper(name);",
    "  missingExternal(name);",
    "  return formatName(name);",
    "}",
    "",
    "export class Greeter {",
    "  sayHello(name: string): string {",
    "    const cleaned = sanitizeName(name);",
    "    consumeHelper(helper);",
    "    return helper(cleaned);",
    "  }",
    "}",
    "",
    "export function orchestrate(name: string): string {",
    "  const cleaned = sanitizeName(name);",
    "  return helper(cleaned);",
    "}",
    "",
    "render(helper);",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "view.tsx"), [
    "import { helper } from './core';",
    "export function Panel(): JSX.Element {",
    "  return <button onClick={() => helper('tsx')}>Run</button>;",
    "}",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "README.md"), "docs\n");
  return workspaceRoot;
}

async function readWorkspaceSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function walk(currentPath: string, relativeDir = ""): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;

      if (entry.isDirectory()) {
        await walk(entryPath, relativePath);
        continue;
      }

      snapshot[relativePath] = await fs.readFile(entryPath, "utf8");
    }
  }

  await walk(root);
  return snapshot;
}

type RelationshipEdge = {
  relationshipKind: string;
  hopCount: number;
  relatedSymbol: {
    name: string;
    workspaceRoot: string;
    relativePath: string;
    selectionRange: { start: { line: number; offset: number } };
  };
  evidence: {
    workspaceRoot: string;
    relativePath: string;
    selectionRange: { start: { line: number; offset: number } };
    snippet: string;
    contextSnippet?: { text: string } | null;
  };
};

function findRelationshipEdge(
  edges: RelationshipEdge[],
  relationshipKind: string,
  relatedName: string,
  hopCount = 1,
): RelationshipEdge {
  const edge = edges.find((candidate) =>
    candidate.relationshipKind === relationshipKind
    && candidate.relatedSymbol.name === relatedName
    && candidate.hopCount === hopCount);

  assert.ok(edge, `Expected ${relationshipKind} edge for ${relatedName} at hop ${hopCount}.`);
  return edge;
}

test("relationship tools inspect direct and hop-2 relationships over stdio without mutating the workspace", async () => {
  const workspaceRoot = await createWorkspaceFixture();
  const beforeSnapshot = await readWorkspaceSnapshot(workspaceRoot);
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-relationship-tools-index-"));
  const client = new Client({
    name: "tree-sitter-mcp-relationship-tools-test",
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
    assert.notEqual(setWorkspaceResult.isError, true);
    const setWorkspacePayload = setWorkspaceResult.structuredContent as {
      workspace: {
        index: {
          workspaceFingerprint: string | null;
          lastBuiltAt: string | null;
        };
      };
    };
    assert.ok(setWorkspacePayload.workspace.index.workspaceFingerprint);
    assert.ok(setWorkspacePayload.workspace.index.lastBuiltAt);

    const definitionSearchResult = await client.callTool({
      name: "search_definitions",
      arguments: {
        query: "helper",
        language: "TypeScript",
        pathPrefix: ".\\src\\core.ts",
        symbolKinds: ["function"],
      },
    });
    assert.notEqual(definitionSearchResult.isError, true);
    const definitionSearchPayload = definitionSearchResult.structuredContent as {
      workspaceRoots: string[];
      results: Array<{
        name: string;
        kind: string;
        languageId: string;
        workspaceRoot: string;
        relativePath: string;
        selectionRange: { start: { line: number } };
      }>;
    };
    assert.deepEqual(definitionSearchPayload.workspaceRoots, [workspaceRoot]);
    assert.deepEqual(definitionSearchPayload.results.map((result) => `${result.relativePath}:${result.name}`), [
      "src/core.ts:helper",
    ]);
    assert.equal(definitionSearchPayload.results[0]?.selectionRange.start.line, 9);

    const relationshipResult = await client.callTool({
      name: "get_relationship_view",
      arguments: {
        symbol: definitionSearchPayload.results[0],
      },
    });
    assert.notEqual(relationshipResult.isError, true);
    const relationshipPayload = relationshipResult.structuredContent as {
      workspaceRoot: string | null;
      workspaceRoots: string[];
      seed: {
        name: string;
        workspaceRoot: string;
        relativePath: string;
        selectionRange: { start: { line: number } };
      } | null;
      results: RelationshipEdge[];
      pagination: {
        limit: number;
        offset: number;
        returned: number;
        total: number;
        hasMore: boolean;
        nextOffset: number | null;
      };
      workspaceBreakdown: Array<{
        workspaceRoot: string;
        searchedFiles: number;
        matchedFiles: number;
        returnedResults: number;
      }>;
      freshness: {
        state: string;
        workspaceFingerprint: string | null;
      };
      diagnostics: Array<{ code: string; message: string }>;
    };
    assert.equal(relationshipPayload.workspaceRoot, workspaceRoot);
    assert.deepEqual(relationshipPayload.workspaceRoots, [workspaceRoot]);
    assert.equal(relationshipPayload.seed?.name, "helper");
    assert.equal(relationshipPayload.seed?.workspaceRoot, workspaceRoot);
    assert.equal(relationshipPayload.seed?.relativePath, "src/core.ts");
    assert.equal(relationshipPayload.seed?.selectionRange.start.line, 9);
    assert.equal(relationshipPayload.freshness.state, "fresh");
    assert.equal(
      relationshipPayload.freshness.workspaceFingerprint,
      setWorkspacePayload.workspace.index.workspaceFingerprint,
    );
    assert.deepEqual(relationshipPayload.pagination, {
      limit: 50,
      offset: 0,
      returned: 6,
      total: 6,
      hasMore: false,
      nextOffset: null,
    });
    assert.deepEqual(relationshipPayload.workspaceBreakdown, [
      {
        workspaceRoot,
        searchedFiles: 2,
        matchedFiles: 2,
        returnedResults: 6,
      },
    ]);

    const incomingCall = findRelationshipEdge(relationshipPayload.results, "incoming_call", "sayHello");
    assert.equal(incomingCall.relatedSymbol.workspaceRoot, workspaceRoot);
    assert.equal(incomingCall.relatedSymbol.relativePath, "src/core.ts");
    assert.equal(incomingCall.relatedSymbol.selectionRange.start.line, 17);
    assert.equal(incomingCall.evidence.workspaceRoot, workspaceRoot);
    assert.equal(incomingCall.evidence.relativePath, "src/core.ts");
    assert.equal(incomingCall.evidence.selectionRange.start.line, 20);
    assert.match(incomingCall.evidence.snippet, /helper/);
    assert.match(incomingCall.evidence.contextSnippet?.text ?? "", /helper\(cleaned\)/);

    const incomingReference = findRelationshipEdge(relationshipPayload.results, "incoming_reference", "sayHello");
    assert.equal(incomingReference.relatedSymbol.selectionRange.start.line, 17);
    assert.equal(incomingReference.evidence.selectionRange.start.line, 19);
    assert.match(incomingReference.evidence.contextSnippet?.text ?? "", /consumeHelper\(helper\)/);

    const outgoingCall = findRelationshipEdge(relationshipPayload.results, "outgoing_call", "formatName");
    assert.equal(outgoingCall.relatedSymbol.workspaceRoot, workspaceRoot);
    assert.equal(outgoingCall.relatedSymbol.relativePath, "src/core.ts");
    assert.equal(outgoingCall.relatedSymbol.selectionRange.start.line, 5);
    assert.equal(outgoingCall.evidence.selectionRange.start.line, 13);
    assert.match(outgoingCall.evidence.contextSnippet?.text ?? "", /formatName\(name\)/);

    const outgoingReference = findRelationshipEdge(relationshipPayload.results, "outgoing_reference", "formatName");
    assert.equal(outgoingReference.relatedSymbol.selectionRange.start.line, 5);
    assert.equal(outgoingReference.evidence.selectionRange.start.line, 10);
    assert.match(outgoingReference.evidence.contextSnippet?.text ?? "", /formatter = formatName/);

    assert.ok(relationshipPayload.results.some((edge) =>
      edge.relationshipKind === "incoming_call" && edge.relatedSymbol.name === "orchestrate"));
    assert.ok(relationshipPayload.results.some((edge) =>
      edge.relationshipKind === "incoming_call" && edge.relatedSymbol.name === "Panel"));

    const firstPageResult = await client.callTool({
      name: "get_relationship_view",
      arguments: {
        symbol: definitionSearchPayload.results[0],
        limit: 2,
      },
    });
    assert.notEqual(firstPageResult.isError, true);
    const firstPagePayload = firstPageResult.structuredContent as {
      pagination: {
        limit: number;
        offset: number;
        returned: number;
        total: number;
        hasMore: boolean;
        nextOffset: number | null;
      };
      results: RelationshipEdge[];
    };
    assert.deepEqual(firstPagePayload.pagination, {
      limit: 2,
      offset: 0,
      returned: 2,
      total: 6,
      hasMore: true,
      nextOffset: 2,
    });
    assert.deepEqual(
      firstPagePayload.results.map((edge) => `${edge.relationshipKind}:${edge.relatedSymbol.name}`),
      [
        "incoming_call:sayHello",
        "incoming_call:orchestrate",
      ],
    );

    const secondPageResult = await client.callTool({
      name: "get_relationship_view",
      arguments: {
        symbol: definitionSearchPayload.results[0],
        limit: 2,
        offset: 2,
      },
    });
    assert.notEqual(secondPageResult.isError, true);
    const secondPagePayload = secondPageResult.structuredContent as {
      pagination: {
        limit: number;
        offset: number;
        returned: number;
        total: number;
        hasMore: boolean;
        nextOffset: number | null;
      };
      results: RelationshipEdge[];
    };
    assert.deepEqual(secondPagePayload.pagination, {
      limit: 2,
      offset: 2,
      returned: 2,
      total: 6,
      hasMore: true,
      nextOffset: 4,
    });
    assert.deepEqual(
      secondPagePayload.results.map((edge) => `${edge.relationshipKind}:${edge.relatedSymbol.name}`),
      [
        "incoming_call:Panel",
        "incoming_reference:sayHello",
      ],
    );

    const expandedResult = await client.callTool({
      name: "get_relationship_view",
      arguments: {
        symbol: definitionSearchPayload.results[0],
        maxDepth: 2,
      },
    });
    assert.notEqual(expandedResult.isError, true);
    const expandedPayload = expandedResult.structuredContent as {
      workspaceRoots: string[];
      results: RelationshipEdge[];
      pagination: { total: number };
      diagnostics: Array<{ message: string }>;
    };
    assert.deepEqual(expandedPayload.workspaceRoots, [workspaceRoot]);
    const secondHopSanitizeName = findRelationshipEdge(expandedPayload.results, "outgoing_call", "sanitizeName", 2);
    assert.equal(secondHopSanitizeName.relatedSymbol.workspaceRoot, workspaceRoot);
    assert.equal(secondHopSanitizeName.relatedSymbol.relativePath, "src/core.ts");
    assert.equal(secondHopSanitizeName.relatedSymbol.selectionRange.start.line, 1);
    assert.equal(secondHopSanitizeName.evidence.selectionRange.start.line, 18);
    assert.ok(expandedPayload.pagination.total > relationshipPayload.pagination.total);
    assert.ok(expandedPayload.results.every((edge) => edge.hopCount <= 2));
    assert.ok(expandedPayload.diagnostics.some((diagnostic) => diagnostic.message.includes("self-relationship")));
    assert.ok(expandedPayload.diagnostics.some((diagnostic) => diagnostic.message.includes("could not be resolved")));
    assert.ok(expandedPayload.diagnostics.some((diagnostic) => diagnostic.message.includes("not enclosed by a named owner symbol")));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }

  const afterSnapshot = await readWorkspaceSnapshot(workspaceRoot);
  assert.deepEqual(afterSnapshot, beforeSnapshot);
});
