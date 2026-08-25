import type {
  CaptureRegion,
  MatchState,
  MatchNote,
  NoteExportStatus,
  RecordingSettings,
  RecordingStatus,
  PendingClip,
  SavedClip,
} from '../lib/types'
import { exportNotesLive } from '../lib/noteExport'
import { DEFAULT_SETTINGS, MAX_LINEUP_IMAGES, RECORDING_PROFILE } from '../lib/types'
import {
  buildClipFilename,
  buildCompilationFilename,
  buildCompilationPath,
  buildDownloadPath,
  extensionForMimeType,
} from '../lib/filename'
import type { Message, StateSnapshot } from '../lib/messages'
import { patchVisibilityAsAlwaysActive } from '../lib/visibilityPatch'

const OFFSCREEN_URL = 'src/offscreen/offscreen.html'

/** Best-effort — some sites freeze the relevant properties defensively, or the tab may not allow script injection (chrome:// pages etc.); either way, not fatal to recording. */
async function keepTabVisible(tabId: number) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: patchVisibilityAsAlwaysActive,
    })
  } catch (err) {
    console.error('[background] failed to patch tab visibility (non-fatal)', err)
  }
}

function defaultMatch(): MatchState {
  return {
    matchInfo: '',
    players: [],
    clockRunning: false,
    elapsedMs: 0,
    runningSinceMs: null,
    matchActive: false,
    captureRegion: null,
    gameSpeed: 1,
    clips: [],
    notes: [],
    lineup: { text: '', imageDataUrls: [] },
  }
}

let match: MatchState = defaultMatch()
// Keyed by player name — multiple players can be at different points of the
// record/tag/save flow at once, so this replaced a single global status.
// A player absent from this map (or explicitly 'idle') is not recording.
let playerRecordingStatus: Record<string, RecordingStatus> = {}
let lastSavedPath: string | null = null
let lastCompilationPath: string | null = null
let lastNoteExportStatus: NoteExportStatus | null = null
// Keyed by player name, same reasoning as playerRecordingStatus.
let pendingClips: Record<string, PendingClip> = {}
// Staged region selected before a match exists to attach it to (the picker
// is triggered from the Setup screen, before START_MATCH). Popup-local React
// state can't hold this either — the popup necessarily closes the instant
// the scout clicks into the broadcast tab to drag the selection box, so this
// has to live somewhere that survives that, same reasoning as playerRecordingStatus.
let draftCaptureRegion: CaptureRegion | null = null
// Per-user preference, not match-scoped — persisted separately in
// chrome.storage.local (survives across matches/browser restarts, unlike
// the session-scoped state above which is meant to reset with each match).
let settings: RecordingSettings = DEFAULT_SETTINGS
// Whether the offscreen document currently has pre-roll standby buffering
// running. Mirrors offscreen's own internal flag; kept here too so
// START_RECORDING can decide promote-vs-fresh-start without asking it.
let standbyArmed = false
// The active tab at Start Match time — the match's canonical "broadcast
// tab". Used only to gate the on-page overlay content script (a static
// script on every page — see src/content/overlay.tsx) so it renders on that
// one tab rather than every open tab while a match is running.
let matchTabId: number | null = null
let hydrated = false

// Persisting playerRecordingStatus/pendingClips (not just match) matters:
// this MV3 service worker can be evicted and restarted by Chrome at any
// time. Without this, a restart while a clip was awaiting a tag would reset
// that player's status to 'idle' even though the offscreen document still
// held that clip's bytes in memory — the popup would show an idle chip with
// no sign the old clip existed, and it would be silently lost the next time
// a recording started for that player. See also the belt-and-suspenders
// check in START_RECORDING.
async function ensureHydrated() {
  if (hydrated) return
  hydrated = true
  const [stored, storedLocal] = await Promise.all([
    chrome.storage.session.get([
      'match',
      'playerRecordingStatus',
      'pendingClips',
      'lastSavedPath',
      'lastCompilationPath',
      'lastNoteExportStatus',
      'draftCaptureRegion',
      'standbyArmed',
      'matchTabId',
    ]),
    chrome.storage.local.get('settings'),
  ])
  if (stored.match) match = stored.match as MatchState
  if (stored.playerRecordingStatus) playerRecordingStatus = stored.playerRecordingStatus as Record<string, RecordingStatus>
  if (stored.pendingClips) pendingClips = stored.pendingClips as Record<string, PendingClip>
  if (stored.lastSavedPath !== undefined) lastSavedPath = stored.lastSavedPath as string | null
  if (stored.lastCompilationPath !== undefined) lastCompilationPath = stored.lastCompilationPath as string | null
  if (stored.lastNoteExportStatus !== undefined) lastNoteExportStatus = stored.lastNoteExportStatus as NoteExportStatus | null
  if (stored.draftCaptureRegion !== undefined) draftCaptureRegion = stored.draftCaptureRegion as CaptureRegion | null
  if (stored.standbyArmed !== undefined) standbyArmed = Boolean(stored.standbyArmed)
  if (stored.matchTabId !== undefined) matchTabId = stored.matchTabId as number | null
  if (storedLocal.settings) settings = { ...DEFAULT_SETTINGS, ...(storedLocal.settings as RecordingSettings) }
}

