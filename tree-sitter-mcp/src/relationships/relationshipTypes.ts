import { z } from "zod";
import { DefinitionMatchSchema } from "../definitions/definitionTypes.js";
import { PaginationSchema } from "../results/paginateResults.js";
import { SymbolKindSchema } from "../queries/queryCatalog.js";
import { ReferenceMatchSchema } from "../references/referenceTypes.js";

export const RelationshipKindSchema = z.enum([
  "incoming_call",
  "incoming_reference",
  "outgoing_call",
  "outgoing_reference",
]);

export const RelationshipSeedSchema = z.object({
  name: z.string().min(1),
  languageId: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
  relativePath: z.string().min(1).optional(),
  kind: SymbolKindSchema.optional(),
});

export const RelationshipEdgeSchema = z.object({
  relationshipKind: RelationshipKindSchema,
  hopCount: z.number().int().min(1).max(2),
  relatedSymbol: DefinitionMatchSchema,
  evidence: ReferenceMatchSchema,
});

export const RelationshipFilterSchema = z.object({
  workspaceRoots: z.array(z.string().min(1)).min(1).optional(),
  language: z.string().nullable(),
  relationshipKinds: z.array(RelationshipKindSchema).min(1),
  maxDepth: z.number().int().min(1).max(2),
  limit: z.number().int().positive().max(200),
  offset: z.number().int().nonnegative(),
});

export const RelationshipViewRequestSchema = z.object({
  symbol: RelationshipSeedSchema.optional(),
  lookup: RelationshipSeedSchema.optional(),
  workspaceRoots: z.array(z.string().min(1)).min(1).optional(),
  language: z.string().min(1).optional(),
  relationshipKinds: z.array(RelationshipKindSchema).optional(),
  maxDepth: z.number().int().min(1).max(2).optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
}).refine((request) => request.symbol || request.lookup, {
  message: "Provide a relationship seed via symbol or lookup.",
  path: ["symbol"],
});

export const RelationshipViewResultSchema = z.object({
  target: DefinitionMatchSchema,
  filters: RelationshipFilterSchema,
  edges: z.array(RelationshipEdgeSchema),
  pagination: PaginationSchema,
});

export type RelationshipKind = z.infer<typeof RelationshipKindSchema>;
export type RelationshipSeed = z.infer<typeof RelationshipSeedSchema>;
export type RelationshipEdge = z.infer<typeof RelationshipEdgeSchema>;
export type RelationshipFilters = z.infer<typeof RelationshipFilterSchema>;
export type RelationshipViewRequest = z.infer<typeof RelationshipViewRequestSchema>;
export type RelationshipViewResult = z.infer<typeof RelationshipViewResultSchema>;

export interface RelationshipFilterInput {
  workspaceRoots?: readonly string[] | null;
  language?: string | null;
  relationshipKinds?: readonly RelationshipKind[] | null;
  maxDepth?: number | null;
  limit?: number | null;
  offset?: number | null;
}
