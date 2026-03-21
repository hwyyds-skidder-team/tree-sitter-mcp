import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { SearchFreshnessSchema } from "../indexing/indexTypes.js";
import {
  filterSearchableFiles,
  matchesDefinitionFilters,
  normalizeDefinitionFilters,
} from "../definitions/definitionFilters.js";
import {
  SymbolKindSchema,
  SymbolMatchSchema,
  type SymbolMatch,
} from "../queries/queryCatalog.js";
import { createWorkspaceBreakdown, WorkspaceBreakdownSchema } from "../results/workspaceBreakdown.js";
import { compareWorkspaceAwareMatches, scoreNameMatch } from "../results/searchRanking.js";
import type { ServerContext } from "../server/serverContext.js";
import { createDefaultFreshness, createFreshnessDiagnostics } from "./indexFreshness.js";

const SearchWorkspaceSymbolsInputSchema = z.object({
  query: z.string().min(1),
  workspaceRoots: z.array(z.string()).optional(),
  language: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
  symbolKinds: z.array(SymbolKindSchema).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const SearchWorkspaceSymbolsOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  workspaceRoots: z.array(z.string()),
  query: z.string(),
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  filters: z.object({
    workspaceRoots: z.array(z.string()).optional(),
    language: z.string().nullable(),
    pathPrefix: z.string().nullable(),
    symbolKinds: z.array(SymbolKindSchema),
    limit: z.number().int().positive(),
  }),
  results: z.array(SymbolMatchSchema),
  workspaceBreakdown: z.array(WorkspaceBreakdownSchema),
  freshness: SearchFreshnessSchema,
  diagnostics: z.array(DiagnosticSchema),
});

export function registerSearchWorkspaceSymbolsTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "search_workspace_symbols",
    {
      title: "Search Workspace Symbols",
      description: "Search the active workspace for Tree-sitter symbols by name using freshness-checked indexed records.",
      inputSchema: SearchWorkspaceSymbolsInputSchema,
      outputSchema: SearchWorkspaceSymbolsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const limit = input.limit ?? 50;
      const normalizedQuery = input.query.trim().toLowerCase();

      if (!context.workspace.root) {
        const filters = {
          workspaceRoots: undefined,
          language: input.language ?? null,
          pathPrefix: input.pathPrefix ?? null,
          symbolKinds: input.symbolKinds ?? [],
          limit,
        };
        const diagnostic = createDiagnostic({
          code: "workspace_not_set",
          message: "No workspace is configured.",
          reason: "Workspace discovery has not run yet.",
          nextStep: "Call set_workspace before searching workspace symbols.",
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: null,
            workspaceRoots: [],
            query: input.query,
            searchedFiles: 0,
            matchedFiles: 0,
            truncated: false,
            filters,
            results: [],
            workspaceBreakdown: [],
            freshness: createDefaultFreshness(context.workspace.index),
            diagnostics: [diagnostic],
          },
        };
      }

      const normalizedFiltersResult = normalizeDefinitionFilters({
        workspaceRoot: context.workspace.root,
        configuredRoots: context.workspace.roots,
        languageRegistry: context.languageRegistry,
        input: {
          workspaceRoots: input.workspaceRoots,
          language: input.language,
          pathPrefix: input.pathPrefix,
          symbolKinds: input.symbolKinds,
        },
      });
      const selectedWorkspaceRoots = normalizedFiltersResult.filters.workspaceRoots ?? context.workspace.roots;

      const filters = {
        workspaceRoots: normalizedFiltersResult.filters.workspaceRoots,
        language: normalizedFiltersResult.filters.language,
        pathPrefix: normalizedFiltersResult.filters.pathPrefix,
        symbolKinds: normalizedFiltersResult.filters.symbolKinds,
        limit,
      };

      if (normalizedFiltersResult.diagnostic) {
        const diagnostic = normalizedFiltersResult.diagnostic;

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: context.workspace.root,
            workspaceRoots: selectedWorkspaceRoots,
            query: input.query,
            searchedFiles: 0,
            matchedFiles: 0,
            truncated: false,
            filters,
            results: [],
            workspaceBreakdown: createWorkspaceBreakdown(selectedWorkspaceRoots, [], []),
            freshness: createDefaultFreshness(context.workspace.index),
            diagnostics: [diagnostic],
          },
        };
      }
      const diagnostics = [...context.workspace.unsupportedFiles.slice(0, 20).map((file) => createDiagnostic({
        code: "unsupported_file",
        message: `Skipping unsupported file ${file.relativePath}.`,
        reason: file.reason,
        nextStep: "Inspect get_capabilities for supported languages or choose a supported file path filter.",
        filePath: file.path,
        relativePath: file.relativePath,
        severity: "info",
      }))];
      const freshIndex = await context.semanticIndex.getFreshRecords(context);
      const searchableFiles = filterSearchableFiles(freshIndex.records, normalizedFiltersResult.filters);

      const matches: SymbolMatch[] = [];
      let searchedFiles = 0;

      for (const file of searchableFiles) {
        searchedFiles += 1;
        diagnostics.push(...file.diagnostics);

        for (const symbol of file.symbols) {
          if (!matchesDefinitionFilters(symbol, normalizedFiltersResult.filters)) {
            continue;
          }

          if (scoreNameMatch(symbol.name, normalizedQuery) === null) {
            continue;
          }

          matches.push(symbol);
        }
      }

      matches.sort((left, right) => compareWorkspaceAwareMatches(left, right, {
        normalizedQuery,
        workspaceRoots: context.workspace.roots,
      }));

      const results = matches.slice(0, limit);
      const uniqueFiles = new Set(
        results.map((symbol) => JSON.stringify([symbol.workspaceRoot, symbol.relativePath])),
      );
      const truncated = matches.length > limit;
      const workspaceBreakdown = createWorkspaceBreakdown(selectedWorkspaceRoots, searchableFiles, results);
      const payload = {
        workspaceRoot: context.workspace.root,
        workspaceRoots: selectedWorkspaceRoots,
        query: input.query,
        searchedFiles,
        matchedFiles: uniqueFiles.size,
        truncated,
        filters,
        results,
        workspaceBreakdown,
        freshness: freshIndex.freshness,
        diagnostics: [...diagnostics, ...createFreshnessDiagnostics(freshIndex.freshness)],
      };

      return {
        content: [
          {
            type: "text" as const,
            text: describeWorkspaceSymbolSearchText(
              formatWorkspaceSearchText({
                resultCount: results.length,
                matchedFiles: uniqueFiles.size,
                searchedFiles,
                selectedWorkspaceCount: selectedWorkspaceRoots.length,
                configuredWorkspaceCount: context.workspace.roots.length,
                noun: "symbol matches",
              }),
              payload.freshness,
            ),
          },
        ],
        structuredContent: payload,
      };
    },
  );
}

function formatWorkspaceSearchText(options: {
  resultCount: number;
  matchedFiles: number;
  searchedFiles: number;
  selectedWorkspaceCount: number;
  configuredWorkspaceCount: number;
  noun: string;
}): string {
  const {
    resultCount,
    matchedFiles,
    searchedFiles,
    selectedWorkspaceCount,
    configuredWorkspaceCount,
    noun,
  } = options;

  if (configuredWorkspaceCount > 1) {
    return `Found ${resultCount} ${noun} across ${matchedFiles} files after searching ${searchedFiles} files in ${selectedWorkspaceCount} of ${configuredWorkspaceCount} configured workspaces.`;
  }

  return `Found ${resultCount} ${noun} across ${matchedFiles} files after searching ${searchedFiles} files.`;
}

function describeWorkspaceSymbolSearchText(
  baseText: string,
  freshness: z.infer<typeof SearchFreshnessSchema>,
): string {
  switch (freshness.state) {
    case "refreshed":
      return `${baseText} Refreshed ${freshness.refreshedFiles.length} file(s) before searching.`;
    case "degraded":
      return `${baseText} Warning: excluded ${freshness.degradedFiles.length} degraded file(s) from symbol search.`;
    case "rebuilding":
      return `${baseText} Warning: the persistent index is rebuilding.`;
    case "fresh":
    default:
      return baseText;
  }
}
