# Roadmap: Stream Genie

## Overview

Stream Genie is a browser extension at v0.9.2, all core milestones shipped (M1–M9). What remains is the polish needed before a public beta: profile curation tools for contributors, viewer onboarding for new users, error state visibility, and privacy disclosure. These four phases take the extension from "technically complete" to "shippable to the public."

## Milestones

- ✅ **v0.9 Core** — Phases 1–9 (shipped, all matching/contribution/rotation features complete)
- ✅ **v1.0 Beta (partial)** — Phases 10–11 (shipped — curation UX and viewer onboarding complete)
- 🚧 **v1.0 Beta (remaining)** — Phases 12–13 (in progress — error states and privacy disclosure)

## Phases

<details>
<summary>✅ v0.9 Core (M1–M9) — SHIPPED</summary>

Milestones 1–9 are complete: hello-world, hover detection, capture mode, perceptual hash matching, profile loading, game detection, STS2 profile, contribution flow, rotation schema, and NCC verification.

</details>

### 🚧 v1.0 Beta (In Progress)

**Milestone Goal:** Everything a stranger needs to install, use, and contribute to Stream Genie without hand-holding.

#### ✅ Phase 10: Profile Curation UX — SHIPPED
**Goal**: Give contributors the tools to manage an existing profile — delete triggers, overwrite triggers with new captures, review all triggers in a grid, and surface near-duplicates before they pollute the profile.
**Requirements**: CUR-01 ✅, CUR-02 ✅, CUR-03 ✅, CUR-04 ✅

#### ✅ Phase 11: Viewer Onboarding — SHIPPED
**Goal**: A new viewer who installs the extension and visits a stream with no matching profile sees a clear, friendly explanation of what the extension does and why nothing is happening — not a silent blank experience.
**Requirements**: ONB-01 ✅, ONB-02 ✅

#### Phase 12: Error States
**Goal**: CDN down, malformed profile JSON, and schema mismatch errors are surfaced to the user in the debug panel (and optionally the popup) rather than failing silently.
**Depends on**: Nothing
**Requirements**: ERR-01, ERR-02, ERR-03
**Success Criteria** (what must be TRUE):
  1. Debug panel shows a red indicator when the profile CDN is unreachable
  2. Debug panel shows a warning when profile JSON fails to parse or fails schema validation
  3. Popup reflects load-error state (not just "no profile selected")
**Plans**: TBD

Plans:
- [ ] 12-01: CDN/fetch error surfacing in debug panel and popup
- [ ] 12-02: JSON parse + schema mismatch error surfacing

#### Phase 13: Privacy & Permissions Disclosure
**Goal**: The extension's store listing and first-run experience clearly state that pixels are read locally and nothing leaves the device, satisfying Chrome Web Store review requirements and user trust expectations.
**Depends on**: Phase 11 (first-run banner is the delivery vehicle for disclosure)
**Requirements**: PRIV-01, PRIV-02
**Success Criteria** (what must be TRUE):
  1. First-run banner includes a privacy statement: pixels processed locally, no data leaves device
  2. README / store-listing text documents all permissions used and why
**Notes**: Privacy statement exists as a GitHub page (PRIV-02 partially addressed), but is not yet surfaced in the extension's first-run experience (PRIV-01 pending).
**Plans**: TBD

Plans:
- [ ] 13-01: Privacy statement in first-run banner and README

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 10. Profile Curation UX | v1.0 Beta | — | ✅ Shipped | 2026-05-13 |
| 11. Viewer Onboarding | v1.0 Beta | — | ✅ Shipped | 2026-05-13 |
| 12. Error States | v1.0 Beta | 0/2 | Not started | - |
| 13. Privacy & Disclosure | v1.0 Beta | 0/1 | Partial (GitHub page exists; not in extension) | - |
