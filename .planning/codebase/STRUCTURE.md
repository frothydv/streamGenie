# Structure — Directory Layout & Organization

## Top-Level Layout

```
twitch-overlay-sidekick/
├── extension/                    # The Chrome Extension
│   ├── manifest.json             # Chrome Extension manifest (MV3)
│   ├── content.js                # (~3726 lines) Main content script
│   ├── background.js             # Service worker (~40 lines)
│   ├── matcher-core.js           # Shared matching library (~700 lines)
│   ├── popup.html                # Popup UI HTML (~250 lines)
│   ├── popup.js                  # Popup logic (~950 lines)
│   ├── icons/                    # Extension icons (16, 48, 128px PNGs)
│   └── references/               # Bundled reference PNGs (legacy/built-in)
│       ├── coin-gold.png
│       ├── coin-gold-old.png
│       ├── ice-cream-relic.png
│       ├── map-icon.png
│       └── map-icon-old.png
│
├── workers/                      # Serverless backend
│   └── submit-trigger/           # Cloudflare Worker
│       ├── index.js              # (~659 lines) Main worker logic
│       ├── wrangler.toml         # Worker configuration
│       └── test.js               # Worker integration tests
│
├── tests/                        # Node.js test files
│   ├── integration/              # Integration tests
│   │   ├── data_flow.test.js     # End-to-end data flow test
│   │   └── sync_flow.test.js     # Sync/freshness flow test
│   ├── fixtures/                 # Test fixtures (profile templates, reference images)
│   ├── catalog-verified.js       # Catalog verified badge propagation test
│   ├── live_sync_check.js        # Sync freshness check
│   ├── m5-create-profile.js      # Profile creation test
│   ├── m5-twitchslug.js          # Twitch slug matching test
│   ├── m5-unit.js                # M5 unit tests
│   ├── masked-matching.js        # Masked reference matching tests
│   ├── permissions.js            # Permission/extension interference tests
│   ├── popup-contributor-status.js # Contributor status UI tests
│   ├── profile-catalog-repair.js # Profile catalog repair tests
│   ├── profile-reload.js         # Profile reload lifecycle tests
│   ├── realcapture.js            # Real capture tests (live stream matching)
│   ├── ref-noise.js              # Reference image noise resilience tests
│   ├── rotation-matching.js      # (~1282 lines) Rotation matching comprehensive tests
│   ├── rotation-realdata.js      # Rotation matching with real captures
│   ├── static_analysis.test.js   # Variable naming & code structure checks
│   ├── verify-complete-fix.js    # Verification system fix tests
│   └── worker-submit.js          # (~1107 lines) Worker submission tests
│
├── test-captures/                # Screenshots/captures used in matching tests
│
├── scripts/                      # Dev/CI scripts
│   └── build-alpha.js            # Build script (zips extension/ for distribution)
│
├── docs/                         # Project documentation / landing page
│   ├── index.html                # (Late) GitHub Pages site
│   ├── privacy.html              # Privacy policy
│   └── images/                   # Screenshots for docs
│
├── .gitignore
├── README.md                     # User-facing README
├── CLAUDE.md                     # Project context for AI agents
├── AGENTS.md                     # Agent instructions (duplicated from CLAUDE.md)
├── algorithm_research_report.md  # Research notes on matching algorithms
├── interference_report.md        # Report on Twitch extension interference
├── package.json                  # Node.js project config
├── package-test.json             # Secondary test package config
├── package-lock.json             # Lockfile for pngjs v7
├── run-matching-test.sh          # Shell script to run matching tests
├── test-matching-node.js         # Node.js matching test harness
└── test-matching.html            # Browser-based matching test
```

## Key File Sizes (Signals for Complexity)

| File | Lines | Signal |
|------|-------|--------|
| `extension/content.js` | 3726 | **Main complexity center** — high coupling, low separation of concerns |
| `extension/matcher-core.js` | ~700 | Cleanly isolated module with well-defined interface |
| `extension/popup.js` | ~950 | Moderate complexity — profile management + contributor status + trigger listing |
| `workers/submit-trigger/index.js` | ~659 | Self-contained worker with clear mode dispatch |
| `tests/rotation-matching.js` | ~1282 | Most complex test — extensive rotation edge cases |
| `tests/worker-submit.js` | ~1107 | Comprehensive worker integration tests |

## Naming Conventions

- **Files:** kebab-case (`matcher-core.js`, `build-alpha.js`, `profile-reload.js`)
- **Test files:** descriptive with `.test.js` suffix (`static_analysis.test.js`, `data_flow.test.js`)
- **Variables:** camelCase (`currentVideo`, `activeProfile`, `mouseOverVideo`)
- **Constants:** UPPER_SNAKE_CASE (`CAPTURE_SIZE`, `PROFILE_CACHE_TTL_MS`, `HEARTBEAT_MS`)
- **Storage keys:** `streamGenie_*` prefix (`streamGenie_active_profile`, `streamGenie_debugPanel`)
- **IDs:** UUID-like strings for triggers; slugified identifiers for profiles/games

## Config Values

Key constants defined at the top of `content.js`:

| Constant | Value | Purpose |
|----------|-------|---------|
| `CAPTURE_SIZE` | 160 | Pixel region captured under cursor |
| `CAPTURE_INTERVAL_MS` | 100 | Mouse throttle interval (10Hz) |
| `HEARTBEAT_MS` | 500 | Video discovery polling interval |
| `MIN_VIDEO_SIZE` | 100 | Minimum video dimension to consider |
| `PROFILE_CACHE_TTL_MS` | 120000 | Profile cache lifetime (2 min) |
| `CANONICAL_SIZE` | 32 | Virtual size for consistent dHash quality |
| `MIN_REF_PX` | 8 | Smallest reference to hash |
