import { createContextSnippet } from "../context/contextSnippet.js";
import { extractEnclosingContext } from "../context/extractEnclosingContext.js";
import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { resolveDefinition } from "../definitions/resolveDefinition.js";
import type {
  DefinitionLookupRequest,
  DefinitionSymbolDescriptor,
} from "../definitions/resolveDefinition.js";
import type { DefinitionMatch } from "../definitions/definitionTypes.js";
import { parseWithDiagnostics } from "../parsing/parseWithDiagnostics.js";
import { paginateResults, type Pagination } from "../results/paginateResults.js";
import type { ServerContext } from "../server/serverContext.js";
import { collectFileReferences } from "./referencePipeline.js";
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

  const candidateFiles = context.workspace.searchableFiles
    .filter((file) => compatibleLanguageIds.has(file.languageId))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const matches: ReferenceMatch[] = [];
  let searchedFiles = 0;

  for (const file of candidateFiles) {
    searchedFiles += 1;
    const fileResult = await collectFileReferences(context, file, {
      targetName: targetMatch.name,
      symbolKind: targetMatch.kind,
    });
    diagnostics.push(...fileResult.diagnostics);

    let references = fileResult.references.filter((reference) => !isDefinitionSelection(reference, targetMatch));
    if (includeContext && references.length > 0) {
      const language = context.languageRegistry.getById(file.languageId);
      if (language) {
        const parseResult = await parseWithDiagnostics({
          absolutePath: file.path,
          relativePath: file.relativePath,
          language,
        });

        if (!parseResult.ok) {
          diagnostics.push(parseResult.diagnostic);
        } else {
          references = references.map((reference) => ({
            ...reference,
            enclosingContext: extractEnclosingContext({
              tree: parseResult.tree,
              startOffset: reference.selectionRange.start.offset,
              endOffset: reference.selectionRange.end.offset,
            }),
            contextSnippet: createContextSnippet({
              source: parseResult.source,
              startOffset: reference.selectionRange.start.offset,
              endOffset: reference.selectionRange.end.offset,
            }),
          }));
        }
      }
    }

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
