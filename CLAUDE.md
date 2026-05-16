# Stream Genie — Project Primer

You are picking up a project in progress. This document captures the concept, architectural decisions, current state, and what remains before a public beta.

## The concept

A browser extension that adds **hover-to-reveal annotations** over Twitch streams (and eventually YouTube). When a viewer hovers over something on screen — a card in a card game, a relic, a UI icon — a popup appears showing text explaining it.

The key insight: we read **pixels** from the video stream, not game state. This is intentionally game-agnostic. Any game works once a profile exists for it. Community members contribute the profiles.

Inspired by the Hearthstone Deck Tracker and Slay the Spire overlays, but generalized to work with any game without per-game engineering.

## Architectural decisions (already made, do not re-litigate)

### Viewer-side, not streamer-side

Browser extension that runs viewer-side. Zero streamer install barrier, works on VODs/clips, hover-scoping makes pixel quality on re-encoded Twitch video acceptable.

### Hover-scoped matching, not continuous scanning

We only scan the region under the cursor on hover, not the whole frame continuously. Cuts CPU cost by orders of magnitude, turns detection into classification, and makes perceptual-hash nearest-neighbor viable.

### Profiles repo hosted on GitHub, served via raw.githubusercontent.com (with jsDelivr as CDN fallback)

One central repo (`frothydv/streamGenieProfiles`) with multiple profiles per game. GitHub for storage/versioning/moderation-via-PR; `raw.githubusercontent.com` for fast serving with `ensureRawUrl()` converting jsDelivr URLs when needed. Zero infrastructure cost.

### Permission tiers via contributor keys, not a full roles system

Trusted contributors get a UUID key that lets them commit directly to main via the Cloudflare Worker. Everyone else's submissions become PRs. Maintainer reviews and merges via the popup's proposal review UI. Do not build a richer roles UI until community scale forces the issue.

### Streamer-declared profile bundles (planned, not yet built)

Creators will declare which profiles their viewers get via `creators/twitch/{streamer}.json` in the profiles repo. Not yet implemented — current detection is game-category-based only.

### Cross-platform by design, Chrome-only for v1

Manifest V3 Chrome extension. YouTube and Firefox are post-beta.

## Current state — v0.9.0

All core milestones are complete. The extension can detect a game, load a community profile from GitHub, match triggers against live video pixels, show popups, and let contributors submit new triggers via a Cloudflare Worker that opens PRs.

### Milestones shipped

- **M1:** Hello-world extension — manifest, service worker, content script, toolbar popup.
- **M2:** Hover detection + pixel capture. Finds video element, tracks cursor at document level (bypasses Twitch overlay divs), captures 160×160 region. Debug panel shows live preview.
- **M2.3:** Capture mode. Alt+Shift+C freezes frame as overlay, user drags box → captured crop used as reference image in the contribution editor.
- **M3:** Perceptual hash matching. dHash at native crop dimensions, sliding-window search, popup rendering (dark Twitch theme), match distance shown in debug panel.
- **M4:** Profile loading. Fetches `catalog.json` then individual `profile.json` from `raw.githubusercontent.com`. 2-minute localStorage cache with stale-fallback. Hardcoded fallback catalog if CDN is unreachable.
- **M5:** Game detection. `detectTwitchGame()` reads the stream-game-link from the Twitch DOM, extracts the category slug, polls every 500ms for SPA navigation. Popup matches `detectedSlug` against catalog entries (handles Twitch slug format differences).
- **M6:** STS2 community profile seeded with real triggers.
- **M7:** Full contribution flow. Capture → reference editor (payload text, popup offset, mask paint, rotation schema) → submit to `streamgenie-submit.vbjosh.workers.dev`. Trusted contributors commit directly to main; untrusted contributors open PRs. Popup shows pending proposals; maintainer can accept or reject from within the extension.
- **M8 (rotation schema):** Rotation-aware matching. Triggers declare a rotation schema (mode: `orthogonal` | `free`, with configurable range/step/fine-steps). Phase 1 always matches the as-captured orientation; Phase 2 searches additional angles. Authoring UI includes animated inline preview and a live heat-map validation test. 39-test suite.
- **M9 (NCC verification):** NCC (Normalized Cross-Correlation) secondary match pass. After dHash locates the best candidate position, NCC verifies it using a summed-area table for O(1) mean/variance. NCC normalizes for local brightness and contrast, making it immune to H.264 level shifts that cause dHash near-misses on live streams. Score ≥ 0.65 fires a match independently of the dHash ratio. SAT built once per hover event and shared across all triggers (~0.24ms overhead). Debug panel surfaces ncc= score. Map-icon went from failing at ±3 noise to holding at ±20.

