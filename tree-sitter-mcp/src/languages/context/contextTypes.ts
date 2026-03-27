import { z } from "zod";
import { SourceRangeSchema } from "../../diagnostics/diagnosticFactory.js";

export const EnclosingContextKindSchema = z.enum(["class", "function", "interface", "method"]);

export const EnclosingContextSchema = z.object({
  name: z.string().nullable(),
  kind: EnclosingContextKindSchema,
  range: SourceRangeSchema,
});

export const ContextSnippetSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
});

export type EnclosingContext = z.infer<typeof EnclosingContextSchema>;
export type ContextSnippet = z.infer<typeof ContextSnippetSchema>;
