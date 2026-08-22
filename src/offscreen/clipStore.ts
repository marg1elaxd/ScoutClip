/**
 * Retains every finalized clip's video bytes for the duration of the match,
 * so they can be re-read later for compilation — chrome.downloads writes
 * clips to disk but gives no way to read them back, and the offscreen
 * document doesn't otherwise keep a clip's blob around once it's handed off
 * for download. Backed by IndexedDB rather than a plain in-memory Map:
 * a full match can be 70-100 clips, easily several hundred MB in aggregate,
 * and IndexedDB-stored blobs don't count against the page's live JS heap
 * the way a Map holding Blob references would.
 */
const DB_NAME = 'scout-clip-store'
const STORE_NAME = 'clips'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open clip store.'))
  })
}

export async function saveClipBlob(clipId: string, blob: Blob): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(blob, clipId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Failed to save clip blob.'))
  })
  db.close()
}

export async function getClipBlob(clipId: string): Promise<Blob> {
  const db = await openDb()
  const blob = await new Promise<Blob | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(clipId)
    req.onsuccess = () => resolve(req.result as Blob | undefined)
    req.onerror = () => reject(req.error ?? new Error('Failed to read clip blob.'))
  })
  db.close()
  if (!blob) throw new Error(`Clip ${clipId} is no longer available (cache cleared or match ended).`)
  return blob
}

export async function clearClipStore(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Failed to clear clip store.'))
  })
  db.close()
}
