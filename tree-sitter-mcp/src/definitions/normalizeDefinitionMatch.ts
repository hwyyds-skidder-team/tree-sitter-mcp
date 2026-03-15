import path from "node:path";
import type { SourceRange } from "../diagnostics/diagnosticFactory.js";
import type { SymbolMatch } from "../queries/queryCatalog.js";
import { DefinitionMatchSchema, type DefinitionMatch } from "./definitionTypes.js";

export function normalizeDefinitionMatch(match: SymbolMatch): DefinitionMatch {
  const range = DefinitionMatchSchema.shape.range.parse(match.range);
  const selectionRange = normalizeSelectionRange(
    DefinitionMatchSchema.shape.range.parse(match.selectionRange),
    range,
  );

  return DefinitionMatchSchema.parse({
    ...match,
    languageId: match.languageId.trim().toLowerCase(),
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
