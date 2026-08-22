import type { CaptureRegion, MatchState, RecordingSettings, RecordingStatus } from './types'

// ---- popup/background <-> background/offscreen message protocol ----
// Every message has a `type` discriminant so listeners can switch on it.

export type Message =
  | { type: 'GET_STATE' }
  // tabId is the active tab at Start Match time — becomes the match's
  // canonical "broadcast tab", which is how the on-page overlay (a static
  // content script on every page) decides whether to render itself on any
  // given tab. See OVERLAY_SHOULD_SHOW below.
  | { type: 'START_MATCH'; matchInfo: string; players: string[]; tabId?: number; gameSpeed: number }
  // Adds a player mid-match. The UI immediately follows this with
  // START_RECORDING for the same name — the point is always "clip this
  // person right now", so a separate select-then-record step would just be
  // friction.
  | { type: 'ADD_PLAYER'; playerName: string }
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
  | { type: 'CONFIRM_SAVE'; playerName: string; actionType: string | null }
  | { type: 'COMPILE_CLIPS'; clipIds: string[] }
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
}

export function sendMessage<T = unknown>(message: Message): Promise<T> {
  return chrome.runtime.sendMessage(message)
}
