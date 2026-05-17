# Phase 13: Privacy & Permissions Disclosure - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-16
**Phase:** 13-privacy-permissions-disclosure
**Areas discussed:** Banner text completeness, Permissions doc format, Store listing artifact

---

## Banner Text Completeness

| Option | Description | Selected |
|--------|-------------|----------|
| Keep it simple | Current text accurate enough — 'nothing leaves your device' covers pixel data; profile fetches are expected network behavior | |
| Add a nuance | Refine to 'pixel analysis is local — no video data or personal info leaves your device' to be precise without being scary | ✓ |

**Refinement direction:**

| Option | Description | Selected |
|--------|-------------|----------|
| Pixel data stays local | 'Pixel analysis runs in your browser — no video data or personal info leaves your device.' | |
| Full disclosure inline | List all network calls (GitHub, Cloudflare Worker) inline in the banner | |
| Link to privacy policy | Keep banner brief, add small 'Privacy →' link opening the existing privacy policy page | ✓ |

**Banner wording:**

| Option | Description | Selected |
|--------|-------------|----------|
| Keep existing + add link | Current text unchanged; add 'Privacy →' link after it | ✓ |
| Slightly revised + link | 'Pixel analysis runs in your browser — no video data or personal info leaves your device. Privacy →' | |

**User's choice:** Keep existing banner text as-is; add a small "Privacy →" link that opens `https://frothydv.github.io/streamGenie/privacy` in a new tab.
**Notes:** Design principle stated by user: "clear but not annoying or scary." The link should feel like accessible fine print, not a warning label.

---

## Permissions Doc Format

| Option | Description | Selected |
|--------|-------------|----------|
| Table | Two-column table: Permission \| Why it's needed. Scannable, authoritative. | ✓ |
| Bulleted prose | Friendlier tone, less clinical, less scannable | |

**Placement:**

| Option | Description | Selected |
|--------|-------------|----------|
| After 'How it works' | Logical flow: feature first, then permissions. Calms concerns. | ✓ |
| Near the end | Keeps top of README clean | |

**User's choice:** Table format, inserted after the "How it works" section in README.

---

## Store Listing Artifact

| Option | Description | Selected |
|--------|-------------|----------|
| STORE-LISTING.md in repo | Dedicated file with CWS short/long description + permissions justification | ✓ |
| README only | Adapt README for CWS at submission time | |

**Contents:**

| Option | Description | Selected |
|--------|-------------|----------|
| Both copy + permissions justification | Product description + permissions explanation section | ✓ |
| Product copy only | Just short and long description | |

**User's choice:** Create `STORE-LISTING.md` at repo root with CWS short description, full description, and a permissions justification section.

---

## Claude's Discretion

- Exact wording of each permission's explanation (keep concise, ≤10 words per row)
- Visual styling of the "Privacy →" link (subdued, matching existing palette)
- Structure and sections within STORE-LISTING.md
- Whether Privacy link is an `<a>` tag in HTML or `chrome.tabs.create` in JS

## Deferred Ideas

None — discussion stayed within phase scope.
