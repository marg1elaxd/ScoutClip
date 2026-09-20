import type { ActionCategories, SavedClip } from './types'
import { subcategoryOf } from './actionType'

/**
 * Formats a player's recorded-clip counts by subcategory — e.g.
 * "Pass ×35 (28✓ / 7✗) · Shot ×2 · Ground Duel ×5 (3✓)" — for a quick "how
 * much of what did I actually get" glance alongside their notes. The
 * bracket is each subcategory's successful/unsuccessful split, shown only
 * for whichever of the two has any clips marked (outcome is optional per
 * clip, so ×35 with just "(28✓)" means 28 marked successful and the rest
 * unmarked, not necessarily failed). Ordered Untagged first (if any), then
 * each category's subcategories in the order they're defined in Settings
 * (matching the tag panel's own button order), skipping any with a zero
 * count. Returns '' if the player has no clips yet.
 */
export function formatPlayerTally(clips: SavedClip[], playerName: string, categories: ActionCategories): string {
  const counts = new Map<string, { total: number; successful: number; unsuccessful: number }>()
  for (const clip of clips) {
    if (clip.playerName !== playerName) continue
    const sub = subcategoryOf(clip.actionType)
    const entry = counts.get(sub) ?? { total: 0, successful: 0, unsuccessful: 0 }
    entry.total++
    if (clip.outcome === 'successful') entry.successful++
    else if (clip.outcome === 'unsuccessful') entry.unsuccessful++
    counts.set(sub, entry)
  }
  if (counts.size === 0) return ''

  const order = ['Untagged', ...categories.Offensive, ...categories.Defensive]
  const parts: string[] = []
  for (const sub of order) {
    const entry = counts.get(sub)
    if (!entry) continue
    const split = [
      entry.successful > 0 ? `${entry.successful}✓` : null,
      entry.unsuccessful > 0 ? `${entry.unsuccessful}✗` : null,
    ].filter((x): x is string => x !== null)
    parts.push(`${sub} ×${entry.total}${split.length > 0 ? ` (${split.join(' / ')})` : ''}`)
  }
  return parts.join(' · ')
}
