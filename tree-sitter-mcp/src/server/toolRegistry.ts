import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetCapabilitiesTool } from "../tools/getCapabilitiesTool.js";
import { registerGetHealthTool } from "../tools/getHealthTool.js";
import { registerListFileSymbolsTool } from "../tools/listFileSymbolsTool.js";
import { registerResolveDefinitionTool } from "../tools/resolveDefinitionTool.js";
import { registerSearchDefinitionsTool } from "../tools/searchDefinitionsTool.js";
import { registerSearchWorkspaceSymbolsTool } from "../tools/searchWorkspaceSymbolsTool.js";
import { registerSetWorkspaceTool } from "../tools/setWorkspaceTool.js";
import type { ServerContext } from "./serverContext.js";

const BootstrapInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  transport: z.literal("stdio"),
  eagerIndexing: z.boolean(),
  parserMode: z.literal("on_demand"),
});

function registerBootstrapInfoTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "tree_sitter_get_server_info",
    {
      title: "Get Tree-sitter MCP Server Info",
      description: "Return bootstrap information about the tree-sitter-mcp server instance.",
      outputSchema: BootstrapInfoSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const info = {
        name: context.config.name,
        version: context.config.version,
        transport: "stdio" as const,
        eagerIndexing: false,
        parserMode: context.parserMode,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(info, null, 2),
          },
        ],
        structuredContent: info,
      };
    },
  );
}

export function registerTools(server: McpServer, context: ServerContext): void {
  registerBootstrapInfoTool(server, context);
  registerSetWorkspaceTool(server, context);
  registerGetCapabilitiesTool(server, context);
  registerGetHealthTool(server, context);
  registerListFileSymbolsTool(server, context);
  registerSearchWorkspaceSymbolsTool(server, context);
  registerSearchDefinitionsTool(server, context);
  registerResolveDefinitionTool(server, context);
}
