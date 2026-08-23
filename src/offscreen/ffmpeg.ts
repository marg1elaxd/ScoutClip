import { FFmpeg } from '@ffmpeg/ffmpeg'

/**
 * ffmpeg-core.js/.wasm are bundled locally (public/ffmpeg/, the ESM build —
 * see below) rather than fetched from a CDN at runtime, since MV3 forbids
 * extensions from executing remotely-fetched code.
 *
 * Two non-obvious things about how @ffmpeg/ffmpeg loads these, worked out by
 * reading its worker source (node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js):
 *
 * 1. Its worker is created with `{ type: "module" }`, and `importScripts()`
 *    always throws in a module worker — so it *always* falls through to
 *    `await import(coreURL)`, a genuine dynamic ESM import expecting
 *    `export default`. The **UMD** build of @ffmpeg/core doesn't have one
 *    (it just assigns a global), so importing it "succeeds" with an empty
 *    module and the library reports "failed to import ffmpeg-core.js". The
 *    **ESM** build (`@ffmpeg/core/dist/esm/`) is the one that actually works
 *    here — that's what's bundled into public/ffmpeg/, not the UMD one.
 * 2. That dynamic import needs a `chrome-extension://` URL (matching the
 *    manifest's `'self'` CSP), not a `blob:` URL — MV3's extension_pages CSP
 *    doesn't allow `blob:` in script-src (by design, to block exactly this
 *    class of dynamically-constructed-script execution), so wrapping these
 *    in @ffmpeg/util's toBlobURL() first — the usual advice for CDN-hosted
 *    core files — actively breaks it here. Pass chrome.runtime.getURL()
 *    directly.
 */
let ffmpegPromise: Promise<FFmpeg> | null = null

function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ff = new FFmpeg()
      ff.on('log', ({ message }) => console.log('[ffmpeg]', message))
      await ff.load({
        coreURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm'),
      })
      return ff
    })()
  }
  return ffmpegPromise
}

/**
 * There's exactly one shared ffmpeg.wasm instance for the whole offscreen
 * document (getFFmpeg's singleton above), and every operation here writes
 * to fixed filenames in its virtual filesystem (raw0.ext, list.txt,
 * joined.ext, ...). That's fine as long as only one logical job touches it
 * at a time — but with concurrent multi-player recording, two players
 * stopping close together can each trigger their own pre-roll splice
 * around the same moment, and nothing was stopping those from actually
 * running concurrently. Interleaved file writes/reads/deletes from two
 * unrelated jobs sharing the same names corrupted the virtual filesystem —
 * surfaced as ffmpeg's own "Aborted()" plus an ErrnoError "FS error" on the
 * JS side. Every exported function below is queued through this so ffmpeg
 * only ever does one job at a time, regardless of how many callers ask for
 * one concurrently.
 */
let ffmpegQueue: Promise<unknown> = Promise.resolve()

