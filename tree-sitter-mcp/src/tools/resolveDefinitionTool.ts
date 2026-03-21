import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import {
  resolveDefinition,
  type DefinitionLookupRequest,
  type DefinitionSymbolDescriptor,
} from "../definitions/resolveDefinition.js";
import { DefinitionFilterSchema, DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import { SymbolKindSchema } from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";

const DefinitionLookupSchema = z.object({
  name: z.string().min(1),
  languageId: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
  relativePath: z.string().min(1).optional(),
  kind: SymbolKindSchema.optional(),
});

const ResolveDefinitionInputSchema = z.object({
  symbol: DefinitionLookupSchema.optional(),
  lookup: DefinitionLookupSchema.optional(),
});

const ResolveDefinitionOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  filters: DefinitionFilterSchema,
  searchedFiles: z.number().int().nonnegative(),
  match: DefinitionMatchSchema.nullable(),
  diagnostic: DiagnosticSchema.nullable(),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerResolveDefinitionTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "resolve_definition",
    {
      title: "Resolve Definition",
      description: "Resolve one symbol descriptor or direct lookup request to the best matching definition with normalized ranges and diagnostics.",
      inputSchema: ResolveDefinitionInputSchema,
      outputSchema: ResolveDefinitionOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await resolveDefinition(context, {
        symbol: input.symbol as DefinitionSymbolDescriptor | undefined,
        lookup: input.lookup as DefinitionLookupRequest | undefined,
      });

      const payload = {
        workspaceRoot: result.match?.workspaceRoot
          ?? input.symbol?.workspaceRoot
          ?? input.lookup?.workspaceRoot
          ?? context.workspace.root,
        filters: result.filters,
        searchedFiles: result.searchedFiles,
        match: result.match,
        diagnostic: result.diagnostic,
        diagnostics: result.diagnostics,
      };

      const text = result.match
        ? `Resolved ${result.match.name} to ${result.match.relativePath}:${result.match.selectionRange.start.line}.`
        : result.diagnostic?.message ?? "Definition resolution did not find a match.";

      return {
        ...(result.diagnostic ? { isError: true } : {}),
        content: [{ type: "text" as const, text }],
        structuredContent: payload,
      };
    },
  );
}
