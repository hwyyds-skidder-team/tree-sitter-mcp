import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { IndexModeSchema } from "../indexing/indexTypes.js";
import { SupportedLanguageSchema } from "../languages/languageRegistry.js";
import { listDefinitionQueryTypes } from "../queries/definitionQueryCatalog.js";
import { listRelationshipQueryTypes } from "../queries/relationshipQueryCatalog.js";
import { listReferenceQueryTypes } from "../queries/referenceQueryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import { createFreshnessDiagnostics } from "./indexFreshness.js";
import {
  SearchableFileRecordSchema,
  summarizeWorkspace,
  UnsupportedFileRecordSchema,
  WorkspaceSummarySchema,
} from "../workspace/workspaceState.js";

const HealthOutputSchema = z.object({
  status: z.enum(["workspace_not_set", "ready"]),
  parserMode: z.literal("on_demand"),
  indexMode: IndexModeSchema,
  supportedLanguages: z.array(SupportedLanguageSchema),
  supportedQueryTypes: z.array(z.string()),
  toolNames: z.array(z.string()),
  workspace: WorkspaceSummarySchema,
  searchableFilesSample: z.array(SearchableFileRecordSchema),
  unsupportedFilesSample: z.array(UnsupportedFileRecordSchema),
  diagnostics: z.array(DiagnosticSchema),
});

const TOOL_NAMES = [
  "tree_sitter_get_server_info",
  "set_workspace",
  "get_capabilities",
  "get_health",
  "list_file_symbols",
  "search_workspace_symbols",
  "search_definitions",
  "resolve_definition",
  "search_references",
  "get_relationship_view",
  "analyze_complexity",
  "find_callers",
  "get_symbol_context",
];

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
        ...listRelationshipQueryTypes(),
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
      const workspace = summarizeWorkspace(context.workspace);
      const workspaceFingerprint = workspace.index.workspaceFingerprint;

      if (workspace.index.state === "degraded") {
        diagnostics.push(...createFreshnessDiagnostics({
          state: "degraded",
          checkedAt: workspace.index.lastRefreshedAt ?? workspace.index.lastBuiltAt ?? new Date().toISOString(),
          refreshedFiles: [],
          degradedFiles: workspace.index.degradedFileCount > 0 && workspaceFingerprint
            ? [workspaceFingerprint]
            : new Array(workspace.index.degradedFileCount).fill("degraded"),
          workspaceFingerprint,
        }));
      }

      const lastLoadResult = context.semanticIndex.getLastLoadResult();
      if (lastLoadResult?.status === "schema_mismatch") {
        diagnostics.push(createDiagnostic({
          code: "index_schema_mismatch",
          severity: "warning",
          message: "A persisted index schema mismatch was detected and rebuilt.",
          reason: `The on-disk index schema ${lastLoadResult.actualSchemaVersion} did not match expected schema ${lastLoadResult.expectedSchemaVersion}.`,
          nextStep: "Reuse the rebuilt index or rerun set_workspace if you need to confirm the new snapshot.",
          details: {
            workspaceFingerprint,
            expectedSchemaVersion: lastLoadResult.expectedSchemaVersion,
            actualSchemaVersion: lastLoadResult.actualSchemaVersion,
          },
        }));
      }

      const payload = {
        status: context.workspace.root ? ("ready" as const) : ("workspace_not_set" as const),
        parserMode: context.parserMode,
        indexMode: workspace.index.indexMode,
        supportedLanguages: context.languageRegistry.list(),
        supportedQueryTypes,
        toolNames: [...TOOL_NAMES],
        workspace,
        searchableFilesSample: context.workspace.searchableFiles.slice(0, 20),
        unsupportedFilesSample: context.workspace.unsupportedFiles.slice(0, 20),
        diagnostics,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: payload.status === "ready"
              ? `Workspace ready at ${payload.workspace.root}; workspaceFingerprint ${payload.workspace.index.workspaceFingerprint}; ${payload.workspace.searchableFileCount} supported files discovered; persistent_disk indexing is active.`
              : "Workspace not set; semantic queries, including definition, reference, and relationship search, will return actionable diagnostics until set_workspace runs.",
          },
        ],
        structuredContent: payload,
      };
    },
  );
}
