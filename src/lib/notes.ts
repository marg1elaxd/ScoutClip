import type { ActionCategories, MatchNote, SavedClip } from './types'
import { formatMmSs } from './time'
import { formatPlayerTally } from './actionTally'

export const GENERAL_NOTE_LABEL = 'General'

/**
 * The current roster, followed by anyone else who still has notes or clips
 * (first-seen order) — i.e. a player deleted from the roster after the fact.
 * Deleting a player only removes their chip; their saved notes and clips
 * stay, and this is what keeps them from silently vanishing from the Notes
 * view and the raw-notes export, both of which used to loop over the roster
 * alone.
 */
export function playersWithNotesOrClips(roster: string[], notes: MatchNote[], clips: SavedClip[]): string[] {
  const players = [...roster]
  const seen = new Set(players)
  for (const name of [...notes.map((n) => n.playerName), ...clips.map((c) => c.playerName)]) {
    if (name != null && !seen.has(name)) {
      seen.add(name)
      players.push(name)
    }
  }
  return players
}

/**
 * Formats a match's notes as flat, copy-paste-ready text — one line per
 * player (plus a "General" line for notes not tied to anyone), each a
 * semicolon-joined run of that player's notes in the order they were taken,
 * followed by their recorded-clip tally if they have one (e.g. "Pass ×35 ·
 * Shot ×2"), separated by " | ". A player with a tally but no written notes
 * still gets a line (just the tally) — the count alone is useful even
 * without commentary. Deliberately not a bulleted/structured format: this
 * is meant to be pasted straight into a raw-notes tool (Obsidian) or an LLM
 * prompt for further processing, not read as a polished document on its own.
 *
 * `includeMinute`: whether to append each note's match time (mm:ss) — off by
 * default (RecordingSettings.includeMinuteInNotes), since the timestamp is
 * always recorded regardless (see MatchNote) and this is purely a formatting
 * choice at the point of reading the notes back, not a recording-time one.
 */
export function formatRawNotes(
  notes: MatchNote[],
  clips: SavedClip[],
  playerOrder: string[],
  includeMinute: boolean,
  categories: ActionCategories,
): string {
  const formatNote = (n: MatchNote) => (includeMinute ? `${n.text} (${formatMmSs(n.timestampMs)})` : n.text)

  const lines: string[] = []
  const general = notes.filter((n) => n.playerName === null)
  if (general.length > 0) {
    lines.push(`${GENERAL_NOTE_LABEL} - ${general.map(formatNote).join('; ')}`)
  }
  for (const player of playerOrder) {
    const playerNotes = notes.filter((n) => n.playerName === player)
    const notesPart = playerNotes.length > 0 ? playerNotes.map(formatNote).join('; ') : null
    const tally = formatPlayerTally(clips, player, categories) || null
    if (notesPart === null && tally === null) continue
    const body = [notesPart, tally].filter((x): x is string => x !== null).join(' | ')
    lines.push(`${player} - ${body}`)
  }
  return lines.join('\n')
}
