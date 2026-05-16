# Requirements: YouTube Support

**Defined:** 2026-05-16
**Core Value:** The extension loads and annotations work on any YouTube video page, with sensible fallback game detection that the viewer can override.

## v1 Requirements

### Manifest & Background

- [ ] **MAN-01**: Content script runs on `*.youtube.com/*` pages
- [ ] **MAN-02**: Extension host permissions include `*.youtube.com/*`
- [ ] **MAN-03**: Web-accessible resources are accessible on youtube.com pages
- [ ] **BG-01**: Alt+Shift+C hotkey forwarded to YouTube tabs

### Content Script — Platform Layer

- [ ] **CONT-01**: Content script initializes on YouTube without errors (guards all Twitch-specific code)
- [ ] **CONT-02**: Platform detection helper distinguishes twitch/youtube at startup
- [ ] **CONT-03**: `heartbeat()` handles YouTube SPA navigation (video element replaced on new video)
- [ ] **CONT-04**: Video element discovery works on YouTube (`querySelectorAll("video")` picks up the player)
- [ ] **CONT-05**: `clientToVideoCoords()` handles YouTube's `object-fit: initial` (no letterbox compensation)
- [ ] **CONT-06**: Reference image loading works on YouTube (web-accessible resources URL)
- [ ] **CONT-07**: Content script responds to `get-video-info` message (for popup title detection)

### Game Detection

- [ ] **GAME-01**: On YouTube, video title extracted from `h1 yt-formatted-string`
- [ ] **GAME-02**: Catalog games matched against title using substring + fuzzy matching
- [ ] **GAME-03**: `twitchSlug` renamed to `legacyTwitchSlug` in catalog schema
- [ ] **GAME-04**: Match result sent to popup for display

### Popup

- [ ] **POP-01**: Status shows "Active on YouTube: /watch" when on YouTube
- [ ] **POP-02**: On YouTube, popup sends `get-video-info` to content script to detect game
- [ ] **POP-03**: If game detected, popup shows "Detected: [Game Name] ✓" with "change" link
- [ ] **POP-04**: If no game detected, popup shows full catalog for manual selection
- [ ] **POP-05**: Popup works fully when no content script is injected (YouTube tab without video page)

### Testing

- [ ] **TEST-01**: Extension loads and initializes on a YouTube VOD page without errors
- [ ] **TEST-02**: Video element found, mouse tracking works on YouTube
- [ ] **TEST-03**: Twitch pages continue to work unchanged (regression)
- [ ] **TEST-04**: Alt+Shift+C capture mode works on YouTube

## v2 Requirements

- **GAME-05**: Channel-based profile mapping (`creators/youtube/{channel}.json`)
- **GAME-06**: YouTube-specific reference/test image gathering for popular games
- **POP-06**: Popup shows channel name on YouTube for context

## Out of Scope

| Feature | Reason |
| ------- | ------ |
| Channel-based auto-detection | Deferred — title matching + manual covers our use case |
| YouTube-to-creator-config lookup | Requires repository schema changes |
| Firefox/YouTube support | Firefox is a separate milestone |
| `<all_urls>` permission | Would flag Chrome Web Store review — keep scoped |

## Traceability

| Requirement | Phase | Status |
| ----------- | ----- | ------ |
| MAN-01 | Phase 1 | Pending |
| MAN-02 | Phase 1 | Pending |
| MAN-03 | Phase 1 | Pending |
| BG-01 | Phase 1 | Pending |
| CONT-01 | Phase 2 | Pending |
| CONT-02 | Phase 2 | Pending |
| CONT-03 | Phase 2 | Pending |
| CONT-04 | Phase 2 | Pending |
| CONT-05 | Phase 2 | Pending |
| CONT-06 | Phase 2 | Pending |
| CONT-07 | Phase 3 | Pending |
| GAME-01 | Phase 3 | Pending |
| GAME-02 | Phase 3 | Pending |
| GAME-03 | Phase 3 | Pending |
| GAME-04 | Phase 3 | Pending |
| POP-01 | Phase 4 | Pending |
| POP-02 | Phase 4 | Pending |
| POP-03 | Phase 4 | Pending |
| POP-04 | Phase 4 | Pending |
| POP-05 | Phase 4 | Pending |
| TEST-01 | Phase 4 | Pending |
| TEST-02 | Phase 4 | Pending |
| TEST-03 | Phase 1 | Pending |
| TEST-04 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-16*
*Last updated: 2026-05-16 after initial definition*
