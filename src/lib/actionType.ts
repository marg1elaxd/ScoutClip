/**
 * A clip's `actionType` is stored as `"<Category> <Subcategory>"` (see the
 * tag panel — `${tagCategory} ${sub}`), `null` meaning untagged. These pull
 * the two halves back apart; shared by folder-building (buildDownloadPath),
 * compilation ordering (sortClipsForCompilation), and the per-player action
 * tally (actionTally.ts) rather than each re-deriving it.
 */
export function categoryOf(actionType: string | null): 'Untagged' | 'Offensive' | 'Defensive' {
  if (actionType == null) return 'Untagged'
  return actionType.startsWith('Offensive') ? 'Offensive' : 'Defensive'
}

export function subcategoryOf(actionType: string | null): string {
  if (actionType == null) return 'Untagged'
  const spaceIdx = actionType.indexOf(' ')
  return spaceIdx === -1 ? actionType : actionType.slice(spaceIdx + 1)
}
