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
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `tree-sitter-mcp-relationship-${label}-`));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "shared.ts"), [
    "export function sanitizeName(name: string): string {",
    `  return '${label}:' + name.trim();`,
    "}",
    "",
    "export function formatName(name: string): string {",
    "  return name.toUpperCase();",
    "}",
    "",
    "export function helper(name: string): string {",
    "  const formatter = formatName;",
    "  return formatName(sanitizeName(name));",
    "}",
    "",
    "export function bridge(name: string): string {",
    "  return helper(sanitizeName(name));",
    "}",
    "",
    "export function rememberHelper(): typeof helper {",
    "  return helper;",
    "}",
    "",
    "render(helper);",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "view.tsx"), [
    "import { helper } from './shared';",
    "export function Panel(): JSX.Element {",
    "  return <button onClick={() => helper('tsx')}>Run</button>;",
    "}",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "README.md"), `${label} docs\n`);
  return workspaceRoot;
}

type RelationshipEdge = {
  relationshipKind: string;
  hopCount: number;
  relatedSymbol: {
    name: string;
    workspaceRoot: string;
    relativePath: string;
    selectionRange: { start: { line: number } };
  };
  evidence: {
    workspaceRoot: string;
    relativePath: string;
    selectionRange: { start: { line: number } };
  };
};

function sumReturnedResults(workspaceBreakdown: Array<{ returnedResults: number }>): number {
  return workspaceBreakdown.reduce((sum, workspace) => sum + workspace.returnedResults, 0);
}

