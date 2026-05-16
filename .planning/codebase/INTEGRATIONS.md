# Integrations — External Services & APIs

## 1. GitHub (Profile Storage)

**What:** All game profiles (trigger definitions, reference images) are stored in `frothydv/streamGenieProfiles` on GitHub.

**Access pattern:**
- **Read:** Raw files fetched via `https://raw.githubusercontent.com/frothydv/streamGenieProfiles/{branch}/games/{gameId}/profiles/{profileId}/profile.json`
- **Write (via Worker):** Cloudflare Worker uses a GitHub PAT (`GITHUB_TOKEN` secret) to:
  - Create/modify profile JSON files via GitHub Contents API
  - Open pull requests for untrusted submissions
  - Update catalog stats (`catalog.json`)

**Endpoints used by the Worker:**
- `GET /repos/{owner}/{repo}/contents/{path}` — read existing files
- `PUT /repos/{owner}/{repo}/contents/{path}` — create/update files (direct commits)
- `POST /repos/{owner}/{repo}/pulls` — create PRs (untrusted submissions)
- `GET /repos/{owner}/{repo}/pulls` — list open PRs for proposal review

## 2. Cloudflare Worker (Submission Backend)

**Endpoint:** `POST https://streamgenie-submit.vbjosh.workers.dev`

**Shared secret authentication:** Both extension and Worker share `SUBMIT_SECRET` (currently a hardcoded string `YorkshireTractorFactor`). Sent as `X-Submit-Secret` header.

**Contributor authentication:** Trusted contributors authenticate via a UUID code stored in KV (`CONTRIBUTOR_KEYS`). Sent as `X-Contributor-Key` header.

**Modes (request body `mode` field):**

| Mode | Description | Auth Required |
|------|-------------|---------------|
| `add` | Submit new trigger. Trusted → direct commit, untrusted → PR | Optional |
| `update` | Modify existing trigger payloads. Same auth split | Optional |
| `remove` | Delete a trigger. Same auth split | Optional |
| `create-profile` | Create new game/profile stub + catalog entry. Always direct | None |
| `verify` | Check if X-Contributor-Key is trusted for gameId/profileId | None |
| `activate` | Anonymous usage ping — increments profile `timesUsed` counter | None |
| `list-proposals` | List open PRs for a game/profile (triggers pending review) | Trusted only |
| `accept-proposal` | Merge an open PR proposal | Trusted only |

**KV namespaces:**
- `CONTRIBUTOR_KEYS` — maps UUID → `{ gameId, profileId, label, createdAt }`
- `PROFILE_STATS` — usage counters (`timesUsed:{gameId}:{profileId}`)

## 3. Twitch (Target Platform)

**Content script scope:** `https://*.twitch.tv/*`

**Interaction model (read-only):**
- The extension never calls the Twitch API.
- Game detection is done by scraping the DOM: `document.querySelector('[data-a-target="stream-game-link"]')` reads the game name and slug from the channel page.
- No OAuth, no Helix API, no authentication required.

## 4. CDN / Content Delivery

**jsDelivr (CDN, currently bypassed):**
- Original URL pattern: `https://cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@main/{path}`
- Currently rewritten to direct GitHub Raw URLs via `ensureRawUrl()` to avoid propagation lag.

**GitHub Raw (active):**
- `https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/{path}`
- Cache-busting: `_cb` query param with `Date.now()`, `cache: "no-store"` fetch option

## 5. Chrome Extension APIs (Host Permissions)

| Pattern | Purpose |
|---------|---------|
| `https://*.twitch.tv/*` | Content script injection + pixel capture |
| `https://cdn.jsdelivr.net/*` | (Legacy) CDN profile loading |
| `https://raw.githubusercontent.com/*` | Profile/reference image loading |
| `https://*.workers.dev/*` | Cloudflare Worker submission endpoint |

## 6. Image/Reference Storage

Reference images (PNG crops captured during contribution flow) are stored in the same GitHub repo under `games/{gameId}/profiles/{profileId}/references/`. They are submitted as base64 `dataUrl` in the POST body to the Worker, which decodes and stores them as binary files.

## Security Notes

- **SUBMIT_SECRET** is hardcoded in both `extension/content.js` and `extension/popup.js` — this is flagged as acceptable for a dev build but should use proper OAuth for production.
- No user authentication or session management exists yet.
- Profile data is publicly readable by design (open-source community knowledge).
