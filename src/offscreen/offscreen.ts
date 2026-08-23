/**
 * Runs headless (no visible window) so it survives popup close. Captures the tab
 * MediaStream handed to it via a tabCapture streamId, records it with MediaRecorder
 * using a fixed bitrate locked for the whole match, and hands finished clips back
 * to the background worker (chrome.downloads isn't available in offscreen docs).
 *
 * Multiple players can be recorded concurrently — each has its own clip
 * "session" (sessionId is the player's name, since a player can only have
 * one in-flight clip at a time), but every session reads from the *same*
 * underlying recordStream via its own independent MediaRecorder instance.
 * Nothing about MediaRecorder requires exclusivity over a MediaStream, so
 * this is just N recorders pointed at one stream rather than anything more
 * exotic — the same trick the pre-roll standby buffer already relies on to
 * avoid the promotion-seam gap (see below).
 *
 * Pre-roll adds a second thing this document does: while "armed" (a match is
 * active and pre-roll is enabled), it continuously records the stream into
 * short rotating "standby" segments completely independently of whatever
 * per-player sessions are or aren't active — that's the only way to have
 * footage from before a click, since nothing can retroactively capture
 * pixels that were never captured. A session's clip is *not* built by
 * "promoting" standby the way earlier versions of this worked; standby just
 * keeps running in the background the whole time it's armed, and at Stop,
 * whatever standby segment(s) cover that session's requested look-back
 * window get losslessly joined onto the front of its own recording via
 * ffmpeg (see ffmpeg.ts). This is deliberately simpler than a
 * stop-old-start-new handoff: with several sessions potentially starting at
 * different moments, there's no single "the" moment to hand off at, and
 * standby needing to run regardless of what any given session is doing is
 * exactly the shared-stream trick above, applied one level up.
 */
import { CANDIDATE_MIME_TYPES, MAX_ROLL_SECONDS, type CaptureRegion } from '../lib/types'
import { concatAndTrimFront, concatClips, correctPlaybackSpeed } from './ffmpeg'
import { clearClipStore, getClipBlob, saveClipBlob } from './clipStore'

const CROP_FPS = 30

// Deliberately NOT tied to the configured preRollSeconds (an earlier version
// rotated as often as every preRollSeconds, minimum 5s) — each rotation does
// real synchronous work (spins up a new MediaRecorder, finalizes the old
// one's Blob) on the same thread the crop-canvas draw loop and every other
// recorder run on, and doing that as often as every 5s was causing a
// periodic stutter in *every* concurrently recording clip, not just standby's
// own buffer. A longer, fixed cadence cuts how often that cost is paid,
// regardless of what pre-roll window the scout actually configured.
const STANDBY_ROTATION_SECONDS = 15
// Enough trailing segments to cover the longest possible configured pre-roll
// window (MAX_ROLL_SECONDS) even in the worst case — right after a fresh
// rotation, with +1 segment of margin.
const MAX_STANDBY_SEGMENTS = Math.ceil(MAX_ROLL_SECONDS / STANDBY_ROTATION_SECONDS) + 1

// ---- the underlying capture stream — persists across multiple clips/sessions while pre-roll is armed or any session is active ----
let stream: MediaStream | null = null // raw tabCapture stream
let recordStream: MediaStream | null = null // possibly cropped; what recorders actually read from
let streamMimeType = 'video/webm'
let videoBitsPerSecond = 5_000_000

// ---- active per-player clip sessions — sessionId is the player's name ----
interface ActiveSession {
  recorder: MediaRecorder
  chunks: Blob[]
  requestedAt: number
  preRollSeconds: number // 0 if this session isn't using pre-roll
}
const activeSessions = new Map<string, ActiveSession>()
const pendingBlobs = new Map<string, Blob>() // sessionId -> finished clip awaiting OFFSCREEN_GET_CLIP

// ---- pre-roll standby ring buffer — one shared history, independent of any active session ----
interface StandbySegment {
  blob: Blob
  startedAt: number
  endedAt: number
}
let standbyArmed = false
let standbyRecorder: MediaRecorder | null = null
let standbyChunks: Blob[] = []
let standbySegmentStartedAt: number | null = null
let standbySegments: StandbySegment[] = [] // oldest first, capped at MAX_STANDBY_SEGMENTS
let standbyRotationTimer: ReturnType<typeof setTimeout> | null = null

