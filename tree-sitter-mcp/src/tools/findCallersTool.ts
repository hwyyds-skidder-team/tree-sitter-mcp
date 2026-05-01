import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { findCallersForSymbol, type CallerResult } from "../references/callerChain.js";
import type { ServerContext } from "../server/serverContext.js";

const CallChainEntrySchema = z.object({
  filePath: z.string(),
  functionName: z.string(),
  location: z.object({
    start: z.object({ row: z.number(), column: z.number() }),
    end: z.object({ row: z.number(), column: z.number() }),
    startIndex: z.number(),
    endIndex: z.number(),
  }),
});

const CallerResultSchema = z.object({
  filePath: z.string(),
  functionName: z.string(),
  callLocation: z.object({
    start: z.object({ row: z.number(), column: z.number() }),
    end: z.object({ row: z.number(), column: z.number() }),
    startIndex: z.number(),
    endIndex: z.number(),
  }),
  callChain: z.array(CallChainEntrySchema),
  snippet: z.string(),
});

const FindCallersInputSchema = z.object({
  symbolName: z.string().min(1),
  workspaceRoots: z.array(z.string()).optional(),
  language: z.string().min(1).optional(),
  maxDepth: z.number().int().min(1).max(5).optional(),
});

const FindCallersOutputSchema = z.object({
  symbolName: z.string(),
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  callers: z.array(CallerResultSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerFindCallersTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "find_callers",
    {
      title: "Find Callers",
      description: "Find all locations that call a specific function, with full call chain context (file -> function -> call site).",
      inputSchema: FindCallersInputSchema,
      outputSchema: FindCallersOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (!context.workspace.root) {
        const diagnostic = createDiagnostic({
          code: "workspace_not_set",
          message: "No workspace is configured.",
          reason: "The server does not know which repository root to trust yet.",
          nextStep: "Call set_workspace before finding callers.",
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            symbolName: input.symbolName,
            searchedFiles: 0,
            matchedFiles: 0,
            callers: [],
            diagnostics: [diagnostic],
          },
        };
      }

      const { records } = await context.semanticIndex.getFreshRecords(context);

      let searchableRecords = records;
      if (input.workspaceRoots && input.workspaceRoots.length > 0) {
        const rootSet = new Set(input.workspaceRoots);
        searchableRecords = searchableRecords.filter((r) => rootSet.has(r.workspaceRoot));
      }
      if (input.language) {
        const langId = input.language.toLowerCase();
        searchableRecords = searchableRecords.filter((r) => r.languageId === langId);
      }

      const allCallers: CallerResult[] = [];
      const matchedFiles = new Set<string>();
      const diagnostics: z.infer<typeof DiagnosticSchema>[] = [];

      for (const record of searchableRecords) {
        const language = context.languageRegistry.getByFilePath(record.path);
        if (!language) {
          continue;
        }

        try {
          const callers = await findCallersForSymbol(
            record.path,
            record.relativePath,
            language,
            input.symbolName,
          );

          if (callers.length > 0) {
            matchedFiles.add(record.path);
            allCallers.push(...callers);
          }
        } catch (error) {
          // Skip files that fail to parse
        }
      }

      const maxDepth = input.maxDepth ?? 2;
      const filteredCallers = allCallers.filter((c) => c.callChain.length <= maxDepth);

      const text = filteredCallers.length > 0
        ? `Found ${filteredCallers.length} call sites for ${input.symbolName} across ${matchedFiles.size} files.`
        : `No callers found for ${input.symbolName} after searching ${searchableRecords.length} files.`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          symbolName: input.symbolName,
          searchedFiles: searchableRecords.length,
          matchedFiles: matchedFiles.size,
          callers: filteredCallers,
          diagnostics,
        },
      };
    },
  );
}
