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
import { compareWorkspaceAwareMatches, scoreNameMatch } from "../results/searchRanking.js";
import type { ServerContext } from "../server/serverContext.js";
import { createDefaultFreshness, createFreshnessDiagnostics } from "./indexFreshness.js";

const SearchWorkspaceSymbolsInputSchema = z.object({
  query: z.string().min(1),
  language: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
  symbolKinds: z.array(SymbolKindSchema).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const SearchWorkspaceSymbolsOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  query: z.string(),
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  filters: z.object({
    language: z.string().nullable(),
    pathPrefix: z.string().nullable(),
    symbolKinds: z.array(SymbolKindSchema),
    limit: z.number().int().positive(),
  }),
  results: z.array(SymbolMatchSchema),
  freshness: SearchFreshnessSchema,
  diagnostics: z.array(DiagnosticSchema),
});

const IMMEDIATE_ERROR_CODES = new Set([
  "unsupported_language",
  "workspace_path_out_of_scope",
  "workspace_root_invalid",
]);

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
            query: input.query,
            searchedFiles: 0,
            matchedFiles: 0,
            truncated: false,
            filters,
            results: [],
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
          language: input.language,
          pathPrefix: input.pathPrefix,
          symbolKinds: input.symbolKinds,
        },
      });

      const filters = {
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
            query: input.query,
            searchedFiles: 0,
            matchedFiles: 0,
            truncated: false,
            filters,
            results: [],
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
      const payload = {
        workspaceRoot: context.workspace.root,
        query: input.query,
        searchedFiles,
        matchedFiles: uniqueFiles.size,
        truncated,
        filters,
        results,
        freshness: freshIndex.freshness,
        diagnostics: [...diagnostics, ...createFreshnessDiagnostics(freshIndex.freshness)],
      };

      return {
        ...(diagnostics.some((diagnostic) => IMMEDIATE_ERROR_CODES.has(diagnostic.code)) && searchedFiles === 0
          ? { isError: true }
          : {}),
        content: [
          {
            type: "text" as const,
            text: describeWorkspaceSymbolSearchText(
              `Found ${results.length} symbol matches across ${uniqueFiles.size} files after searching ${searchedFiles} files.`,
              payload.freshness,
            ),
          },
        ],
        structuredContent: payload,
      };
    },
  );
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
