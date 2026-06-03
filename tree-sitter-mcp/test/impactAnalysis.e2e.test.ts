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

async function createImpactWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-impact-e2e-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "engine.ts"), [
    "export function coreHelper(name: string): string {",
    "  return name.trim();",
    "}",
    "",
    "export function primaryProcessor(name: string): string {",
    "  const cleaned = coreHelper(name);",
    "  return secondaryFormatter(cleaned);",
    "}",
    "",
    "export function secondaryFormatter(name: string): string {",
    "  return name.toUpperCase();",
    "}",
    "",
    "export function deepTarget(name: string): string {",
    "  return secondaryFormatter(name);",
    "}",
    "",
    "export function refOnly(name: string): string {",
    "  const f = secondaryFormatter;",
    "  return f(name);",
    "}",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(workspaceRoot, "src", "callers.ts"), [
    "import { primaryProcessor, coreHelper } from './engine';",
    "",
    "export class ServiceCoordinator {",
    "  executeAction(input: string): string {",
    "    const result = primaryProcessor(input);",
    "    return this.enhanceResult(result);",
    "  }",
    "",
    "  enhanceResult(input: string): string {",
    "    return `[enhanced] ${input}`;",
    "  }",
    "}",
    "",
    "export function externalCaller(name: string): string {",
    "  return primaryProcessor(name);",
    "}",
    "",
    "export function shallowWrapper(name: string): string {",
    "  return externalCaller(name);",
    "}",
    "",
    "export function helperClient(name: string): string {",
    "  return coreHelper(name) + '_client';",
    "}",
    "",
  ].join("\n"));

  return workspaceRoot;
}

