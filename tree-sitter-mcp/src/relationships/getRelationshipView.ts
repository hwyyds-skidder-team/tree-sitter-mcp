import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { resolveDefinition } from "../definitions/resolveDefinition.js";
import { type DefinitionMatch } from "../definitions/definitionTypes.js";
import {
  createSearchFreshness,
  type SearchFreshness,
} from "../indexing/indexTypes.js";
import { type FreshRecordsResult } from "../indexing/semanticIndexCoordinator.js";
import { paginateResults, type Pagination } from "../results/paginateResults.js";
import type { ServerContext } from "../server/serverContext.js";
import {
  DEFAULT_RELATIONSHIP_KINDS,
  normalizeRelationshipFilters,
} from "./relationshipFilters.js";
import {
  collectDirectRelationshipEdges,
  createRelationshipEdgeKey,
  sortRelationshipEdges,
  type SearchableRelationshipFile,
} from "./relationshipTraversal.js";
import {
  RelationshipFilterSchema,
  RelationshipViewResultSchema,
  type RelationshipEdge,
  type RelationshipFilters,
  type RelationshipViewRequest,
} from "./relationshipTypes.js";

const MAX_DEPTH = 2;

export interface GetRelationshipViewResult {
  target: DefinitionMatch | null;
  filters: RelationshipFilters;
  edges: RelationshipEdge[];
  pagination: Pagination;
  freshness: SearchFreshness;
  diagnostic: Diagnostic | null;
  diagnostics: Diagnostic[];
  searchedFiles: number;
  matchedFiles: number;
  searchableFiles: SearchableRelationshipFile[];
}

interface TraversalState {
  diagnostics: Diagnostic[];
  searchableFiles: Map<string, SearchableRelationshipFile>;
  freshnesses: SearchFreshness[];
  resolveCache: Map<string, Promise<DefinitionMatch | null>>;
  ownerResolveCache: Map<string, Promise<DefinitionMatch | null>>;
}

