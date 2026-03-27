import { z } from "zod";

export const SourcePositionSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const SourceRangeSchema = z.object({
  start: SourcePositionSchema,
  end: SourcePositionSchema,
});

export const DiagnosticCodeSchema = z.enum([
  "workspace_not_set",
  "workspace_root_invalid",
  "workspace_path_out_of_scope",
  "file_excluded",
  "file_not_found",
  "unsupported_file",
  "unsupported_language",
  "relationship_depth_invalid",
  "dependency_depth_invalid",
  "parse_failed",
  "index_build_failed",
  "index_refresh_failed",
  "index_degraded",
  "index_schema_mismatch",
  "definition_not_found",
  "reference_not_found",
]);

export const DiagnosticSchema = z.object({
  code: DiagnosticCodeSchema,
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  reason: z.string(),
  nextStep: z.string(),
  filePath: z.string().optional(),
  relativePath: z.string().optional(),
  languageId: z.string().optional(),
  range: SourceRangeSchema.optional(),
  details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export type SourceRange = z.infer<typeof SourceRangeSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type DiagnosticCode = z.infer<typeof DiagnosticCodeSchema>;

interface CreateDiagnosticInput {
  code: DiagnosticCode;
  message: string;
  reason: string;
  nextStep: string;
  severity?: Diagnostic["severity"];
  filePath?: string;
  relativePath?: string;
  languageId?: string;
  range?: Diagnostic["range"];
  details?: Diagnostic["details"];
}

export function createSourceRange(
  startPosition: { row: number; column: number },
  endPosition: { row: number; column: number },
  startIndex: number,
  endIndex: number,
): SourceRange {
  return {
    start: {
      line: startPosition.row + 1,
      column: startPosition.column + 1,
      offset: startIndex,
    },
    end: {
      line: endPosition.row + 1,
      column: endPosition.column + 1,
      offset: endIndex,
    },
  };
}

export function createDiagnostic(input: CreateDiagnosticInput): Diagnostic {
  return {
    code: input.code,
    severity: input.severity ?? "error",
    message: input.message,
    reason: input.reason,
    nextStep: input.nextStep,
    ...(input.filePath ? { filePath: input.filePath } : {}),
    ...(input.relativePath ? { relativePath: input.relativePath } : {}),
    ...(input.languageId ? { languageId: input.languageId } : {}),
    ...(input.range ? { range: input.range } : {}),
    ...(input.details ? { details: input.details } : {}),
  };
}

export function diagnosticToText(diagnostic: Diagnostic): string {
  const location = diagnostic.relativePath ?? diagnostic.filePath ?? "server";
  return `${diagnostic.code}: ${diagnostic.message} (${location})`;
}
