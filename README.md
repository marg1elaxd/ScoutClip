# Scout Clip Recorder

A Chrome extension for football scouts: record match clips one click at a
time straight from whatever broadcast is playing in your browser, tag them
by player and action, and compile a per-player highlight reel afterward —
no separate screen-recording software, no manual clipping/renaming.

- **One-click record/stop** against the active broadcast tab (full tab, or a
  region you draw around just the video player)
- **Player-organized clips**, tagged offensive/defensive by action type,
  optionally captured mid-recording
- **Pre-roll / post-roll**, so you don't have to react in the exact instant
  something happens
- **Lossless per-player compilation** into a single highlight reel via
  `ffmpeg.wasm`, entirely in-browser — nothing leaves your machine
- An **on-page overlay** so you can record without alt-tabbing away from the
  match

> ⚠️ Only record broadcasts/footage you're actually authorized to capture
> (your own subscription, club footage, licensed feeds, etc.). This is a
> recording tool, not a way around any streaming service's terms.

## Install

Chrome extensions loaded this way (rather than through the Chrome Web Store)
require Developer Mode — Chrome will show a "this extension is not from the
store" style notice, which is expected for a self-distributed tool like this.

1. Download the latest `scout-clip-recorder-vX.Y.Z.zip` from the
   [Releases](../../releases) page and unzip it.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder.
5. Pin the extension from the toolbar puzzle-piece icon for easy access.

To build it from source instead, see
[Build & load as an unpacked extension](#build--load-as-an-unpacked-extension)
below.

## License

[MIT](LICENSE) © marg1elaxd

## Switching the broadcast tab mid-match

Some sites don't play the video on the page you started the match from at
all — clicking play opens the actual player in a *different* tab. Since the
whole app pins to one "broadcast tab" (`matchTabId`, set once at Start
Match, and pre-roll's standby stream locks to whatever tab was active at
that exact moment), there was previously no way to recover from that short
of New Session and starting over.

**Record from this tab instead**, in the in-match "⋯" panel: switch to
whichever tab actually has the video, then click it.

This is two messages, not one, and the order matters: `PREPARE_TAB_SWITCH`
disarms the old tab's pre-roll standby buffer (if on) and must **fully
complete** before requesting a `tabCapture` stream ID for the new tab —
Chrome only allows one active `tabCapture` stream per extension, so
skipping straight to grabbing the new tab's stream ID while the old one was
still technically live failed with "Cannot capture a tab with an active
stream." Once that's done, `RETARGET_BROADCAST_TAB` (in
[src/background/index.ts](src/background/index.ts)):

- Re-points `matchTabId` to the current tab.
- Re-arms pre-roll on the new tab if it's on, using a fresh `tabCapture`
  stream ID grabbed in the popup's own click handler *after*
  `PREPARE_TAB_SWITCH` resolves (same reason `ARM_PRE_ROLL` does at Start
  Match: needs a genuine user gesture, which only the popup, not the
  background worker, can supply).
- Pushes `OVERLAY_ACTIVATE` to the new tab and `OVERLAY_DEACTIVATE` to the
  old one, so the on-page overlay moves with it rather than lingering on a
  tab that's no longer relevant (it otherwise only unmounts when the whole
  match ends, not when it's simply not the right tab anymore).
- **Clears the capture region** — its pixel coordinates were selected
  against the old tab's page layout and are essentially meaningless on a
  different page. Reselect via "Change region" on the new tab if needed.

Blocked while actively recording (stop first) and while no match is active.

**Known limitation**: some sites open the player in a genuinely minimal
`window.open()` popup window — no tab strip, no toolbar, no extensions
icon row at all (just a URL bar). Chrome doesn't expose the extension icon
on that kind of window, so the regular popup (Settings, Compile, New
Session, and "Record from this tab instead" itself) can only be opened from
a normal browser window/tab, not from inside that popup. The on-page
overlay still works fine there once retargeted, though, since it's
injected directly into the page rather than depending on the toolbar — for
this kind of site, expect to do setup/retargeting from a normal tab and
then rely on the overlay (Record/Stop/tag/player select) for the rest of
the match.

