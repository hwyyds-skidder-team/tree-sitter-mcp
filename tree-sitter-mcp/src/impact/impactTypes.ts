import { z } from "zod";
import { DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import { DependencyPathStepSchema } from "../dependencies/dependencyTypes.js";
import { RelationshipKindSchema } from "../relationships/relationshipTypes.js";
import { DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { PaginationSchema } from "../results/paginateResults.js";
import { SearchFreshnessSchema } from "../indexing/indexTypes.js";

export const ConfidenceLevelSchema = z.enum(["high", "medium", "low"]);

export const ImpactSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

export const ImpactTargetSchema = z.object({
  symbol: DefinitionMatchSchema,
  direction: z.enum(["incoming", "outgoing"]),
  depth: z.number().int().min(1).max(4),
  relationshipKind: RelationshipKindSchema,
  confidence: ConfidenceLevelSchema,
  severity: ImpactSeveritySchema,
  reason: z.string().min(1),
  path: z.array(DependencyPathStepSchema).min(1),
});

export const ImpactAreaSummarySchema = z.object({
  relativePath: z.string().min(1),
  workspaceRoot: z.string().min(1),
  targetCount: z.number().int().nonnegative(),
  criticalCount: z.number().int().nonnegative(),
  highCount: z.number().int().nonnegative(),
  severity: ImpactSeveritySchema,
});

export const ImpactBlastRadiusSchema = z.object({
  totalTargets: z.number().int().nonnegative(),
  criticalCount: z.number().int().nonnegative(),
  highCount: z.number().int().nonnegative(),
  mediumCount: z.number().int().nonnegative(),
  lowCount: z.number().int().nonnegative(),
  incomingCount: z.number().int().nonnegative(),
  outgoingCount: z.number().int().nonnegative(),
  affectedFiles: z.array(ImpactAreaSummarySchema),
  summary: z.string(),
});

export const ImpactAnalysisRequestSchema = z.object({
  symbol: z.object({
    name: z.string().min(1),
    languageId: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional(),
    relativePath: z.string().min(1).optional(),
    kind: z.enum(["class", "function", "method", "variable", "interface"]).optional(),
  }).optional().describe("Impact analysis seed descriptor. Provide symbol or lookup."),
  lookup: z.object({
    name: z.string().min(1),
    languageId: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional(),
    relativePath: z.string().min(1).optional(),
    kind: z.enum(["class", "function", "method", "variable", "interface"]).optional(),
  }).optional().describe("Impact analysis seed lookup. Provide symbol or lookup."),
  workspaceRoots: z.array(z.string().min(1)).min(1).optional().describe(
    "Optional subset of configured workspace roots to search.",
  ),
  language: z.string().min(1).optional().describe("Optional language filter."),
  relationshipKinds: z.array(RelationshipKindSchema).optional().describe(
    "Relationship kinds to include in impact traversal.",
  ),
  maxDepth: z.number().int().min(1).max(4).optional().describe(
    "Impact traversal depth (must be 1-4).",
  ),
  limit: z.number().int().positive().max(200).optional().describe(
    "Maximum number of impact targets to return.",
  ),
  offset: z.number().int().nonnegative().optional().describe(
    "Pagination offset for impact targets.",
  ),
});

export const ValidatedImpactAnalysisRequestSchema = ImpactAnalysisRequestSchema.refine(
  (request) => request.symbol || request.lookup,
  {
    message: "Provide an impact analysis seed via symbol or lookup.",
    path: ["symbol"],
  },
);

export const ImpactAnalysisResultSchema = z.object({
  workspaceRoot: z.string().nullable(),
  workspaceRoots: z.array(z.string()),
  seed: DefinitionMatchSchema.nullable(),
  targets: z.array(ImpactTargetSchema),
  blastRadius: ImpactBlastRadiusSchema,
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  pagination: PaginationSchema,
  workspaceBreakdown: z.array(z.object({
    workspaceRoot: z.string(),
    searchedFiles: z.number().int().nonnegative(),
    matchedFiles: z.number().int().nonnegative(),
    returnedResults: z.number().int().nonnegative(),
  })),
  freshness: SearchFreshnessSchema,
  diagnostic: DiagnosticSchema.nullable(),
  diagnostics: z.array(DiagnosticSchema),
});

export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;
export type ImpactSeverity = z.infer<typeof ImpactSeveritySchema>;
export type ImpactTarget = z.infer<typeof ImpactTargetSchema>;
export type ImpactAreaSummary = z.infer<typeof ImpactAreaSummarySchema>;
export type ImpactBlastRadius = z.infer<typeof ImpactBlastRadiusSchema>;
export type ImpactAnalysisRequest = z.infer<typeof ImpactAnalysisRequestSchema>;
export type ValidatedImpactAnalysisRequest = z.infer<typeof ValidatedImpactAnalysisRequestSchema>;
export type ImpactAnalysisResult = z.infer<typeof ImpactAnalysisResultSchema>;
