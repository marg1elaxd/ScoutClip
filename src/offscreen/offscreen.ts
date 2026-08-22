/**
 * Runs headless (no visible window) so it survives popup close. Captures the tab
 * MediaStream handed to it via a tabCapture streamId, records it with MediaRecorder
 * using a fixed bitrate locked for the whole match, and hands finished clips back
 * to the background worker (chrome.downloads isn't available in offscreen docs).
 *
 * Pre-roll adds a second thing this document does: while "armed" (a match is
 * active and pre-roll is enabled), it continuously records the stream into
 * short rotating "standby" segments even when the scout hasn't pressed
 * Record — that's the only way to have footage from before the click, since
 * nothing can retroactively capture pixels that were never captured. When
 * Record is actually pressed, the current standby segment is finalized
 * ("promoted") and a normal clip recording begins; at Stop, the needed
 * standby segment(s) plus the clip are losslessly joined and trimmed to the
 * requested pre-roll window via ffmpeg (see ffmpeg.ts).
 */
import { CANDIDATE_MIME_TYPES, type CaptureRegion } from '../lib/types'
import { concatAndTrimFront, concatClips, correctPlaybackSpeed } from './ffmpeg'
import { clearClipStore, getClipBlob, saveClipBlob } from './clipStore'

const CROP_FPS = 30

// ---- the underlying capture stream — persists across multiple clips while pre-roll is armed ----
let stream: MediaStream | null = null // raw tabCapture stream
let recordStream: MediaStream | null = null // possibly cropped; what recorders actually read from
let streamMimeType = 'video/webm'
let videoBitsPerSecond = 5_000_000

// ---- the "real" clip recorder, active from Record-click to Stop ----
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let clipRequestedAt: number | null = null
let clipUsedPreRoll = false
let preRollSecondsForClip = 0
let pendingBlob: Blob | null = null

// ---- pre-roll standby ring buffer ----
interface StandbySegment {
  blob: Blob
  startedAt: number
  endedAt: number
}
let standbyArmed = false
let standbyRecorder: MediaRecorder | null = null
let standbyChunks: Blob[] = []
let standbySegmentStartedAt: number | null = null
let standbySegments: StandbySegment[] = [] // oldest first, capped at 2
let standbyRotationSeconds = 5
let standbyRotationTimer: ReturnType<typeof setTimeout> | null = null

// ---- capture-region crop pipeline (unchanged mechanics, now spans multiple clips while armed) ----
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
 * raw stream. `region` is in device pixels, matching the tabCapture video
 * track's actual frame size (see regionPicker.ts).
 */
function cropStreamToRegion(source: MediaStream, region: CaptureRegion): MediaStream {
  const videoTrack = source.getVideoTracks()[0]
  if (!videoTrack) return source

  cropVideoEl = document.createElement('video')
  cropVideoEl.muted = true
  // Offscreen documents are never rendered/visible — some browsers throttle
  // or skip decode/paint for elements that aren't attached to the document
  // at all, so attach it (nothing is ever shown to the user regardless).
  document.body.appendChild(cropVideoEl)
  cropVideoEl.srcObject = new MediaStream([videoTrack])
  cropVideoEl.play().catch(() => {})

  cropCanvas = document.createElement('canvas')
  cropCanvas.width = region.width
  cropCanvas.height = region.height
  const ctx = cropCanvas.getContext('2d')

  // requestAnimationFrame does NOT reliably fire in offscreen documents —
  // they're hidden/non-rendered by design, and Chrome throttles or fully
  // stops rAF for pages that are never actually visible, which was why
  // regions recorded as blank. setInterval isn't tied to the rendering
  // pipeline and fires normally in hidden contexts.
  const draw = () => {
    if (!cropVideoEl || !ctx) return
    if (cropVideoEl.readyState >= 2) {
      ctx.drawImage(cropVideoEl, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height)
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

/** Obtains the tabCapture stream once; a no-op if it's already set up (e.g. pre-roll already armed it). */
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
  console.log('[offscreen] stream ready —', region ? `${region.width}x${region.height} crop` : 'full tab', streamMimeType)
}

function teardownStream() {
  stopCropPipeline()
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  recordStream = null
}

// ---- pre-roll standby buffering ----

function startStandbySegment() {
  if (!recordStream) return
  // Captured in a local closure (not read back off the module-level
  // standby* vars) so the recorder being wound down at a rotation/promotion
  // seam can still be finalized correctly even after these module vars have
  // already been overwritten by the *next* segment — see stopSegment below.
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
  standbyRotationTimer = setTimeout(rotateStandbySegment, standbyRotationSeconds * 1000)
}

/**
 * Stops one specific recorder/chunk-buffer pair and resolves with its
 * finalized segment. Takes explicit references rather than reading the
 * module-level standby* vars, because by the time this resolves a *new*
 * standby segment may already be running (see rotateStandbySegment /
 * startRecordingViaPromotion) and those vars would already point at it.
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
 * Waiting for that before starting the replacement (the original approach)
 * left a real gap where nothing was capturing recordStream, which showed up
 * in playback as a freeze-then-skip right at the seam. Starting the new
 * recorder first and letting it briefly overlap with the old one being torn
 * down closes that gap — worst case is a fraction of a second of duplicate
 * frames at the boundary, not a lost one.
 */
async function rotateStandbySegment() {
  if (!standbyArmed || !standbyRecorder) return
  const oldRec = standbyRecorder
  const oldChunks = standbyChunks
  const oldStartedAt = standbySegmentStartedAt ?? Date.now()
  startStandbySegment()
  const segment = await stopSegment(oldRec, oldChunks, oldStartedAt)
  standbySegments.push(segment)
  if (standbySegments.length > 2) standbySegments.shift()
}

async function armStandby(streamId: string, region: CaptureRegion | null, bitrate: number, rotationSeconds: number) {
  await ensureStreamReady(streamId, region, bitrate)
  standbyArmed = true
  standbyRotationSeconds = rotationSeconds
  standbySegments = []
  startStandbySegment()
  console.log('[offscreen] pre-roll armed, rotating every', rotationSeconds, 's')
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
  if (!recorder) teardownStream() // only fully tear down if no clip is currently using the stream
  console.log('[offscreen] pre-roll disarmed')
}

// ---- the actual clip recording ----

function beginActiveClipRecording() {
  if (!recordStream) throw new Error('Recording stream is not ready.')
  chunks = []
  clipRequestedAt = Date.now()
  recorder = new MediaRecorder(recordStream, { mimeType: streamMimeType, videoBitsPerSecond })
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.start()
}

/** Normal path — pre-roll not in use, matches the original single-shot record flow exactly. */
async function startRecordingDirect(streamId: string, region: CaptureRegion | null, bitrate: number) {
  await ensureStreamReady(streamId, region, bitrate)
  clipUsedPreRoll = false
  beginActiveClipRecording()
}

/**
 * Pre-roll path — promotes the standby buffer into the real clip recording.
 * Starts the active clip recorder *before* winding down the standby one
 * (same reasoning as rotateStandbySegment) so the promotion seam — right at
 * the start of every pre-roll clip — doesn't leave a capture gap there.
 */
async function startRecordingViaPromotion(preRollSeconds: number) {
  if (!recordStream) throw new Error('Pre-roll is not armed yet — nothing to promote.')
  if (standbyRotationTimer != null) {
    clearTimeout(standbyRotationTimer)
    standbyRotationTimer = null
  }
  clipUsedPreRoll = true
  preRollSecondsForClip = preRollSeconds

  const oldRec = standbyRecorder
  const oldChunks = standbyChunks
  const oldStartedAt = standbySegmentStartedAt ?? Date.now()
  standbyRecorder = null

  beginActiveClipRecording()

  if (oldRec) {
    const segment = await stopSegment(oldRec, oldChunks, oldStartedAt)
    standbySegments.push(segment)
    if (standbySegments.length > 2) standbySegments.shift()
  }
}

function stopRecorderAndCollect(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!recorder) {
      reject(new Error('Stop was requested but no recording was active.'))
      return
    }
    const rec = recorder
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: streamMimeType })
      chunks = []
      recorder = null
      resolve(blob)
    }
    rec.stop()
  })
}

