import type { EnclosingContext } from "../context/contextTypes.js";
import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import {
  resolveDefinition,
  type ResolveDefinitionRequest,
} from "../definitions/resolveDefinition.js";
import {
  type DefinitionMatch,
} from "../definitions/definitionTypes.js";
import {
  type IndexedFileSemanticRecord,
  type SearchFreshness,
  createSearchFreshness,
} from "../indexing/indexTypes.js";
import { type FreshRecordsResult } from "../indexing/semanticIndexCoordinator.js";
import { paginateResults, type Pagination } from "../results/paginateResults.js";
import {
  filterReferenceSearchableFiles,
  normalizeReferenceFilters,
} from "../references/referenceFilters.js";
import { searchReferences } from "../references/searchReferences.js";
import type { ReferenceMatch } from "../references/referenceTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import {
  DEFAULT_RELATIONSHIP_KINDS,
  matchesRelationshipFilters,
  normalizeRelationshipFilters,
} from "./relationshipFilters.js";
import {
  RelationshipFilterSchema,
  RelationshipViewResultSchema,
  type RelationshipEdge,
  type RelationshipFilters,
  type RelationshipKind,
  type RelationshipViewRequest,
} from "./relationshipTypes.js";

const MAX_DEPTH = 2;
const INTERNAL_REFERENCE_PAGE_LIMIT = 200;

