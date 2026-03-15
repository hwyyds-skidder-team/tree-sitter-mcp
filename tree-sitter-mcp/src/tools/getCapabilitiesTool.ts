import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SupportedLanguageSchema } from "../languages/languageRegistry.js";
import type { ServerContext } from "../server/serverContext.js";
import { summarizeWorkspace } from "../workspace/workspaceState.js";

const CapabilitiesOutputSchema = z.object({
  parserMode: z.literal("on_demand"),
  supportedLanguages: z.array(SupportedLanguageSchema),
  supportedQueryTypes: z.array(z.string()),
  toolNames: z.array(z.string()),
  workspace: z.object({
    root: z.string().nullable(),
    exclusions: z.array(z.string()),
    searchableFileCount: z.number().int().nonnegative(),
    unsupportedFileCount: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().nullable(),
  }),
});

const TOOL_NAMES = [
  "tree_sitter_get_server_info",
  "set_workspace",
  "get_capabilities",
  "get_health",
  "list_file_symbols",
  "search_workspace_symbols",
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
      const payload = {
        parserMode: context.parserMode,
        supportedLanguages: context.languageRegistry.list(),
        supportedQueryTypes: [...context.queryTypes],
        toolNames: [...TOOL_NAMES],
        workspace: summarizeWorkspace(context.workspace),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `Parser mode ${payload.parserMode}; ${payload.supportedLanguages.length} languages; ${payload.supportedQueryTypes.length} semantic query types.`,
          },
        ],
        structuredContent: payload,
      };
    },
  );
}