**Click isolation**: Shadow DOM (used for the overlay) isolates styling and
DOM queries, but not event bubbling — a click inside the overlay still
bubbles out to the host page's own `document`. Live-TV/streaming sites are
often loaded with aggressive click-hijacking ad scripts that listen for
*any* click on the page and redirect focus or open pop-unders — which was
firing for clicks on the overlay's own buttons too, kicking focus back to
whatever tab opened the popup window. `createOverlay` in
[src/content/overlay.tsx](src/content/overlay.tsx) now stops every
click/pointer event from propagating past the overlay's own host element
once it's done bubbling through the shadow tree, so it never reaches the
page's listeners.

This has to be a **bubble-phase** listener on the host, not capture — an
earlier attempt used capture and made the whole overlay unresponsive
instead of just quieter: capture fires on the way *in*, before the event
ever reaches the actual button deep in the shadow tree, so calling
`stopPropagation()` there killed the event before React's own click
handlers (which run on the container inside the shadow tree) ever saw it.
Bubble phase fires only after the event has already worked its way back up
through React's own handling, so it only blocks it from continuing further
out to the page beyond that point.

## Keeping the recorded tab's video player alive when it loses focus

Some streaming/live-TV sites pause or outright error their video player the
moment their tab stops being the foreground one — checking
`document.hidden`/`visibilityState` in a `visibilitychange` handler, or
listening for `window.blur`. That's reasonable UX for a human tabbing away
casually, but it also kills a legitimate recording of a tab the scout has
deliberately designated as the one being captured, the instant they alt-tab
to check the popup, switch apps, or do anything else while the game runs.

The fix: when a tab becomes the designated broadcast tab (on `Start Match`,
and again on `Retarget Broadcast Tab`), the background worker injects a
small script into that tab's **MAIN world** (via
`chrome.scripting.executeScript({ world: 'MAIN' })`, not the extension's
usual isolated world — it has to run in the page's own JS realm for the
page's own code to see the override at all). See
[`src/lib/visibilityPatch.ts`](src/lib/visibilityPatch.ts).

It overrides `document.hidden`, `document.visibilityState`,
`document.webkitHidden`, and `document.hasFocus()` so they always report
"visible and focused," regardless of what's actually happening at the OS
window level. Any site logic that checks these to decide whether to pause
stops triggering, because what it reads always says everything is fine.

This deliberately patches the property **getters**, not the underlying
`visibilitychange`/`blur` **events**. Suppressing the events themselves
(e.g. intercepting them in capture phase and calling `stopPropagation()`)
would be unreliable here, because the patch is injected on demand — at
Start Match / Retarget time, well after the page has already loaded and
registered its own listeners. Getter-overriding works regardless of
registration order, since it intercepts the *value* at the moment the
site's own handler reads it, not the delivery of an event.

Scope is deliberately narrow: this only runs against the one tab set as
`matchTabId`, only when that happens, not as a blanket content script on
every page — patching every tab's visibility API unconditionally would be
overreach and could break other sites' legitimate battery/bandwidth-saving
behavior for tabs that have nothing to do with the match. It's also
best-effort: injection can fail (a `chrome://` page, a site that makes
these properties non-configurable), and that's treated as non-fatal —
recording just proceeds without the patch in that case.

## On hold: keeping the overlay out of recordings

The on-page overlay is a normal DOM element painted into the broadcast tab
— `chrome.tabCapture` grabs the tab's actual rendered pixels, so it
currently shows up in every recorded clip, sitting on top of the match
footage. A masking approach was built and then reverted (not shipped) once
its core limitation became clear: it can only *hide* the overlay's own
clutter by painting a plain fill over its rect, not restore the match
footage that was physically behind it — those pixels are already gone by
the time tabCapture sees the frame (the browser composites the overlay on
top before capture ever sees it), so there's no "clean" video underneath to
reveal. The recording would have shown a solid black patch in that corner
instead of the overlay's own UI, which wasn't an acceptable trade.

Two other approaches were discussed but not attempted, worth a look if this
gets picked back up:

- **Separate browser window** instead of an in-page overlay
  (`chrome.windows.create`) — `chrome.tabCapture` only sees a tab's own
  content, so a genuinely separate window is invisible to it regardless of
  where it sits on screen. Loses the "docked to the page" placement, and
  Chrome extension windows don't have reliable "always on top" support.
