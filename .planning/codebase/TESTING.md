# Test Coverage

**Analysis Date:** 2026-05-10

## Test Suite

**File:** `tests/rotation-matching.js`
**Run:** `node tests/rotation-matching.js`
**Count:** 39 tests

### Test Sections

| Section | What it covers |
|---------|---------------|
| `rotatePixels` correctness | Bilinear pixel rotation output for known synthetic inputs |
| `computeRotatedHashes` structure | Returns correct number of angle entries; hash lengths valid |
| `anglesForRotation` | Angle list generation for orthogonal/free modes; fineStepNearZero; baseAngle is preview-only |
| Rotation accuracy | Rotated ref matches at correct angle; near-miss angles don't match |
| False negatives without rotation | Confirms unrotated matcher misses rotated refs (validates the need for rotation) |
| False positives | Distinct refs don't cross-match above threshold |
| `findBestMatch` integration | End-to-end: synthetic capture → match result with correct triggerId, position, ncc score |
| Performance benchmarks | 5 rotating triggers < 150ms; 20 rotating triggers < 500ms |
| Native-dimensions hash invariant | dHash output is stable regardless of source image resolution |
| Noise resilience | ±20 pixel noise (H.264 simulation) doesn't break NCC match; dHash alone fails at ±3 |
| High-frequency (sharp border) | Refs with sharp edges match correctly |
| Masked NCC correctness | Mask data-URL correctly excludes masked pixels from NCC computation |
| Popup anchor stability | Offset math produces consistent popup position across ref sizes |

### Test Harness

Custom 20-line harness — no Jest/Vitest/Mocha:
```js
function test(name, fn) { ... }
function assert(cond, msg) { ... }
function assertClose(a, b, tol, msg) { ... }
```

## Coverage Gaps

### Completely untested
- `extension/content.js` — the entire content script:
  - Video attachment and heartbeat logic
  - Pixel capture (`captureRegion`, `clientToVideoCoords`)
  - Profile loading, cache TTL, stale-fallback
  - Game detection (`detectTwitchGame`)
  - Popup rendering and auto-dismiss
  - Debug panel
  - Capture mode (Alt+Shift+C freeze-and-drag)
  - Trigger editor / contribution UI
  - Heat-map test feature in editor
  - Toast notifications
  - Message handlers
- `extension/popup.js` — all proposal review UI, profile selection, contributor key flow
- `extension/background.js` — hotkey forwarding
- `workers/submit-trigger/index.js` — all Worker ops (add, update, remove, list-proposals, accept, reject)
- localStorage cache correctness and TTL expiry
- `ensureRawUrl()` URL conversion
- Profile schema validation (none exists)

### Integration / E2E
- No tests exercise actual Twitch DOM
- No tests exercise actual Chrome extension APIs
- No browser automation (Playwright/Puppeteer) configured

## CI/CD

None. No `.github/workflows/` directory. Tests are run manually:
```
node tests/rotation-matching.js
```

## Recommendations (pre-beta)

1. Add Worker unit tests (mock GitHub API calls) — highest ROI given contribution flow complexity
2. Add profile cache tests — TTL logic and stale-fallback have real edge cases
3. Add `ensureRawUrl()` unit test — trivial to add, guards against CDN URL format changes
4. Consider adding a smoke test that loads a real profile from the repo and validates schema
