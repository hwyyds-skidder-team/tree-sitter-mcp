import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import {
  normalizeConfiguredWorkspaceRoots,
  normalizeWorkspacePathPrefix,
} from "../definitions/definitionFilters.js";
import type { LanguageRegistry } from "../languages/languageRegistry.js";
import { relativePathMatchesPrefix } from "../workspace/resolveWorkspace.js";
import type { SearchableFileRecord } from "../workspace/workspaceState.js";
import {
  ReferenceFilterSchema,
  type ReferenceFilterInput,
  type ReferenceFilters,
  type ReferenceMatch,
} from "./referenceTypes.js";

export interface NormalizeReferenceFiltersOptions {
  workspaceRoot: string;
  configuredRoots?: readonly string[];
  languageRegistry: LanguageRegistry;
  input?: ReferenceFilterInput;
}

export interface NormalizeReferenceFiltersResult {
  filters: ReferenceFilters;
  diagnostic: Diagnostic | null;
}

export function normalizeReferenceFilters(
  options: NormalizeReferenceFiltersOptions,
): NormalizeReferenceFiltersResult {
  const configuredRoots = options.configuredRoots?.length
    ? [...options.configuredRoots]
    : [options.workspaceRoot];
  const normalizedWorkspaceRootsResult = normalizeConfiguredWorkspaceRoots(
    configuredRoots,
    options.input?.workspaceRoots,
  );

  const rawLanguage = options.input?.language?.trim() ?? "";
  const normalizedLanguage = rawLanguage.length > 0 ? rawLanguage.toLowerCase() : null;

  let normalizedPathPrefix: string | null = null;
  if ((options.input?.pathPrefix?.trim() ?? "").length > 0) {
    try {
      normalizedPathPrefix = normalizeWorkspacePathPrefix(
        normalizedWorkspaceRootsResult.workspaceRoots?.length
          ? normalizedWorkspaceRootsResult.workspaceRoots
          : configuredRoots,
        options.input?.pathPrefix ?? "",
      );
    } catch (error) {
      const filters = ReferenceFilterSchema.parse({
        workspaceRoots: normalizedWorkspaceRootsResult.workspaceRoots,
        language: normalizedLanguage,
        pathPrefix: null,
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

  const filters = ReferenceFilterSchema.parse({
    workspaceRoots: normalizedWorkspaceRootsResult.workspaceRoots,
    language: normalizedLanguage,
    pathPrefix: normalizedPathPrefix,
  });

  if (normalizedWorkspaceRootsResult.diagnostic) {
    return {
      filters,
      diagnostic: normalizedWorkspaceRootsResult.diagnostic,
    };
  }

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

export function filterReferenceSearchableFiles<
  T extends Pick<SearchableFileRecord, "languageId" | "relativePath" | "workspaceRoot">,
>(files: readonly T[], filters: ReferenceFilters): T[] {
  return files.filter((file) => matchesReferenceFileFilters(file, filters));
}

export function matchesReferenceFilters(
  match: Pick<ReferenceMatch, "languageId" | "relativePath" | "workspaceRoot">,
  filters: ReferenceFilters,
): boolean {
  if (filters.workspaceRoots?.length && !filters.workspaceRoots.includes(match.workspaceRoot)) {
    return false;
  }

  if (filters.language && match.languageId !== filters.language) {
    return false;
  }

  if (filters.pathPrefix && !relativePathMatchesPrefix(match.relativePath, filters.pathPrefix)) {
    return false;
  }

  return true;
}

function matchesReferenceFileFilters(
  file: Pick<SearchableFileRecord, "languageId" | "relativePath" | "workspaceRoot">,
  filters: ReferenceFilters,
): boolean {
  if (filters.workspaceRoots?.length) {
    if (!file.workspaceRoot || !filters.workspaceRoots.includes(file.workspaceRoot)) {
      return false;
    }
  }

  if (filters.language && file.languageId !== filters.language) {
    return false;
  }

  if (filters.pathPrefix && !relativePathMatchesPrefix(file.relativePath, filters.pathPrefix)) {
    return false;
  }

  return true;
}
