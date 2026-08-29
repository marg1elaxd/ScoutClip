import type { CaptureRegion, MatchState, NoteExportStatus, RecordingSettings, RecordingStatus } from './types'

// ---- popup/background <-> background/offscreen message protocol ----
// Every message has a `type` discriminant so listeners can switch on it.

export type Message =
  | { type: 'GET_STATE' }
  // tabId is the active tab at Start Match time — becomes the match's
  // canonical "broadcast tab", which is how the on-page overlay (a static
  // content script on every page) decides whether to render itself on any
  // given tab. See OVERLAY_SHOULD_SHOW below.
  | { type: 'START_MATCH'; matchInfo: string; players: string[]; tabId?: number; gameSpeed: number }
  // Adds a player mid-match — just appends them to the roster (their chip
  // shows up, same as anyone from the original roster). Doesn't start
  // recording them; an earlier version did that automatically, but not
  // every mid-match add means "clip them right now."
  | { type: 'ADD_PLAYER'; playerName: string }
  // Bulk add — e.g. a pasted Obsidian-style roster (see lib/roster.ts).
  // Same dedup-against-existing-roster behavior as ADD_PLAYER, just N at once.
  | { type: 'ADD_PLAYERS'; playerNames: string[] }
  | { type: 'TOGGLE_CLOCK' }
  | { type: 'SET_CAPTURE_REGION'; region: CaptureRegion | null }
  | { type: 'SET_GAME_SPEED'; gameSpeed: number }
  | { type: 'SET_SETTINGS'; settings: RecordingSettings }
  // Only sent when pre-roll is enabled — arms continuous standby buffering
  // on the tab identified by streamId, obtained from a popup user gesture.
  | { type: 'ARM_PRE_ROLL'; streamId: string }
  // Some sites open the actual video in a different tab than the one the
  // scout started the match from — this pair re-points the broadcast tab.
  // Split in two because Chrome only allows one active tabCapture stream
  // per extension: PREPARE_TAB_SWITCH disarms the old tab's standby buffer
  // (if pre-roll is on) and must fully complete *before* the popup requests
  // a streamId for the new tab, or the request fails with "Cannot capture a
  // tab with an active stream" since the old one is technically still live.
  // RETARGET_BROADCAST_TAB then does the rest: re-points matchTabId, clears
  // captureRegion (its pixel coordinates are specific to the old tab's page
  // layout and meaningless on a different one), moves the overlay over via
  // OVERLAY_ACTIVATE/DEACTIVATE, and re-arms pre-roll with preRollStreamId
  // if it was on (obtained the same way as ARM_PRE_ROLL, after PREPARE_TAB_SWITCH).
  | { type: 'PREPARE_TAB_SWITCH' }
  | { type: 'RETARGET_BROADCAST_TAB'; tabId: number; preRollStreamId?: string }
  // Multiple players can each have their own clip in flight at once — every
  // recording action names which player it's for, and the background worker
  // tracks status per player rather than one global recording state.
  // streamId omitted when pre-roll is armed: recording is "promoted" from
  // the already-buffering standby stream instead of starting a fresh one —
  // also omitted (and ignored if sent) whenever the shared capture stream is
  // already open for another concurrently-recording player.
  | { type: 'START_RECORDING'; playerName: string; streamId?: string }
  | { type: 'STOP_RECORDING'; playerName: string }
  | { type: 'CONFIRM_SAVE'; playerName: string; actionType: string | null; starred: boolean }
  // Cancels a clip awaiting a tag without saving/downloading it at all —
  // for "clipped by mistake, don't want it lingering." Only valid while
  // that player's clip is actually pending a tag.
  | { type: 'DISCARD_CLIP'; playerName: string }
  // Removes a player from the active roster so their chip stops appearing
  // (and can't be clicked to start a new recording) — their already-saved
  // clips and files on disk are untouched, and stay in match.clips/the
  // Clips list so they can still be tagged/compiled/deleted individually.
  // Blocked while that player has anything in flight (recording, pending a
  // tag, saving), same as most other match-state-mutating actions.
  | { type: 'DELETE_PLAYER'; playerName: string }
  // Removes one clip from the in-match clip list (and the offscreen
  // document's IndexedDB cache, so it's no longer eligible for
  // compilation) — the already-downloaded file on disk is untouched,
  // exactly like DELETE_PLAYER: this only ever forgets what the extension
  // itself is tracking, never deletes anything from the filesystem.
  | { type: 'DELETE_CLIP'; clipId: string }
  // Compilation output always matches the source clips' own format (WebM
  // by default) — an MP4-export option was tried and reverted; see
  // "Compilation (Phase 4)" in the README for why.
  // order: 'tag' groups Untagged -> Offensive -> Defensive (chronological
  // within each group); 'number' is plain chronological. Starred clips are
  // always pulled to the front regardless of order, chronological among
  // themselves.
  | { type: 'COMPILE_CLIPS'; clipIds: string[]; order: 'tag' | 'number' }
  // A quick text note, independent of the clip/recording pipeline entirely
  // — playerName null means a general match note, not tied to anyone.
  | { type: 'ADD_NOTE'; playerName: string | null; text: string }
  // Reference-only lineup info (screenshots + free text) — see MatchLineup.
  | { type: 'SET_LINEUP_TEXT'; text: string }
  | { type: 'ADD_LINEUP_IMAGE'; imageDataUrl: string }
  | { type: 'REMOVE_LINEUP_IMAGE'; index: number }
  | { type: 'NEW_SESSION' }

export interface StateSnapshot {
  match: MatchState
  /** Keyed by player name; a player absent from this map is idle. */
  playerRecordingStatus: Record<string, RecordingStatus>
  currentMinute: number
  lastSavedPath: string | null
  lastCompilationPath: string | null
  /** Region picked before a match exists to attach it to — see regionPicker.ts. */
  draftCaptureRegion: CaptureRegion | null
  settings: RecordingSettings
  /** Whether pre-roll standby buffering is currently active — for the UI, and to catch a failed/missed arm. */
  preRollArmed: boolean
  /** Result of the most recent live note-export attempt (see lib/noteExport.ts), null before any note has been saved this session. */
  lastNoteExportStatus: NoteExportStatus | null
}

export function sendMessage<T = unknown>(message: Message): Promise<T> {
  return chrome.runtime.sendMessage(message)
}
