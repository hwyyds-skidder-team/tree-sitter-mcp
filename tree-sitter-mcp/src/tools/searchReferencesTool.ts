import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import { SearchFreshnessSchema } from "../indexing/indexTypes.js";
import { PaginationSchema } from "../results/paginateResults.js";
import { createWorkspaceBreakdown, WorkspaceBreakdownSchema } from "../results/workspaceBreakdown.js";
import {
  filterReferenceSearchableFiles,
  normalizeReferenceFilters,
} from "../references/referenceFilters.js";
import { searchReferences } from "../references/searchReferences.js";
import { ReferenceMatchSchema, ReferenceSearchTargetSchema } from "../references/referenceTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import { createFreshnessDiagnostics } from "./indexFreshness.js";

const SearchReferencesInputSchema = z.object({
  symbol: ReferenceSearchTargetSchema.optional(),
  lookup: ReferenceSearchTargetSchema.optional(),
  workspaceRoots: z.array(z.string()).optional(),
  language: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
  includeContext: z.boolean().optional(),
});

const SearchReferencesOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  workspaceRoots: z.array(z.string()),
  target: DefinitionMatchSchema.nullable(),
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  pagination: PaginationSchema,
  results: z.array(ReferenceMatchSchema),
  workspaceBreakdown: z.array(WorkspaceBreakdownSchema),
  freshness: SearchFreshnessSchema,
  diagnostic: DiagnosticSchema.nullable(),
  diagnostics: z.array(DiagnosticSchema),
});

const WARNING_DIAGNOSTIC_CODES = ["index_refresh_failed", "index_degraded"] as const;

export function registerSearchReferencesTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "search_references",
    {
      title: "Search References",
      description: "Search the active workspace for references or call sites to a resolved symbol using freshness-checked indexed records.",
      inputSchema: SearchReferencesInputSchema,
      outputSchema: SearchReferencesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const normalizedFiltersResult = context.workspace.root
        ? normalizeReferenceFilters({
            workspaceRoot: context.workspace.root,
            configuredRoots: context.workspace.roots,
            languageRegistry: context.languageRegistry,
            input: {
              workspaceRoots: input.workspaceRoots,
              language: input.language,
              pathPrefix: input.pathPrefix,
            },
          })
        : null;
      const selectedWorkspaceRoots = normalizedFiltersResult?.filters.workspaceRoots ?? context.workspace.roots;
      const result = await searchReferences(context, {
        symbol: input.symbol,
        lookup: input.lookup,
        workspaceRoots: input.workspaceRoots,
        language: input.language,
        pathPrefix: input.pathPrefix,
        limit: input.limit,
        offset: input.offset,
        includeContext: input.includeContext,
      });
      const searchableFiles = result.target && result.searchedFiles > 0 && normalizedFiltersResult
        ? filterReferenceSearchableFiles(
            (await context.semanticIndex.getFreshRecords(context)).records
              .filter((file) => getCompatibleLanguageIds(result.target?.languageId).has(file.languageId)),
            normalizedFiltersResult.filters,
          )
        : [];
      const workspaceBreakdown = createWorkspaceBreakdown(
        selectedWorkspaceRoots,
        searchableFiles,
        result.results,
      );

      const payload = {
        workspaceRoot: context.workspace.root,
        workspaceRoots: selectedWorkspaceRoots,
        target: result.target,
        searchedFiles: result.searchedFiles,
        matchedFiles: result.matchedFiles,
        pagination: result.pagination,
        results: result.results,
        workspaceBreakdown,
        freshness: result.freshness,
        diagnostic: result.diagnostic,
        diagnostics: [...result.diagnostics, ...createFreshnessDiagnostics(result.freshness)],
      };

      const text = result.results.length > 0
        ? formatReferenceSearchText({
            targetName: result.target?.name ?? "the requested symbol",
            resultCount: result.results.length,
            matchedFiles: result.matchedFiles,
            searchedFiles: result.searchedFiles,
            selectedWorkspaceCount: selectedWorkspaceRoots.length,
            configuredWorkspaceCount: context.workspace.roots.length,
          })
        : result.target && result.searchedFiles > 0
          ? formatReferenceMissText({
              targetName: result.target.name,
              searchedFiles: result.searchedFiles,
              selectedWorkspaceCount: selectedWorkspaceRoots.length,
              configuredWorkspaceCount: context.workspace.roots.length,
            })
          : result.diagnostic?.message ?? "Reference search did not find a match.";
      const freshnessText = describeReferenceSearchText(text, payload.freshness);

      return {
        ...(result.diagnostic && result.results.length === 0 ? { isError: true } : {}),
        content: [{ type: "text" as const, text: freshnessText }],
        structuredContent: payload,
      };
    },
  );
}

function formatReferenceSearchText(options: {
  targetName: string;
  resultCount: number;
  matchedFiles: number;
  searchedFiles: number;
  selectedWorkspaceCount: number;
  configuredWorkspaceCount: number;
}): string {
  const {
    targetName,
    resultCount,
    matchedFiles,
    searchedFiles,
    selectedWorkspaceCount,
    configuredWorkspaceCount,
  } = options;

  if (configuredWorkspaceCount > 1) {
    return `Found ${resultCount} references across ${matchedFiles} files for ${targetName} after searching ${searchedFiles} files in ${selectedWorkspaceCount} of ${configuredWorkspaceCount} configured workspaces.`;
  }

  return `Found ${resultCount} references across ${matchedFiles} files for ${targetName} after searching ${searchedFiles} files.`;
}

function formatReferenceMissText(options: {
  targetName: string;
  searchedFiles: number;
  selectedWorkspaceCount: number;
  configuredWorkspaceCount: number;
}): string {
  const {
    targetName,
    searchedFiles,
    selectedWorkspaceCount,
    configuredWorkspaceCount,
  } = options;

  if (configuredWorkspaceCount > 1) {
    return `No references were found for ${targetName} after searching ${searchedFiles} files in ${selectedWorkspaceCount} of ${configuredWorkspaceCount} configured workspaces.`;
  }

  return `No references were found for ${targetName} after searching ${searchedFiles} files.`;
}

function describeReferenceSearchText(
  baseText: string,
  freshness: z.infer<typeof SearchFreshnessSchema>,
): string {
  if (freshness.state === "refreshed") {
    return `${baseText} Refreshed ${freshness.refreshedFiles.length} file(s) before searching.`;
  }

  if (freshness.state === "degraded") {
    return `${baseText} Warning: ${WARNING_DIAGNOSTIC_CODES[1]} results excluded ${freshness.degradedFiles.length} degraded file(s).`;
  }

  if (freshness.state === "rebuilding") {
    return `${baseText} Warning: the persistent index is rebuilding.`;
  }

  return baseText;
}

function getCompatibleLanguageIds(languageId: string | undefined): Set<string> {
  if (languageId === "typescript" || languageId === "tsx") {
    return new Set(["typescript", "tsx"]);
  }

  return languageId ? new Set([languageId]) : new Set();
}
