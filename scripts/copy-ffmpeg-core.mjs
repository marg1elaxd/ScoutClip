// public/ffmpeg/ is gitignored — the core files are a large (~32MB) vendored
// copy of @ffmpeg/core's own ESM build (see src/offscreen/ffmpeg.ts for why
// it has to be the ESM build specifically, and why it's bundled locally
// rather than fetched from a CDN at runtime). Re-copying them here on every
// `npm install` keeps them out of git history entirely.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm')
const destDir = join(root, 'public', 'ffmpeg')

mkdirSync(destDir, { recursive: true })
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copyFileSync(join(srcDir, file), join(destDir, file))
}
console.log('[copy-ffmpeg-core] copied ffmpeg-core.js/.wasm into public/ffmpeg/')
