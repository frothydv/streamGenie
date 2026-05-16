# Testing — Structure, Practices & Coverage

## Test Framework

**No test framework.** All tests are vanilla Node.js scripts run via `node <file>`. They use the built-in `assert` module for assertions and print their own pass/fail output to stdout.

**Running tests:**
```bash
# Single test
node tests/static_analysis.test.js

# Matching tests (requires pngjs)
node test-matching-node.js

# Worker tests (requires live Worker deployment)
node tests/worker-submit.js

# Shell script for matching tests
./run-matching-test.sh
```

## Test Categories

### 1. Static Analysis (`tests/static_analysis.test.js` — 81 lines)
- Regex-based checks on source code without executing it.
- Verifies variable naming consistency (`currentVideo` vs `video`, `uKey` vs `key`).
- Ensures cache-busting is present in popup code.
- Checks that `deleteLocally` uses IDs (not indices).
- Runs in Node.js, no DOM required.

### 2. Matching Algorithm Tests (`test-matching-node.js`, various `tests/*.js`)
- Pure JS tests exercising `matcher-core.js` in Node.js.
- Use `pngjs` to load reference images from disk for comparison.
- Key test files:

| File | Lines | Focus |
|------|-------|-------|
| `tests/rotation-matching.js` | 1282 | Comprehensive rotation matching — all angle configs, clip masks, NCC verification with rotation |
| `tests/rotation-realdata.js` | 258 | Rotation matching against real captured frames from streams |
| `tests/masked-matching.js` | 160 | Test masked reference matching (non-rectangular icons) |
| `tests/ref-noise.js` | 246 | Resilience tests — how matching degrades with image noise |
| `tests/realcapture.js` | 255 | Matching against actual stream capture images |
| `test-matching-node.js` | 429 | Main Node.js test harness for matching pipeline |

### 3. Integration Tests (`tests/integration/`)
| File | Lines | Focus |
|------|-------|-------|
| `tests/integration/data_flow.test.js` | 196 | End-to-end data flow: profile loading → reference loading → hash computation → matching |
| `tests/integration/sync_flow.test.js` | 87 | Sync freshness — cache busting, stale-while-revalidate, local vs CDN reconciliation |

### 4. Worker Tests (`tests/worker-submit.js` — 1107 lines)
- Tests the Cloudflare Worker's GitHub API integration.
- Extensive mocking of GitHub API responses.
- Covers all modes: add, update, remove, create-profile, verify, list-proposals, accept-proposal.
- Tests both trusted (direct commit) and untrusted (PR) submission paths.
- Requires the Worker to be deployed and a `SUBMIT_SECRET` matching.

### 5. Browser-Based Tests (`test-matching.html` — 337 lines)
- HTML page that loads `matcher-core.js` and runs matching tests in a browser context.
- Useful for debugging canvas-based hash computation visually.

### 6. Profile/Data Layer Tests
| File | Lines | Focus |
|------|-------|-------|
| `tests/catalog-verified.js` | 203 | Verified badge propagation across catalog entries |
| `tests/m5-create-profile.js` | 191 | Profile creation flow (create → catalog → select) |
| `tests/m5-twitchslug.js` | 185 | Twitch slug ↔ gameId matching |
| `tests/m5-unit.js` | 172 | M5 milestone unit tests |
| `tests/popup-contributor-status.js` | 210 | Contributor code verification UI flow |
| `tests/profile-catalog-repair.js` | 179 | Edge cases with catalog recovery |
| `tests/profile-reload.js` | 172 | Profile reload lifecycle events |
| `tests/permissions.js` | 217 | Extension permission/interference tests |
| `tests/verify-complete-fix.js` | 78 | Verification system regression test |
| `tests/live_sync_check.js` | 77 | Live sync freshness check |

## What Is NOT Tested (Gaps)

1. **Browser DOM interaction** — Tests do not run in a browser/headless environment. `content.js` UI rendering (popup, debug panel, editor modal) is untested.
2. **Mouse tracking + pixel capture** — The `clientToVideoCoords()` and `captureRegion()` functions depend on a live video element and can't be tested in Node.js.
3. **Full user flow** — No end-to-end test that opens a Twitch page, loads profiles, hovers, and verifies popup appearance.
4. **Chrome API interactions** — `chrome.storage`, `chrome.tabs.sendMessage` calls are not mocked in tests.
5. **Performance benchmarks** — No tests measure capture-to-popup latency or hash computation time.
6. **Profile schema validation** — No tests validate that a profile JSON conforms to the expected schema.

## Testing Practices

- **Test isolation:** Each test file is independent and can be run separately.
- **No mock framework:** HTTP interactions in worker tests are mocked with hand-crafted response objects.
- **Console-driven testing:** Tests log progress messages (`✓ Cache-busting implemented`) and throw `AssertionError` on failure.
- **Border cases covered:** Empty profiles, missing references, zero-size images, all-rotated cards, noise resilience.
- **Two environments:** Matching logic tested in Node.js (for fast iteration) and in-browser (for visual debugging).
