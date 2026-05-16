# Phase 13: Privacy & Permissions Disclosure - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Text and documentation changes only — no new extension features. Deliver two artifacts:

1. **First-run banner enhancement** (`popup.html`): Add a "Privacy →" link alongside the existing privacy statement so users who want details can access the full privacy policy. The existing text ("Pixel matching runs locally — nothing leaves your device.") stays as-is.

2. **Permissions documentation** (`README.md` + new `STORE-LISTING.md`): Add a permissions table to README explaining each manifest permission in plain English. Create `STORE-LISTING.md` with Chrome Web Store copy (short description, long description, and permissions justification section).

**What already exists (don't rebuild):**
- `popup.html:147-150` — First-run banner is fully wired from Phase 11. CSS, dismiss logic, and storage key (`streamGenie_first_run_seen`) are all in place.
- `https://frothydv.github.io/streamGenie/privacy` — Privacy policy page already exists at this URL.
- README already mentions "nothing is sent to a server during normal use" and links to the privacy policy.

</domain>

<decisions>
## Implementation Decisions

### PRIV-01: First-run banner enhancement

- **D-01:** Keep the existing banner text unchanged: *"Stream Genie shows tooltips when you hover over recognized game elements on Twitch streams. Pixel matching runs locally — nothing leaves your device."*
- **D-02:** Add a small "Privacy →" link after the existing text that opens `https://frothydv.github.io/streamGenie/privacy` in a new tab. The link should be visually subdued (matching existing `#c9b3ff` / `#9146ff` palette) — not alarming, not hidden.
- **D-03:** The link opens via `chrome.tabs.create({ url: '...' })` from popup.js (the standard pattern for opening external links from an extension popup). Use `target="_blank"` on an `<a>` tag is also acceptable; use whichever is cleaner given existing popup patterns.

### PRIV-02: Permissions table in README

- **D-04:** Add a "## Permissions" section to README immediately after the "## How it works" section. Format: two-column table (Permission | Why it's needed). Each manifest entry (both `permissions` and `host_permissions`) gets its own row with a plain-English explanation. The table should feel factual and calm — not defensive.

Permissions to document:
| Permission | Why it's needed |
|---|---|
| `activeTab` | Detect which game you're watching |
| `storage` | Save profile selections and first-run state |
| `https://*.twitch.tv/*` | Run the hover overlay on Twitch pages |
| `https://raw.githubusercontent.com/*` | Download community annotation profiles |
| `https://cdn.jsdelivr.net/*` | Fetch the game catalog |
| `https://*.workers.dev/*` | Submit new trigger contributions |

- **D-05:** Create `STORE-LISTING.md` at repo root with: (a) a Chrome Web Store short description (≤132 chars), (b) a full description (≤16,000 chars), and (c) a "Permissions justification" section matching the README table. The file is the source of truth for CWS submission copy.

### Claude's Discretion

- Exact wording of each permission's "Why it's needed" explanation (keep concise, ≤10 words per row)
- The visual styling of the "Privacy →" link (subdued, matching existing palette — don't make it look like an alert)
- Structure/sections of `STORE-LISTING.md` (CWS fields, formatting headers, etc.)
- Whether the "Privacy →" link is an `<a>` tag in popup.html or uses `chrome.tabs.create` in popup.js — use whichever fits existing popup link patterns

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Extension entry points
- `extension/popup.html` — First-run banner HTML (lines 147–150); CSS starts line 123
- `extension/popup.js` — First-run banner JS (lines 826–835); `FIRST_RUN_KEY` constant, dismiss handler
- `extension/manifest.json` — Source of truth for all permissions (must be read to write accurate table)

### Project documentation
- `README.md` — Current state before additions; "How it works" section is the insertion point for permissions table
- `CLAUDE.md` (project root) — Working style and permission context
- `.planning/REQUIREMENTS.md` — PRIV-01 and PRIV-02 definitions

### External reference
- `https://frothydv.github.io/streamGenie/privacy` — The privacy policy URL that the "Privacy →" link must open

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- First-run banner (`popup.html:147-150`, `popup.js:826-835`): Fully implemented from Phase 11. Only the HTML content and a link need to be added — no logic changes.
- Extension link-opening pattern: check `popup.js` for any existing `chrome.tabs.create` usage to match the established approach.

### Established Patterns
- Dark Twitch palette: `#9146ff` (purple), `#c9b3ff` (light purple text), `#adadb8` (muted), `#efeff1` (primary text). Privacy link should use this palette.
- `.dismiss-btn` already uses `#9146ff` border/color — the Privacy link can reuse this style or be a plain `<a>` with matching color.

### Integration Points
- `popup.html` banner div: add the link inside the existing `<div style="flex:1;">` text container.
- README: insert "## Permissions" section after the existing "## How it works" section.
- New file: `STORE-LISTING.md` at repo root — no integration needed, standalone document.

</code_context>

<specifics>
## Specific Ideas

- Banner look: "clear but not annoying or scary" — the Privacy link should feel like fine print that's easy to find, not a warning label.
- The existing banner text tone is calm and explanatory — the Privacy link should match that register.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 13-privacy-permissions-disclosure*
*Context gathered: 2026-05-16*