- **Position the overlay outside the capture region** — zero new code,
  works today if you're already cropping to a region and the video player
  doesn't extend into the corner where the overlay sits. Doesn't help for
  full-tab recording.

## Editable action-tag categories

The two top-level categories (Offensive/Defensive) are fixed, but each
one's subcategory list — what actually shows up as tag buttons after
Stop — is now a per-user setting (`RecordingSettings.actionCategories`),
editable from **Settings**: remove any tag with its ✕, add new ones by
typing and pressing Enter, or **Reset** one category back to its shipped
default independently of the other. Persisted in `chrome.storage.local`
like the rest of Settings, so it survives across matches.

Current defaults (`DEFAULT_ACTION_CATEGORIES` in
[src/lib/types.ts](src/lib/types.ts)):

- **Offensive**: Pass, Key Pass, Dribble, Shot, Goal, Assist, Off-ball Movement
- **Defensive**: Interception, Tackle, Ground Duel, Aerial Duel, Clearance, Block, Pressing

## Recording multiple players at once

There's no Record button and no "selected player" — each player's own chip
*is* the record toggle. Click a chip to start their clip; click it again to
stop. Any number of chips can be live at the same time, each fully
independent: starting player B's clip doesn't touch player A's still-running
one, and each gets its own tag panel (expands inline under that specific
chip once it's stopped) so tagging one doesn't block or get mixed up with
another that's still recording.

- **Chip states**: idle (default), **live** (recording — filled red,
  pulsing dot) and **busy** (dimmed, unclickable — covers the post-roll
  wait, awaiting a tag, and saving, so a second click can't fire mid-flow
  for that player).
- **Backend**: `playerRecordingStatus` in `StateSnapshot` is a map keyed by
  player name (a player absent from it, or explicitly `'idle'`, isn't
  recording) — see [src/lib/messages.ts](src/lib/messages.ts) — replacing
  what used to be one global `recordingStatus`. `START_RECORDING`,
  `STOP_RECORDING`, and `CONFIRM_SAVE` all now take a `playerName`.
- **Offscreen document**: each in-flight clip is its own "session" (keyed by
  player name, since a player can only have one clip in flight at a time),
  each with its own independent `MediaRecorder` — but all of them read from
  the *same* underlying `recordStream`. Nothing about `MediaRecorder`
  requires exclusive access to a `MediaStream`, so this is just N recorders
  pointed at one stream, the same trick pre-roll's standby buffer already
  used to avoid a capture gap at its own rotation seams (see
  [src/offscreen/offscreen.ts](src/offscreen/offscreen.ts)). The underlying
  `tabCapture` stream itself is only torn down once *every* session has
  stopped and standby isn't armed either — not the instant any single
  session finishes.
- **Pre-roll works per-session, not via a single "promotion"**: earlier
  versions of this had one active clip promote from a shared standby
  buffer, which meant stopping and restarting a recorder at that handoff
  (the exact seam that caused the freeze-then-skip bug documented below,
  before it was fixed). With multiple concurrent sessions there's no single
  moment to hand off at anyway, so standby buffering now just runs
  continuously and independently of whatever sessions are or aren't active;
  at Stop, whatever standby segment(s) cover *that session's* look-back
  window get losslessly spliced onto the front of its own recording.

## Adding a player mid-match

The roster entered at Start Match isn't fixed — a **+** chip at the end of
the player row (popup and overlay both) opens a small inline name field.
Confirming it (`ADD_PLAYER`) appends the player to `match.players` and
immediately starts recording them (same as clicking their chip would), since
the reason to add someone mid-match is always "clip this person right now" —
a separate add-then-click step would just be friction for no reason.

## Game speed correction

If you watch the broadcast at 2x, the recording is inherently 2x too fast
too — the browser just captures whatever's rendering on screen in real
wall-clock time, so a video playing at 2x produces footage that's 2x
time-compressed. **Watching the broadcast at** on the Setup screen (and
"Change game speed" in the in-match "⋯" panel, for switching mid-match)
selects the broadcast's actual playback rate; every clip recorded at that
setting gets slowed back down by that same factor right when it finishes
recording, so the saved file plays at real match speed regardless of how
fast you were watching.

This is the **first genuinely lossy operation** in the app — everything
else (pre-roll trimming, compilation) was deliberately built as lossless
stream-copy (`-c copy`, no re-encoding). Changing playback speed can't work
that way: it means restretching every frame's timestamp and every audio
sample (`setpts=gameSpeed*PTS` for video, `atempo=1/gameSpeed` for audio —
valid as a single filter instance for the 1x-2x range offered here, since
`atempo` only supports 0.5-2.0 per instance), which requires a real
decode-then-re-encode pass, not just remuxing. Re-encoded at close to the
original bitrate (`-b:v 5M`, matching `RECORDING_PROFILE`) to keep the
quality loss small, but it isn't zero, and it takes longer than every other
save (real encoding, not stream copy) — expect "Saving clip…" to take
noticeably longer when this is active.

Also genuinely new territory: this is the first time the app needs ffmpeg.wasm
to actually **encode** (H.264/VP9 + AAC/Opus), not just demux/remux —
everything built before this only ever used `-c copy`. Whether the bundled
`@ffmpeg/core` build includes those encoders (not just decoders) hasn't been
confirmed by an actual successful run yet as of writing; if speed correction
fails, check the offscreen console for `[ffmpeg]` log lines and
`[offscreen] speed correction failed` — it falls back to saving the clip at
its recorded (sped-up) speed rather than losing it, same resilience pattern
as pre-roll's trim-failure fallback.

**Known edge case**: if you change game speed mid-match, clips recorded at
different speeds get re-encoded through different code paths (1x clips are
untouched raw MediaRecorder output; anything else is ffmpeg-re-encoded), and
their codec parameters could differ enough that later compiling clips from
different speeds together hits the same "stream copy requires matching
parameters" constraint compilation already relies on. Not specifically
handled — if it comes up in practice, worth revisiting.

## Compilation (Phase 4)

Select clips from the clip list and merge them into one highlight reel —
losslessly, via the same ffmpeg.wasm stream-copy concat technique already
proven for pre-roll trimming (concat demuxer, no re-encoding, so output
quality exactly matches the source clips).

- Each clip row in the clip list now has a checkbox. Select any combination
  (single player or mixed — there's no restriction), then **Compile selected
  (N)**. Clips get joined in **chronological order** (by save time), not
  click-selection order, so the reel plays out the way the match actually
  happened regardless of the order you checked them in.
- Output filename/location: `<Player> - Compilation - <Match Info> - <N>
  clips.<ext>` under `.../<Player>/Compilations/` for a single-player
  selection, or `Compilation - ...` under `.../Compilations/` (game-level,
  no player subfolder) for a mixed one.
- **The real gap this had to close first**: `chrome.downloads` writes clips
  to disk but has no way to read a saved file's bytes back — so compiling
  needs the actual video data from somewhere. The offscreen document now
  additionally stashes a copy of every finalized clip's blob in **IndexedDB**
  ([src/offscreen/clipStore.ts](src/offscreen/clipStore.ts)), keyed by a
  `clipId` carried alongside the rest of that clip's metadata in
  `match.clips`. IndexedDB rather than a plain in-memory `Map`, deliberately:
  a full match can be 70-100 clips — easily several hundred MB in aggregate —
  and IndexedDB-stored blobs don't count against the page's live JS heap the
  way holding every Blob reference in a Map would. The cache is cleared on
  **New Session** (`OFFSCREEN_CLEAR_CLIP_CACHE`), since it exists purely to
  support compiling the match that just finished — no reason to keep it
  (or the disk space) once that's done, and letting it grow unbounded across
  many matches over a season would be a real cost.
- Compiling is therefore only possible **before** New Session is clicked for
  that match, same scoping as the clip list itself (Phase 2's "current match
  only" decision) — this is a natural fit, not an extra restriction.

## On-page overlay

Chrome closes the extension popup the instant it loses focus — which it
necessarily does the moment you click into the broadcast tab to actually
watch the game. That's fine for setup, but painful for the live
record/tag loop, which is exactly what this overlay fixes: a
small floating panel injected into the broadcast tab itself
([src/content/overlay.tsx](src/content/overlay.tsx)), staying visible while
you interact with the video because it's part of the page, not a separate
popup window.

- **Appears automatically** once a match is started from the popup (no
  separate "show overlay" step) — bottom-right corner, minimizable to a
  small pill, closable with ✕.
- **Starting a match pushes activation directly to the tab**
  (`chrome.tabs.sendMessage(matchTabId, { type: 'OVERLAY_ACTIVATE' })` in
  `START_MATCH`, handled by a listener in overlay.tsx) rather than relying
  on the content script to notice on its own — it only self-checks
  (`OVERLAY_SHOULD_SHOW`) once, at its own page-load time, so without this
  push a scout already on the broadcast tab *before* clicking Start Match
  would need to refresh the page for the overlay to ever appear. No refresh
  needed for normal use now.
- **Dev-reload gotcha (still real, different cause)**: Chrome only injects
  content scripts into tabs that load *after* the **extension itself**
  (re)loads — this is a platform limitation, not something the fix above can
  work around. After reloading the unpacked extension in
  `chrome://extensions` (i.e. after a code change), refresh the broadcast
  tab once before testing — otherwise that tab is still running the old
  (or no) content script and `chrome.tabs.sendMessage` to it will just fail
  silently (caught and ignored).
- **Scoped to the broadcast tab only.** This is a static content script
  (present on every page — content scripts can't be injected on-demand into
  a specific tab the way the region picker is), so it self-gates on load: it
  asks the background worker `OVERLAY_SHOULD_SHOW`, which checks whether
  *this* tab is `matchTabId` (the tab that was active when Start Match was
  clicked) and only renders if so. Every other open tab pays one small
  message round trip and renders nothing.
- **Same backend, second frontend.** It sends the exact same messages the
  popup does (`GET_STATE`, `START_RECORDING`, ...) — no changes to the
  recording pipeline, offscreen document, or file-saving logic. The one real
  difference: content scripts have no `chrome.tabCapture` access at all
  (unlike the popup, which can call it directly from a click
  handler), so the overlay's `START_RECORDING` omits `streamId` entirely and
  the background worker resolves one itself using the message `sender`'s tab
  id (`resolveStreamIdForTab` in
  [src/background/index.ts](src/background/index.ts)) — or promotes the
  pre-roll standby buffer instead, same as before, if that's armed.
- **Styling isolation** via Shadow DOM (`attachShadow`) plus `all: initial`
  on the host element, so the host page's CSS can't bleed in and the
  overlay's CSS can't bleed out.
- Deliberately scoped down from the popup for this first version: **no**
  match setup, Settings, region picker, or New Session here — those stay
  popup-only (pre/post-match actions, not part of the live loop this exists
  to fix). Player select, Record/Stop, tagging, and a live clip
  count/minute footer are what actually needed to be on-page.
- **Known limitation**: if the video is put into browser fullscreen, the
  overlay disappears — fullscreened elements render in a separate top layer
  that hides everything else in the document, overlay included. Not
  addressed here (would need Fullscreen API listeners to re-parent the
  overlay into the fullscreened element).

## Clip list (current match only)

The main screen lists every clip saved so far in the running match, grouped
by player and sorted by minute, with a **Show** button per clip
(`chrome.downloads.show(downloadId)`) that opens the OS file explorer with
that file highlighted — a quick way to spot-check a clip right after tagging
it. Scoped to "current match only" (`match.clips`, reset on the next
`START_MATCH`) rather than a cross-match library, since that's what the
Phase 4 compilation picker will need directly and keeps the data model
simple; a full historical library across matches would need its own screen
and storage strategy if that's wanted later.

## Pre-roll and post-roll (Settings)

Both off by default — Record/Stop click exactly when you press them, same
as before. In **Settings** (⚙ on the Setup screen, or from the in-match
"⋯" panel), each is independently toggleable with its own seconds value
(1–30s):

- **Auto-stop / post-roll** — keeps recording for N seconds after that
  player's chip is clicked to stop. Simple: the offscreen document just
  delays calling that session's `recorder.stop()` by that long (`stopSession`
  in [src/offscreen/offscreen.ts](src/offscreen/offscreen.ts)) — no
  architecture change, the clip's natural end already includes the extra
  seconds. The popup/overlay show a local "+Ns" countdown next to that
  player's chip purely for feedback (not synced to the backend, just
  cosmetic) and disable that chip for the window so a second click can't
  fire mid-stop.

- **Pre-roll** — this is the substantial one, since the browser can't
  retroactively capture pixels it never captured: getting footage from
  *before* the click means something has to be continuously recording
  the whole time you're "armed," not just while an actual clip is being
  taken.
  - When pre-roll is enabled, **Start Match** also grabs a `tabCapture`
    stream for the active tab and arms continuous **standby buffering** in
    the offscreen document: a `MediaRecorder` runs the whole time, rotated
    into fresh segments every `max(preRollSeconds, 5)`s so memory stays
    bounded (only the last 2 completed segments are kept — a few dozen MB
    at most, not the whole match). This runs independently of whatever
    per-player clip sessions are or aren't active — see "Recording multiple
    players at once" above for why there's no single "promote standby to
    the clip" step the way earlier versions had.
  - Clicking a player's chip starts a normal clip recorder on the same
    already-open shared stream — no interaction with standby's own recorder
    at all, so there's no handoff/seam at that moment to worry about.
  - Clicking that chip again to stop finalizes the clip, then **ffmpeg.wasm**
    losslessly joins whatever standby segment(s) cover *that session's*
    requested look-back window with the clip itself (concat demuxer, stream
    copy — no re-encoding,
    consistent with the lossless approach planned for Phase 4 compilation)
    and trims the front to the requested offset (also stream copy — cuts
    land on the nearest keyframe, so "5 seconds before" is *approximately*
    5 seconds, not frame-exact). Standby buffering never stopped in the
    first place, so there's nothing to resume — it's already covering
    whoever gets clicked next.
  - If the trim step fails for any reason, the clip still saves — just
    without pre-roll, falling back to the plain recorded clip rather than
    losing it (logged as `[offscreen] pre-roll trim failed`).
  - **Pre-roll only (re)arms at Start Match**, not the instant you toggle it
    in Settings — arming needs a fresh `tabCapture` stream from a genuine
    user gesture, which the Settings screen's Save button isn't tied to a
    specific tab for. Toggling it mid-match takes effect next match.
  - ffmpeg.wasm's core files (`ffmpeg-core.js`/`.wasm`, ~32MB) are bundled
    locally under `public/ffmpeg/` rather than fetched from a CDN at
    runtime — MV3 forbids extensions from executing remotely-fetched code.
    The manifest's CSP includes `wasm-unsafe-eval` so the wasm module can
    actually instantiate. Specifically the **ESM** build
    (`@ffmpeg/core/dist/esm/`), not the UMD one — `@ffmpeg/ffmpeg`'s worker
    runs as a module worker, where `importScripts()` always throws, so it
    always falls through to a real dynamic `import()` expecting
    `export default`, which only the ESM build has. And that import needs a
    plain `chrome-extension://` URL (`chrome.runtime.getURL(...)`), not a
    `blob:` one — despite being the usual advice for CDN-hosted ffmpeg.wasm
    setups, MV3's CSP doesn't allow `blob:` in script-src, so wrapping these
    with `@ffmpeg/util`'s `toBlobURL()` actively breaks it here. Both
    findings are written up in [src/offscreen/ffmpeg.ts](src/offscreen/ffmpeg.ts).

This is by far the most complex piece built so far — continuous background
recording, segment rotation, and a wasm video-processing pipeline all at
once — so budget for a debugging round or two rather than expecting it to
work perfectly on the first real test. Things worth checking specifically if
pre-roll clips don't come out right: the offscreen document's console for
`[offscreen] pre-roll armed`, `[offscreen] pre-roll trim: segments=…`, and
`[ffmpeg]` log lines (ffmpeg's own stderr output is piped through), and
whether the resulting clip's actual duration roughly matches
`preRollSeconds + (time between Record and Stop) + postRollSeconds`.

## New session

The **New session** button (top of the main screen, next to the match title)
resets everything — match info, roster, clock, clip list — back to the Setup
screen for the next game. It's disabled while actively recording or saving
(stop first), and if a clip is still awaiting a tag it gets auto-saved as
`Untagged` before resetting rather than lost, reusing the same safety-net
logic ("Recovering an unresolved pending clip" above) that already handles
this for `START_RECORDING`. The previously selected capture region carries
forward as the next session's draft, since back-to-back games are very
likely the same broadcast layout — reselecting is still one click away if not.

## Build & load as an unpacked extension

```bash
npm install
npm run dev
```

`npm run dev` (via `@crxjs/vite-plugin`) writes a live-reloading build to
`dist/`. Load it once in Chrome/Edge:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

Subsequent edits hot-reload automatically; no need to re-load the extension.
For a production build use `npm run build` instead.

## Where clips land

Clips save via `chrome.downloads` to:

```
Downloads/ScoutClips/<Game>/<Player>/<Player> - <Action> - <Match Info> - <N>min - #<ClipNumber>.mp4  (or .webm)
```

`#<ClipNumber>` is that player's Nth clip in the match (1-based, from
`match.clips`, computed in `finalizePendingClip`) — it's what keeps two
clips tagged in the same match-minute from colliding, since minute alone
isn't unique. Per-player rather than match-wide, since two different
players recording in the same minute already land in separate folders and
never collide anyway.

This is a deliberate Phase 1 tradeoff: recording runs in a headless
**offscreen document** (so a clip survives the popup closing when the scout
clicks back onto the game tab), and offscreen documents can't show a
File System Access folder picker. `chrome.downloads` (which does support
writing into subfolders under Downloads) works from a headless context
without one. If a custom root folder (outside `Downloads/`) becomes a
requirement, that needs the File System Access API driven from a visible
context (popup/options page) with the recorded clip relayed to it — worth
revisiting in a later phase if `Downloads/ScoutClips/...` isn't good enough.

## How recording works

1. Popup button click → `chrome.tabCapture.getMediaStreamId()` for the active
   tab (must run in a user-gesture context — hence it happens in the popup,
   not the background).
2. The stream ID is handed to the background service worker, which spins up
   the offscreen document and forwards it there.
3. The offscreen document turns the stream ID into a real `MediaStream` via
   `getUserMedia` and records it with `MediaRecorder`, using a **fixed
   bitrate** (5 Mbps) locked for the whole match — this is what will make
   lossless stream-copy compilation possible in Phase 4. The container/codec
   is picked at record time via `MediaRecorder.isTypeSupported()`, preferring
   real MP4 (H.264/AAC) and falling back to WebM (VP9/Opus) if the browser/OS
   combo doesn't support MP4 recording — the saved file's extension always
   matches whatever was actually used.
4. `tabCapture` mutes the source tab's audio by default; the offscreen
   document plays the captured audio back out through a hidden `<audio>`
   element so the scout doesn't lose the commentary/crowd while recording.
5. On stop, the clip stays in memory until the scout tags it (or explicitly
   skips tagging) in the popup, at which point the filename is finalized.
6. If a capture region was selected (see below), the raw tab video track is
   redrawn frame-by-frame, cropped, onto a canvas before recording — the
   video actually fed to `MediaRecorder` is `canvas.captureStream()`, not
   the raw stream.
7. **The actual save is a three-way relay**, because neither obvious context
   has everything it needs: `chrome.downloads` is unavailable inside the
   offscreen document, and `URL.createObjectURL` is unavailable inside this
   MV3 service worker (contrary to some docs — confirmed by testing, not
   assumed). So the offscreen document creates a `blob:` URL for the
   recorded clip (it has full DOM) and hands the URL string to the
   background worker, which calls `chrome.downloads.download()` on it
   (it has `chrome.downloads`, including the subfolder-path support the
   folder structure above depends on) and tells the offscreen document to
   revoke the URL once the download finishes. A base64 `data:` URL was
   tried first as a same-context alternative but proved unreliable at
   clip-sized payloads (downloads "succeeded" but produced unplayable files)
   — worth remembering if this ever needs revisiting.

## Recording only part of the tab

`chrome.tabCapture` only ever gives you the whole tab — there's no API to
request just a rectangle — so cropping to just the match video happens after
capture, not instead of it:

1. In the Setup screen (or "Change region" once a match is running), the
   scout clicks **Select region**, which injects a one-off overlay
   ([src/lib/regionPicker.ts](src/lib/regionPicker.ts)) into the *currently
   active tab* via `chrome.scripting.executeScript`. The scout drags a box
   over the video player and presses Enter to confirm (Esc cancels).
2. The selected rectangle — converted to device pixels via
   `window.devicePixelRatio`, so it lines up with the actual frame size of
   the tabCapture video track — is sent with `chrome.runtime.sendMessage`
   **directly from the injected overlay to the background service worker**,
   not back to the popup that triggered it. This isn't optional: dragging on
   the page means clicking into that tab, and Chrome auto-closes the
   extension popup the instant it loses focus — an earlier version had the
   popup itself `await` the picker's result and lost every selection this
   way, since the popup's JS context (including that pending `await`) was
   torn down before Enter was ever pressed. The background worker persists
   independently of the popup, so nothing is lost; the popup just needs to
   be reopened afterward to see the selection confirmed (both screens say so).
3. Before a match exists to attach the region to (Setup screen), it's held
   in a separate `draftCaptureRegion` — background state, not popup-local
   React state, for the same reason as point 2. `START_MATCH` folds it into
   the new match's `captureRegion` once the scout actually starts the match.
4. If `captureRegion` is set, the offscreen document redraws just that
   rectangle of every incoming frame onto a hidden `<canvas>`
   (`cropStreamToRegion` in [src/offscreen/offscreen.ts](src/offscreen/offscreen.ts))
   and records `canvas.captureStream()` instead of the raw stream — audio
   passes through unmodified, only video is cropped. `null` records the
   full tab, unchanged from before.
   The draw loop runs on `setInterval`, not `requestAnimationFrame` — an
   earlier version used rAF and produced entirely blank cropped recordings,
   because offscreen documents are hidden/non-rendered by design and Chrome
   throttles or fully stops rAF callbacks for pages that are never actually
   visible. `setInterval` isn't tied to the rendering pipeline and fires
   normally there. The hidden `<video>`/`<canvas>` elements are also
   attached to the document now rather than left fully detached, since
   decode can stall for elements outside the document tree too.

**Known limitation**: the region is captured once, in page coordinates, at
selection time. If the video player later moves or resizes (fullscreen
toggle, page reflow, window resize), the crop will drift — the scout needs
to reselect the region via "Change region" rather than it tracking
automatically. Not attempting auto-tracking was a deliberate simplicity
tradeoff for this phase.

## Recovering an unresolved pending clip

A player's chip is disabled while their clip is awaiting a tag, so this
shouldn't normally be reachable — but the background service worker can be
evicted/restarted by Chrome at any point, which used to reset its in-memory
`recordingStatus`/`pendingClip` back to defaults even though the offscreen
document still held an unsaved clip in memory. Now that both are per-player
maps (`playerRecordingStatus`, `pendingClips`, keyed by player name), the
same two things guard against losing a clip that way, scoped to whichever
player it actually belonged to:

1. `playerRecordingStatus` and `pendingClips` are persisted to
   `chrome.storage.session` (not just `match`), so a service-worker restart
   correctly rehydrates that player's status back into `pending-tag` instead
   of silently forgetting there's a clip waiting — their chip will still
   show the tag panel, not reset to idle.
2. As a belt-and-suspenders fallback, `START_RECORDING` checks for a
   leftover `pendingClips[playerName]` before starting a new recording for
   that same player and, if found, auto-saves it as `Untagged` first rather
   than overwriting it. This also covers cases the persistence fix above
   can't (e.g. the offscreen document itself was reloaded and no longer has
   the clip's bytes) — that failure is logged via
   `console.error('[background] could not recover orphaned pending clip', ...)`
   and the new recording proceeds regardless, since blocking it over an
   unrecoverable old clip would be worse. `NEW_SESSION` sweeps every
   remaining player's `pendingClips` entry the same way, so nothing is left
   behind purely because a different player's clip was the one still open.

## Known gaps before this is match-ready

- No clip list / library view yet (Phase 2 territory, though the file
  structure already supports it).
- No icons in the manifest yet — add real ones before publishing anywhere
  beyond local unpacked use.
