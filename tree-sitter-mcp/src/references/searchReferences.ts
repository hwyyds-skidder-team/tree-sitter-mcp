import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { resolveDefinition } from "../definitions/resolveDefinition.js";
import type {
  DefinitionLookupRequest,
  DefinitionSymbolDescriptor,
} from "../definitions/resolveDefinition.js";
import type { DefinitionMatch } from "../definitions/definitionTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import { collectFileReferences } from "./referencePipeline.js";
import type { ReferenceMatch } from "./referenceTypes.js";

export interface SearchReferencesRequest {
  symbol?: DefinitionSymbolDescriptor;
  lookup?: DefinitionLookupRequest;
  limit?: number;
}

export interface SearchReferencesResult {
  target: DefinitionMatch | null;
  results: ReferenceMatch[];
  diagnostic: Diagnostic | null;
  diagnostics: Diagnostic[];
  searchedFiles: number;
  matchedFiles: number;
  truncated: boolean;
}

export async function searchReferences(
  context: ServerContext,
  request: SearchReferencesRequest,
): Promise<SearchReferencesResult> {
  const limit = request.limit ?? 100;

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

    matches.push(...fileResult.references.filter((reference) => !isDefinitionSelection(reference, targetMatch)));
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

  const truncated = matches.length > limit;
  const results = matches.slice(0, limit);
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
