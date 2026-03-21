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
  WorkspaceSummarySchema,
  UnsupportedFileRecordSchema,
} from "../workspace/workspaceState.js";

const SetWorkspaceInputSchema = z.object({
  root: z.string().min(1),
  additionalExclusions: z.array(z.string().min(1)).optional(),
});

const SetWorkspaceOutputSchema = z.object({
  workspace: WorkspaceSummarySchema,
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
        context.semanticIndex.replaceWorkspace({
          root,
          exclusions,
        });
        try {
          await context.semanticIndex.ensureReady(context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const diagnostic = createDiagnostic({
            code: "index_build_failed",
            message: "The persistent index failed to finish building for this workspace.",
            reason: message,
            nextStep: "Retry set_workspace after fixing the underlying issue or clearing the persisted index directory.",
            severity: "warning",
            details: {
              root,
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
            content: [{ type: "text" as const, text: diagnostic.message }],
            structuredContent: payload,
          };
        }

        const diagnostics = [];
        const lastLoadResult = context.semanticIndex.getLastLoadResult();
        if (lastLoadResult?.status === "schema_mismatch") {
          diagnostics.push(createDiagnostic({
            code: "index_schema_mismatch",
            message: "An older persisted index schema was discarded and rebuilt for this workspace.",
            reason: `Expected schema ${lastLoadResult.expectedSchemaVersion} but found ${lastLoadResult.actualSchemaVersion}.`,
            nextStep: "Reuse the rebuilt index for future searches or rerun set_workspace if you want to confirm the rebuilt snapshot.",
            severity: "warning",
            details: {
              expectedSchemaVersion: lastLoadResult.expectedSchemaVersion,
              actualSchemaVersion: lastLoadResult.actualSchemaVersion,
              workspaceFingerprint: context.workspace.index.workspaceFingerprint,
            },
          }));
        }

        const payload = {
          workspace: summarizeWorkspace(context.workspace),
          searchableFilesSample: context.workspace.searchableFiles.slice(0, 20),
          unsupportedFilesSample: context.workspace.unsupportedFiles.slice(0, 20),
          diagnostics,
        };
        const lastBuiltAt = payload.workspace.index.lastBuiltAt;
        const lastRefreshedAt = payload.workspace.index.lastRefreshedAt;

        return {
          content: [
            {
              type: "text" as const,
              text: `Workspace set to ${root}. Discovered ${payload.workspace.searchableFileCount} supported files and ${payload.workspace.unsupportedFileCount} unsupported files.${lastBuiltAt ? ` Index lastBuiltAt ${lastBuiltAt}.` : ""}${lastRefreshedAt ? ` lastRefreshedAt ${lastRefreshedAt}.` : ""}`,
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
