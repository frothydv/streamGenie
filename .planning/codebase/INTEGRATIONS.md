# External Integrations

**Analysis Date:** 2026-05-10

## Profile Data — GitHub Repository

**Repo:** `frothydv/streamGenieProfiles` (github.com)

**Purpose:** Central store for all game profiles, trigger references, and the catalog index.

**Files fetched at runtime:**

| File | URL Pattern | Fetched by |
|------|-------------|------------|
| `catalog.json` | `https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/catalog.json` | `popup.js` |
| `profile.json` | `https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/games/{gameId}/profiles/{profileId}/profile.json` | `content.js` |
| Reference PNGs | `{profileBaseUrl}/references/{file}` | `content.js` |

**Cache strategy:** `chrome.storage.local` with a 2-minute TTL (`PROFILE_CACHE_TTL_MS = 2 * 60 * 1000`). On cache miss or expiry, fetches fresh; on network failure, falls back to stale cache entry.

**Fallback catalog:** Both `content.js` and `popup.js` embed a hardcoded `FALLBACK_CATALOG` covering the STS2 community profile. Used when the CDN fetch fails entirely.

## CDN — raw.githubusercontent.com vs jsDelivr

**Primary:** `https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/...`

**Secondary (legacy/fallback):** `https://cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@main/...`

The function `ensureRawUrl()` (duplicated in both `content.js` and `popup.js`) converts any jsDelivr URL to its raw.githubusercontent.com equivalent before fetching. This bypasses the jsDelivr CDN's up-to-24-hour propagation lag during active development.

Both domains are listed in `manifest.json` `host_permissions`.

## Cloudflare Worker — Contribution Backend

**Endpoint:** `https://streamgenie-submit.vbjosh.workers.dev`

**Source:** `workers/submit-trigger/index.js`

**Auth:** Every request must include `X-Submit-Secret` header matching the `SUBMIT_SECRET` env secret. Trusted contributors additionally send `X-Contributor-Key` (UUID) validated against the `CONTRIBUTOR_KEYS` KV namespace.

**Operations (all via POST with JSON body):**

| mode | Trusted contributor | Untrusted contributor | Notes |
|------|--------------------|-----------------------|-------|
| `add` | Direct commit to `main` | Opens GitHub PR | Requires `trigger.references[0].dataUrl` |
| `update` | Direct commit | Opens GitHub PR | Patches payloads on existing trigger |
| `remove` | Direct commit | Opens GitHub PR | Deletes trigger by id |
| `create-profile` | Direct commit; returns contributor code | Not available | Creates profile stub + catalog entry |
| `verify` | Returns `{ trusted: true }` | Returns `{ trusted: false }` | Validates contributor key |
| `list-proposals` | Lists open PRs for game/profile | 403 | Trusted only |
| `accept-proposal` | Merges PR | 403 | Trusted only |
| `reject-proposal` | Closes PR with comment | 403 | Trusted only |
| `activate` | Records usage ping to KV | Available (anonymous) | Increments `timesUsed` counter |

**Cloudflare KV namespaces:**

| Binding | Purpose |
|---------|---------|
| `CONTRIBUTOR_KEYS` | UUID keys → `{ gameId, profileId, label, createdAt }` |
| `PROFILE_STATS` | Usage counts keyed as `timesUsed:{gameId}:{profileId}` |

**Secrets (set via `wrangler secret put`, never in repo):**
- `GITHUB_TOKEN` — GitHub PAT with Contents + Pull Requests write on `streamGenieProfiles`
- `SUBMIT_SECRET` — shared secret; must match the constant in `content.js` / `popup.js`

**CORS:** Worker responds to `OPTIONS` with `Access-Control-Allow-Origin: *`.

## GitHub API — Direct from Cloudflare Worker

The Cloudflare Worker calls the GitHub REST API directly using a PAT. Operations include:
- `GET /repos/frothydv/streamGenieProfiles/contents/{path}` — read files
- `PUT /repos/frothydv/streamGenieProfiles/contents/{path}` — create or update files (direct commits to `main`)
- `POST /repos/frothydv/streamGenieProfiles/pulls` — open a PR (untrusted path)
- `PUT /repos/frothydv/streamGenieProfiles/pulls/{prNumber}/merge` — merge a PR
- `PATCH /repos/frothydv/streamGenieProfiles/pulls/{prNumber}` — close a PR

The extension itself never calls the GitHub API directly.

## Twitch DOM

The extension reads from the Twitch page DOM (no Twitch API calls, no OAuth):

| What is read | How | File |
|-------------|-----|------|
| Game/category slug | `querySelector('[data-a-target="stream-game-link"]')` then href regex | `content.js` |
| Live video stream pixels | `<video>` element via `getBoundingClientRect` + `drawImage` to canvas | `content.js` |
| Twitch extension iframes | `querySelectorAll("iframe")` filtered on `ext-twitch.tv` src | `content.js` |

Game detection polls on a 500ms heartbeat to handle Twitch SPA navigation.

**No Twitch API credentials are used.**

## Manifest Declared Host Permissions

```json
"host_permissions": [
  "https://*.twitch.tv/*",
  "https://cdn.jsdelivr.net/*",
  "https://raw.githubusercontent.com/*",
  "https://*.workers.dev/*"
]
```

## Privacy Boundary

All pixel capture, dHash, and NCC happen locally in the browser. Pixels never leave the device. Outbound calls only:
1. Fetch `catalog.json` / `profile.json` from `raw.githubusercontent.com` (no user data)
2. POST to Cloudflare Worker on contribution submit (trigger payload + optional contributor key)
3. POST `activate` mode on profile load (sends `gameId` + `profileId` only — anonymous)
