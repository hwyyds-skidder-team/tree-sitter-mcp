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
  const trimmedPath = targetPath.trim();
  if (trimmedPath.length === 0) {
    throw new Error("Path is required.");
  }

  const candidatePath = isAbsolutePathLike(trimmedPath)
    ? normalizeAbsolutePathLike(trimmedPath)
    : normalizeAbsolutePath(path.join(root, ...splitPathSegments(trimmedPath)));

  if (!isPathInsideWorkspace(root, candidatePath)) {
    throw new Error(`Path escapes the configured workspace root: ${targetPath}`);
  }

  return candidatePath;
}

export function normalizeWorkspaceRelativePath(root: string, targetPath: string): string | null {
  const relativePath = relativeToWorkspace(root, resolveWorkspacePath(root, targetPath));
  return relativePath === "." ? null : relativePath;
}

export function relativeToWorkspace(root: string, targetPath: string): string {
  const relativePath = path.relative(normalizeAbsolutePath(root), normalizeAbsolutePath(targetPath));
  const normalizedPath = normalizeRelativePath(relativePath);
  return normalizedPath.length === 0 ? "." : normalizedPath;
}

export function normalizeRelativePath(targetPath: string): string {
  return targetPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

export function relativePathMatchesPrefix(relativePath: string, prefix: string): boolean {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const normalizedPrefix = normalizeRelativePath(prefix);

  if (normalizedPrefix.length === 0) {
    return true;
  }

  return normalizedRelativePath === normalizedPrefix
    || normalizedRelativePath.startsWith(`${normalizedPrefix}/`);
}

function splitPathSegments(targetPath: string): string[] {
  const normalizedPath = normalizeRelativePath(targetPath);
  if (normalizedPath.length === 0) {
    return [];
  }

  return normalizedPath.split("/").filter((segment) => segment.length > 0);
}

function isAbsolutePathLike(targetPath: string): boolean {
  return path.isAbsolute(targetPath)
    || path.win32.isAbsolute(targetPath)
    || path.posix.isAbsolute(targetPath);
}

function normalizeAbsolutePathLike(targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return normalizeAbsolutePath(targetPath);
  }

  if (path.win32.isAbsolute(targetPath)) {
    return path.win32.normalize(targetPath);
  }

  if (path.posix.isAbsolute(targetPath)) {
    return path.posix.normalize(targetPath);
  }

  return normalizeAbsolutePath(targetPath);
}
