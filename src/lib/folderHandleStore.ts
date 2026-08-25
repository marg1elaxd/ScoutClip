/**
 * Persists the user's chosen export folder (a FileSystemDirectoryHandle)
 * across popup opens/closes and browser restarts. chrome.storage can't hold
 * a FileSystemDirectoryHandle (not JSON-serializable), but IndexedDB can —
 * handles are structured-cloneable — and, since this is extension-scoped
 * IndexedDB (chrome-extension://<id> origin), the same stored handle is
 * readable from every extension context (popup, background service worker,
 * offscreen document), not just the one that saved it. That's what lets a
 * later phase read it back from the background worker to actually save
 * files there — this module only does the picking/persisting/permission
 * plumbing, nothing writes through it yet.
 */
const DB_NAME = 'scout-clip-recorder-folder'
const STORE_NAME = 'handle'
const DB_VERSION = 1
const KEY = 'exportFolder'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open folder handle store.'))
  })
}

export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(handle, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Failed to save folder handle.'))
  })
  db.close()
}

export async function loadFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()
  const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(KEY)
    req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined)
    req.onerror = () => reject(req.error ?? new Error('Failed to read folder handle.'))
  })
  db.close()
  return handle ?? null
}

export async function clearFolderHandle(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Failed to clear folder handle.'))
  })
  db.close()
}

export type FolderPermissionState = 'granted' | 'needs-regrant' | 'none'

/** Never prompts — safe to call on mount. 'needs-regrant' covers both a lapsed grant and a not-yet-granted handle (e.g. a fresh browser session). */
export async function checkFolderPermission(handle: FileSystemDirectoryHandle | null): Promise<FolderPermissionState> {
  if (!handle) return 'none'
  const state = await handle.queryPermission({ mode: 'readwrite' })
  return state === 'granted' ? 'granted' : 'needs-regrant'
}

/** Must be called from a click handler — requestPermission() requires an active user gesture. */
export async function requestFolderPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const state = await handle.requestPermission({ mode: 'readwrite' })
  return state === 'granted'
}
