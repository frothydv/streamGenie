# Phase 12: Error States - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-13
**Phase:** 12-error-states
**Areas discussed:** Stale-cache silent failure, Schema validation depth, Popup ↔ content error sync

---

## Stale-cache silent failure

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — warn but don't alarm | Amber 'using stale cache' line in debug panel | ✓ |
| No — silent fallback is fine | Don't show non-fatal condition | |

**User's choice:** Warn with amber line; matching still works so it's informational not alarming.

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — popup should show error too | Add profileLoadError to get-game response | ✓ |
| No — debug panel is enough | Keep popup independent | |

**User's choice:** Popup should also reflect hard errors from content.js.

---

## Schema validation depth

| Option | Description | Selected |
|--------|-------------|----------|
| Shallow — structural check only | triggers array, id/references presence, file/w/h on refs | ✓ |
| Deep — validate every field | Check payloads, rotation schema, mask URLs | |
| Minimal — just catch thrown errors | Wrap in try/catch, surface JS errors | |

**User's choice:** Shallow structural check only — enough to catch real-world malformed profiles without over-engineering.

| Option | Description | Selected |
|--------|-------------|----------|
| Skip it, warn in debug panel | Drop invalid triggers, show IDs in debug panel | ✓ |
| Abort the whole profile | Reject profile on any invalid trigger | |

**User's choice:** Skip invalid triggers, keep valid ones working, surface skipped IDs in debug panel.

---

## Popup ↔ content error sync

| Option | Description | Selected |
|--------|-------------|----------|
| Piggyback on get-game | Add profileLoadError to existing response | ✓ |
| New get-status message | Dedicated diagnostic message type | |
| Poll on a timer | Periodic polling | |

**User's choice:** Piggyback on get-game — zero new message types.

| Option | Description | Selected |
|--------|-------------|----------|
| Near the profile selector | Below profile name, reuse existing note element | ✓ |
| Top of popup as a banner | Full-width banner | |

**User's choice:** Near the profile selector, consistent with existing error note location.

---

## Claude's Discretion

- Exact warning/error string wording
- Whether to clear flags on successful fresh fetch (should follow existing `profileLoadError = null` pattern)
- Popup rendering of stale warning vs. hard error (same element, different color/icon)

## Deferred Ideas

None.
