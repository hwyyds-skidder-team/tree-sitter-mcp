import type { EnclosingContext } from "../context/contextTypes.js";
import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import {
  resolveDefinition,
  type ResolveDefinitionRequest,
} from "../definitions/resolveDefinition.js";
import type { DefinitionMatch } from "../definitions/definitionTypes.js";
import {
  type IndexedFileSemanticRecord,
  type SearchFreshness,
} from "../indexing/indexTypes.js";
import { type FreshRecordsResult } from "../indexing/semanticIndexCoordinator.js";
import {
  filterReferenceSearchableFiles,
  normalizeReferenceFilters,
} from "../references/referenceFilters.js";
import { searchReferences } from "../references/searchReferences.js";
import type { ReferenceMatch } from "../references/referenceTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import { DEFAULT_RELATIONSHIP_KINDS } from "./relationshipFilters.js";
import {
  type RelationshipEdge,
  type RelationshipKind,
} from "./relationshipTypes.js";

const INTERNAL_REFERENCE_PAGE_LIMIT = 200;

export type SearchableRelationshipFile = Pick<
  IndexedFileSemanticRecord,
  "workspaceRoot" | "relativePath" | "languageId"
>;

export interface RelationshipTraversalFilters {
  workspaceRoots?: readonly string[];
  language: string | null;
  relationshipKinds: readonly RelationshipKind[];
  maxDepth: number;
}

export interface CollectDirectRelationshipEdgesOptions {
  hopCount: number;
  filters: RelationshipTraversalFilters;
  freshIndex: FreshRecordsResult;
  diagnostics: Diagnostic[];
  searchableFiles: Map<string, SearchableRelationshipFile>;
  freshnesses: SearchFreshness[];
  resolveCache?: Map<string, Promise<DefinitionMatch | null>>;
  ownerResolveCache?: Map<string, Promise<DefinitionMatch | null>>;
}

export async function collectDirectRelationshipEdges(
  context: ServerContext,
  frontier: DefinitionMatch,
  options: CollectDirectRelationshipEdgesOptions,
): Promise<RelationshipEdge[]> {
  const resolveCache = options.resolveCache ?? new Map<string, Promise<DefinitionMatch | null>>();
  const ownerResolveCache = options.ownerResolveCache ?? new Map<string, Promise<DefinitionMatch | null>>();
  const [incomingEdges, outgoingEdges] = await Promise.all([
    collectIncomingEdges(context, frontier, options, ownerResolveCache),
    collectOutgoingEdges(context, frontier, options, resolveCache),
  ]);

  return [...incomingEdges, ...outgoingEdges];
}

export function createRelationshipEdgeKey(edge: RelationshipEdge): string {
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

export function sortRelationshipEdges(
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

async function collectIncomingEdges(
  context: ServerContext,
  frontier: DefinitionMatch,
  options: CollectDirectRelationshipEdgesOptions,
  ownerResolveCache: Map<string, Promise<DefinitionMatch | null>>,
): Promise<RelationshipEdge[]> {
  const referenceFiltersResult = normalizeReferenceFilters({
    workspaceRoot: context.workspace.root ?? frontier.workspaceRoot,
    configuredRoots: context.workspace.roots,
    languageRegistry: context.languageRegistry,
    input: {
      workspaceRoots: options.filters.workspaceRoots,
      language: options.filters.language,
    },
  });
  if (referenceFiltersResult.diagnostic) {
    options.diagnostics.push(referenceFiltersResult.diagnostic);
    return [];
  }

  const compatibleLanguageIds = getCompatibleLanguageIds(frontier.languageId);
  const searchableFiles = filterReferenceSearchableFiles(
    options.freshIndex.records.filter((file) => compatibleLanguageIds.has(file.languageId)),
    referenceFiltersResult.filters,
  );
  trackSearchableFiles(options.searchableFiles, searchableFiles);

  const references = await collectAllReferences(context, frontier, options.filters, options);
  const edges: RelationshipEdge[] = [];

  for (const reference of references) {
    if (!reference.enclosingContext?.name) {
      options.diagnostics.push(createSkippedOwnerDiagnostic(frontier, reference));
      continue;
    }

    const owner = await resolveOwnerDefinition(context, reference, ownerResolveCache);
    if (!owner) {
      options.diagnostics.push(createUnresolvedRelationshipDiagnostic(frontier, reference, "incoming"));
      continue;
    }

    if (isSameDefinition(owner, frontier)) {
      options.diagnostics.push(createSelfRelationshipDiagnostic(frontier, reference, "incoming"));
      continue;
    }

    const edge = createRelationshipEdge(
      reference.referenceKind === "call" ? "incoming_call" : "incoming_reference",
      options.hopCount,
      owner,
      reference,
    );

    if (!matchesRelationshipTraversalFilters(edge, options.filters)) {
      continue;
    }

    edges.push(edge);
  }

  return edges;
}

async function collectOutgoingEdges(
  context: ServerContext,
  frontier: DefinitionMatch,
  options: CollectDirectRelationshipEdgesOptions,
  resolveCache: Map<string, Promise<DefinitionMatch | null>>,
): Promise<RelationshipEdge[]> {
  const frontierRecord = options.freshIndex.records.find((record) =>
    record.workspaceRoot === frontier.workspaceRoot && record.relativePath === frontier.relativePath);

  if (!frontierRecord) {
    return [];
  }

  trackSearchableFiles(options.searchableFiles, [frontierRecord]);

  const references = frontierRecord.references.filter((reference) =>
    isReferenceWithinDefinition(reference, frontier));
  const edges: RelationshipEdge[] = [];

  for (const reference of references) {
    const relatedDefinition = await resolveReferencedDefinition(context, reference, resolveCache);
    if (!relatedDefinition) {
      options.diagnostics.push(createUnresolvedRelationshipDiagnostic(frontier, reference, "outgoing"));
      continue;
    }

    if (isSameDefinition(relatedDefinition, frontier)) {
      options.diagnostics.push(createSelfRelationshipDiagnostic(frontier, reference, "outgoing"));
      continue;
    }

    const edge = createRelationshipEdge(
      reference.referenceKind === "call" ? "outgoing_call" : "outgoing_reference",
      options.hopCount,
      relatedDefinition,
      reference,
    );

    if (!matchesRelationshipTraversalFilters(edge, options.filters)) {
      continue;
    }

    edges.push(edge);
  }

  return edges;
}

async function collectAllReferences(
  context: ServerContext,
  frontier: DefinitionMatch,
  filters: RelationshipTraversalFilters,
  options: CollectDirectRelationshipEdgesOptions,
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
      workspaceRoots: filters.workspaceRoots ? [...filters.workspaceRoots] : undefined,
      language: filters.language ?? undefined,
      limit: INTERNAL_REFERENCE_PAGE_LIMIT,
      offset,
      includeContext: true,
    });

    options.freshnesses.push(page.freshness);
    options.diagnostics.push(
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

function matchesRelationshipTraversalFilters(
  edge: RelationshipEdge,
  filters: RelationshipTraversalFilters,
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

function getCompatibleLanguageIds(languageId: string): Set<string> {
  if (languageId === "typescript" || languageId === "tsx") {
    return new Set(["typescript", "tsx"]);
  }

  return new Set([languageId]);
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
