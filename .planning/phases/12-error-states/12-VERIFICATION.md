---
phase: 12-error-states
verified: 2026-05-15T00:00:00Z
status: human_needed
score: 7/7 must-haves verified
overrides_applied: 0
human_verification:
  - test: "CDN unreachable with stale cache — debug panel amber indicator"
    expected: "When raw.githubusercontent.com is blocked in DevTools Network and a cached profile exists, the debug panel shows an amber line reading 'WARNING CDN unreachable — using cached profile (Failed to fetch)'"
    why_human: "Cannot simulate network failure or stale-cache path programmatically without a running browser"
  - test: "CDN unreachable with NO cache — debug panel red indicator"
    expected: "When raw.githubusercontent.com is blocked AND localStorage profile cache is cleared, the debug panel shows a red 'profile error: ...' line"
    why_human: "Requires live browser with DevTools network blocking"
  - test: "Fresh fetch clears both warning lines"
    expected: "After unblocking the CDN and reloading, neither amber nor red lines appear in the debug panel"
    why_human: "Requires live browser interaction"
  - test: "Popup reflects CDN error state"
    expected: "When CDN fails with no cache, opening the popup shows a red note 'Profile failed to load: ...' near the profile selector. When stale cache is used, shows amber 'CDN unreachable — using cached profile'"
    why_human: "Requires live browser with controlled CDN failure"
  - test: "Schema validation skips invalid triggers"
    expected: "A profile.json with one trigger missing a string id (e.g. id: 123) is loaded, the invalid trigger is skipped, valid triggers still match, and the debug panel shows an amber line '1 trigger(s) skipped — invalid schema: (unknown)'"
    why_human: "Requires loading a crafted malformed profile into the live extension"
---

# Phase 12: Error States — Verification Report

**Phase Goal:** Make CDN failures and malformed profiles visible — amber debug-panel warning when stale cache is used, error flags exposed to the popup, and invalid triggers skipped with diagnostics.
**Verified:** 2026-05-15
**Status:** human_needed (automated checks pass; live-browser tests required for behavioral confirmation)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | When CDN fetch fails and stale cache is used, the debug panel shows an amber warning | VERIFIED | `content.js` line 2664–2665: `if (profileStaleWarning)` pushes amber `#f5b000` span "WARNING CDN unreachable — using cached profile (…)" |
| 2 | When CDN fetch fails with no cache, the existing red error line in the debug panel is unchanged | VERIFIED | `content.js` line 2661–2663: `if (profileLoadError)` pushes red `#ff5c5c` span — code path intact, no regression |
| 3 | When a fresh fetch succeeds, both profileStaleWarning and profileLoadError are cleared | VERIFIED | `content.js` lines 583–584: `profileLoadError = null; profileStaleWarning = null;` on the success path |
| 4 | The get-game message response carries profileLoadError and profileStaleWarning | VERIFIED | `content.js` line 3543: `sendResponse({ game: detectedGame, profileLoadError: profileLoadError, profileStaleWarning: profileStaleWarning })` |
| 5 | Invalid triggers (per structural schema) are skipped and the rest of the profile still loads | VERIFIED | `content.js` lines 507–528: `applyProfile()` resets `profileSchemaWarnings`, filters `profile.triggers` via structural check, then assigns `TRIGGERS` from the filtered array |
| 6 | Debug panel shows how many triggers were skipped and their IDs in amber | VERIFIED | `content.js` lines 2667–2669: `if (profileSchemaWarnings && profileSchemaWarnings.length > 0)` pushes amber `#f5b000` span with count and joined IDs |
| 7 | Popup shows a note near the profile selector when profileLoadError or profileStaleWarning is set, using red for hard errors and amber for stale-cache | VERIFIED | `popup.js` lines 128–140, 178–186: local variables capture flags from get-game response; `applyNote` set to red `#ff5c5c` for hard errors, amber `#f5b000` for stale warning — `textContent` used throughout (no innerHTML) |

**Score:** 7/7 truths verified

### ROADMAP Success Criteria vs Implementation

