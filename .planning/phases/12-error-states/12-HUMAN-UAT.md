---
status: partial
phase: 12-error-states
source: [12-VERIFICATION.md]
started: 2026-05-16T02:37:43Z
updated: 2026-05-16T02:37:43Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. CDN unreachable with stale cache — amber debug panel
expected: Block raw.githubusercontent.com in DevTools Network. With a cached profile in localStorage (key matching streamGenie_profile_*), reload the Twitch page. Debug panel shows amber line "WARNING CDN unreachable — using cached profile (Failed to fetch)". Red "profile error" line does NOT appear.
result: [pending]

### 2. CDN unreachable with no cache — red debug panel
expected: Block raw.githubusercontent.com AND delete localStorage profile cache entry. Reload. Debug panel shows red "profile error: Failed to fetch". No amber CDN line appears.
result: [pending]

### 3. Fresh fetch clears all warnings
expected: After test 1 or 2, unblock raw.githubusercontent.com and reload. Neither amber CDN warning nor red profile error line appears in debug panel.
result: [pending]

### 4. Popup reflects error state
expected: With CDN blocked and no cache, open popup — red note "Profile failed to load: ..." near profile selector. With stale cache active, amber "CDN unreachable — using cached profile" note instead.
result: [pending]

### 5. Schema validation skips bad triggers
expected: Load a crafted profile.json with one trigger with id: 123 (integer) and one valid trigger. Console warns "schema: 1 trigger(s) skipped — invalid schema: (unknown)". Debug panel shows amber "1 trigger(s) skipped — invalid schema: (unknown)". Valid trigger still matches on hover.
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