### Profile selection gap

Profile selection in the popup is still manual — the user picks from a list of profiles for the detected game. Auto-selection (e.g. picking the top/verified profile automatically) and streamer-specific overrides (`creators/twitch/` lookup) are not yet built.

## File layout

```
extension/
  manifest.json           # Manifest V3, Chrome, v0.9.0
  background.js           # Service worker; hotkey forwarding
  content.js              # Main content script (~2900 lines). All matching, UI, editor.
  matcher-core.js         # dHash, rotation, findBestMatch — loaded before content.js
  popup.html + popup.js   # Toolbar popup: game detection, profile select, proposals
  icons/                  # 16/48/128px PNGs
workers/
  submit-trigger/
    index.js              # Cloudflare Worker — add/update/remove/create-profile/review ops
    wrangler.toml         # Worker config (account: vbjosh)
tests/
  rotation-matching.js    # 39 tests — angle generation, accuracy, heat-map invariants, speed
```

`content.js` is an IIFE with `window.__streamOverlayLoaded` guard. Major sections:
1. Config constants and profile loading
2. Video discovery (`findBestVideo`, `attachToVideo`, 500ms heartbeat)
3. Pixel capture (`clientToVideoCoords`, `captureRegion`, 160×160 + 480×480 wide)
4. Matching pipeline (invokes `MatcherCore.findBestMatch`)
5. Popup rendering (dark Twitch theme, auto-dismiss on cursor leave)
6. Debug panel
7. Capture mode (Alt+Shift+C freeze-and-drag)
8. Trigger editor / contribution UI (payload, offset, mask, rotation schema, heat-map test)
9. Toast notifications
10. Message handlers (hotkey, get-game, review-proposal)

## Profile and catalog schema

### `catalog.json`
```json
{
  "games": [
    {
      "id": "slay-the-spire-2",
      "name": "Slay the Spire 2",
      "twitchSlug": "slay-the-spire-ii",
      "profiles": [
        {
          "id": "community",
          "name": "STS2 Community",
          "verified": true,
          "url": "https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/games/slay-the-spire-2/profiles/community/profile.json"
        }
      ]
    }
  ]
}
```

### `profile.json`
```json
{
  "triggers": [
    {
      "id": "map-button",
      "payloads": [
        {
          "title": "Map",
          "text": "Opens the map.",
          "popupOffset": { "x": 14, "y": 22 },
          "image": null
        }
      ],
      "references": [
        {
          "file": "map-button.png",
          "w": 95,
          "h": 116,
          "srcW": 1920,
          "srcH": 1080,
          "maskDataUrl": "data:image/png;base64,..."
        }
      ],
      "rotation": {
        "mode": "free",
        "minAngle": -30,
        "maxAngle": 30,
        "step": 5,
        "fineStepNearZero": true,
        "baseAngle": 0
      },
      "rotates": true
    }
  ]
}
```

Reference PNGs live at `{profileBaseUrl}/references/{file}`.

## Worker operations

`POST https://streamgenie-submit.vbjosh.workers.dev` with JSON body `{ op, gameId, profileId, trigger?, triggerId?, contributorKey? }`.

