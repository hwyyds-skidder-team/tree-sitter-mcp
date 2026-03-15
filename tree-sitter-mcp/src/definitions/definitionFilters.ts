import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { LanguageRegistry } from "../languages/languageRegistry.js";
import type { SymbolKind } from "../queries/queryCatalog.js";
import {
  normalizeWorkspaceRelativePath,
  relativePathMatchesPrefix,
} from "../workspace/resolveWorkspace.js";
import type { SearchableFileRecord } from "../workspace/workspaceState.js";
import {
  DefinitionFilterSchema,
  type DefinitionFilterInput,
  type DefinitionFilters,
  type DefinitionMatch,
} from "./definitionTypes.js";

export interface NormalizeDefinitionFiltersOptions {
  workspaceRoot: string;
  languageRegistry: LanguageRegistry;
  input?: DefinitionFilterInput;
}

export interface NormalizeDefinitionFiltersResult {
  filters: DefinitionFilters;
  diagnostic: Diagnostic | null;
}

export function normalizeDefinitionFilters(
  options: NormalizeDefinitionFiltersOptions,
): NormalizeDefinitionFiltersResult {
  const rawLanguage = options.input?.language?.trim() ?? "";
  const normalizedLanguage = rawLanguage.length > 0 ? rawLanguage.toLowerCase() : null;
  const symbolKinds = dedupeSymbolKinds(options.input?.symbolKinds ?? []);

  let normalizedPathPrefix: string | null = null;
  if ((options.input?.pathPrefix?.trim() ?? "").length > 0) {
    try {
      normalizedPathPrefix = normalizeWorkspaceRelativePath(options.workspaceRoot, options.input?.pathPrefix ?? "");
    } catch (error) {
      const filters = DefinitionFilterSchema.parse({
        language: normalizedLanguage,
        pathPrefix: null,
        symbolKinds,
      });

      return {
        filters,
        diagnostic: createDiagnostic({
          code: "workspace_path_out_of_scope",
          message: "Path filter escapes the configured workspace root.",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Use a pathPrefix inside the active workspace root.",
          filePath: options.input?.pathPrefix ?? undefined,
        }),
      };
    }
  }

  const filters = DefinitionFilterSchema.parse({
    language: normalizedLanguage,
    pathPrefix: normalizedPathPrefix,
    symbolKinds,
  });

  if (normalizedLanguage && !options.languageRegistry.getById(normalizedLanguage)) {
    return {
      filters,
      diagnostic: createDiagnostic({
        code: "unsupported_language",
        message: `Language ${normalizedLanguage} is not registered in this server instance.`,
        reason: "The requested language filter does not match any builtin grammar registration.",
        nextStep: "Inspect get_capabilities for supported language identifiers and retry.",
        languageId: normalizedLanguage,
      }),
    };
  }

  return {
    filters,
    diagnostic: null,
  };
}

export function filterSearchableFiles(
  files: readonly SearchableFileRecord[],
  filters: DefinitionFilters,
): SearchableFileRecord[] {
  return files.filter((file) => matchesFileFilters(file, filters));
}

export function matchesDefinitionFilters(
  match: Pick<DefinitionMatch, "kind" | "languageId" | "relativePath">,
  filters: DefinitionFilters,
): boolean {
  if (filters.language && match.languageId !== filters.language) {
    return false;
  }

  if (filters.pathPrefix && !relativePathMatchesPrefix(match.relativePath, filters.pathPrefix)) {
    return false;
  }

  if (filters.symbolKinds.length > 0 && !filters.symbolKinds.includes(match.kind)) {
    return false;
  }

  return true;
}

function matchesFileFilters(
  file: Pick<SearchableFileRecord, "languageId" | "relativePath">,
  filters: DefinitionFilters,
): boolean {
  if (filters.language && file.languageId !== filters.language) {
    return false;
  }

  if (filters.pathPrefix && !relativePathMatchesPrefix(file.relativePath, filters.pathPrefix)) {
    return false;
  }

  return true;
}

function dedupeSymbolKinds(symbolKinds: readonly SymbolKind[]): SymbolKind[] {
  const normalizedKinds: SymbolKind[] = [];
  const seenKinds = new Set<SymbolKind>();

  for (const symbolKind of symbolKinds) {
    if (seenKinds.has(symbolKind)) {
      continue;
    }

    seenKinds.add(symbolKind);
    normalizedKinds.push(symbolKind);
  }

  return normalizedKinds;
}
