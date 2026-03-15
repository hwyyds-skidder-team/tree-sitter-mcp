import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { SupportedLanguageSchema } from "../languages/languageRegistry.js";
import { listDefinitionQueryTypes } from "../queries/definitionQueryCatalog.js";
import { listReferenceQueryTypes } from "../queries/referenceQueryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import {
  SearchableFileRecordSchema,
  summarizeWorkspace,
  UnsupportedFileRecordSchema,
} from "../workspace/workspaceState.js";

const HealthOutputSchema = z.object({
  status: z.enum(["workspace_not_set", "ready"]),
  parserMode: z.literal("on_demand"),
  supportedLanguages: z.array(SupportedLanguageSchema),
  supportedQueryTypes: z.array(z.string()),
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

export function registerGetHealthTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "get_health",
    {
      title: "Get Health",
      description: "Return current workspace state, exclusions, supported languages, and actionable diagnostics.",
      outputSchema: HealthOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const supportedQueryTypes = [...new Set([
        ...context.queryTypes,
        ...listDefinitionQueryTypes(),
        ...listReferenceQueryTypes(),
      ])];
      const diagnostics = context.workspace.root
        ? []
        : [
            createDiagnostic({
              code: "workspace_not_set",
              message: "No workspace is configured.",
              reason: "Semantic file discovery has not run yet.",
              nextStep: "Call set_workspace with a repository root before running semantic queries.",
              severity: "info",
            }),
          ];

      const payload = {
        status: context.workspace.root ? ("ready" as const) : ("workspace_not_set" as const),
        parserMode: context.parserMode,
        supportedLanguages: context.languageRegistry.list(),
        supportedQueryTypes,
        workspace: summarizeWorkspace(context.workspace),
        searchableFilesSample: context.workspace.searchableFiles.slice(0, 20),
        unsupportedFilesSample: context.workspace.unsupportedFiles.slice(0, 20),
        diagnostics,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: payload.status === "ready"
              ? `Workspace ready at ${payload.workspace.root}; ${payload.workspace.searchableFileCount} supported files discovered; definition and reference search remain on-demand and read-only.`
              : "Workspace not set; semantic queries, including definition and reference search, will return actionable diagnostics until set_workspace runs.",
          },
        ],
        structuredContent: payload,
      };
    },
  );
}
