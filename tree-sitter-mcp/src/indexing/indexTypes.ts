import { z } from "zod";

export const FreshnessStateSchema = z.enum(["fresh", "refreshed", "rebuilding", "degraded"]);

export const IndexedFileSemanticRecordSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  languageId: z.string(),
  grammarName: z.string(),
  contentHash: z.string(),
  symbolCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export const WorkspaceIndexManifestSchema = z.object({
  schemaVersion: z.string(),
  workspaceFingerprint: z.string(),
  workspaceRoot: z.string(),
  exclusions: z.array(z.string()),
  lastBuiltAt: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
  state: FreshnessStateSchema,
  indexedFileCount: z.number().int().nonnegative(),
  degradedFiles: z.array(z.string()),
});

export const WorkspaceIndexSummarySchema = z.object({
  enabled: z.boolean(),
  storageMode: z.literal("disk"),
  state: FreshnessStateSchema,
  workspaceFingerprint: z.string().nullable(),
  indexedFileCount: z.number().int().nonnegative(),
  degradedFileCount: z.number().int().nonnegative(),
  lastBuiltAt: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
});

export type FreshnessState = z.infer<typeof FreshnessStateSchema>;
export type IndexedFileSemanticRecord = z.infer<typeof IndexedFileSemanticRecordSchema>;
export type WorkspaceIndexManifest = z.infer<typeof WorkspaceIndexManifestSchema>;
export type WorkspaceIndexSummary = z.infer<typeof WorkspaceIndexSummarySchema>;

export function createEmptyWorkspaceIndexSummary(): WorkspaceIndexSummary {
  return {
    enabled: true,
    storageMode: "disk",
    state: "rebuilding",
    workspaceFingerprint: null,
    indexedFileCount: 0,
    degradedFileCount: 0,
    lastBuiltAt: null,
    lastRefreshedAt: null,
  };
}

export function summarizeWorkspaceIndexManifest(
  manifest: WorkspaceIndexManifest,
): WorkspaceIndexSummary {
  return {
    enabled: true,
    storageMode: "disk",
    state: manifest.state,
    workspaceFingerprint: manifest.workspaceFingerprint,
    indexedFileCount: manifest.indexedFileCount,
    degradedFileCount: manifest.degradedFiles.length,
    lastBuiltAt: manifest.lastBuiltAt,
    lastRefreshedAt: manifest.lastRefreshedAt,
  };
}
