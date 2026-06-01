# Changelog

All notable changes to Stream Genie are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from v0.6.0 onward.

---

## [0.10.0] — 2026-06

### Added
- **YouTube support v1.0** — full platform setup, content script awareness, game detection from video titles, fixture pages, e2e tests. Merged into master.
- **Error states (Phase 12)** — CDN failure graceful handling, schema validation warnings in popup, stale-cache debug indicator, Playwright e2e suite
  - `profileLoadError` and `profileStaleWarning` flags surfaced in get-game response
  - Amber/red indicators in debug panel for CDN unreachable / stale cache
  - Schema validation: numeric trigger IDs skipped, null `triggers` field handled
- **Privacy & store prep (Phase 13)** — privacy link in first-run banner, README permissions table, STORE-LISTING.md finalized
- **Dev profile override** — load any profile URL from the popup without deploying

### Fixed
- Security: `SUBMIT_SECRET` extracted to gitignored `config.js` (no longer in public repo)
- Security: `innerHTML` → `textContent` for all profile-supplied payload fields
- Security: Worker rate limiting added
- Popup: config extraction fix, code review findings resolved
- Manifest: renamed from "Stream Overlay" to "Stream Genie"

### Infrastructure
- Playwright e2e test suite (6 tests: error states, CDN failure, schema validation)
- Fixture pages for Twitch and YouTube e2e tests

### Docs
- GitHub Pages site at `frothydv.github.io/streamGenie/` with product page and privacy policy
- `STORE-LISTING.md` with CWS submission copy and permissions justification
- README permissions table added

---

## [0.9.2] — 2026-05

### Added
- GitHub Pages landing site (`frothydv.github.io/streamGenie/`) with product page, privacy policy
- Real Stream Genie lamp icon (all sizes)
- Chrome Web Store listing draft (`STORE-LISTING.md`) with permissions justification

