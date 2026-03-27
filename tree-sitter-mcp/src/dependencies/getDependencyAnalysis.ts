import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { resolveDefinition } from "../definitions/resolveDefinition.js";
import { type DefinitionMatch } from "../definitions/definitionTypes.js";
import {
  createSearchFreshness,
  type SearchFreshness,
} from "../indexing/indexTypes.js";
import { paginateResults, type Pagination } from "../results/paginateResults.js";
import type { ServerContext } from "../server/serverContext.js";
import {
  collectDirectRelationshipEdges,
  sortRelationshipEdges,
  type SearchableRelationshipFile,
} from "../relationships/relationshipTraversal.js";
import { type RelationshipKind } from "../relationships/relationshipTypes.js";
import {
  DEFAULT_DEPENDENCY_RELATIONSHIP_KINDS,
  matchesDependencyResultFilters,
  normalizeDependencyFilters,
} from "./dependencyFilters.js";
import {
  DependencyAnalysisResultSchema,
  DependencyFilterSchema,
  type DependencyAnalysisRequest,
  type DependencyDirection,
  type DependencyFilters,
  type DependencyPathStep,
  type DependencyResult,
} from "./dependencyTypes.js";

const DIRECT_EDGE_MAX_DEPTH = 1;

export interface GetDependencyAnalysisResult {
  target: DefinitionMatch | null;
  filters: DependencyFilters;
  results: DependencyResult[];
  pagination: Pagination;
  freshness: SearchFreshness;
  diagnostic: Diagnostic | null;
  diagnostics: Diagnostic[];
  searchedFiles: number;
  matchedFiles: number;
  searchableFiles: SearchableRelationshipFile[];
}

interface DependencyTraversalState {
  diagnostics: Diagnostic[];
  searchableFiles: Map<string, SearchableRelationshipFile>;
  freshnesses: SearchFreshness[];
  resolveCache: Map<string, Promise<DefinitionMatch | null>>;
  ownerResolveCache: Map<string, Promise<DefinitionMatch | null>>;
}

interface DependencyFrontierEntry {
  symbol: DefinitionMatch;
  direction: DependencyDirection;
  path: DependencyPathStep[];
}

