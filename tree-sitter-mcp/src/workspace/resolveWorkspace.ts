import fs from "node:fs/promises";
import path from "node:path";

export function normalizeAbsolutePath(targetPath: string): string {
  return path.normalize(path.resolve(targetPath));
}

export async function resolveWorkspaceRoot(targetRoot: string): Promise<string> {
  if (targetRoot.trim().length === 0) {
    throw new Error("Workspace root is required.");
  }

  const resolvedRoot = normalizeAbsolutePath(targetRoot);

  let stats;
  try {
    stats = await fs.stat(resolvedRoot);
  } catch {
    throw new Error(`Workspace root does not exist: ${resolvedRoot}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Workspace root must be a directory: ${resolvedRoot}`);
  }

  return resolvedRoot;
}

export function isPathInsideWorkspace(root: string, candidatePath: string): boolean {
  const normalizedRoot = normalizeAbsolutePath(root);
  const normalizedCandidate = normalizeAbsolutePath(candidatePath);
  const relativePath = path.relative(normalizedRoot, normalizedCandidate);

  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function resolveWorkspacePath(root: string, targetPath: string): string {
  const candidatePath = path.isAbsolute(targetPath)
    ? normalizeAbsolutePath(targetPath)
    : normalizeAbsolutePath(path.join(root, targetPath));

  if (!isPathInsideWorkspace(root, candidatePath)) {
    throw new Error(`Path escapes the configured workspace root: ${targetPath}`);
  }

  return candidatePath;
}

export function relativeToWorkspace(root: string, targetPath: string): string {
  const relativePath = path.relative(root, targetPath).split(path.sep).join("/");
  return relativePath.length === 0 ? "." : relativePath;
}
