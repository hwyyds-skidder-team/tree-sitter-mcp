import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import {
  loadWorkspaceIndex,
  saveWorkspaceIndex,
} from "../src/indexing/indexStorage.js";
import type { IndexedFileSemanticRecord, WorkspaceIndexManifest } from "../src/indexing/indexTypes.js";
import { createWorkspaceFingerprint } from "../src/indexing/workspaceFingerprint.js";

function createRange(startOffset: number, endOffset: number) {
  return {
    start: { line: 1, column: 1, offset: startOffset },
    end: { line: 1, column: 6, offset: endOffset },
  };
}

function createRecord(workspaceRoot: string): IndexedFileSemanticRecord {
  return {
    workspaceRoot,
    path: path.join(workspaceRoot, "src", "index.ts"),
    relativePath: "src/index.ts",
    languageId: "typescript",
    grammarName: "typescript",
    contentHash: "abc123",
    symbolCount: 2,
    updatedAt: "2026-03-21T00:00:00.000Z",
    mtimeMs: 123,
    sizeBytes: 456,
    symbols: [{
      name: "greet",
      kind: "function",
      languageId: "typescript",
      workspaceRoot,
      filePath: path.join(workspaceRoot, "src", "index.ts"),
      relativePath: "src/index.ts",
      range: createRange(0, 5),
      selectionRange: createRange(0, 5),
      snippet: "function greet()",
      containerName: null,
    }],
    definitions: [{
      name: "greet",
      kind: "function",
      languageId: "typescript",
      workspaceRoot,
      filePath: path.join(workspaceRoot, "src", "index.ts"),
      relativePath: "src/index.ts",
      range: createRange(0, 5),
      selectionRange: createRange(0, 5),
      snippet: "function greet()",
      containerName: null,
    }],
    references: [{
      name: "greet",
      referenceKind: "call",
      symbolKind: "function",
      languageId: "typescript",
      workspaceRoot,
      filePath: path.join(workspaceRoot, "src", "index.ts"),
      relativePath: "src/index.ts",
      range: createRange(6, 11),
      selectionRange: createRange(6, 11),
      containerName: null,
      snippet: "greet()",
      enclosingContext: null,
      contextSnippet: null,
    }],
    diagnostics: [],
  };
}

function createManifest(
  workspaceRoot: string,
  workspaceFingerprint: string,
  schemaVersion: string,
): WorkspaceIndexManifest {
  return {
    schemaVersion,
    workspaceFingerprint,
    workspaceRoot,
    exclusions: ["node_modules"],
    lastBuiltAt: "2026-03-21T00:00:00.000Z",
    lastRefreshedAt: null,
    state: "fresh",
    indexedFileCount: 1,
    degradedFiles: [],
  };
}

test("persistent index storage honors TREE_SITTER_MCP_INDEX_DIR and writes manifest + records", async () => {
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-index-root-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-workspace-"));
  const config = loadRuntimeConfig({
    ...process.env,
    TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
  });
  const workspaceFingerprint = createWorkspaceFingerprint({
    root: workspaceRoot,
    exclusions: ["node_modules"],
    indexSchemaVersion: config.indexSchemaVersion,
  });

  const manifest = createManifest(workspaceRoot, workspaceFingerprint, config.indexSchemaVersion);
  const records = [createRecord(workspaceRoot)];
  const savedLocation = await saveWorkspaceIndex(config, {
    manifest,
    records,
  });

  assert.equal(savedLocation.directory, path.join(indexRootDir, workspaceFingerprint));
  assert.equal(savedLocation.manifestPath, path.join(savedLocation.directory, "manifest.json"));
  assert.equal(savedLocation.recordsPath, path.join(savedLocation.directory, "records.json"));

  const manifestContents = await fs.readFile(savedLocation.manifestPath, "utf8");
  const recordsContents = await fs.readFile(savedLocation.recordsPath, "utf8");
  assert.match(manifestContents, /"schemaVersion": "1"/);
  assert.match(recordsContents, /"relativePath": "src\/index.ts"/);

  const loaded = await loadWorkspaceIndex(config, workspaceFingerprint);
  assert.equal(loaded.status, "loaded");
  if (loaded.status === "loaded") {
    assert.equal(loaded.manifest.schemaVersion, config.indexSchemaVersion);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.relativePath, "src/index.ts");
    assert.equal(loaded.records[0]?.definitions[0]?.name, "greet");
    assert.equal(loaded.records[0]?.references[0]?.referenceKind, "call");
    assert.equal(loaded.records[0]?.mtimeMs, 123);
    assert.equal(loaded.records[0]?.sizeBytes, 456);
  }
});

test("loadWorkspaceIndex invalidates persisted data when schemaVersion changes", async () => {
  const indexRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-index-root-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-workspace-"));
  const config = loadRuntimeConfig({
    ...process.env,
    TREE_SITTER_MCP_INDEX_DIR: indexRootDir,
  });
  const workspaceFingerprint = createWorkspaceFingerprint({
    root: workspaceRoot,
    exclusions: ["node_modules"],
    indexSchemaVersion: config.indexSchemaVersion,
  });

  await saveWorkspaceIndex(config, {
    manifest: createManifest(workspaceRoot, workspaceFingerprint, "legacy-schemaVersion"),
    records: [createRecord(workspaceRoot)],
  });

  const loaded = await loadWorkspaceIndex(config, workspaceFingerprint);
  assert.equal(loaded.status, "schema_mismatch");
  if (loaded.status === "schema_mismatch") {
    assert.equal(loaded.expectedSchemaVersion, config.indexSchemaVersion);
    assert.equal(loaded.actualSchemaVersion, "legacy-schemaVersion");
  }

  await assert.rejects(fs.access(path.join(indexRootDir, workspaceFingerprint)));
});
