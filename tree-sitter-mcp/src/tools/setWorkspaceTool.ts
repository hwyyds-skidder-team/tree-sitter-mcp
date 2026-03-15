import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import type { ServerContext } from "../server/serverContext.js";
import { discoverWorkspaceFiles } from "../workspace/discoverFiles.js";
import { resolveWorkspaceRoot } from "../workspace/resolveWorkspace.js";
import {
  applyWorkspaceSnapshot,
  mergeExclusions,
  SearchableFileRecordSchema,
  summarizeWorkspace,
  UnsupportedFileRecordSchema,
} from "../workspace/workspaceState.js";

const SetWorkspaceInputSchema = z.object({
  root: z.string().min(1),
  additionalExclusions: z.array(z.string().min(1)).optional(),
});

const SetWorkspaceOutputSchema = z.object({
  workspace: z.object({
    root: z.string().nullable(),
    exclusions: z.array(z.string()),
    searchableFileCount: z.number().int().nonnegative(),
    unsupportedFileCount: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().nullable(),
  }),
  searchableFilesSample: z.array(SearchableFileRecordSchema),
  unsupportedFilesSample: z.array(UnsupportedFileRecordSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerSetWorkspaceTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "set_workspace",
    {
      title: "Set Workspace",
      description: "Resolve a workspace root, apply exclusion rules, and discover supported Tree-sitter source files.",
      inputSchema: SetWorkspaceInputSchema,
      outputSchema: SetWorkspaceOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const root = await resolveWorkspaceRoot(input.root);
        const exclusions = mergeExclusions(
          context.config.defaultExclusions,
          input.additionalExclusions ?? [],
        );
        const discovery = await discoverWorkspaceFiles(root, exclusions, context.languageRegistry);
        applyWorkspaceSnapshot(context.workspace, {
          root,
          exclusions,
          searchableFiles: discovery.searchableFiles,
          unsupportedFiles: discovery.unsupportedFiles,
        });

        const payload = {
          workspace: summarizeWorkspace(context.workspace),
          searchableFilesSample: context.workspace.searchableFiles.slice(0, 20),
          unsupportedFilesSample: context.workspace.unsupportedFiles.slice(0, 20),
          diagnostics: [],
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `Workspace set to ${root}. Discovered ${payload.workspace.searchableFileCount} supported files and ${payload.workspace.unsupportedFileCount} unsupported files.`,
            },
          ],
          structuredContent: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const diagnostic = createDiagnostic({
          code: "workspace_root_invalid",
          message: "Failed to resolve the requested workspace root.",
          reason: message,
          nextStep: "Pass an existing directory path to set_workspace and retry.",
          details: {
            requestedRoot: input.root,
          },
        });

        const payload = {
          workspace: summarizeWorkspace(context.workspace),
          searchableFilesSample: context.workspace.searchableFiles.slice(0, 20),
          unsupportedFilesSample: context.workspace.unsupportedFiles.slice(0, 20),
          diagnostics: [diagnostic],
        };

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `${diagnostic.message} ${diagnostic.reason}`,
            },
          ],
          structuredContent: payload,
        };
      }
    },
  );
}
