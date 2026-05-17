# Roadmap: YouTube Support + AI Profile Population

**5 phases** | **24+ requirements** | All v1 requirements covered ✓

- ✅ **v0.9 Core** — Phases 1–9 (shipped, all matching/contribution/rotation features complete)
- ✅ **v1.0 Beta (partial)** — Phases 10–11 (shipped — curation UX and viewer onboarding complete)
- ✅ **v1.0 Beta (remaining)** — Phases 12–13 (complete — error states and privacy disclosure)
- ✅ **M10 YouTube Support** — Phases 1–4 (shipped — complete YouTube platform support)
- 🔬 **Exp: AI Profile Population** — Phase 5 (experimental — AI-driven profile generation from VODs)

| # | Phase | Goal | Requirements | Criteria |
|---|-------|------|-------------|----------|
| 1 | Platform Setup | Extension loads on YouTube pages | MAN-01, MAN-02, MAN-03, BG-01, TEST-03 | 3 success criteria |
| 2 | YouTube-Aware Content Script | Pipeline works on YouTube without errors | CONT-01, CONT-02, CONT-03, CONT-04, CONT-05, CONT-06 | 4 success criteria |
| 3 | Game Detection | Auto-detect game from YouTube video title | CONT-07, GAME-01, GAME-02, GAME-03, GAME-04 | 3 success criteria |
| 4 | Popup & Testing | Popup shows YouTube status and fallback flow | POP-01, POP-02, POP-03, POP-04, POP-05, TEST-01, TEST-02, TEST-04 | 3 success criteria |
| 5 | AI Profile Population | AI generates profile triggers from a YouTube VOD | AI-01, AI-02, AI-03, AI-04, AI-05, AI-06, AI-07, AI-08, AI-09, AI-10 | 5 success criteria |

---

## Phase 1: Platform Setup

**Goal:** The extension loads and initializes on YouTube pages. Twitch is unaffected.

**Requirements:** MAN-01, MAN-02, MAN-03, BG-01, TEST-03

