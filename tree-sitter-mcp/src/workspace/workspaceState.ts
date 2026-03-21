import { z } from "zod";
import {
  createEmptyWorkspaceIndexSummary,
  type WorkspaceIndexSummary,
  WorkspaceIndexSummarySchema,
} from "../indexing/indexTypes.js";

export const SearchableFileRecordSchema = z.object({
  workspaceRoot: z.string().optional(),
  path: z.string(),
  relativePath: z.string(),
  languageId: z.string(),
  grammarName: z.string(),
});

export const UnsupportedFileRecordSchema = z.object({
  workspaceRoot: z.string().optional(),
  path: z.string(),
  relativePath: z.string(),
  reason: z.string(),
  extension: z.string().nullable().optional(),
});

export const WorkspaceEntrySummarySchema = z.object({
  root: z.string(),
  exclusions: z.array(z.string()),
  searchableFileCount: z.number().int().nonnegative(),
  unsupportedFileCount: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().nullable(),
  index: WorkspaceIndexSummarySchema,
});

export const WorkspaceSummarySchema = z.object({
  root: z.string().nullable(),
  roots: z.array(z.string()),
  workspaceCount: z.number().int().nonnegative(),
  workspaces: z.array(WorkspaceEntrySummarySchema),
  exclusions: z.array(z.string()),
  searchableFileCount: z.number().int().nonnegative(),
  unsupportedFileCount: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().nullable(),
  index: WorkspaceIndexSummarySchema,
});

export type SearchableFileRecord = z.infer<typeof SearchableFileRecordSchema>;
export type UnsupportedFileRecord = z.infer<typeof UnsupportedFileRecordSchema>;
export type WorkspaceEntrySummary = z.infer<typeof WorkspaceEntrySummarySchema>;
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export interface WorkspaceState {
  root: string | null;
  roots: string[];
  workspaceCount: number;
  workspaces: WorkspaceEntrySummary[];
  exclusions: string[];
  searchableFiles: SearchableFileRecord[];
  unsupportedFiles: UnsupportedFileRecord[];
  lastUpdatedAt: string | null;
  index: WorkspaceIndexSummary;
}

export interface WorkspaceEntrySnapshotInput {
  root: string;
  exclusions?: string[];
  searchableFileCount?: number;
  unsupportedFileCount?: number;
  lastUpdatedAt?: string | null;
  index?: WorkspaceIndexSummary;
}

export interface WorkspaceSnapshotInput {
  root?: string | null;
  roots?: string[];
  workspaces?: WorkspaceEntrySnapshotInput[];
  exclusions: string[];
  searchableFiles: SearchableFileRecord[];
  unsupportedFiles: UnsupportedFileRecord[];
  lastUpdatedAt?: string;
  index?: WorkspaceIndexSummary;
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
    roots: [],
    workspaceCount: 0,
    workspaces: [],
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
  const lastUpdatedAt = snapshot.lastUpdatedAt ?? new Date().toISOString();
  const roots = resolveSnapshotRoots(snapshot);

  state.root = roots[0] ?? null;
  state.roots = [...roots];
  state.workspaceCount = roots.length;
  state.workspaces = createWorkspaceEntrySummaries(state, snapshot, roots, lastUpdatedAt);
  state.exclusions = [...snapshot.exclusions];
  state.searchableFiles = snapshot.searchableFiles.map((file) => ({ ...file }));
  state.unsupportedFiles = snapshot.unsupportedFiles.map((file) => ({ ...file }));
  state.lastUpdatedAt = lastUpdatedAt;
}

export function summarizeWorkspace(state: WorkspaceState): WorkspaceSummary {
  return {
    root: state.root,
    roots: [...state.roots],
    workspaceCount: state.workspaceCount,
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      exclusions: [...workspace.exclusions],
      index: { ...workspace.index },
    })),
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

  if (state.workspaceCount === 1 && state.root !== null) {
    state.workspaces = state.workspaces.map((workspace) => workspace.root === state.root
      ? {
        ...workspace,
        exclusions: [...workspace.exclusions],
        index: { ...index },
      }
      : workspace);
  }
}

