import type { ActionCategories, MatchState, NoteExportStatus } from './types'
import { formatRawNotes } from './notes'
import { sanitizeSegment } from './filename'
import { checkFolderPermission, loadFolderHandle } from './folderHandleStore'

/**
 * Best-effort live export of the current match's notes to a markdown file
 * in the chosen export folder (Settings > Export folder). Called after
 * every ADD_NOTE. Rewrites the whole file each time rather than appending —
 * it's regenerated deterministically from match.notes, which is simpler
 * than reconciling partial appends and naturally picks up a mid-match
 * includeMinuteInNotes toggle on the very next note. Runs in the background
 * service worker (same origin as the popup that granted folder permission,
 * so the persisted handle is usable here without re-prompting) so it fires
 * regardless of whether the popup happens to be open.
 *
 * Never throws — a failed export shouldn't fail the note save itself, which
 * already succeeded in extension storage regardless of this.
 */
export async function exportNotesLive(
  match: MatchState,
  includeMinute: boolean,
  categories: ActionCategories,
): Promise<NoteExportStatus> {
  try {
    const handle = await loadFolderHandle()
    if (!handle) return { ok: false, detail: 'Not exported: no export folder set (Settings > Export folder).' }

    const permission = await checkFolderPermission(handle)
    if (permission !== 'granted') {
      return { ok: false, detail: 'Not exported: export folder needs permission re-granted (Settings).' }
    }

    const filename = `${sanitizeSegment(match.matchInfo) || 'Match'} - Notes.md`
    const fileHandle = await handle.getFileHandle(filename, { create: true })
    const writable = await fileHandle.createWritable()
    const body = formatRawNotes(match.notes, match.clips, match.players, includeMinute, categories)
    await writable.write(`# ${match.matchInfo || 'Match'}\n\n${body}\n`)
    await writable.close()
    return { ok: true, detail: `Exported to ${filename}` }
  } catch (err) {
    return { ok: false, detail: `Export failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