export async function getDependencyAnalysis(
  context: ServerContext,
  request: DependencyAnalysisRequest,
): Promise<GetDependencyAnalysisResult> {
  const fallbackFilters = createFallbackDependencyFilters(request);
  const emptyPagination = paginateResults([], {
    limit: fallbackFilters.limit,
    offset: fallbackFilters.offset,
  }).pagination;

  if (!context.workspace.root) {
    const diagnostic = createDiagnostic({
      code: "workspace_not_set",
      message: "No workspace is configured.",
      reason: "Dependency analysis requires an active workspace snapshot.",
      nextStep: "Call set_workspace before requesting dependency analysis.",
    });

    return {
      target: null,
      filters: fallbackFilters,
      results: [],
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
      message: "No dependency seed was provided.",
      reason: "Dependency analysis needs a symbol descriptor or lookup request.",
      nextStep: "Provide a symbol or lookup seed and retry.",
    });

    return {
      target: null,
      filters: fallbackFilters,
      results: [],
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
      results: [],
      pagination: emptyPagination,
      freshness: freshIndex.freshness,
      diagnostic: targetResult.diagnostic,
      diagnostics: dedupeDiagnostics(diagnostics),
      searchedFiles: 0,
      matchedFiles: 0,
      searchableFiles: [],
    };
  }

  const normalizedFiltersResult = normalizeDependencyFilters({
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
    const emptyResult = DependencyAnalysisResultSchema.parse({
      target: targetResult.match,
      filters: normalizedFiltersResult.filters,
      results: [],
      pagination: paginateResults([], {
        limit: normalizedFiltersResult.filters.limit,
        offset: normalizedFiltersResult.filters.offset,
      }).pagination,
    });

    return {
      target: emptyResult.target,
      filters: emptyResult.filters,
      results: emptyResult.results,
      pagination: emptyResult.pagination,
      freshness: freshIndex.freshness,
      diagnostic: normalizedFiltersResult.diagnostic,
      diagnostics: dedupeDiagnostics(diagnostics),
      searchedFiles: 0,
      matchedFiles: 0,
      searchableFiles: [],
    };
  }

  const traversalState: DependencyTraversalState = {
    diagnostics,
    searchableFiles: new Map<string, SearchableRelationshipFile>(),
    freshnesses: [freshIndex.freshness],
    resolveCache: new Map<string, Promise<DefinitionMatch | null>>(),
    ownerResolveCache: new Map<string, Promise<DefinitionMatch | null>>(),
  };

  const results = await traverseDependencies(
    context,
    targetResult.match,
    normalizedFiltersResult.filters,
    freshIndex,
    traversalState,
  );
  const sortedResults = sortDependencyResults(results, context.workspace.roots);
  const pagedResults = paginateResults(sortedResults, {
    limit: normalizedFiltersResult.filters.limit,
    offset: normalizedFiltersResult.filters.offset,
  });
  const dependencyResult = DependencyAnalysisResultSchema.parse({
    target: targetResult.match,
    filters: normalizedFiltersResult.filters,
    results: pagedResults.items,
    pagination: pagedResults.pagination,
  });

  return {
    target: dependencyResult.target,
    filters: dependencyResult.filters,
    results: dependencyResult.results,
    pagination: dependencyResult.pagination,
    freshness: combineFreshness(traversalState.freshnesses),
    diagnostic: null,
    diagnostics: dedupeDiagnostics(traversalState.diagnostics),
    searchedFiles: traversalState.searchableFiles.size,
    matchedFiles: countMatchedFiles(dependencyResult.results),
    searchableFiles: [...traversalState.searchableFiles.values()],
  };
}

async function traverseDependencies(
  context: ServerContext,
  target: DefinitionMatch,
  filters: DependencyFilters,
  freshIndex: Awaited<ReturnType<ServerContext["semanticIndex"]["getFreshRecords"]>>,
  state: DependencyTraversalState,
): Promise<DependencyResult[]> {
  const results = new Map<string, DependencyResult>();
  const seenFrontier = new Set<string>();
  let frontier: DependencyFrontierEntry[] = [{
    symbol: target,
    direction: "outgoing",
    path: [],
  }, {
    symbol: target,
    direction: "incoming",
    path: [],
  }];
  let depth = 1;

  while (frontier.length > 0 && depth <= filters.maxDepth) {
    const nextFrontier: DependencyFrontierEntry[] = [];

    for (const entry of frontier) {
      const directFilters = {
        workspaceRoots: filters.workspaceRoots,
        language: filters.language,
        relationshipKinds: narrowRelationshipKinds(filters.relationshipKinds, entry.path[0]?.relationshipKind ?? entry.direction),
        maxDepth: DIRECT_EDGE_MAX_DEPTH,
      };
      const directEdges = sortRelationshipEdges(
        await collectDirectRelationshipEdges(context, entry.symbol, {
          hopCount: 1,
          filters: directFilters,
          freshIndex,
          diagnostics: state.diagnostics,
          searchableFiles: state.searchableFiles,
          freshnesses: state.freshnesses,
          resolveCache: state.resolveCache,
          ownerResolveCache: state.ownerResolveCache,
        }),
        context.workspace.roots,
      );

      for (const edge of directEdges) {
        const nextPath = [
          ...entry.path,
          {
            relationshipKind: edge.relationshipKind,
            fromSymbol: entry.symbol,
            toSymbol: edge.relatedSymbol,
            evidence: edge.evidence,
          },
        ];
        const direction = getDependencyDirection(nextPath[0].relationshipKind);
        const result: DependencyResult = {
          symbol: edge.relatedSymbol,
          direction,
          depth: nextPath.length,
          path: nextPath,
        };
        const resultKey = createDependencyResultKey(result);

        if (!matchesDependencyResultFilters(result, filters) || results.has(resultKey)) {
          continue;
        }

        results.set(resultKey, result);

        if (depth >= filters.maxDepth) {
          continue;
        }

        if (seenFrontier.has(resultKey)) {
          continue;
        }

        seenFrontier.add(resultKey);
        nextFrontier.push({
          symbol: edge.relatedSymbol,
          direction,
          path: nextPath,
        });
      }
    }

    frontier = nextFrontier;
    depth += 1;
  }

  return [...results.values()];
}

