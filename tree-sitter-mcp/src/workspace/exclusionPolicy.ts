import { normalizeAbsolutePath, relativeToWorkspace } from "./resolveWorkspace.js";

export interface ExclusionMatch {
  pattern: string;
  relativePath: string;
  mode: "segment" | "path";
}

export interface ExclusionPolicy {
  patterns: string[];
  shouldExclude(targetPath: string): boolean;
  explain(targetPath: string): ExclusionMatch | null;
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function explainExclusion(root: string, targetPath: string, patterns: string[]): ExclusionMatch | null {
  const relativePath = relativeToWorkspace(root, normalizeAbsolutePath(targetPath)).replace(/\\/g, "/");
  const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0 && segment !== ".");

  for (const pattern of patterns) {
    const normalizedPattern = normalizePattern(pattern);
    if (normalizedPattern.length === 0) {
      continue;
    }

    if (normalizedPattern.includes("/")) {
      if (
        relativePath === normalizedPattern
        || relativePath.startsWith(`${normalizedPattern}/`)
        || relativePath.includes(`/${normalizedPattern}/`)
      ) {
        return {
          pattern: normalizedPattern,
          relativePath,
          mode: "path",
        };
      }
      continue;
    }

    if (pathSegments.includes(normalizedPattern)) {
      return {
        pattern: normalizedPattern,
        relativePath,
        mode: "segment",
      };
    }
  }

  return null;
}

export function createExclusionPolicy(root: string, patterns: string[]): ExclusionPolicy {
  const normalizedRoot = normalizeAbsolutePath(root);
  const normalizedPatterns = patterns
    .map(normalizePattern)
    .filter((pattern, index, allPatterns) => pattern.length > 0 && allPatterns.indexOf(pattern) === index);

  return {
    patterns: normalizedPatterns,
    shouldExclude(targetPath: string): boolean {
      return explainExclusion(normalizedRoot, targetPath, normalizedPatterns) !== null;
    },
    explain(targetPath: string): ExclusionMatch | null {
      return explainExclusion(normalizedRoot, targetPath, normalizedPatterns);
    },
  };
}