function persist() {
  chrome.storage.session.set({
    match,
    playerRecordingStatus,
    pendingClips,
    lastSavedPath,
    lastCompilationPath,
    lastNoteExportStatus,
    draftCaptureRegion,
    standbyArmed,
    matchTabId,
  })
}

/** Whether any player currently has a recording in flight (not idle, not merely awaiting a tag) — gates operations that need the shared capture stream to stand still, like switching the broadcast tab. */
function anyPlayerBusy(): boolean {
  return Object.values(playerRecordingStatus).some((s) => s === 'recording' || s === 'stopping' || s === 'saving')
}

function currentElapsedMs(): number {
  const runningExtra = match.runningSinceMs != null ? Date.now() - match.runningSinceMs : 0
  return match.elapsedMs + runningExtra
}

function currentMinute(): number {
  return Math.floor(currentElapsedMs() / 60000)
}

/** Untagged first (per the scout's b-roll-style workflow), then Offensive, then Defensive. actionType is stored as "<Category> <Subcategory>" (see the tag panel), so the category is just its leading word. */
function clipCategoryRank(actionType: string | null): number {
  if (actionType == null) return 0
  if (actionType.startsWith('Offensive')) return 1
  return 2
}

/**
 * Orders clips for a compilation export. Starred (highlight) clips always
 * lead, chronological among themselves, regardless of `order` — the whole
 * point of starring is "put this first." The rest follow either plain
 * chronological ('number') or grouped by category ('tag'), chronological
 * within each group.
 */
function sortClipsForCompilation(clips: SavedClip[], order: 'tag' | 'number'): SavedClip[] {
  const starred = clips.filter((c) => c.starred).sort((a, b) => a.timestampMs - b.timestampMs)
  const rest = clips.filter((c) => !c.starred)
  rest.sort((a, b) => {
    if (order === 'tag') {
      const rankDiff = clipCategoryRank(a.actionType) - clipCategoryRank(b.actionType)
      if (rankDiff !== 0) return rankDiff
    }
    return a.timestampMs - b.timestampMs
  })
  return [...starred, ...rest]
}

function snapshot(): StateSnapshot {
  return {
    match,
    playerRecordingStatus,
    currentMinute: currentMinute(),
    lastSavedPath,
    lastCompilationPath,
    lastNoteExportStatus,
    draftCaptureRegion,
    settings,
    preRollArmed: standbyArmed,
  }
}

/**
 * chrome.runtime.sendMessage resolves even when the receiver caught an error
 * and replied with `{ error }` — it does not reject. Without this check a
 * failed offscreen operation (e.g. chrome.downloads.download rejecting) was
 * being reported back to the popup as a success.
 */
async function sendToOffscreen<T = unknown>(message: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as (T & { error?: string }) | undefined
  if (response && typeof response === 'object' && 'error' in response && response.error) {
    console.error('[background] offscreen error for', message.type, response.error)
    throw new Error(response.error)
  }
  return response as T
}

function scheduleRevoke(downloadId: number, url: string) {
  let done = false
  const revoke = () => {
    if (done) return
    done = true
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_REVOKE', url }).catch(() => {})
    chrome.downloads.onChanged.removeListener(onChanged)
  }
  const onChanged = (delta: chrome.downloads.DownloadDelta) => {
    if (delta.id === downloadId && delta.state && delta.state.current !== 'in_progress') revoke()
  }
  chrome.downloads.onChanged.addListener(onChanged)
  // Fallback in case onChanged never reports completion for some reason.
  setTimeout(revoke, 120_000)
}

