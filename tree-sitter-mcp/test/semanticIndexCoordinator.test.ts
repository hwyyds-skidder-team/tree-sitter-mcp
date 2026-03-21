import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { createSemanticIndexCoordinator } from "../src/indexing/semanticIndexCoordinator.js";
import type { IndexedFileSemanticRecord } from "../src/indexing/indexTypes.js";
import { createWorkspaceFingerprint } from "../src/indexing/workspaceFingerprint.js";
import { createServerContext } from "../src/server/serverContext.js";
import { summarizeWorkspace } from "../src/workspace/workspaceState.js";

function createRecord(workspaceRoot: string): IndexedFileSemanticRecord {
  return {
    path: path.join(workspaceRoot, "src", "index.ts"),
    relativePath: "src/index.ts",
    languageId: "typescript",
    grammarName: "typescript",
    contentHash: "sha1-index",
    symbolCount: 1,
    updatedAt: "2026-03-21T00:00:00.000Z",
  };
}

test("semantic index coordinator reports rebuilding during bootstrap and shapes workspace summaries", async () => {
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-index-root-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-workspace-"));
  const config = loadRuntimeConfig({
    ...process.env,
    TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
  });
  const context = createServerContext(config);

  assert.equal(context.semanticIndex.getSummary().state, "rebuilding");
  assert.equal(context.workspace.index.state, "rebuilding");

  context.semanticIndex.replaceWorkspace({
    root: workspaceRoot,
    exclusions: ["node_modules"],
  });
  const loadResult = await context.semanticIndex.loadPersistedIndex();
  const workspaceSummary = summarizeWorkspace(context.workspace);
  const expectedFingerprint = createWorkspaceFingerprint({
    root: workspaceRoot,
    exclusions: ["node_modules"],
    indexSchemaVersion: config.indexSchemaVersion,
  });

  assert.equal(loadResult.status, "missing");
  assert.equal(workspaceSummary.index.state, "rebuilding");
  assert.equal(workspaceSummary.index.workspaceFingerprint, expectedFingerprint);
});

test("semantic index coordinator transitions to fresh and refreshed when persistence succeeds", async () => {
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-index-root-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-workspace-"));
  const config = loadRuntimeConfig({
    ...process.env,
    TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
  });
  const coordinator = createSemanticIndexCoordinator(config, {
    now: (() => {
      const timestamps = [
        "2026-03-21T00:00:00.000Z",
        "2026-03-21T00:05:00.000Z",
      ];
      return () => timestamps.shift() ?? "2026-03-21T00:05:00.000Z";
    })(),
  });
  coordinator.replaceWorkspace({
    root: workspaceRoot,
    exclusions: ["node_modules"],
  });

  const freshSummary = await coordinator.markFresh([createRecord(workspaceRoot)]);
  assert.equal(freshSummary.state, "fresh");
  assert.equal(freshSummary.lastBuiltAt, "2026-03-21T00:00:00.000Z");
  assert.equal(freshSummary.lastRefreshedAt, null);

  const refreshedSummary = await coordinator.markRefreshed([createRecord(workspaceRoot)]);
  assert.equal(refreshedSummary.state, "refreshed");
  assert.equal(refreshedSummary.lastBuiltAt, "2026-03-21T00:00:00.000Z");
  assert.equal(refreshedSummary.lastRefreshedAt, "2026-03-21T00:05:00.000Z");
});

test("semantic index coordinator marks degraded when persistence rejects an update", async () => {
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-index-root-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-workspace-"));
  const config = loadRuntimeConfig({
    ...process.env,
    TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
  });
  const coordinator = createSemanticIndexCoordinator(config, {
    saveWorkspaceIndex: async () => {
      throw new Error("disk full");
    },
  });
  coordinator.replaceWorkspace({
    root: workspaceRoot,
    exclusions: ["node_modules"],
  });

  const degradedSummary = await coordinator.markFresh([createRecord(workspaceRoot)]);
  assert.equal(degradedSummary.state, "degraded");
  assert.equal(degradedSummary.degradedFileCount, 1);
  assert.equal(degradedSummary.indexedFileCount, 1);
});
