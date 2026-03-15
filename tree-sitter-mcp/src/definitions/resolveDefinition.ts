import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { SymbolKind, SymbolMatch } from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import { collectFileDefinitions } from "./definitionPipeline.js";

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
  match: SymbolMatch | null;
  diagnostic: Diagnostic | null;
  diagnostics: Diagnostic[];
  searchedFiles: number;
}

export async function resolveDefinition(
  context: ServerContext,
  request: ResolveDefinitionRequest,
): Promise<ResolveDefinitionResult> {
  if (!context.workspace.root) {
    const diagnostic = createDiagnostic({
      code: "workspace_not_set",
      message: "No workspace is configured.",
      reason: "Definition resolution requires an active workspace snapshot.",
      nextStep: "Call set_workspace before resolving definitions.",
    });

    return {
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
      match: null,
      diagnostic,
      diagnostics: [diagnostic],
      searchedFiles: 0,
    };
  }

  const normalizedName = target?.name.trim().toLowerCase() ?? "";
  if (normalizedName.length === 0) {
    const diagnostic = createDiagnostic({
      code: "definition_not_found",
      message: "No definition target was provided.",
      reason: "Definition resolution needs a symbol name or lookup request.",
      nextStep: "Provide a symbol descriptor or lookup name and retry.",
    });

    return {
      match: null,
      diagnostic,
      diagnostics: [diagnostic],
      searchedFiles: 0,
    };
  }

  const filesToSearch = context.workspace.searchableFiles.filter((file) => {
    if (target.languageId && file.languageId !== target.languageId) {
      return false;
    }

    if (target.relativePath && file.relativePath !== target.relativePath) {
      return false;
    }

    return true;
  });

  const orderedFiles = prioritizeSearchableFiles(filesToSearch, target.relativePath);
  const diagnostics: Diagnostic[] = [];
  const matches: SymbolMatch[] = [];
  let searchedFiles = 0;

  for (const file of orderedFiles) {
    searchedFiles += 1;
    const result = await collectFileDefinitions(context, file);
    diagnostics.push(...result.diagnostics);

    matches.push(...result.definitions.filter((definition) => {
      if (definition.name.toLowerCase() !== normalizedName) {
        return false;
      }

      if (target.kind && definition.kind !== target.kind) {
        return false;
      }

      return true;
    }));
  }

  const match = rankDefinitionMatches(matches, target)[0] ?? null;
  if (match) {
    return {
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
    ...(target.relativePath ? { relativePath: target.relativePath } : {}),
    ...(target.languageId ? { languageId: target.languageId } : {}),
  });

  diagnostics.push(diagnostic);

  return {
    match: null,
    diagnostic,
    diagnostics,
    searchedFiles,
  };
}

function prioritizeSearchableFiles(
  files: ServerContext["workspace"]["searchableFiles"],
  relativePath?: string,
) {
  return [...files].sort((left, right) => {
    if (relativePath) {
      const leftPriority = left.relativePath === relativePath ? 0 : 1;
      const rightPriority = right.relativePath === relativePath ? 0 : 1;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
    }

    return left.relativePath.localeCompare(right.relativePath);
  });
}

function rankDefinitionMatches(
  matches: SymbolMatch[],
  target: DefinitionLookupRequest | DefinitionSymbolDescriptor,
): SymbolMatch[] {
  return [...matches].sort((left, right) => {
    const leftScore = scoreDefinition(left, target);
    const rightScore = scoreDefinition(right, target);
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
  definition: SymbolMatch,
  target: DefinitionLookupRequest | DefinitionSymbolDescriptor,
): number {
  let score = 0;

  if (target.relativePath && definition.relativePath !== target.relativePath) {
    score += 10;
  }

  if (target.languageId && definition.languageId !== target.languageId) {
    score += 5;
  }

  if (target.kind && definition.kind !== target.kind) {
    score += 2;
  }

  return score;
}