/**
 * Retrieves the offscreen document's currently held clip and downloads it.
 * Shared by the normal tag-and-save flow and by the orphaned-clip safety net
 * in START_RECORDING, so a clip is never silently dropped either way.
 */
async function finalizePendingClip(clip: PendingClip, actionType: string | null, starred: boolean): Promise<void> {
  let clipUrl: string | null = null
  try {
    // Neither context has everything: chrome.downloads is unavailable in
    // the offscreen document, and URL.createObjectURL is unavailable in
    // this service worker. So the offscreen document creates the blob
    // URL (it has full DOM) and hands over just the string; this worker
    // (which does have chrome.downloads, incl. its subfolder support)
    // downloads directly from that URL.
    const { url, mimeType, clipId } = await sendToOffscreen<{ url: string; mimeType: string; clipId: string }>({
      type: 'OFFSCREEN_GET_CLIP',
      sessionId: clip.playerName,
    })
    clipUrl = url
    // Per-player, not global — two different players recording in the same
    // minute land in different folders anyway and don't collide; this only
    // needs to disambiguate the same player's clips from each other.
    const clipNumber = match.clips.filter((c) => c.playerName === clip.playerName).length + 1
    const extension = extensionForMimeType(mimeType)
    const filename = buildClipFilename({
      playerName: clip.playerName,
      actionType,
      matchInfo: clip.matchInfo,
      minute: clip.minute,
      clipNumber,
      extension,
      starred,
    })
    const path = buildDownloadPath({ matchInfo: clip.matchInfo, playerName: clip.playerName, filename })

    const downloadId = await chrome.downloads.download({ url, filename: path, saveAs: false })
    console.log('[background] download queued', { downloadId, path, mimeType })
    scheduleRevoke(downloadId, url)
    lastSavedPath = path
    match = {
      ...match,
      clips: [
        ...match.clips,
        {
          playerName: clip.playerName,
          actionType,
          matchInfo: clip.matchInfo,
          minute: clip.minute,
          timestampMs: clip.timestampMs,
          clipNumber,
          starred,
          filename,
          path,
          extension,
          savedAt: Date.now(),
          downloadId,
          clipId,
        },
      ],
    }
  } catch (err) {
    if (clipUrl) chrome.runtime.sendMessage({ type: 'OFFSCREEN_REVOKE', url: clipUrl }).catch(() => {})
    throw err
  }
}

function resolveStreamIdForTab(tabId: number | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!tabId) {
      reject(new Error('No target tab to capture.'))
      return
    }
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message || 'Failed to get capture stream.'))
        return
      }
      resolve(id)
    })
  })
}

async function ensureOffscreenDocument() {
  const has = await (chrome.offscreen as any).hasDocument?.()
  if (has) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA' as chrome.offscreen.Reason, 'AUDIO_PLAYBACK' as chrome.offscreen.Reason],
    justification: 'Records the active broadcast tab via tabCapture and plays its audio back so the scout keeps hearing the match.',
  })
}

