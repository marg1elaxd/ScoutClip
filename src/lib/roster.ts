/**
 * Parses a roster pasted straight out of Obsidian, in the shape scouts
 * commonly keep it there — one line per player, jersey number then a
 * `[[Full Name, Birth Year]]` wikilink, grouped under a team-name header:
 *
 *   LEK:
 *   8 - [[Yolande Mylene Zoua, 2010]] -
 *   10 - [[Ange Anastasie Tazanou, 2010]] -
 *
 *   DEA:
 *   18 - [[Paule Oceyane Nse Mvome, 2005]] -
 *
 * Blank lines don't match either pattern and are silently skipped. Each
 * matching player line becomes a "<number> <last name> <birth year>" label
 * (e.g. "8 Zoua 2010") — last name only (the final whitespace-separated
 * token of the full name) plus the number and year, since that's what's
 * actually useful to glance at on a chip during a match — not the full
 * name, which this format doesn't otherwise use anywhere. A team-header
 * line (anything else ending in a bare `:`) sets which team subsequent
 * player lines are tagged with, until the next header.
 */
const PLAYER_LINE = /^\s*(\d+)\s*-\s*\[\[\s*([^,\]]+?)\s*,\s*(\d{4})\s*\]\]/
const TEAM_HEADER = /^\s*([^:]+):\s*$/

export interface ParsedRosterEntry {
  label: string
  team: string | null
}

export function parseRosterPaste(text: string): ParsedRosterEntry[] {
  const seen = new Set<string>()
  const entries: ParsedRosterEntry[] = []
  let currentTeam: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const playerMatch = PLAYER_LINE.exec(line)
    if (playerMatch) {
      const [, number, fullName, year] = playerMatch
      const lastName = fullName.trim().split(/\s+/).pop()
      if (!lastName) continue
      const label = `${number} ${lastName} ${year}`
      if (seen.has(label)) continue
      seen.add(label)
      entries.push({ label, team: currentTeam })
      continue
    }
    const headerMatch = TEAM_HEADER.exec(line)
    if (headerMatch) currentTeam = headerMatch[1].trim()
  }
  return entries
}
