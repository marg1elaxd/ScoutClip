/**
 * Static content script, present on every page (see manifest.config.ts) —
 * content scripts can't be injected on demand the way the region picker is,
 * so this has to be there from page load and decide for itself whether to
 * actually render anything.
 *
 * On load it asks the background worker whether THIS tab is the active
 * match's broadcast tab (OVERLAY_SHOULD_SHOW, resolved server-side via the
 * message sender's tab id — see background/index.ts) and renders nothing at
 * all if not, keeping the cost on every other open tab to one small message
 * round trip.
 *
 * Everything else reuses the exact same background message protocol the
 * popup uses (GET_STATE, START_RECORDING, ...) — this is a second frontend
 * for the same backend, not a different recording pipeline.
 * The one real difference: content scripts have no chrome.tabCapture access
 * at all, so START_RECORDING is sent without a streamId here and the
 * background worker resolves one itself from this tab.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { sendMessage, type StateSnapshot } from '../lib/messages'
import type { RecordingStatus } from '../lib/types'

const HOST_ID = 'scout-clip-recorder-overlay-host'
const POLL_MS = 3000

const OVERLAY_CSS = `
  :host, * { box-sizing: border-box; }
  .panel {
    width: 240px;
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    font-size: 12px;
    background: #101418;
    color: #e8ecef;
    border: 1px solid #2b333a;
    border-radius: 10px;
    padding: 10px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.45);
  }
  .pill {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    font-size: 12px;
    background: #101418;
    color: #e8ecef;
    border: 1px solid #2b333a;
    border-radius: 999px;
    padding: 8px 14px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.45);
    cursor: pointer;
    max-width: 220px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4a5560; flex-shrink: 0; }
  .dot.recording { background: #d1453b; }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 8px; }
  .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .header-btns { display: flex; gap: 4px; flex-shrink: 0; }
  button {
    cursor: pointer;
    border: 1px solid #2b333a;
    background: #1a2027;
    color: #e8ecef;
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    font-family: inherit;
  }
  button:hover { background: #232b33; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary { background: #2f6feb; border-color: #2f6feb; color: white; font-weight: 600; }
  button.danger { background: #d1453b; border-color: #d1453b; color: white; font-weight: 600; }
  .header-btns button { padding: 2px 7px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
  .chip { padding: 4px 9px; border-radius: 999px; font-size: 11px; }
  .chip.selected { background: #2f6feb; border-color: #2f6feb; color: white; font-weight: 600; }
  .player-rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .player-record-row { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
  .player-chip { display: inline-flex; align-items: center; gap: 6px; }
  .player-chip.live { background: #d1453b; border-color: #d1453b; color: white; font-weight: 600; }
  .player-chip.busy { opacity: 0.6; }
  .rec-dot { width: 7px; height: 7px; border-radius: 50%; background: white; flex-shrink: 0; animation: rec-pulse 1.2s infinite; }
  @keyframes rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .add-player-row { display: flex; gap: 5px; margin-bottom: 8px; }
  .add-player-row input {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    padding: 5px 7px;
    border-radius: 6px;
    border: 1px solid #2b333a;
    background: #1a2027;
    color: #e8ecef;
    font-size: 12px;
    font-family: inherit;
  }
  .record-btn { width: 100%; padding: 11px; font-size: 13px; }
  .tag-panel { margin-top: 8px; padding: 8px; background: #1a2027; border-radius: 8px; border: 1px solid #2b333a; }
  .tag-panel.inline { width: 100%; box-sizing: border-box; margin-top: 0; }
  .category-row { display: flex; gap: 6px; margin-bottom: 6px; }
  .category-row button { flex: 1; }
  .subcategory-grid { display: flex; flex-wrap: wrap; gap: 5px; }
  .full { margin-top: 6px; width: 100%; }
  .status { margin-top: 6px; font-size: 11px; color: #9aa4ad; }
  .status.inline { margin-top: 0; }
  .error { margin-top: 6px; font-size: 11px; color: #ff8a80; }
  .footer { margin-top: 8px; font-size: 10px; color: #6b7580; }
`

function OverlayApp({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tagCategoryByPlayer, setTagCategoryByPlayer] = useState<Record<string, 'Offensive' | 'Defensive'>>({})
  const [minimized, setMinimized] = useState(false)
  const [stoppingPlayers, setStoppingPlayers] = useState<Set<string>>(new Set())
  const [stopCountdowns, setStopCountdowns] = useState<Record<string, number>>({})
  const [showAddPlayer, setShowAddPlayer] = useState(false)
  const [newPlayerName, setNewPlayerName] = useState('')

  async function refresh() {
    try {
      const res = await sendMessage<StateSnapshot>({ type: 'GET_STATE' })
      if (!res.match.matchActive) {
        onClose()
        return
      }
      setState(res)
    } catch {
      // Extension context invalidated (e.g. reloaded) — stop polling quietly.
      onClose()
    }
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (Object.keys(stopCountdowns).length === 0) return
    const id = setTimeout(() => {
      setStopCountdowns((prev) => {
        const next: Record<string, number> = {}
        for (const [player, secondsLeft] of Object.entries(prev)) {
          if (secondsLeft > 1) next[player] = secondsLeft - 1
        }
        return next
      })
    }, 1000)
    return () => clearTimeout(id)
  }, [stopCountdowns])

  async function call(message: Parameters<typeof sendMessage>[0]) {
    setError(null)
    const res = await sendMessage<StateSnapshot & { error?: string }>(message)
    if (res && 'error' in res && res.error) {
      setError(res.error)
      return
    }
    setState(res)
  }

  if (!state) return null

  const { match, playerRecordingStatus, currentMinute, settings } = state

  function statusFor(player: string): RecordingStatus {
    return playerRecordingStatus[player] ?? 'idle'
  }

  // The chip itself is the toggle: idle → click starts that player's clip,
  // recording → click stops it. Any number of players can be mid-clip at
  // once, each independently.
  async function handleChipClick(player: string) {
    setError(null)
    const status = statusFor(player)
    if (status === 'idle') {
      try {
        await call({ type: 'START_RECORDING', playerName: player })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } else if (status === 'recording') {
      setStoppingPlayers((prev) => new Set(prev).add(player))
      if (settings.postRollEnabled) setStopCountdowns((prev) => ({ ...prev, [player]: settings.postRollSeconds }))
      try {
        await call({ type: 'STOP_RECORDING', playerName: player })
      } finally {
        setStoppingPlayers((prev) => {
          const next = new Set(prev)
          next.delete(player)
          return next
        })
        setStopCountdowns((prev) => {
          const { [player]: _drop, ...rest } = prev
          return rest
        })
      }
    }
  }

  async function handleAddPlayer() {
    const name = newPlayerName.trim()
    if (!name) return
    await call({ type: 'ADD_PLAYER', playerName: name })
    setNewPlayerName('')
    setShowAddPlayer(false)
    // The point of adding someone mid-match is always "clip them right
    // now" — immediately start their recording rather than requiring a
    // separate chip click after.
    try {
      await call({ type: 'START_RECORDING', playerName: name })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const recordingPlayers = match.players.filter((p) => statusFor(p) === 'recording')

  if (minimized) {
    return (
      <div className="pill" onClick={() => setMinimized(false)}>
        <span className={`dot ${recordingPlayers.length > 0 ? 'recording' : ''}`} />
        {recordingPlayers.length > 0 ? `${recordingPlayers.length} recording` : match.matchInfo || 'Scout Clip Recorder'}
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="header">
        <span className="title" title={match.matchInfo}>
          {match.matchInfo}
        </span>
        <div className="header-btns">
          <button onClick={() => setMinimized(true)} title="Minimize">
            –
          </button>
          <button onClick={onClose} title="Close">
            ✕
          </button>
        </div>
      </div>

      <div className="player-rows">
        {match.players.map((p) => {
          const status = statusFor(p)
          const countdown = stopCountdowns[p]
          const tagCategory = tagCategoryByPlayer[p] ?? null
          // See the popup's identical comment: the backend's own 'stopping'
          // status isn't visible to this same caller until the whole
          // STOP_RECORDING call (including the post-roll wait) resolves.
          const isLocallyStopping = stoppingPlayers.has(p)
          const busy = isLocallyStopping || status === 'stopping' || status === 'pending-tag' || status === 'saving'
          return (
            <div key={p} className="player-record-row">
              <button
                className={`chip player-chip ${status === 'recording' && !isLocallyStopping ? 'live' : ''} ${busy ? 'busy' : ''}`}
                disabled={busy}
                onClick={() => handleChipClick(p)}
              >
                {status === 'recording' && !isLocallyStopping && <span className="rec-dot" />}
                {p}
                {status === 'saving' ? ' · saving…' : ''}
              </button>
              {countdown != null && <span className="status inline">+{countdown}s</span>}

              {status === 'pending-tag' && (
                <div className="tag-panel inline">
                  <div className="category-row">
                    <button
                      className={tagCategory === 'Offensive' ? 'primary' : ''}
                      onClick={() => setTagCategoryByPlayer((prev) => ({ ...prev, [p]: 'Offensive' }))}
                    >
                      Offensive
                    </button>
                    <button
                      className={tagCategory === 'Defensive' ? 'primary' : ''}
                      onClick={() => setTagCategoryByPlayer((prev) => ({ ...prev, [p]: 'Defensive' }))}
                    >
                      Defensive
                    </button>
                  </div>
                  {tagCategory && (
                    <div className="subcategory-grid">
                      {settings.actionCategories[tagCategory].map((sub) => (
                        <button
                          key={sub}
                          onClick={() => {
                            call({ type: 'CONFIRM_SAVE', playerName: p, actionType: `${tagCategory} ${sub}` })
                            setTagCategoryByPlayer((prev) => {
                              const { [p]: _drop, ...rest } = prev
                              return rest
                            })
                          }}
                        >
                          {sub}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="category-row">
                    <button
                      onClick={() => {
                        call({ type: 'CONFIRM_SAVE', playerName: p, actionType: null })
                        setTagCategoryByPlayer((prev) => {
                          const { [p]: _drop, ...rest } = prev
                          return rest
                        })
                      }}
                    >
                      Save without tag
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        call({ type: 'DISCARD_CLIP', playerName: p })
                        setTagCategoryByPlayer((prev) => {
                          const { [p]: _drop, ...rest } = prev
                          return rest
                        })
                      }}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {!showAddPlayer && (
          <button className="chip" title="Add player" onClick={() => setShowAddPlayer(true)}>
            +
          </button>
        )}
      </div>

      {showAddPlayer && (
        <div className="add-player-row">
          <input
            type="text"
            autoFocus
            value={newPlayerName}
            onChange={(e) => setNewPlayerName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddPlayer()
              if (e.key === 'Escape') {
                setShowAddPlayer(false)
                setNewPlayerName('')
              }
            }}
            placeholder="New player name"
          />
          <button className="primary" onClick={handleAddPlayer}>
            Add
          </button>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="footer">
        min {currentMinute} · {match.clips.length} clip{match.clips.length === 1 ? '' : 's'}
      </div>
    </div>
  )
}

function createOverlay() {
  if (document.getElementById(HOST_ID)) return

  const host = document.createElement('div')
  host.id = HOST_ID
  // `all: initial` resets whatever the host page's CSS would otherwise
  // inherit onto this element (font, color, etc.) before the shadow
  // boundary takes over — belt-and-suspenders with Shadow DOM's own
  // encapsulation, which blocks outward leakage but not all inheritance.
  host.style.cssText = 'all: initial; position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;'
  document.body.appendChild(host)

  // Shadow DOM isolates styling and DOM queries, but NOT event bubbling —
  // an event inside the shadow tree still bubbles out through the host into
  // the page's own document. Some sites (live-TV/streaming pages especially)
  // attach page-wide click listeners that hijack focus or open ads on ANY
  // click anywhere on the page, which was firing for clicks on our own
  // buttons too. Keyboard events leak the same way — typing a player name
  // into the "Add player" input bubbled out as keydown/keyup on the page's
  // document, which sites with global keyboard shortcuts (YouTube: k/m/j/l,
  // arrow keys, ...) happily acted on while the scout was just trying to
  // type a name.
  //
  // This MUST be a bubble-phase listener (no `true` third arg), not capture.
  // Capture fires on the way *in*, before the event ever reaches the actual
  // button/input inside the shadow tree — stopPropagation() there kills it
  // before React's own handlers (which run on the container inside the
  // shadow tree) ever see it, which is exactly what a first attempt at this
  // did: it made the whole overlay unresponsive, not just quieter. Bubble
  // phase fires only after the event has already worked its way back up
  // through React's handling, so it only blocks it from continuing further
  // out to the page beyond this point.
  const stopLeaking = (e: Event) => e.stopPropagation()
  for (const type of [
    'click',
    'mousedown',
    'mouseup',
    'pointerdown',
    'pointerup',
    'keydown',
    'keyup',
    'keypress',
  ]) {
    host.addEventListener(type, stopLeaking)
  }

  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = OVERLAY_CSS
  shadow.appendChild(style)
  const container = document.createElement('div')
  shadow.appendChild(container)

  createRoot(container).render(<OverlayApp onClose={() => host.remove()} />)
}

function destroyOverlay() {
  document.getElementById(HOST_ID)?.remove()
}

/**
 * The OVERLAY_SHOULD_SHOW check below only fires once, at this script's own
 * load time — a content script has no way to re-run itself later. Without
 * this listener, a scout who was already on the broadcast tab *before*
 * clicking Start Match would need to refresh the page for the overlay to
 * ever appear (the already-loaded, dormant script would have no way to find
 * out a match started afterward). Instead, START_MATCH pushes this directly
 * to the match's tab (chrome.tabs.sendMessage in background/index.ts) the
 * moment it's actually needed, so no refresh is required either way.
 *
 * OVERLAY_DEACTIVATE is the reverse case: RETARGET_BROADCAST_TAB (some
 * sites open the actual video in a different tab than the one the scout
 * started the match from) moves the match to a different tab — the old
 * tab's overlay would otherwise sit there indefinitely, since it only ever
 * unmounts itself when the match ends entirely, not when it's simply no
 * longer the relevant tab.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'OVERLAY_ACTIVATE') createOverlay()
  if (message?.type === 'OVERLAY_DEACTIVATE') destroyOverlay()
})

async function init() {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'OVERLAY_SHOULD_SHOW' })) as { shouldShow?: boolean }
    if (res?.shouldShow) createOverlay()
  } catch {
    // Extension context invalidated, or background not ready yet — the
    // OVERLAY_ACTIVATE listener above still covers the normal case (match
    // started after this script loaded), so bail quietly rather than retry.
  }
}

init()
