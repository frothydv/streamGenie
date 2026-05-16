# Architecture — Stream Genie

## System Overview

Stream Genie is a Chrome Extension (Manifest V3) that provides hover-to-reveal annotations over Twitch stream video. It runs entirely client-side — pixel matching happens in the browser. A Cloudflare Worker backend handles submission moderation and GitHub integration for community-contributed profiles.

```
┌─────────────────────────────────────────────────────────────────┐
│                       Chrome Extension                          │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │  popup.html   │◄──►│  background.js   │◄──►│  content.js  │  │
│  │  (popup UI)   │ IPC│  (service worker)│ IPC│  (main logic)│  │
│  └──────────────┘    └──────────────────┘    └──────┬───────┘  │
│                                                      │          │
│                                           ┌──────────┴────────┐│
│                                           │  matcher-core.js  ││
│                                           │  (dHash matching) ││
│                                           └───────────────────┘│
└──────────┬──────────────────────────────────────────────────────┘
           │ fetch (profile JSON, reference images)
           ▼
┌──────────────────────┐       ┌──────────────────────────────┐
│  raw.githubusercontent │◄──────│  frothydv/streamGenieProfiles│
│  .com (GitHub Raw)    │       │  (GitHub — profile storage)  │
└──────────────────────┘       └──────────┬───────────────────┘
                                          │ Content API (via Worker)
                                          ▼
                              ┌───────────────────────────┐
                              │  Cloudflare Worker        │
                              │  streamgenie-submit       │
                              │  (submit-trigger/index.js)│
                              │                           │
                              │  KV: CONTRIBUTOR_KEYS     │
                              │  KV: PROFILE_STATS        │
                              └───────────────────────────┘
```

## Architecture Pattern

**Single content script** pattern — all logic lives in `content.js` (~3726 lines). No component framework, no module bundler. The content script manages:

1. Video discovery and lifecycle (heartbeat polling)
2. Mouse tracking and pixel capture
3. Perceptual hash matching (delegates to `matcher-core.js`)
4. Popup UI rendering (match overlay toasts)
5. Trigger editor modal (capture → edit → submit flow)
6. Debug panel
7. Extension interference handling (Twitch extension overlay detection)
8. Profile loading and caching
9. Curator panel (trigger management UI)

## Core Data Flow (Hover → Popup)

```
Mouse move (document level)
    │
    ▼
clamp to video bounds, throttle to 10Hz
    │
    ▼
clientToVideoCoords() — translate screen px → video-native px
    │
    ▼
captureRegion() — drawImage(video) to 160×160 canvas, getImageData()
    │
    ▼
fillGrayBuffer() — RGB→luma conversion
    │
    ▼
findBestMatch(TRIGGERS, capturePixels, captureGray)
    │
    ├── Phase 1: dHash sliding-window for ALL triggers (no rotation)
    │   ├── Coarse sweep (step=4) → prune candidates by threshold
    │   ├── Fine sweep around coarse winners (step=1)
    │   └── NCC verification at best position
    │
    ├── If any Phase 1 match → return first match
    │
    └── Phase 2 (only if Phase 1 produced no match):
        └── For rotating triggers within dist window:
            └── Center-constrained scan with rotated hashes
    │
    ▼
Render popup near cursor with matched trigger's payload
    │
    ▼
Auto-dismiss when cursor moves away from match region
```

## Key Architecture Decisions

### 1. Document-level Mouse Events
Twitch's player uses transparent overlay divs that swallow pointer events on `<video>`. Solution: listen for `mousemove` at `document` level with `capture: true`, then check `clientToVideoCoords()` to determine if the cursor is actually over the video.

### 2. Single-Pixel-Array Matching
Instead of hundreds of `getImageData()` calls for each sliding-window position, the code captures a single 160×160 region into a pixel buffer, converts once to grayscale, then does all distance calculations in pure JS arrays. This eliminated a major performance bottleneck.

### 3. Two-Phase Matching Pipeline
- **Phase 1 (fast):** Base dHash for all triggers. If any trigger passes threshold + NCC verification + color verify, return immediately.
- **Phase 2 (expensive, conditional):** Only runs when Phase 1 finds no match. Evaluates rotated hashes for triggers flagged with `rotation` schema. Uses adaptive candidate selection — only evaluates triggers whose Phase 1 dist falls within a window of the best miss.

### 4. Three-Pass Score Verification
1. **dHash distance** — bit-by-bit Hamming distance on perceptual hash
2. **NCC (Normalized Cross-Correlation)** — immune to H.264 brightness/contrast shifts; can rescue dHash near-misses
3. **Color verify** — RGB sample grid check; only used for fully unmasked references

### 5. Heartbeat Architecture
A 500ms `setInterval` monitors:
- SPA navigation (URL changes → reset state)
- Video element presence/change
- Game detection (re-scrapes DOM)
- Twitch extension interference detection
- Video dimension changes (triggers hash recomputation)

### 6. Profile Caching
- `localStorage` with 2-minute TTL for profile JSON
- Cache-busting with `_cb` timestamp + `cache: "no-store"`
- Fallback to stale cache on network failure
- Stale-cache retention for pending user triggers not yet in CDN

## Entry Points

| File | Role |
|------|------|
| `extension/content.js` | Main content script — injected on `*.twitch.tv/*`. All matching, UI, capture logic. |
| `extension/background.js` | Service worker — hotkey forwarding (Alt+Shift+C → content script message) |
| `extension/popup.html` + `popup.js` | Toolbar popup — profile selection, trigger listing, contributor status, first-run banner |
| `extension/matcher-core.js` | Shared matching library — dHash, NCC, rotation, SAT. UMD wrapper for Node.js testing |
| `workers/submit-trigger/index.js` | Cloudflare Worker — GitHub PR management, profile creation, proposal review |
| `scripts/build-alpha.js` | Build script — `.zip` packaging |