async function stopActiveClip(postRollMs: number, gameSpeed: number): Promise<void> {
  if (postRollMs > 0) await sleep(postRollMs)
  const activeClipBlob = await stopRecorderAndCollect()
  const ext = streamMimeType.startsWith('video/mp4') ? 'mp4' : 'webm'

  if (clipUsedPreRoll && clipRequestedAt != null) {
    const desiredStartMs = clipRequestedAt - preRollSecondsForClip * 1000
    const needed = standbySegments.filter((s) => s.endedAt > desiredStartMs).sort((a, b) => a.startedAt - b.startedAt)
    if (needed.length > 0) {
      const joinedStartMs = needed[0].startedAt
      const offsetSeconds = Math.max(0, (desiredStartMs - joinedStartMs) / 1000)
      try {
        console.log('[offscreen] pre-roll trim: segments=', needed.length, 'offsetSeconds=', offsetSeconds.toFixed(2))
        pendingBlob = await concatAndTrimFront(
          [...needed.map((s) => ({ blob: s.blob, extension: ext })), { blob: activeClipBlob, extension: ext }],
          offsetSeconds,
        )
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
  // before the click) stays untouched by this — it operates on whatever
  // pendingBlob is at this point, sped-up content included.
  if (gameSpeed !== 1) {
    try {
      console.log('[offscreen] correcting playback speed, factor=', gameSpeed)
      pendingBlob = await correctPlaybackSpeed(pendingBlob!, ext, gameSpeed)
    } catch (err) {
      console.error('[offscreen] speed correction failed — saving clip at recorded (sped-up) speed instead', err)
    }
  }

  clipRequestedAt = null
  clipUsedPreRoll = false
  standbyChunks = []

  if (standbyArmed) {
    startStandbySegment() // resume buffering for the next clip
  } else {
    teardownStream()
  }
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
async function takePendingClip(): Promise<{ url: string; mimeType: string; clipId: string }> {
  if (!pendingBlob) throw new Error('No recorded clip to hand off.')
  const mimeType = pendingBlob.type || 'video/webm'
  const clipId = crypto.randomUUID()
  await saveClipBlob(clipId, pendingBlob)
  const url = URL.createObjectURL(pendingBlob)
  pendingBlob = null
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
        await armStandby(message.streamId, message.region, message.videoBitsPerSecond, message.rotationSeconds)
        sendResponse({ ok: true })
        break
      case 'OFFSCREEN_DISARM_STANDBY':
        await disarmStandby()
        sendResponse({ ok: true })
        break
      case 'OFFSCREEN_START':
        if (message.viaPromotion) {
          await startRecordingViaPromotion(message.preRollSeconds)
        } else {
          await startRecordingDirect(message.streamId, message.region, message.videoBitsPerSecond)
        }
        sendResponse({ ok: true })
        break
      case 'OFFSCREEN_STOP':
        await stopActiveClip(message.postRollMs ?? 0, message.gameSpeed ?? 1)
        sendResponse({ ok: true })
        break
      case 'OFFSCREEN_GET_CLIP':
        sendResponse(await takePendingClip())
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