function createFallbackDependencyFilters(request: DependencyAnalysisRequest): DependencyFilters {
  return DependencyFilterSchema.parse({
    workspaceRoots: request.workspaceRoots?.length ? [...new Set(request.workspaceRoots)] : undefined,
    language: request.language?.trim().toLowerCase() || null,
    relationshipKinds: request.relationshipKinds?.length
      ? DEFAULT_DEPENDENCY_RELATIONSHIP_KINDS.filter((relationshipKind) => request.relationshipKinds?.includes(relationshipKind))
      : [...DEFAULT_DEPENDENCY_RELATIONSHIP_KINDS],
    maxDepth: request.maxDepth ?? 2,
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

function narrowRelationshipKinds(
  relationshipKinds: readonly RelationshipKind[],
  direction: DependencyDirection | RelationshipKind,
): RelationshipKind[] {
  const directionPrefix = typeof direction === "string" && direction.startsWith("incoming")
    ? "incoming"
    : typeof direction === "string" && direction.startsWith("outgoing")
      ? "outgoing"
      : direction;

  return relationshipKinds.filter((relationshipKind) => relationshipKind.startsWith(directionPrefix));
}

function getDependencyDirection(relationshipKind: RelationshipKind): DependencyDirection {
  return relationshipKind.startsWith("incoming") ? "incoming" : "outgoing";
}

function createDependencyResultKey(result: Pick<DependencyResult, "direction" | "symbol">): string {
  return JSON.stringify([
    result.direction,
    result.symbol.workspaceRoot,
    result.symbol.relativePath,
    result.symbol.selectionRange.start.offset,
  ]);
}

function sortDependencyResults(
  results: readonly DependencyResult[],
  configuredRoots: readonly string[],
): DependencyResult[] {
  const directionOrder = new Map<DependencyDirection, number>([
    ["incoming", 0],
    ["outgoing", 1],
  ]);
  const workspaceOrder = new Map(configuredRoots.map((workspaceRoot, index) => [workspaceRoot, index] as const));

  return [...results].sort((left, right) => {
    if (left.depth !== right.depth) {
      return left.depth - right.depth;
    }

    const leftDirection = directionOrder.get(left.direction) ?? Number.MAX_SAFE_INTEGER;
    const rightDirection = directionOrder.get(right.direction) ?? Number.MAX_SAFE_INTEGER;
    if (leftDirection !== rightDirection) {
      return leftDirection - rightDirection;
    }

    const leftWorkspace = workspaceOrder.get(left.symbol.workspaceRoot) ?? Number.MAX_SAFE_INTEGER;
    const rightWorkspace = workspaceOrder.get(right.symbol.workspaceRoot) ?? Number.MAX_SAFE_INTEGER;
    if (leftWorkspace !== rightWorkspace) {
      return leftWorkspace - rightWorkspace;
    }

    if (left.symbol.relativePath !== right.symbol.relativePath) {
      return left.symbol.relativePath.localeCompare(right.symbol.relativePath);
    }

    return left.symbol.selectionRange.start.offset - right.symbol.selectionRange.start.offset;
  });
}

function countMatchedFiles(results: readonly DependencyResult[]): number {
  return new Set(
    results.map((result) => JSON.stringify([result.symbol.workspaceRoot, result.symbol.relativePath])),
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