export function applyWorkspaceEntryIndexSummaries(
  state: WorkspaceState,
  entries: Array<{ root: string; index: WorkspaceIndexSummary }>,
): void {
  if (entries.length === 0 || state.workspaces.length === 0) {
    return;
  }

  const summariesByRoot = new Map(
    entries.map((entry) => [entry.root, { ...entry.index }] as const),
  );

  state.workspaces = state.workspaces.map((workspace) => {
    const nextIndex = summariesByRoot.get(workspace.root);
    if (!nextIndex) {
      return workspace;
    }

    return {
      ...workspace,
      exclusions: [...workspace.exclusions],
      index: nextIndex,
    };
  });
}

function resolveSnapshotRoots(snapshot: WorkspaceSnapshotInput): string[] {
  const roots = snapshot.roots ?? snapshot.workspaces?.map((workspace) => workspace.root) ?? [];
  if (roots.length > 0) {
    return [...new Set(roots)];
  }

  if (snapshot.root) {
    return [snapshot.root];
  }

  return [];
}

function createWorkspaceEntrySummaries(
  state: WorkspaceState,
  snapshot: WorkspaceSnapshotInput,
  roots: string[],
  lastUpdatedAt: string,
): WorkspaceEntrySummary[] {
  if (roots.length === 0) {
    return [];
  }

  const explicitEntries = snapshot.workspaces;
  if (explicitEntries && explicitEntries.length > 0) {
    return explicitEntries.map((workspace) => createWorkspaceEntrySummary({
      root: workspace.root,
      exclusions: workspace.exclusions ?? snapshot.exclusions,
      searchableFileCount: workspace.searchableFileCount,
      unsupportedFileCount: workspace.unsupportedFileCount,
      lastUpdatedAt: workspace.lastUpdatedAt ?? lastUpdatedAt,
      index: workspace.index ?? findWorkspaceIndex(
        state,
        workspace.root,
        roots.length,
        workspace.root === roots[0] ? snapshot.index : undefined,
      ),
    }));
  }

  return roots.map((root, index) => createWorkspaceEntrySummary({
    root,
    exclusions: snapshot.exclusions,
    searchableFileCount: countRecordsForWorkspace(snapshot.searchableFiles, root, roots[0]),
    unsupportedFileCount: countRecordsForWorkspace(snapshot.unsupportedFiles, root, roots[0]),
    lastUpdatedAt,
    index: findWorkspaceIndex(state, root, roots.length, index === 0 ? snapshot.index : undefined),
  }));
}

function createWorkspaceEntrySummary(input: {
  root: string;
  exclusions: string[];
  searchableFileCount?: number;
  unsupportedFileCount?: number;
  lastUpdatedAt?: string | null;
  index?: WorkspaceIndexSummary;
}): WorkspaceEntrySummary {
  return {
    root: input.root,
    exclusions: [...input.exclusions],
    searchableFileCount: input.searchableFileCount ?? 0,
    unsupportedFileCount: input.unsupportedFileCount ?? 0,
    lastUpdatedAt: input.lastUpdatedAt ?? null,
    index: { ...(input.index ?? createEmptyWorkspaceIndexSummary()) },
  };
}

function findWorkspaceIndex(
  state: WorkspaceState,
  root: string,
  workspaceCount: number,
  fallback?: WorkspaceIndexSummary,
): WorkspaceIndexSummary {
  const existingWorkspace = state.workspaces.find((workspace) => workspace.root === root);
  if (existingWorkspace) {
    return existingWorkspace.index;
  }

  if (fallback) {
    return fallback;
  }

  if (workspaceCount === 1 && state.root === root) {
    return state.index;
  }

  return createEmptyWorkspaceIndexSummary();
}

function countRecordsForWorkspace(
  records: Array<SearchableFileRecord | UnsupportedFileRecord>,
  root: string,
  fallbackRoot: string | undefined,
): number {
  return records.filter((record) => {
    if (record.workspaceRoot) {
      return record.workspaceRoot === root;
    }

    return fallbackRoot === root;
  }).length;
}
