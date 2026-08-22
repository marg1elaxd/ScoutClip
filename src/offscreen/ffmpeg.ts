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

export interface TrimSegment {
  blob: Blob
  /** Container extension shared by every segment — they always match here, all recorded from the same MediaRecorder profile. */
  extension: string
}

async function readOutputBlob(ffmpeg: FFmpeg, path: string, mimeType: string): Promise<Blob> {
  const data = await ffmpeg.readFile(path)
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string)
  // ffmpeg.wasm's Uint8Array is typed over ArrayBufferLike (which includes
  // SharedArrayBuffer), stricter than BlobPart's plain ArrayBuffer — cast
  // rather than copy, the runtime value is a perfectly normal Uint8Array.
  return new Blob([bytes as BlobPart], { type: mimeType })
}

/** Writes `segments` into ffmpeg's virtual FS and losslessly joins them (concat demuxer, stream copy) into `joined.<ext>`. */
async function writeAndConcat(ffmpeg: FFmpeg, segments: TrimSegment[]): Promise<{ joined: string; ext: string; cleanup: string[] }> {
  const ext = segments[0].extension
  const names = segments.map((_, i) => `seg${i}.${ext}`)
  const joined = `joined.${ext}`

  for (let i = 0; i < segments.length; i++) {
    await ffmpeg.writeFile(names[i], new Uint8Array(await segments[i].blob.arrayBuffer()))
  }

  const listContent = names.map((n) => `file '${n}'`).join('\n')
  await ffmpeg.writeFile('list.txt', listContent)
  await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', joined])

  return { joined, ext, cleanup: [...names, 'list.txt', joined] }
}

/**
 * Losslessly joins `segments` (in chronological order) via ffmpeg's concat
 * demuxer — stream copy, no re-encoding, since they all share one codec
 * profile — then trims `offsetSeconds` off the front, also via stream copy.
 * Because -c copy can only cut on keyframe boundaries, the trim isn't
 * frame-exact; that's fine for a "roughly N seconds before" pre-roll.
 */
export async function concatAndTrimFront(segments: TrimSegment[], offsetSeconds: number): Promise<Blob> {
  if (segments.length === 0) throw new Error('concatAndTrimFront called with no segments.')
  const ffmpeg = await getFFmpeg()
  const { joined, ext, cleanup } = await writeAndConcat(ffmpeg, segments)
  const trimmed = `trimmed.${ext}`

  try {
    const trimArgs =
      offsetSeconds > 0
        ? ['-ss', offsetSeconds.toFixed(2), '-i', joined, '-c', 'copy', '-avoid_negative_ts', 'make_zero', trimmed]
        : ['-i', joined, '-c', 'copy', trimmed]
    await ffmpeg.exec(trimArgs)
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
export async function concatClips(clips: TrimSegment[]): Promise<Blob> {
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
export async function correctPlaybackSpeed(blob: Blob, extension: string, gameSpeed: number): Promise<Blob> {
  if (gameSpeed === 1) return blob
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
    await ffmpeg.exec([
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