**Success criteria:**
1. Content script is injected on `www.youtube.com/watch?v=*` pages (verify via DevTools console)
2. Alt+Shift+C hotkey fires `capture-trigger` message to YouTube tab's content script
3. Twitch pages still load and work normally (extension on both platforms doesn't interfere with itself)

---

## Phase 2: YouTube-Aware Content Script

**Goal:** The content script runs without errors on YouTube, discovers the video, handles coordinate math correctly, and skips Twitch-specific logic.

**Requirements:** CONT-01, CONT-02, CONT-03, CONT-04, CONT-05, CONT-06

**Success criteria:**
1. Content script initializes on YouTube with log `loaded on https://www.youtube.com/watch?v=...` and no errors
2. `findBestVideo()` discovers the YouTube `<video>` element; heartbeat detects video replacement on SPA navigation
3. Hovering over the video triggers pixel capture without coordinate math errors
4. Twitch extension interference code never runs on YouTube pages (no errors about missing `ext-twitch.tv` elements)

---

## Phase 3: Game Detection

**Goal:** The extension detects the game from the YouTube video title and matches it against the catalog.

**Requirements:** CONT-07, GAME-01, GAME-02, GAME-03, GAME-04

**UI hint:** no

**Success criteria:**
1. Content script extracts video title from YouTube DOM on request
2. Title is fuzzy-matched against catalog game names; match above threshold returns the game
3. `twitchSlug` → `legacyTwitchSlug` rename works with backward compatibility

---

## Phase 4: Popup & Testing

**Goal:** The popup shows YouTube status, game detection result (or manual selection), and everything works end-to-end.

**Requirement:** POP-01, POP-02, POP-03, POP-04, POP-05, TEST-01, TEST-02, TEST-04

**Success criteria:**
1. Popup shows "Active on YouTube: /watch?v=XXXX" when on a YouTube video page
2. If game is detected, popup shows "Detected: [Game Name]" with manual override option
3. Capable of triggering the full test flow on a YouTube VOD (extension loads, hover triggers popup, capture mode works)

---

## Phase 5: AI Profile Population

**Goal:** A local CLI skill and supporting Node scripts let a user point the AI at a YouTube VOD, and it automatically generates a full profile branch in streamGenieProfiles — complete with reference crops, payloads, and a PR ready for review.

**Requirements:** AI-01, AI-02, AI-03, AI-04, AI-05, AI-06, AI-07, AI-08, AI-09, AI-10

**Plans:** 5 plans

Plans:
- [ ] 05-01-PLAN.md — Frame extraction (extract.js) + NCC validation (validate.js) + test scaffolds
- [ ] 05-02-PLAN.md — Wiki grounding (wiki.js), vision pass (vision.js), crop utility (crop.js)
- [ ] 05-03-PLAN.md — GitHub branch/PR/file ops (github.js) + deduplication (dedup.js)
- [ ] 05-04-PLAN.md — Popup dev override UI (popup.html/js + content.js load-dev-profile handler)
- [ ] 05-05-PLAN.md — CLI orchestrator (index.js) + summary report (report.js) + README

**Success criteria:**
1. Running the skill against a YouTube VOD + game ID produces reference PNG crops and payload JSON via yt-dlp + ffmpeg (1080p, scene-change sampling)
2. Vision model pre-identifies game items using wiki-sourced item list; NCC self-validation gates each crop (soft gate with one retry, confidence tiers ✓/~/⚠)
3. Profile branch is committed to streamGenieProfiles and a PR is opened automatically
4. Popup dev override URL field lets the user load the branch profile for live testing without merging
5. Running against a second video additively merges triggers (name match + hash proximity dedup; duplicate references added as variants)

**Requirements detail:**
- AI-01: Frame extraction — yt-dlp + ffmpeg, 1080p, scene-change detection with configurable floor interval
- AI-02: Wiki grounding — opportunistic wiki lookup, item list injected as pre-identification prompt
- AI-03: Vision pass — model identifies items in frame, returns bbox per item
- AI-04: Crop validation — bbox + padding → NCC self-validation (≥0.65 pass), one retry on fail, soft gate with confidence tiers
- AI-05: node-canvas + matcher-core.js validator runs in Node.js for automated pre-PR testing
- AI-06: Profile branch builder — writes reference PNGs + profile.json to a named branch in streamGenieProfiles
- AI-07: PR creation — opens PR via GitHub API; merge path uses existing accept-proposal Worker op
- AI-08: Popup dev override — URL input in popup.html/js that loads a branch profile URL instead of catalog for testing
- AI-09: Multi-video additive — name match + hash proximity dedup; duplicates become additional references on existing trigger
- AI-10: Summary report — wiki item count, % mapped per pass, retry counts, confidence tiers, detectable timestamps, dev URL, PR link

---

## STATE.md

**Last updated:** 2026-05-17
**Milestone:** YouTube Support v1.0
**Status:** Complete — all 4 phases shipped
**Completed phases:** 4 ✓
**Completed requirements:** MAN-01, MAN-02, MAN-03, BG-01, TEST-03, CONT-01-06, CONT-07, GAME-01-04, POP-01-05

### Phase 1: Platform Setup (✓)
**Status:** Complete — committed bddad28
**Deliverables:** manifest.json permissions, background.js hotkey, e2e fixture page, Playwright tests
**Blockers:** Playwright tests can't run in this WSL environment (missing libnspr4.so)

### Phase 2: YouTube-Aware Content Script (✓)
**Status:** Complete — all 5 tasks done, manually verified on YouTube
**Deliverables:** PLATFORM constant, guarded heartbeat, e2e test spec
**Blockers:** e2e tests can't run in WSL (libnspr4.so); manual Chrome test passed

### Phase 3: Game Detection (✓)
**Status:** Complete — user-confirmed manual YouTube game detection
**Deliverables:** `detectYouTubeGame()`, `fuzzyMatchTitle()`, `legacyTwitchSlug` rename
**Decisions:** Client-side fuzzy matching (threshold 0.4), backward-compat with twitchSlug

### Phase 4: Popup & Testing (✓)
**Status:** Complete — all code changes implemented
**Deliverables:** Non-video message, detected badge with [change] link, no-detection toast, placeholder dropdown
**Blockers:** Manual testing in Chrome pending (can't run in WSL)

## Session Continuity

Last session: 2026-05-17
Stopped at: Phase 4 complete — all implementation done
Resume action: Manual testing in Chrome
