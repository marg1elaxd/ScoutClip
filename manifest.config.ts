import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

export default defineManifest({
  manifest_version: 3,
  name: 'Scout Clip Recorder',
  version: pkg.version,
  description: 'One-click match clip recording and player-organized clip library for football scouts.',
  action: {
    default_popup: 'src/popup/index.html',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  // Injected on every page (auto-runs, unlike the on-demand region picker)
  // because content scripts can't be triggered on demand via chrome.scripting
  // the way the region picker is — this needs to be present and ready before
  // the scout ever interacts with the tab. It self-gates immediately on load
  // (asks background whether this specific tab is the active match's
  // broadcast tab) and renders nothing at all otherwise — see
  // src/content/overlay.tsx.
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/overlay.tsx'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['tabCapture', 'offscreen', 'downloads', 'storage', 'activeTab', 'scripting'],
  // ffmpeg.wasm (used for pre-roll trimming — see offscreen/ffmpeg.ts) needs
  // wasm-unsafe-eval to instantiate its WebAssembly module under MV3's
  // otherwise-strict default CSP.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
})
