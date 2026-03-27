import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import type { ServerContext } from "../server/serverContext.js";
import { discoverConfiguredWorkspaces } from "../workspace/discoverFiles.js";
import { resolveWorkspaceRoots } from "../workspace/resolveWorkspace.js";
import {
  applyWorkspaceSnapshot,
  mergeExclusions,
  SearchableFileRecordSchema,
  summarizeWorkspace,
  WorkspaceSummarySchema,
  UnsupportedFileRecordSchema,
} from "../workspace/workspaceState.js";
import { validateToolInput } from "./validateToolInput.js";

const SetWorkspaceInputSchema = z.object({
  root: z.string().min(1).optional().describe("Single workspace root. Provide either root or roots."),
  roots: z.array(z.string().min(1)).min(1).optional().describe(
    "Ordered workspace roots. Provide either root or roots.",
  ),
  additionalExclusions: z.array(z.string().min(1)).optional().describe(
    "Extra exclusion patterns to merge with the default workspace exclusions.",
  ),
});

const ValidatedSetWorkspaceInputSchema = SetWorkspaceInputSchema.superRefine((input, ctx) => {
  if (!input.root && !input.roots?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either root or roots is required.",
      path: ["root"],
    });
  }
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
      const validatedInput = validateToolInput(
        "set_workspace",
        ValidatedSetWorkspaceInputSchema,
        input,
      );

      try {
        const roots = await resolveWorkspaceRoots({
          root: validatedInput.root,
          roots: validatedInput.roots,
        });
        const exclusions = mergeExclusions(
          context.config.defaultExclusions,
          validatedInput.additionalExclusions ?? [],
        );
        const discovery = await discoverConfiguredWorkspaces(
          roots,
          exclusions,
          context.languageRegistry,
        );
        applyWorkspaceSnapshot(context.workspace, {
          root: roots[0] ?? null,
          roots,
          exclusions,
          searchableFiles: discovery.searchableFiles,
          unsupportedFiles: discovery.unsupportedFiles,
        });
        context.semanticIndex.replaceWorkspaces(roots.map((root) => ({
          root,
          exclusions,
        })));
        try {
          await context.semanticIndex.ensureReady(context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const diagnostic = createDiagnostic({
            code: "index_build_failed",
            message: "The persistent index failed to finish building for the configured workspace roots.",
            reason: message,
            nextStep: "Retry set_workspace after fixing the underlying issue or clearing the persisted index directory.",
            severity: "warning",
            details: {
              primaryRoot: roots[0] ?? null,
              rootCount: roots.length,
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
        for (const loadResult of context.semanticIndex.getLastLoadResults()) {
          if (loadResult.result?.status !== "schema_mismatch") {
            continue;
          }

          diagnostics.push(createDiagnostic({
            code: "index_schema_mismatch",
            message: "An older persisted index schema was discarded and rebuilt for one configured workspace.",
            reason: `Expected schema ${loadResult.result.expectedSchemaVersion} but found ${loadResult.result.actualSchemaVersion}.`,
            nextStep: "Reuse the rebuilt index for future searches or rerun set_workspace if you want to confirm the rebuilt snapshot.",
            severity: "warning",
            details: {
              root: loadResult.root,
              expectedSchemaVersion: loadResult.result.expectedSchemaVersion,
              actualSchemaVersion: loadResult.result.actualSchemaVersion,
              workspaceFingerprint: context.workspace.workspaces
                .find((workspace) => workspace.root === loadResult.root)?.index.workspaceFingerprint
                ?? context.workspace.index.workspaceFingerprint,
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
              text: `Workspace set to ${roots.length === 1 ? roots[0] : `${roots[0]} (+${roots.length - 1} more roots)`}. Discovered ${payload.workspace.searchableFileCount} supported files and ${payload.workspace.unsupportedFileCount} unsupported files.${lastBuiltAt ? ` Index lastBuiltAt ${lastBuiltAt}.` : ""}${lastRefreshedAt ? ` lastRefreshedAt ${lastRefreshedAt}.` : ""}`,
            },
          ],
          structuredContent: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const diagnostic = createDiagnostic({
          code: "workspace_root_invalid",
          message: "Failed to resolve the requested workspace root configuration.",
          reason: message,
          nextStep: "Pass one or more existing directory paths to set_workspace and retry.",
          details: {
            requestedRoot: validatedInput.root ?? null,
            requestedRoots: validatedInput.roots?.join(", ") ?? null,
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
