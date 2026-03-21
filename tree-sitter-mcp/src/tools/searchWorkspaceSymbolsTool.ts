import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import {
  SymbolKindSchema,
  SymbolMatchSchema,
} from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import { createExclusionPolicy } from "../workspace/exclusionPolicy.js";
import { resolveWorkspacePath } from "../workspace/resolveWorkspace.js";

const SearchWorkspaceSymbolsInputSchema = z.object({
  query: z.string().min(1),
  language: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
  symbolKinds: z.array(SymbolKindSchema).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const SearchWorkspaceSymbolsOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  query: z.string(),
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  filters: z.object({
    language: z.string().nullable(),
    pathPrefix: z.string().nullable(),
    symbolKinds: z.array(SymbolKindSchema),
    limit: z.number().int().positive(),
  }),
  results: z.array(SymbolMatchSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerSearchWorkspaceSymbolsTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "search_workspace_symbols",
    {
      title: "Search Workspace Symbols",
      description: "Search the active workspace for Tree-sitter symbols by name using freshness-checked indexed records.",
      inputSchema: SearchWorkspaceSymbolsInputSchema,
      outputSchema: SearchWorkspaceSymbolsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const limit = input.limit ?? 50;
      const normalizedQuery = input.query.toLowerCase();
      const filters = {
        language: input.language ?? null,
        pathPrefix: input.pathPrefix ?? null,
        symbolKinds: input.symbolKinds ?? [],
        limit,
      };

      if (!context.workspace.root) {
        const diagnostic = createDiagnostic({
          code: "workspace_not_set",
          message: "No workspace is configured.",
          reason: "Workspace discovery has not run yet.",
          nextStep: "Call set_workspace before searching workspace symbols.",
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: null,
            query: input.query,
            searchedFiles: 0,
            matchedFiles: 0,
            truncated: false,
            filters,
            results: [],
            diagnostics: [diagnostic],
          },
        };
      }

      if (input.language && !context.languageRegistry.getById(input.language)) {
        const diagnostic = createDiagnostic({
          code: "unsupported_language",
          message: `Language ${input.language} is not registered in this server instance.`,
          reason: "The requested language filter does not match any builtin grammar registration.",
          nextStep: "Inspect get_capabilities for supported language identifiers and retry.",
          languageId: input.language,
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: context.workspace.root,
            query: input.query,
            searchedFiles: 0,
            matchedFiles: 0,
            truncated: false,
            filters,
            results: [],
            diagnostics: [diagnostic],
          },
        };
      }

      let normalizedPathPrefix: string | null = null;
      if (input.pathPrefix) {
        try {
          const resolvedPathPrefix = resolveWorkspacePath(context.workspace.root, input.pathPrefix);
          normalizedPathPrefix = path.relative(context.workspace.root, resolvedPathPrefix).split(path.sep).join("/");
          if (normalizedPathPrefix === "") {
            normalizedPathPrefix = null;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const diagnostic = createDiagnostic({
            code: "workspace_path_out_of_scope",
            message: "Path filter escapes the configured workspace root.",
            reason: message,
            nextStep: "Use a pathPrefix inside the active workspace root.",
            filePath: input.pathPrefix,
          });

          return {
            isError: true,
            content: [{ type: "text" as const, text: diagnostic.message }],
            structuredContent: {
              workspaceRoot: context.workspace.root,
              query: input.query,
              searchedFiles: 0,
              matchedFiles: 0,
              truncated: false,
              filters,
              results: [],
              diagnostics: [diagnostic],
            },
          };
        }
      }

      const exclusionPolicy = createExclusionPolicy(context.workspace.root, context.workspace.exclusions);
      const diagnostics = [...context.workspace.unsupportedFiles.slice(0, 20).map((file) => createDiagnostic({
        code: "unsupported_file",
        message: `Skipping unsupported file ${file.relativePath}.`,
        reason: file.reason,
        nextStep: "Inspect get_capabilities for supported languages or choose a supported file path filter.",
        filePath: file.path,
        relativePath: file.relativePath,
        severity: "info",
      }))];
      const freshIndex = await context.semanticIndex.getFreshRecords(context);

      const results = [];
      let searchedFiles = 0;

      for (const file of freshIndex.records) {
        if (input.language && file.languageId !== input.language) {
          continue;
        }

        if (normalizedPathPrefix && !(file.relativePath === normalizedPathPrefix || file.relativePath.startsWith(`${normalizedPathPrefix}/`))) {
          continue;
        }

        if (exclusionPolicy.shouldExclude(file.path)) {
          continue;
        }

        searchedFiles += 1;
        diagnostics.push(...file.diagnostics);

        for (const symbol of file.symbols) {
          if (!symbol.name.toLowerCase().includes(normalizedQuery)) {
            continue;
          }

          if (filters.symbolKinds.length > 0 && !filters.symbolKinds.includes(symbol.kind)) {
            continue;
          }

          results.push(symbol);
          if (results.length >= limit) {
            break;
          }
        }

        if (results.length >= limit) {
          break;
        }
      }

      const uniqueFiles = new Set(results.map((symbol) => symbol.relativePath));
      const truncated = results.length >= limit;
      const payload = {
        workspaceRoot: context.workspace.root,
        query: input.query,
        searchedFiles,
        matchedFiles: uniqueFiles.size,
        truncated,
        filters,
        results,
        diagnostics,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} symbol matches across ${uniqueFiles.size} files after searching ${searchedFiles} files.`,
          },
        ],
        structuredContent: payload,
      };
    },
  );
}
