# Technology Stack

**Analysis Date:** 2026-05-10

## Languages

**Primary:**
- JavaScript (ES2020+) — all extension code, Cloudflare Worker, and tests. No TypeScript.

**Secondary:**
- HTML — `extension/popup.html` (toolbar popup UI)
- CSS — inline styles only; no external stylesheet files

## Runtime Environments

**Browser Extension (content scripts):**
- Chrome Manifest V3
- Content scripts run in isolated world on `https://*.twitch.tv/*`
- Load order enforced by manifest: `matcher-core.js` before `content.js`
- IIFE with `window.__streamOverlayLoaded` guard prevents double-injection on reload

**Service Worker:**
- `extension/background.js` — MV3 service worker (no persistent background page)
- Wakes for `chrome.commands.onCommand` (hotkey) and `chrome.runtime.onInstalled`
- Forwards `capture-trigger` command to active Twitch tab via `chrome.tabs.sendMessage`

**Cloudflare Worker:**
- `workers/submit-trigger/index.js` — ES module worker (`export default { fetch }`)
- Compatibility date: `2024-09-23`
- Deployed as `streamgenie-submit` to `vbjosh.workers.dev`
- Uses Cloudflare KV for two namespaces: `CONTRIBUTOR_KEYS`, `PROFILE_STATS`

**Node.js (tests only):**
- `tests/rotation-matching.js` — run with `node tests/rotation-matching.js`
- No test framework; uses bare assert-style helpers written inline
- 39 tests covering angle generation, accuracy, heat-map invariants, and speed

## Package Manager

- npm (`package.json` present with one dependency: `pngjs ^7.0.0`)
- Extension itself has **zero npm dependencies** — ships as plain JS files with no bundler

## Build Tools

**None.** The extension is unbundled:
- Files loaded directly by Chrome from `extension/`
- No Webpack, Rollup, esbuild, Vite, or similar bundler
- No transpilation; Chrome V8 consumes source directly
- `wrangler` CLI deploys the Cloudflare Worker, but no build script exists for the extension

## Chrome Extension APIs Used

| API | Where Used | Purpose |
|-----|-----------|---------|
| `chrome.runtime` | `background.js`, `content.js` | Message passing, install events |
| `chrome.commands` | `background.js` | Alt+Shift+C hotkey (capture-trigger) |
| `chrome.tabs` | `background.js`, `popup.js` | Query active tab, send messages |
| `chrome.storage.local` | `content.js`, `popup.js` | Profile cache, contributor keys, settings (2-min TTL) |

## Browser APIs Used (in content script)

| API | File | Purpose |
|-----|------|---------|
| Canvas 2D (`<canvas>` + `drawImage`) | `content.js` | Capture 160×160 px region from video element |
| `HTMLVideoElement` | `content.js` | Pixel source; `videoWidth`/`videoHeight` for coord mapping |
| DOM (`querySelectorAll`, traversal) | `content.js` | Video discovery, Twitch game-link detection |
| `MouseEvent` (document-level listener) | `content.js` | Hover tracking; bypasses Twitch overlay divs |
| `Uint8Array` / `ImageData` | `matcher-core.js` | Raw RGBA pixel buffers for dHash and NCC |
| `fetch` | `content.js`, `popup.js` | Load catalog.json and profile.json from GitHub |

## Matching Algorithm Stack

All matching logic lives in `extension/matcher-core.js` — a UMD module exposing
`globalThis.StreamGenieMatcher` in the browser and `module.exports` in Node.

| Component | Description |
|-----------|-------------|
| dHash | Difference hash normalised to 32×32 canonical size before hashing |
| Sliding-window search | Coarse pass (stride 4, top 16 candidates) then fine pass (stride 1) across 160×160 capture |
| Rotation | Pure-JS bilinear pixel rotation; up to 20 angles for `rotates: true` triggers |
| NCC | Normalized Cross-Correlation secondary pass using summed-area table; O(1) per position; threshold ≥ 0.65 |
| Mask support | PNG mask data-URL on trigger references; masked dHash uses only non-masked pixels |

## Key Thresholds (from `matcher-core.js`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `matchThresholdRatio` | 10/64 | Max dHash bit-error ratio for unmasked match |
| `maskedMatchThresholdRatio` | 6/64 | Max ratio for masked match |
| `rotationMatchThresholdRatio` | 7/64 | Max ratio during rotation search |
| `nccMatchThreshold` | 0.65 | Min NCC score to independently confirm a match |
| `canonicalSize` | 32 | Both ref and capture window normalised to 32×32 before hashing |
| `captureSize` | 160 | Default hover-capture region in pixels |

## Platform Requirements

**Development:**
- Node.js (any modern LTS) — needed only to run `node tests/rotation-matching.js`
- `pngjs ^7.0.0` — installed via npm; used in node-side test scripts only
- Wrangler CLI — needed only to deploy the Cloudflare Worker

**Production (extension):**
- Chrome with Manifest V3 support (Chrome 88+; no explicit minimum version pinned)
- No build step required; load unpacked directly from `extension/`
