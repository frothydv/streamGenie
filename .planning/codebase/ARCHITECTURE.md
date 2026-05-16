# Architecture

**Analysis Date:** 2026-05-10

## System Overview

Stream Genie is a viewer-side Chrome extension. No streamer install required. All matching happens locally in the browser against pixels captured from the live video element.

```
┌─────────────────────────────────────────────────────────────┐
│ Chrome Browser                                               │
│                                                             │
│  ┌─────────────┐   chrome.runtime    ┌──────────────────┐  │
│  │ background  │ ◄─────────────────► │    popup.js      │  │
│  │    .js      │   (sendMessage)      │  (toolbar popup) │  │
│  │ (service    │                      └────────┬─────────┘  │
│  │  worker)    │                               │ fetch       │
│  └──────┬──────┘                               ▼            │
│         │ chrome.tabs                  raw.githubusercontent │
│         │ .sendMessage                  (catalog.json)       │
│         ▼                                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ content.js  (Twitch page, isolated world)           │    │
│  │                                                     │    │
│  │  mousemove → captureRegion → MatcherCore.find  →   │    │
│  │              (canvas/video)   BestMatch         →   │    │
│  │                               (dHash+NCC)       →   │    │
│  │                                              popup  │    │
│  │                                              render │    │
│  │  Alt+Shift+C → capture mode → editor UI            │    │
│  │                                    │ POST           │    │
│  └────────────────────────────────────┼────────────────┘    │
│                                       │                      │
│  ┌────────────────────────────────────┼────────────────┐    │
│  │ matcher-core.js (loaded first)     │                │    │
│  │  dHash, NCC, sliding window,       │                │    │
│  │  rotation, SAT                     │                │    │
│  └────────────────────────────────────┼────────────────┘    │
└───────────────────────────────────────┼─────────────────────┘
                                        │ HTTPS POST
                                        ▼
                          ┌─────────────────────────────┐
                          │  Cloudflare Worker           │
                          │  streamgenie-submit          │
                          │  .vbjosh.workers.dev         │
                          │                             │
                          │  KV: CONTRIBUTOR_KEYS        │
                          │  KV: PROFILE_STATS           │
                          └──────────────┬──────────────┘
                                         │ GitHub API
                                         ▼
                          ┌─────────────────────────────┐
                          │  frothydv/streamGenie        │
                          │  Profiles (GitHub repo)      │
                          │                             │
                          │  catalog.json               │
                          │  games/{id}/profiles/       │
                          │    {id}/profile.json        │
                          │    {id}/references/*.png    │
                          └─────────────────────────────┘
```

## Message Passing

### background.js ↔ content.js
```
background → content:  { type: "capture-trigger" }   (Alt+Shift+C hotkey)
content → background:  none (content initiates via popup or direct)
```

### popup.js ↔ content.js
```
popup → content:  { type: "get-game" }               → returns { game, slug }
popup → content:  { type: "review-proposal", ... }   → triggers proposal review UI
content → popup:  responses via sendResponse callback
```

All message passing uses `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.

## Data Flow: Matching Pipeline

```
1. mousemove event (document level, throttled 500ms)
2. clientToVideoCoords() — map cursor to video pixel space
3. captureRegion(x, y, 160, 160) — drawImage to canvas, getImageData
4. MatcherCore.findBestMatch(imageData, triggers)
   a. For each trigger reference:
      - Build 32×32 canonical dHash of reference (once, cached)
      - Sliding window over capture (stride 4 coarse, stride 1 fine)
      - dHash distance at each position
      - If distance < threshold → candidate
   b. For rotates:true triggers: also try rotation angles
   c. Build summed-area table (SAT) once per hover event
   d. NCC verification at top candidate positions
5. Best match (lowest distance + NCC ≥ 0.65) → fire
6. Render popup near cursor with trigger payload text
7. Auto-dismiss when cursor leaves match region
```

## Data Flow: Profile Loading

```
1. popup.js fetches catalog.json from raw.githubusercontent.com
   (chrome.storage.local cache, 2-min TTL, stale-fallback on failure)
2. User selects profile in popup (no auto-selection yet)
3. popup → content: activate profile
4. content.js fetches profile.json
5. content.js fetches each reference PNG, decodes to ImageData
6. Triggers stored in memory; matching begins on next hover
```

## Data Flow: Contribution

```
1. Alt+Shift+C → capture mode (freeze frame, drag box, crop PNG)
2. Editor UI opens: payload text, popup offset, mask paint, rotation schema
3. Heat-map test: runs findBestMatch against a test frame to validate coverage
4. Submit: POST to Cloudflare Worker
   - Trusted (contributor key): direct commit to main branch
   - Untrusted: opens GitHub PR
5. Maintainer reviews PR in popup proposal UI (list/accept/reject ops)
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Viewer-side | Browser extension | Zero streamer install barrier; works on VODs |
| Hover-scoped | Only scan under cursor | Orders-of-magnitude CPU reduction; turns detection into classification |
| Pixel-based | Read video pixels, not game state | Game-agnostic; works on re-encoded Twitch video |
| dHash + NCC | Two-stage matching | dHash is fast and scale-invariant; NCC handles H.264 level shifts |
| GitHub storage | Profiles repo on GitHub | Free CDN, versioning, PR-based moderation |
| No bundler | Plain JS files | Simplest possible extension dev loop (reload = done) |
| Cloudflare Worker | Contribution backend | Zero infrastructure cost; handles both trusted/PR paths |
