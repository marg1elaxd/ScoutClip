/** Strip characters illegal in Windows/macOS filenames and folder names. */
export function sanitizeSegment(segment: string): string {
  return segment.replace(/[\\/:*?"<>|]/g, '').trim()
}

export function buildGameFolderName(matchInfo: string): string {
  return sanitizeSegment(matchInfo) || 'Match'
}

export function buildPlayerFolderName(playerName: string): string {
  return sanitizeSegment(playerName) || 'Unknown Player'
}

/** Derives the real file extension from the MediaRecorder mimeType actually used. */
export function extensionForMimeType(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
}

export function buildClipFilename(opts: {
  playerName: string
  actionType: string | null
  matchInfo: string
  minute: number
  /** This player's Nth clip in the match (1-based) — keeps filenames unique when two clips land in the same minute. */
  clipNumber: number
  extension: string
  /** Prefixes the filename with "HL - " so a highlight-worthy clip stands out immediately in the folder listing. */
  starred: boolean
}): string {
  const parts = [
    opts.playerName,
    opts.actionType ?? 'Untagged',
    opts.matchInfo,
    `${opts.minute}min`,
    `#${opts.clipNumber}`,
  ].map(sanitizeSegment)
  const prefix = opts.starred ? 'HL - ' : ''
  return `${prefix}${parts.join(' - ')}.${opts.extension}`
}

/** `Downloads/ScoutClips/<Game>/<Player>/<clip>.<ext>` — the path chrome.downloads writes to. */
export function buildDownloadPath(opts: {
  matchInfo: string
  playerName: string
  filename: string
}): string {
  const game = buildGameFolderName(opts.matchInfo)
  const player = buildPlayerFolderName(opts.playerName)
  return `ScoutClips/${game}/${player}/${opts.filename}`
}

/** `playerName` null means the selection spans more than one player. */
export function buildCompilationFilename(opts: {
  playerName: string | null
  matchInfo: string
  clipCount: number
  extension: string
}): string {
  const parts = [
    opts.playerName ?? 'Multiple Players',
    'Compilation',
    opts.matchInfo,
    `${opts.clipCount} clips`,
  ].map(sanitizeSegment)
  return `${parts.join(' - ')}.${opts.extension}`
}

/** Compilations live in their own subfolder — `<Player>/Compilations/` for a single-player reel, `<Game>/Compilations/` for a mixed one. */
export function buildCompilationPath(opts: { matchInfo: string; playerName: string | null; filename: string }): string {
  const game = buildGameFolderName(opts.matchInfo)
  if (opts.playerName) {
    const player = buildPlayerFolderName(opts.playerName)
    return `ScoutClips/${game}/${player}/Compilations/${opts.filename}`
  }
  return `ScoutClips/${game}/Compilations/${opts.filename}`
}
