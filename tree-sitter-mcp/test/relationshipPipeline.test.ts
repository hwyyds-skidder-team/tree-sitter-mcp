import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { getRelationshipView } from "../src/relationships/getRelationshipView.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverConfiguredWorkspaces } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createPrimaryWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-relationship-primary-"));
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

  return workspaceRoot;
}

async function createSecondaryWorkspaceFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-relationship-secondary-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "consumer.ts"), [
    "export function crossWorkspaceUse(name: string): string {",
    "  return helper(name);",
    "}",
    "",
  ].join("\n"));

  return workspaceRoot;
}

async function createPreparedContext(workspaceRoots: readonly string[]) {
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-relationship-index-"));
  const context = createServerContext(loadRuntimeConfig({
    ...process.env,
    TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
  }));
  const discovery = await discoverConfiguredWorkspaces(
    [...workspaceRoots],
    context.config.defaultExclusions,
    context.languageRegistry,
  );

  applyWorkspaceSnapshot(context.workspace, {
    root: workspaceRoots[0] ?? null,
    roots: [...workspaceRoots],
    workspaces: discovery.workspaces.map((workspace) => ({
      root: workspace.root,
      exclusions: context.config.defaultExclusions,
      searchableFileCount: workspace.searchableFiles.length,
      unsupportedFileCount: workspace.unsupportedFiles.length,
    })),
    exclusions: context.config.defaultExclusions,
    searchableFiles: discovery.searchableFiles,
    unsupportedFiles: discovery.unsupportedFiles,
  });
  context.semanticIndex.replaceWorkspaces(
    workspaceRoots.map((root) => ({
      root,
      exclusions: context.config.defaultExclusions,
    })),
  );
  await context.semanticIndex.ensureReady(context);

  return context;
}

test("getRelationshipView produces direct incoming and outgoing edges from indexed evidence", async () => {
  const primaryRoot = await createPrimaryWorkspaceFixture();
  const secondaryRoot = await createSecondaryWorkspaceFixture();
  const context = await createPreparedContext([primaryRoot, secondaryRoot]);

  const result = await getRelationshipView(context, {
    lookup: {
      name: "helper",
      languageId: "typescript",
      workspaceRoot: primaryRoot,
      kind: "function",
    },
  });

  assert.equal(result.diagnostic, null);
  assert.equal(result.target?.name, "helper");
  assert.ok(result.edges.some((edge) =>
    edge.relationshipKind === "incoming_call"
    && edge.relatedSymbol.name === "sayHello"
    && edge.relatedSymbol.relativePath === "src/core.ts"));
  assert.ok(result.edges.some((edge) =>
    edge.relationshipKind === "incoming_call"
    && edge.relatedSymbol.name === "orchestrate"));
  assert.ok(result.edges.some((edge) =>
    edge.relationshipKind === "incoming_call"
    && edge.relatedSymbol.name === "Panel"
    && edge.relatedSymbol.languageId === "tsx"));
  assert.ok(result.edges.some((edge) =>
    edge.relationshipKind === "incoming_call"
    && edge.relatedSymbol.name === "crossWorkspaceUse"
    && edge.relatedSymbol.workspaceRoot === secondaryRoot));
  assert.ok(result.edges.some((edge) =>
    edge.relationshipKind === "incoming_reference"
    && edge.relatedSymbol.name === "sayHello"));
  assert.ok(result.edges.some((edge) =>
    edge.relationshipKind === "outgoing_call"
    && edge.relatedSymbol.name === "formatName"));
  assert.ok(result.edges.some((edge) =>
    edge.relationshipKind === "outgoing_reference"
    && edge.relatedSymbol.name === "formatName"));
  assert.ok(result.edges.every((edge) => edge.relatedSymbol.workspaceRoot.length > 0));
  assert.ok(result.edges.every((edge) => edge.evidence.workspaceRoot.length > 0));
});

