# Phase 4: Popup & Testing

**Branch:** `m10-youtube-support`
**Status:** Ready to execute
**Requirements:** POP-01, POP-02, POP-03, POP-04, POP-05, TEST-01, TEST-02, TEST-04

## Goal

Polish popup YouTube integration: detected badge shows game name + change link, no-detection shows a transient toast, non-video YouTube pages get a clear message.

## Tasks

### 1. Update popup status for non-video pages (POP-05)
- Change "Not on Twitch or YouTube." → "Not a video/stream page."

### 2. Detected badge shows game name + change link (POP-03)
- Replace "✓ Auto-detected from stream" with `🔍 Detected: {gameName} ✓`
- Add [change] link that clears selection and shows no-detection toast
- Applies to both Twitch and YouTube detection

### 3. No-detection behaviour (POP-04)
- Add a transient toast modal: "No profile detected — select one or build your own"
- Auto-dismisses after 3 seconds with fade
- Appears on YouTube AND Twitch when no game detected
- No pre-selected game in dropdown (placeholder "-- Select a game --" instead)

### 4. Non-video YouTube pages (POP-05)
- YouTube homepage, search, channel pages show "Not a video/stream page."
- Popup still works (manual catalog selection) since no content script needed

### 5. Manual test
- User loads extension on YouTube VOD where game IS detected → sees badge
- Loads on YouTube VOD where game NOT detected → sees toast + blank dropdown
- Loads on YouTube homepage → sees "Not a video/stream page."

## Files changed

### `extension/popup.js`
- Status string change for non-platform pages
- Detected badge render: show game name + change link, wire change click handler
- Add `showNoDetectionToast()` function
- Change no-detection branch to invoke toast instead of static message
- Add placeholder option to game-select dropdown; default to null when no detection
- `selectedGameId` falls back to `null` on no-match (not `active.gameId`)

### `extension/popup.html`
- Add `.toast` modal element for no-detection notification

## Not in scope
- No content script changes (game detection pipeline is already complete)
- No profile schema changes
- No test fixture updates (Playwright still blocked in WSL)
- No styling overhaul — just the toast element
