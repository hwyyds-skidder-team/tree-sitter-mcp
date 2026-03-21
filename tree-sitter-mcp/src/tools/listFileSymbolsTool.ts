import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { parseWithDiagnostics } from "../parsing/parseWithDiagnostics.js";
import { extractSymbols, SymbolMatchSchema } from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import { createExclusionPolicy } from "../workspace/exclusionPolicy.js";
import { relativeToWorkspace, resolveWorkspacePath } from "../workspace/resolveWorkspace.js";

const ListFileSymbolsInputSchema = z.object({
  path: z.string().min(1),
});

const ListFileSymbolsOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  filePath: z.string(),
  relativePath: z.string().nullable(),
  languageId: z.string().nullable(),
  symbols: z.array(SymbolMatchSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerListFileSymbolsTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "list_file_symbols",
    {
      title: "List File Symbols",
      description: "Parse one supported source file on demand and return extracted symbols plus actionable diagnostics.",
      inputSchema: ListFileSymbolsInputSchema,
      outputSchema: ListFileSymbolsOutputSchema,
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
          nextStep: "Call set_workspace before listing file symbols.",
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: null,
            filePath: input.path,
            relativePath: null,
            languageId: null,
            symbols: [],
            diagnostics: [diagnostic],
          },
        };
      }

      let absolutePath: string;
      try {
        absolutePath = resolveWorkspacePath(context.workspace.root, input.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const diagnostic = createDiagnostic({
          code: "workspace_path_out_of_scope",
          message: "Requested file is outside the configured workspace root.",
          reason: message,
          nextStep: "Use a path inside the active workspace or reset the workspace root.",
          filePath: input.path,
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: context.workspace.root,
            filePath: input.path,
            relativePath: null,
            languageId: null,
            symbols: [],
            diagnostics: [diagnostic],
          },
        };
      }

      const exclusionPolicy = createExclusionPolicy(context.workspace.root, context.workspace.exclusions);
      if (exclusionPolicy.shouldExclude(absolutePath)) {
        const match = exclusionPolicy.explain(absolutePath);
        const diagnostic = createDiagnostic({
          code: "file_excluded",
          message: "Requested file is excluded by the active workspace policy.",
          reason: match ? `Matched exclusion pattern ${match.pattern}.` : "Matched an active exclusion rule.",
          nextStep: "Adjust additionalExclusions in set_workspace or target a non-excluded file.",
          filePath: absolutePath,
          relativePath: relativeToWorkspace(context.workspace.root, absolutePath),
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: context.workspace.root,
            filePath: absolutePath,
            relativePath: diagnostic.relativePath ?? null,
            languageId: null,
            symbols: [],
            diagnostics: [diagnostic],
          },
        };
      }

      const relativePath = relativeToWorkspace(context.workspace.root, absolutePath);
      const language = context.languageRegistry.getByFilePath(absolutePath);
      if (!language) {
        const diagnostic = createDiagnostic({
          code: "unsupported_file",
          message: `No registered Tree-sitter grammar supports ${path.extname(absolutePath) || "this file"}.`,
          reason: "Only files mapped to a registered language can be parsed semantically.",
          nextStep: "Inspect get_capabilities for supported languages or choose a supported source file.",
          filePath: absolutePath,
          relativePath,
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: context.workspace.root,
            filePath: absolutePath,
            relativePath,
            languageId: null,
            symbols: [],
            diagnostics: [diagnostic],
          },
        };
      }

      const parseResult = await parseWithDiagnostics({
        absolutePath,
        relativePath,
        language,
      });

      if (!parseResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: parseResult.diagnostic.message }],
          structuredContent: {
            workspaceRoot: context.workspace.root,
            filePath: absolutePath,
            relativePath,
            languageId: language.id,
            symbols: [],
            diagnostics: [parseResult.diagnostic],
          },
        };
      }

      const symbols = extractSymbols({
        language,
        workspaceRoot: context.workspace.root,
        absolutePath,
        relativePath,
        source: parseResult.source,
        tree: parseResult.tree,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${symbols.length} symbols in ${relativePath}.`,
          },
        ],
        structuredContent: {
          workspaceRoot: context.workspace.root,
          filePath: absolutePath,
          relativePath,
          languageId: language.id,
          symbols,
          diagnostics: [],
        },
      };
    },
  );
}
