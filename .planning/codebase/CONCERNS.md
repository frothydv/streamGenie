# Concerns — Technical Debt, Risks & Known Issues

## High Priority

### 1. Monolithic `content.js` (~3726 lines)
**Risk:** High. One file handles video discovery, mouse tracking, pixel capture, hash matching, popup rendering, trigger editor modal, debug panel, curator panel, extension interference handling, profile loading/caching, and a diagnostic click dumper. This has already caused synchronization bugs (v0.6.5 fixed ID-based deduplication and sorting issues).

**Symptoms:**
- Duplicated logic (`ensureRawUrl()` exists identically in both `content.js` and `popup.js`)
- Interleaved concerns (matching logic adjacent to DOM rendering adjacent to Chrome IPC)
- Debug logging everywhere (74 `console.log/warn/error` calls)
- Hard to test — browser-dependent code mixed with pure logic

**Recommendation:** Extract into modules:
- `matcher-core.js` (already extracted — good)
- `profile-loader.js` (profile fetch, cache, apply)
- `capture-engine.js` (video discovery, mouse tracking, pixel capture)
- `ui-renderer.js` (popups, editor modal, debug panel, curator)
- `interference-handler.js` (Twitch extension overlay management)

### 2. Hardcoded Secrets in Extension Bundle
**Risk:** High. `SUBMIT_SECRET = "YorkshireTractorFactor"` and `WORKER_URL` are hardcoded in both `content.js` and `popup.js`. Anyone who unpacks the extension can read these:
- Submit fraudulent triggers with arbitrary content
- Spam the worker with activation pings
- Impersonate trusted contributors (if they also steal a contributor code)

**Documented as accepted risk for dev build.** For production, must use OAuth flow or per-instance secrets.

### 3. `ensureRawUrl()` Duplication
**Risk:** Medium. The exact same function (31 lines) exists in both `content.js` and `popup.js`. A fix in one but not the other creates hard-to-diagnose URL loading bugs. This has already happened historically (CDN vs Raw URL confusion during v0.6.x development).

### 4. No Build Tool / Module System
**Risk:** Medium. All extension JS is loaded directly as individual files in `manifest.json`. No bundling means:
- No tree-shaking (entire files loaded even if only partially used)
- Global namespace pollution (`StreamGenieMatcher` on `globalThis`)
- Hard to add npm dependencies (must manually vendor them)
- All Chrome API calls must be prefixed with `chrome.` — no abstraction layer

## Medium Priority

### 5. No Production CI/CD
**Risk:** Medium. No GitHub Actions, no automated testing, no linting. The build script (`scripts/build-alpha.js`) only creates a `.zip` and is Windows-specific (uses PowerShell `Compress-Archive`).

### 6. No Schema Validation for Profile JSON
**Risk:** Medium. Profiles are fetched as JSON and used directly. A malformed profile (missing `triggers` array, wrong reference format) will silently fail or throw unhandled errors. The `rehashRef()` function has defensive checks but there's no upfront schema validation.

### 7. Test Coverage Gaps
**Risk:** Medium-High. Critical browser-dependent paths are untested:
- Mouse coordinate transformation (`clientToVideoCoords`)
- Pixel capture (`captureRegion`)
- All UI rendering (editor modal, debug panel, popup overlay, curator panel)
- Chrome storage interactions (`chrome.storage.local`)
- End-to-end hover-to-popup flow

Tests cover matching algorithm thoroughly but leave the integration layer uncovered.

### 8. Chrome MV3 Limitations
**Risk:** Medium. Service workers can be killed by Chrome at any time. The current design assumes the service worker lives long enough to forward hotkey events. Content script handles all real work, so this is mostly ok, but:
- `chrome.commands.onCommand` listener may not fire if the service worker is terminated
- No persistent state for the service worker (must re-initialize on wake)
- No `localStorage` in service worker (content script uses it for profile cache)

## Low Priority

### 9. Debug Logging in Production
**Risk:** Low. 74 console calls remain in `content.js`. These are filtered by the `[overlay/` prefix convention, but they add bundle size and could leak information about profiles/triggers in user consoles.

### 10. Twitch DOM Dependency
**Risk:** Low-Medium (for future). Game detection and video discovery depend on specific DOM selectors:
- `[data-a-target="stream-game-link"]` for game detection
- `querySelectorAll("video")` for video discovery
- These selectors could break when Twitch updates their UI

### 11. Rotation Animation Performance
**Risk:** Low. The trigger editor's rotation preview runs a `setInterval` at 40ms (25fps) with canvas rotation. Very large references could cause jank during preview. Safeguard exists (rotateWarnEl warns for refs >117px).

### 12. No Error Boundary for Editor Modal
**Risk:** Low. The `openTriggerEditor()` function builds a complex modal with nested UI (mask editor, payload editor, rotation preview). An unhandled error inside any of these sub-components leaves the user stuck with an unresponsive modal (the `closeEditor()` cleanup may not run).

## Already Documented Issues

From `CLAUDE.md` and `README.md`:
- **Propagation delay:** Profile updates take 1–5 min to appear even with cache busting.
- **Low-resolution matching degrades** below 720p.
- **Chrome reserves Ctrl+Shift+C** for DevTools → extension uses Alt+Shift+C.
- **Twitch homepage video preloaders** trip up naive `querySelector("video")`.

## Metrics That Suggest Concerns

| Metric | Value | Signal |
|--------|-------|--------|
| `content.js` lines | 3726 | Too large for one file |
| Console calls in content.js | 74 | Excessive debug logging |
| Duplicated functions | `ensureRawUrl()` in 2 files | DRY violation |
| `catch (err)` blocks | ~30 in content.js | Many error recovery paths (both good and bad — indicates distributed error handling) |
| No module/system | — | No TypeScript, no bundler, no linting |
| No CI | — | Every test must be run manually |

