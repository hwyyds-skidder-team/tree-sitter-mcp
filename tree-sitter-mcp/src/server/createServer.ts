import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "./serverContext.js";
import { registerTools } from "./toolRegistry.js";

export function createServer(context: ServerContext): McpServer {
  const server = new McpServer({
    name: context.config.name,
    version: context.config.version,
  });

  registerTools(server, context);
  return server;
}