type SearchableRelationshipFile = Pick<IndexedFileSemanticRecord, "workspaceRoot" | "relativePath" | "languageId">;

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
  const queuedDefinitions = [target];
  const visitedDefinitions = new Set<string>([createDefinitionKey(target)]);
  const uniqueEdges = new Map<string, RelationshipEdge>();
  const resolveCache = new Map<string, Promise<DefinitionMatch | null>>();
  const ownerResolveCache = new Map<string, Promise<DefinitionMatch | null>>();
  let depth = 1;
  let frontier = queuedDefinitions;

  while (frontier.length > 0 && depth <= Math.min(filters.maxDepth, MAX_DEPTH)) {
    const nextFrontier: DefinitionMatch[] = [];

    for (const definition of frontier) {
      const directEdges = await collectDirectEdges(
        context,
        definition,
        depth,
        filters,
        freshIndex,
        state,
        resolveCache,
        ownerResolveCache,
      );

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

async function collectDirectEdges(
  context: ServerContext,
  frontier: DefinitionMatch,
  hopCount: number,
  filters: RelationshipFilters,
  freshIndex: FreshRecordsResult,
  state: TraversalState,
  resolveCache: Map<string, Promise<DefinitionMatch | null>>,
  ownerResolveCache: Map<string, Promise<DefinitionMatch | null>>,
): Promise<RelationshipEdge[]> {
  const edges: RelationshipEdge[] = [];
  const [incomingEdges, outgoingEdges] = await Promise.all([
    collectIncomingEdges(context, frontier, hopCount, filters, freshIndex, state, ownerResolveCache),
    collectOutgoingEdges(context, frontier, hopCount, filters, freshIndex, state, resolveCache),
  ]);

  edges.push(...incomingEdges, ...outgoingEdges);
  return edges;
}

async function collectIncomingEdges(
  context: ServerContext,
  frontier: DefinitionMatch,
  hopCount: number,
  filters: RelationshipFilters,
  freshIndex: FreshRecordsResult,
  state: TraversalState,
  ownerResolveCache: Map<string, Promise<DefinitionMatch | null>>,
): Promise<RelationshipEdge[]> {
  const referenceFiltersResult = normalizeReferenceFilters({
    workspaceRoot: context.workspace.root ?? frontier.workspaceRoot,
    configuredRoots: context.workspace.roots,
    languageRegistry: context.languageRegistry,
    input: {
      workspaceRoots: filters.workspaceRoots,
      language: filters.language,
    },
  });
  const compatibleLanguageIds = getCompatibleLanguageIds(frontier.languageId);
  const searchableFiles = filterReferenceSearchableFiles(
    freshIndex.records.filter((file) => compatibleLanguageIds.has(file.languageId)),
    referenceFiltersResult.filters,
  );
  trackSearchableFiles(state.searchableFiles, searchableFiles);

  const references = await collectAllReferences(context, frontier, filters, state);
  const edges: RelationshipEdge[] = [];

  for (const reference of references) {
    if (!reference.enclosingContext?.name) {
      state.diagnostics.push(createSkippedOwnerDiagnostic(frontier, reference));
      continue;
    }

    const owner = await resolveOwnerDefinition(context, reference, ownerResolveCache);
    if (!owner) {
      state.diagnostics.push(createUnresolvedRelationshipDiagnostic(frontier, reference, "incoming"));
      continue;
    }

    if (isSameDefinition(owner, frontier)) {
      state.diagnostics.push(createSelfRelationshipDiagnostic(frontier, reference, "incoming"));
      continue;
    }

    const edge = createRelationshipEdge(
      reference.referenceKind === "call" ? "incoming_call" : "incoming_reference",
      hopCount,
      owner,
      reference,
    );

    if (!matchesRelationshipFilters(edge, filters)) {
      continue;
    }

    edges.push(edge);
  }

  return edges;
}

async function collectOutgoingEdges(
  context: ServerContext,
  frontier: DefinitionMatch,
  hopCount: number,
  filters: RelationshipFilters,
  freshIndex: FreshRecordsResult,
  state: TraversalState,
  resolveCache: Map<string, Promise<DefinitionMatch | null>>,
): Promise<RelationshipEdge[]> {
  const frontierRecord = freshIndex.records.find((record) =>
    record.workspaceRoot === frontier.workspaceRoot && record.relativePath === frontier.relativePath);

  if (!frontierRecord) {
    return [];
  }

  trackSearchableFiles(state.searchableFiles, [frontierRecord]);

  const references = frontierRecord.references.filter((reference) =>
    isReferenceWithinDefinition(reference, frontier));
  const edges: RelationshipEdge[] = [];

  for (const reference of references) {
    const relatedDefinition = await resolveReferencedDefinition(context, reference, resolveCache);
    if (!relatedDefinition) {
      state.diagnostics.push(createUnresolvedRelationshipDiagnostic(frontier, reference, "outgoing"));
      continue;
    }

    if (isSameDefinition(relatedDefinition, frontier)) {
      state.diagnostics.push(createSelfRelationshipDiagnostic(frontier, reference, "outgoing"));
      continue;
    }

    const edge = createRelationshipEdge(
      reference.referenceKind === "call" ? "outgoing_call" : "outgoing_reference",
      hopCount,
      relatedDefinition,
      reference,
    );

    if (!matchesRelationshipFilters(edge, filters)) {
      continue;
    }

    edges.push(edge);
  }

  return edges;
}

async function collectAllReferences(
  context: ServerContext,
  frontier: DefinitionMatch,
  filters: RelationshipFilters,
  state: TraversalState,
): Promise<ReferenceMatch[]> {
  const results: ReferenceMatch[] = [];
  let offset = 0;

  while (true) {
    const page = await searchReferences(context, {
      lookup: {
        name: frontier.name,
        languageId: frontier.languageId,
        workspaceRoot: frontier.workspaceRoot,
        relativePath: frontier.relativePath,
        kind: frontier.kind,
      },
      workspaceRoots: filters.workspaceRoots,
      language: filters.language ?? undefined,
      limit: INTERNAL_REFERENCE_PAGE_LIMIT,
      offset,
      includeContext: true,
    });

    state.freshnesses.push(page.freshness);
    state.diagnostics.push(
      ...page.diagnostics.filter((diagnostic) => diagnostic.code !== "reference_not_found"),
    );
    results.push(...page.results);

    if (!page.pagination.hasMore || page.pagination.nextOffset == null) {
      break;
    }

    offset = page.pagination.nextOffset;
  }

  return results;
}

async function resolveOwnerDefinition(
  context: ServerContext,
  reference: ReferenceMatch,
  ownerResolveCache: Map<string, Promise<DefinitionMatch | null>>,
): Promise<DefinitionMatch | null> {
  if (!reference.enclosingContext?.name) {
    return null;
  }

  const lookupRequest: ResolveDefinitionRequest = {
    lookup: {
      name: reference.enclosingContext.name,
      languageId: reference.languageId,
      workspaceRoot: reference.workspaceRoot,
      relativePath: reference.relativePath,
      kind: normalizeEnclosingKind(reference.enclosingContext.kind),
    },
  };
  const cacheKey = JSON.stringify([
    lookupRequest.lookup?.name ?? "",
    lookupRequest.lookup?.languageId ?? "",
    lookupRequest.lookup?.workspaceRoot ?? "",
    lookupRequest.lookup?.relativePath ?? "",
    lookupRequest.lookup?.kind ?? "",
  ]);
  const cached = ownerResolveCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = resolveDefinition(context, lookupRequest).then((result) => result.match);
  ownerResolveCache.set(cacheKey, pending);
  return pending;
}

async function resolveReferencedDefinition(
  context: ServerContext,
  reference: ReferenceMatch,
  resolveCache: Map<string, Promise<DefinitionMatch | null>>,
): Promise<DefinitionMatch | null> {
  const cacheKey = JSON.stringify([
    reference.name,
    reference.languageId,
    reference.workspaceRoot,
    reference.relativePath,
  ]);
  const cached = resolveCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const sameFileMatch = await resolveDefinition(context, {
      lookup: {
        name: reference.name,
        languageId: reference.languageId,
        workspaceRoot: reference.workspaceRoot,
        relativePath: reference.relativePath,
      },
    });
    if (sameFileMatch.match) {
      return sameFileMatch.match;
    }

    const sameWorkspaceMatch = await resolveDefinition(context, {
      lookup: {
        name: reference.name,
        languageId: reference.languageId,
        workspaceRoot: reference.workspaceRoot,
      },
    });
    if (sameWorkspaceMatch.match) {
      return sameWorkspaceMatch.match;
    }

    const globalMatch = await resolveDefinition(context, {
      lookup: {
        name: reference.name,
        languageId: reference.languageId,
      },
    });
    return globalMatch.match;
  })();
  resolveCache.set(cacheKey, pending);
  return pending;
}