export async function getRelationshipView(
  context: ServerContext,
  request: RelationshipViewRequest,
): Promise<GetRelationshipViewResult> {
  const fallbackFilters = createFallbackRelationshipFilters(request);
  const emptyPagination = paginateResults([], {
    limit: fallbackFilters.limit,
    offset: fallbackFilters.offset,
  }).pagination;

  if (!context.workspace.root) {
    const diagnostic = createDiagnostic({
      code: "workspace_not_set",
      message: "No workspace is configured.",
      reason: "Relationship traversal requires an active workspace snapshot.",
      nextStep: "Call set_workspace before requesting a relationship view.",
    });

    return {
      target: null,
      filters: fallbackFilters,
      edges: [],
      pagination: emptyPagination,
      freshness: createFallbackFreshness(context),
      diagnostic,
      diagnostics: [diagnostic],
      searchedFiles: 0,
      matchedFiles: 0,
      searchableFiles: [],
    };
  }

  const targetRequest = request.symbol ? { symbol: request.symbol } : request.lookup ? { lookup: request.lookup } : null;
  if (!targetRequest) {
    const diagnostic = createDiagnostic({
      code: "definition_not_found",
      message: "No relationship seed was provided.",
      reason: "Relationship traversal needs a symbol descriptor or lookup request.",
      nextStep: "Provide a symbol or lookup seed and retry.",
    });

    return {
      target: null,
      filters: fallbackFilters,
      edges: [],
      pagination: emptyPagination,
      freshness: createFallbackFreshness(context),
      diagnostic,
      diagnostics: [diagnostic],
      searchedFiles: 0,
      matchedFiles: 0,
      searchableFiles: [],
    };
  }

  const freshIndex = await context.semanticIndex.getFreshRecords(context);
  const diagnostics = [...freshIndex.diagnostics];
  const targetResult = await resolveDefinition(context, targetRequest);
  diagnostics.push(...targetResult.diagnostics);

  if (!targetResult.match) {
    return {
      target: null,
      filters: fallbackFilters,
      edges: [],
      pagination: emptyPagination,
      freshness: freshIndex.freshness,
      diagnostic: targetResult.diagnostic,
      diagnostics: dedupeDiagnostics(diagnostics),
      searchedFiles: 0,
      matchedFiles: 0,
      searchableFiles: [],
    };
  }

  const normalizedFiltersResult = normalizeRelationshipFilters({
    workspaceRoot: context.workspace.root,
    configuredRoots: context.workspace.roots,
    languageRegistry: context.languageRegistry,
    input: {
      workspaceRoots: request.workspaceRoots,
      language: request.language,
      relationshipKinds: request.relationshipKinds,
      maxDepth: request.maxDepth,
      limit: request.limit,
      offset: request.offset,
    },
  });

  if (normalizedFiltersResult.diagnostic) {
    diagnostics.push(normalizedFiltersResult.diagnostic);
    const emptyResult = RelationshipViewResultSchema.parse({
      target: targetResult.match,
      filters: normalizedFiltersResult.filters,
      edges: [],
      pagination: paginateResults([], {
        limit: normalizedFiltersResult.filters.limit,
        offset: normalizedFiltersResult.filters.offset,
      }).pagination,
    });

    return {
      target: emptyResult.target,
      filters: emptyResult.filters,
      edges: emptyResult.edges,
      pagination: emptyResult.pagination,
      freshness: freshIndex.freshness,
      diagnostic: normalizedFiltersResult.diagnostic,
      diagnostics: dedupeDiagnostics(diagnostics),
      searchedFiles: 0,
      matchedFiles: 0,
      searchableFiles: [],
    };
  }

  const traversalState: TraversalState = {
    diagnostics,
    searchableFiles: new Map<string, SearchableRelationshipFile>(),
    freshnesses: [freshIndex.freshness],
    resolveCache: new Map<string, Promise<DefinitionMatch | null>>(),
    ownerResolveCache: new Map<string, Promise<DefinitionMatch | null>>(),
  };

  const edges = await traverseRelationships(
    context,
    targetResult.match,
    normalizedFiltersResult.filters,
    freshIndex,
    traversalState,
  );
  const sortedEdges = sortRelationshipEdges(edges, context.workspace.roots);
  const pagedEdges = paginateResults(sortedEdges, {
    limit: normalizedFiltersResult.filters.limit,
    offset: normalizedFiltersResult.filters.offset,
  });
  const relationshipResult = RelationshipViewResultSchema.parse({
    target: targetResult.match,
    filters: normalizedFiltersResult.filters,
    edges: pagedEdges.items,
    pagination: pagedEdges.pagination,
  });

  return {
    target: relationshipResult.target,
    filters: relationshipResult.filters,
    edges: relationshipResult.edges,
    pagination: relationshipResult.pagination,
    freshness: combineFreshness(traversalState.freshnesses),
    diagnostic: null,
    diagnostics: dedupeDiagnostics(traversalState.diagnostics),
    searchedFiles: traversalState.searchableFiles.size,
    matchedFiles: countMatchedFiles(relationshipResult.edges),
    searchableFiles: [...traversalState.searchableFiles.values()],
  };
}

async function traverseRelationships(
  context: ServerContext,
  target: DefinitionMatch,
  filters: RelationshipFilters,
  freshIndex: FreshRecordsResult,
  state: TraversalState,
): Promise<RelationshipEdge[]> {
  const visitedDefinitions = new Set<string>([createDefinitionKey(target)]);
  const uniqueEdges = new Map<string, RelationshipEdge>();
  let depth = 1;
  let frontier = [target];

  while (frontier.length > 0 && depth <= Math.min(filters.maxDepth, MAX_DEPTH)) {
    const nextFrontier: DefinitionMatch[] = [];

    for (const definition of frontier) {
      const directEdges = await collectDirectRelationshipEdges(context, definition, {
        hopCount: depth,
        filters,
        freshIndex,
        diagnostics: state.diagnostics,
        searchableFiles: state.searchableFiles,
        freshnesses: state.freshnesses,
        resolveCache: state.resolveCache,
        ownerResolveCache: state.ownerResolveCache,
      });

      for (const edge of directEdges) {
        const edgeKey = createRelationshipEdgeKey(edge);
        if (uniqueEdges.has(edgeKey)) {
          continue;
        }

        uniqueEdges.set(edgeKey, edge);
        const relatedDefinitionKey = createDefinitionKey(edge.relatedSymbol);
        if (depth < Math.min(filters.maxDepth, MAX_DEPTH) && !visitedDefinitions.has(relatedDefinitionKey)) {
          visitedDefinitions.add(relatedDefinitionKey);
          nextFrontier.push(edge.relatedSymbol);
        }
      }
    }

    frontier = nextFrontier;
    depth += 1;
  }

  return [...uniqueEdges.values()];
}

