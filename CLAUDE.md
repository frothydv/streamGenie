# Stream Overlay — Project Primer

You are picking up a project in progress. This document captures the concept, architectural decisions made so far, the current state of the codebase, and the planned next steps. The user has been collaborating with a previous Claude instance in a web chat; they have now transitioned to Claude Code for faster iteration.

## The concept

A browser extension that adds **hover-to-reveal annotations** over Twitch streams (and eventually YouTube). When a viewer hovers over something on screen — a card in a card game, a relic, a UI icon — a popup appears showing text and/or images explaining it.

The key insight: we read **pixels** from the video stream, not game state. This is intentionally game-agnostic. Any game works once a profile exists for it. Community members contribute the profiles.

Inspired by the long-running Hearthstone Deck Tracker and Slay the Spire overlays, but generalized to work with any game without per-game engineering.

## Architectural decisions (already made, do not re-litigate)

### Viewer-side, not streamer-side

Originally considered a streamer-side desktop app that would scan the framebuffer and broadcast metadata. Rejected in favor of a browser extension that runs viewer-side because:
- Zero streamer install barrier
- Works on VODs/clips as a bonus
- Hover-scoping (next section) makes the pixel-quality gap on re-encoded Twitch video acceptable

### Hover-scoped matching, not continuous scanning

We only scan the region under the cursor on hover, not the whole frame continuously. This:
- Cuts CPU cost by orders of magnitude (hover is a human-scale event)
- Turns "detection" into "classification" — dramatically easier problem
- Lets a perceptual-hash-nearest-neighbor approach work where template matching would struggle

### Monorepo of profiles, hosted on GitHub + served via jsDelivr

One central repo with multiple profiles per game (official, community-x, etc.). GitHub for storage/versioning/moderation-via-PR; jsDelivr's free CDN for fast serving. Zero infrastructure cost.

### Permission tiers (as convention, not code, until needed)

Four conceptual tiers: god mode (maintainer), profile owners (streamers/community leads), trusted contributors (scoped write access), and public (via PR). Implemented via GitHub CODEOWNERS rather than a custom permission system. Do not build a roles UI until multiple community profiles actually exist and force the issue.

### Streamer-declared profile bundles

Creators (Twitch streamers, YouTubers) declare which profiles their viewers get via a config file in the repo (e.g., `creators/twitch/calpey.json`). Viewers can override, but additively only (add-to, not replace). This keeps streamer curation meaningful.

### Cross-platform by design, but Chrome-only for v1

Manifest V3 Chrome extension. YouTube support planned for milestone 5 (same code path, different platform module). Firefox later if project has legs.

## Current state

The extension is at **v0.2.3**, end of milestone 2 with a capture-mode extension. Milestones completed:

- **M1 (v0.1.0):** Hello-world extension. Manifest, service worker, content script, toolbar popup. Loads on Twitch, logs to console. Hotkey registered (does nothing yet).
- **M2 (v0.2.0–0.2.2):** Hover detection + pixel capture. Content script finds the video element, tracks cursor at document level (bypasses Twitch's overlay divs that swallow events), captures 160×160 region under cursor via `drawImage(video, ...)` to a canvas. Debug panel in top-right shows live capture preview + coordinates.
- **M2.3 (v0.2.3, current):** In-extension capture mode. Alt+Shift+C freezes the current frame as an overlay, user drags a box, releases → PNG downloads. Groundwork for the milestone 7 contribution flow, also used immediately to generate reference images for milestone 3.

## File layout

```
extension/
  manifest.json         # Manifest V3, Chrome
  background.js         # Service worker; handles hotkey, forwards to content
  content.js            # Main content script (~570 lines). All the action.
  popup.html + .js      # Toolbar popup, shows tab status
  icons/                # Placeholder purple-square PNGs
README.md               # User-facing test instructions
CLAUDE.md               # This file
```

All of `content.js` is wrapped in an IIFE with `window.__streamOverlayLoaded` guard against double-injection on extension reload. It contains:

1. Config constants (capture size, intervals)
2. Video discovery (`findBestVideo`, `attachToVideo`, heartbeat)
3. Pixel capture (`clientToVideoCoords`, `captureRegion`)
4. Document-level mouse handler
5. Debug panel UI
6. Capture mode (the Alt+Shift+C freeze-and-crop flow)
7. Toast notifications
8. Message handler for the hotkey

## Gotchas already discovered and handled

- **Chrome reserves Ctrl+Shift+C** for DevTools inspector. Use Alt+Shift+C.
- **Twitch homepages have hidden `<video>` preloaders** that trip up naive `querySelector('video')`. We now pick the largest visible video with non-zero dimensions.
- **Twitch's player has transparent overlay divs** that swallow pointer events on the `<video>` element. We listen at document level and check bounds instead of listening on the video directly.
- **Video element can appear late after SPA navigation.** We use a 500ms heartbeat that re-evaluates video attachment, not just a URL-change listener.
- **Resolution varies** — Twitch viewers pick their quality (1080p, 720p, etc.). Perceptual hashing at small sizes (16×16 or 32×32 dHash) is naturally resolution-robust. Build matching with this in mind.

## Testing workflow

1. User makes code changes (you, as Claude Code, edit files directly).
2. User goes to `chrome://extensions/`, clicks the reload icon on the "Stream Overlay (dev)" card.
3. User reloads or revisits a Twitch page.
4. User opens DevTools (F12), filters console by `[overlay` to see our logs.
5. User reports back what they see; iterate.

The user is not a streamer and is not deeply technical. Keep instructions concrete and minimal. They're happy to click reload, check a console, and paste errors. They're not going to want to set up a dev environment or debug JavaScript themselves.

## Next milestone — M3: dummy matching

The user just captured a reference image using the M2.3 capture feature. The image is the "map button" (a scroll-with-X icon) from Slay the Spire 2 on streamer Calpey's channel. They may also capture additional references (cards, relics, other UI) for additional test coverage.

**M3 scope:**
- Add a hardcoded trigger list — for now just one or two reference images bundled in the extension, with text payloads.
- Implement perceptual hash matching. dHash at 16×16 is the starting point; robust to compression and resolution scaling.
- For small references (smaller than 160×160 capture), use sliding-window search: slide the reference across the capture region, take the best-matching position. This handles imprecise hovering.
- On match above threshold, render a popup near the cursor with the payload text. Popup should be styled consistently (dark Twitch-ish theme). Should auto-dismiss when cursor moves away from match region.
- Debug panel should show current best-match distance and which trigger matched (or "no match"). We want to see the numbers during testing.

**What to ask the user for before starting M3:**
- The reference image files from their M2.3 capture session
- The payload text for each (what the popup should say)
- Any preference on popup position (below cursor / above / follow cursor / etc.)

**What NOT to do in M3:**
- Do not load profiles from the cloud yet — that's M4.
- Do not implement game detection — that's M5.
- Do not build real contribution flow — M2.3 is a stub, M7 is the real thing.

## Working style notes

The previous Claude was fairly opinionated about pushing back on over-engineering and scope creep. The user appreciates this. When the user floats an idea, evaluate it seriously and say "yes, and here's why" or "no, and here's why, and here's what I think instead." Do not default to agreement.

The user is fine with being told they need to do something that requires human hands (install, test, screenshot). They don't want to be asked unnecessary questions when a reasonable default exists. They also appreciate honest acknowledgment of uncertainty and risk.

When a change is small, make it. When a change is large or architectural, surface it for discussion first.

Commits should be semantic and descriptive. The user wants git history to be useful.

## Known limitations (as of M3)

### Low-resolution matching
dHash at 9×8 bits on a small reference (< ~40px) loses discriminative power — many different game UI elements hash similarly. Current behavior: refs that scale below `SMALL_REF_THRESHOLD` (40px) at the current stream resolution get their hash silently disabled and produce no matches. In practice:
- **1080p native:** all refs match well.
- **720p:** larger refs (map icon ~51px) match; smaller refs (coin ~35px) are near the threshold and may miss.
- **480p and below:** most small refs are disabled entirely.

This is acceptable for M3/M4/M5 since profiles will be anchored to streamers who broadcast at source resolution. Address in a dedicated milestone if sub-720p support becomes a real need.

**Candidate approaches when we get there:**
- Canonical-size hashing: resize both reference and each capture window to a fixed size (e.g. 32×32) before hashing, so comparison quality is resolution-independent.
- pHash (DCT-based): captures low-frequency structure, more robust to compression artifacts and small scaling differences.
- Color histogram confirmation: as a cheap second-pass on dHash candidates.

## Planned milestones

- **M4:** Profile loading from GitHub via jsDelivr. Profile schema. Caching.
- **M5:** Game detection via Twitch category (and YouTube channel-based equivalent). Streamer/creator config lookup.
- **M6:** First real profile. Seeded with Slay the Spire 2 content since Calpey streams it.
- **M7:** Real contribution flow — refine M2.3 with payload entry, offset specification, preview-before-submit, and upload via a Cloudflare Worker that opens PRs.
- **Later:** YouTube support, Firefox support, profile management UI for owners, NSFW scanning, sub-720p matching improvements, etc.
