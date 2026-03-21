import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { createSearchFreshness, type SearchFreshness } from "../indexing/indexTypes.js";
import type { SymbolKind } from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
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
    languageRegistry: context.languageRegistry,
    input: {
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
  const matches: Array<DefinitionMatch & { score: number }> = [];
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

      const score = scoreDefinitionMatch(definition, normalizedQuery);
      if (score === null) {
        continue;
      }

      matches.push({
        ...definition,
        score,
      });
    }
  }

  matches.sort((left, right) => {
    if (left.score != right.score) {
      return left.score - right.score;
    }

    if (left.relativePath != right.relativePath) {
      return left.relativePath.localeCompare(right.relativePath);
    }

    return left.range.start.offset - right.range.start.offset;
  });

  const truncated = matches.length > limit;
  const results = matches.slice(0, limit).map(({ score: _score, ...definition }) => definition);

  return {
    filters: normalizedFiltersResult.filters,
    results,
    freshness: freshIndex.freshness,
    diagnostics,
    searchedFiles,
    matchedFiles: new Set(results.map((definition) => definition.relativePath)).size,
    truncated,
  };
}

function scoreDefinitionMatch(definition: DefinitionMatch, normalizedQuery: string): number | null {
  const normalizedName = definition.name.toLowerCase();
  if (normalizedName === normalizedQuery) {
    return 0;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 100 + (normalizedName.length - normalizedQuery.length);
  }

  const containsIndex = normalizedName.indexOf(normalizedQuery);
  if (containsIndex >= 0) {
    return 200 + containsIndex + (normalizedName.length - normalizedQuery.length);
  }

  return null;
}
