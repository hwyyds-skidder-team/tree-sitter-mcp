const DEPENDENCY_QUERY_TYPES = ["dependency_analysis"] as const;

export function listDependencyQueryTypes(): string[] {
  return [...DEPENDENCY_QUERY_TYPES];
}