// ---- capture-region crop pipeline (unchanged mechanics, shared across every session and standby) ----
let cropVideoEl: HTMLVideoElement | null = null
let cropCanvas: HTMLCanvasElement | null = null
let cropCanvasStream: MediaStream | null = null
let cropIntervalId: ReturnType<typeof setInterval> | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getAudioEl(): HTMLAudioElement {
  return document.getElementById('playback') as HTMLAudioElement
}

function pickSupportedMimeType(): string {
  for (const type of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return 'video/webm'
}

/**
 * chrome.tabCapture only ever gives you the whole tab — there's no API to
 * request just a rectangle. To record only the match video, redraw just
 * that rectangle of every incoming frame onto a canvas via drawImage's
 * source-rect cropping, then record canvas.captureStream() instead of the
 * raw stream.
 *
 * `region` is a fraction of the *page's* viewport (see CaptureRegion's doc
 * comment in types.ts) — resolved here against `videoTrack.getSettings()`,
 * the capture stream's own reported width/height, rather than assumed to
 * equal `window.innerWidth/innerHeight * devicePixelRatio`. That assumption
 * doesn't reliably hold (tabCapture's delivered resolution isn't guaranteed
 * to exactly match the page's own layout metrics) and produced a real,
 * reproducible offset between the selected and actually-recorded rectangle.
 * `getSettings()` reports the track's actual dimensions synchronously, no
 * need to wait for the `<video>` element to start playing frames.
 */
function cropStreamToRegion(source: MediaStream, region: CaptureRegion): MediaStream {
  const videoTrack = source.getVideoTracks()[0]
  if (!videoTrack) return source

  const trackSettings = videoTrack.getSettings()
  const frameWidth = trackSettings.width
  const frameHeight = trackSettings.height
  if (!frameWidth || !frameHeight) {
    console.error('[offscreen] capture track reported no frame size — recording full tab instead of the selected region')
    return source
  }

  // tabCapture doesn't necessarily deliver frames at the page's own
  // resolution — measured live, a 1912x948 page came through as a fixed
  // 1920x1080 frame, a different aspect ratio entirely. That means the page
  // is fit into the frame ("contain"-style — scaled to fill one axis,
  // letterboxed/pillarboxed on the other) rather than mapping 1:1, so the
  // selection ratio has to be resolved against the actual *content*
  // rectangle within the frame, not the frame's outer edges, or it lands
  // offset by however big the padding bars are.
  const pageAspect = region.viewportWidth / region.viewportHeight
  const frameAspect = frameWidth / frameHeight
  let contentWidth: number
  let contentHeight: number
  let contentLeft: number
  let contentTop: number
  if (pageAspect > frameAspect) {
    // Page is proportionally wider than the frame — fit to width, pad top/bottom.
    contentWidth = frameWidth
    contentHeight = frameWidth / pageAspect
    contentLeft = 0
    contentTop = (frameHeight - contentHeight) / 2
  } else {
    // Page is proportionally taller/narrower than the frame — fit to height, pad left/right.
    contentHeight = frameHeight
    contentWidth = frameHeight * pageAspect
    contentTop = 0
    contentLeft = (frameWidth - contentWidth) / 2
  }

  const pixelRegion = {
    x: Math.round(contentLeft + region.xRatio * contentWidth),
    y: Math.round(contentTop + region.yRatio * contentHeight),
    width: Math.round(region.widthRatio * contentWidth),
    height: Math.round(region.heightRatio * contentHeight),
  }
  console.log('[offscreen] crop region resolved —', {
    region,
    frameWidth,
    frameHeight,
    contentLeft,
    contentTop,
    contentWidth,
    contentHeight,
    pixelRegion,
  })

  cropVideoEl = document.createElement('video')
  cropVideoEl.muted = true
  // Offscreen documents are never rendered/visible — some browsers throttle
  // or skip decode/paint for elements that aren't attached to the document
  // at all, so attach it (nothing is ever shown to the user regardless).
  document.body.appendChild(cropVideoEl)
  cropVideoEl.srcObject = new MediaStream([videoTrack])
  cropVideoEl.play().catch(() => {})

  cropCanvas = document.createElement('canvas')
  cropCanvas.width = pixelRegion.width
  cropCanvas.height = pixelRegion.height
  const ctx = cropCanvas.getContext('2d')

  // requestAnimationFrame does NOT reliably fire in offscreen documents —
  // they're hidden/non-rendered by design, and Chrome throttles or fully
  // stops rAF for pages that are never actually visible, which was why
  // regions recorded as blank. setInterval isn't tied to the rendering
  // pipeline and fires normally in hidden contexts.
  const draw = () => {
    if (!cropVideoEl || !ctx) return
    if (cropVideoEl.readyState >= 2) {
      ctx.drawImage(
        cropVideoEl,
        pixelRegion.x,
        pixelRegion.y,
        pixelRegion.width,
        pixelRegion.height,
        0,
        0,
        pixelRegion.width,
        pixelRegion.height,
      )
    }
  }
  cropIntervalId = setInterval(draw, 1000 / CROP_FPS)

  cropCanvasStream = cropCanvas.captureStream(CROP_FPS)
  return new MediaStream([...cropCanvasStream.getVideoTracks(), ...source.getAudioTracks()])
}

function stopCropPipeline() {
  if (cropIntervalId != null) clearInterval(cropIntervalId)
  cropIntervalId = null
  cropVideoEl?.pause()
  cropVideoEl?.remove()
  cropVideoEl = null
  cropCanvas = null
  cropCanvasStream?.getTracks().forEach((t) => t.stop())
  cropCanvasStream = null
}

/** Obtains the tabCapture stream once; a no-op if it's already set up (e.g. pre-roll already armed it, or another session is already using it). */
async function ensureStreamReady(streamId: string, region: CaptureRegion | null, bitrate: number) {
  if (stream) return
  videoBitsPerSecond = bitrate
  const constraints = {
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any

  stream = await navigator.mediaDevices.getUserMedia(constraints)

  // tabCapture mutes the source tab by default — route audio back out so the
  // scout keeps hearing the match while it records/buffers.
  const audioOnly = new MediaStream(stream.getAudioTracks())
  const audioEl = getAudioEl()
  audioEl.srcObject = audioOnly
  await audioEl.play().catch(() => {})

  recordStream = region ? cropStreamToRegion(stream, region) : stream
  streamMimeType = pickSupportedMimeType()
  console.log(
    '[offscreen] stream ready —',
    region ? `${Math.round(region.widthRatio * 100)}%×${Math.round(region.heightRatio * 100)}% crop` : 'full tab',
    streamMimeType,
  )
}

/** Only safe to call once nothing — no standby, no active session — still needs the stream. */
function teardownStreamIfUnused() {
  if (standbyArmed || activeSessions.size > 0) return
  stopCropPipeline()
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  recordStream = null
}

// ---- pre-roll standby buffering ----

function startStandbySegment() {
  if (!recordStream) return
  // Captured in a local closure (not read back off the module-level
  // standby* vars) so the recorder being wound down at a rotation seam can
  // still be finalized correctly even after these module vars have already
  // been overwritten by the *next* segment — see stopSegment below.
  const chunksRef: Blob[] = []
  const startedAt = Date.now()
  const rec = new MediaRecorder(recordStream, { mimeType: streamMimeType, videoBitsPerSecond })
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunksRef.push(e.data)
  }
  rec.start()
  standbyRecorder = rec
  standbyChunks = chunksRef
  standbySegmentStartedAt = startedAt
  standbyRotationTimer = setTimeout(rotateStandbySegment, STANDBY_ROTATION_SECONDS * 1000)
}

/**
 * Stops one specific recorder/chunk-buffer pair and resolves with its
 * finalized segment. Takes explicit references rather than reading the
 * module-level standby* vars, because by the time this resolves a *new*
 * standby segment may already be running (see rotateStandbySegment) and
 * those vars would already point at it.
 */
function stopSegment(rec: MediaRecorder, chunksRef: Blob[], startedAt: number): Promise<StandbySegment> {
  return new Promise((resolve) => {
    const finish = () => resolve({ blob: new Blob(chunksRef, { type: streamMimeType }), startedAt, endedAt: Date.now() })
    if (rec.state === 'inactive') {
      finish()
      return
    }
    rec.onstop = finish
    rec.stop()
  })
}

/**
 * MediaRecorder.stop() is async — the old recorder doesn't actually go
 * quiet until its `stop` event fires, one or more event-loop ticks later.
 * Waiting for that before starting the replacement left a real gap where
 * nothing was capturing recordStream, which showed up in playback as a
 * freeze-then-skip right at the seam. Starting the new recorder first and
 * letting it briefly overlap with the old one being torn down closes that
 * gap — worst case is a fraction of a second of duplicate frames at the
 * boundary, not a lost one.
 */
async function rotateStandbySegment() {
  if (!standbyArmed || !standbyRecorder) return
  const oldRec = standbyRecorder
  const oldChunks = standbyChunks
  const oldStartedAt = standbySegmentStartedAt ?? Date.now()
  startStandbySegment()
  const segment = await stopSegment(oldRec, oldChunks, oldStartedAt)
  standbySegments.push(segment)
  if (standbySegments.length > MAX_STANDBY_SEGMENTS) standbySegments.shift()
}

async function armStandby(streamId: string, region: CaptureRegion | null, bitrate: number) {
  await ensureStreamReady(streamId, region, bitrate)
  standbyArmed = true
  standbySegments = []
  startStandbySegment()
  console.log('[offscreen] pre-roll armed, rotating every', STANDBY_ROTATION_SECONDS, 's')
}

async function disarmStandby() {
  standbyArmed = false
  if (standbyRotationTimer != null) clearTimeout(standbyRotationTimer)
  standbyRotationTimer = null
  if (standbyRecorder && standbyRecorder.state !== 'inactive') {
    standbyRecorder.onstop = null
    standbyRecorder.stop()
  }
  standbyRecorder = null
  standbyChunks = []
  standbySegments = []
  teardownStreamIfUnused() // no-op if any session is still actively recording
  console.log('[offscreen] pre-roll disarmed')
}

// ---- per-player clip sessions ----

/** Starts a new independent recording for `sessionId` (a player name) — one at a time per session, any number of sessions concurrently. */
async function startSession(
  sessionId: string,
  streamId: string | undefined,
  region: CaptureRegion | null,
  bitrate: number,
  preRollSeconds: number,
): Promise<void> {
  if (activeSessions.has(sessionId)) throw new Error('This player is already recording.')
  if (!recordStream) {
    if (!streamId) throw new Error('Recording stream is not ready.')
    await ensureStreamReady(streamId, region, bitrate)
  }
  const chunks: Blob[] = []
  const requestedAt = Date.now()
  const recorder = new MediaRecorder(recordStream!, { mimeType: streamMimeType, videoBitsPerSecond })
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.start()
  activeSessions.set(sessionId, { recorder, chunks, requestedAt, preRollSeconds })
}

function stopRecorderAndCollect(rec: MediaRecorder, chunksRef: Blob[]): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (rec.state === 'inactive') {
      reject(new Error('Recording already stopped.'))
      return
    }
    rec.onstop = () => resolve(new Blob(chunksRef, { type: streamMimeType }))
    rec.stop()
  })
}

