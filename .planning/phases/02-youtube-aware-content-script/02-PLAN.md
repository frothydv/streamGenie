# Phase 2: YouTube-Aware Content Script

**Branch:** `m10-youtube-support`
**Status:** Ready to execute
**Requirements:** CONT-01, CONT-02, CONT-03, CONT-04, CONT-05, CONT-06

## Goal

The content script (`content.js`) runs without errors on YouTube, discovers the video element, handles coordinate math correctly, and skips all Twitch-specific logic. Twitch functionality is completely unaffected.

## Success Criteria

1. Content script initializes on YouTube with log `[overlay/content] loaded on https://www.youtube.com/watch?v=...` and **no errors**
2. A `PLATFORM` constant (`"twitch"` | `"youtube"`) is derived from `location.hostname` at the top of the IIFE
3. `findBestVideo()` discovers the YouTube `<video>` element; heartbeat detects video element changes on SPA navigation (clicking a different video)
4. Hovering over the YouTube video triggers pixel capture without coordinate math errors
5. Twitch extension interference code (`detectTwitchExtensions`, `disableTwitchExtensions`, `enableTwitchExtensions`, `maybeShowExtensionWarning`, `showExtensionWarningUI`) never runs on YouTube pages — zero errors about missing `ext-twitch.tv` elements
6. `detectTwitchGame()` never runs on YouTube — no console noise or errors
7. Web-accessible reference images load correctly on YouTube pages

## Twitch-Specific Code Paths to Guard

### A. Extension Interference Variables (lines ~98–105)
`extensionToggleUI`, `disabledElements`, `extensionsDisabled`, `extensionInterferenceState`, `lastExtCount`, `EXT_SETTING_PREFIX` — these are only read/written by Twitch-specific functions. They can stay as-is (no errors from unused vars), but the functions that use them must be guarded.

### B. `detectTwitchGame()` (lines ~108–124)
Pure Twitch — scrapes `[data-a-target="stream-game-link"]` and `a[href*="/directory/category/"]` elements that don't exist on YouTube.

**Guard:** Wrap call site only (heartbeat + startup). The function itself is self-contained.

### C. Extension interference functions (lines ~184–306)
- `detectTwitchExtensions()` — hunts `ext-twitch.tv` iframes
- `disableTwitchExtensions()` — sets `pointerEvents: none` on overlays
- `enableTwitchExtensions()` — restores `pointerEvents`
- `maybeShowExtensionWarning()` — shows the yellow interference banner
- `showExtensionWarningUI()` — builds the interference UI

**Guard:** All call sites in heartbeat and SPA nav reset. The functions themselves don't throw if called on YouTube (they just won't find anything), but guarding them avoids wasted work and makes intent clear.

### D. `detectTwitchGame()` call in heartbeat (line 318)
```js
detectTwitchGame();
```
→ Guard with `if (PLATFORM === "twitch")`

### E. `maybeShowExtensionWarning()` call in heartbeat (line 319)
```js
maybeShowExtensionWarning();
```
→ Guard with `if (PLATFORM === "twitch")`

### F. `enableTwitchExtensions()` in SPA navigation reset (line 313)
```js
enableTwitchExtensions();
extensionInterferenceState = "unknown";
lastExtCount = 0;
if (extensionToggleUI) { extensionToggleUI.remove(); extensionToggleUI = null; }
```
→ Guard with `if (PLATFORM === "twitch")` — only Twitch has extension state to reset

## Platform-Agnostic Paths (no changes needed)

### `findBestVideo()` (lines ~139–153)
Already generic — uses `document.querySelectorAll("video")` and picks largest visible. YouTube's video element is a `<video>` tag inside the player container. Should work as-is. **Test on YouTube to confirm.**

### `clientToVideoCoords()` (lines ~345–385)
The letterbox math **only activates** when `object-fit: contain`. YouTube uses `object-fit: initial` (defaults to `fill`), so the else branch fires — meaning the video fills the element exactly, no offset/scale compensation needed. **This is correct and already handles both platforms.**

### `captureRegion()` (lines ~397–409)
Uses standard `drawImage(video, ...)` — works identically on both platforms.

### `ensureCaptureCanvas()`, dHash/matching functions (lines ~387–442)
Pure JS, no DOM — fully platform-agnostic.

### `ensureRawUrl()` (lines ~57–63)
Platform-agnostic — URL string manipulation.

### Profile loading (`loadProfile`, `fetchAndCacheProfile`, `applyProfile`, `loadReferencesForTriggers`, etc.)
Platform-agnostic — lazy-loads reference images from CDN/raw URLs.

### Debug panel (`ensureDebugPanel`, `renderDebugPanel`, `showDebugPanel`, `hideDebugPanel`)
Platform-agnostic — DOM overlays that work on any page.

### Popup rendering (`showPopups`, `hidePopups`, `makePopupEl`)
Platform-agnostic — fixed-position DOM overlays relative to cursor.