test("analyze_impact returns blast-radius view with prioritized targets over stdio", async () => {
  const workspaceRoot = await createImpactWorkspaceFixture();
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-impact-e2e-index-"));
  const client = new Client({
    name: "tree-sitter-mcp-impact-e2e-test",
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

    const definitionSearchResult = await client.callTool({
      name: "search_definitions",
      arguments: {
        query: "primaryProcessor",
        language: "TypeScript",
        symbolKinds: ["function"],
      },
    });
    assert.notEqual(definitionSearchResult.isError, true);
    const defPayload = definitionSearchResult.structuredContent as {
      results: Array<{
        name: string;
        kind: string;
        workspaceRoot: string;
        relativePath: string;
      }>;
    };
    assert.equal(defPayload.results.length, 1);
    assert.equal(defPayload.results[0]?.name, "primaryProcessor");

    const impactResult = await client.callTool({
      name: "analyze_impact",
      arguments: {
        symbol: defPayload.results[0],
        maxDepth: 2,
      },
    });
    assert.notEqual(impactResult.isError, true);

    const impactPayload = impactResult.structuredContent as {
      workspaceRoot: string | null;
      workspaceRoots: string[];
      seed: {
        name: string;
        workspaceRoot: string;
        relativePath: string;
      } | null;
      targets: Array<{
        symbol: { name: string; relativePath: string };
        direction: string;
        depth: number;
        confidence: string;
        severity: string;
        reason: string;
        relationshipKind: string;
        path: Array<{
          relationshipKind: string;
          fromSymbol: { name: string };
          toSymbol: { name: string };
        }>;
      }>;
      blastRadius: {
        totalTargets: number;
        criticalCount: number;
        highCount: number;
        mediumCount: number;
        lowCount: number;
        incomingCount: number;
        outgoingCount: number;
        affectedFiles: Array<{
          relativePath: string;
          workspaceRoot: string;
          targetCount: number;
          severity: string;
        }>;
        summary: string;
      };
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

    assert.equal(impactPayload.workspaceRoot, workspaceRoot);
    assert.deepEqual(impactPayload.workspaceRoots, [workspaceRoot]);
    assert.equal(impactPayload.seed?.name, "primaryProcessor");
    assert.equal(impactPayload.seed?.workspaceRoot, workspaceRoot);
    assert.equal(impactPayload.seed?.relativePath, "src/engine.ts");
    assert.equal(impactPayload.freshness.state, "fresh");

    // Should have blast radius data
    assert.ok(impactPayload.blastRadius.totalTargets > 0);
    assert.equal(
      impactPayload.blastRadius.criticalCount + impactPayload.blastRadius.highCount
      + impactPayload.blastRadius.mediumCount + impactPayload.blastRadius.lowCount,
      impactPayload.blastRadius.totalTargets,
    );
    assert.ok(impactPayload.blastRadius.summary.length > 0);
    assert.ok(impactPayload.blastRadius.affectedFiles.length > 0);

    // Direct outgoing callees should be critical
    const criticalTargets = impactPayload.targets.filter((t) => t.severity === "critical");
    assert.ok(criticalTargets.length > 0, "Should have critical targets");
    for (const t of criticalTargets) {
      assert.equal(t.direction, "outgoing");
      assert.equal(t.depth, 1);
      assert.equal(t.confidence, "high");
      assert.ok(t.reason.length > 0);
    }

    // coreHelper and secondaryFormatter should be direct callees of primaryProcessor
    assert.ok(impactPayload.targets.some((t) => t.symbol.name === "coreHelper" && t.severity === "critical"));
    assert.ok(impactPayload.targets.some((t) => t.symbol.name === "secondaryFormatter" && t.severity === "critical"));

    // Should have incoming callers (ServiceCoordinator.executeAction, externalCaller)
    const incomingCallers = impactPayload.targets.filter((t) => t.direction === "incoming");
    assert.ok(incomingCallers.length > 0, "Should have incoming callers");

    // Targets should be sorted by priority
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < impactPayload.targets.length; i++) {
      const prevSev = severityOrder[impactPayload.targets[i - 1].severity as keyof typeof severityOrder] ?? 99;
      const currSev = severityOrder[impactPayload.targets[i].severity as keyof typeof severityOrder] ?? 99;
      assert.ok(prevSev <= currSev,
        `Target #${i} (${impactPayload.targets[i].symbol.name}, ${impactPayload.targets[i].severity}) should not precede #${i - 1} (${impactPayload.targets[i - 1].symbol.name}, ${impactPayload.targets[i - 1].severity})`);
    }

    // Every target should have a path with proper attribution
    for (const target of impactPayload.targets) {
      assert.ok(target.path.length > 0);
      assert.ok(target.path.length <= 2);
      for (const step of target.path) {
        assert.ok(step.relationshipKind.length > 0);
        assert.ok(step.fromSymbol.name.length > 0);
        assert.ok(step.toSymbol.name.length > 0);
      }
    }

    // Verify workspace breakdown
    assert.equal(impactPayload.workspaceBreakdown.length, 1);
    assert.equal(impactPayload.workspaceBreakdown[0].workspaceRoot, workspaceRoot);
    assert.ok(impactPayload.workspaceBreakdown[0].returnedResults > 0);

    // Test with different maxDepth
    const shallowResult = await client.callTool({
      name: "analyze_impact",
      arguments: {
        symbol: defPayload.results[0],
        maxDepth: 1,
      },
    });
    assert.notEqual(shallowResult.isError, true);
    const shallowPayload = shallowResult.structuredContent as typeof impactPayload;
    // All targets should be at depth 1
    for (const target of shallowPayload.targets) {
      assert.equal(target.depth, 1, `${target.symbol.name} should be at depth 1`);
    }

    // Test pagination
    if (impactPayload.targets.length >= 3) {
      const page1Result = await client.callTool({
        name: "analyze_impact",
        arguments: {
          symbol: defPayload.results[0],
          maxDepth: 2,
          limit: 2,
          offset: 0,
        },
      });
      assert.notEqual(page1Result.isError, true);
      const page1Payload = page1Result.structuredContent as typeof impactPayload;
      assert.equal(page1Payload.targets.length, 2);
      assert.equal(page1Payload.pagination.hasMore, true);
      assert.equal(page1Payload.pagination.nextOffset, 2);
    }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
