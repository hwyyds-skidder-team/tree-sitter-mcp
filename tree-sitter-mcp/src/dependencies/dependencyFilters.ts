import { z } from "zod";
import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { normalizeConfiguredWorkspaceRoots } from "../definitions/definitionFilters.js";
import type { LanguageRegistry } from "../languages/languageRegistry.js";
import { DEFAULT_RELATIONSHIP_KINDS } from "../relationships/relationshipFilters.js";
import type { RelationshipKind } from "../relationships/relationshipTypes.js";
import {
  DependencyFilterSchema,
  type DependencyFilterInput,
  type DependencyFilters,
  type DependencyResult,
} from "./dependencyTypes.js";

const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;
const DEFAULT_MAX_DEPTH = 2;

export const DEFAULT_DEPENDENCY_RELATIONSHIP_KINDS = [...DEFAULT_RELATIONSHIP_KINDS];

export interface NormalizeDependencyFiltersOptions {
  workspaceRoot: string;
  configuredRoots?: readonly string[];
  languageRegistry: LanguageRegistry;
  input?: DependencyFilterInput;
}

export interface NormalizeDependencyFiltersResult {
  filters: DependencyFilters;
  diagnostic: Diagnostic | null;
}

type DependencyFilterable = Pick<DependencyResult, "depth" | "path"> & {
  symbol: Pick<DependencyResult["symbol"], "languageId" | "workspaceRoot">;
};

export function normalizeDependencyFilters(
  options: NormalizeDependencyFiltersOptions,
): NormalizeDependencyFiltersResult {
  const configuredRoots = options.configuredRoots?.length
    ? [...options.configuredRoots]
    : [options.workspaceRoot];
  const normalizedWorkspaceRootsResult = normalizeConfiguredWorkspaceRoots(
    configuredRoots,
    options.input?.workspaceRoots,
  );
  const rawLanguage = options.input?.language?.trim() ?? "";
  const normalizedLanguage = rawLanguage.length > 0 ? rawLanguage.toLowerCase() : null;
  const relationshipKinds = normalizeDependencyRelationshipKinds(options.input?.relationshipKinds);
  const normalizedMaxDepthResult = normalizeDependencyMaxDepth(options.input?.maxDepth);
  const filters = DependencyFilterSchema.parse({
    workspaceRoots: normalizedWorkspaceRootsResult.workspaceRoots,
    language: normalizedLanguage,
    relationshipKinds,
    maxDepth: normalizedMaxDepthResult.maxDepth,
    limit: normalizeDependencyLimit(options.input?.limit),
    offset: normalizeDependencyOffset(options.input?.offset),
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

export function matchesDependencyResultFilters(
  result: DependencyFilterable,
  filters: DependencyFilters,
): boolean {
  if (filters.workspaceRoots?.length && !filters.workspaceRoots.includes(result.symbol.workspaceRoot)) {
    return false;
  }

  if (filters.language && result.symbol.languageId !== filters.language) {
    return false;
  }

  if (result.depth > filters.maxDepth) {
    return false;
  }

  if (!result.path.every((step) => filters.relationshipKinds.includes(step.relationshipKind))) {
    return false;
  }

  return true;
}

function normalizeDependencyRelationshipKinds(
  relationshipKinds?: readonly RelationshipKind[] | null,
): RelationshipKind[] {
  const requestedKinds = relationshipKinds ?? [];
  if (requestedKinds.length === 0) {
    return [...DEFAULT_DEPENDENCY_RELATIONSHIP_KINDS];
  }

  const requestedKindSet = new Set(requestedKinds);
  return DEFAULT_DEPENDENCY_RELATIONSHIP_KINDS.filter((relationshipKind) => requestedKindSet.has(relationshipKind));
}

function normalizeDependencyMaxDepth(
  maxDepth?: number | null,
): { maxDepth: number; diagnostic: Diagnostic | null } {
  if (maxDepth == null) {
    return {
      maxDepth: DEFAULT_MAX_DEPTH,
      diagnostic: null,
    };
  }

  const parsedMaxDepth = z.number().int().min(1).max(4).safeParse(maxDepth);
  if (parsedMaxDepth.success) {
    return {
      maxDepth: parsedMaxDepth.data,
      diagnostic: null,
    };
  }

  return {
    maxDepth: DEFAULT_MAX_DEPTH,
    diagnostic: createDiagnostic({
      code: "dependency_depth_invalid",
      message: "Dependency maxDepth must be between 1 and 4.",
      reason: "Phase 7 dependency analysis is intentionally bounded to four hops to keep traversal results actionable and predictable.",
      nextStep: "Retry with maxDepth set between 1 and 4.",
      details: { requestedMaxDepth: maxDepth },
    }),
  };
}

function normalizeDependencyLimit(limit?: number | null): number {
  const parsedLimit = z.number().int().positive().max(200).safeParse(limit ?? DEFAULT_LIMIT);
  return parsedLimit.success ? parsedLimit.data : DEFAULT_LIMIT;
}

function normalizeDependencyOffset(offset?: number | null): number {
  const parsedOffset = z.number().int().nonnegative().safeParse(offset ?? DEFAULT_OFFSET);
  return parsedOffset.success ? parsedOffset.data : DEFAULT_OFFSET;
}
