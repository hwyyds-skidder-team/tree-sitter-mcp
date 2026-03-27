import { z } from "zod";
import { DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import { PaginationSchema } from "../results/paginateResults.js";
import { SymbolKindSchema } from "../queries/queryCatalog.js";
import { ReferenceMatchSchema } from "../references/referenceTypes.js";
import { RelationshipKindSchema, type RelationshipKind } from "../relationships/relationshipTypes.js";

export const DependencyDirectionSchema = z.enum(["incoming", "outgoing"]);

export const DependencySeedSchema = z.object({
  name: z.string().min(1),
  languageId: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
  relativePath: z.string().min(1).optional(),
  kind: SymbolKindSchema.optional(),
});

export const DependencyPathStepSchema = z.object({
  relationshipKind: RelationshipKindSchema,
  fromSymbol: DefinitionMatchSchema,
  toSymbol: DefinitionMatchSchema,
  evidence: ReferenceMatchSchema,
});

export const DependencyResultSchema = z.object({
  symbol: DefinitionMatchSchema,
  direction: DependencyDirectionSchema,
  depth: z.number().int().min(1).max(4),
  path: z.array(DependencyPathStepSchema).min(1),
});

export const DependencyFilterSchema = z.object({
  workspaceRoots: z.array(z.string().min(1)).min(1).optional(),
  language: z.string().nullable(),
  relationshipKinds: z.array(RelationshipKindSchema).min(1),
  maxDepth: z.number().int().min(1).max(4),
  limit: z.number().int().positive().max(200),
  offset: z.number().int().nonnegative(),
});

export const DependencyAnalysisRequestSchema = z.object({
  symbol: DependencySeedSchema.optional().describe(
    "Dependency seed descriptor. Provide symbol or lookup.",
  ),
  lookup: DependencySeedSchema.optional().describe(
    "Dependency seed lookup. Provide symbol or lookup.",
  ),
  workspaceRoots: z.array(z.string().min(1)).min(1).optional().describe(
    "Optional subset of configured workspace roots to search.",
  ),
  language: z.string().min(1).optional().describe("Optional language filter."),
  relationshipKinds: z.array(RelationshipKindSchema).optional().describe(
    "Relationship kinds to include in dependency traversal.",
  ),
  maxDepth: z.number().int().min(1).max(4).optional().describe(
    "Dependency traversal depth. Supports bounded multi-hop traversal up to depth 4.",
  ),
  limit: z.number().int().positive().max(200).optional().describe(
    "Maximum number of dependency results to return.",
  ),
  offset: z.number().int().nonnegative().optional().describe(
    "Pagination offset for dependency results.",
  ),
});

export const ValidatedDependencyAnalysisRequestSchema = DependencyAnalysisRequestSchema.refine(
  (request) => request.symbol || request.lookup,
  {
    message: "Provide a dependency seed via symbol or lookup.",
    path: ["symbol"],
  },
);

export const DependencyAnalysisResultSchema = z.object({
  target: DefinitionMatchSchema,
  filters: DependencyFilterSchema,
  results: z.array(DependencyResultSchema),
  pagination: PaginationSchema,
});

export type DependencyDirection = z.infer<typeof DependencyDirectionSchema>;
export type DependencySeed = z.infer<typeof DependencySeedSchema>;
export type DependencyPathStep = z.infer<typeof DependencyPathStepSchema>;
export type DependencyResult = z.infer<typeof DependencyResultSchema>;
export type DependencyFilters = z.infer<typeof DependencyFilterSchema>;
export type DependencyAnalysisRequest = z.infer<typeof DependencyAnalysisRequestSchema>;
export type ValidatedDependencyAnalysisRequest = z.infer<typeof ValidatedDependencyAnalysisRequestSchema>;
export type DependencyAnalysisResult = z.infer<typeof DependencyAnalysisResultSchema>;

export interface DependencyFilterInput {
  workspaceRoots?: readonly string[] | null;
  language?: string | null;
  relationshipKinds?: readonly RelationshipKind[] | null;
  maxDepth?: number | null;
  limit?: number | null;
  offset?: number | null;
}
