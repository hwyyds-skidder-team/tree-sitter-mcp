import { z } from "zod";
import { SourceRangeSchema } from "../diagnostics/diagnosticFactory.js";
import { SymbolKindSchema, type SymbolKind } from "../queries/queryCatalog.js";

export const DefinitionMatchSchema = z.object({
  name: z.string().min(1),
  kind: SymbolKindSchema,
  languageId: z.string().min(1),
  filePath: z.string().min(1),
  relativePath: z.string().min(1),
  range: SourceRangeSchema,
  selectionRange: SourceRangeSchema,
  containerName: z.string().nullable(),
  snippet: z.string(),
});

export const DefinitionFilterSchema = z.object({
  language: z.string().nullable(),
  pathPrefix: z.string().nullable(),
  symbolKinds: z.array(SymbolKindSchema),
});

export type DefinitionMatch = z.infer<typeof DefinitionMatchSchema>;
export type DefinitionFilters = z.infer<typeof DefinitionFilterSchema>;

export interface DefinitionFilterInput {
  language?: string | null;
  pathPrefix?: string | null;
  symbolKinds?: readonly SymbolKind[] | null;
}
