import { createDiagnostic, type Diagnostic } from "../../diagnostics/diagnosticFactory.js";
import { createSearchFreshness, type SearchFreshness } from "../indexing/indexTypes.js";
import type { SymbolKind } from "../../queries/queryCatalog.js";
import { compareWorkspaceAwareMatches, scoreNameMatch } from "../../results/searchRanking.js";
import type { ServerContext } from "../../server/serverContext.js";
import {
  filterSearchableFiles,
  matchesDefinitionFilters,
  normalizeDefinitionFilters,
} from "./definitionFilters.js";
import type { DefinitionFilters, DefinitionMatch } from "./definitionTypes.js";
import { normalizeDefinitionMatches } from "./normalizeDefinitionMatch.js";

export interface SearchDefinitionsRequest {
  query: string;
  limit?: number;
  workspaceRoots?: string[];
  language?: string;
  pathPrefix?: string;
  symbolKinds?: SymbolKind[];
}

export interface SearchDefinitionsResult {
  filters: DefinitionFilters;
  results: DefinitionMatch[];
  freshness: SearchFreshness;
  diagnostics: Diagnostic[];
  searchedFiles: number;
  matchedFiles: number;
  truncated: boolean;
}

export async function searchDefinitions(
  context: ServerContext,
  request: SearchDefinitionsRequest,
): Promise<SearchDefinitionsResult> {
  const limit = request.limit ?? 50;
  const emptyFilters: DefinitionFilters = {
    workspaceRoots: undefined,
    language: null,
    pathPrefix: null,
    symbolKinds: [],
  };

  if (!context.workspace.root) {
    return {
      filters: emptyFilters,
      results: [],
      freshness: createSearchFreshness({
        state: context.workspace.index.state,
        checkedAt: new Date().toISOString(),
        refreshedFiles: [],
        degradedFiles: [],
        workspaceFingerprint: context.workspace.index.workspaceFingerprint,
      }),
      diagnostics: [createDiagnostic({
        code: "workspace_not_set",
        message: "No workspace is configured.",
        reason: "Definition search requires an active workspace snapshot.",
        nextStep: "Call set_workspace before searching definitions.",
      })],
      searchedFiles: 0,
      matchedFiles: 0,
      truncated: false,
    };
  }

  const normalizedFiltersResult = normalizeDefinitionFilters({
    workspaceRoot: context.workspace.root,
    configuredRoots: context.workspace.roots,
    languageRegistry: context.languageRegistry,
    input: {
      workspaceRoots: request.workspaceRoots,
      language: request.language,
      pathPrefix: request.pathPrefix,
      symbolKinds: request.symbolKinds,
    },
  });

  if (normalizedFiltersResult.diagnostic) {
    return {
      filters: normalizedFiltersResult.filters,
      results: [],
      freshness: createSearchFreshness({
        state: context.workspace.index.state,
        checkedAt: new Date().toISOString(),
        refreshedFiles: [],
        degradedFiles: [],
        workspaceFingerprint: context.workspace.index.workspaceFingerprint,
      }),
      diagnostics: [normalizedFiltersResult.diagnostic],
      searchedFiles: 0,
      matchedFiles: 0,
      truncated: false,
    };
  }

  const normalizedQuery = request.query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return {
      filters: normalizedFiltersResult.filters,
      results: [],
      freshness: createSearchFreshness({
        state: context.workspace.index.state,
        checkedAt: new Date().toISOString(),
        refreshedFiles: [],
        degradedFiles: [],
        workspaceFingerprint: context.workspace.index.workspaceFingerprint,
      }),
      diagnostics: [],
      searchedFiles: 0,
      matchedFiles: 0,
      truncated: false,
    };
  }

  const diagnostics: Diagnostic[] = [];
  const matches: DefinitionMatch[] = [];
  const freshIndex = await context.semanticIndex.getFreshRecords(context);
  const searchableFiles = filterSearchableFiles(freshIndex.records, normalizedFiltersResult.filters);
  let searchedFiles = 0;

  for (const file of searchableFiles) {
    searchedFiles += 1;
    diagnostics.push(...file.diagnostics);

    for (const definition of normalizeDefinitionMatches(file.definitions)) {
      if (!matchesDefinitionFilters(definition, normalizedFiltersResult.filters)) {
        continue;
      }

      if (scoreNameMatch(definition.name, normalizedQuery) === null) {
        continue;
      }

      matches.push(definition);
    }
  }

  matches.sort((left, right) => {
    return compareWorkspaceAwareMatches(left, right, {
      normalizedQuery,
      workspaceRoots: context.workspace.roots,
    });
  });

  const truncated = matches.length > limit;
  const results = matches.slice(0, limit);

  return {
    filters: normalizedFiltersResult.filters,
    results,
    freshness: freshIndex.freshness,
    diagnostics,
    searchedFiles,
    matchedFiles: new Set(
      results.map((definition) => JSON.stringify([definition.workspaceRoot, definition.relativePath])),
    ).size,
    truncated,
  };
}