test("getRelationshipView applies relationshipKinds, workspaceRoots, language, and pagination before returning results", async () => {
  const primaryRoot = await createPrimaryWorkspaceFixture();
  const secondaryRoot = await createSecondaryWorkspaceFixture();
  const context = await createPreparedContext([primaryRoot, secondaryRoot]);

  const outgoingReferenceOnly = await getRelationshipView(context, {
    lookup: {
      name: "helper",
      languageId: "typescript",
      workspaceRoot: primaryRoot,
      kind: "function",
    },
    relationshipKinds: ["outgoing_reference"],
  });

  assert.deepEqual(
    [...new Set(outgoingReferenceOnly.edges.map((edge) => edge.relationshipKind))],
    ["outgoing_reference"],
  );
  assert.deepEqual(outgoingReferenceOnly.edges.map((edge) => edge.relatedSymbol.name), ["formatName"]);

  const primaryIncomingCalls = await getRelationshipView(context, {
    lookup: {
      name: "helper",
      languageId: "typescript",
      workspaceRoot: primaryRoot,
      kind: "function",
    },
    workspaceRoots: [primaryRoot],
    relationshipKinds: ["incoming_call"],
    limit: 1,
  });

  assert.equal(primaryIncomingCalls.pagination.returned, 1);
  assert.equal(primaryIncomingCalls.pagination.total, 3);
  assert.equal(primaryIncomingCalls.edges.length, 1);

  const secondaryIncomingCalls = await getRelationshipView(context, {
    lookup: {
      name: "helper",
      languageId: "typescript",
      workspaceRoot: primaryRoot,
      kind: "function",
    },
    workspaceRoots: [secondaryRoot],
    relationshipKinds: ["incoming_call"],
  });

  assert.deepEqual(
    secondaryIncomingCalls.edges.map((edge) => `${edge.relatedSymbol.workspaceRoot}:${edge.relatedSymbol.name}`),
    [`${secondaryRoot}:crossWorkspaceUse`],
  );

  const tsxIncomingCalls = await getRelationshipView(context, {
    lookup: {
      name: "helper",
      languageId: "typescript",
      workspaceRoot: primaryRoot,
      kind: "function",
    },
    workspaceRoots: [primaryRoot],
    language: "tsx",
    relationshipKinds: ["incoming_call"],
    limit: 5,
  });

  assert.equal(tsxIncomingCalls.pagination.total, 1);
  assert.deepEqual(tsxIncomingCalls.edges.map((edge) => edge.relatedSymbol.name), ["Panel"]);
});

test("getRelationshipView expands one extra hop and skips duplicate, self, unresolved, and ownerless edges with diagnostics", async () => {
  const primaryRoot = await createPrimaryWorkspaceFixture();
  const secondaryRoot = await createSecondaryWorkspaceFixture();
  const context = await createPreparedContext([primaryRoot, secondaryRoot]);

  const result = await getRelationshipView(context, {
    lookup: {
      name: "helper",
      languageId: "typescript",
      workspaceRoot: primaryRoot,
      kind: "function",
    },
    maxDepth: 2,
  });

  assert.equal(result.diagnostic, null);
  assert.ok(result.edges.some((edge) =>
    edge.hopCount === 2
    && edge.relationshipKind === "outgoing_call"
    && edge.relatedSymbol.name === "sanitizeName"));
  assert.ok(result.edges.every((edge) => edge.hopCount <= 2));
  assert.equal(
    new Set(result.edges.map((edge) => JSON.stringify([
      edge.relationshipKind,
      edge.relatedSymbol.workspaceRoot,
      edge.relatedSymbol.relativePath,
      edge.relatedSymbol.selectionRange.start.offset,
      edge.evidence.workspaceRoot,
      edge.evidence.relativePath,
      edge.evidence.selectionRange.start.offset,
      edge.hopCount,
    ]))).size,
    result.edges.length,
  );
  assert.ok(!result.edges.some((edge) =>
    edge.hopCount === 1
    && edge.relationshipKind === "outgoing_call"
    && edge.relatedSymbol.name === "helper"));
  assert.ok(!result.edges.some((edge) => edge.relatedSymbol.name === "missingExternal"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("self-relationship")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("could not be resolved")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("not enclosed by a named owner symbol")));
});