| SC | Wording | Implementation | Status |
|----|---------|---------------|--------|
| SC1 | "Debug panel shows a red indicator when the profile CDN is unreachable" | Amber for stale-cache (CDN unreachable but cache exists); red only for hard failure (no cache). Design intentional per Plan 01 — amber/red are mutually exclusive and communicate severity. | WARNING — SC says "red" but design uses amber for stale path. Not a blocker: visible indicator IS shown; SC language is imprecise. |
| SC2 | "Debug panel shows a warning when profile JSON fails to parse or fails schema validation" | Malformed JSON throws in `res.json()` catch at line 586 — falls into same error path as network failure; `profileLoadError` or `profileStaleWarning` surfaces it. Schema failures: `profileSchemaWarnings` amber line. | VERIFIED |
| SC3 | "Popup reflects load-error state (not just 'no profile selected')" | `popup.js` lines 178–186 render applyNote with error text. | VERIFIED |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `extension/content.js` | profileStaleWarning, stale-branch wiring, debug panel amber line, get-game response fields | VERIFIED | All 4 elements present and substantive |
| `extension/content.js` | profileSchemaWarnings array, schema validation in applyProfile, schema-skip line in debug panel | VERIFIED | Declaration (line 95), validation loop (lines 507–525), debug line (lines 2667–2669) |
| `extension/popup.js` | get-game response handler reads profileLoadError and profileStaleWarning, renders note | VERIFIED | Lines 128–140 capture flags; lines 178–186 render applyNote |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `fetchAndCacheProfile()` stale-cache branch | `profileStaleWarning` variable | assignment inside `usedStale=true` branch | VERIFIED | `content.js` line 594: `profileStaleWarning = err.message;` precedes `usedStale = true` at line 595 |
| `updateDebugPanelStatus()` | `profileStaleWarning` | amber span push | VERIFIED | Line 2664: `if (profileStaleWarning)` → `lines.push(…#f5b000…)` |
| get-game message handler | `profileLoadError`, `profileStaleWarning` | `sendResponse` object | VERIFIED | Line 3543: both fields included in sendResponse literal |
| `applyProfile()` entry | `profileSchemaWarnings` array | validation loop filtering `profile.triggers` | VERIFIED | Lines 507–521: reset, conditional Array.isArray check, filter loop with push for failures |
| `updateDebugPanelStatus()` | `profileSchemaWarnings` | amber span with count and IDs | VERIFIED | Lines 2667–2669 |
| `popup.js` get-game response handler | `resp.profileLoadError`, `resp.profileStaleWarning` | local variables → applyNote update | VERIFIED | Lines 139–140 assign from resp; lines 178–186 apply to applyNote |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `updateDebugPanelStatus()` (debug panel) | `profileStaleWarning` | `err.message` from caught fetch Error in `fetchAndCacheProfile()` | Yes — JS runtime Error string, not hardcoded | FLOWING |
| `updateDebugPanelStatus()` (debug panel) | `profileLoadError` | `err.message` from caught fetch Error (no-cache path) | Yes | FLOWING |
| `updateDebugPanelStatus()` (debug panel) | `profileSchemaWarnings` | filter loop in `applyProfile()` pushing trigger id or "(unknown)" | Yes | FLOWING |
| `popup.js` applyNote | `contentProfileLoadError` | `resp?.profileLoadError` from get-game response | Yes — sourced from content.js at load time | FLOWING |
| `popup.js` applyNote | `contentProfileStaleWarning` | `resp?.profileStaleWarning` from get-game response | Yes | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| profileStaleWarning declared | `node -e "const s=require('fs').readFileSync('extension/content.js','utf8'); console.log(s.includes('let profileStaleWarning = null'))"` | Not run (requires cwd context) | VERIFIED by Read |
| get-game response includes both flags | grep on line 3543 | Both `profileLoadError: profileLoadError` and `profileStaleWarning: profileStaleWarning` present | VERIFIED |
| popup.js uses textContent not innerHTML | grep: no `applyNote.innerHTML` | Confirmed absent | VERIFIED |
| No debt markers in modified files | grep for TBD/FIXME/XXX | Zero results in both files | VERIFIED |