function createRelationshipEdge(
  relationshipKind: RelationshipKind,
  hopCount: number,
  relatedSymbol: DefinitionMatch,
  evidence: ReferenceMatch,
): RelationshipEdge {
  return {
    relationshipKind,
    hopCount,
    relatedSymbol,
    evidence,
  };
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

function createRelationshipEdgeKey(edge: RelationshipEdge): string {
  return JSON.stringify([
    edge.relationshipKind,
    edge.relatedSymbol.workspaceRoot,
    edge.relatedSymbol.relativePath,
    edge.relatedSymbol.selectionRange.start.offset,
    edge.evidence.workspaceRoot,
    edge.evidence.relativePath,
    edge.evidence.selectionRange.start.offset,
    edge.hopCount,
  ]);
}

function compareWorkspaceRoots(left: string, right: string, configuredRoots: readonly string[]): number {
  if (left === right) {
    return 0;
  }

  const order = new Map(configuredRoots.map((workspaceRoot, index) => [workspaceRoot, index] as const));
  const leftIndex = order.get(left);
  const rightIndex = order.get(right);

  if (leftIndex !== undefined || rightIndex !== undefined) {
    if (leftIndex === undefined) {
      return 1;
    }

    if (rightIndex === undefined) {
      return -1;
    }

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
  }

  return left.localeCompare(right);
}

function sortRelationshipEdges(
  edges: readonly RelationshipEdge[],
  configuredRoots: readonly string[],
): RelationshipEdge[] {
  const relationshipKindOrder = new Map(
    DEFAULT_RELATIONSHIP_KINDS.map((relationshipKind, index) => [relationshipKind, index] as const),
  );

  return [...edges].sort((left, right) => {
    if (left.hopCount !== right.hopCount) {
      return left.hopCount - right.hopCount;
    }

    const leftKindOrder = relationshipKindOrder.get(left.relationshipKind) ?? Number.MAX_SAFE_INTEGER;
    const rightKindOrder = relationshipKindOrder.get(right.relationshipKind) ?? Number.MAX_SAFE_INTEGER;
    if (leftKindOrder !== rightKindOrder) {
      return leftKindOrder - rightKindOrder;
    }

    const relatedWorkspaceComparison = compareWorkspaceRoots(
      left.relatedSymbol.workspaceRoot,
      right.relatedSymbol.workspaceRoot,
      configuredRoots,
    );
    if (relatedWorkspaceComparison !== 0) {
      return relatedWorkspaceComparison;
    }

    if (left.relatedSymbol.relativePath !== right.relatedSymbol.relativePath) {
      return left.relatedSymbol.relativePath.localeCompare(right.relatedSymbol.relativePath);
    }

    if (left.relatedSymbol.selectionRange.start.offset !== right.relatedSymbol.selectionRange.start.offset) {
      return left.relatedSymbol.selectionRange.start.offset - right.relatedSymbol.selectionRange.start.offset;
    }

    const evidenceWorkspaceComparison = compareWorkspaceRoots(
      left.evidence.workspaceRoot,
      right.evidence.workspaceRoot,
      configuredRoots,
    );
    if (evidenceWorkspaceComparison !== 0) {
      return evidenceWorkspaceComparison;
    }

    if (left.evidence.relativePath !== right.evidence.relativePath) {
      return left.evidence.relativePath.localeCompare(right.evidence.relativePath);
    }

    return left.evidence.selectionRange.start.offset - right.evidence.selectionRange.start.offset;
  });
}

function countMatchedFiles(edges: readonly RelationshipEdge[]): number {
  return new Set(
    edges.map((edge) => JSON.stringify([edge.relatedSymbol.workspaceRoot, edge.relatedSymbol.relativePath])),
  ).size;
}

function trackSearchableFiles(
  trackedFiles: Map<string, SearchableRelationshipFile>,
  files: readonly SearchableRelationshipFile[],
): void {
  for (const file of files) {
    trackedFiles.set(JSON.stringify([file.workspaceRoot, file.relativePath]), file);
  }
}

function isReferenceWithinDefinition(reference: ReferenceMatch, definition: DefinitionMatch): boolean {
  return reference.selectionRange.start.offset >= definition.range.start.offset
    && reference.selectionRange.end.offset <= definition.range.end.offset;
}

function isSameDefinition(left: DefinitionMatch, right: DefinitionMatch): boolean {
  return left.workspaceRoot === right.workspaceRoot
    && left.relativePath === right.relativePath
    && left.selectionRange.start.offset === right.selectionRange.start.offset
    && left.selectionRange.end.offset === right.selectionRange.end.offset;
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

function getCompatibleLanguageIds(languageId: string): Set<string> {
  if (languageId === "typescript" || languageId === "tsx") {
    return new Set(["typescript", "tsx"]);
  }

  return new Set([languageId]);
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

function normalizeEnclosingKind(kind: EnclosingContext["kind"]): DefinitionMatch["kind"] {
  switch (kind) {
    case "class":
      return "class";
    case "interface":
      return "interface";
    case "method":
      return "method";
    case "function":
    default:
      return "function";
  }
}

function createSkippedOwnerDiagnostic(
  target: DefinitionMatch,
  reference: ReferenceMatch,
): Diagnostic {
  return createDiagnostic({
    code: "reference_not_found",
    severity: "warning",
    message: `Skipped incoming relationship evidence for ${target.name} because the reference is not enclosed by a named owner symbol.`,
    reason: "Incoming relationship edges are anchored to named enclosing definitions so the related symbol can be resolved precisely.",
    nextStep: "Inspect search_references for raw evidence when top-level relationships matter.",
    filePath: reference.filePath,
    relativePath: reference.relativePath,
    languageId: reference.languageId,
    range: reference.selectionRange,
  });
}

function createUnresolvedRelationshipDiagnostic(
  target: DefinitionMatch,
  reference: ReferenceMatch,
  direction: "incoming" | "outgoing",
): Diagnostic {
  return createDiagnostic({
    code: "definition_not_found",
    severity: "warning",
    message: `Skipped ${direction} relationship evidence for ${target.name} because ${reference.name} could not be resolved to a definition.`,
    reason: "Relationship edges stay definition-backed so callers can navigate to the related symbol precisely.",
    nextStep: "Verify the referenced symbol exists inside the indexed workspace snapshot and retry.",
    filePath: reference.filePath,
    relativePath: reference.relativePath,
    languageId: reference.languageId,
    range: reference.selectionRange,
  });
}

function createSelfRelationshipDiagnostic(
  target: DefinitionMatch,
  reference: ReferenceMatch,
  direction: "incoming" | "outgoing",
): Diagnostic {
  return createDiagnostic({
    code: "reference_not_found",
    severity: "info",
    message: `Skipped ${direction} self-relationship evidence for ${target.name}.`,
    reason: "Phase 06 relationship views only return edges to distinct related symbols, not recursive self-links.",
    nextStep: "Use the reference evidence directly if you need to inspect the recursive site.",
    filePath: reference.filePath,
    relativePath: reference.relativePath,
    languageId: reference.languageId,
    range: reference.selectionRange,
  });
}
