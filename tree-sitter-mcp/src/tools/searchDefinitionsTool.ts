import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { searchDefinitions } from "../definitions/searchDefinitions.js";
import { SearchFreshnessSchema } from "../indexing/indexTypes.js";
import { DefinitionFilterSchema, DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import { SymbolKindSchema } from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import { createFreshnessDiagnostics } from "./indexFreshness.js";

const SearchDefinitionsInputSchema = z.object({
  query: z.string().min(1),
  language: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
  symbolKinds: z.array(SymbolKindSchema).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const SearchDefinitionsOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  query: z.string(),
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  filters: DefinitionFilterSchema.extend({
    limit: z.number().int().positive(),
  }),
  results: z.array(DefinitionMatchSchema),
  freshness: SearchFreshnessSchema,
  diagnostics: z.array(DiagnosticSchema),
});

const IMMEDIATE_ERROR_CODES = new Set([
  "workspace_not_set",
  "unsupported_language",
  "workspace_path_out_of_scope",
]);

export function registerSearchDefinitionsTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "search_definitions",
    {
      title: "Search Definitions",
      description: "Search the active workspace for symbol definitions by name using freshness-checked indexed records and read-only MCP semantics.",
      inputSchema: SearchDefinitionsInputSchema,
      outputSchema: SearchDefinitionsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const limit = input.limit ?? 50;
      const result = await searchDefinitions(context, {
        query: input.query,
        language: input.language,
        pathPrefix: input.pathPrefix,
        symbolKinds: input.symbolKinds,
        limit,
      });

      const payload = {
        workspaceRoot: context.workspace.root,
        query: input.query,
        searchedFiles: result.searchedFiles,
        matchedFiles: result.matchedFiles,
        truncated: result.truncated,
        filters: {
          ...result.filters,
          limit,
        },
        results: result.results,
        freshness: result.freshness,
        diagnostics: [...result.diagnostics, ...createFreshnessDiagnostics(result.freshness)],
      };

      const isImmediateError = result.searchedFiles === 0
        && result.diagnostics.some((diagnostic) => IMMEDIATE_ERROR_CODES.has(diagnostic.code));
      const primaryText = isImmediateError
        ? result.diagnostics[0]?.message ?? "Definition search failed."
        : describeDefinitionSearchText(
            `Found ${payload.results.length} definition matches across ${payload.matchedFiles} files after searching ${payload.searchedFiles} files.`,
            payload.freshness,
          );

      return {
        ...(isImmediateError ? { isError: true } : {}),
        content: [{ type: "text" as const, text: primaryText }],
        structuredContent: payload,
      };
    },
  );
}

function describeDefinitionSearchText(
  baseText: string,
  freshness: z.infer<typeof SearchFreshnessSchema>,
): string {
  switch (freshness.state) {
    case "refreshed":
      return `${baseText} Refreshed ${freshness.refreshedFiles.length} file(s) before searching.`;
    case "degraded":
      return `${baseText} Warning: excluded ${freshness.degradedFiles.length} degraded file(s) from the indexed search results.`;
    case "rebuilding":
      return `${baseText} Warning: the persistent index is rebuilding.`;
    case "fresh":
    default:
      return baseText;
  }
}
