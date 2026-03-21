import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { resolveDefinition } from "../definitions/resolveDefinition.js";
import type {
  DefinitionLookupRequest,
  DefinitionSymbolDescriptor,
} from "../definitions/resolveDefinition.js";
import type { DefinitionMatch } from "../definitions/definitionTypes.js";
import { createSearchFreshness, type SearchFreshness } from "../indexing/indexTypes.js";
import { paginateResults, type Pagination } from "../results/paginateResults.js";
import type { ServerContext } from "../server/serverContext.js";
import type { ReferenceMatch } from "./referenceTypes.js";

export interface SearchReferencesRequest {
  symbol?: DefinitionSymbolDescriptor;
  lookup?: DefinitionLookupRequest;
  limit?: number;
  offset?: number;
  includeContext?: boolean;
}

export interface SearchReferencesResult {
  target: DefinitionMatch | null;
  results: ReferenceMatch[];
  freshness: SearchFreshness;
  diagnostic: Diagnostic | null;
  diagnostics: Diagnostic[];
  searchedFiles: number;
  matchedFiles: number;
  pagination: Pagination;
  truncated: boolean;
}

export async function searchReferences(
  context: ServerContext,
  request: SearchReferencesRequest,
): Promise<SearchReferencesResult> {
  const limit = request.limit ?? 50;
  const offset = request.offset ?? 0;
  const includeContext = request.includeContext ?? true;

  if (!context.workspace.root) {
    const diagnostic = createDiagnostic({
      code: "workspace_not_set",
      message: "No workspace is configured.",
      reason: "Reference search requires an active workspace snapshot.",
      nextStep: "Call set_workspace before searching references.",
    });

    return {
      target: null,
      results: [],
      freshness: createSearchFreshness({
        state: context.workspace.index.state,
        checkedAt: new Date().toISOString(),
        refreshedFiles: [],
        degradedFiles: [],
        workspaceFingerprint: context.workspace.index.workspaceFingerprint,
      }),
      diagnostic,
      diagnostics: [diagnostic],
      searchedFiles: 0,
      matchedFiles: 0,
      pagination: paginateResults([], { limit, offset }).pagination,
      truncated: false,
    };
  }

  const targetRequest = request.symbol ?? request.lookup;
  if (!targetRequest) {
    const diagnostic = createDiagnostic({
      code: "reference_not_found",
      message: "No reference target was provided.",
      reason: "Reference search needs a symbol descriptor or lookup request.",
      nextStep: "Provide a symbol descriptor or lookup name and retry.",
    });

    return {
      target: null,
      results: [],
      freshness: createSearchFreshness({
        state: context.workspace.index.state,
        checkedAt: new Date().toISOString(),
        refreshedFiles: [],
        degradedFiles: [],
        workspaceFingerprint: context.workspace.index.workspaceFingerprint,
      }),
      diagnostic,
      diagnostics: [diagnostic],
      searchedFiles: 0,
      matchedFiles: 0,
      pagination: paginateResults([], { limit, offset }).pagination,
      truncated: false,
    };
  }

  const targetResult = await resolveDefinition(context, request.symbol
    ? { symbol: request.symbol }
    : { lookup: request.lookup });
  const diagnostics = [...targetResult.diagnostics];

  if (!targetResult.match) {
    return {
      target: null,
      results: [],
      freshness: createSearchFreshness({
        state: context.workspace.index.state,
        checkedAt: new Date().toISOString(),
        refreshedFiles: [],
        degradedFiles: [],
        workspaceFingerprint: context.workspace.index.workspaceFingerprint,
      }),
      diagnostic: targetResult.diagnostic,
      diagnostics: dedupeDiagnostics(diagnostics),
      searchedFiles: 0,
      matchedFiles: 0,
      pagination: paginateResults([], { limit, offset }).pagination,
      truncated: false,
    };
  }

  const targetMatch = targetResult.match;
  const compatibleLanguageIds = getCompatibleLanguageIds(targetMatch.languageId);
  const freshIndex = await context.semanticIndex.getFreshRecords(context);

  const candidateFiles = freshIndex.records
    .filter((file) => compatibleLanguageIds.has(file.languageId))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const matches: ReferenceMatch[] = [];
  let searchedFiles = 0;

  for (const file of candidateFiles) {
    searchedFiles += 1;
    diagnostics.push(...file.diagnostics);

    const references = file.references
      .filter((reference) => reference.name.toLowerCase() === targetMatch.name.toLowerCase())
      .filter((reference) => !isDefinitionSelection(reference, targetMatch))
      .map((reference) => shapeReferenceMatch(reference, targetMatch.kind, includeContext));

    matches.push(...references);
  }

  matches.sort((left, right) => {
    if (left.relativePath !== right.relativePath) {
      return left.relativePath.localeCompare(right.relativePath);
    }

    if (left.referenceKind !== right.referenceKind) {
      return left.referenceKind === "call" ? -1 : 1;
    }

    return left.range.start.offset - right.range.start.offset;
  });

  const pagedResults = paginateResults(matches, { limit, offset });
  const truncated = pagedResults.pagination.hasMore;
  const results = pagedResults.items;
  const matchedFiles = new Set(results.map((reference) => reference.relativePath)).size;

  if (results.length === 0) {
    const diagnostic = createDiagnostic({
      code: "reference_not_found",
      message: `No references were found for ${targetMatch.name}.`,
      reason: "The active workspace snapshot does not contain any matching usages for the resolved symbol target.",
      nextStep: "Broaden the workspace scope, verify the symbol name, or retry after adding more source files.",
      relativePath: targetMatch.relativePath,
      languageId: targetMatch.languageId,
    });

    diagnostics.push(diagnostic);
    return {
      target: targetMatch,
      results,
      freshness: freshIndex.freshness,
      diagnostic,
      diagnostics: dedupeDiagnostics(diagnostics),
      searchedFiles,
      matchedFiles,
      pagination: pagedResults.pagination,
      truncated,
    };
  }

  return {
    target: targetMatch,
    results,
    freshness: freshIndex.freshness,
    diagnostic: null,
    diagnostics: dedupeDiagnostics(diagnostics),
    searchedFiles,
    matchedFiles,
    pagination: pagedResults.pagination,
    truncated,
  };
}

function isDefinitionSelection(reference: ReferenceMatch, target: DefinitionMatch): boolean {
  return reference.relativePath === target.relativePath
    && reference.selectionRange.start.offset === target.selectionRange.start.offset
    && reference.selectionRange.end.offset === target.selectionRange.end.offset;
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

function shapeReferenceMatch(
  reference: ReferenceMatch,
  symbolKind: DefinitionMatch["kind"],
  includeContext: boolean,
): ReferenceMatch {
  if (includeContext) {
    return {
      ...reference,
      symbolKind,
    };
  }

  return {
    name: reference.name,
    referenceKind: reference.referenceKind,
    symbolKind,
    languageId: reference.languageId,
    workspaceRoot: reference.workspaceRoot,
    filePath: reference.filePath,
    relativePath: reference.relativePath,
    range: reference.range,
    selectionRange: reference.selectionRange,
    containerName: reference.containerName,
    snippet: reference.snippet,
  };
}
