/**
 * Downscales an image data URL so lineup screenshots don't blow past
 * chrome.storage.session's quota or render huge in a narrow popup. Long
 * edge capped at `maxDim`; re-encoded as JPEG (screenshots/graphics, not
 * something that needs lossless PNG) to keep the stored size down.
 */
export async function resizeImageDataUrl(dataUrl: string, maxDim = 900): Promise<string> {
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
  const w = Math.round(img.width * scale)
  const h = Math.round(img.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.85)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load image.'))
    img.src = src
  })
}

/** Reads a File (from a file input or a pasted clipboard item) as a data URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Could not read file.'))
    reader.readAsDataURL(file)
  })
}