function queued<T>(task: () => Promise<T>): Promise<T> {
  const result = ffmpegQueue.then(task, task)
  // Chain the queue itself off a version that never rejects, so one job's
  // failure doesn't wedge every job queued after it — only `result` (this
  // call's own promise) should reject for its caller.
  ffmpegQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export interface TrimSegment {
  blob: Blob
  /** Container extension shared by every segment — they always match here, all recorded from the same MediaRecorder profile. */
  extension: string
  /**
   * If set, only the first this-many seconds of the segment are kept before
   * joining. Used to cut real content overlap out of consecutive standby
   * segments — the standby ring buffer starts a segment's replacement
   * recorder before the outgoing one finishes stopping (to avoid a capture
   * gap at the seam), which means both briefly recorded the same real
   * seconds of footage. Concatenating full segments as-is would replay that
   * overlap as a literal repeat in the output; trimming the earlier
   * segment's tail back to where the next one's recording actually began
   * removes it before the segments are ever joined. Stream copy, so the cut
   * lands on the nearest keyframe — not frame-exact, same tolerance as the
   * front trim below.
   */
  trimToSeconds?: number | null
}

/**
 * `FFmpeg.exec()` resolves with the underlying process's *return code* —
 * it does NOT reject just because ffmpeg itself crashed or aborted
 * internally ("Aborted()" in its log output). Every direct `ffmpeg.exec()`
 * call in this file was `await`ed and its result ignored, which meant a
 * failed command (e.g. a segment trim that aborted mid-way) was silently
 * treated as a success — code proceeded to reference output that was never
 * actually written, and the *real* failure only surfaced several steps
 * later as a confusing "No such file or directory" from some unrelated
 * downstream read. This wraps every exec call so a non-zero return code
 * throws immediately, at the point that actually failed, with the command
 * that failed in the error — turning a silent, delayed, misleading failure
 * into an immediate, attributable one.
 */
async function execChecked(ffmpeg: FFmpeg, args: string[]): Promise<void> {
  const code = await ffmpeg.exec(args)
  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code}: ${args.join(' ')}`)
  }
}

async function readOutputBlob(ffmpeg: FFmpeg, path: string, mimeType: string): Promise<Blob> {
  const data = await ffmpeg.readFile(path)
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string)
  // ffmpeg.wasm's Uint8Array is typed over ArrayBufferLike (which includes
  // SharedArrayBuffer), stricter than BlobPart's plain ArrayBuffer — cast
  // rather than copy, the runtime value is a perfectly normal Uint8Array.
  return new Blob([bytes as BlobPart], { type: mimeType })
}

/**
 * Writes `segments` into ffmpeg's virtual FS and losslessly joins them
 * (concat demuxer, stream copy) into `joined.<ext>`. Any segment with
 * `trimToSeconds` set is cut down to that duration first, as its own
 * intermediate file, before being added to the concat list — see
 * TrimSegment's doc comment for why. If trimming a given segment fails, it's
 * dropped from the join rather than failing the whole operation — losing
 * one slice of pre-roll is far better than losing all of it.
 *
 * Known limitation: if the caller is relying on offsetSeconds (the
 * concatAndTrimFront front-trim) computed relative to `segments[0]`, and
 * segment 0 specifically is the one that fails to trim, that offset no
 * longer lines up with the resulting joined file's timeline (which now
 * starts from whichever segment survived first). Not corrected for here —
 * accepted as a rare, strictly-better-than-total-failure edge case rather
 * than threading the surviving-segment list back through offset math for a
 * failure mode that in practice has only hit the most recent (not-yet-
 * rotated, requestData()-flushed) segment, which is always last, not first.
 */
async function writeAndConcat(ffmpeg: FFmpeg, segments: TrimSegment[]): Promise<{ joined: string; ext: string; cleanup: string[] }> {
  const ext = segments[0].extension
  const joined = `joined.${ext}`
  const cleanup: string[] = []
  const names: string[] = []

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const rawName = `raw${i}.${ext}`
    await ffmpeg.writeFile(rawName, new Uint8Array(await seg.blob.arrayBuffer()))
    cleanup.push(rawName)

    if (seg.trimToSeconds != null) {
      const trimmedName = `segtrim${i}.${ext}`
      try {
        await execChecked(ffmpeg, ['-i', rawName, '-t', seg.trimToSeconds.toFixed(2), '-c', 'copy', trimmedName])
        cleanup.push(trimmedName)
        names.push(trimmedName)
      } catch (err) {
        // Trimming one segment (most often the not-yet-rotated standby
        // segment flushed via requestData() — see flushCurrentStandbySegment
        // in offscreen.ts) has occasionally failed even with no apparent
        // timing race, root cause not fully pinned down. Losing that one
        // segment's slice of pre-roll is far better than losing the whole
        // splice over it — drop it from the join and keep going with
        // whatever else is available rather than letting this exception
        // propagate and fail the entire operation.
        console.error('[ffmpeg] failed to trim segment', i, '— excluding it from the join rather than failing the whole splice', err)
      }
    } else {
      names.push(rawName)
    }
  }

  if (names.length === 0) throw new Error('No segments survived trimming.')

  const listContent = names.map((n) => `file '${n}'`).join('\n')
  await ffmpeg.writeFile('list.txt', listContent)
  cleanup.push('list.txt')
  // Each segment comes from its own independent MediaRecorder instance,
  // each restarting its own internal PTS/DTS near zero — the concat
  // demuxer is supposed to rebase later files onto a continuous timeline
  // when gluing them together with -c copy, but in practice this wasn't
  // happening reliably for audio here, logged as repeated ffmpeg warnings
  // ("Non-monotonous DTS in output stream 0:1") and each one silently
  // patched by nudging the timestamp forward by the smallest possible
  // amount instead of properly rebasing it — a real but cosmetic playback
  // glitch right at the seam, no data actually missing.
  //
  // -fflags +genpts (tried first) was worse than the problem it fixed:
  // regenerating every presentation timestamp from scratch, rather than
  // rebasing each file's onto the previous one's, could assign the *last*
  // file in the chain (always the active clip itself here) timestamps that
  // didn't correctly continue after the pre-roll segments before it — which
  // made the front-trim step below (-ss offsetSeconds, applied to the whole
  // joined file) think that content belonged *before* the cut point and
  // drop it, so the saved clip ended up containing only the pre-roll and
  // none of what was actually recorded after the click.
  // -avoid_negative_ts make_zero is the gentler fix actually needed here:
  // it only shifts timestamps to avoid negative/wrapped values (the
  // specific thing that breaks DTS monotonicity at a concat seam) without
  // touching their relative ordering, so it doesn't risk reshuffling
  // content the way wholesale regeneration did.
  await execChecked(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-avoid_negative_ts', 'make_zero', joined])

  return { joined, ext, cleanup: [...cleanup, joined] }
}

/**
 * Losslessly joins `segments` (in chronological order) via ffmpeg's concat
 * demuxer — stream copy, no re-encoding, since they all share one codec
 * profile — then trims `offsetSeconds` off the front, also via stream copy.
 * Because -c copy can only cut on keyframe boundaries, the trim isn't
 * frame-exact; that's fine for a "roughly N seconds before" pre-roll.
 */
export function concatAndTrimFront(segments: TrimSegment[], offsetSeconds: number): Promise<Blob> {
  return queued(() => concatAndTrimFrontImpl(segments, offsetSeconds))
}

async function concatAndTrimFrontImpl(segments: TrimSegment[], offsetSeconds: number): Promise<Blob> {
  if (segments.length === 0) throw new Error('concatAndTrimFront called with no segments.')
  const ffmpeg = await getFFmpeg()
  const { joined, ext, cleanup } = await writeAndConcat(ffmpeg, segments)
  const trimmed = `trimmed.${ext}`

  try {
    const trimArgs =
      offsetSeconds > 0
        ? ['-ss', offsetSeconds.toFixed(2), '-i', joined, '-c', 'copy', '-avoid_negative_ts', 'make_zero', trimmed]
        : ['-i', joined, '-c', 'copy', trimmed]
    await execChecked(ffmpeg, trimArgs)
    return await readOutputBlob(ffmpeg, trimmed, segments[segments.length - 1].blob.type || `video/${ext}`)
  } finally {
    for (const n of [...cleanup, trimmed]) {
      await ffmpeg.deleteFile(n).catch(() => {})
    }
  }
}

/**
 * Losslessly joins `clips` (in the order given — caller sorts, typically
 * chronological) into a single compiled video — the post-match highlight
 * reel. Same stream-copy concat as pre-roll trimming, just without the trim
 * step: no re-encoding, so output quality exactly matches the source clips.
 */
export function concatClips(clips: TrimSegment[]): Promise<Blob> {
  return queued(() => concatClipsImpl(clips))
}

async function concatClipsImpl(clips: TrimSegment[]): Promise<Blob> {
  if (clips.length === 0) throw new Error('concatClips called with no clips.')
  const ffmpeg = await getFFmpeg()
  const { joined, ext, cleanup } = await writeAndConcat(ffmpeg, clips)
  try {
    return await readOutputBlob(ffmpeg, joined, clips[clips.length - 1].blob.type || `video/${ext}`)
  } finally {
    for (const n of cleanup) {
      await ffmpeg.deleteFile(n).catch(() => {})
    }
  }
}

/**
 * Slows a clip down by `gameSpeed` (e.g. 2 for a broadcast watched at 2x),
 * restoring real match speed. Unlike every other ffmpeg operation here, this
 * one genuinely can't be a lossless stream copy — changing playback speed
 * means restretching every frame's timestamp and every audio sample, which
 * requires a real decode + re-encode pass. Video: `setpts=gameSpeed*PTS`
 * (stretches timestamps, e.g. 2x → doubles duration → half speed). Audio:
 * `atempo=1/gameSpeed` (valid for a single atempo instance across the whole
 * 1x-2x range this app offers — atempo only supports 0.5-2.0 per instance,
 * which is exactly 1/gameSpeed for gameSpeed in [1, 2]).
 */
export function correctPlaybackSpeed(blob: Blob, extension: string, gameSpeed: number): Promise<Blob> {
  if (gameSpeed === 1) return Promise.resolve(blob)
  return queued(() => correctPlaybackSpeedImpl(blob, extension, gameSpeed))
}

async function correctPlaybackSpeedImpl(blob: Blob, extension: string, gameSpeed: number): Promise<Blob> {
  const ffmpeg = await getFFmpeg()
  const input = `speed_in.${extension}`
  const output = `speed_out.${extension}`
  const isMp4 = extension === 'mp4'
  const audioCodec = isMp4 ? 'aac' : 'libopus'
  // Both encoders default to compression-efficiency-tuned presets (x264's
  // "medium", libvpx-vp9 effectively its slowest good-quality mode) — wildly
  // wrong trade-off for wasm with no hardware acceleration: an ~13s clip was
  // taking 80-90+ seconds (measured speed=~0.2x realtime). These push both
  // toward "fast enough to feel responsive," accepting a slightly larger
  // file for the same quality in exchange.
  const videoArgs = isMp4
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '5M']
    : ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '5M']

  try {
    await ffmpeg.writeFile(input, new Uint8Array(await blob.arrayBuffer()))
    await execChecked(ffmpeg, [
      '-i',
      input,
      '-vf',
      `setpts=${gameSpeed}*PTS`,
      '-af',
      `atempo=${(1 / gameSpeed).toFixed(4)}`,
      ...videoArgs,
      '-c:a',
      audioCodec,
      output,
    ])
    return await readOutputBlob(ffmpeg, output, blob.type || `video/${extension}`)
  } finally {
    await ffmpeg.deleteFile(input).catch(() => {})
    await ffmpeg.deleteFile(output).catch(() => {})
  }
}
