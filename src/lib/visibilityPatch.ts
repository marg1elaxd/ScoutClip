/**
 * Injected into the broadcast tab (MAIN world, not the extension's isolated
 * world — has to be, since the goal is making the *page's own* JS believe
 * it's always foreground/focused, and an isolated-world override wouldn't
 * be visible to it at all) via chrome.scripting.executeScript. Must be
 * fully self-contained — no closures over outer scope — since it gets
 * serialized and re-run in the target page's own context.
 *
 * Many video sites (streaming/live-TV ones especially) pause or outright
 * error their player when the tab stops being the foreground one —
 * checking document.hidden/visibilityState inside a visibilitychange
 * handler, or listening for window blur. That's normal enough UX for a
 * human viewer tabbing away, but it also kills a legitimate recording of a
 * tab the scout has deliberately set as the one being captured, the moment
 * they alt-tab to do anything else (check the popup, switch apps, ...).
 *
 * Overriding the underlying getters (not suppressing the event itself,
 * which is unreliable here — this runs on demand, well after page load, so
 * the site's own listeners are typically already registered and would fire
 * before anything we add now) means any future read of document.hidden /
 * visibilityState / hasFocus() returns "still visible/focused" regardless
 * of when the real visibility change happens or when the site's handler
 * was registered — the site's own pause-on-background logic just never
 * triggers, because what it checks always says everything's fine.
 */
export function patchVisibilityAsAlwaysActive(): void {
  const define = (obj: object, prop: string, get: () => unknown) => {
    try {
      Object.defineProperty(obj, prop, { configurable: true, get })
    } catch {
      // Some sites make these non-configurable defensively — nothing more
      // to do for that specific property then, but don't let it block the
      // others from being patched.
    }
  }
  define(Document.prototype, 'hidden', () => false)
  define(Document.prototype, 'visibilityState', () => 'visible')
  define(Document.prototype, 'webkitHidden', () => false)
  try {
    document.hasFocus = () => true
  } catch {
    // ignore
  }
}