test("federated relationship views preserve workspace attribution and avoid duplicate-name bleed across roots", async () => {
  const firstRoot = await createFederatedWorkspaceFixture("first");
  const secondRoot = await createFederatedWorkspaceFixture("second");
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-relationship-federated-index-"));
  const client = new Client({
    name: "tree-sitter-mcp-federated-relationship-test",
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
        workspaces: Array<{ root: string }>;
      };
    };
    assert.equal(setWorkspacePayload.workspace.root, firstRoot);
    assert.deepEqual(setWorkspacePayload.workspace.roots, [firstRoot, secondRoot]);
    assert.equal(setWorkspacePayload.workspace.workspaceCount, 2);
    assert.deepEqual(
      setWorkspacePayload.workspace.workspaces.map((workspace) => workspace.root),
      [firstRoot, secondRoot],
    );

    const definitionSearchResult = await client.callTool({
      name: "search_definitions",
      arguments: {
        query: "helper",
        symbolKinds: ["function"],
        limit: 10,
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
      }>;
    };
    assert.deepEqual(definitionSearchPayload.workspaceRoots, [firstRoot, secondRoot]);
    const helperDefinitions = definitionSearchPayload.results
      .filter((result) => result.name === "helper" && result.relativePath === "src/shared.ts")
      .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));
    assert.deepEqual(
      helperDefinitions.map((result) => `${result.workspaceRoot}:${result.relativePath}:${result.name}`),
      [
        `${firstRoot}:src/shared.ts:helper`,
        `${secondRoot}:src/shared.ts:helper`,
      ],
    );

    const resolvedSecondHelperResult = await client.callTool({
      name: "resolve_definition",
      arguments: {
        symbol: helperDefinitions[1],
      },
    });
    assert.notEqual(resolvedSecondHelperResult.isError, true);
    const resolvedSecondHelperPayload = resolvedSecondHelperResult.structuredContent as {
      match: {
        name: string;
        workspaceRoot: string;
        relativePath: string;
      } | null;
      diagnostic: { code: string } | null;
    };
    assert.equal(resolvedSecondHelperPayload.diagnostic, null);
    assert.equal(resolvedSecondHelperPayload.match?.name, "helper");
    assert.equal(resolvedSecondHelperPayload.match?.workspaceRoot, secondRoot);
    assert.equal(resolvedSecondHelperPayload.match?.relativePath, "src/shared.ts");

    const federatedRelationshipResult = await client.callTool({
      name: "get_relationship_view",
      arguments: {
        symbol: helperDefinitions[1],
        limit: 20,
      },
    });
    assert.notEqual(federatedRelationshipResult.isError, true);
    const federatedRelationshipPayload = federatedRelationshipResult.structuredContent as {
      workspaceRoot: string | null;
      workspaceRoots: string[];
      results: RelationshipEdge[];
      workspaceBreakdown: Array<{
        workspaceRoot: string;
        searchedFiles: number;
        matchedFiles: number;
        returnedResults: number;
      }>;
      pagination: { total: number; returned: number };
    };
    assert.equal(federatedRelationshipPayload.workspaceRoot, firstRoot);
    assert.deepEqual(federatedRelationshipPayload.workspaceRoots, [firstRoot, secondRoot]);
    assert.equal(federatedRelationshipPayload.pagination.returned, federatedRelationshipPayload.results.length);
    assert.equal(federatedRelationshipPayload.pagination.total, federatedRelationshipPayload.results.length);
    assert.ok(federatedRelationshipPayload.results.some((edge) =>
      edge.relationshipKind === "incoming_call"
      && edge.relatedSymbol.name === "bridge"
      && edge.relatedSymbol.workspaceRoot === firstRoot));
    assert.ok(federatedRelationshipPayload.results.some((edge) =>
      edge.relationshipKind === "incoming_call"
      && edge.relatedSymbol.name === "bridge"
      && edge.relatedSymbol.workspaceRoot === secondRoot));
    assert.ok(federatedRelationshipPayload.results.some((edge) =>
      edge.relationshipKind === "outgoing_reference"
      && edge.relatedSymbol.name === "formatName"
      && edge.relatedSymbol.workspaceRoot === secondRoot
      && edge.evidence.workspaceRoot === secondRoot));
    assert.ok(federatedRelationshipPayload.results.some((edge) =>
      edge.relationshipKind === "outgoing_call"
      && edge.relatedSymbol.name === "formatName"
      && edge.relatedSymbol.workspaceRoot === secondRoot
      && edge.evidence.workspaceRoot === secondRoot));
    assert.ok(federatedRelationshipPayload.results.every((edge) =>
      [firstRoot, secondRoot].includes(edge.relatedSymbol.workspaceRoot)));
    assert.ok(federatedRelationshipPayload.results.every((edge) =>
      [firstRoot, secondRoot].includes(edge.evidence.workspaceRoot)));
    assert.equal(
      sumReturnedResults(federatedRelationshipPayload.workspaceBreakdown),
      federatedRelationshipPayload.results.length,
    );
    assert.deepEqual(
      federatedRelationshipPayload.workspaceBreakdown.map((workspace) => workspace.workspaceRoot),
      [firstRoot, secondRoot],
    );

    const narrowedRelationshipResult = await client.callTool({
      name: "get_relationship_view",
      arguments: {
        symbol: helperDefinitions[1],
        workspaceRoots: [secondRoot],
        relationshipKinds: ["incoming_call"],
      },
    });
    assert.notEqual(narrowedRelationshipResult.isError, true);
    const narrowedRelationshipPayload = narrowedRelationshipResult.structuredContent as {
      workspaceRoots: string[];
      results: RelationshipEdge[];
      workspaceBreakdown: Array<{
        workspaceRoot: string;
        searchedFiles: number;
        matchedFiles: number;
        returnedResults: number;
      }>;
    };
    assert.deepEqual(narrowedRelationshipPayload.workspaceRoots, [secondRoot]);
    assert.ok(narrowedRelationshipPayload.results.length > 0);
    assert.ok(narrowedRelationshipPayload.results.every((edge) => edge.relationshipKind === "incoming_call"));
    assert.ok(narrowedRelationshipPayload.results.every((edge) => edge.relatedSymbol.workspaceRoot === secondRoot));
    assert.ok(narrowedRelationshipPayload.results.every((edge) => edge.evidence.workspaceRoot === secondRoot));
    assert.deepEqual(narrowedRelationshipPayload.workspaceBreakdown, [
      {
        workspaceRoot: secondRoot,
        searchedFiles: 2,
        matchedFiles: 2,
        returnedResults: narrowedRelationshipPayload.results.length,
      },
    ]);

    const expandedRelationshipResult = await client.callTool({
      name: "get_relationship_view",
      arguments: {
        symbol: helperDefinitions[1],
        maxDepth: 2,
      },
    });
    assert.notEqual(expandedRelationshipResult.isError, true);
    const expandedRelationshipPayload = expandedRelationshipResult.structuredContent as {
      results: RelationshipEdge[];
    };
    assert.ok(expandedRelationshipPayload.results.some((edge) =>
      edge.hopCount === 2
      && edge.relationshipKind === "outgoing_call"
      && edge.relatedSymbol.name === "sanitizeName"
      && edge.relatedSymbol.workspaceRoot === secondRoot
      && edge.evidence.workspaceRoot === secondRoot
      && edge.evidence.selectionRange.start.line === 15));
    assert.ok(!expandedRelationshipPayload.results.some((edge) =>
      edge.hopCount === 2
      && edge.relatedSymbol.name === "sanitizeName"
      && edge.relatedSymbol.workspaceRoot === firstRoot
      && edge.evidence.workspaceRoot === secondRoot));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
