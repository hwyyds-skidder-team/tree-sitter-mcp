import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import { PaginationSchema } from "../results/paginateResults.js";
import { searchReferences } from "../references/searchReferences.js";
import { ReferenceMatchSchema, ReferenceSearchTargetSchema } from "../references/referenceTypes.js";
import type { ServerContext } from "../server/serverContext.js";

const SearchReferencesInputSchema = z.object({
  symbol: ReferenceSearchTargetSchema.optional(),
  lookup: ReferenceSearchTargetSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
  includeContext: z.boolean().optional(),
});

const SearchReferencesOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  target: DefinitionMatchSchema.nullable(),
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  pagination: PaginationSchema,
  results: z.array(ReferenceMatchSchema),
  diagnostic: DiagnosticSchema.nullable(),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerSearchReferencesTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "search_references",
    {
      title: "Search References",
      description: "Search the active workspace for references or call sites to a resolved symbol using on-demand Tree-sitter parsing.",
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
      const result = await searchReferences(context, {
        symbol: input.symbol,
        lookup: input.lookup,
        limit: input.limit,
        offset: input.offset,
        includeContext: input.includeContext,
      });

      const payload = {
        workspaceRoot: context.workspace.root,
        target: result.target,
        searchedFiles: result.searchedFiles,
        matchedFiles: result.matchedFiles,
        pagination: result.pagination,
        results: result.results,
        diagnostic: result.diagnostic,
        diagnostics: result.diagnostics,
      };

      const text = result.results.length > 0
        ? `Found ${result.results.length} references across ${result.matchedFiles} files for ${result.target?.name ?? "the requested symbol"}.`
        : result.diagnostic?.message ?? "Reference search did not find a match.";

      return {
        ...(result.diagnostic && result.results.length === 0 ? { isError: true } : {}),
        content: [{ type: "text" as const, text }],
        structuredContent: payload,
      };
    },
  );
}
