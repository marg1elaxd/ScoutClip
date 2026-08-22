/**
 * Selected crop rectangle as a **fraction (0–1) of the tab's rendered
 * viewport**, not absolute pixels. Converted to real pixel coordinates at
 * crop time using the tabCapture video track's own reported dimensions
 * (`MediaStreamTrack.getSettings()`), not derived from the page's own
 * `window.innerWidth/innerHeight * devicePixelRatio` the way an earlier
 * version did — there's no guarantee tabCapture's delivered frame
 * resolution exactly equals that.
 *
 * It very much doesn't, in fact: measured live, a 1912×948 page was
 * captured into a fixed 1920×1080 frame — a different aspect ratio
 * entirely, meaning tabCapture fits the page into that frame
 * ("contain"-style scaling) and pads whichever axis doesn't fill it, rather
 * than capturing 1:1 at the page's own resolution. `viewportWidth`/
 * `viewportHeight` (the page's own dimensions at selection time) are kept
 * alongside the ratios so `cropStreamToRegion` in offscreen.ts can work out
 * where those padding bars actually are and map the ratio onto the real
 * content rectangle inside the frame, not the frame's outer edges.
 */
export interface CaptureRegion {
  xRatio: number
  yRatio: number
  widthRatio: number
  heightRatio: number
  viewportWidth: number
  viewportHeight: number
}

/** A clip that has actually finished saving to disk, for the in-match clip list. */
export interface SavedClip {
  playerName: string
  actionType: string | null
  matchInfo: string
  minute: number
  /** This player's Nth clip in the match (1-based) — also baked into the filename so same-minute clips don't collide. */
  clipNumber: number
  filename: string
  path: string
  extension: string
  savedAt: number
  downloadId: number
  /** Key into the offscreen document's IndexedDB clip store — chrome.downloads can't read a saved file back, so compiling later needs this to re-fetch the clip's actual bytes. */
  clipId: string
}

export interface MatchState {
  matchInfo: string
  players: string[]
  clockRunning: boolean
  /** ms elapsed accumulated across previous run segments (excludes the current running segment) */
  elapsedMs: number
  /** timestamp (Date.now()) the clock was last (re)started, null when paused/stopped */
  runningSinceMs: number | null
  matchActive: boolean
  /** null means record the full tab. */
  captureRegion: CaptureRegion | null
  /** How fast the broadcast is being watched (e.g. 2 = 2x) — saved clips get slowed back down by this factor so they play at real match speed. 1 = no correction. */
  gameSpeed: number
  /** Scoped to the current match only — reset on the next START_MATCH. */
  clips: SavedClip[]
}

/** Common playback-speed increments a broadcast is likely to be watched at. */
export const GAME_SPEED_OPTIONS = [1, 1.25, 1.5, 1.75, 2]

/**
 * Per-player, not global — multiple players can be at different points of
 * this at once (see StateSnapshot.playerRecordingStatus in messages.ts).
 * 'stopping' = post-roll delay running after that player's Stop was clicked,
 * before their clip is final.
 */
export type RecordingStatus = 'idle' | 'recording' | 'stopping' | 'pending-tag' | 'saving'

export interface PendingClip {
  playerName: string
  matchInfo: string
  minute: number
}

export type ActionCategoryName = 'Offensive' | 'Defensive'
export type ActionCategories = Record<ActionCategoryName, string[]>

/** Shipped defaults, and what "Reset to defaults" in Settings restores. */
export const DEFAULT_ACTION_CATEGORIES: ActionCategories = {
  Offensive: ['Pass', 'Key Pass', 'Dribble', 'Shot', 'Goal', 'Assist', 'Off-ball Movement'],
  Defensive: ['Interception', 'Tackle', 'Ground Duel', 'Aerial Duel', 'Clearance', 'Block', 'Pressing'],
}

/** Per-user preference, not match-scoped — persisted in chrome.storage.local, survives across matches. */
export interface RecordingSettings {
  preRollEnabled: boolean
  preRollSeconds: number
  postRollEnabled: boolean
  postRollSeconds: number
  /** The two top-level categories (Offensive/Defensive) are fixed; their subcategory lists are user-editable — see Settings. */
  actionCategories: ActionCategories
}

export const DEFAULT_SETTINGS: RecordingSettings = {
  preRollEnabled: false,
  preRollSeconds: 5,
  postRollEnabled: false,
  postRollSeconds: 5,
  actionCategories: DEFAULT_ACTION_CATEGORIES,
}

export const MIN_ROLL_SECONDS = 1
export const MAX_ROLL_SECONDS = 30

/**
 * Bitrate is fixed for the whole match so clips concatenate losslessly later.
 * mimeType is deliberately NOT fixed here — MP4 (H.264/AAC) MediaRecorder
 * support is inconsistent across Chrome/OS combos, so the offscreen document
 * picks the best type it actually supports at record time via
 * MediaRecorder.isTypeSupported() and reports back what it used.
 */
export const RECORDING_PROFILE = {
  videoBitsPerSecond: 5_000_000,
} as const

/** Preference order: real MP4 if this Chrome/OS combo supports it, else WebM. */
export const CANDIDATE_MIME_TYPES = [
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
]
