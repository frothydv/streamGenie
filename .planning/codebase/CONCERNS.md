# Technical Concerns

**Analysis Date:** 2026-05-10

## Security (Pre-Beta Must-Fix)

### 1. Hardcoded submit secret (CRITICAL)
`SUBMIT_SECRET = "YorkshireTractorFactor"` is plaintext in `extension/content.js:71` and `extension/popup.js:7`. Anyone who unpacks the extension zip can read it and spam the Worker endpoint.
- **Fix before store listing:** Move to a per-session token flow or rate-limit by origin instead.

### 2. XSS via innerHTML
`payload.title` and `payload.text` from profile JSON are interpolated directly into `innerHTML` in `content.js` around line 2326-2337 (popup rendering). A malicious profile in the repo could inject scripts into every viewer's Twitch page.
- **Fix:** Sanitize with `textContent` assignment or DOMPurify before any innerHTML insertion.
- Same issue: `err.message` in `innerHTML` at `popup.js:480`.

### 3. Zero rate limiting on Cloudflare Worker
`workers/submit-trigger/index.js` has no rate limiting. Any caller with the `SUBMIT_SECRET` can hit the Worker endpoint at will — opening PRs, merging, rejecting. Since the secret is visible in the unpacked extension (see #1), this is effectively public.
- **Fix:** Add per-IP or per-key request throttling in the Worker.

### 4. No schema validation on profile.json
`applyProfile()` in `content.js` trusts profile JSON structure entirely. A malformed or malicious profile could cause runtime errors or (combined with #2) inject content.
- **Fix:** Validate required fields before applying.

## Beta Blockers

### 5. No viewer onboarding
When no profile matches the current stream, the extension is silent. Viewers have no way to know the extension is installed but inactive.
- Needed: "No profile found for this stream" state in debug panel and/or a first-run banner.

### 6. Silent CDN failures
Bare `catch (_) {}` blocks in profile fetch paths (`content.js` ~line 542, 568). CDN outage, malformed JSON, or schema mismatch produces no user-visible error — the extension just silently does nothing.
- Needed: At minimum a debug panel indicator when profile load fails.

### 7. No privacy disclosure
Store listing and first-run flow must state that pixels are read locally and nothing leaves the device. Currently neither exists.

### 8. Manual profile selection
Popup requires the user to manually pick a profile from the list. Auto-selection (top verified profile) and streamer-specific overrides are not implemented. Friction at first use.

## Technical Debt

### 9. content.js monolith (~3700 lines)
The entire content script is one IIFE with 10 logical sections. Makes navigation hard; no section is independently testable. Not blocking for beta but will become painful as the codebase grows.

### 10. `ensureRawUrl()` duplication
Identical function in both `content.js` and `popup.js`. Should be a shared utility, but there's no module system to share across content scripts and popup scripts without bundling.

### 11. Debug log statements left in production
`[DEBUG]` console.log statements remain in production code (`content.js` ~lines 841-848). These emit on every hover event and will appear in viewer consoles.

### 12. `_isModified` flag is in-memory only
The editor's unsaved-changes tracking is lost on page reload. A contributor can lose work without warning.

### 13. Canvas elements not pooled
`rehashRef()` creates new canvas elements on each call rather than reusing a pool. Minor perf issue on heavy editing sessions.

### 14. Uncommitted analysis files in repo root
`BRANCH_SUMMARY.md`, `CLEANUP_INSTRUCTIONS.md`, `ISSUE_ANALYSIS.md`, `ISSUE_SUMMARY.md` are untracked files in the repo root. Either commit or delete them before public launch.

## Performance Concerns

### 15. content.js parse time
At ~3700 lines, the content script parse + eval time on every new Twitch tab is non-trivial. No measurements taken. Probably acceptable but worth profiling before beta.

### 16. Hover event frequency
The matching pipeline runs on every `mousemove`. The 500ms debounce (`HOVER_DEBOUNCE_MS`) throttles it, but at high cursor speeds multiple events can queue. SAT overhead is ~0.24ms per hover event per the agent benchmark — acceptable.

## Risks

### 17. Twitch DOM change breaks game detection
`detectTwitchGame()` depends on `[data-a-target="stream-game-link"]`. Twitch can rename this attribute at any time without notice — game detection silently breaks for all users.
- Mitigation: Monitor Twitch DOM changes; no automated alert exists.

### 18. raw.githubusercontent.com outage = total profile loss
If GitHub's raw content CDN is unreachable, users get the hardcoded fallback catalog (STS2 only) with no error message. Other profiles disappear silently.

### 19. jsDelivr effectively disabled
`ensureRawUrl()` converts all jsDelivr URLs to raw.githubusercontent.com. This was correct during active development but must be reconsidered before public launch — jsDelivr provides better global latency and caching than raw.githubusercontent.com.

### 20. MV3 service worker lifecycle
The service worker (`background.js`) is currently stateless, which is safe. If state is ever added, MV3's aggressive service worker termination will cause data loss. Keep background.js stateless.

## Known Bugs (from agent analysis)

- `localTriggers is not defined` around `content.js:~548` — breaks mask/offset persistence after edit sessions
- Mask changes lost on refresh — `maskImg.onerror = finish` silently skips mask load errors
- Ghost user-storage triggers from old code iterations persist in some installations
