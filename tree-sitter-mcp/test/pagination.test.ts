import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { searchReferences } from "../src/references/searchReferences.js";
import { createServerContext } from "../src/server/serverContext.js";
import { discoverWorkspaceFiles } from "../src/workspace/discoverFiles.js";
import { applyWorkspaceSnapshot } from "../src/workspace/workspaceState.js";

async function createPaginationFixture(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-pagination-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), [
    "export function ping(): string {",
    "  return 'pong';",
    "}",
    "ping();",
    "ping();",
    "ping();",
    "ping();",
    "ping();",
    "",
  ].join("\n"));

  return workspaceRoot;
}

async function createPreparedContext(workspaceRoot: string) {
  const context = createServerContext(loadRuntimeConfig());
  const discovery = await discoverWorkspaceFiles(
    workspaceRoot,
    context.config.defaultExclusions,
    context.languageRegistry,
  );

  applyWorkspaceSnapshot(context.workspace, {
    root: workspaceRoot,
    exclusions: context.config.defaultExclusions,
    searchableFiles: discovery.searchableFiles,
    unsupportedFiles: discovery.unsupportedFiles,
  });

  return context;
}

test("searchReferences returns deterministic pagination metadata for large result sets", async () => {
  const workspaceRoot = await createPaginationFixture();
  const context = await createPreparedContext(workspaceRoot);

  const firstPage = await searchReferences(context, {
    lookup: {
      name: "ping",
      languageId: "typescript",
      kind: "function",
    },
    limit: 2,
    offset: 0,
  });

  assert.equal(firstPage.results.length, 2);
  assert.deepEqual(firstPage.pagination, {
    limit: 2,
    offset: 0,
    returned: 2,
    total: 5,
    hasMore: true,
    nextOffset: 2,
  });

  const secondPage = await searchReferences(context, {
    lookup: {
      name: "ping",
      languageId: "typescript",
      kind: "function",
    },
    limit: 2,
    offset: firstPage.pagination.nextOffset ?? 0,
  });

  assert.equal(secondPage.results.length, 2);
  assert.deepEqual(secondPage.pagination, {
    limit: 2,
    offset: 2,
    returned: 2,
    total: 5,
    hasMore: true,
    nextOffset: 4,
  });

  const finalPage = await searchReferences(context, {
    lookup: {
      name: "ping",
      languageId: "typescript",
      kind: "function",
    },
    limit: 2,
    offset: secondPage.pagination.nextOffset ?? 0,
  });

  assert.equal(finalPage.results.length, 1);
  assert.deepEqual(finalPage.pagination, {
    limit: 2,
    offset: 4,
    returned: 1,
    total: 5,
    hasMore: false,
    nextOffset: null,
  });
});
