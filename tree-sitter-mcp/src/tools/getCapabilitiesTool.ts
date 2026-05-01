import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IndexModeSchema } from "../indexing/indexTypes.js";
import { SupportedLanguageSchema } from "../languages/languageRegistry.js";
import { listDefinitionQueryTypes } from "../queries/definitionQueryCatalog.js";
import { listRelationshipQueryTypes } from "../queries/relationshipQueryCatalog.js";
import { listReferenceQueryTypes } from "../queries/referenceQueryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import { summarizeWorkspace, WorkspaceSummarySchema } from "../workspace/workspaceState.js";

const CapabilitiesOutputSchema = z.object({
  parserMode: z.literal("on_demand"),
  indexMode: IndexModeSchema,
  supportedLanguages: z.array(SupportedLanguageSchema),
  supportedQueryTypes: z.array(z.string()),
  toolNames: z.array(z.string()),
  workspace: WorkspaceSummarySchema,
});

const TOOL_NAMES = [
  "tree_sitter_get_server_info",
  "set_workspace",
  "get_capabilities",
  "get_health",
  "list_file_symbols",
  "search_workspace_symbols",
  "search_definitions",
  "resolve_definition",
  "search_references",
  "get_relationship_view",
  "analyze_complexity",
  "find_callers",
  "get_symbol_context",
];

export function registerGetCapabilitiesTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get Capabilities",
      description: "Return supported languages, query types, parser mode, and current workspace constraints.",
      outputSchema: CapabilitiesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const supportedQueryTypes = [...new Set([
        ...context.queryTypes,
        ...listDefinitionQueryTypes(),
        ...listReferenceQueryTypes(),
        ...listRelationshipQueryTypes(),
      ])];
      const payload = {
        parserMode: context.parserMode,
        indexMode: context.workspace.index.indexMode,
        supportedLanguages: context.languageRegistry.list(),
        supportedQueryTypes,
        toolNames: [...TOOL_NAMES],
        workspace: summarizeWorkspace(context.workspace),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `Parser mode ${payload.parserMode}; indexMode ${payload.indexMode}; ${payload.supportedLanguages.length} languages; ${payload.supportedQueryTypes.length} semantic query types including indexed definition, reference, and relationship search.`,
          },
        ],
        structuredContent: payload,
      };
    },
  );
}
