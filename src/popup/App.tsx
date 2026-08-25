import { useEffect, useState } from 'react'
import { sendMessage, type StateSnapshot } from '../lib/messages'
import {
  DEFAULT_ACTION_CATEGORIES,
  GAME_SPEED_OPTIONS,
  MAX_LINEUP_IMAGES,
  MAX_ROLL_SECONDS,
  MIN_ROLL_SECONDS,
  type ActionCategoryName,
  type RecordingSettings,
  type RecordingStatus,
} from '../lib/types'
import { openRegionPickerOnActiveTab } from '../lib/regionPicker'
import { formatRawNotes, GENERAL_NOTE_LABEL } from '../lib/notes'
import { formatMmSs } from '../lib/time'
import { readFileAsDataUrl, resizeImageDataUrl } from '../lib/image'
import {
  checkFolderPermission,
  clearFolderHandle,
  loadFolderHandle,
  requestFolderPermission,
  saveFolderHandle,
  type FolderPermissionState,
} from '../lib/folderHandleStore'

/** Sentinel key for the general (not-tied-to-a-player) note field/target, alongside real player names in the same open-fields list. */
const GENERAL_NOTE_KEY = '__general__'

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
  return formatMmSs(elapsedMs + extra)
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
  // Starred (highlight-worthy) is chosen in the tag panel, independent of
  // category, before the category/No tag click that actually saves the
  // clip — baked into the filename (HL prefix) at that point, since a
  // downloaded file can't be renamed after the fact.
  const [starredByPlayer, setStarredByPlayer] = useState<Record<string, boolean>>({})
  const [stoppingPlayers, setStoppingPlayers] = useState<Set<string>>(new Set())
  const [stopCountdowns, setStopCountdowns] = useState<Record<string, number>>({})
  const [regionPickerBusy, setRegionPickerBusy] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [showClips, setShowClips] = useState(false)
  // Which players' clip groups are collapsed in the Clips section — starts
  // empty (everyone expanded, matching prior behavior); collapsing specific
  // groups is how a scout cuts down scrolling once there are several
  // players with several clips each.
  const [collapsedClipPlayers, setCollapsedClipPlayers] = useState<Set<string>>(new Set())
  const [showSettings, setShowSettings] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<RecordingSettings | null>(null)
  // Export folder: plumbing only for now (Phase 2) — nothing writes through
  // this yet, it just lets a scout pick and persist a folder handle ahead
  // of Notes/Clips export actually using it. Lives outside settingsDraft
  // since a FileSystemDirectoryHandle isn't JSON-serializable and can't go
  // through SET_SETTINGS/chrome.storage the way the rest of Settings does.
  const [exportFolderName, setExportFolderName] = useState<string | null>(null)
  const [exportFolderPermission, setExportFolderPermission] = useState<FolderPermissionState>('none')
  const [folderBusy, setFolderBusy] = useState(false)
  const [gameSpeedInput, setGameSpeedInput] = useState(1)
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set())
  const [compiling, setCompiling] = useState(false)
  // 'tag' (Untagged -> Offensive -> Defensive) is the default per the
  // scout's usual workflow (untagged clips are b-roll-style and go first);
  // starred clips always lead regardless of this choice — see
  // sortClipsForCompilation in background/index.ts.
  const [compileOrder, setCompileOrder] = useState<'tag' | 'number'>('tag')
  const [showAddPlayer, setShowAddPlayer] = useState(false)
  const [newPlayerName, setNewPlayerName] = useState('')
  const [retargeting, setRetargeting] = useState(false)
  // Note-taking: any number of note fields can be open at once (one per
  // player, plus at most one general), stacked above the roster rather than
  // inline per-chip, so writing a note never blocks clicking a chip to
  // record something that just happened. openNoteTargets is ordered (stable
  // stacking); noteDrafts holds each field's in-progress text keyed the
  // same way.
  const [openNoteTargets, setOpenNoteTargets] = useState<string[]>([])
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [showNotes, setShowNotes] = useState(false)
  // Lineup: reference-only screenshot + free text, purely a glance-at panel
  // (no parsing/linking to the roster). Text is edited locally and only
  // sent to the background on blur, so we're not firing a message per
  // keystroke; lineupTextDirty tracks whether the local draft has diverged
  // from state so a stale draft doesn't clobber a freshly loaded snapshot.
  const [showLineup, setShowLineup] = useState(false)
  const [lineupTextDraft, setLineupTextDraft] = useState<string | null>(null)
  const [lineupImageBusy, setLineupImageBusy] = useState(false)
  // Set while viewing one lineup image full-size — the popup temporarily
  // widens (see the lightbox-active body class below) since its default
  // 280px is nowhere near enough to read a lineup screenshot.
  const [lightboxImage, setLightboxImage] = useState<string | null>(null)

  useEffect(() => {
    document.body.classList.toggle('lightbox-active', lightboxImage != null)
  }, [lightboxImage])

  useEffect(() => {
    sendMessage<StateSnapshot>({ type: 'GET_STATE' }).then(setState)
  }, [])

  useEffect(() => {
    refreshFolderStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function refreshFolderStatus() {
    const handle = await loadFolderHandle()
    setExportFolderName(handle?.name ?? null)
    setExportFolderPermission(await checkFolderPermission(handle))
  }

  async function handleChooseFolder() {
    setFolderBusy(true)
    setError(null)
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      await saveFolderHandle(handle)
      await refreshFolderStatus()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setFolderBusy(false)
    }
  }

  async function handleRegrantFolderAccess() {
    const handle = await loadFolderHandle()
    if (!handle) return
    setFolderBusy(true)
    setError(null)
    try {
      const granted = await requestFolderPermission(handle)
      setExportFolderPermission(granted ? 'granted' : 'needs-regrant')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setFolderBusy(false)
    }
  }

  async function handleClearExportFolder() {
    await clearFolderHandle()
    setExportFolderName(null)
    setExportFolderPermission('none')
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

  if (lightboxImage) {
    return (
      <div>
        <div className="header-row">
          <span className="match-title">Lineup screenshot</span>
          <button className="icon-btn" title="Close" aria-label="Close" onClick={() => setLightboxImage(null)}>
            ✕
          </button>
        </div>
        <img className="lightbox-full-image" src={lightboxImage} alt="Lineup screenshot, full size" />
      </div>
    )
  }

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

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.includeMinuteInNotes}
            onChange={(e) => setSettingsDraft({ ...draft, includeMinuteInNotes: e.target.checked })}
          />
          Show the match minute alongside each note
        </label>

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

        <div className="status-line" style={{ marginTop: 16, fontWeight: 600, color: '#e8ecef' }}>
          Export folder
        </div>
        <div className="status-line" style={{ marginTop: 2 }}>
          {exportFolderName
            ? `Selected: ${exportFolderName}`
            : "Not set — not used by anything yet, this just gets the folder picked and ready ahead of Notes/Clips export."}
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button disabled={folderBusy} onClick={handleChooseFolder}>
            {exportFolderName ? 'Change folder…' : 'Choose folder…'}
          </button>
          {exportFolderPermission === 'needs-regrant' && (
            <button disabled={folderBusy} onClick={handleRegrantFolderAccess}>
              Re-grant access
            </button>
          )}
          {exportFolderName && (
            <button disabled={folderBusy} onClick={handleClearExportFolder}>
              Clear
            </button>
          )}
        </div>

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

  const { match, playerRecordingStatus, currentMinute, lastSavedPath, lastCompilationPath, lastNoteExportStatus, settings } =
    state

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

  function clearTagState(player: string) {
    setTagCategoryByPlayer((prev) => {
      const { [player]: _drop, ...rest } = prev
      return rest
    })
    setStarredByPlayer((prev) => {
      const { [player]: _drop, ...rest } = prev
      return rest
    })
  }

  async function handleCompile() {
    if (selectedClipIds.size === 0) return
    setError(null)
    setCompiling(true)
    try {
      await call({ type: 'COMPILE_CLIPS', clipIds: Array.from(selectedClipIds), order: compileOrder })
      setSelectedClipIds(new Set())
    } finally {
      setCompiling(false)
    }
  }

  function toggleClipGroupCollapsed(player: string) {
    setCollapsedClipPlayers((prev) => {
      const next = new Set(prev)
      if (next.has(player)) next.delete(player)
      else next.add(player)
      return next
    })
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

  function toggleNoteField(target: string) {
    setOpenNoteTargets((prev) => (prev.includes(target) ? prev.filter((t) => t !== target) : [...prev, target]))
  }

  function closeNoteField(target: string) {
    setOpenNoteTargets((prev) => prev.filter((t) => t !== target))
    setNoteDrafts((prev) => {
      const { [target]: _drop, ...rest } = prev
      return rest
    })
  }

  async function handleSendNote(target: string) {
    const text = (noteDrafts[target] ?? '').trim()
    if (!text) {
      closeNoteField(target)
      return
    }
    const playerName = target === GENERAL_NOTE_KEY ? null : target
    try {
      await call({ type: 'ADD_NOTE', playerName, text })
      closeNoteField(target)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCopyRawNotes() {
    const text = formatRawNotes(match.notes, match.players, settings.includeMinuteInNotes)
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCopyNotesFor(player: string | null) {
    const notes = match.notes.filter((n) => n.playerName === player)
    const text = formatRawNotes(notes, player === null ? [] : [player], settings.includeMinuteInNotes)
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleLineupTextBlur() {
    if (lineupTextDraft === null || lineupTextDraft === match.lineup.text) return
    await call({ type: 'SET_LINEUP_TEXT', text: lineupTextDraft })
    setLineupTextDraft(null)
  }

  async function handleLineupFile(file: File | null) {
    if (!file || !file.type.startsWith('image/')) return
    if (match.lineup.imageDataUrls.length >= MAX_LINEUP_IMAGES) {
      setError(`Up to ${MAX_LINEUP_IMAGES} lineup images.`)
      return
    }
    setLineupImageBusy(true)
    setError(null)
    try {
      const raw = await readFileAsDataUrl(file)
      const resized = await resizeImageDataUrl(raw)
      await call({ type: 'ADD_LINEUP_IMAGE', imageDataUrl: resized })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLineupImageBusy(false)
    }
  }

  async function handleRemoveLineupImage(index: number) {
    await call({ type: 'REMOVE_LINEUP_IMAGE', index })
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

      {openNoteTargets.length > 0 && (
        <div className="note-fields">
          {openNoteTargets.map((target) => (
            <div key={target} className="note-field-row">
              <div className="note-field-label">
                <span>Note for: {target === GENERAL_NOTE_KEY ? GENERAL_NOTE_LABEL : target}</span>
                <button
                  className="icon-btn"
                  title="Cancel note"
                  aria-label="Cancel note"
                  onClick={() => closeNoteField(target)}
                >
                  ✕
                </button>
              </div>
              <input
                type="text"
                autoFocus
                value={noteDrafts[target] ?? ''}
                onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [target]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSendNote(target)
                  if (e.key === 'Escape') closeNoteField(target)
                }}
                placeholder="Type a note, Enter to save…"
              />
            </div>
          ))}
        </div>
      )}

      <div className="player-rows">
        {match.players.map((p) => {
          const status = statusFor(p)
          const countdown = stopCountdowns[p]
          const tagCategory = tagCategoryByPlayer[p] ?? null
          const starred = starredByPlayer[p] ?? false
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
              <div className="player-chip-row">
                <button
                  className={`chip player-chip ${status === 'recording' && !isLocallyStopping ? 'live' : ''} ${busy ? 'busy' : ''}`}
                  disabled={busy}
                  onClick={() => handleChipClick(p)}
                >
                  {status === 'recording' && !isLocallyStopping && <span className="rec-dot" />}
                  {p}
                  {status === 'saving' ? ' · saving…' : ''}
                </button>
                <button className="icon-btn" title="Add note" aria-label={`Note for ${p}`} onClick={() => toggleNoteField(p)}>
                  ✎
                </button>
                {status === 'idle' && (
                  <button
                    className="icon-btn"
                    title="Remove player"
                    aria-label={`Remove ${p}`}
                    onClick={() => handleDeletePlayer(p)}
                  >
                    ✕
                  </button>
                )}
              </div>
              {countdown != null && <span className="status-line inline">+{countdown}s</span>}

              {status === 'pending-tag' && (
                <div className="tag-panel inline">
                  <button
                    className={`full star-toggle ${starred ? 'primary' : ''}`}
                    onClick={() => setStarredByPlayer((prev) => ({ ...prev, [p]: !starred }))}
                  >
                    {starred ? '★ Highlight' : '☆ Mark as highlight'}
                  </button>
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
                            call({ type: 'CONFIRM_SAVE', playerName: p, actionType: `${tagCategory} ${sub}`, starred })
                            clearTagState(p)
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
                        call({ type: 'CONFIRM_SAVE', playerName: p, actionType: null, starred })
                        clearTagState(p)
                      }}
                    >
                      No tag
                    </button>
                    <button
                      className="danger"
                      style={{ flex: 1 }}
                      onClick={() => {
                        call({ type: 'DISCARD_CLIP', playerName: p })
                        clearTagState(p)
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
        <button className="chip" title="General note" onClick={() => toggleNoteField(GENERAL_NOTE_KEY)}>
          ✎ General
        </button>
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
              const collapsed = collapsedClipPlayers.has(player)
              return (
              <div key={player} className="clip-group">
                <div className="clip-group-header">
                  <button
                    className="icon-btn clip-group-toggle"
                    title={collapsed ? 'Expand' : 'Collapse'}
                    aria-label={collapsed ? `Expand ${player}'s clips` : `Collapse ${player}'s clips`}
                    onClick={() => toggleClipGroupCollapsed(player)}
                  >
                    {collapsed ? '▸' : '▾'}
                  </button>
                  <label className="clip-select-all">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => setPlayerClipsSelected(playerClipIds, !allSelected)}
                    />
                    <span>
                      {player} ({playerClips.length})
                    </span>
                  </label>
                  {isActivePlayer && (
                    <button className="icon-btn" title="Remove player" aria-label="Remove player" onClick={() => handleDeletePlayer(player)}>
                      ✕
                    </button>
                  )}
                </div>
                {!collapsed &&
                  playerClips
                  .sort((a, b) => a.timestampMs - b.timestampMs)
                  .map((clip, i) => (
                    <div key={i} className="clip-row">
                      <label className="clip-select">
                        <input
                          type="checkbox"
                          checked={selectedClipIds.has(clip.clipId)}
                          onChange={() => toggleClipSelected(clip.clipId)}
                        />
                        <span>
                          {clip.starred ? '★ ' : ''}#{clip.clipNumber} · {clip.actionType ?? 'Untagged'} ·{' '}
                          {formatMmSs(clip.timestampMs)}
                        </span>
                      </label>
                      <div className="row" style={{ gap: 4 }}>
                        <button onClick={() => chrome.downloads.show(clip.downloadId)}>Show</button>
                        <button onClick={() => handleDeleteClip(clip.clipId, `${clip.actionType ?? 'Untagged'} · ${formatMmSs(clip.timestampMs)}`)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
              )
            })
          }

          <label className="status-line" style={{ marginTop: 8, marginBottom: 0, display: 'block' }}>
            Order
          </label>
          <div className="category-row">
            <button
              className={compileOrder === 'tag' ? 'primary' : ''}
              onClick={() => setCompileOrder('tag')}
            >
              By tag
            </button>
            <button
              className={compileOrder === 'number' ? 'primary' : ''}
              onClick={() => setCompileOrder('number')}
            >
              By clip number
            </button>
          </div>
          <div className="status-line" style={{ marginTop: 4 }}>
            Starred (★) clips always lead, regardless of order. Compiles export as WebM. To convert to MP4, use a
            free tool like{' '}
            <a href="https://www.openshot.org/" target="_blank" rel="noreferrer">
              OpenShot
            </a>
            .
          </div>
          <button
            className="primary full"
            disabled={selectedClipIds.size === 0 || compiling}
            onClick={handleCompile}
          >
            {compiling ? 'Compiling…' : `Compile selected (${selectedClipIds.size})`}
          </button>
        </div>
      )}

      <button className="clip-toggle" onClick={() => setShowNotes((s) => !s)}>
        Notes ({match.notes.length}) {showNotes ? '▲' : '▼'}
      </button>

      {lastNoteExportStatus && (
        <div className="status-line" style={{ marginTop: 0, color: lastNoteExportStatus.ok ? '#7f8b94' : '#ff8a80' }}>
          {lastNoteExportStatus.detail}
        </div>
      )}

      {showNotes && match.notes.length > 0 && (
        <div className="clip-list">
          {[null, ...match.players].map((player) => {
            const playerNotes = match.notes.filter((n) => n.playerName === player)
            if (playerNotes.length === 0) return null
            return (
              <div key={player ?? GENERAL_NOTE_KEY} className="clip-group">
                <div className="clip-group-header">
                  <span>{player ?? GENERAL_NOTE_LABEL}</span>
                  <button className="icon-btn" title="Copy raw notes for this" aria-label="Copy raw notes for this" onClick={() => handleCopyNotesFor(player)}>
                    ⧉
                  </button>
                </div>
                {playerNotes.map((note) => (
                  <div key={note.id} className="clip-row">
                    <span>
                      {note.text}
                      {settings.includeMinuteInNotes ? ` (${formatMmSs(note.timestampMs)})` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )
          })}
          <button className="full" onClick={handleCopyRawNotes}>
            Copy all raw notes
          </button>
        </div>
      )}

      <button className="clip-toggle" onClick={() => setShowLineup((s) => !s)}>
        Lineup {showLineup ? '▲' : '▼'}
      </button>

      {showLineup && (
        <div className="clip-list">
          <div className="lineup-images-grid">
            {match.lineup.imageDataUrls.map((url, i) => (
              <div key={i} className="lineup-thumb-wrap">
                <img
                  className="lineup-thumb"
                  src={url}
                  alt={`Lineup screenshot ${i + 1}`}
                  onClick={() => setLightboxImage(url)}
                />
                <button
                  className="icon-btn lineup-thumb-remove"
                  title="Remove image"
                  aria-label={`Remove lineup screenshot ${i + 1}`}
                  onClick={() => handleRemoveLineupImage(i)}
                >
                  ✕
                </button>
              </div>
            ))}
            {match.lineup.imageDataUrls.length < MAX_LINEUP_IMAGES && (
              <label className="lineup-dropzone lineup-thumb-add">
                {lineupImageBusy ? '…' : '+ Add'}
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => handleLineupFile(e.target.files?.[0] ?? null)}
                />
              </label>
            )}
          </div>
          <div className="status-line" style={{ marginTop: 0 }}>
            Click a thumbnail to view it full-size, or paste (Ctrl+V) a screenshot into the box below to add it.
          </div>
          <textarea
            className="lineup-textarea"
            placeholder="Type or paste the lineup…"
            value={lineupTextDraft ?? match.lineup.text}
            onChange={(e) => setLineupTextDraft(e.target.value)}
            onBlur={handleLineupTextBlur}
            onPaste={(e) => {
              const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'))
              const file = item?.getAsFile()
              if (file) {
                e.preventDefault()
                void handleLineupFile(file)
              }
            }}
          />
        </div>
      )}
    </div>
  )
}
