#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { createServer } from "./server/createServer.js";
import { createServerContext } from "./server/serverContext.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const context = createServerContext(config);
  const server = createServer(context);
  const transport = new StdioServerTransport();

  // Keep stdin flowing when the server is launched as a child process over stdio.
  process.stdin.resume();

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}
`);
  process.exit(1);
});
