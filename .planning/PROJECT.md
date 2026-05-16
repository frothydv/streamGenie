# Stream Genie — YouTube Support

## What This Is

Add YouTube video support to Stream Genie, a Chrome extension that shows hover-to-reveal annotations over game streams. The pixel-capture → dHash matching → popup pipeline already works on Twitch. This project makes it work on YouTube too, unlocking easier testing (VODs can be replayed/scrubbed) and reaching YouTube gaming viewers.

## Core Value

The extension loads and annotations work on any Youtube video page, with sensible fallback game detection that the viewer can override.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — ship to validate)

### Active

- [ ] **MAN-01**: Extension content script runs on `*.youtube.com/*` pages
- [ ] **MAN-02**: Extension host permissions include `*.youtube.com/*`
- [ ] **MAN-03**: Web-accessible resources accessible on youtube.com pages
- [ ] **BG-01**: Hotkey (Alt+Shift+C) forwarded to YouTube tabs as well as Twitch
- [ ] **POP-01**: Popup status shows "Active on YouTube:" with path when on a YouTube video, instead of just "Not on Twitch."
- [ ] **POP-02**: Popup attempts title-based game detection then falls back to manual catalog selection
- [ ] **POP-03**: Catalog entries have a `legacyTwitchSlug` field (renamed from `twitchSlug`) to support multi-platform games
- [ ] **CONT-01**: Content script loads and initializes on YouTube pages without errors
- [ ] **CONT-02**: Video element is discovered on YouTube (different DOM structure than Twitch)
- [ ] **CONT-03**: Platform-agnostic heartbeat works on YouTube SPA navigation
- [ ] **CONT-04**: Game detection works via message from popup (popup sends detected game to content script)
- [ ] **CONT-05**: Twitch-specific logic (extension interference detection/handling) is skipped on YouTube
- [ ] **GAME-01**: Given a YouTube video page, the extension extracts the video title from the page
- [ ] **GAME-02**: Given a video title, the extension fuzzy-matches it against catalog game names
- [ ] **GAME-03**: If a match is found above threshold, the popup auto-selects that profile and shows "Detected: [game]" with an option to change
- [ ] **GAME-04**: If no match is found, the popup shows the full catalog for manual selection
- [ ] **TEST-01**: Extension works on a replayed YouTube VOD for testing purposes

### Out of Scope

- Channel-based auto-detection (`creators/youtube/{channel}.json`) — deferred
- YouTube-to-creator-config lookup — deferred
- YouTube-specific reference/test image gathering — not part of code work
- Firefox support — separate milestone
- Changing the profile repository schema for multi-platform support — defer until needed

## Context

The codebase is well-established at v0.9.2 with a mature matching pipeline. The main engineering challenge is not the pixel/matching code (which is platform-agnostic) but:

1. **Platform detection** — The extension needs to know if it's on Twitch or YouTube and branch behavior accordingly
2. **Game detection** — YouTube has no game category API; title-based matching is a new code path
3. **Video discovery** — YouTube's DOM is different; `querySelector` strategies need testing
4. **Heartbeat** — YouTube's SPA navigation is similar but video element lifecycle differs
5. **Twitch-specific code** — Extension interference handling uses Twitch-specific iframe selectors

A full codebase map exists at `.planning/codebase/` detailing the architecture, touch points, and concerns.

## Constraints

- **No external API calls for game detection** — Title matching must work client-side from the catalog
- **Must not break Twitch** — All existing Twitch functionality must work unchanged
- **Branch-only** — All work on `m10-youtube-support`; merge to main when stable
- **Minimal manifest scope** — Only `*.youtube.com/*` permissions added, not broad `<all_urls>`

## Key Decisions

| Decision | Rationale | Outcome |
| -------- | --------- | ------- |
| Title-based + manual fallback for game detection | YouTube has no game category; this is the simplest approach that works | - Pending |
| Branch m10-youtube-support | Isolated work, don't disrupt main | ✓ Good |
| Rename `twitchSlug` to `legacyTwitchSlug` in catalog | Cleaner model when games span platforms; avoids confusion | - Pending |
| Skip Twitch extension interference code on YouTube | YouTube doesn't have equivalent extension iframes | - Pending |

---
*Last updated: 2026-05-16 after initialization*
