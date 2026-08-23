/** Formats a millisecond duration as `mm:ss`, e.g. 125_000 -> "02:05". */
export function formatMmSs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const mm = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, '0')
  const ss = (totalSec % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}
