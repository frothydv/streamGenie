# Stack — Stream Genie

## Languages & Runtimes

| Layer | Technology | Notes |
|-------|-----------|-------|
| Extension runtime | **JavaScript (ES2020+)** | All extension scripts (content, popup, background) are vanilla JS. No TypeScript, no bundler, no transpilation step. |
| Extension engine | **Chrome Manifest V3** | `manifest.json` declares service worker, content script (runs on `*.twitch.tv/*`), popup, command (Alt+Shift+C). |
| Serverless backend | **Cloudflare Workers (ES2022)** | Single Worker handles submission flow, profile creation, proposal review. Uses `wrangler.toml` for config, KV namespaces for contributor keys and profile stats. |
| Testing | **Node.js >=14.19** | Tests run via `node` (no test framework). `pngjs` v6/v7 for image processing in matching tests. |

## Key Dependencies

### Extension (no bundler, loaded directly)
- None beyond the Chrome API surface:
  - `chrome.storage.local` — persisting profile state, user triggers, contributor codes
  - `chrome.tabs.sendMessage` — popup ↔ content script IPC
  - `chrome.commands.onCommand` — hotkey forwarding (Alt+Shift+C)
  - `chrome.runtime.onMessage` — inter-script messaging
  - `chrome.runtime.getURL` — web-accessible resource loading

### matcher-core.js (shared between extension & Node.js)
- Pure JS, zero dependencies. UMD wrapper (`module.exports` / `globalThis`).
- Exports: `createMatcher`, `DEFAULTS`, `rotatePixels`, `computeRotatedHashes`, `anglesForRotation`

### Node.js dev dependencies
- `pngjs` (v6.0.0 in `package-test.json`, v7.0.0 in `package.json`) — reading/writing PNG files for test captures

### Cloudflare Worker
- No npm packages. Uses Fetch API, `wrangler` CLI for deployment.
- KV bindings: `CONTRIBUTOR_KEYS`, `PROFILE_STATS`
- Secrets (set via `wrangler secret put`): `GITHUB_TOKEN`, `SUBMIT_SECRET`

## Configuration Files

| File | Purpose |
|------|---------|
| `extension/manifest.json` | Chrome Extension manifest V3 — permissions, content script injection, popup, commands |
| `package.json` | Root project metadata. Script: `test:grid-match` runs `test-matching-node.js` |
| `package-test.json` | Secondary test package (legacy, contains pngjs v6) |
| `package-lock.json` | Lockfile for pngjs v7 |
| `scripts/build-alpha.js` | Build script — zips `extension/` into `dist/stream-genie-v<version>.zip` using PowerShell |
| `workers/submit-trigger/wrangler.toml` | Cloudflare Worker config — name, main module, compatibility date, KV bindings |

## Build & Deploy Pipeline

- **No build step for development.** Content scripts are loaded directly as files.
- **Alpha build:** `node scripts/build-alpha.js` → creates `.zip` from `extension/` directory
- **Worker deploy:** `wrangler deploy` from `workers/submit-trigger/`
- **Profile storage:** GitHub repo `frothydv/streamGenieProfiles` served via raw.githubusercontent.com (cache-busted with `_cb` query param)

## Key Technology Decisions

1. **Canvas-based pixel capture** — `captureRegion()` uses `ctx.drawImage(video, ...)` to grab 160×160 region under cursor. Single `getImageData()` call per hover event.
2. **Summed-area tables (SAT)** for O(1) NCC verification — built once per hover event, reused across all trigger evaluations.
3. **jsDelivr → GitHub Raw rewrite** — all CDN URLs are rewritten to `raw.githubusercontent.com` to bypass CDN propagation lag during development.
4. **UMD for matcher-core** — dual-loadable as CommonJS (Node.js testing) and globalThis (browser content script).

