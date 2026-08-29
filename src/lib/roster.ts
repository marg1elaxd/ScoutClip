/**
 * Parses a roster pasted straight out of Obsidian, in the shape scouts
 * commonly keep it there — one line per player, jersey number then a
 * `[[Full Name, Birth Year]]` wikilink, e.g.:
 *
 *   LEK:
 *   8 - [[Yolande Mylene Zoua, 2010]] -
 *   10 - [[Ange Anastasie Tazanou, 2010]] -
 *
 * Team-header lines (like "LEK:") and blank lines don't match the player
 * pattern and are silently skipped — no need to special-case them. Each
 * matching line becomes a "<number> <last name> <birth year>" label (e.g.
 * "8 Zoua 2010"): last name only (the final whitespace-separated token of
 * the full name) plus the number and year, since that's what's actually
 * useful to glance at on a chip during a match — not the full name, which
 * this format doesn't otherwise use anywhere.
 */
const PLAYER_LINE = /^\s*(\d+)\s*-\s*\[\[\s*([^,\]]+?)\s*,\s*(\d{4})\s*\]\]/

export function parseRosterPaste(text: string): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = PLAYER_LINE.exec(line)
    if (!match) continue
    const [, number, fullName, year] = match
    const lastName = fullName.trim().split(/\s+/).pop()
    if (!lastName) continue
    const label = `${number} ${lastName} ${year}`
    if (seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels
}
