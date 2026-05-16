# Code Conventions

**Analysis Date:** 2026-05-10

## Module Pattern

**Content script:** Single large IIFE in `extension/content.js` with a double-injection guard:
```js
if (window.__streamOverlayLoaded) return;
window.__streamOverlayLoaded = true;
```

**Matcher:** `extension/matcher-core.js` uses UMD pattern — works in both browser (`globalThis.StreamGenieMatcher`) and Node.js (`module.exports`). Loaded before `content.js` per manifest `content_scripts` order.

**Popup:** `extension/popup.js` is a plain script tag in `popup.html`, no module wrapper.

## Naming

- **Functions/variables:** camelCase (`findBestVideo`, `captureRegion`, `applyProfile`)
- **Constants:** UPPER_SNAKE_CASE (`CAPTURE_SIZE`, `PROFILE_CACHE_TTL_MS`, `WORKER_URL`)
- **DOM IDs/classes:** kebab-case (`stream-genie-popup`, `sg-debug-panel`)
- **Trigger IDs:** kebab-case strings in profile JSON (`map-button`, `coin-gold`)

## Logging

All console output is prefixed with a bracketed tag for easy DevTools filtering:

| Tag | File | Filter |
|-----|------|--------|
| `[overlay/content]` | `content.js` | `[overlay` catches all |
| `[overlay/bg]` | `background.js` | |
| `[overlay/popup]` | `popup.js` | |
| `[overlay/matcher]` | `matcher-core.js` | |
| `[overlay/submit]` | worker client code | |

## Error Handling

- Silent `catch (_) {}` blocks in profile fetch paths (known gap — see CONCERNS.md)
- No global error handler or `window.onerror` listener
- Debug panel surfaces match distances but not load errors
- Worker errors logged to console but not surfaced in UI

## Known Anti-Pattern: `parseFloat(x) || default`

`parseFloat("0") || default` treats `0` as falsy. Fixed via `parseOrDef(val, def)` helper in `content.js`:
```js
function parseOrDef(val, def) {
  const n = parseFloat(val);
  return isNaN(n) ? def : n;
}
```
**Use this everywhere rotation inputs are read.** Do not use `parseFloat(x) || default`.

## UI Construction

- Vanilla DOM throughout — no framework
- Mix of `Object.assign(el.style, {...})` and `.style.cssText` for inline styles
- `innerHTML` template literals used for popup content (XSS risk — see CONCERNS.md)
- Twitch dark palette hardcoded: background `#18181b`, text `#efeff1`, purple `#9146ff`/`#bf94ff`

## Caching Pattern

Profile JSON cached in `chrome.storage.local` with explicit TTL:
```js
{ data: profileJson, ts: Date.now() }
// Valid if: Date.now() - ts < PROFILE_CACHE_TTL_MS (2 minutes)
// On network failure: stale value returned as fallback
```
Cache key format: `streamGenie_profile_{gameId}_{profileId}`

## `ensureRawUrl()` Convention

Both `content.js` and `popup.js` duplicate this helper to convert jsDelivr URLs to `raw.githubusercontent.com`. Any URL from the catalog must pass through `ensureRawUrl()` before fetch.

## Tooling

- No ESLint, Prettier, or other linting/formatting config
- No bundler or build step
- 2-space indentation throughout
- No TypeScript or JSDoc types