async function stopSession(sessionId: string, postRollMs: number, gameSpeed: number): Promise<void> {
  const session = activeSessions.get(sessionId)
  if (!session) throw new Error('No active recording for this player.')
  activeSessions.delete(sessionId)

  if (postRollMs > 0) await sleep(postRollMs)
  const activeClipBlob = await stopRecorderAndCollect(session.recorder, session.chunks)
  const ext = streamMimeType.startsWith('video/mp4') ? 'mp4' : 'webm'

  let pendingBlob: Blob
  if (session.preRollSeconds > 0) {
    const desiredStartMs = session.requestedAt - session.preRollSeconds * 1000
    const needed = standbySegments.filter((s) => s.endedAt > desiredStartMs).sort((a, b) => a.startedAt - b.startedAt)
    if (needed.length > 0) {
      const joinedStartMs = needed[0].startedAt
      const offsetSeconds = Math.max(0, (desiredStartMs - joinedStartMs) / 1000)
      // Consecutive standby segments can genuinely overlap in real content —
      // rotateStandbySegment starts the next segment's recorder before the
      // previous one's stop() resolves (to avoid a capture gap at the
      // rotation seam), so both briefly recorded the same real seconds of
      // footage. The same thing can happen between the *last* standby
      // segment and this active clip's own recording, if a rotation landed
      // while the clip was already recording — standby never pauses for an
      // active session, so that segment kept going too. Trim each segment
      // to stop exactly where the next one (or the active clip itself)
      // actually began, using their own measured timestamps as ground
      // truth, so the overlap never reaches the concat step at all instead
      // of playing back as a literal repeat.
      const trimmedSegments = needed.map((s, i) => {
        const nextBoundaryMs = i + 1 < needed.length ? needed[i + 1].startedAt : session.requestedAt
        const trimToSeconds = Math.max(0, (nextBoundaryMs - s.startedAt) / 1000)
        return { blob: s.blob, extension: ext, trimToSeconds }
      })
      try {
        console.log('[offscreen]', sessionId, 'pre-roll trim: segments=', needed.length, 'offsetSeconds=', offsetSeconds.toFixed(2))
        pendingBlob = await concatAndTrimFront([...trimmedSegments, { blob: activeClipBlob, extension: ext }], offsetSeconds)
      } catch (err) {
        console.error('[offscreen] pre-roll trim failed — saving clip without pre-roll instead', err)
        pendingBlob = activeClipBlob
      }
    } else {
      pendingBlob = activeClipBlob
    }
  } else {
    pendingBlob = activeClipBlob
  }

  // Watching the broadcast at gameSpeed means the capture is that much too
  // fast — slow it back down to real match speed. Applied last, after any
  // pre-roll join/trim, so the pre-roll math (which is about real seconds
  // before the click) stays untouched by this.
  if (gameSpeed !== 1) {
    try {
      console.log('[offscreen]', sessionId, 'correcting playback speed, factor=', gameSpeed)
      pendingBlob = await correctPlaybackSpeed(pendingBlob, ext, gameSpeed)
    } catch (err) {
      console.error('[offscreen] speed correction failed — saving clip at recorded (sped-up) speed instead', err)
    }
  }

  pendingBlobs.set(sessionId, pendingBlob)
  teardownStreamIfUnused()
}

