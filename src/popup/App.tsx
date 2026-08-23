import { useEffect, useState } from 'react'
import { sendMessage, type StateSnapshot } from '../lib/messages'
import {
  DEFAULT_ACTION_CATEGORIES,
  GAME_SPEED_OPTIONS,
  MAX_ROLL_SECONDS,
  MIN_ROLL_SECONDS,
  type ActionCategoryName,
  type RecordingSettings,
  type RecordingStatus,
} from '../lib/types'
import { openRegionPickerOnActiveTab } from '../lib/regionPicker'

function getStreamIdForActiveTab(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        reject(new Error('No active tab to capture.'))
        return
      }
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError || !id) {
          reject(new Error(chrome.runtime.lastError?.message || 'Failed to get capture stream.'))
          return
        }
        resolve(id)
      })
    })
  })
}

function formatClock(elapsedMs: number, runningSinceMs: number | null, tick: number): string {
  void tick // force re-render dependency
  const extra = runningSinceMs != null ? Date.now() - runningSinceMs : 0
  const totalSec = Math.floor((elapsedMs + extra) / 1000)
  const mm = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, '0')
  const ss = (totalSec % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

function CategoryEditor({
  label,
  items,
  onChange,
}: {
  label: ActionCategoryName
  items: string[]
  onChange: (items: string[]) => void
}) {
  const [newTag, setNewTag] = useState('')

  function addTag() {
    const name = newTag.trim()
    if (!name) return
    onChange([...items, name])
    setNewTag('')
  }

  return (
    <div>
      <div className="header-row" style={{ marginTop: 10, marginBottom: 4 }}>
        <label style={{ margin: 0 }}>{label} actions</label>
        <button className="icon-btn" style={{ fontSize: 11 }} onClick={() => onChange(DEFAULT_ACTION_CATEGORIES[label])}>
          Reset
        </button>
      </div>
      <div className="chips">
        {items.map((item, i) => (
          <span key={i} className="chip tag-chip">
            {item}
            <button onClick={() => onChange(items.filter((_, idx) => idx !== i))}>✕</button>
          </span>
        ))}
      </div>
      <div className="row">
        <input
          type="text"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTag()
          }}
          placeholder={`Add ${label.toLowerCase()} action`}
        />
        <button onClick={addTag}>Add</button>
      </div>
    </div>
  )
}