async function handle(message: Message, sender?: chrome.runtime.MessageSender): Promise<StateSnapshot> {
  await ensureHydrated()

  switch (message.type) {
    case 'GET_STATE':
      return snapshot()

    case 'START_MATCH':
      match = {
        ...defaultMatch(),
        matchInfo: message.matchInfo,
        players: message.players,
        matchActive: true,
        captureRegion: draftCaptureRegion,
        gameSpeed: message.gameSpeed || 1,
      }
      playerRecordingStatus = {}
      pendingClips = {}
      matchTabId = message.tabId ?? null
      draftCaptureRegion = null
      persist()
      // Pushes activation directly to the overlay content script already
      // sitting dormant on that tab (it only self-checks once, at its own
      // page-load time) — without this, the overlay wouldn't appear until
      // the scout manually refreshed the broadcast tab.
      if (matchTabId != null) {
        chrome.tabs.sendMessage(matchTabId, { type: 'OVERLAY_ACTIVATE' }).catch(() => {})
        keepTabVisible(matchTabId)
      }
      return snapshot()

    case 'ADD_PLAYER': {
      const name = message.playerName.trim()
      if (!name) throw new Error('Player name cannot be empty.')
      const players = match.players.includes(name) ? match.players : [...match.players, name]
      match = { ...match, players }
      persist()
      return snapshot()
    }

    case 'SET_CAPTURE_REGION':
      // Sent directly by the injected picker overlay (not the popup — see
      // regionPicker.ts), so it can arrive whether or not a match is active
      // yet and whether or not the popup that triggered it is still open.
      if (match.matchActive) {
        match = { ...match, captureRegion: message.region }
      } else {
        draftCaptureRegion = message.region
      }
      persist()
      return snapshot()

    case 'SET_GAME_SPEED':
      match = { ...match, gameSpeed: message.gameSpeed || 1 }
      persist()
      return snapshot()

    case 'SET_SETTINGS': {
      const wasPreRollEnabled = settings.preRollEnabled
      settings = message.settings
      await chrome.storage.local.set({ settings })
      // Arming only happens at Start Match (needs a fresh streamId from a
      // user gesture), but disarming needs no streamId — do it immediately
      // rather than leaving a standby tabCapture stream open on the tab
      // with nothing tracking it anymore. Left unfixed, that orphaned
      // stream makes Chrome refuse the *next* capture attempt on that tab
      // ("Cannot capture a tab with an active stream"), since
      // ensureStreamReady's `if (stream) return` guard treats the leftover
      // stream as still valid to reuse.
      if (wasPreRollEnabled && !settings.preRollEnabled && standbyArmed) {
        try {
          await sendToOffscreen({ type: 'OFFSCREEN_DISARM_STANDBY' })
        } catch (err) {
          console.error('[background] failed to disarm pre-roll standby after disabling it in Settings', err)
        }
        standbyArmed = false
        persist()
      }
      return snapshot()
    }

    case 'ARM_PRE_ROLL': {
      if (!match.matchActive) throw new Error('Start a match before arming pre-roll.')
      await ensureOffscreenDocument()
      // Rotation cadence is fixed inside the offscreen document itself,
      // decoupled from the configured pre-roll length — see
      // STANDBY_ROTATION_SECONDS in offscreen.ts for why.
      await sendToOffscreen({
        type: 'OFFSCREEN_ARM_STANDBY',
        streamId: message.streamId,
        region: match.captureRegion,
        videoBitsPerSecond: RECORDING_PROFILE.videoBitsPerSecond,
      })
      standbyArmed = true
      persist()
      return snapshot()
    }

    case 'PREPARE_TAB_SWITCH': {
      if (!match.matchActive) throw new Error('No match is running.')
      if (anyPlayerBusy()) {
        throw new Error('Stop all current recordings before switching tabs.')
      }
      // Must fully complete before the popup requests a streamId for the
      // new tab — Chrome only allows one active tabCapture stream per
      // extension, so the old one has to actually be released first, not
      // just marked as going away.
      if (standbyArmed) {
        try {
          await sendToOffscreen({ type: 'OFFSCREEN_DISARM_STANDBY' })
        } catch (err) {
          console.error('[background] failed to disarm pre-roll standby before retargeting', err)
        }
        standbyArmed = false
        persist()
      }
      return snapshot()
    }

    case 'RETARGET_BROADCAST_TAB': {
      if (!match.matchActive) throw new Error('No match is running.')
      if (anyPlayerBusy()) {
        throw new Error('Stop all current recordings before switching tabs.')
      }
      const oldTabId = matchTabId

      // Safety net in case PREPARE_TAB_SWITCH was skipped somehow — a no-op
      // if already disarmed.
      if (standbyArmed) {
        try {
          await sendToOffscreen({ type: 'OFFSCREEN_DISARM_STANDBY' })
        } catch (err) {
          console.error('[background] failed to disarm pre-roll standby before retargeting', err)
        }
        standbyArmed = false
      }

      matchTabId = message.tabId
      // A capture region's pixel coordinates are specific to the old tab's
      // page layout and are almost certainly meaningless on a different
      // page — clear it rather than silently cropping to the wrong spot.
      match = { ...match, captureRegion: null }
      persist()

      if (oldTabId != null && oldTabId !== matchTabId) {
        chrome.tabs.sendMessage(oldTabId, { type: 'OVERLAY_DEACTIVATE' }).catch(() => {})
      }
      chrome.tabs.sendMessage(matchTabId, { type: 'OVERLAY_ACTIVATE' }).catch(() => {})
      keepTabVisible(matchTabId)

      if (settings.preRollEnabled && message.preRollStreamId) {
        await ensureOffscreenDocument()
        try {
          await sendToOffscreen({
            type: 'OFFSCREEN_ARM_STANDBY',
            streamId: message.preRollStreamId,
            region: null,
            videoBitsPerSecond: RECORDING_PROFILE.videoBitsPerSecond,
          })
          standbyArmed = true
        } catch (err) {
          console.error('[background] failed to re-arm pre-roll on the new tab', err)
        }
        persist()
      }
      return snapshot()
    }

    case 'TOGGLE_CLOCK':
      if (match.clockRunning) {
        const runningExtra = match.runningSinceMs != null ? Date.now() - match.runningSinceMs : 0
        match = { ...match, clockRunning: false, elapsedMs: match.elapsedMs + runningExtra, runningSinceMs: null }
      } else {
        match = { ...match, clockRunning: true, runningSinceMs: Date.now() }
      }
      persist()
      return snapshot()

    case 'START_RECORDING': {
      const playerName = message.playerName
      if (!match.players.includes(playerName)) throw new Error('Unknown player.')
      if ((playerRecordingStatus[playerName] ?? 'idle') !== 'idle') {
        throw new Error(`${playerName} is already recording or awaiting a tag.`)
      }
      if (settings.preRollEnabled && !standbyArmed) {
        throw new Error('Pre-roll is enabled but not armed yet — check Settings, or start a new match to re-arm it.')
      }

      // Normally unreachable through the UI (a player's chip is disabled
      // while their clip is pending a tag), but this state worker can be
      // evicted/restarted mid-flow, or the offscreen document reloaded —
      // don't let an old clip silently vanish under a new recording.
      if (pendingClips[playerName]) {
        console.warn('[background] starting a new recording with an unresolved pending clip — auto-saving it as Untagged')
        const orphan = pendingClips[playerName]
        try {
          await finalizePendingClip(orphan, null, false)
        } catch (err) {
          console.error('[background] could not recover orphaned pending clip', err)
        }
        delete pendingClips[playerName]
      }

      pendingClips[playerName] = {
        playerName,
        matchInfo: match.matchInfo,
        minute: currentMinute(),
        timestampMs: currentElapsedMs(),
      }
      await ensureOffscreenDocument()
      playerRecordingStatus = { ...playerRecordingStatus, [playerName]: 'recording' }
      persist()
      try {
        // Pre-roll needs no streamId — the shared capture stream is already
        // open from arming, and this just starts an independent recorder on
        // it (see startSession in offscreen.ts). Without pre-roll, a
        // streamId is fetched, but it's ignored by the offscreen document if
        // the stream's already open for another concurrently-recording
        // player — only the very first recorder of the match (or since the
        // stream was last torn down) actually needs it.
        const usePreRoll = settings.preRollEnabled && standbyArmed
        let streamId: string | undefined
        if (!usePreRoll) {
          // The popup fetches this itself (a genuine click-handler user
          // gesture). Content scripts can't call chrome.tabCapture at all,
          // so the on-page overlay omits streamId and this resolves it here
          // instead, using the sender's own tab — sender.tab is only
          // populated for messages from a tab-associated context (content
          // scripts), never for popup messages, so this path is naturally
          // unreachable for popup-originated calls.
          streamId = message.streamId ?? (await resolveStreamIdForTab(sender?.tab?.id))
        }
        await sendToOffscreen({
          type: 'OFFSCREEN_START',
          sessionId: playerName,
          streamId,
          videoBitsPerSecond: RECORDING_PROFILE.videoBitsPerSecond,
          region: match.captureRegion,
          preRollSeconds: usePreRoll ? settings.preRollSeconds : 0,
        })
      } catch (err) {
        playerRecordingStatus = { ...playerRecordingStatus, [playerName]: 'idle' }
        delete pendingClips[playerName]
        persist()
        throw err
      }
      return snapshot()
    }

    case 'STOP_RECORDING': {
      const playerName = message.playerName
      if (playerRecordingStatus[playerName] !== 'recording') {
        throw new Error(`${playerName} is not currently recording.`)
      }
      const postRollMs = settings.postRollEnabled ? settings.postRollSeconds * 1000 : 0
      playerRecordingStatus = { ...playerRecordingStatus, [playerName]: 'stopping' }
      persist()
      try {
        await sendToOffscreen({ type: 'OFFSCREEN_STOP', sessionId: playerName, postRollMs, gameSpeed: match.gameSpeed })
      } catch (err) {
        playerRecordingStatus = { ...playerRecordingStatus, [playerName]: 'idle' }
        delete pendingClips[playerName]
        persist()
        throw err
      }
      playerRecordingStatus = { ...playerRecordingStatus, [playerName]: 'pending-tag' }
      persist()
      return snapshot()
    }

    case 'CONFIRM_SAVE': {
      const playerName = message.playerName
      const clip = pendingClips[playerName]
      if (!clip) throw new Error('No clip pending save for this player.')
      playerRecordingStatus = { ...playerRecordingStatus, [playerName]: 'saving' }
      persist()
      try {
        await finalizePendingClip(clip, message.actionType, message.starred)
      } catch (err) {
        console.error('[background] save failed', err)
        playerRecordingStatus = { ...playerRecordingStatus, [playerName]: 'pending-tag' }
        persist()
        throw err
      }
      playerRecordingStatus = { ...playerRecordingStatus, [playerName]: 'idle' }
      delete pendingClips[playerName]
      persist()
      return snapshot()
    }

    case 'DISCARD_CLIP': {
      const playerName = message.playerName
      const clip = pendingClips[playerName]
      if (!clip) throw new Error('No clip pending for this player.')
      try {
        await sendToOffscreen({ type: 'OFFSCREEN_DISCARD_CLIP', sessionId: playerName })
      } catch (err) {
        // Non-fatal — worst case the offscreen document holds onto a blob
        // it'll never be asked for again until the match ends and the whole
        // clip cache clears anyway. Not worth blocking the discard over.
        console.error('[background] failed to discard pending clip blob (non-fatal)', err)
      }
      delete pendingClips[playerName]
      playerRecordingStatus = { ...playerRecordingStatus, [playerName]: 'idle' }
      persist()
      return snapshot()
    }

    case 'DELETE_PLAYER': {
      const playerName = message.playerName
      const status = playerRecordingStatus[playerName]
      if (status === 'recording' || status === 'stopping' || status === 'saving' || status === 'pending-tag') {
        throw new Error(`Finish ${playerName}'s current clip before removing them.`)
      }
      match = { ...match, players: match.players.filter((p) => p !== playerName) }
      if (playerRecordingStatus[playerName] !== undefined) {
        const next = { ...playerRecordingStatus }
        delete next[playerName]
        playerRecordingStatus = next
      }
      persist()
      return snapshot()
    }

    case 'DELETE_CLIP': {
      const clip = match.clips.find((c) => c.clipId === message.clipId)
      if (!clip) throw new Error('That clip is no longer available.')
      match = { ...match, clips: match.clips.filter((c) => c.clipId !== message.clipId) }
      persist()
      try {
        await sendToOffscreen({ type: 'OFFSCREEN_DELETE_CLIP', clipId: message.clipId })
      } catch (err) {
        // Non-fatal — the clip is already gone from match.clips (what the UI
        // and compilation both actually read), so the scout sees it removed
        // either way. Worst case a stale blob lingers in IndexedDB until New
        // Session clears the whole cache.
        console.error('[background] failed to delete cached clip blob (non-fatal)', err)
      }
      return snapshot()
    }

    case 'COMPILE_CLIPS': {
      if (message.clipIds.length === 0) throw new Error('Select at least one clip to compile.')
      const selected = message.clipIds
        .map((id) => match.clips.find((c) => c.clipId === id))
        .filter((c): c is (typeof match.clips)[number] => c != null)
      if (selected.length === 0) throw new Error('Selected clips are no longer available.')
      // Not click-order — a highlight reel should play out in a deliberate
      // order, not whatever sequence the checkboxes happened to be clicked
      // in. See sortClipsForCompilation for the actual ordering rules.
      const ordered = sortClipsForCompilation(selected, message.order)

      const players = new Set(ordered.map((c) => c.playerName))
      const playerName = players.size === 1 ? ordered[0].playerName : null
      const filename = buildCompilationFilename({
        playerName,
        matchInfo: match.matchInfo,
        clipCount: ordered.length,
        extension: ordered[0].extension,
      })
      const path = buildCompilationPath({ matchInfo: match.matchInfo, playerName, filename })

      await ensureOffscreenDocument()
      const { url, mimeType } = await sendToOffscreen<{ url: string; mimeType: string }>({
        type: 'OFFSCREEN_COMPILE',
        clipIds: ordered.map((c) => c.clipId),
      })
      const downloadId = await chrome.downloads.download({ url, filename: path, saveAs: false })
      console.log('[background] compilation queued', { downloadId, path, mimeType, clips: ordered.length })
      scheduleRevoke(downloadId, url)
      lastCompilationPath = path
      persist()
      return snapshot()
    }

    case 'ADD_NOTE': {
      const text = message.text.trim()
      if (!text) throw new Error('Note text cannot be empty.')
      if (message.playerName != null && !match.players.includes(message.playerName)) {
        throw new Error('Unknown player.')
      }
      const note: MatchNote = {
        id: crypto.randomUUID(),
        playerName: message.playerName,
        text,
        timestampMs: currentElapsedMs(),
        savedAt: Date.now(),
      }
      match = { ...match, notes: [...match.notes, note] }
      persist()
      // Best-effort — never blocks or fails the note save itself, which has
      // already succeeded in extension storage above regardless of this.
      lastNoteExportStatus = await exportNotesLive(match, settings.includeMinuteInNotes)
      persist()
      return snapshot()
    }

    case 'SET_LINEUP_TEXT': {
      match = { ...match, lineup: { ...match.lineup, text: message.text } }
      persist()
      return snapshot()
    }

    case 'ADD_LINEUP_IMAGE': {
      if (match.lineup.imageDataUrls.length >= MAX_LINEUP_IMAGES) {
        throw new Error(`Up to ${MAX_LINEUP_IMAGES} lineup images.`)
      }
      match = {
        ...match,
        lineup: { ...match.lineup, imageDataUrls: [...match.lineup.imageDataUrls, message.imageDataUrl] },
      }
      persist()
      return snapshot()
    }

    case 'REMOVE_LINEUP_IMAGE': {
      match = {
        ...match,
        lineup: { ...match.lineup, imageDataUrls: match.lineup.imageDataUrls.filter((_, i) => i !== message.index) },
      }
      persist()
      return snapshot()
    }

    case 'NEW_SESSION': {
      if (anyPlayerBusy()) {
        throw new Error('Stop all current recordings before starting a new session.')
      }
      // Don't let an untagged clip vanish just because the session reset —
      // same reasoning as the orphaned-clip check in START_RECORDING. Covers
      // every player with a clip still awaiting a tag, not just one.
      for (const orphan of Object.values(pendingClips)) {
        try {
          await finalizePendingClip(orphan, null, false)
        } catch (err) {
          console.error('[background] could not recover orphaned pending clip during New Session', err)
        }
      }
      pendingClips = {}
      if (standbyArmed) {
        try {
          await sendToOffscreen({ type: 'OFFSCREEN_DISARM_STANDBY' })
        } catch (err) {
          console.error('[background] failed to disarm pre-roll standby', err)
        }
        standbyArmed = false
      }
      // The offscreen document's IndexedDB clip cache exists purely so this
      // match's clips can be compiled — no reason to keep it once the match
      // is over, and letting it grow unbounded across many matches would
      // waste real disk space over time.
      try {
        await sendToOffscreen({ type: 'OFFSCREEN_CLEAR_CLIP_CACHE' })
      } catch (err) {
        console.error('[background] failed to clear clip cache', err)
      }
      // Carry the capture region forward as the next match's draft — very
      // likely the same broadcast layout for back-to-back games, so this
      // saves reselecting it every time. Reselecting is still one click away.
      draftCaptureRegion = match.captureRegion
      matchTabId = null
      match = defaultMatch()
      playerRecordingStatus = {}
      lastSavedPath = null
      lastCompilationPath = null
      persist()
      return snapshot()
    }

    default:
      return snapshot()
  }
}

chrome.runtime.onMessage.addListener((message: Message | { type: 'OVERLAY_SHOULD_SHOW' }, sender, sendResponse) => {
  // Not part of the StateSnapshot-returning Message protocol — the overlay
  // content script (present on every tab) asks this on load to decide
  // whether to render on THIS particular tab.
  if (message.type === 'OVERLAY_SHOULD_SHOW') {
    ensureHydrated().then(() => {
      sendResponse({ shouldShow: match.matchActive && matchTabId != null && sender.tab?.id === matchTabId })
    })
    return true
  }

  handle(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }))
  return true
})
