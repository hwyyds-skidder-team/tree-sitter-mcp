import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import {
  DEFAULT_DEPENDENCY_RELATIONSHIP_KINDS,
  normalizeDependencyFilters,
} from "../src/dependencies/dependencyFilters.js";
import { DependencyAnalysisRequestSchema } from "../src/dependencies/dependencyTypes.js";
import { listDependencyQueryTypes } from "../src/queries/dependencyQueryCatalog.js";
import { createServerContext } from "../src/server/serverContext.js";

async function createWorkspaceRoot(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `tree-sitter-mcp-dependency-${label}-`));
}

test("listDependencyQueryTypes registers dependency_analysis", () => {
  assert.deepEqual(listDependencyQueryTypes(), ["dependency_analysis"]);
});

test("normalizeDependencyFilters defaults relationshipKinds and maxDepth while preserving workspaceRoots, limit, and offset", async () => {
  const context = createServerContext(loadRuntimeConfig());
  const primaryRoot = await createWorkspaceRoot("primary");
  const secondaryRoot = await createWorkspaceRoot("secondary");

  const result = normalizeDependencyFilters({
    workspaceRoot: primaryRoot,
    configuredRoots: [primaryRoot, secondaryRoot],
    languageRegistry: context.languageRegistry,
    input: {
      workspaceRoots: [secondaryRoot, secondaryRoot],
      language: "TypeScript",
      limit: 25,
      offset: 10,
    },
  });

  assert.equal(result.diagnostic, null);
  assert.deepEqual(result.filters, {
    workspaceRoots: [secondaryRoot],
    language: "typescript",
    relationshipKinds: DEFAULT_DEPENDENCY_RELATIONSHIP_KINDS,
    maxDepth: 2,
    limit: 25,
    offset: 10,
  });
});

test("normalizeDependencyFilters collapses duplicate relationshipKinds into canonical order", async () => {
  const context = createServerContext(loadRuntimeConfig());
  const workspaceRoot = await createWorkspaceRoot("canonical");

  const result = normalizeDependencyFilters({
    workspaceRoot,
    languageRegistry: context.languageRegistry,
    input: {
      relationshipKinds: [
        "outgoing_reference",
        "incoming_call",
        "outgoing_reference",
      ],
      maxDepth: 4,
    },
  });

  assert.equal(result.diagnostic, null);
  assert.deepEqual(result.filters.relationshipKinds, [
    "incoming_call",
    "outgoing_reference",
  ]);
  assert.equal(result.filters.maxDepth, 4);
});

test("normalizeDependencyFilters returns diagnostics for unsupported workspace roots and languages", async () => {
  const context = createServerContext(loadRuntimeConfig());
  const primaryRoot = await createWorkspaceRoot("primary");
  const secondaryRoot = await createWorkspaceRoot("secondary");

  const invalidWorkspaceResult = normalizeDependencyFilters({
    workspaceRoot: primaryRoot,
    configuredRoots: [primaryRoot],
    languageRegistry: context.languageRegistry,
    input: {
      workspaceRoots: [secondaryRoot],
    },
  });

  assert.equal(invalidWorkspaceResult.diagnostic?.code, "workspace_root_invalid");

  const unsupportedLanguageResult = normalizeDependencyFilters({
    workspaceRoot: primaryRoot,
    configuredRoots: [primaryRoot, secondaryRoot],
    languageRegistry: context.languageRegistry,
    input: {
      language: "Go",
    },
  });

  assert.equal(unsupportedLanguageResult.diagnostic?.code, "unsupported_language");
  assert.equal(unsupportedLanguageResult.filters.language, "go");
});

test("dependency maxDepth rejects values outside 1..4 and surfaces dependency_depth_invalid", async () => {
  const belowRange = DependencyAnalysisRequestSchema.safeParse({
    lookup: { name: "greet" },
    maxDepth: 0,
  });
  assert.equal(belowRange.success, false);

  const aboveRange = DependencyAnalysisRequestSchema.safeParse({
    lookup: { name: "greet" },
    maxDepth: 5,
  });
  assert.equal(aboveRange.success, false);

  const context = createServerContext(loadRuntimeConfig());
  const workspaceRoot = await createWorkspaceRoot("depth");
  const belowRangeResult = normalizeDependencyFilters({
    workspaceRoot,
    languageRegistry: context.languageRegistry,
    input: {
      maxDepth: 0,
    },
  });
  const aboveRangeResult = normalizeDependencyFilters({
    workspaceRoot,
    languageRegistry: context.languageRegistry,
    input: {
      maxDepth: 5,
    },
  });

  assert.equal(belowRangeResult.filters.maxDepth, 2);
  assert.equal(belowRangeResult.diagnostic?.code, "dependency_depth_invalid");
  assert.equal(aboveRangeResult.filters.maxDepth, 2);
  assert.equal(aboveRangeResult.diagnostic?.code, "dependency_depth_invalid");
});
