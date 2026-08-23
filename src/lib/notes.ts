import type { MatchNote } from './types'

export const GENERAL_NOTE_LABEL = 'General'

/**
 * Formats a match's notes as flat, copy-paste-ready text — one line per
 * player (plus a "General" line for notes not tied to anyone), each a
 * semicolon-joined run of that player's notes in the order they were taken.
 * Deliberately not a bulleted/structured format: this is meant to be pasted
 * straight into a raw-notes tool (Obsidian) or an LLM prompt for further
 * processing, not read as a polished document on its own.
 *
 * `includeMinute`: whether to append each note's match minute — off by
 * default (RecordingSettings.includeMinuteInNotes), since minute is always
 * recorded regardless (see MatchNote) and this is purely a formatting
 * choice at the point of reading the notes back, not a recording-time one.
 */
export function formatRawNotes(notes: MatchNote[], playerOrder: string[], includeMinute: boolean): string {
  const formatNote = (n: MatchNote) => (includeMinute ? `${n.text} (${n.minute}′)` : n.text)

  const lines: string[] = []
  const general = notes.filter((n) => n.playerName === null)
  if (general.length > 0) {
    lines.push(`${GENERAL_NOTE_LABEL} - ${general.map(formatNote).join('; ')}`)
  }
  for (const player of playerOrder) {
    const playerNotes = notes.filter((n) => n.playerName === player)
    if (playerNotes.length === 0) continue
    lines.push(`${player} - ${playerNotes.map(formatNote).join('; ')}`)
  }
  return lines.join('\n')
}
