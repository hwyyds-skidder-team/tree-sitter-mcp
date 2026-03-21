import { z } from "zod";
import {
  createEmptyWorkspaceIndexSummary,
  type WorkspaceIndexSummary,
  WorkspaceIndexSummarySchema,
} from "../indexing/indexTypes.js";

export const SearchableFileRecordSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  languageId: z.string(),
  grammarName: z.string(),
});

export const UnsupportedFileRecordSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  reason: z.string(),
  extension: z.string().nullable().optional(),
});

export const WorkspaceSummarySchema = z.object({
  root: z.string().nullable(),
  exclusions: z.array(z.string()),
  searchableFileCount: z.number().int().nonnegative(),
  unsupportedFileCount: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().nullable(),
  index: WorkspaceIndexSummarySchema,
});

export type SearchableFileRecord = z.infer<typeof SearchableFileRecordSchema>;
export type UnsupportedFileRecord = z.infer<typeof UnsupportedFileRecordSchema>;
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export interface WorkspaceState {
  root: string | null;
  exclusions: string[];
  searchableFiles: SearchableFileRecord[];
  unsupportedFiles: UnsupportedFileRecord[];
  lastUpdatedAt: string | null;
  index: WorkspaceIndexSummary;
}

export interface WorkspaceSnapshotInput {
  root: string;
  exclusions: string[];
  searchableFiles: SearchableFileRecord[];
  unsupportedFiles: UnsupportedFileRecord[];
  lastUpdatedAt?: string;
}

export function mergeExclusions(...lists: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const list of lists) {
    for (const entry of list) {
      const normalized = entry.trim();
      if (normalized.length === 0 || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      merged.push(normalized);
    }
  }

  return merged;
}

export function createWorkspaceState(
  defaultExclusions: string[],
  index: WorkspaceIndexSummary = createEmptyWorkspaceIndexSummary(),
): WorkspaceState {
  return {
    root: null,
    exclusions: mergeExclusions(defaultExclusions),
    searchableFiles: [],
    unsupportedFiles: [],
    lastUpdatedAt: null,
    index: { ...index },
  };
}

export function applyWorkspaceSnapshot(
  state: WorkspaceState,
  snapshot: WorkspaceSnapshotInput,
): void {
  state.root = snapshot.root;
  state.exclusions = [...snapshot.exclusions];
  state.searchableFiles = snapshot.searchableFiles.map((file) => ({ ...file }));
  state.unsupportedFiles = snapshot.unsupportedFiles.map((file) => ({ ...file }));
  state.lastUpdatedAt = snapshot.lastUpdatedAt ?? new Date().toISOString();
}

export function summarizeWorkspace(state: WorkspaceState): WorkspaceSummary {
  return {
    root: state.root,
    exclusions: [...state.exclusions],
    searchableFileCount: state.searchableFiles.length,
    unsupportedFileCount: state.unsupportedFiles.length,
    lastUpdatedAt: state.lastUpdatedAt,
    index: { ...state.index },
  };
}

export function applyWorkspaceIndexSummary(
  state: WorkspaceState,
  index: WorkspaceIndexSummary,
): void {
  state.index = { ...index };
}
