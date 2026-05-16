# Roadmap: YouTube Support

**4 phases** | **24 requirements** | All v1 requirements covered ✓

| # | Phase | Goal | Requirements | Criteria |
|---|-------|------|-------------|----------|
| 1 | Platform Setup | Extension loads on YouTube pages | MAN-01, MAN-02, MAN-03, BG-01, TEST-03 | 3 success criteria |
| 2 | YouTube-Aware Content Script | Pipeline works on YouTube without errors | CONT-01, CONT-02, CONT-03, CONT-04, CONT-05, CONT-06 | 4 success criteria |
| 3 | Game Detection | Auto-detect game from YouTube video title | CONT-07, GAME-01, GAME-02, GAME-03, GAME-04 | 3 success criteria |
| 4 | Popup & Testing | Popup shows YouTube status and fallback flow | POP-01, POP-02, POP-03, POP-04, POP-05, TEST-01, TEST-02, TEST-04 | 3 success criteria |

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

## STATE.md

**Last updated:** 2026-05-16
**Current phase:** 0 (not started)
**Completed phases:** None
**Completed requirements:** None

### Phase 1: Platform Setup (○)
**Status:** Not started
**Blockers:** None

### Phase 2: YouTube-Aware Content Script (○)
**Status:** Not started
**Blockers:** Phase 1

### Phase 3: Game Detection (○)
**Status:** Not started
**Blockers:** Phase 2

### Phase 4: Popup & Testing (○)
**Status:** Not started
**Blockers:** Phase 3
