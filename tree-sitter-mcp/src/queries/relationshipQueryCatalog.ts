const RELATIONSHIP_QUERY_TYPES = ["relationship_view"] as const;

export function listRelationshipQueryTypes(): string[] {
  return [...RELATIONSHIP_QUERY_TYPES];
}
