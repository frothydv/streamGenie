# Codebase Structure

**Analysis Date:** 2026-05-10

## Directory Tree

```
twitch-overlay/
├── extension/                    # Chrome extension (load unpacked from here)
│   ├── manifest.json             # MV3 manifest — permissions, content scripts, commands
│   ├── background.js             # Service worker — hotkey forwarding only
│   ├── content.js                # Main content script (~3700 lines) — all action
│   ├── matcher-core.js           # dHash, NCC, rotation — loaded before content.js
│   ├── popup.html                # Toolbar popup HTML
│   ├── popup.js                  # Toolbar popup logic
│   ├── icons/                    # 16/48/128px PNGs
│   └── references/               # Local reference PNGs (dev/test only; not shipped to users)
│       ├── map-icon.png
│       ├── coin-gold.png
│       └── ice-cream-relic.png
├── workers/
│   └── submit-trigger/
│       ├── index.js              # Cloudflare Worker — all contribution ops
│       └── wrangler.toml         # Worker config (account: vbjosh, KV bindings)
├── tests/
│   ├── rotation-matching.js      # 39 tests for matcher-core.js
│   └── bench-ncc.js              # NCC performance benchmark (standalone)
├── package.json                  # One dep: pngjs (node-side only)
├── CLAUDE.md                     # Project primer for Claude Code sessions
├── README.md                     # User-facing instructions
└── .planning/                    # GSD planning artifacts
    └── codebase/                 # This codebase map
```

## File Responsibilities

### `extension/manifest.json`
- Declares `content_scripts`: `matcher-core.js` then `content.js` on `https://*.twitch.tv/*`
- Declares `background.service_worker`: `background.js`
- Declares `action` (popup): `popup.html`
- Declares `commands`: `capture-trigger` (Alt+Shift+C)
- `host_permissions`: twitch.tv, jsdelivr, raw.githubusercontent.com, workers.dev

### `extension/background.js`
- Listens for `chrome.commands.onCommand("capture-trigger")`
- Queries active Twitch tab, sends `{ type: "capture-trigger" }` to content script
- Minimal — no state, no storage, no network

### `extension/matcher-core.js`
- UMD module: `globalThis.StreamGenieMatcher` in browser, `module.exports` in Node
- Exports: `findBestMatch(imageData, triggers, opts)`, `dHash(imageData)`, `computeRotatedHashes(ref)`, `anglesForRotation(rotation)`, `buildSAT(imageData)`, `nccAtPosition(...)`
- Pure computation — no DOM, no fetch, no side effects
- Used by `content.js` at runtime and by `tests/rotation-matching.js` in Node

### `extension/content.js` (~3700 lines)
Single IIFE, 10 logical sections:

| Section | Lines (approx) | Responsibility |
|---------|---------------|----------------|
| Config constants | 1–100 | `CAPTURE_SIZE`, `WORKER_URL`, `SUBMIT_SECRET`, `FALLBACK_CATALOG`, etc. |
| Profile loading | 100–300 | `loadCatalog()`, `loadProfile()`, `applyProfile()`, `ensureRawUrl()`, cache logic |
| Video discovery | 300–450 | `findBestVideo()`, `attachToVideo()`, 500ms heartbeat |
| Pixel capture | 450–600 | `clientToVideoCoords()`, `captureRegion()` (160×160 and 480×480 wide) |
| Matching pipeline | 600–800 | Calls `MatcherCore.findBestMatch`, debounce, match state management |
| Popup rendering | 800–1100 | Dark Twitch-theme popup, auto-dismiss, position calculation |
| Debug panel | 1100–1350 | Live preview, match distance display, game detection status |
| Capture mode | 1350–1600 | Alt+Shift+C freeze-and-drag flow, PNG export |
| Trigger editor | 1600–3200 | Payload entry, popup offset, mask paint, rotation schema, heat-map test, submit |
| Toast + message handlers | 3200–3700 | `showToast()`, `chrome.runtime.onMessage` (capture-trigger, get-game, review-proposal) |

### `extension/popup.js`
- Calls `chrome.tabs.sendMessage({ type: "get-game" })` to get detected game/slug
- Fetches catalog, matches slug to game, shows profile list
- Handles contributor key entry and `verify` call to Worker
- Handles proposal review UI: calls `list-proposals`, `accept-proposal`, `reject-proposal`
- Calls `activate` op on profile selection

### `workers/submit-trigger/index.js`
- ES module Cloudflare Worker (`export default { fetch }`)
- Validates `X-Submit-Secret` header on every request
- Routes by `body.mode` or `body.op` to handler functions
- All GitHub API calls are direct from Worker using `GITHUB_TOKEN` secret
- KV reads: `CONTRIBUTOR_KEYS.get(key)` for trusted contributor check
- KV writes: `PROFILE_STATS.put(...)` for usage tracking

## Inter-File Dependencies

```
manifest.json
  └─ loads: matcher-core.js → content.js (content scripts, in order)
  └─ loads: background.js (service worker)
  └─ loads: popup.html → popup.js (action popup)

content.js
  └─ reads: globalThis.StreamGenieMatcher (from matcher-core.js)
  └─ reads: chrome.storage.local (profile cache, settings)
  └─ fetch: raw.githubusercontent.com (profile.json, reference PNGs)
  └─ fetch: WORKER_URL (contribution submit)

popup.js
  └─ chrome.tabs.sendMessage → content.js (get-game, review-proposal)
  └─ fetch: raw.githubusercontent.com (catalog.json)
  └─ fetch: WORKER_URL (verify, list-proposals, accept-proposal, reject-proposal, activate)

background.js
  └─ chrome.tabs.sendMessage → content.js (capture-trigger)

tests/rotation-matching.js
  └─ require: matcher-core.js (via Node module.exports)
  └─ require: pngjs (image decoding for test fixtures)
```

## Shared State

| State | Where stored | Who reads/writes |
|-------|-------------|-----------------|
| Active profile JSON | In-memory (`currentProfile`) | `content.js` only |
| Profile cache | `chrome.storage.local` | `content.js` writes; `popup.js` writes |
| Contributor key | `chrome.storage.local` | `popup.js` reads/writes |
| Debug panel open | `chrome.storage.local` | `content.js` reads/writes |
| Extension interference pref | `chrome.storage.local` | `content.js` reads/writes |
| Match state | In-memory | `content.js` only |
| Captured frame (capture mode) | In-memory canvas | `content.js` only |
