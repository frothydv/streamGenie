---
phase: 12-error-states
plan: "01"
subsystem: content-script
tags: [error-states, debug-panel, cdn, stale-cache]
dependency_graph:
  requires: []
  provides: [profileStaleWarning, stale-cache-debug-indicator, get-game-error-fields]
  affects: [extension/content.js]
tech_stack:
  added: []
  patterns: [amber-warning-line, mutually-exclusive-error-flags]
key_files:
  created: []
  modified:
    - extension/content.js
decisions:
  - "profileStaleWarning and profileLoadError are mutually exclusive per fetch attempt — stale path sets warning, no-cache path sets error"
  - "err.message from fetch is a JS runtime string (not profile-supplied content) — safe to render via innerHTML in developer-facing debug panel"
metrics:
  duration: "~10 minutes"
  completed: "2026-05-15"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 1
---

# Phase 12 Plan 01: CDN Warning and get-game Extension Summary

**One-liner:** Stale-cache CDN failures now surface as an amber debug-panel warning and are exposed to the popup via the get-game response.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Declare profileStaleWarning and wire into fetchAndCacheProfile | b953eae | extension/content.js |
| 2 | Render stale-cache warning in debug panel and expand get-game response | a09345d | extension/content.js |

## What Was Built

Three edits to `extension/content.js`:

1. **Variable declaration** (line 94): `let profileStaleWarning = null;` added after `profileLoadError`, with a comment describing its purpose.

2. **Stale-cache wiring** in `fetchAndCacheProfile()`:
   - Success path: clears both `profileLoadError = null` and `profileStaleWarning = null`
   - Stale-cache branch: sets `profileStaleWarning = err.message` before `usedStale = true`
   - No-cache failure branch: unchanged — still sets `profileLoadError` only

3. **Debug panel render** in `updateDebugPanelStatus()`: amber span (`#f5b000`) added after the existing red profileLoadError block: "WARNING CDN unreachable — using cached profile (…)"

4. **get-game response expansion** (line 3517): `sendResponse({ game: detectedGame, profileLoadError: profileLoadError, profileStaleWarning: profileStaleWarning })` — both error flags now travel to the popup.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. Both flags are fully wired end-to-end for the content-script side. Plan 02 will consume the get-game response fields in popup.js.

## Threat Flags

No new security-relevant surface introduced. err.message is a JS runtime string from fetch, not profile-supplied content. Threat register entries T-12-01 and T-12-02 reviewed — both dispositions (mitigate/accept) are satisfied by the existing implementation pattern.

## Self-Check

**Files exist:**
- extension/content.js — modified (not a new file, exists)

**Commits exist:**
- b953eae — feat(12-01): declare profileStaleWarning and wire into fetchAndCacheProfile
- a09345d — feat(12-01): surface stale-cache warning in debug panel and get-game response

## Self-Check: PASSED
