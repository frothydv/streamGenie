---
phase: 12-error-states
reviewed: 2026-05-15T00:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - extension/content.js
  - extension/popup.js
findings:
  critical: 0
  warning: 4
  info: 2
  total: 6
status: issues_found
---

# Phase 12: Code Review Report

**Reviewed:** 2026-05-15
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Phase 12 added error-state surfacing for CDN failures, stale-cache fallback, and schema validation across `content.js` and `popup.js`. The core state machine (three variables: `profileLoadError`, `profileStaleWarning`, `profileSchemaWarnings`) is sound and correctly threaded through to both the debug panel and the popup. No security vulnerabilities were found.

Four warnings were identified: a state-persistence bug where stale-cache path does not clear `profileLoadError` from a prior failed load; the `applyNote` error/stale banner is silently overwritten when the user clicks Apply; a misleading schema-warning message when `profile.triggers` is not an array at all; and the stale-cache `applyProfile()` call is not awaited, creating a race between the applied triggers and the `profileStaleWarning` assignment. Two info-level items are also noted.

---

## Warnings

### WR-01: Stale-cache path does not clear `profileLoadError` from a previous fetch failure

**File:** `extension/content.js:586-601`

**Issue:** When `fetchAndCacheProfile()` fails and a stale cache entry exists, the code sets `profileStaleWarning` and sets `usedStale = true`, but it never clears `profileLoadError`. If a prior invocation had set `profileLoadError` (e.g., a background refresh that also failed without a cache), the stale-success path leaves both `profileLoadError` and `profileStaleWarning` non-null simultaneously. The debug panel renders them both — an amber "CDN unreachable" warning alongside a red "profile error" line — which is contradictory (the profile actually loaded from stale cache). The popup, which only shows one via `else if`, would display the error (red) rather than the less alarming warning (amber), even though triggers are functional.

```js
// Current (lines 591-595):
if (cached) {
  applyProfile(cached.profile, ap.url);
  profileStaleWarning = err.message;
  usedStale = true;
}

// Fix: clear profileLoadError when stale cache is successfully used
if (cached) {
  applyProfile(cached.profile, ap.url);
  profileLoadError = null;          // <-- add this
  profileStaleWarning = err.message;
  usedStale = true;
}
```

---

### WR-02: Clicking Apply overwrites the error/stale `applyNote` banner without restoring it

**File:** `extension/popup.js:365-388`

**Issue:** On popup open, `applyNote` is set to a red "Profile failed to load" or amber "CDN unreachable" message (lines 178-186). When the user then clicks Apply (even for the same profile), `applyNote` is unconditionally overwritten with either "Already active." or "Reload the Twitch page to activate." (lines 381-385). The error information is permanently lost for the lifetime of that popup session, misleading the user into thinking the profile is healthy. Since the popup closes on apply only for the "reload" path (not "already active"), the user can observe the error text disappear and be replaced with an "Already active." message despite the profile still being broken.

```js
// Fix: only overwrite applyNote if no error/stale banner was previously set,
// or re-assert it after the status message:
if (unchanged) {
  applyNote.textContent = "Already active.";
  applyNote.style.color = "#adadb8";
} else {
  applyNote.textContent = "Reload the Twitch page to activate.";
  applyNote.style.color = "#00f593";
}
// Preserve error context below the action result:
if (contentProfileLoadError) {
  // Re-show or keep a secondary indicator
}
```

Simplest fix: skip overwriting `applyNote` when a prior error/stale text is shown, or use a separate element for the action feedback.

---

### WR-03: Schema warning message is misleading when `triggers` field is entirely absent

**File:** `extension/content.js:508-510`

**Issue:** When `profile.triggers` is not an array (e.g., the field is missing from the JSON), the code pushes the string `"triggers is not an array"` into `profileSchemaWarnings`, which is designed to hold trigger IDs. The debug panel renders it as:

> `1 trigger(s) skipped — invalid schema: triggers is not an array`

This is a category error — the panel says one *trigger* was skipped, but the real problem is the entire `triggers` array is malformed. The count `1` is also meaningless. More importantly, `updateDebugPanelStatus()` is still called at the end of `applyProfile()` (line 550), so the warning does appear, but its phrasing will confuse developers during debugging.

```js
// Fix: use a separate "structural" error path rather than pushing into the ID list:
if (!Array.isArray(profile.triggers)) {
  console.warn("[overlay/content] schema: profile.triggers is not an array");
  profileSchemaWarnings = ["(profile.triggers is not an array)"];
  profile.triggers = [];
}
// Or surface it via profileLoadError-style variable and dedicated panel line.
```

---

### WR-04: `applyProfile()` not awaited in the stale-cache path — `profileStaleWarning` assigned before `applyProfile` may complete

**File:** `extension/content.js:593-594`

**Issue:** `applyProfile` is `async` and takes up to several hundred milliseconds (it calls `chrome.storage.local.get`, iterates pending triggers, and calls `loadReferencesForTriggers`). In the stale-cache path (line 593), it is called without `await`:

```js
applyProfile(cached.profile, ap.url);   // missing await
profileStaleWarning = err.message;
usedStale = true;
```

While `profileStaleWarning` being set before or after the async work of `applyProfile` is unlikely to cause visible user-facing bugs (the debug panel re-renders on reference load events too), the call to `updateDebugPanelStatus()` *inside* `applyProfile` at line 550 fires before the function's own awaits complete, meaning the panel may render intermediate state. The `profileStaleWarning` is not yet set when that inner `updateDebugPanelStatus()` call runs, so the amber CDN warning is absent on the first render and only appears on the next panel update. Contrast with the happy path (line 585) where `applyProfile` is properly awaited.

```js
// Fix: await the call
applyProfile(cached.profile, ap.url);
// becomes:
await applyProfile(cached.profile, ap.url);
profileStaleWarning = err.message;
usedStale = true;
```

Note: the outer `try/catch` block already wraps this — the inner `try/catch (_) {}` around it swallows any errors from `applyProfile` either way, so adding `await` does not change error-handling behavior.

---

## Info

### IN-01: `applyNote` has no initial `display:none` — renders as empty space before JS runs

**File:** `extension/popup.html:187`, `extension/popup.js:178-186`

**Issue:** The `#apply-note` element has class `note` with no `display:none` in HTML. JS sets `display: "block"` when an error exists but never sets `display: "none"` in the clean/no-error path. The element is always present in the DOM flow. If neither error nor stale condition exists, the element simply has its default visible-but-empty state, consuming a small layout gap. This is benign but could cause a subtle visual artifact (an unexplained gap) before any status is written. The `applyBtn` click handler also never sets `display` at all, relying on the element already being visible.

No fix required unless popup layout is tightened, but worth adding `style="display:none"` to the HTML element and explicitly showing it only when text is set.

---

### IN-02: Debug console log uses backslash path separator in log prefix

**File:** `extension/content.js:582`, `extension/content.js:587`

**Issue:** Log lines use `[overlay\content]` (backslash) instead of `[overlay/content]` (forward slash). All other log lines in the file use the forward-slash convention. This makes filtering by `[overlay/content` in DevTools miss these two lines.

```js
// Line 582 — current:
console.log("[overlay\content] profile: fetched from CDN (cache-busted)");
// Fix:
console.log("[overlay/content] profile: fetched from CDN (cache-busted)");

// Line 587 — current:
console.warn("[overlay\content] profile fetch failed:", err.message);
// Fix:
console.warn("[overlay/content] profile fetch failed:", err.message);
```

---

_Reviewed: 2026-05-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
