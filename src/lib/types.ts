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
  /** Elapsed match time in ms at record time, kept alongside `minute` for mm:ss display precision (`minute` alone is whole-minute only, needed as-is for the filename). */
  timestampMs: number
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

/**
 * A quick text note taken live, independent of clips entirely — for
 * observations that don't warrant (or come before/after) an actual
 * recording. `playerName: null` means a general match note, not tied to
 * anyone specific. `timestampMs` (elapsed match time in ms) is always
 * recorded (cheap to store); whether it's actually *shown* anywhere is a
 * display preference (`RecordingSettings.includeMinuteInNotes`), not a
 * recording-time choice — so toggling that setting mid-match doesn't
 * retroactively lose data either way.
 */
export interface MatchNote {
  id: string
  playerName: string | null
  text: string
  timestampMs: number
  savedAt: number
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
  /** Scoped to the current match only, same as clips — reset on the next START_MATCH. */
  notes: MatchNote[]
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
  timestampMs: number
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
  /** Off by default — whether the match minute is shown alongside each note (in the Notes list and in "Copy raw notes"). Doesn't affect whether the minute is recorded, only whether it's displayed. */
  includeMinuteInNotes: boolean
}

export const DEFAULT_SETTINGS: RecordingSettings = {
  preRollEnabled: false,
  preRollSeconds: 5,
  postRollEnabled: false,
  postRollSeconds: 5,
  actionCategories: DEFAULT_ACTION_CATEGORIES,
  includeMinuteInNotes: false,
}

export const MIN_ROLL_SECONDS = 1
export const MAX_ROLL_SECONDS = 30

/**
 * Bitrate is fixed for the whole match so clips concatenate losslessly later.
 * mimeType is deliberately NOT fixed here — support for any given container
 * varies across Chrome/OS combos, so the offscreen document picks the best
 * type it actually supports at record time via
 * MediaRecorder.isTypeSupported() (see CANDIDATE_MIME_TYPES below) and
 * reports back what it used.
 */
export const RECORDING_PROFILE = {
  videoBitsPerSecond: 5_000_000,
} as const

/**
 * Preference order: WebM first, MP4 as a fallback if this Chrome/OS combo
 * doesn't support WebM recording at all (rare).
 *
 * Was MP4-first originally, on the reasoning that it's the more universally
 * playable format. Flipped after MP4's rigid container structure turned out
 * to be the direct cause of several real bugs specific to this app's
 * architecture (heavy segmented recording + lossless stream-copy
 * concatenation, over and over, for every pre-roll splice and every
 * compilation): Chrome's MP4 MediaRecorder only writes the trailing "moov"
 * atom (the container's sample/track index) once a recording is genuinely
 * finalized via `.stop()`, and MP4 muxing was also the one that surfaced
 * "Non-monotonous DTS" warnings when concatenating audio across segment
 * boundaries. WebM/Matroska has neither problem — it's designed to be
 * parseable as a stream from the start, with no trailing index requirement,
 * which is exactly the shape of file this app produces constantly.
 */
export const CANDIDATE_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
]
