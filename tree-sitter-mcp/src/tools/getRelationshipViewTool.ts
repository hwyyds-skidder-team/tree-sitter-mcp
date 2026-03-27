import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { SearchFreshnessSchema } from "../indexing/indexTypes.js";
import { PaginationSchema } from "../results/paginateResults.js";
import { createWorkspaceBreakdown, WorkspaceBreakdownSchema } from "../results/workspaceBreakdown.js";
import {
  getRelationshipView,
} from "../relationships/getRelationshipView.js";
import {
  RelationshipEdgeSchema,
  RelationshipViewRequestSchema,
  ValidatedRelationshipViewRequestSchema,
} from "../relationships/relationshipTypes.js";
import { DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import { createFreshnessDiagnostics } from "./indexFreshness.js";
import { validateToolInput } from "./validateToolInput.js";

const GetRelationshipViewOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  workspaceRoots: z.array(z.string()),
  seed: DefinitionMatchSchema.nullable(),
  results: z.array(RelationshipEdgeSchema),
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  pagination: PaginationSchema,
  workspaceBreakdown: z.array(WorkspaceBreakdownSchema),
  freshness: SearchFreshnessSchema,
  diagnostic: DiagnosticSchema.nullable(),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerGetRelationshipViewTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "get_relationship_view",
    {
      title: "Get Relationship View",
      description: "Inspect direct incoming and outgoing semantic relationships, plus one extra read-only impact hop, using freshness-checked indexed records.",
      inputSchema: RelationshipViewRequestSchema,
      outputSchema: GetRelationshipViewOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const validatedInput = validateToolInput(
        "get_relationship_view",
        ValidatedRelationshipViewRequestSchema,
        input,
      );
      const result = await getRelationshipView(context, validatedInput);
      const selectedWorkspaceRoots = result.filters.workspaceRoots ?? context.workspace.roots;
      const workspaceBreakdown = createWorkspaceBreakdown(
        selectedWorkspaceRoots,
        result.searchableFiles,
        result.edges.map((edge) => ({
          workspaceRoot: edge.relatedSymbol.workspaceRoot,
          relativePath: edge.relatedSymbol.relativePath,
        })),
      );
      const diagnostics = [...result.diagnostics, ...createFreshnessDiagnostics(result.freshness)];
      const payload = {
        workspaceRoot: context.workspace.root,
        workspaceRoots: selectedWorkspaceRoots,
        seed: result.target,
        results: result.edges,
        searchedFiles: result.searchedFiles,
        matchedFiles: result.matchedFiles,
        pagination: result.pagination,
        workspaceBreakdown,
        freshness: result.freshness,
        diagnostic: result.diagnostic,
        diagnostics,
      };
      const text = describeRelationshipSearchText(
        formatRelationshipSearchText({
          seedName: result.target?.name ?? "the requested symbol",
          resultCount: result.edges.length,
          matchedFiles: result.matchedFiles,
          searchedFiles: result.searchedFiles,
          selectedWorkspaceCount: selectedWorkspaceRoots.length,
          configuredWorkspaceCount: context.workspace.roots.length,
          foundSeed: Boolean(result.target),
          diagnosticMessage: result.diagnostic?.message ?? null,
        }),
        payload.freshness,
      );

      return {
        ...(result.diagnostic && result.edges.length === 0 ? { isError: true } : {}),
        content: [{ type: "text" as const, text }],
        structuredContent: payload,
      };
    },
  );
}

function formatRelationshipSearchText(options: {
  seedName: string;
  resultCount: number;
  matchedFiles: number;
  searchedFiles: number;
  selectedWorkspaceCount: number;
  configuredWorkspaceCount: number;
  foundSeed: boolean;
  diagnosticMessage: string | null;
}): string {
  const {
    seedName,
    resultCount,
    matchedFiles,
    searchedFiles,
    selectedWorkspaceCount,
    configuredWorkspaceCount,
    foundSeed,
    diagnosticMessage,
  } = options;

  if (!foundSeed) {
    return diagnosticMessage ?? "Relationship view failed.";
  }

  if (resultCount > 0) {
    if (configuredWorkspaceCount > 1) {
      return `Found ${resultCount} relationship edges across ${matchedFiles} files for ${seedName} after searching ${searchedFiles} files in ${selectedWorkspaceCount} of ${configuredWorkspaceCount} configured workspaces.`;
    }

    return `Found ${resultCount} relationship edges across ${matchedFiles} files for ${seedName} after searching ${searchedFiles} files.`;
  }

  if (configuredWorkspaceCount > 1) {
    return `No relationships were found for ${seedName} after searching ${searchedFiles} files in ${selectedWorkspaceCount} of ${configuredWorkspaceCount} configured workspaces.`;
  }

  return `No relationships were found for ${seedName} after searching ${searchedFiles} files.`;
}

function describeRelationshipSearchText(
  baseText: string,
  freshness: z.infer<typeof SearchFreshnessSchema>,
): string {
  switch (freshness.state) {
    case "refreshed":
      return `${baseText} Refreshed ${freshness.refreshedFiles.length} file(s) before searching.`;
    case "degraded":
      return `${baseText} Warning: excluded ${freshness.degradedFiles.length} degraded file(s) from the indexed search results.`;
    case "rebuilding":
      return `${baseText} Warning: the persistent index is rebuilding.`;
    case "fresh":
    default:
      return baseText;
  }
}