### Probe Execution

No probes declared or conventional probe files found for this phase. Step 7c: SKIPPED (no probe scripts).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| ERR-01 | 12-01, 12-02 | CDN unreachable → debug panel visible indicator | SATISFIED | Amber line for stale-cache CDN failure (content.js 2664–2665); red line for hard failure (2661–2663) |
| ERR-02 | 12-01, 12-02 | Profile JSON parse failure → debug panel warning with parse error | SATISFIED | `res.json()` SyntaxError caught at line 586; falls into profileLoadError (red) or profileStaleWarning (amber) path — surfaced in debug panel |
| ERR-03 | 12-02 | Schema validation → debug panel shows invalid fields | SATISFIED | `profileSchemaWarnings` amber debug line (lines 2667–2669) lists skipped trigger IDs |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | — | — | No anti-patterns found in modified files |

No `TBD`, `FIXME`, or `XXX` markers in either modified file. No stub returns, no hardcoded empty arrays in the new code paths.

### Human Verification Required

#### 1. CDN Unreachable with Stale Cache — Amber Debug Panel

**Test:** Block `raw.githubusercontent.com` in DevTools Network. Ensure a cached profile exists in localStorage (key matching `streamGenie_profile_*`). Reload the Twitch page with the extension active. Open the debug panel.
**Expected:** Amber line reading "WARNING CDN unreachable — using cached profile (Failed to fetch)" appears in the debug panel. The red "profile error" line does NOT appear.
**Why human:** Cannot simulate selective network failure or localStorage state programmatically without a live browser.

#### 2. CDN Unreachable with No Cache — Red Debug Panel

**Test:** Block `raw.githubusercontent.com` in DevTools Network AND delete the localStorage profile cache entry. Reload the Twitch page.
**Expected:** Red line "profile error: Failed to fetch" (or "profile error: HTTP NNN") appears in the debug panel. No amber CDN line.
**Why human:** Requires live browser with controlled DevTools network blocking and storage manipulation.

#### 3. Fresh Fetch Clears All Warnings

**Test:** After tests 1 or 2 above, unblock `raw.githubusercontent.com` in DevTools Network. Reload the Twitch page.
**Expected:** Neither the amber CDN warning nor the red profile error line appears in the debug panel.
**Why human:** Requires live browser interaction sequenced after network unblock.

#### 4. Popup Reflects Error State

**Test:** With CDN blocked and no cache, open the extension popup.
**Expected:** Red note "Profile failed to load: ..." appears near the profile selector (in the applyNote element). With stale cache active, amber "CDN unreachable — using cached profile" note appears instead.
**Why human:** Requires live browser with controlled failure state.

#### 5. Schema Validation Skips Bad Triggers

**Test:** Temporarily swap the profile.json URL to point to a crafted JSON containing one trigger with `id: 123` (integer, not string) and one valid trigger. Load the profile in the extension. Check the debug panel and verify the valid trigger still matches in the hover flow.
**Expected:** Console warn "schema: 1 trigger(s) skipped — invalid schema: (unknown)". Debug panel shows amber "1 trigger(s) skipped — invalid schema: (unknown)". Valid trigger still matches on hover.
**Why human:** Requires crafting and serving a malformed profile, which cannot be done statically.

### Gaps Summary

No gaps found. All 7 must-have truths are VERIFIED against the actual codebase. The ROADMAP SC1 wording says "red indicator" for CDN unreachable, but the implementation uses amber for the stale-cache case and red for the hard-failure case — this is an intentional, documented design decision in Plan 01 (mutually exclusive flags) and produces a more informative UX than a single color. This does not constitute a gap; it constitutes imprecise SC wording.

The phase goal is structurally achieved. Human verification is required to confirm behavioral correctness in a live browser.

---

_Verified: 2026-05-15_
_Verifier: Claude (gsd-verifier)_
