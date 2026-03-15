import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { SymbolMatch } from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import { collectFileDefinitions } from "./definitionPipeline.js";

export interface SearchDefinitionsRequest {
  query: string;
  limit?: number;
}

export interface SearchDefinitionsResult {
  results: SymbolMatch[];
  diagnostics: Diagnostic[];
  searchedFiles: number;
  matchedFiles: number;
}

export async function searchDefinitions(
  context: ServerContext,
  request: SearchDefinitionsRequest,
): Promise<SearchDefinitionsResult> {
  const normalizedQuery = request.query.trim().toLowerCase();
  const limit = request.limit ?? 50;

  if (!context.workspace.root) {
    return {
      results: [],
      diagnostics: [createDiagnostic({
        code: "workspace_not_set",
        message: "No workspace is configured.",
        reason: "Definition search requires an active workspace snapshot.",
        nextStep: "Call set_workspace before searching definitions.",
      })],
      searchedFiles: 0,
      matchedFiles: 0,
    };
  }

  if (normalizedQuery.length === 0) {
    return {
      results: [],
      diagnostics: [],
      searchedFiles: 0,
      matchedFiles: 0,
    };
  }

  const diagnostics: Diagnostic[] = [];
  const matches: Array<SymbolMatch & { score: number }> = [];
  let searchedFiles = 0;

  for (const file of context.workspace.searchableFiles) {
    searchedFiles += 1;
    const result = await collectFileDefinitions(context, file);
    diagnostics.push(...result.diagnostics);

    for (const definition of result.definitions) {
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
    if (left.score !== right.score) {
      return left.score - right.score;
    }

    if (left.relativePath !== right.relativePath) {
      return left.relativePath.localeCompare(right.relativePath);
    }

    return left.range.start.offset - right.range.start.offset;
  });

  const results = matches.slice(0, limit).map(({ score: _score, ...definition }) => definition);

  return {
    results,
    diagnostics,
    searchedFiles,
    matchedFiles: new Set(results.map((definition) => definition.relativePath)).size,
  };
}

function scoreDefinitionMatch(definition: SymbolMatch, normalizedQuery: string): number | null {
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
