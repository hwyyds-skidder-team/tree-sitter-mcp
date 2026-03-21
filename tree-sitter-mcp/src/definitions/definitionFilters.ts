import { createDiagnostic, type Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { LanguageRegistry } from "../languages/languageRegistry.js";
import type { SymbolKind } from "../queries/queryCatalog.js";
import {
  findContainingWorkspaceRoot,
  normalizeAbsolutePath,
  normalizeWorkspaceRelativePath,
  relativeToWorkspace,
  relativePathMatchesPrefix,
  resolveConfiguredWorkspacePath,
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
  configuredRoots?: readonly string[];
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
  const configuredRoots = getConfiguredRoots(options);
  const normalizedWorkspaceRootsResult = normalizeConfiguredWorkspaceRoots(
    configuredRoots,
    options.input?.workspaceRoots,
  );
  if (normalizedWorkspaceRootsResult.diagnostic) {
    return {
      filters: DefinitionFilterSchema.parse({
        workspaceRoots: normalizedWorkspaceRootsResult.workspaceRoots,
        language: null,
        pathPrefix: null,
        symbolKinds: dedupeSymbolKinds(options.input?.symbolKinds ?? []),
      }),
      diagnostic: normalizedWorkspaceRootsResult.diagnostic,
    };
  }

  const rawLanguage = options.input?.language?.trim() ?? "";
  const normalizedLanguage = rawLanguage.length > 0 ? rawLanguage.toLowerCase() : null;
  const symbolKinds = dedupeSymbolKinds(options.input?.symbolKinds ?? []);
  const normalizedPathPrefixResult = normalizeDefinitionPathPrefix({
    workspaceRoot: options.workspaceRoot,
    configuredRoots,
    workspaceRoots: normalizedWorkspaceRootsResult.workspaceRoots,
    pathPrefix: options.input?.pathPrefix,
  });

  const filters = DefinitionFilterSchema.parse({
    workspaceRoots: normalizedWorkspaceRootsResult.workspaceRoots,
    language: normalizedLanguage,
    pathPrefix: normalizedPathPrefixResult.pathPrefix,
    symbolKinds,
  });

  if (normalizedPathPrefixResult.diagnostic) {
    return {
      filters,
      diagnostic: normalizedPathPrefixResult.diagnostic,
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

export function filterSearchableFiles<
  T extends Pick<SearchableFileRecord, "languageId" | "relativePath" | "workspaceRoot">,
>(
  files: readonly T[],
  filters: DefinitionFilters,
): T[] {
  return files.filter((file) => matchesFileFilters(file, filters));
}

export function matchesDefinitionFilters(
  match: Pick<DefinitionMatch, "kind" | "languageId" | "relativePath" | "workspaceRoot">,
  filters: DefinitionFilters,
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

  if (filters.symbolKinds.length > 0 && !filters.symbolKinds.includes(match.kind)) {
    return false;
  }

  return true;
}

function matchesFileFilters(
  file: Pick<SearchableFileRecord, "languageId" | "relativePath" | "workspaceRoot">,
  filters: DefinitionFilters,
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

export function normalizeConfiguredWorkspaceRoots(
  configuredRoots: readonly string[],
  workspaceRoots?: readonly string[] | null,
): { workspaceRoots?: string[]; diagnostic: Diagnostic | null } {
  const requestedRoots = workspaceRoots?.map((root) => root.trim()).filter((root) => root.length > 0) ?? [];
  if (requestedRoots.length === 0) {
    return {
      workspaceRoots: undefined,
      diagnostic: null,
    };
  }

  const configuredRootMap = new Map(
    configuredRoots.map((root) => [normalizeAbsolutePath(root), root] as const),
  );
  const normalizedRoots: string[] = [];
  const seenRoots = new Set<string>();

  for (const requestedRoot of requestedRoots) {
    const normalizedRoot = normalizeAbsolutePath(requestedRoot);
    const configuredRoot = configuredRootMap.get(normalizedRoot);
    if (!configuredRoot) {
      return {
        workspaceRoots: normalizedRoots.length > 0 ? normalizedRoots : undefined,
        diagnostic: createDiagnostic({
          code: "workspace_root_invalid",
          message: "Workspace root filter is not configured.",
          reason: `Requested workspace root ${normalizedRoot} is not part of the active workspace set.`,
          nextStep: "Use a workspaceRoot returned by previous results or call set_workspace with that root.",
          filePath: requestedRoot,
        }),
      };
    }

    if (seenRoots.has(configuredRoot)) {
      continue;
    }

    seenRoots.add(configuredRoot);
    normalizedRoots.push(configuredRoot);
  }

  return {
    workspaceRoots: normalizedRoots,
    diagnostic: null,
  };
}

export function normalizeDefinitionPathPrefix(options: {
  workspaceRoot: string;
  configuredRoots: readonly string[];
  workspaceRoots?: readonly string[];
  pathPrefix?: string | null;
}): { pathPrefix: string | null; diagnostic: Diagnostic | null } {
  const rawPathPrefix = options.pathPrefix?.trim() ?? "";
  if (rawPathPrefix.length === 0) {
    return {
      pathPrefix: null,
      diagnostic: null,
    };
  }

  const pathRoots = options.workspaceRoots?.length
    ? options.workspaceRoots
    : options.configuredRoots.length > 0
      ? options.configuredRoots
      : [options.workspaceRoot];

  try {
    const normalizedPathPrefix = normalizeWorkspacePathPrefix(pathRoots, rawPathPrefix);
    return {
      pathPrefix: normalizedPathPrefix,
      diagnostic: null,
    };
  } catch (error) {
    return {
      pathPrefix: null,
      diagnostic: createDiagnostic({
        code: "workspace_path_out_of_scope",
        message: "Path filter escapes the configured workspace root.",
        reason: error instanceof Error ? error.message : String(error),
        nextStep: "Use a pathPrefix inside the active workspace root.",
        filePath: options.pathPrefix ?? undefined,
      }),
    };
  }
}

export function normalizeWorkspacePathPrefix(
  configuredRoots: readonly string[],
  pathPrefix: string,
): string | null {
  if (configuredRoots.length === 0) {
    throw new Error("A configured workspace root is required.");
  }

  const normalizedPath = pathPrefix.trim();
  if (normalizedPath.length === 0) {
    return null;
  }

  if (isAbsoluteWorkspacePath(normalizedPath)) {
    const resolvedPath = resolveConfiguredWorkspacePath(configuredRoots, normalizedPath);
    const workspaceRoot = findContainingWorkspaceRoot(configuredRoots, resolvedPath);
    if (!workspaceRoot) {
      throw new Error(`Path escapes the configured workspace roots: ${pathPrefix}`);
    }

    const relativePath = relativeToWorkspace(workspaceRoot, resolvedPath);
    return relativePath === "." ? null : relativePath;
  }

  return normalizeWorkspaceRelativePath(configuredRoots[0], normalizedPath);
}

function getConfiguredRoots(options: NormalizeDefinitionFiltersOptions): string[] {
  if (options.configuredRoots && options.configuredRoots.length > 0) {
    return [...options.configuredRoots];
  }

  return [options.workspaceRoot];
}

function isAbsoluteWorkspacePath(targetPath: string): boolean {
  return targetPath.length > 0 && (
    targetPath.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(targetPath)
    || targetPath.startsWith("\\\\")
  );
}
