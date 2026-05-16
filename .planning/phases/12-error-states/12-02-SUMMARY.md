---
phase: 12-error-states
plan: "02"
subsystem: content-script
tags: [error-states, schema-validation, popup, debug-panel]
dependency_graph:
  requires:
    - phase: 12-01
      provides: [profileStaleWarning, profileLoadError, get-game-error-fields]
  provides: [profileSchemaWarnings, schema-validation-in-applyProfile, popup-error-note]
  affects: [extension/content.js, extension/popup.js]
tech_stack:
  added: []
  patterns: [shallow-schema-validation, error-flag-propagation-to-popup]
key_files:
  created: []
  modified:
    - extension/content.js
    - extension/popup.js
key_decisions:
  - "Schema validation checks only structural fields (id, references[].file/w/h) — payloads and rotation fields are intentionally excluded (too volatile per D-04)"
  - "applyNote (id=apply-note) reused rather than creating a new DOM element — avoids layout disruption"
  - "contentProfileLoadError/contentProfileStaleWarning stored as local variables before applyNote declaration to avoid temporal dependency on DOM init order"
patterns-established:
  - "Schema validation: filter-and-warn pattern — invalid entries skipped, valid entries unaffected"
  - "Error propagation: content.js flags travel via get-game message response to popup.js"
requirements-completed: [ERR-01, ERR-02, ERR-03]
duration: ~2min
completed: 2026-05-16
---

# Phase 12 Plan 02: Schema Validation and Popup Error Notes Summary

**Invalid profile triggers now filtered silently by structural schema check, with amber debug-panel diagnostics and red/amber popup notes reflecting CDN load errors from content.js**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-05-16T02:22:00Z
- **Completed:** 2026-05-16T02:24:12Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- `applyProfile()` now validates each trigger structurally before inserting into `TRIGGERS` — triggers missing a string `id`, non-array `references`, or refs missing `file`/`w`/`h` are skipped and their IDs recorded in `profileSchemaWarnings`
- Debug panel shows an amber line listing skipped trigger count and IDs whenever `profileSchemaWarnings` is non-empty
- Popup's `applyNote` element now reflects content.js profile errors: red "Profile failed to load: ..." for hard CDN failures, amber "CDN unreachable — using cached profile" for stale-cache warnings

## Task Commits

Each task was committed atomically:

1. **Task 1: Add profileSchemaWarnings and schema validation in applyProfile** - `9a1ee5d` (feat)
2. **Task 2: Show content.js error flags in popup near profile selector** - `c11bd5d` (feat)

**Plan metadata:** (docs commit below)

## Files Created/Modified
- `extension/content.js` — Added `profileSchemaWarnings` declaration, validation loop in `applyProfile()`, and amber debug panel line
- `extension/popup.js` — Captured `contentProfileLoadError`/`contentProfileStaleWarning` from get-game response, applied to `applyNote` after DOM init

## Decisions Made
- Validation excludes `payloads` and `rotation` fields (volatile/optional per D-04 decision) — only checks structural keys needed for matching
- `textContent` used (not `innerHTML`) for popup note text — prevents XSS on any error string from fetch (T-12-04, T-12-05 mitigated)
- Local variables capture error flags before `applyNote` DOM element is declared — avoids referencing undeclared variables in async init order

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. Both error flag paths are fully wired end-to-end. Content.js sets flags during profile fetch; popup.js reads them on every open.

## Threat Flags

No new security-relevant surface introduced. All threat register entries (T-12-03, T-12-04, T-12-05) reviewed:
- T-12-03: trigger.id values from CDN profile are developer-authored identifiers shown only in debug panel and console — accepted
- T-12-04/T-12-05: `textContent` used for popup note — XSS not possible

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

Phase 12 (Error States) is now complete. Both plans delivered:
- 12-01: CDN failure detection + stale-cache warning in debug panel + get-game extension
- 12-02: Schema validation + popup error notes

Phase 13 (viewer onboarding / profile curation UX) can proceed.

---
*Phase: 12-error-states*
*Completed: 2026-05-16*
