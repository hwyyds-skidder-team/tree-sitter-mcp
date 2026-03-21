import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import { SearchFreshnessSchema } from "../indexing/indexTypes.js";
import { PaginationSchema } from "../results/paginateResults.js";
import { searchReferences } from "../references/searchReferences.js";
import { ReferenceMatchSchema, ReferenceSearchTargetSchema } from "../references/referenceTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import { createFreshnessDiagnostics } from "./indexFreshness.js";

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
        freshness: result.freshness,
        diagnostic: result.diagnostic,
        diagnostics: [...result.diagnostics, ...createFreshnessDiagnostics(result.freshness)],
      };

      const text = result.results.length > 0
        ? `Found ${result.results.length} references across ${result.matchedFiles} files for ${result.target?.name ?? "the requested symbol"}.`
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
