# Phase 3: Game Detection

**Branch:** `m10-youtube-support`
**Status:** Ready to execute
**Requirements:** GAME-01, GAME-02, GAME-03, GAME-04, CONT-04

## Goal

The extension detects the game from the YouTube video title and matches it against the catalog. On match above threshold, the profile is auto-selected. On no match, the full catalog is shown for manual selection.

## Success Criteria

1. Content script extracts video title from YouTube DOM on `"get-game"` message — uses `<h1 yt-formatted-string>` first, falls back to `document.title`
2. Popup implements client-side fuzzy title matching against `catalog.gameName` with a 0.4 threshold
3. On match above threshold: popup auto-selects that game, shows "Detected: [game]" badge
4. On no match: popup shows full catalog for manual selection (existing fallback path)
5. `twitchSlug` → `legacyTwitchSlug` rename with backward compatibility (both `legacyTwitchSlug` and `twitchSlug` accepted from CDN)

## Files changed

### `extension/content.js`
- Add `detectYouTubeGame()` function after `detectTwitchGame()` — extracts video title from DOM
- Update `"get-game"` message handler: on YouTube, respond with `{ game: null, videoTitle }` instead of `{ game: { slug, name } }`

### `extension/popup.js`
- Update tab status: show "Active on YouTube: /watch?v=..." for YouTube watch pages
- Send `"get-game"` on YouTube tabs too (was Twitch-only)
- Add `fuzzyMatchTitle()` function — substring + word-overlap scoring against catalog game names
- On YouTube, run fuzzy match from `videoTitle` → set `detectedSlug`/`detectedName` if matched
- Rename `twitchSlug` → `legacyTwitchSlug` in catalog model with backward compat:
  - CDN parsing: reads `legacyTwitchSlug` from new field, falls back to `twitchSlug`
  - `catalogMatch`: checks `gameId`, `legacyTwitchSlug`, and `twitchSlug` (backward compat)
  - All internal references use `legacyTwitchSlug`
- Update "no game detected" branch to also check for YouTube tabs

## Not in scope
- No new UI elements — reuse existing `detected-game` element and fallback path
- No cloud API calls — all matching is client-side
- No profile schema changes on GitHub — field rename is backward-compatible
