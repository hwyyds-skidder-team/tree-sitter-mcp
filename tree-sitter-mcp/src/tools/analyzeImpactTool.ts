import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { SearchFreshnessSchema } from "../indexing/indexTypes.js";
import { PaginationSchema } from "../results/paginateResults.js";
import { WorkspaceBreakdownSchema } from "../results/workspaceBreakdown.js";
import {
  analyzeImpact,
} from "../impact/impactAnalysis.js";
import {
  ImpactAnalysisRequestSchema,
  ImpactAnalysisResultSchema,
  ImpactTargetSchema,
  ImpactBlastRadiusSchema,
  ValidatedImpactAnalysisRequestSchema,
} from "../impact/impactTypes.js";
import { DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import { createFreshnessDiagnostics } from "./indexFreshness.js";
import { validateToolInput } from "./validateToolInput.js";

const AnalyzeImpactOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  workspaceRoots: z.array(z.string()),
  seed: DefinitionMatchSchema.nullable(),
  targets: z.array(ImpactTargetSchema),
  blastRadius: ImpactBlastRadiusSchema,
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  pagination: PaginationSchema,
  workspaceBreakdown: z.array(WorkspaceBreakdownSchema),
  freshness: SearchFreshnessSchema,
  diagnostic: DiagnosticSchema.nullable(),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerAnalyzeImpactTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "analyze_impact",
    {
      title: "Analyze Impact",
      description: "Estimate the blast radius of changing a symbol. Returns prioritized impact targets with confidence metadata, severity scores, and a reasoned summary of likely affected code.",
      inputSchema: ImpactAnalysisRequestSchema,
      outputSchema: AnalyzeImpactOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const validatedInput = validateToolInput(
        "analyze_impact",
        ValidatedImpactAnalysisRequestSchema,
        input,
      );
      const result = await analyzeImpact(context, validatedInput);
      const diagnostics = [...result.diagnostics, ...createFreshnessDiagnostics(result.freshness)];
      const payload = {
        workspaceRoot: context.workspace.root,
        workspaceRoots: result.workspaceRoots,
        seed: result.seed,
        targets: result.targets,
        blastRadius: result.blastRadius,
        searchedFiles: result.searchedFiles,
        matchedFiles: result.matchedFiles,
        pagination: result.pagination,
        workspaceBreakdown: result.workspaceBreakdown,
        freshness: result.freshness,
        diagnostic: result.diagnostic,
        diagnostics,
      };

      const text = describeImpactAnalysisText(
        formatImpactAnalysisText({
          seedName: result.seed?.name ?? "the requested symbol",
          targetCount: result.targets.length,
          blastRadius: result.blastRadius,
          matchedFiles: result.matchedFiles,
          searchedFiles: result.searchedFiles,
          selectedWorkspaceCount: result.workspaceRoots.length,
          configuredWorkspaceCount: context.workspace.roots.length,
          foundSeed: Boolean(result.seed),
          diagnosticMessage: result.diagnostic?.message ?? null,
        }),
        payload.freshness,
      );

      return {
        ...(result.diagnostic && result.targets.length === 0 ? { isError: true } : {}),
        content: [{ type: "text" as const, text }],
        structuredContent: payload,
      };
    },
  );
}

function formatImpactAnalysisText(options: {
  seedName: string;
  targetCount: number;
  blastRadius: { totalTargets: number; criticalCount: number; highCount: number };
  matchedFiles: number;
  searchedFiles: number;
  selectedWorkspaceCount: number;
  configuredWorkspaceCount: number;
  foundSeed: boolean;
  diagnosticMessage: string | null;
}): string {
  const {
    seedName,
    targetCount,
    blastRadius,
    matchedFiles,
    searchedFiles,
    selectedWorkspaceCount,
    configuredWorkspaceCount,
    foundSeed,
    diagnosticMessage,
  } = options;

  if (!foundSeed) {
    return diagnosticMessage ?? "Impact analysis failed.";
  }

  if (targetCount > 0) {
    let text = `Found ${targetCount} impact target(s) for ${seedName}`;
    if (blastRadius.criticalCount > 0) {
      text += ` (${blastRadius.criticalCount} critical`;
      if (blastRadius.highCount > 0) text += `, ${blastRadius.highCount} high`;
      text += ")";
    }

    text += ` across ${matchedFiles} file(s)`;

    if (configuredWorkspaceCount > 1) {
      text += ` after searching ${searchedFiles} files in ${selectedWorkspaceCount} of ${configuredWorkspaceCount} configured workspaces.`;
    } else {
      text += ` after searching ${searchedFiles} files.`;
    }

    return text;
  }

  if (configuredWorkspaceCount > 1) {
    return `No impact targets were found for ${seedName} after searching ${searchedFiles} files in ${selectedWorkspaceCount} of ${configuredWorkspaceCount} configured workspaces.`;
  }

  return `No impact targets were found for ${seedName} after searching ${searchedFiles} files.`;
}

function describeImpactAnalysisText(
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