| op | trusted | untrusted |
|----|---------|-----------|
| `add` | direct commit to main | opens PR |
| `update` | direct commit | opens PR |
| `remove` | direct commit | opens PR |
| `create-profile` | direct commit, returns contributor code | — |
| `verify` | checks contributor key validity | — |
| `list-proposals` | lists open PRs for game/profile | — |
| `accept-proposal` | merges PR | — |
| `reject-proposal` | closes PR with comment | — |

## Gotchas discovered and handled

- **Chrome reserves Ctrl+Shift+C** for DevTools. Use Alt+Shift+C.
- **Twitch has hidden `<video>` preloaders** on homepages. Pick the largest visible video with non-zero dimensions.
- **Twitch overlay divs swallow pointer events** on the video. Listen at document level and check bounds.
- **Video appears late on SPA navigation.** 500ms heartbeat re-evaluates attachment.
- **Resolution varies.** dHash at native crop dimensions is robust; heat-map stride fixed at 4 (guarantees ≤2px offset, ≤2 bit mismatch at threshold 7).
- **`parseFloat("0") || default` treats 0 as falsy.** Use `parseOrDef(val, def)` with `isNaN` check everywhere rotation inputs are read.
- **jsDelivr CDN lags behind main branch** by up to 24 hours. `ensureRawUrl()` converts CDN URLs to `raw.githubusercontent.com` on load.
- **Rotation schema: Phase 1 always fires.** Phase 1 matches the as-captured orientation regardless of the configured rotation range. The range is additive (adds more angles to search), not a filter.
- **baseAngle is preview-only.** It tells the animation where the ref is tilted in real life. It does NOT shift `anglesForRotation()`'s output.

## Testing workflow

1. Edit files directly (Claude Code).
2. `chrome://extensions/` → reload the "Stream Genie (pre-alpha)" card.
3. Reload the Twitch page.
4. F12 → Console, filter by `[overlay` for extension logs.
5. Run `node tests/rotation-matching.js` for the matcher test suite.
6. Run `npm run test:e2e` for the Playwright e2e suite (6 tests — error states, CDN failure, schema validation). Requires Chromium: `npx playwright install chromium`.

## Known limitations

### Low-resolution matching
References smaller than ~40px at the viewer's stream resolution are silently skipped (insufficient discriminative power). In practice:
- **1080p:** all refs match well.
- **720p:** larger refs match; tiny refs (~35px) may miss.
- **480p and below:** most small refs disabled.

Acceptable while profiles are anchored to streamers who broadcast at source resolution. Future options: canonical-size hashing (resize both sides to 32×32), pHash (DCT-based), or color histogram confirmation pass.

## Working style notes

Push back on scope creep. When the user floats an idea, evaluate seriously and say yes-and or no-and. Do not default to agreement.

When a change is small, make it. When large or architectural, surface for discussion first.

Commits should be semantic and descriptive.

The user is comfortable clicking reload and pasting console errors. Keep instructions concrete and minimal.

## What remains before a public beta

### Must-haves
- **Profile curation UX** — delete a trigger, overwrite a trigger (new image + import existing metadata), profile grid/review mode so a contributor can scan all triggers quickly. Near-duplicate detection (surface triggers whose hashes are close).
- **Viewer onboarding** — "no profile found for this stream" state that explains the extension is working. First-run banner.
- **Privacy/permissions disclosure** — store listing and first-run must state that pixels are read locally, nothing leaves the device.

### Nice-to-haves (post-beta)
- Auto-profile selection in popup (pick top verified profile automatically)
- Creator/streamer-specific profile config (`creators/twitch/{streamer}.json`)
- Match quality indicator in editor (auto-run heat-map on open, show pass/fail)
- Rate limiting / abuse prevention on the Cloudflare Worker
- Profile upvotes + sorting (see wishlist memory)
- Profile owner review UI and report button (see wishlist memory)
- YouTube support, Firefox support, sub-720p matching improvements

## Planned future work (post-beta roadmap)

- Creator-declared profile bundles (`creators/twitch/` lookup)
- YouTube + Firefox support
- Profile upvotes and community sorting
- Owner review UI and viewer report button
- Telemetry (which triggers match most) — requires backend + privacy consideration
