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
import { MAX_LINEUP_IMAGES, type ClipOutcome, type RecordingStatus } from '../lib/types'
import { GENERAL_NOTE_LABEL } from '../lib/notes'
import { parseRosterPaste } from '../lib/roster'
import { readFileAsDataUrl, resizeImageDataUrl } from '../lib/image'

const HOST_ID = 'scout-clip-recorder-overlay-host'
const POLL_MS = 3000
/** Sentinel key for the general (not-tied-to-a-player) note field/target, alongside real player names in the same open-fields list. */
const GENERAL_NOTE_KEY = '__general__'

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
  .player-chip-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
  .team-badge { font-size: 9px; padding: 2px 5px; min-width: 16px; text-align: center; }
  .team-toggle-group { display: inline-flex; align-items: center; gap: 2px; }
  .team-rename-input { padding: 4px 7px; border-radius: 999px; border: 1px solid #2f6feb; background: #1a2027; color: #e8ecef; font-size: 11px; width: 90px; font-family: inherit; }
  .position-input { width: 36px; box-sizing: border-box; padding: 2px 3px; font-size: 9px; border: none; background: transparent; color: #e8ecef; border-radius: 4px; flex-shrink: 0; font-family: inherit; }
  .position-input::placeholder { color: #3a444d; }
  .position-input:not(:placeholder-shown) { background: #1a2027; border: 1px solid #2b333a; }
  .position-input:focus { background: #1a2027; border: 1px solid #2f6feb; outline: none; }
  .reorder-panel { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .reorder-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 7px; background: #1a2027; border-radius: 6px; font-size: 11px; }
  .reorder-row button { padding: 1px 6px; font-size: 10px; }
  .note-fields { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .note-field-row { background: #1a2027; border: 1px solid #2b333a; border-radius: 8px; padding: 6px 8px; }
  .note-field-label { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: #9aa4ad; margin-bottom: 4px; }
  .note-field-label button { padding: 2px 6px; font-size: 10px; }
  .note-field-row input[type='text'] { width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 6px; border: 1px solid #2b333a; background: #101418; color: #e8ecef; font-size: 12px; font-family: inherit; }
  .player-chip { display: inline-flex; align-items: center; gap: 6px; }
  .player-chip.live { background: #d1453b; border-color: #d1453b; color: white; font-weight: 600; }
  .player-chip.busy { opacity: 0.6; }
  .chip-remove { padding: 2px 7px; font-size: 11px; flex-shrink: 0; }
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
  .star-toggle { margin-bottom: 6px; }
  .star-toggle.primary { background: #caa53d; border-color: #caa53d; color: #1a1400; }
  .outcome-btn.successful.active { background: #2e8b57; border-color: #2e8b57; color: white; font-weight: 600; }
  .outcome-btn.unsuccessful.active { background: #d1453b; border-color: #d1453b; color: white; font-weight: 600; }
  .status { margin-top: 6px; font-size: 11px; color: #9aa4ad; }
  .status.inline { margin-top: 0; }
  .error { margin-top: 6px; font-size: 11px; color: #ff8a80; }
  .footer { margin-top: 8px; font-size: 10px; color: #6b7580; }
  .lineup-toggle { width: 100%; margin-bottom: 8px; background: transparent; border-color: #2b333a; color: #9aa4ad; font-size: 11px; padding: 5px; }
  .lineup-panel { margin-bottom: 8px; }
  .lineup-images-grid { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
  .lineup-thumb-wrap { position: relative; width: 50px; height: 50px; }
  .lineup-thumb { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; background: #1a2027; border: 1px solid #2b333a; cursor: pointer; display: block; }
  .lineup-thumb-remove { position: absolute; top: -6px; right: -6px; padding: 0 5px; font-size: 9px; line-height: 1.6; border-radius: 999px; background: #1a2027; }
  .lineup-dropzone, .lineup-thumb-add { display: flex; align-items: center; justify-content: center; text-align: center; border: 1px dashed #2b333a; border-radius: 8px; font-size: 10px; color: #9aa4ad; cursor: pointer; }
  .lineup-thumb-add { width: 50px; height: 50px; padding: 0; font-size: 9px; }
  .lineup-dropzone:hover, .lineup-thumb-add:hover { border-color: #3a444d; color: #e8ecef; }
  .lineup-textarea { width: 100%; box-sizing: border-box; min-height: 70px; margin-top: 6px; padding: 7px; border-radius: 6px; border: 1px solid #2b333a; background: #1a2027; color: #e8ecef; font-size: 12px; font-family: inherit; resize: vertical; }
  .lightbox-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 2147483647; cursor: pointer; }
  .lightbox-content { position: relative; max-width: 92vw; max-height: 92vh; cursor: default; }
  .lightbox-img { display: block; max-width: 92vw; max-height: 92vh; object-fit: contain; border-radius: 8px; }
  .lightbox-close { position: absolute; top: -12px; right: -12px; padding: 4px 9px; font-size: 13px; border-radius: 999px; }
`

function OverlayApp({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tagCategoryByPlayer, setTagCategoryByPlayer] = useState<Record<string, 'Offensive' | 'Defensive'>>({})
  const [starredByPlayer, setStarredByPlayer] = useState<Record<string, boolean>>({})
  const [outcomeByPlayer, setOutcomeByPlayer] = useState<Record<string, ClipOutcome>>({})
  const [minimized, setMinimized] = useState(false)
  const [stoppingPlayers, setStoppingPlayers] = useState<Set<string>>(new Set())
  const [stopCountdowns, setStopCountdowns] = useState<Record<string, number>>({})
  const [showAddPlayer, setShowAddPlayer] = useState(false)
  const [newPlayerName, setNewPlayerName] = useState('')
  const [showRosterPaste, setShowRosterPaste] = useState(false)
  const [rosterPasteText, setRosterPasteText] = useState('')
  const [activeTeamFilters, setActiveTeamFilters] = useState<Set<string>>(new Set())
  const [renamingTeam, setRenamingTeam] = useState<string | null>(null)
  const [showReorderPlayers, setShowReorderPlayers] = useState(false)
  const [positionDrafts, setPositionDrafts] = useState<Record<string, string>>({})
  // Note-taking: any number of note fields can be open at once (one per
  // player, plus at most one general), stacked above the roster rather than
  // inline per-chip, so writing a note never blocks clicking a chip to
  // record something that just happened.
  const [openNoteTargets, setOpenNoteTargets] = useState<string[]>([])
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [showLineup, setShowLineup] = useState(false)
  const [lineupTextDraft, setLineupTextDraft] = useState<string | null>(null)
  const [lineupImageBusy, setLineupImageBusy] = useState(false)
  const [lightboxImage, setLightboxImage] = useState<string | null>(null)

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

  useEffect(() => {
    if (!lightboxImage) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxImage(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxImage])

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

  if (lightboxImage) {
    return (
      <div className="lightbox-backdrop" onClick={() => setLightboxImage(null)}>
        <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
          <button className="lightbox-close" title="Close" aria-label="Close" onClick={() => setLightboxImage(null)}>
            ✕
          </button>
          <img className="lightbox-img" src={lightboxImage} alt="Lineup screenshot, full size" />
        </div>
      </div>
    )
  }

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
  }

  async function handleAddPlayersFromPaste() {
    const parsed = parseRosterPaste(rosterPasteText)
    if (parsed.length === 0) return
    const playerTeams: Record<string, string> = {}
    for (const e of parsed) if (e.team) playerTeams[e.label] = e.team
    await call({ type: 'ADD_PLAYERS', playerNames: parsed.map((e) => e.label), playerTeams })
    setRosterPasteText('')
    setShowRosterPaste(false)
  }

  function toggleTeamFilter(team: string) {
    setActiveTeamFilters((prev) => {
      const next = new Set(prev)
      if (next.has(team)) next.delete(team)
      else next.add(team)
      return next
    })
  }

  async function handleRenameTeam(oldName: string, newNameRaw: string) {
    setRenamingTeam(null)
    const newName = newNameRaw.trim()
    if (!newName || newName === oldName) return
    await call({ type: 'RENAME_TEAM', oldName, newName })
    setActiveTeamFilters((prev) => {
      if (!prev.has(oldName)) return prev
      const next = new Set(prev)
      next.delete(oldName)
      next.add(newName)
      return next
    })
  }

  function cycleTeam(player: string) {
    const known = Array.from(new Set(Object.values(match.playerTeams)))
    const pair =
      known.length >= 2
        ? known.slice(0, 2)
        : [...known, ...['Team A', 'Team B'].filter((t) => !known.includes(t))].slice(0, 2)
    const current = match.playerTeams[player] ?? null
    const next = current === null ? pair[0] : current === pair[0] ? pair[1] : null
    call({ type: 'SET_PLAYER_TEAM', playerName: player, team: next })
  }

  async function handlePositionBlur(player: string) {
    const value = (positionDrafts[player] ?? match.playerPositions[player] ?? '').trim()
    if (value === (match.playerPositions[player] ?? '')) {
      setPositionDrafts((prev) => {
        const { [player]: _drop, ...rest } = prev
        return rest
      })
      return
    }
    await call({ type: 'SET_PLAYER_POSITION', playerName: player, position: value })
    setPositionDrafts((prev) => {
      const { [player]: _drop, ...rest } = prev
      return rest
    })
  }

  function movePlayer(from: number, to: number) {
    if (to < 0 || to >= match.players.length) return
    const next = [...match.players]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    call({ type: 'REORDER_PLAYERS', players: next })
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

  function clearTagState(player: string) {
    setTagCategoryByPlayer((prev) => {
      const { [player]: _drop, ...rest } = prev
      return rest
    })
    setStarredByPlayer((prev) => {
      const { [player]: _drop, ...rest } = prev
      return rest
    })
    setOutcomeByPlayer((prev) => {
      const { [player]: _drop, ...rest } = prev
      return rest
    })
  }

  async function handleDeletePlayer(player: string) {
    if (!window.confirm(`Remove ${player} from the roster? Their saved clips stay untouched.`)) return
    await call({ type: 'DELETE_PLAYER', playerName: player })
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

      <button className="lineup-toggle" onClick={() => setShowLineup((s) => !s)}>
        Lineup {showLineup ? '▲' : '▼'}
      </button>

      {showLineup && (
        <div className="lineup-panel">
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
                  className="lineup-thumb-remove"
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

      {openNoteTargets.length > 0 && (
        <div className="note-fields">
          {openNoteTargets.map((target) => (
            <div key={target} className="note-field-row">
              <div className="note-field-label">
                <span>Note for: {target === GENERAL_NOTE_KEY ? GENERAL_NOTE_LABEL : target}</span>
                <button title="Cancel note" aria-label="Cancel note" onClick={() => closeNoteField(target)}>
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

      {(() => {
        const knownTeams = Array.from(new Set(Object.values(match.playerTeams))).slice(0, 2)
        if (knownTeams.length === 0) return null
        return (
          <div className="chips" style={{ marginBottom: 6 }}>
            {knownTeams.map((team) =>
              renamingTeam === team ? (
                <input
                  key={team}
                  className="team-rename-input"
                  autoFocus
                  defaultValue={team}
                  onBlur={(e) => handleRenameTeam(team, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenamingTeam(null)
                  }}
                />
              ) : (
                <div key={team} className="team-toggle-group">
                  <button
                    className={`chip ${activeTeamFilters.has(team) ? 'selected' : ''}`}
                    onClick={() => toggleTeamFilter(team)}
                  >
                    {team}
                  </button>
                  <button
                    className="chip-remove"
                    title="Rename team"
                    aria-label={`Rename ${team}`}
                    onClick={() => setRenamingTeam(team)}
                  >
                    ✎
                  </button>
                </div>
              ),
            )}
          </div>
        )
      })()}

      {showReorderPlayers && (
        <div className="reorder-panel">
          {match.players.map((p, i) => (
            <div key={p} className="reorder-row">
              <span>{p}</span>
              <div>
                <button disabled={i === 0} onClick={() => movePlayer(i, i - 1)} title="Move up" aria-label={`Move ${p} up`}>
                  ↑
                </button>
                <button
                  disabled={i === match.players.length - 1}
                  onClick={() => movePlayer(i, i + 1)}
                  title="Move down"
                  aria-label={`Move ${p} down`}
                >
                  ↓
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="player-rows">
        {match.players
          .filter((p) => activeTeamFilters.size === 0 || activeTeamFilters.has(match.playerTeams[p] ?? ''))
          .map((p) => {
          const status = statusFor(p)
          const countdown = stopCountdowns[p]
          const tagCategory = tagCategoryByPlayer[p] ?? null
          const starred = starredByPlayer[p] ?? false
          const outcome = outcomeByPlayer[p] ?? null
          // See the popup's identical comment: the backend's own 'stopping'
          // status isn't visible to this same caller until the whole
          // STOP_RECORDING call (including the post-roll wait) resolves.
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
                <button
                  className="chip-remove team-badge"
                  title={match.playerTeams[p] ? `Team: ${match.playerTeams[p]} (click to change)` : 'Assign team'}
                  aria-label={`Team for ${p}`}
                  onClick={() => cycleTeam(p)}
                >
                  {match.playerTeams[p] ? match.playerTeams[p].slice(0, 3) : '—'}
                </button>
                <input
                  type="text"
                  className="position-input"
                  placeholder="pos"
                  value={positionDrafts[p] ?? match.playerPositions[p] ?? ''}
                  onChange={(e) => setPositionDrafts((prev) => ({ ...prev, [p]: e.target.value }))}
                  onBlur={() => handlePositionBlur(p)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                <button className="chip-remove" title="Add note" aria-label={`Note for ${p}`} onClick={() => toggleNoteField(p)}>
                  ✎
                </button>
                {status === 'idle' && (
                  <button
                    className="chip-remove"
                    title="Remove player"
                    aria-label={`Remove ${p}`}
                    onClick={() => handleDeletePlayer(p)}
                  >
                    ✕
                  </button>
                )}
              </div>
              {countdown != null && <span className="status inline">+{countdown}s</span>}

              {status === 'pending-tag' && (
                <div className="tag-panel inline">
                  <button
                    className={`full star-toggle ${starred ? 'primary' : ''}`}
                    onClick={() => setStarredByPlayer((prev) => ({ ...prev, [p]: !starred }))}
                  >
                    {starred ? '★ Highlight' : '☆ Mark as highlight'}
                  </button>
                  <div className="category-row">
                    {(['successful', 'unsuccessful'] as const).map((value) => (
                      <button
                        key={value}
                        className={`outcome-btn ${value} ${outcome === value ? 'active' : ''}`}
                        onClick={() =>
                          setOutcomeByPlayer((prev) => {
                            const { [p]: _drop, ...rest } = prev
                            return outcome === value ? rest : { ...rest, [p]: value }
                          })
                        }
                      >
                        {value === 'successful' ? '✓ Successful' : '✗ Unsuccessful'}
                      </button>
                    ))}
                  </div>
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
                            call({ type: 'CONFIRM_SAVE', playerName: p, actionType: `${tagCategory} ${sub}`, starred, outcome })
                            clearTagState(p)
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
                        call({ type: 'CONFIRM_SAVE', playerName: p, actionType: null, starred, outcome })
                        clearTagState(p)
                      }}
                    >
                      No tag
                    </button>
                    <button
                      className="danger"
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
        {!showAddPlayer && !showRosterPaste && (
          <button className="chip" title="Add player" onClick={() => setShowAddPlayer(true)}>
            +
          </button>
        )}
        {!showAddPlayer && !showRosterPaste && (
          <button className="chip" title="Paste roster" onClick={() => setShowRosterPaste(true)}>
            + Paste roster
          </button>
        )}
        <button className="chip" title="General note" onClick={() => toggleNoteField(GENERAL_NOTE_KEY)}>
          ✎ General
        </button>
        {match.players.length > 1 && (
          <button
            className={`chip ${showReorderPlayers ? 'selected' : ''}`}
            title="Reorder players"
            onClick={() => setShowReorderPlayers((s) => !s)}
          >
            ⇅
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

      {showRosterPaste && (
        <div style={{ marginBottom: 8 }}>
          <textarea
            className="lineup-textarea"
            autoFocus
            value={rosterPasteText}
            onChange={(e) => setRosterPasteText(e.target.value)}
            placeholder={'Paste from Obsidian, e.g.:\n8 - [[Yolande Mylene Zoua, 2010]] - '}
          />
          <div className="status" style={{ marginTop: 2 }}>
            {(() => {
              const n = parseRosterPaste(rosterPasteText).length
              return n > 0 ? `Found ${n} player${n === 1 ? '' : 's'}.` : 'Paste lines like "8 - [[Name, Year]] - ".'
            })()}
          </div>
          <div className="category-row" style={{ marginTop: 6 }}>
            <button
              className="primary"
              disabled={parseRosterPaste(rosterPasteText).length === 0}
              onClick={handleAddPlayersFromPaste}
            >
              Add parsed
            </button>
            <button
              onClick={() => {
                setShowRosterPaste(false)
                setRosterPasteText('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="footer">
        min {currentMinute} · {match.clips.length} clip{match.clips.length === 1 ? '' : 's'} ·{' '}
        {match.notes.length} note{match.notes.length === 1 ? '' : 's'}
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
    'paste',
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