### Fixed
- `listProposals`: eliminate phantom duplicates caused by stale PR branches
- REMOVE proposal review: load reference image from `main` branch instead of the PR branch (which doesn't exist for delete proposals)
- REMOVE proposal review UX: show image thumbnail and clear action buttons

---

## [0.9.1] — 2026-05

### Added
- Viewer onboarding — first-run banner (dismissable), no-profile-detected toast with links
- Profile sort/stats — sort profiles by upvotes, trigger count, or times used
- `timesUsed` counter — activation pings increment per-profile usage count via KV
- Connectivity indicators — catalog-unavailable fallback notice
- Curator: delete button on each trigger card with confirmation flow
- Curator: duplicate detection (hash-distance < 8) with filter tab and badge
- Debug panel: closeable with × button, toggle from popup

### Fixed
- Popup anchor: derive coordinates from trigger position, not cursor position
- Coordinate transform: correct offset calculation when popup follows trigger
- `triggerCount`: derive from live profile fetch and update dropdown immediately

### Infrastructure
- `PROFILE_STATS` KV namespace configured on Cloudflare Worker

---

## [0.9.0] — 2026-04

### Added
- **NCC verification pass** — Normalized Cross-Correlation as a secondary matcher. After dHash locates the best candidate position, NCC verifies it using a summed-area table (SAT) for O(1) mean/variance. NCC is immune to H.264 brightness/contrast shifts that cause dHash near-misses on live streams.
  - SAT built once per hover event (~0.24ms), shared across all triggers
  - Score ≥ 0.65 fires independently of the dHash distance ratio
  - Debug panel surfaces `ncc=` score alongside dHash distance
- **Profile curator panel** (Phase 1) — full-screen grid view of all triggers in a profile
  - Offset drag handles — drag the popup offset dot on each card
  - Batch offset editing — multi-select triggers, set offset in one action
  - Duplicate detection — hash-distance comparison flags near-identical references
  - Pending changes workflow — staged edits submit via the Worker as `update` operations

### Fixed
- Sliding-window false miss: when true match falls between coarse grid lines
- Heat-map test stride and Phase 1 threshold values
- Rotation Phase 1 now always fires (not gated by range config)

### Tests
- Noise-resilience suite: 8 new tests for high-frequency images and noise tolerance
- Noise-tolerance sweep in `realcapture.js`

---

## [0.8.0] — 2026-04

### Added
- **Rotation schema** — triggers declare rotation behaviour via a structured schema
  - `mode: "orthogonal"` — matches 0°, 90°, 180°, 270°
  - `mode: "free"` — configurable range (min/max angle) and step
  - `fineStepNearZero` — adds ±1°–±4° steps around 0° for small tilts
  - `baseAngle` — static preview offset showing the reference's real tilt
- **Rotation authoring UI** in the trigger editor
  - Mode selector (orthogonal / free) with inline animated preview
  - Angle range/step inputs with `parseOrDef` zero-safe parsing
  - Heat-map validation test — visual grid showing which angles match and how accurately
  - Stride-4 heat map guarantees ≤2px offset, ≤2 bit mismatch at threshold 7
- Wider 480×480 capture region to accommodate rotation bounding boxes

### Fixed
- Inline rotation preview: no transform stomp between renders
- Base angle preview: 2s hold before returning to idle pose
- Heat-map: compute ref hash at native dimensions, not resampled to 32×32
- Zero-value form inputs: `parseFloat("0") || default` now handled via `parseOrDef`

---

## [0.7.1] — 2026-03

### Changed
- **Two-pass matching** — Phase 2 rotation candidates shortlisted via adaptive distance-window instead of fixed-K
- `rotationCandidateLimit` raised to 15 for headroom as profiles grow
- Phase 2 rotation cost capped at O(K) regardless of total trigger count

### Performance
- Adaptive shortlisting: only Phase 1 candidates within 1.5× the best distance enter Phase 2
- Measured improvement: 40–60% fewer rotation evaluations on a 30-trigger profile

---

## [0.7.0] — 2026-03

### Added
- **Rotation-aware dHash matching** — triggers can match at multiple angles (0°, 90°, 180°, 270° by default)
- Center-constrained step-1 scan for Phase 2 rotation candidates
- Mask clipped corner bits preserved in rotated hashes
- Match angle shown in debug panel
- **Proposal review UI** — trusted contributors can accept/reject PRs directly from the popup
  - Accept writes merged changes directly to `main`
  - Full editor view for reviewing proposals before accepting

### Fixed
- Nearest-neighbor interpolation in `rehashRef` for correct hash alignment
- Rotation threshold tuned to 7/64
- Route trigger submissions to the profile shown in popup, not stored active profile

### Tests
- Rotation diagnostic suite with 8 angle-generation tests
- Real-capture fixture (`defend-ironclad`) for end-to-end rotation matching

---

## [0.6.5] — 2026-03

### Added
- **Masked trigger editing** — polygon/paint mask editing in the trigger editor
- **Second-pass verifier** for masked refs (grid-based verification)
- **Twitch Extension disable toggle** — globally disables pointer events on Twitch overlays so Stream Genie works on streams with conflicting extensions
- **Trigger editing from popup** — edit existing triggers (payload, offset, mask, rotation)
- **Game detection** — reads Twitch category slug from `data-a-target="stream-game-link"`
- **Verified profile badge** — ✓ prefix on verified profiles in dropdown
- **Worker tests** — 35 end-to-end tests for `addTrigger`/`update`/`remove` with mock GitHub client
- **CDN synchronization fixes** — `ensureRawUrl()` rewrites jsDelivr URLs to `raw.githubusercontent.com` to bypass 24-hour CDN lag
- **Cache-busting** in popup on every open
- **GitHub Raw host permissions** — `raw.githubusercontent.com` added to manifest

### Fixed
- Game detection: `twitchSlug` matching between catalog (Slug format) and Twitch DOM (category slug)
- Trigger display: user-created triggers now show in popup list
- User-trigger delete: local storage key fixed
- Contributor status: now reflects the selected profile, not a stale cached one
- Catalog fetch: bypasses browser cache with `cache: "no-store"` and timestamp param

### Infrastructure
- `wrangler.toml` configured with KV bindings for contributor keys
- Cloudflare Worker supports `add`, `update`, `remove`, `create-profile`, `verify`, `list-proposals`, `accept-proposal`, `reject-proposal` operations

---

## [0.6.0] — 2026-02

### Added
- **M4: Profile loading from CDN** — fetches `catalog.json` then individual `profile.json` from jsDelivr
  - 2-minute localStorage cache with stale-fallback
  - Hardcoded fallback catalog if CDN is unreachable
- **M3: Scale-normalized dHash matching**
  - dHash at canonical 32×32 size (resize both ref and capture before hashing)
  - Sliding-window search for small references
  - Graceful degradation at sub-720p resolutions
  - Masked matching support (maskDataUrl with alpha-based masking)
- **M2.3: Capture mode** — Alt+Shift+C freezes frame as overlay, user drags box → captured crop launches trigger editor
- **M2: Hover detection + pixel capture**
  - Document-level mouse tracking bypasses Twitch overlay divs
  - Video discovery picks largest visible video (ignores hidden preloaders)
  - 500ms heartbeat re-evaluates video attachment on SPA navigation
  - 160×160 capture region under cursor
  - Debug panel with live capture preview
- **M1: Hello-world extension**
  - Manifest V3, Chrome content script
  - Service worker (background.js)
  - Toolbar popup (popup.html/js)
  - Alt+Shift+C hotkey registered

### Infrastructure
- Cloudflare Worker scaffolded at `workers/submit-trigger/`
- Profile repository: `frothydv/streamGenieProfiles`
- Catalog schema with game → profile → trigger hierarchy
- Build script: `npm run build:release` zips the extension with versioned filename

---

## [0.5.x and earlier] — Pre-tag

Development versions before semantic versioning was adopted. M1–M3 prototyping, initial pixel-capture experiments, and architecture exploration. See `git log` for the full history.

[0.10.0]: https://github.com/frothydv/streamGenie/releases/tag/v0.10.0
[0.9.2]: https://github.com/frothydv/streamGenie/releases/tag/v0.9.2
[0.9.1]: https://github.com/frothydv/streamGenie/releases/tag/v0.9.1
[0.9.0]: https://github.com/frothydv/streamGenie/releases/tag/v0.9.0
[0.8.0]: https://github.com/frothydv/streamGenie/releases/tag/v0.8.0
[0.7.1]: https://github.com/frothydv/streamGenie/releases/tag/v0.7.1
[0.7.0]: https://github.com/frothydv/streamGenie/releases/tag/v0.7.0
[0.6.5]: https://github.com/frothydv/streamGenie/releases/tag/v0.6.5
[0.6.0]: https://github.com/frothydv/streamGenie/releases/tag/v0.6.0
