# Phase 12: Error States - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Surface three categories of failure in the debug panel and popup: CDN/network errors (ERR-01), JSON parse errors (ERR-02), and schema validation failures (ERR-03). Currently these fail silently or only partially surface. No new network calls, no new Worker ops — this is purely diagnostic wiring in `content.js` and `popup.js`.

**What already exists (don't rebuild):**
- `profileLoadError` variable in `content.js` — set on fetch fail when no stale cache; shown in red in debug panel (`content.js:2636`)
- `fetchAndCacheProfile()` catch block already sets `profileLoadError` and calls `showToast()` for no-cache failures
- `popup.js:746` already shows a network-error note near the profile selector for its own fetch errors
- `get-game` message handler already returns game/slug from content.js to popup — extend this, don't duplicate

</domain>

<decisions>
## Implementation Decisions

### ERR-01: CDN unreachable — stale cache available

- **D-01:** When CDN fetch fails but stale cache is used, set a separate `profileStaleWarning` flag (distinct from `profileLoadError`). Debug panel shows it in **amber/yellow**: e.g. `⚠ CDN unreachable — using cached profile`. This is a warning, not an error — matching still works. The existing red `profile error` line is for the no-cache failure case only.

### ERR-01/02: CDN unreachable or parse error — no cache

- **D-02:** The existing `profileLoadError` red line in the debug panel covers this case. No change to the debug panel display needed.
- **D-03:** The popup must also reflect this error. Implement by piggybacking on the existing `get-game` message: add `profileLoadError` (and `profileStaleWarning`) to the response object that content.js returns when the popup sends `{type:"get-game"}`. Popup already reads this response on open — use the same field to show the error near the profile selector (same area as the existing `note` element at `popup.js:746`).

### ERR-03: Schema validation

- **D-04:** Validate profile JSON with a **shallow structural check** in `applyProfile()` (or just before calling it). Check:
  - `profile.triggers` is an Array
  - Each trigger has: `id` (string), `references` (non-empty Array)
  - Each reference has: `file` (string), `w` (number), `h` (number)
  - Payloads, rotation schema, mask fields are **not** validated — too volatile as schema evolves
- **D-05:** Invalid triggers are **skipped**, not cause for rejecting the whole profile. The valid ones still load and match. Debug panel shows: `N trigger(s) skipped — invalid schema: [id1, id2]`. This message uses the existing `lines.push(...)` pattern in `updateDebugPanelStatus()`.
- **D-06:** Set a `profileSchemaWarnings` array (not a string) to accumulate skip-reasons; cleared and repopulated on each `applyProfile()` call.

### Claude's Discretion

- Exact wording of warning/error strings (keep them short, consistent with existing console log style)
- Whether `profileStaleWarning` and `profileSchemaWarnings` are cleared on successful fresh fetch (yes — clear them in the success path at `content.js:559`)
- How popup renders the stale-cache warning vs. the hard error (same note element, different icon/color)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — ERR-01, ERR-02, ERR-03

### Project Primer
- `CLAUDE.md` — architectural context, profile/catalog schema, Worker ops

### Codebase Maps
- `.planning/codebase/STRUCTURE.md` — file responsibilities; key: `content.js:529–577` (`loadProfile`/`fetchAndCacheProfile`), `content.js:2625–2648` (`updateDebugPanelStatus`), `popup.js:163–248` (profile selector + error note)
- `.planning/codebase/CONVENTIONS.md` — logging tags, inline style pattern, `textContent` not `innerHTML` for user-facing strings

### Key code locations (read before editing)
- `extension/content.js:529–577` — `loadProfile()` and `fetchAndCacheProfile()` — this is where stale-cache and fetch-error logic lives
- `extension/content.js:2625–2648` — `updateDebugPanelStatus()` — where new warning lines get added
- `extension/content.js:504–527` — `applyProfile()` — where schema validation runs
- `extension/popup.js:163–250` — profile selector area including existing network-error note
- `extension/popup.js:850–895` — `get-game` message handling in popup — extend response here

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `profileLoadError` (string | null) — already wired to debug panel; just add population in stale-cache path
- `updateDebugPanelStatus()` — add new `lines.push(...)` entries for stale warning and schema skips
- `showToast(msg, type)` — available for one-shot user notifications
- `get-game` response object — extend with `profileLoadError` and `profileStaleWarning` fields
- `note` element in popup (`popup.js:742–746`) — already used for network errors; reuse for content.js errors

### Established Patterns
- Debug panel status lines: `lines.push('<span style="color:{color}">{message}</span>')` — amber = `#f5b000`, red = `#ff5c5c`
- Error state reset on success: `profileLoadError = null` at `content.js:559` — follow same pattern for new flags
- Content→popup communication: `chrome.tabs.sendMessage` response object (see `get-game` handler)

### Integration Points
- `fetchAndCacheProfile()` stale-cache branch (`content.js:563–571`): add `profileStaleWarning = err.message` here
- `applyProfile()` entry (`content.js:504`): add structural validation loop before processing triggers
- `updateDebugPanelStatus()` (`content.js:2632`): add amber stale-warning and schema-skip lines
- `get-game` message handler in `content.js`: add `profileLoadError` and `profileStaleWarning` to response
- Popup `get-game` response handler: read those fields and update the `note` element

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond decisions above — open to standard approaches for string formatting and element reuse.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 12-error-states*
*Context gathered: 2026-05-13*
