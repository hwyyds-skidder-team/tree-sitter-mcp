interface WorkspaceAwareMatch {
  name: string;
  workspaceRoot?: string | null;
  relativePath: string;
  range: {
    start: {
      offset: number;
    };
  };
}

interface CompareWorkspaceAwareMatchesOptions {
  normalizedQuery: string;
  workspaceRoots?: readonly string[];
}

export function scoreNameMatch(name: string, normalizedQuery: string): number | null {
  const query = normalizedQuery.trim().toLowerCase();
  if (query.length === 0) {
    return null;
  }

  const normalizedName = name.toLowerCase();
  if (normalizedName === query) {
    return 0;
  }

  if (normalizedName.startsWith(query)) {
    return 100 + (normalizedName.length - query.length);
  }

  const containsIndex = normalizedName.indexOf(query);
  if (containsIndex >= 0) {
    return 200 + containsIndex + (normalizedName.length - query.length);
  }

  return null;
}

export function compareWorkspaceAwareMatches<T extends WorkspaceAwareMatch>(
  left: T,
  right: T,
  options: CompareWorkspaceAwareMatchesOptions,
): number {
  const leftScore = scoreNameMatch(left.name, options.normalizedQuery);
  const rightScore = scoreNameMatch(right.name, options.normalizedQuery);

  if (leftScore === null && rightScore === null) {
    return 0;
  }

  if (leftScore === null) {
    return 1;
  }

  if (rightScore === null) {
    return -1;
  }

  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }

  const workspaceComparison = compareWorkspaceRoots(
    left.workspaceRoot ?? null,
    right.workspaceRoot ?? null,
    options.workspaceRoots,
  );
  if (workspaceComparison !== 0) {
    return workspaceComparison;
  }

  if (left.relativePath !== right.relativePath) {
    return left.relativePath.localeCompare(right.relativePath);
  }

  return left.range.start.offset - right.range.start.offset;
}

function compareWorkspaceRoots(
  left: string | null,
  right: string | null,
  workspaceRoots?: readonly string[],
): number {
  if (left === right) {
    return 0;
  }

  const order = new Map(
    (workspaceRoots ?? []).map((workspaceRoot, index) => [workspaceRoot, index] as const),
  );

  const leftIndex = left ? order.get(left) : undefined;
  const rightIndex = right ? order.get(right) : undefined;

  if (leftIndex !== undefined || rightIndex !== undefined) {
    if (leftIndex === undefined) {
      return 1;
    }

    if (rightIndex === undefined) {
      return -1;
    }

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
  }

  return (left ?? "").localeCompare(right ?? "");
}
