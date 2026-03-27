import path from "node:path";
import type { SourceRange } from "../../diagnostics/diagnosticFactory.js";
import type { SymbolMatch } from "../../queries/queryCatalog.js";
import { DefinitionMatchSchema, type DefinitionMatch } from "./definitionTypes.js";

export function normalizeDefinitionMatch(match: SymbolMatch): DefinitionMatch {
  const range = DefinitionMatchSchema.shape.range.parse(match.range);
  const selectionRange = normalizeSelectionRange(
    DefinitionMatchSchema.shape.range.parse(match.selectionRange),
    range,
  );
  const workspaceRoot = normalizeWorkspaceRoot(match);

  return DefinitionMatchSchema.parse({
    ...match,
    languageId: match.languageId.trim().toLowerCase(),
    workspaceRoot,
    filePath: path.normalize(match.filePath),
    relativePath: normalizeRelativePath(match.relativePath),
    range,
    selectionRange,
    containerName: normalizeContainerName(match.containerName),
    snippet: normalizeSnippet(match.snippet),
  });
}

export function normalizeDefinitionMatches(matches: readonly SymbolMatch[]): DefinitionMatch[] {
  return matches.map((match) => normalizeDefinitionMatch(match));
}

function normalizeSelectionRange(selectionRange: SourceRange, fallbackRange: SourceRange): SourceRange {
  return isNestedRange(selectionRange, fallbackRange) ? selectionRange : fallbackRange;
}

function isNestedRange(candidate: SourceRange, parent: SourceRange): boolean {
  return compareOffsets(candidate.start.offset, parent.start.offset) >= 0
    && compareOffsets(candidate.end.offset, parent.end.offset) <= 0;
}

function compareOffsets(left: number, right: number): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function normalizeContainerName(containerName: string | null): string | null {
  const normalized = containerName?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeSnippet(snippet: string): string {
  return snippet.trim().replace(/\s+/g, " ");
}

function normalizeWorkspaceRoot(
  match: Pick<SymbolMatch, "filePath" | "relativePath"> & { workspaceRoot?: string },
): string {
  const explicitWorkspaceRoot = match.workspaceRoot?.trim() ?? "";
  if (explicitWorkspaceRoot.length > 0) {
    return path.normalize(explicitWorkspaceRoot);
  }

  return deriveWorkspaceRoot(match.filePath, match.relativePath);
}

function deriveWorkspaceRoot(filePath: string, relativePath: string): string {
  const normalizedFilePath = path.normalize(filePath);
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  if (normalizedRelativePath.length === 0 || normalizedRelativePath === ".") {
    return path.dirname(normalizedFilePath);
  }

  const segmentCount = normalizedRelativePath.split("/").filter((segment) => segment.length > 0).length;
  return path.resolve(path.dirname(normalizedFilePath), ...Array(Math.max(segmentCount - 1, 0)).fill(".."));
}
