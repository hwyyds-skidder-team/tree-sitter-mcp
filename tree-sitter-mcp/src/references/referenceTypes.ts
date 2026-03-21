import { z } from "zod";
import { ContextSnippetSchema, EnclosingContextSchema } from "../context/contextTypes.js";
import { SourceRangeSchema } from "../diagnostics/diagnosticFactory.js";
import { SymbolKindSchema } from "../queries/queryCatalog.js";

export const ReferenceKindSchema = z.enum(["reference", "call"]);

export const ReferenceMatchSchema = z.object({
  name: z.string().min(1),
  referenceKind: ReferenceKindSchema,
  symbolKind: SymbolKindSchema.nullable(),
  languageId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  filePath: z.string().min(1),
  relativePath: z.string().min(1),
  range: SourceRangeSchema,
  selectionRange: SourceRangeSchema,
  containerName: z.string().nullable(),
  snippet: z.string(),
  enclosingContext: EnclosingContextSchema.nullable().optional(),
  contextSnippet: ContextSnippetSchema.nullable().optional(),
});

export const ReferenceSearchTargetSchema = z.object({
  name: z.string().min(1),
  languageId: z.string().optional(),
  workspaceRoot: z.string().min(1).optional(),
  relativePath: z.string().optional(),
  kind: SymbolKindSchema.optional(),
});

export const SearchReferencesRequestSchema = z.object({
  symbol: ReferenceSearchTargetSchema.optional(),
  lookup: ReferenceSearchTargetSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export type ReferenceKind = z.infer<typeof ReferenceKindSchema>;
export type ReferenceMatch = z.infer<typeof ReferenceMatchSchema>;
export type ReferenceSearchTarget = z.infer<typeof ReferenceSearchTargetSchema>;
