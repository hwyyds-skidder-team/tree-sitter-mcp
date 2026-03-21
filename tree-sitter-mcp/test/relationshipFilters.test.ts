import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import {
  DEFAULT_RELATIONSHIP_KINDS,
  matchesRelationshipFilters,
  normalizeRelationshipFilters,
} from "../src/relationships/relationshipFilters.js";
import { RelationshipViewRequestSchema } from "../src/relationships/relationshipTypes.js";
import { createServerContext } from "../src/server/serverContext.js";
import { listRelationshipQueryTypes } from "../src/queries/relationshipQueryCatalog.js";

async function createWorkspaceRoot(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `tree-sitter-mcp-relationship-${label}-`));
}

test("listRelationshipQueryTypes registers relationship_view", () => {
  assert.deepEqual(listRelationshipQueryTypes(), ["relationship_view"]);
});

test("normalizeRelationshipFilters defaults relationshipKinds and maxDepth while normalizing workspace roots and language", async () => {
  const context = createServerContext(loadRuntimeConfig());
  const primaryRoot = await createWorkspaceRoot("primary");
  const secondaryRoot = await createWorkspaceRoot("secondary");

  const result = normalizeRelationshipFilters({
    workspaceRoot: primaryRoot,
    configuredRoots: [primaryRoot, secondaryRoot],
    languageRegistry: context.languageRegistry,
    input: {
      workspaceRoots: [secondaryRoot, secondaryRoot],
      language: "TypeScript",
    },
  });

  assert.equal(result.diagnostic, null);
  assert.deepEqual(result.filters, {
    workspaceRoots: [secondaryRoot],
    language: "typescript",
    relationshipKinds: DEFAULT_RELATIONSHIP_KINDS,
    maxDepth: 1,
    limit: 50,
    offset: 0,
  });
});

test("normalizeRelationshipFilters collapses duplicate relationshipKinds in canonical order and matches edges by depth", async () => {
  const context = createServerContext(loadRuntimeConfig());
  const workspaceRoot = await createWorkspaceRoot("canonical");

  const result = normalizeRelationshipFilters({
    workspaceRoot,
    languageRegistry: context.languageRegistry,
    input: {
      language: "typescript",
      relationshipKinds: [
        "outgoing_reference",
        "incoming_call",
        "outgoing_reference",
      ],
      maxDepth: 2,
    },
  });

  assert.equal(result.diagnostic, null);
  assert.deepEqual(result.filters.relationshipKinds, [
    "incoming_call",
    "outgoing_reference",
  ]);
  assert.equal(result.filters.maxDepth, 2);
  assert.equal(matchesRelationshipFilters({
    relationshipKind: "outgoing_reference",
    hopCount: 2,
    relatedSymbol: {
      languageId: "typescript",
      workspaceRoot,
    },
  }, result.filters), true);
  assert.equal(matchesRelationshipFilters({
    relationshipKind: "incoming_reference",
    hopCount: 1,
    relatedSymbol: {
      languageId: "typescript",
      workspaceRoot,
    },
  }, result.filters), false);
});

test("normalizeRelationshipFilters returns a diagnostic for unsupported languages and unknown workspace roots", async () => {
  const context = createServerContext(loadRuntimeConfig());
  const primaryRoot = await createWorkspaceRoot("primary");
  const secondaryRoot = await createWorkspaceRoot("secondary");

  const invalidWorkspaceResult = normalizeRelationshipFilters({
    workspaceRoot: primaryRoot,
    configuredRoots: [primaryRoot],
    languageRegistry: context.languageRegistry,
    input: {
      workspaceRoots: [secondaryRoot],
    },
  });

  assert.equal(invalidWorkspaceResult.diagnostic?.code, "workspace_root_invalid");

  const unsupportedLanguageResult = normalizeRelationshipFilters({
    workspaceRoot: primaryRoot,
    configuredRoots: [primaryRoot, secondaryRoot],
    languageRegistry: context.languageRegistry,
    input: {
      language: "Rust",
    },
  });

  assert.equal(unsupportedLanguageResult.diagnostic?.code, "unsupported_language");
  assert.equal(unsupportedLanguageResult.filters.language, "rust");
});

test("relationship maxDepth rejects values outside 1..2 and surfaces a normalization diagnostic", async () => {
  const belowRange = RelationshipViewRequestSchema.safeParse({
    lookup: { name: "greet" },
    maxDepth: 0,
  });
  assert.equal(belowRange.success, false);

  const aboveRange = RelationshipViewRequestSchema.safeParse({
    lookup: { name: "greet" },
    maxDepth: 3,
  });
  assert.equal(aboveRange.success, false);

  const context = createServerContext(loadRuntimeConfig());
  const workspaceRoot = await createWorkspaceRoot("depth");
  const result = normalizeRelationshipFilters({
    workspaceRoot,
    languageRegistry: context.languageRegistry,
    input: {
      maxDepth: 3,
    },
  });

  assert.equal(result.filters.maxDepth, 1);
  assert.equal(result.diagnostic?.code, "relationship_depth_invalid");
});