function createFallbackRelationshipFilters(request: RelationshipViewRequest): RelationshipFilters {
  return RelationshipFilterSchema.parse({
    workspaceRoots: request.workspaceRoots?.length ? [...new Set(request.workspaceRoots)] : undefined,
    language: request.language?.trim().toLowerCase() || null,
    relationshipKinds: request.relationshipKinds?.length
      ? DEFAULT_RELATIONSHIP_KINDS.filter((relationshipKind) => request.relationshipKinds?.includes(relationshipKind))
      : [...DEFAULT_RELATIONSHIP_KINDS],
    maxDepth: request.maxDepth ?? 1,
    limit: request.limit ?? 50,
    offset: request.offset ?? 0,
  });
}

function createFallbackFreshness(context: ServerContext): SearchFreshness {
  return createSearchFreshness({
    state: context.workspace.index.state,
    checkedAt: new Date().toISOString(),
    refreshedFiles: [],
    degradedFiles: [],
    workspaceFingerprint: context.workspace.index.workspaceFingerprint,
  });
}

function createDefinitionKey(definition: Pick<DefinitionMatch, "workspaceRoot" | "relativePath" | "selectionRange">): string {
  return JSON.stringify([
    definition.workspaceRoot,
    definition.relativePath,
    definition.selectionRange.start.offset,
    definition.selectionRange.end.offset,
  ]);
}

function countMatchedFiles(edges: readonly RelationshipEdge[]): number {
  return new Set(
    edges.map((edge) => JSON.stringify([edge.relatedSymbol.workspaceRoot, edge.relatedSymbol.relativePath])),
  ).size;
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const uniqueDiagnostics = new Map<string, Diagnostic>();

  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.relativePath ?? "",
      diagnostic.filePath ?? "",
      diagnostic.languageId ?? "",
      diagnostic.range?.start.offset ?? "",
      diagnostic.range?.end.offset ?? "",
      diagnostic.message,
    ].join(":");

    if (!uniqueDiagnostics.has(key)) {
      uniqueDiagnostics.set(key, diagnostic);
    }
  }

  return [...uniqueDiagnostics.values()];
}

function combineFreshness(freshnesses: readonly SearchFreshness[]): SearchFreshness {
  if (freshnesses.length === 0) {
    return createSearchFreshness({
      state: "rebuilding",
      checkedAt: new Date().toISOString(),
      refreshedFiles: [],
      degradedFiles: [],
      workspaceFingerprint: null,
    });
  }

  const refreshedFiles = new Set<string>();
  const degradedFiles = new Set<string>();
  let state: SearchFreshness["state"] = "fresh";
  let checkedAt = freshnesses[0].checkedAt;
  let workspaceFingerprint = freshnesses[0].workspaceFingerprint;

  for (const freshness of freshnesses) {
    checkedAt = checkedAt > freshness.checkedAt ? checkedAt : freshness.checkedAt;
    workspaceFingerprint ??= freshness.workspaceFingerprint;

    for (const refreshedFile of freshness.refreshedFiles) {
      refreshedFiles.add(refreshedFile);
    }

    for (const degradedFile of freshness.degradedFiles) {
      degradedFiles.add(degradedFile);
    }

    if (freshness.state === "rebuilding") {
      state = "rebuilding";
      continue;
    }

    if (freshness.state === "degraded" && state !== "rebuilding") {
      state = "degraded";
      continue;
    }

    if (freshness.state === "refreshed" && state === "fresh") {
      state = "refreshed";
    }
  }

  return createSearchFreshness({
    state,
    checkedAt,
    refreshedFiles: [...refreshedFiles].sort(),
    degradedFiles: [...degradedFiles].sort(),
    workspaceFingerprint,
  });
}
