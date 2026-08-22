import { useEffect, useState } from 'react'
import { sendMessage, type StateSnapshot } from '../lib/messages'
import {
  DEFAULT_ACTION_CATEGORIES,
  GAME_SPEED_OPTIONS,
  MAX_ROLL_SECONDS,
  MIN_ROLL_SECONDS,
  type ActionCategoryName,
  type RecordingSettings,
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
  const [tagCategory, setTagCategory] = useState<'Offensive' | 'Defensive' | null>(null)
  const [regionPickerBusy, setRegionPickerBusy] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [showClips, setShowClips] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<RecordingSettings | null>(null)
  const [isStopping, setIsStopping] = useState(false)
  const [stopCountdown, setStopCountdown] = useState<number | null>(null)
  const [gameSpeedInput, setGameSpeedInput] = useState(1)
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set())
  const [compiling, setCompiling] = useState(false)
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

  // Purely a local, cosmetic countdown — the actual post-roll delay lives in
  // the offscreen document (it must, to keep capturing) and isn't reported
  // back live; this just gives the scout a sense of progress while waiting.
  useEffect(() => {
    if (stopCountdown == null || stopCountdown <= 0) return
    const id = setTimeout(() => setStopCountdown((c) => (c != null ? c - 1 : null)), 1000)
    return () => clearTimeout(id)
  }, [stopCountdown])

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
            ? `Region: ${state.draftCaptureRegion.width}×${state.draftCaptureRegion.height}px — only this area will be recorded. Reopen this popup after selecting to see it confirmed here.`
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

  const { match, recordingStatus, currentMinute, lastSavedPath, lastCompilationPath, settings } = state

  async function handleRecordClick() {
    setError(null)
    if (recordingStatus === 'idle') {
      try {
        if (settings.preRollEnabled) {
          // Promotes the already-armed standby buffer — no fresh capture
          // stream needed (or wanted: it has to be the same stream that's
          // been buffering, not a new one).
          await call({ type: 'START_RECORDING' })
        } else {
          const streamId = await getStreamIdForActiveTab()
          await call({ type: 'START_RECORDING', streamId })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } else if (recordingStatus === 'recording') {
      setIsStopping(true)
      if (settings.postRollEnabled) setStopCountdown(settings.postRollSeconds)
      try {
        await call({ type: 'STOP_RECORDING' })
      } finally {
        setIsStopping(false)
        setStopCountdown(null)
      }
    }
  }

  async function handleNewSession() {
    setError(null)
    const hasUnsavedClip = recordingStatus === 'pending-tag'
    const confirmed = window.confirm(
      hasUnsavedClip
        ? 'Start a new session? The clip awaiting a tag will be saved as Untagged first.'
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
      await call({ type: 'COMPILE_CLIPS', clipIds: Array.from(selectedClipIds) })
      setSelectedClipIds(new Set())
    } finally {
      setCompiling(false)
    }
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
                ? `Region: ${match.captureRegion.width}×${match.captureRegion.height}px`
                : 'Recording full tab'}
            </span>
            <button disabled={regionPickerBusy || recordingStatus !== 'idle'} onClick={handleOpenRegionPicker}>
              {regionPickerBusy ? 'Opening picker…' : 'Change region'}
            </button>
          </div>
          <div className="clock-row">
            <span>Broadcast tab</span>
            <button disabled={retargeting || recordingStatus !== 'idle'} onClick={handleRetargetTab}>
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
            <button
              style={{ flex: 1 }}
              disabled={recordingStatus === 'recording' || recordingStatus === 'saving'}
              onClick={handleNewSession}
            >
              New session
            </button>
          </div>
        </div>
      )}

      <div className="chips">
        {match.players.map((p) => (
          <button
            key={p}
            className={`chip ${match.selectedPlayer === p ? 'selected' : ''}`}
            onClick={() => call({ type: 'SELECT_PLAYER', playerName: p })}
          >
            {p}
          </button>
        ))}
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

      <button
        className={`record-btn ${recordingStatus === 'recording' ? 'danger' : 'primary'}`}
        disabled={
          !match.selectedPlayer || recordingStatus === 'pending-tag' || recordingStatus === 'saving' || isStopping
        }
        onClick={handleRecordClick}
      >
        {recordingStatus === 'recording' ? '■ Stop' : '● Record'}
        {!match.selectedPlayer && recordingStatus === 'idle' ? ' (select a player)' : ''}
      </button>

      {stopCountdown != null && (
        <div className="status-line">Capturing follow-through… {stopCountdown}s</div>
      )}

      {recordingStatus === 'pending-tag' && (
        <div className="tag-panel">
          <h2>Tag this clip (optional)</h2>
          <div className="category-row">
            <button
              className={tagCategory === 'Offensive' ? 'primary' : ''}
              onClick={() => setTagCategory('Offensive')}
            >
              Offensive
            </button>
            <button
              className={tagCategory === 'Defensive' ? 'primary' : ''}
              onClick={() => setTagCategory('Defensive')}
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
                    call({ type: 'CONFIRM_SAVE', actionType: `${tagCategory} ${sub}` })
                    setTagCategory(null)
                  }}
                >
                  {sub}
                </button>
              ))}
            </div>
          )}
          <button
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => {
              call({ type: 'CONFIRM_SAVE', actionType: null })
              setTagCategory(null)
            }}
          >
            Save without tag
          </button>
        </div>
      )}

      {recordingStatus === 'saving' && <div className="status-line">Saving clip…</div>}
      {lastSavedName && recordingStatus === 'idle' && <div className="status-line">Saved: {lastSavedName}</div>}
      {lastCompilationName && <div className="status-line">Compiled: {lastCompilationName}</div>}
      {error && <div className="error-line">{error}</div>}

      <button className="clip-toggle" onClick={() => setShowClips((s) => !s)}>
        Clips ({match.clips.length}) {showClips ? '▲' : '▼'}
      </button>

      {showClips && match.clips.length > 0 && (
        <div className="clip-list">
          {match.players
            .filter((p) => match.clips.some((c) => c.playerName === p))
            .map((player) => {
              const playerClips = match.clips.filter((c) => c.playerName === player)
              const playerClipIds = playerClips.map((c) => c.clipId)
              const allSelected = playerClipIds.every((id) => selectedClipIds.has(id))
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
                      <button onClick={() => chrome.downloads.show(clip.downloadId)}>Show</button>
                    </div>
                  ))}
              </div>
              )
            })}

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
