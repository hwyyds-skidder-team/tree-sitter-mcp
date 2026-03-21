import { z } from "zod";

export const WorkspaceBreakdownSchema = z.object({
  workspaceRoot: z.string().min(1),
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  returnedResults: z.number().int().nonnegative(),
});

export type WorkspaceBreakdown = z.infer<typeof WorkspaceBreakdownSchema>;

interface WorkspaceAwareFile {
  workspaceRoot?: string | null;
}

interface WorkspaceAwareResult {
  workspaceRoot: string;
  relativePath: string;
}

export function createWorkspaceBreakdown<
  TFile extends WorkspaceAwareFile,
  TResult extends WorkspaceAwareResult,
>(
  workspaceRoots: readonly string[],
  searchableFiles: readonly TFile[],
  results: readonly TResult[],
): WorkspaceBreakdown[] {
  const selectedWorkspaceRoots = [...new Set(workspaceRoots)];
  const searchedFilesByWorkspace = new Map<string, number>(
    selectedWorkspaceRoots.map((workspaceRoot) => [workspaceRoot, 0] as const),
  );
  const matchedFilesByWorkspace = new Map<string, Set<string>>(
    selectedWorkspaceRoots.map((workspaceRoot) => [workspaceRoot, new Set<string>()] as const),
  );
  const returnedResultsByWorkspace = new Map<string, number>(
    selectedWorkspaceRoots.map((workspaceRoot) => [workspaceRoot, 0] as const),
  );

  for (const file of searchableFiles) {
    if (!file.workspaceRoot || !searchedFilesByWorkspace.has(file.workspaceRoot)) {
      continue;
    }

    searchedFilesByWorkspace.set(
      file.workspaceRoot,
      (searchedFilesByWorkspace.get(file.workspaceRoot) ?? 0) + 1,
    );
  }

  for (const result of results) {
    if (!returnedResultsByWorkspace.has(result.workspaceRoot)) {
      continue;
    }

    returnedResultsByWorkspace.set(
      result.workspaceRoot,
      (returnedResultsByWorkspace.get(result.workspaceRoot) ?? 0) + 1,
    );
    matchedFilesByWorkspace.get(result.workspaceRoot)?.add(result.relativePath);
  }

  return selectedWorkspaceRoots.map((workspaceRoot) => WorkspaceBreakdownSchema.parse({
    workspaceRoot,
    searchedFiles: searchedFilesByWorkspace.get(workspaceRoot) ?? 0,
    matchedFiles: matchedFilesByWorkspace.get(workspaceRoot)?.size ?? 0,
    returnedResults: returnedResultsByWorkspace.get(workspaceRoot) ?? 0,
  }));
}