### Capture mode (`startCaptureMode`, `onCaptureMouseDown`, etc.)
Platform-agnostic — full-page overlay for freeze-and-crop.

### Trigger editor (`openTriggerEditor`, mask editor, rotation UI)
Platform-agnostic — modal DOM UI with canvas operations.

### Curator panel (`openCuratorPanel`, `buildCard`, etc.)
Platform-agnostic — full-page modal with trigger grid.

### Toast (`showToast`)
Platform-agnostic — simple DOM notification.

### Message handler (`chrome.runtime.onMessage`)
Platform-agnostic — handles IPC from background/popup.

### Diagnostic click handler (`onDocumentClick`)
Platform-agnostic — debugging tool independent of platform.

## Heartbeat Behavior on YouTube

The heartbeat currently does this on each tick (500ms):

```
1. SPA navigation check (URL change) → reset state
2. detectTwitchGame()
3. maybeShowExtensionWarning()
4. findBestVideo() → attachToVideo/discover
5. updateDebugPanelStatus()
```

After Phase 2 changes, on YouTube it will do:

```
1. SPA navigation check (URL change) → reset state (skip extension reset)
2. (skip) — no game detection via DOM scraping
3. (skip) — no extension interference on YouTube
4. findBestVideo() → attachToVideo/discover
5. updateDebugPanelStatus()
```

The SPA navigation detection (URL change) already works generically — YouTube replaces the video element when navigating between watch pages, so the `if (video && video !== currentVideo)` check in `heartbeat()` will fire correctly.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| YouTube video element selectors fail | Low-medium | High — no capture | `findBestVideo()` already handles multiple videos and zero-video states; test on real YouTube |
| CSS `object-fit` differs from expectation | Low | Medium — offset math off | `clientToVideoCoords()` handles both branches; verify with shift+click dumper |
| YouTube SPA doesn't replace video element on nav | Low | Medium — stale video ref | Already guarded by `if (!document.body.contains(currentVideo))` |
| Twitch guarded code has latent bug that only manifests when PLATFORM guard is added | Very low | Low | Logical conditions are simple equality checks |
| Web-accessible resources blocked on YouTube | Low | Low — only affects built-in refs | Phase 1 already added youtube.com to WAR matches |

## Execution Plan

### Task 1: Add PLATFORM constant and guard top-level comment

**File:** `extension/content.js`

- Add `const PLATFORM = location.hostname.includes("youtube.com") ? "youtube" : "twitch";` after the IIFE guard check
- Update the comment at line 1 from `// Content script. Runs in the context of twitch.tv pages.` to something generic

### Task 2: Guard extension interference variables + functions

**File:** `extension/content.js`

- Wrap `enableTwitchExtensions()` call + extension state reset in the SPA navigation block (heartbeat, line ~309-316) with `if (PLATFORM === "twitch")`
- Wrap `detectTwitchGame()` call (line ~318) with `if (PLATFORM === "twitch")`
- Wrap `maybeShowExtensionWarning()` call (line ~319) with `if (PLATFORM === "twitch")`

### Task 3: Confirm YouTube video discovery works

**Test method:** Load extension on `https://www.youtube.com/watch?v=...` in Chrome, open DevTools console, filter by `[overlay/` and verify:
- `[overlay/content] loaded on https://www.youtube.com/watch?v=...` appears
- `[overlay/content] attaching to video:` appears with correct dimensions
- No errors related to Twitch selectors or extension interference

### Task 4: Confirm coordinate math works

**Test method:** With debug panel open on YouTube, hover over the video. Verify:
- Debug panel shows coordinates updating
- The capture preview canvas shows video content (not black/empty)
- No console errors from `clientToVideoCoords()` or `captureRegion()`

### Task 5: Update top-level doc comment

**File:** `extension/content.js` line 1

Change `// Content script. Runs in the context of twitch.tv pages.` to describe both platforms.

## Verification

After implementation, verify by loading the extension on:
1. **Twitch live stream** — everything works exactly as before (regression test)
2. **YouTube VOD** — content script loads, attaches to video, shows debug panel, no errors
3. **YouTube homepage** — graceful no-op (no video, no errors)
4. **Shift+click diagnostics** on YouTube produce correct coordinate data

## Manual Test Script (since e2e Playwright can't run)

```
1. Load extension in Chrome
2. Open https://www.youtube.com/watch?v=pzRHaqKn_pQ (or any VOD)
3. Open DevTools → Console, filter by [overlay
4. Expected: "[overlay/content] loaded on https://www.youtube.com/watch?v=..."
5. Expected: "[overlay/content] attaching to video: layoutSize ... nativeSize ..."
6. Expected: No errors mentioning "ext-twitch", "extension", or "stream-game-link"
7. Hover over video — debug panel should show coordinates updating
8. Verify Twitch still works: open a Twitch stream, confirm extension works as before
```