export default function App() {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [matchInfoInput, setMatchInfoInput] = useState('')
  const [playerInput, setPlayerInput] = useState('')
  const [rosterDraft, setRosterDraft] = useState<string[]>([])
  // Keyed by player name — each player's tag panel (and Stop's post-roll
  // countdown) is independent, since several can be at different points of
  // the record/tag flow at once.
  const [tagCategoryByPlayer, setTagCategoryByPlayer] = useState<Record<string, 'Offensive' | 'Defensive'>>({})
  const [stoppingPlayers, setStoppingPlayers] = useState<Set<string>>(new Set())
  const [stopCountdowns, setStopCountdowns] = useState<Record<string, number>>({})
  const [regionPickerBusy, setRegionPickerBusy] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [showClips, setShowClips] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<RecordingSettings | null>(null)
  const [gameSpeedInput, setGameSpeedInput] = useState(1)
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set())
  const [compiling, setCompiling] = useState(false)
  const [exportAsMp4, setExportAsMp4] = useState(false)
  const [showAddPlayer, setShowAddPlayer] = useState(false)
  const [newPlayerName, setNewPlayerName] = useState('')
  const [retargeting, setRetargeting] = useState(false)

  useEffect(() => {
    sendMessage<StateSnapshot>({ type: 'GET_STATE' }).then(setState)
  }, [])

  useEffect(() => {
    if (!state?.match.clockRunning) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [state?.match.clockRunning])

  // Purely a local, cosmetic countdown per player — the actual post-roll
  // delay lives in the offscreen document (it must, to keep capturing) and
  // isn't reported back live; this just gives the scout a sense of progress
  // while waiting. Several can be ticking down concurrently.
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

  // Fire-and-forget: the picker overlay messages the background worker
  // directly once the scout confirms a selection (see regionPicker.ts) —
  // this popup will almost always have already closed by then, since
  // dragging on the page requires clicking into that tab. The result shows
  // up next time this popup mounts (e.g. reopening it) via GET_STATE.
  async function handleOpenRegionPicker() {
    setError(null)
    setRegionPickerBusy(true)
    try {
      await openRegionPickerOnActiveTab()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRegionPickerBusy(false)
    }
  }

  async function handleSaveSettings() {
    if (!state) return
    setError(null)
    await call({ type: 'SET_SETTINGS', settings: settingsDraft ?? state.settings })
    setSettingsDraft(null)
    setShowSettings(false)
  }

  if (!state) return <div>Loading…</div>

  if (showSettings) {
    const draft = settingsDraft ?? state.settings
    return (
      <div>
        <div className="header-row">
          <span className="match-title">Settings</span>
          <button className="icon-btn" title="Back" aria-label="Back" onClick={() => setShowSettings(false)}>
            ✕
          </button>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.preRollEnabled}
            onChange={(e) => setSettingsDraft({ ...draft, preRollEnabled: e.target.checked })}
          />
          Pre-roll: start the clip N seconds before I press Record
        </label>
        <div className="row">
          <input
            type="number"
            min={MIN_ROLL_SECONDS}
            max={MAX_ROLL_SECONDS}
            disabled={!draft.preRollEnabled}
            value={draft.preRollSeconds}
            onChange={(e) =>
              setSettingsDraft({ ...draft, preRollSeconds: Math.max(MIN_ROLL_SECONDS, Number(e.target.value) || 0) })
            }
          />
          <span className="status-line" style={{ marginTop: 0, alignSelf: 'center' }}>
            seconds
          </span>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.postRollEnabled}
            onChange={(e) => setSettingsDraft({ ...draft, postRollEnabled: e.target.checked })}
          />
          Auto-stop: keep recording N seconds after I press Stop
        </label>
        <div className="row">
          <input
            type="number"
            min={MIN_ROLL_SECONDS}
            max={MAX_ROLL_SECONDS}
            disabled={!draft.postRollEnabled}
            value={draft.postRollSeconds}
            onChange={(e) =>
              setSettingsDraft({ ...draft, postRollSeconds: Math.max(MIN_ROLL_SECONDS, Number(e.target.value) || 0) })
            }
          />
          <span className="status-line" style={{ marginTop: 0, alignSelf: 'center' }}>
            seconds
          </span>
        </div>

        <div className="status-line">
          Both are off by default — Record/Stop click exactly when you press them. Pre-roll needs continuous
          background buffering, so it only (re)arms when you hit Start Match; toggling it mid-match takes effect
          next match, not immediately.
        </div>

        <CategoryEditor
          label="Offensive"
          items={draft.actionCategories.Offensive}
          onChange={(items) =>
            setSettingsDraft({ ...draft, actionCategories: { ...draft.actionCategories, Offensive: items } })
          }
        />
        <CategoryEditor
          label="Defensive"
          items={draft.actionCategories.Defensive}
          onChange={(items) =>
            setSettingsDraft({ ...draft, actionCategories: { ...draft.actionCategories, Defensive: items } })
          }
        />

        <button className="primary record-btn" onClick={handleSaveSettings}>
          Save
        </button>
        {error && <div className="error-line">{error}</div>}
      </div>
    )
  }

  if (!state.match.matchActive) {
    return (
      <div>
        <div className="header-row">
          <span className="match-title">Start Match</span>
          <button
            className="icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={() => setShowSettings(true)}
          >
            ⚙
          </button>
        </div>
        <label>Match info (opponent, competition, date)</label>
        <input
          type="text"
          value={matchInfoInput}
          onChange={(e) => setMatchInfoInput(e.target.value)}
          placeholder="vs Dinamo - League - 2026-08-21"
        />

        <label>Add player</label>
        <div className="row">
          <input
            type="text"
            value={playerInput}
            onChange={(e) => setPlayerInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && playerInput.trim()) {
                setRosterDraft((r) => [...r, playerInput.trim()])
                setPlayerInput('')
              }
            }}
            placeholder="Player name"
          />
          <button
            onClick={() => {
              if (playerInput.trim()) {
                setRosterDraft((r) => [...r, playerInput.trim()])
                setPlayerInput('')
              }
            }}
          >
            Add
          </button>
        </div>

        {rosterDraft.length > 0 && (
          <ul className="player-list">
            {rosterDraft.map((p, i) => (
              <li key={i}>
                {p}
                <button onClick={() => setRosterDraft((r) => r.filter((_, idx) => idx !== i))}>✕</button>
              </li>
            ))}
          </ul>
        )}

        <label>Match video region (optional)</label>
        <div className="row">
          <button disabled={regionPickerBusy} onClick={handleOpenRegionPicker}>
            {regionPickerBusy
              ? 'Opening picker…'
              : state.draftCaptureRegion
                ? 'Reselect region'
                : 'Select region on current tab'}
          </button>
          {state.draftCaptureRegion && (
            <button onClick={() => call({ type: 'SET_CAPTURE_REGION', region: null })}>Clear</button>
          )}
        </div>
        <div className="status-line">
          {state.draftCaptureRegion
            ? `Region: ${Math.round(state.draftCaptureRegion.widthRatio * 100)}%×${Math.round(state.draftCaptureRegion.heightRatio * 100)}% of the tab — only this area will be recorded. Reopen this popup after selecting to see it confirmed here.`
            : 'No region selected — the full tab will be recorded. Selecting one closes this popup — reopen it afterward to continue.'}
        </div>

        <label>Watching the broadcast at</label>
        <div className="chips">
          {GAME_SPEED_OPTIONS.map((speed) => (
            <button
              key={speed}
              className={`chip ${gameSpeedInput === speed ? 'selected' : ''}`}
              onClick={() => setGameSpeedInput(speed)}
            >
              {speed}×
            </button>
          ))}
        </div>
        <div className="status-line">
          {gameSpeedInput === 1
            ? 'Clips save at normal speed.'
            : `Clips will be slowed back down ${gameSpeedInput}× so they play at real match speed, not the sped-up broadcast.`}
        </div>

        <button
          className="primary record-btn"
          disabled={!matchInfoInput.trim() || rosterDraft.length === 0}
          onClick={async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            await call({
              type: 'START_MATCH',
              matchInfo: matchInfoInput.trim(),
              players: rosterDraft,
              tabId: tab?.id,
              gameSpeed: gameSpeedInput,
            })
            if (state.settings.preRollEnabled) {
              try {
                const streamId = await getStreamIdForActiveTab()
                await call({ type: 'ARM_PRE_ROLL', streamId })
              } catch (err) {
                setError(
                  `Match started, but pre-roll couldn't arm: ${err instanceof Error ? err.message : String(err)}`,
                )
              }
            }
          }}
        >
          Start Match
        </button>
        {error && <div className="error-line">{error}</div>}
      </div>
    )
  }

  const { match, playerRecordingStatus, currentMinute, lastSavedPath, lastCompilationPath, settings } = state

  function statusFor(player: string): RecordingStatus {
    return playerRecordingStatus[player] ?? 'idle'
  }

  const anyPlayerBusy = Object.values(playerRecordingStatus).some(
    (s) => s === 'recording' || s === 'stopping' || s === 'saving',
  )

  // The chip itself is the toggle: idle → click starts that player's clip,
  // recording → click stops it. Any number of players can be mid-clip at
  // once, each independently — there's no single "selected player" anymore.
  async function handleChipClick(player: string) {
    setError(null)
    const status = statusFor(player)
    if (status === 'idle') {
      try {
        if (settings.preRollEnabled) {
          // Promotes the already-armed standby buffer — no fresh capture
          // stream needed (or wanted: it has to be the same stream that's
          // been buffering, not a new one).
          await call({ type: 'START_RECORDING', playerName: player })
        } else {
          const streamId = await getStreamIdForActiveTab()
          await call({ type: 'START_RECORDING', playerName: player, streamId })
        }
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

  async function handleNewSession() {
    setError(null)
    const hasUnsavedClip = Object.values(playerRecordingStatus).some((s) => s === 'pending-tag')
    const confirmed = window.confirm(
      hasUnsavedClip
        ? 'Start a new session? Clips still awaiting a tag will be saved as Untagged first.'
        : 'Start a new session? This clears the current match setup and clip list (already-saved clip files are not touched).',
    )
    if (!confirmed) return
    await call({ type: 'NEW_SESSION' })
  }

  async function handleRetargetTab() {
    setError(null)
    setRetargeting(true)
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) {
        setError('No active tab to switch to.')
        return
      }
      // Must fully resolve before requesting a streamId for the new tab —
      // Chrome only allows one active tabCapture stream per extension, so
      // the old tab's capture needs to actually be released first.
      await call({ type: 'PREPARE_TAB_SWITCH' })
      let preRollStreamId: string | undefined
      if (settings.preRollEnabled) {
        // Grabbed here, in this click handler, for the same reason as
        // ARM_PRE_ROLL at Start Match — needs a genuine user gesture, which
        // only the popup (not background) can supply.
        preRollStreamId = await getStreamIdForActiveTab()
      }
      await call({ type: 'RETARGET_BROADCAST_TAB', tabId: tab.id, preRollStreamId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetargeting(false)
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
      if (settings.preRollEnabled) {
        await call({ type: 'START_RECORDING', playerName: name })
      } else {
        const streamId = await getStreamIdForActiveTab()
        await call({ type: 'START_RECORDING', playerName: name, streamId })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function toggleClipSelected(clipId: string) {
    setSelectedClipIds((prev) => {
      const next = new Set(prev)
      if (next.has(clipId)) next.delete(clipId)
      else next.add(clipId)
      return next
    })
  }

  function setPlayerClipsSelected(playerClipIds: string[], selected: boolean) {
    setSelectedClipIds((prev) => {
      const next = new Set(prev)
      for (const id of playerClipIds) {
        if (selected) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function handleCompile() {
    if (selectedClipIds.size === 0) return
    setError(null)
    setCompiling(true)
    try {
      await call({ type: 'COMPILE_CLIPS', clipIds: Array.from(selectedClipIds), exportAsMp4 })
      setSelectedClipIds(new Set())
    } finally {
      setCompiling(false)
    }
  }

  async function handleDeletePlayer(player: string) {
    if (!window.confirm(`Remove ${player} from the roster? Their saved clips stay untouched and stay listed here.`)) return
    await call({ type: 'DELETE_PLAYER', playerName: player })
  }

  async function handleDeleteClip(clipId: string, label: string) {
    if (!window.confirm(`Delete "${label}" from the list? The downloaded file stays on disk.`)) return
    await call({ type: 'DELETE_CLIP', clipId })
    setSelectedClipIds((prev) => {
      if (!prev.has(clipId)) return prev
      const next = new Set(prev)
      next.delete(clipId)
      return next
    })
  }

  const lastSavedName = lastSavedPath?.split('/').pop() ?? null
  const lastCompilationName = lastCompilationPath?.split('/').pop() ?? null

  return (
    <div className="compact">
      <div className="header-row">
        <span className="match-title" title={match.matchInfo}>
          {match.matchInfo}
        </span>
        <button
          className="icon-btn"
          title="Match settings"
          aria-label="Match settings"
          onClick={() => setShowDetails((s) => !s)}
        >
          ⋯
        </button>
      </div>

      {showDetails && (
        <div className="details-panel">
          <div className="clock-row">
            <span className="clock-time">
              {formatClock(match.elapsedMs, match.runningSinceMs, tick)} · min {currentMinute}
            </span>
            <button onClick={() => call({ type: 'TOGGLE_CLOCK' })}>
              {match.clockRunning ? 'Pause' : 'Start'} clock
            </button>
          </div>
          <div className="clock-row">
            <span>
              {match.captureRegion
                ? `Region: ${Math.round(match.captureRegion.widthRatio * 100)}%×${Math.round(match.captureRegion.heightRatio * 100)}% of tab`
                : 'Recording full tab'}
            </span>
            <button disabled={regionPickerBusy || anyPlayerBusy} onClick={handleOpenRegionPicker}>
              {regionPickerBusy ? 'Opening picker…' : 'Change region'}
            </button>
          </div>
          <div className="clock-row">
            <span>Broadcast tab</span>
            <button disabled={retargeting || anyPlayerBusy} onClick={handleRetargetTab}>
              {retargeting ? 'Switching…' : 'Record from this tab instead'}
            </button>
          </div>
          <div className="status-line" style={{ marginTop: -4 }}>
            If the video actually opened in a different tab than the one you
            started the match from, switch to that tab, then tap this — it
            re-points recording there (and re-arms pre-roll if it's on).
            Clears the capture region, since it won't line up on a different
            page.
          </div>
          <div className="clock-row">
            <span>Watching at {match.gameSpeed}×</span>
            <div className="row" style={{ gap: 4 }}>
              {GAME_SPEED_OPTIONS.map((speed) => (
                <button
                  key={speed}
                  className={`chip ${match.gameSpeed === speed ? 'selected' : ''}`}
                  onClick={() => call({ type: 'SET_GAME_SPEED', gameSpeed: speed })}
                >
                  {speed}×
                </button>
              ))}
            </div>
          </div>
          {(state.settings.preRollEnabled || state.settings.postRollEnabled) && (
            <div className="clock-row">
              <span>
                {state.settings.preRollEnabled ? `Pre-roll ${state.settings.preRollSeconds}s` : ''}
                {state.settings.preRollEnabled && state.settings.postRollEnabled ? ' · ' : ''}
                {state.settings.postRollEnabled ? `Auto-stop +${state.settings.postRollSeconds}s` : ''}
                {state.settings.preRollEnabled ? (state.preRollArmed ? ' · armed' : ' · not armed') : ''}
              </span>
            </div>
          )}
          <div className="row">
            <button style={{ flex: 1 }} onClick={() => setShowSettings(true)}>
              Settings
            </button>
            <button style={{ flex: 1 }} disabled={anyPlayerBusy} onClick={handleNewSession}>
              New session
            </button>
          </div>
        </div>
      )}

      <div className="player-rows">
        {match.players.map((p) => {
          const status = statusFor(p)
          const countdown = stopCountdowns[p]
          const tagCategory = tagCategoryByPlayer[p] ?? null
          // stoppingPlayers covers the gap between clicking Stop and this
          // popup's own state actually reflecting it — the backend does set
          // 'stopping' immediately, but that's only visible to *other*
          // concurrent pollers (e.g. the overlay); this same caller's next
          // state update only arrives once the whole STOP_RECORDING call
          // (including the post-roll wait) resolves.
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
              {countdown != null && <span className="status-line inline">+{countdown}s</span>}

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
                  <div className="row">
                    <button
                      style={{ flex: 1 }}
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
                      style={{ flex: 1 }}
                      onClick={() => {
                        if (!window.confirm(`Discard ${p}'s clip? It won't be saved.`)) return
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
        <div className="row" style={{ marginBottom: 8 }}>
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

      {lastSavedName && !anyPlayerBusy && <div className="status-line">Saved: {lastSavedName}</div>}
      {lastCompilationName && <div className="status-line">Compiled: {lastCompilationName}</div>}
      {error && <div className="error-line">{error}</div>}

      <button className="clip-toggle" onClick={() => setShowClips((s) => !s)}>
        Clips ({match.clips.length}) {showClips ? '▲' : '▼'}
      </button>

      {showClips && match.clips.length > 0 && (
        <div className="clip-list">
          {
            // Grouped by whoever actually has clips, not match.players — a
            // deleted player's chip stops appearing, but their already-saved
            // clips stay listed here (tag/compile/delete still work on them)
            // exactly like the files on disk, which are also untouched.
            Array.from(new Set(match.clips.map((c) => c.playerName))).map((player) => {
              const playerClips = match.clips.filter((c) => c.playerName === player)
              const playerClipIds = playerClips.map((c) => c.clipId)
              const allSelected = playerClipIds.every((id) => selectedClipIds.has(id))
              const isActivePlayer = match.players.includes(player)
              return (
              <div key={player} className="clip-group">
                <div className="clip-group-header">
                  <label className="clip-select-all">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => setPlayerClipsSelected(playerClipIds, !allSelected)}
                    />
                    <span>{player}</span>
                  </label>
                  {isActivePlayer && (
                    <button className="icon-btn" title="Remove player" aria-label="Remove player" onClick={() => handleDeletePlayer(player)}>
                      ✕
                    </button>
                  )}
                </div>
                {playerClips
                  .sort((a, b) => a.minute - b.minute)
                  .map((clip, i) => (
                    <div key={i} className="clip-row">
                      <label className="clip-select">
                        <input
                          type="checkbox"
                          checked={selectedClipIds.has(clip.clipId)}
                          onChange={() => toggleClipSelected(clip.clipId)}
                        />
                        <span>
                          #{clip.clipNumber} · {clip.actionType ?? 'Untagged'} · {clip.minute}′
                        </span>
                      </label>
                      <div className="row" style={{ gap: 4 }}>
                        <button onClick={() => chrome.downloads.show(clip.downloadId)}>Show</button>
                        <button onClick={() => handleDeleteClip(clip.clipId, `${clip.actionType ?? 'Untagged'} · ${clip.minute}′`)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
              )
            })
          }

          <label className="checkbox-row">
            <input type="checkbox" checked={exportAsMp4} onChange={(e) => setExportAsMp4(e.target.checked)} />
            Export as MP4 (re-encodes — slower, but plays everywhere)
          </label>
          <button
            className="primary full"
            disabled={selectedClipIds.size === 0 || compiling}
            onClick={handleCompile}
          >
            {compiling ? 'Compiling…' : `Compile selected (${selectedClipIds.size})`}
          </button>
        </div>
      )}
    </div>
  )
}
