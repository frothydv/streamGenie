# Conventions — Code Style, Patterns & Practices

## Code Style & Structure

### Content Script (`content.js`)
- **IIFE guard pattern:** `(function () { if (window.__streamOverlayLoaded) return; window.__streamOverlayLoaded = true; ... })();` Prevents double-injection on extension reload.
- **Constants at top:** All config constants defined as `const` at file top.
- **function declarations** (not arrow) for named functions: `function findBestVideo() { ... }`, `function heartbeat() { ... }`
- **Arrow functions** for callbacks and concise expressions: `const sorted = triggers.sort((a, b) => ...)`
- **Single-letter variables:** Rare, only in hot loops (`let i = 0; i < src; i += 4`)
- **Descriptive naming:** `currentVideo`, `activeProfile`, `editorModalOpen`, `mouseOverVideo`

### Popup (`popup.js`)
- **IIFE async wrapper:** `(async function () { ... })();`
- **DOM references** stored at top after HTML elements are accessed once.
- **Event listeners** attached after element references.
- **Inline HTML** in template strings for UI widgets (no framework).

### Matcher Core (`matcher-core.js`)
- **UMD pattern:** `(function (root, factory) { const api = factory(); if (typeof module !== "undefined") module.exports = api; if (root) root.StreamGenieMatcher = api; })(...)`
- **Config object pattern:** `createMatcher(options = {})` merges user options with `DEFAULTS`.
- **Factory function** returns an object of methods — no classes.
- **Pure functions** with no side effects — all state passed as arguments.
- **TypedArrays:** `Uint8Array`, `Float32Array`, `Float64Array`, `Int16Array` for performance.

### Worker (`workers/submit-trigger/index.js`)
- **ES module** (`export default { async fetch(request, env) { ... } }`)
- **Guard clauses:** Early returns for OPTIONS/CORS, method check, auth check.
- **Mode dispatch:** `if (mode === "activate")`, `if (mode === "verify")` — flat structure, no switch.
- **Helper factory:** `function githubClient(token)` returns a configured GitHub API client.

## Error Handling Patterns

### Extension
- **try/catch** around all async operations (profile fetch, storage, worker calls).
- **Graceful fallbacks:** stale cache → try CDN → fallback to stale cache.
- **Error toasts:** `showToast(message, level)` with four levels: `ok`, `info`, `warn`, `error`.
- **Defensive returns:** Early returns for null/missing state (e.g., `if (!video) return;`).

### Matcher Core
- **No exceptions thrown** — all functions return result objects with `{ dist, ratio, validBits, ... }`.
- **Null/undefined checks:** `ref?.refHash`, `ref?.refValidBits ?? 64`.
- **Edge cases handled:** zero-variance regions return NCC score 0; microscopic refs skip matching.

### Worker
- **Error responses as JSON:** `return json({ ok: false, error: "message" }, statusCode)`.
- **HTTP status codes:** 401 for auth failure, 400 for bad request, 500 for server errors.
- **401 on wrong secret** to avoid leaking info.

## Shared Patterns

### `ensureRawUrl()` — URL Rewriting
Both `content.js` and `popup.js` contain an identical `ensureRawUrl()` function that rewrites jsDelivr CDN URLs to direct GitHub Raw URLs to bypass CDN propagation lag.

### Cache-Busting Pattern
```javascript
const url = new URL(ensureRawUrl(ap.url));
url.searchParams.set("_cb", Date.now());
const res = await fetch(url.toString(), { cache: "no-store" });
```

### Storage Key Pattern
All chrome.storage keys use the `streamGenie_` prefix followed by a descriptive name:
- `streamGenie_active_profile` — current active profile
- `streamGenie_profile_{gameId}_{profileId}` — cached profile data
- `streamGenie_triggers_{gameId}_{profileId}` — user triggers
- `streamGenie_debugPanel` — debug panel toggle
- `streamGenie_ext_pref_{channel}` — per-channel extension preference

## Testing Conventions

- **No test framework** — all tests are Node.js scripts using `assert` module.
- **Tests are ordered** and print their own pass/fail messages.
- **Console-driven:** Tests output logs and throw on failures.
- **File-level tests:** Each test file is executed directly with `node`.
- **Static analysis tests:** `static_analysis.test.js` uses regex to check variable naming and code structure — no DOM/headless browser required.

## DOM Interaction Patterns

- **No jQuery or UI framework.** All DOM manipulation is raw `document.createElement`, `Object.assign(el.style, { ... })`, `el.appendChild()`.
- **Inline styles** are set programmatically (not via CSS classes) for dynamic UI elements.
- **CSS-in-JS** for modals: styles defined in JS objects, applied via `Object.assign(el.style, { ... })`.
- **Positioning:** Dynamic overlay elements use `position: fixed` with z-index `2147483647` (max safe).

## IPC Patterns (Chrome)

| Sender | → | Receiver | Message Type |
|--------|---|----------|-------------|
| Background (hotkey) | → | Content | `capture-trigger` |
| Popup | → | Content | `capture-trigger`, `get-game`, `review-proposal`, `edit-trigger`, `open-curator`, `reload-profile`, `ping` |
| Content | → | Popup | `{ game }` (response to `get-game`) |
| Storage listener | — | Content | Reacts to `streamGenie_active_profile` and `streamGenie_debugPanel` changes |

## Profile Schema Convention

Profile JSON structure (served by the repository):
```json
{
  "triggers": [
    {
      "id": "unique-trigger-id",
      "payloads": [{ "title": "Name", "text": "Description", "popupOffset": { "x": 14, "y": 22 } }],
      "references": [{ "file": "image.png", "w": 32, "h": 32, "srcW": 1920, "srcH": 1080 }],
      "rotation": { "mode": "free", "minAngle": -30, "maxAngle": 30 }
    }
  ]
}
```

