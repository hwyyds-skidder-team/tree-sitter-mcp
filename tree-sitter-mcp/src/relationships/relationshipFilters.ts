import { z } from "zod";
import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { normalizeConfiguredWorkspaceRoots } from "../definitions/definitionFilters.js";
import type { LanguageRegistry } from "../languages/languageRegistry.js";
import {
  RelationshipFilterSchema,
  RelationshipKindSchema,
  type RelationshipEdge,
  type RelationshipFilterInput,
  type RelationshipFilters,
  type RelationshipKind,
} from "./relationshipTypes.js";

const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;
const DEFAULT_MAX_DEPTH = 1;

export const DEFAULT_RELATIONSHIP_KINDS = [...RelationshipKindSchema.options] as RelationshipKind[];

export interface NormalizeRelationshipFiltersOptions {
  workspaceRoot: string;
  configuredRoots?: readonly string[];
  languageRegistry: LanguageRegistry;
  input?: RelationshipFilterInput;
}

export interface NormalizeRelationshipFiltersResult {
  filters: RelationshipFilters;
  diagnostic: Diagnostic | null;
}

type RelationshipFilterable = Pick<RelationshipEdge, "relationshipKind" | "hopCount"> & {
  relatedSymbol: Pick<RelationshipEdge["relatedSymbol"], "languageId" | "workspaceRoot">;
};

export function normalizeRelationshipFilters(
  options: NormalizeRelationshipFiltersOptions,
): NormalizeRelationshipFiltersResult {
  const configuredRoots = options.configuredRoots?.length
    ? [...options.configuredRoots]
    : [options.workspaceRoot];
  const normalizedWorkspaceRootsResult = normalizeConfiguredWorkspaceRoots(
    configuredRoots,
    options.input?.workspaceRoots,
  );
  const rawLanguage = options.input?.language?.trim() ?? "";
  const normalizedLanguage = rawLanguage.length > 0 ? rawLanguage.toLowerCase() : null;
  const relationshipKinds = normalizeRelationshipKinds(options.input?.relationshipKinds);
  const normalizedMaxDepthResult = normalizeRelationshipMaxDepth(options.input?.maxDepth);
  const filters = RelationshipFilterSchema.parse({
    workspaceRoots: normalizedWorkspaceRootsResult.workspaceRoots,
    language: normalizedLanguage,
    relationshipKinds,
    maxDepth: normalizedMaxDepthResult.maxDepth,
    limit: normalizeRelationshipLimit(options.input?.limit),
    offset: normalizeRelationshipOffset(options.input?.offset),
  });

  if (normalizedWorkspaceRootsResult.diagnostic) {
    return {
      filters,
      diagnostic: normalizedWorkspaceRootsResult.diagnostic,
    };
  }

  if (normalizedLanguage && !options.languageRegistry.getById(normalizedLanguage)) {
    return {
      filters,
      diagnostic: createDiagnostic({
        code: "unsupported_language",
        message: `Language ${normalizedLanguage} is not registered in this server instance.`,
        reason: "The requested language filter does not match any builtin grammar registration.",
        nextStep: "Inspect get_capabilities for supported language identifiers and retry.",
        languageId: normalizedLanguage,
      }),
    };
  }

  if (normalizedMaxDepthResult.diagnostic) {
    return {
      filters,
      diagnostic: normalizedMaxDepthResult.diagnostic,
    };
  }

  return {
    filters,
    diagnostic: null,
  };
}

export function matchesRelationshipFilters(
  edge: RelationshipFilterable,
  filters: RelationshipFilters,
): boolean {
  if (filters.workspaceRoots?.length && !filters.workspaceRoots.includes(edge.relatedSymbol.workspaceRoot)) {
    return false;
  }

  if (filters.language && edge.relatedSymbol.languageId !== filters.language) {
    return false;
  }

  if (!filters.relationshipKinds.includes(edge.relationshipKind)) {
    return false;
  }

  if (edge.hopCount > filters.maxDepth) {
    return false;
  }

  return true;
}

function normalizeRelationshipKinds(
  relationshipKinds?: readonly RelationshipKind[] | null,
): RelationshipKind[] {
  const requestedKinds = relationshipKinds ?? [];
  if (requestedKinds.length === 0) {
    return [...DEFAULT_RELATIONSHIP_KINDS];
  }

  const requestedKindSet = new Set(requestedKinds);
  return DEFAULT_RELATIONSHIP_KINDS.filter((relationshipKind) => requestedKindSet.has(relationshipKind));
}

function normalizeRelationshipMaxDepth(
  maxDepth?: number | null,
): { maxDepth: number; diagnostic: Diagnostic | null } {
  if (maxDepth == null) {
    return {
      maxDepth: DEFAULT_MAX_DEPTH,
      diagnostic: null,
    };
  }

  const parsedMaxDepth = z.number().int().min(1).max(2).safeParse(maxDepth);
  if (parsedMaxDepth.success) {
    return {
      maxDepth: parsedMaxDepth.data,
      diagnostic: null,
    };
  }

  return {
    maxDepth: DEFAULT_MAX_DEPTH,
    diagnostic: createDiagnostic({
      code: "relationship_depth_invalid",
      message: "Relationship maxDepth must be between 1 and 2.",
      reason: "Phase 6 relationship views are intentionally limited to direct links and one additional impact hop.",
      nextStep: "Retry with maxDepth set to 1 for direct edges or 2 for a small impact neighborhood.",
      details: { requestedMaxDepth: maxDepth },
    }),
  };
}

function normalizeRelationshipLimit(limit?: number | null): number {
  const parsedLimit = z.number().int().positive().max(200).safeParse(limit ?? DEFAULT_LIMIT);
  return parsedLimit.success ? parsedLimit.data : DEFAULT_LIMIT;
}

function normalizeRelationshipOffset(offset?: number | null): number {
  const parsedOffset = z.number().int().nonnegative().safeParse(offset ?? DEFAULT_OFFSET);
  return parsedOffset.success ? parsedOffset.data : DEFAULT_OFFSET;
}