// chrome.downloads is NOT available inside offscreen documents, and
// URL.createObjectURL is NOT available inside the background service worker
// — so the blob URL has to be created here (offscreen has full DOM) and the
// URL *string* handed to the background worker, which does have
// chrome.downloads and can download from it directly.
//
// Also stashes a copy of the blob in IndexedDB (clipStore) keyed by a fresh
// clipId, and returns that id — chrome.downloads has no way to read a saved
// file's bytes back, so this is the only way a later compilation can get at
// this clip's actual video data again.
async function takePendingClip(sessionId: string): Promise<{ url: string; mimeType: string; clipId: string }> {
  const blob = pendingBlobs.get(sessionId)
  if (!blob) throw new Error('No recorded clip to hand off for this player.')
  pendingBlobs.delete(sessionId)
  const mimeType = blob.type || 'video/webm'
  const clipId = crypto.randomUUID()
  await saveClipBlob(clipId, blob)
  const url = URL.createObjectURL(blob)
  return { url, mimeType, clipId }
}

/** Compiles previously-saved clips (by clipId, from the match's clip list) into one output, in the order given. */
async function compileClips(clipIds: string[]): Promise<{ url: string; mimeType: string }> {
  if (clipIds.length === 0) throw new Error('No clips selected to compile.')
  const blobs = await Promise.all(clipIds.map((id) => getClipBlob(id)))
  // Read the extension from the stored blobs' own tagged MIME type, not the
  // module-level streamMimeType — that only reflects the most recent
  // recording session and could be stale (default-reset) if the offscreen
  // document was recreated since. All clips in one match share a profile,
  // so the first blob's type is representative of all of them.
  const ext = (blobs[0].type || 'video/webm').startsWith('video/mp4') ? 'mp4' : 'webm'
  const compiled = await concatClips(blobs.map((blob) => ({ blob, extension: ext })))
  const url = URL.createObjectURL(compiled)
  return { url, mimeType: compiled.type || `video/${ext}` }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    switch (message.type) {
      case 'OFFSCREEN_ARM_STANDBY':
        await armStandby(message.streamId, message.region, message.videoBitsPerSecond)
        sendResponse({ ok: true })
        break
      case 'OFFSCREEN_DISARM_STANDBY':
        await disarmStandby()
        sendResponse({ ok: true })
        break
      case 'OFFSCREEN_START':
        await startSession(message.sessionId, message.streamId, message.region, message.videoBitsPerSecond, message.preRollSeconds ?? 0)
        sendResponse({ ok: true })
        break
      case 'OFFSCREEN_STOP':
        await stopSession(message.sessionId, message.postRollMs ?? 0, message.gameSpeed ?? 1)
        sendResponse({ ok: true })
        break
      case 'OFFSCREEN_GET_CLIP':
        sendResponse(await takePendingClip(message.sessionId))
        break
      case 'OFFSCREEN_COMPILE':
        sendResponse(await compileClips(message.clipIds))
        break
      case 'OFFSCREEN_CLEAR_CLIP_CACHE':
        await clearClipStore()
        sendResponse({ ok: true })
        break
      case 'OFFSCREEN_REVOKE':
        URL.revokeObjectURL(message.url)
        sendResponse({ ok: true })
        break
      default:
        // not addressed to the offscreen document
        return
    }
  })().catch((err) => {
    console.error('[offscreen]', message.type, err)
    sendResponse({ error: err instanceof Error ? err.message : String(err) })
  })
  return true
})
