// Put the authenticated owner condition last so callers cannot override it.
export function ownerScopedQuery(ownerId, criteria = {}, ownerField = "ownerId") {
  return { ...criteria, [ownerField]: ownerId };
}
