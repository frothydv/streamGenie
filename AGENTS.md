# Stream Overlay — Project Primer

You are picking up a project in progress. This document captures the concept, architectural decisions made so far, the current state of the codebase, and the planned next steps. The user has been collaborating with a previous Codex instance in a web chat; they have now transitioned to Codex for faster iteration.

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

The extension is at **v0.6.5**, having resolved synchronization and list UX issues. Milestones completed:

- **M1 (v0.1.0):** Hello-world extension. Manifest, service worker, content script.
- **M2 (v0.2.0):** Hover detection + pixel capture. Document-level mouse tracking to bypass Twitch overlay divs.
- **M3 (v0.3.0):** Scale-normalized dHash matching. Sliding-window search for small references.
- **M4 (v0.4.0):** Profile loading from GitHub via jsDelivr. Dynamic trigger management.
- **M5 (v0.5.0):** Game detection via Twitch category scraping. Profile selection UI.
- **M6 (v0.5.5):** First real profile (Slay the Spire 2). Masked matching support for non-rectangular icons.
- **M7 (v0.6.0):** Complete contribution flow. Integrated capture -> editor -> PR submission via Cloudflare Worker.
- **M8 (v0.6.5):** Robust synchronization. Auto-rewriting CDN URLs to GitHub Raw; ID-based deduplication; alphabetical sorting.

## File layout

```
extension/
  manifest.json         # Manifest V3, Chrome
  background.js         # Service worker; handles hotkey
  content.js            # Main content script. Logic, UI, matching.
  matcher-core.js       # Reusable dHash matching logic (Node + Browser)
  popup.html + .js      # Toolbar popup, profile management
  icons/                # App icons
workers/
  submit-trigger/       # Cloudflare Worker for GitHub PR creation
tests/
  integration/          # Data flow and worker integration tests
```

## Known limitations (as of v0.6.5)

### Propagation Delay
While the extension now uses GitHub Raw and cache-busting to minimize lag, updates merged to the repository can still take 1–5 minutes to become visible in the raw file feed. The popup's "refresh" button can be used to force an immediate update.

### Low-resolution matching
Matching quality degrades at sub-720p resolutions. 1080p is the target.

## Planned milestones

- **M9:** Multi-region/Multi-reference support per trigger (capture variations for different resolutions/skins).
- **M10:** YouTube support.
- **M11:** Firefox support.
- **M12:** Advanced community tools (voting on PRs, reputation system).
