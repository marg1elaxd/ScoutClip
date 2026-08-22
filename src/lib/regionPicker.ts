/**
 * Injected into the broadcast tab via chrome.scripting.executeScript, so it
 * must be fully self-contained — no closures over outer scope, since it gets
 * serialized and re-run in the target page's own context. Lets the scout
 * drag a box over the match video once.
 *
 * IMPORTANT: this does NOT return the picked region to its caller. Dragging
 * on the page requires clicking into that tab, which makes Chrome
 * auto-close the extension popup that triggered the injection — destroying
 * whatever Promise the popup was awaiting. Instead this messages the
 * background service worker directly (chrome.runtime.sendMessage is
 * available to injected scripts, same as content scripts) once Enter/Esc is
 * pressed, since the background worker persists independently of the popup.
 * The popup picks the result up on its next GET_STATE (e.g. when reopened).
 */
export function regionPickerOverlay(): void {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.35);'

  const hint = document.createElement('div')
  hint.textContent = 'Drag a box over the match video — Enter to confirm, Esc to cancel'
  hint.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#111;color:#fff;' +
    'padding:8px 14px;border-radius:6px;font:13px system-ui,sans-serif;z-index:2147483647;pointer-events:none;'

  const box = document.createElement('div')
  box.style.cssText =
    'position:fixed;border:2px solid #2f6feb;background:rgba(47,111,235,0.15);display:none;z-index:2147483647;'

  document.body.appendChild(overlay)
  document.body.appendChild(box)
  document.body.appendChild(hint)

  let startX = 0
  let startY = 0
  let dragging = false
  let currentRect: { x: number; y: number; width: number; height: number } | null = null

  function cleanup() {
    overlay.remove()
    box.remove()
    hint.remove()
    window.removeEventListener('keydown', onKeyDown, true)
  }

  function updateBox(curX: number, curY: number) {
    const x = Math.min(startX, curX)
    const y = Math.min(startY, curY)
    const width = Math.abs(curX - startX)
    const height = Math.abs(curY - startY)
    box.style.left = `${x}px`
    box.style.top = `${y}px`
    box.style.width = `${width}px`
    box.style.height = `${height}px`
    currentRect = { x, y, width, height }
  }

  function onMouseDown(e: MouseEvent) {
    dragging = true
    startX = e.clientX
    startY = e.clientY
    box.style.display = 'block'
    updateBox(e.clientX, e.clientY)
  }

  function onMouseMove(e: MouseEvent) {
    if (dragging) updateBox(e.clientX, e.clientY)
  }

  function onMouseUp() {
    dragging = false
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cleanup()
      chrome.runtime.sendMessage({ type: 'SET_CAPTURE_REGION', region: null })
    } else if (e.key === 'Enter' && currentRect && currentRect.width > 4 && currentRect.height > 4) {
      e.preventDefault()
      e.stopPropagation()
      cleanup()
      // Expressed as a fraction of the viewport, not absolute/device pixels
      // — see CaptureRegion's doc comment for why. window.innerWidth/Height
      // are viewport CSS pixels, matching the clientX/clientY the box was
      // dragged in, so this ratio is exactly "how far across/down the
      // visible tab" regardless of zoom or device pixel ratio.
      console.log('[regionPicker] selection —', {
        currentRect,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      })
      chrome.runtime.sendMessage({
        type: 'SET_CAPTURE_REGION',
        region: {
          xRatio: currentRect.x / window.innerWidth,
          yRatio: currentRect.y / window.innerHeight,
          widthRatio: currentRect.width / window.innerWidth,
          heightRatio: currentRect.height / window.innerHeight,
          // Carried through so the crop step can work out where any
          // letterbox/pillarbox padding actually is — see CaptureRegion's
          // doc comment in types.ts.
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        },
      })
    }
  }

  overlay.addEventListener('mousedown', onMouseDown)
  overlay.addEventListener('mousemove', onMouseMove)
  overlay.addEventListener('mouseup', onMouseUp)
  // Capture phase + stopPropagation: some streaming sites bind their own
  // player keyboard shortcuts (space, f, enter) on document/window and
  // would otherwise swallow this before it reaches us.
  window.addEventListener('keydown', onKeyDown, true)
}

/** Injects the picker into the currently active tab. Fire-and-forget by design — see regionPickerOverlay's doc comment. */
export async function openRegionPickerOnActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab to select a region on.')
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: regionPickerOverlay,
  })
}
