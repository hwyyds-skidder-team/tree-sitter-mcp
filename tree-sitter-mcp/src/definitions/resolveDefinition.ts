import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { SymbolKind } from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import {
  filterSearchableFiles,
  matchesDefinitionFilters,
  normalizeDefinitionFilters,
} from "./definitionFilters.js";
import { collectFileDefinitions } from "./definitionPipeline.js";
import type { DefinitionFilters, DefinitionMatch } from "./definitionTypes.js";
import { normalizeDefinitionMatches } from "./normalizeDefinitionMatch.js";

export interface DefinitionSymbolDescriptor {
  name: string;
  languageId?: string;
  relativePath?: string;
  kind?: SymbolKind;
}

export interface DefinitionLookupRequest {
  name: string;
  languageId?: string;
  relativePath?: string;
  kind?: SymbolKind;
}

export interface ResolveDefinitionRequest {
  symbol?: DefinitionSymbolDescriptor;
  lookup?: DefinitionLookupRequest;
}

export interface ResolveDefinitionResult {
  filters: DefinitionFilters;
  match: DefinitionMatch | null;
  diagnostic: Diagnostic | null;
  diagnostics: Diagnostic[];
  searchedFiles: number;
}

export async function resolveDefinition(
  context: ServerContext,
  request: ResolveDefinitionRequest,
): Promise<ResolveDefinitionResult> {
  const emptyFilters: DefinitionFilters = {
    language: null,
    pathPrefix: null,
    symbolKinds: [],
  };

  if (!context.workspace.root) {
    const diagnostic = createDiagnostic({
      code: "workspace_not_set",
      message: "No workspace is configured.",
      reason: "Definition resolution requires an active workspace snapshot.",
      nextStep: "Call set_workspace before resolving definitions.",
    });

    return {
      filters: emptyFilters,
      match: null,
      diagnostic,
      diagnostics: [diagnostic],
      searchedFiles: 0,
    };
  }

  const target = request.symbol ?? request.lookup;
  if (!target) {
    const diagnostic = createDiagnostic({
      code: "definition_not_found",
      message: "No definition target was provided.",
      reason: "Definition resolution needs a symbol name or lookup request.",
      nextStep: "Provide a symbol descriptor or lookup name and retry.",
    });

    return {
      filters: emptyFilters,
      match: null,
      diagnostic,
      diagnostics: [diagnostic],
      searchedFiles: 0,
    };
  }

  const normalizedName = target.name.trim().toLowerCase();
  const normalizedFiltersResult = normalizeDefinitionFilters({
    workspaceRoot: context.workspace.root,
    languageRegistry: context.languageRegistry,
    input: {
      language: target.languageId,
      pathPrefix: target.relativePath,
      symbolKinds: target.kind ? [target.kind] : [],
    },
  });

  if (normalizedName.length === 0) {
    const diagnostic = createDiagnostic({
      code: "definition_not_found",
      message: "No definition target was provided.",
      reason: "Definition resolution needs a symbol name or lookup request.",
      nextStep: "Provide a symbol descriptor or lookup name and retry.",
    });

    return {
      filters: normalizedFiltersResult.filters,
      match: null,
      diagnostic,
      diagnostics: [diagnostic],
      searchedFiles: 0,
    };
  }

  if (normalizedFiltersResult.diagnostic) {
    return {
      filters: normalizedFiltersResult.filters,
      match: null,
      diagnostic: normalizedFiltersResult.diagnostic,
      diagnostics: [normalizedFiltersResult.diagnostic],
      searchedFiles: 0,
    };
  }

  const filesToSearch = filterSearchableFiles(context.workspace.searchableFiles, normalizedFiltersResult.filters);
  const orderedFiles = prioritizeSearchableFiles(filesToSearch, normalizedFiltersResult.filters.pathPrefix);
  const diagnostics: Diagnostic[] = [];
  const matches: DefinitionMatch[] = [];
  let searchedFiles = 0;

  for (const file of orderedFiles) {
    searchedFiles += 1;
    const result = await collectFileDefinitions(context, file);
    diagnostics.push(...result.diagnostics);

    matches.push(...normalizeDefinitionMatches(result.definitions).filter((definition) => {
      if (definition.name.toLowerCase() !== normalizedName) {
        return false;
      }

      return matchesDefinitionFilters(definition, normalizedFiltersResult.filters);
    }));
  }

  const match = rankDefinitionMatches(matches, target, normalizedFiltersResult.filters)[0] ?? null;
  if (match) {
    return {
      filters: normalizedFiltersResult.filters,
      match,
      diagnostic: null,
      diagnostics,
      searchedFiles,
    };
  }

  const diagnostic = createDiagnostic({
    code: "definition_not_found",
    message: `No definition match was found for ${target.name}.`,
    reason: "The active workspace snapshot does not contain a matching parsed definition.",
    nextStep: "Check the lookup spelling, adjust the workspace snapshot, or broaden the search criteria.",
    ...(normalizedFiltersResult.filters.pathPrefix ? { relativePath: normalizedFiltersResult.filters.pathPrefix } : {}),
    ...(normalizedFiltersResult.filters.language ? { languageId: normalizedFiltersResult.filters.language } : {}),
  });

  diagnostics.push(diagnostic);

  return {
    filters: normalizedFiltersResult.filters,
    match: null,
    diagnostic,
    diagnostics,
    searchedFiles,
  };
}

function prioritizeSearchableFiles(
  files: ServerContext["workspace"]["searchableFiles"],
  preferredPathPrefix: string | null,
) {
  return [...files].sort((left, right) => {
    if (preferredPathPrefix) {
      const leftPriority = left.relativePath === preferredPathPrefix ? 0 : 1;
      const rightPriority = right.relativePath === preferredPathPrefix ? 0 : 1;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
    }

    return left.relativePath.localeCompare(right.relativePath);
  });
}

function rankDefinitionMatches(
  matches: DefinitionMatch[],
  target: DefinitionLookupRequest | DefinitionSymbolDescriptor,
  filters: DefinitionFilters,
): DefinitionMatch[] {
  return [...matches].sort((left, right) => {
    const leftScore = scoreDefinition(left, target, filters);
    const rightScore = scoreDefinition(right, target, filters);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }

    if (left.relativePath !== right.relativePath) {
      return left.relativePath.localeCompare(right.relativePath);
    }

    return left.range.start.offset - right.range.start.offset;
  });
}

function scoreDefinition(
  definition: DefinitionMatch,
  target: DefinitionLookupRequest | DefinitionSymbolDescriptor,
  filters: DefinitionFilters,
): number {
  let score = 0;

  if (filters.pathPrefix && definition.relativePath !== filters.pathPrefix) {
    score += 10;
  }

  if (filters.language && definition.languageId !== filters.language) {
    score += 5;
  }

  if (target.kind && definition.kind !== target.kind) {
    score += 2;
  }

  return score;
}
