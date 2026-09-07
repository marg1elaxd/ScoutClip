import type { ActionCategories, SavedClip } from './types'
import { subcategoryOf } from './actionType'

/**
 * Formats a player's recorded-clip counts by subcategory — e.g.
 * "Pass ×35 · Shot ×2 · Ground Duel ×5" — for a quick "how much of what did
 * I actually get" glance alongside their notes. Ordered Untagged first (if
 * any), then each category's subcategories in the order they're defined in
 * Settings (matching the tag panel's own button order), skipping any with a
 * zero count. Returns '' if the player has no clips yet.
 */
export function formatPlayerTally(clips: SavedClip[], playerName: string, categories: ActionCategories): string {
  const counts = new Map<string, number>()
  for (const clip of clips) {
    if (clip.playerName !== playerName) continue
    const sub = subcategoryOf(clip.actionType)
    counts.set(sub, (counts.get(sub) ?? 0) + 1)
  }
  if (counts.size === 0) return ''

  const order = ['Untagged', ...categories.Offensive, ...categories.Defensive]
  const parts: string[] = []
  for (const sub of order) {
    const n = counts.get(sub)
    if (n) parts.push(`${sub} ×${n}`)
  }
  return parts.join(' · ')
}
