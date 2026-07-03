# Stream Genie — Maintainer Handoff

Read `CLAUDE.md` first for the concept and architecture. This file covers how to
operate the system, what protects it from abuse, and where to take matching next.
Small, mechanical tasks live in `SMALL-TASKS.md` — they are scoped so a small
model (Haiku, local qwen) can do them one at a time.

## Operating the system

### Pieces

| Piece | Where | Deploy |
|---|---|---|
| Extension | `extension/` | `chrome://extensions` → Load unpacked → reload after edits |
| Submit worker | `workers/submit-trigger/` | `cd workers/submit-trigger && npx wrangler deploy` |
| Profiles repo | github.com/frothydv/streamGenieProfiles | normal git; served via raw.githubusercontent.com |

### Secrets and config

- `extension/config.js` (gitignored) holds `SUBMIT_SECRET`. It must match the
  worker's secret. On a new machine, copy it from the old machine or create it
  and re-set the worker secret to match.
- Worker secrets: `npx wrangler secret put GITHUB_TOKEN` (PAT with Contents +
  Pull requests write on streamGenieProfiles) and `npx wrangler secret put SUBMIT_SECRET`.
- KV namespaces (bound in `wrangler.toml`): `CONTRIBUTOR_KEYS` (uuid → {gameId,
  profileId, label}) and `PROFILE_STATS` (usage counters + rate-limit buckets).

### Tests

```
node tests/rotation-matching.js      # 55 tests — matcher math
node tests/worker-submit.js          # 85 tests — worker ops (imports the real worker code)
node tests/pending-duplicate.test.js #  9 tests — pending-trigger dedup
npm run test:e2e                     # 19 Playwright tests — error states, privacy banner, YouTube
```

Node ≥ 22 required (the worker tests import the ES-module worker directly).
E2e runs against **Edge** by default (`channel: msedge` in `tests/e2e/helpers.js`)
because branded Chrome ≥ 137 removed `--load-extension` and Playwright's bundled
Chromium doesn't spawn on every Windows machine. Override with `SG_E2E_CHANNEL`.

## Security model — what stops the community from ruining it

Assume the submit secret is public: it ships inside the extension, so anyone can
extract it and send raw requests to the worker. The real defenses, all
server-side in `workers/submit-trigger/index.js`:

1. **Slug validation.** `gameId`/`profileId`/trigger ids/branch names/reference
   filenames must match strict regexes before they touch a GitHub API path.
   This is what prevents writes outside `games/**` (e.g. `.github/workflows`).
2. **Size caps** (`LIMITS` const): payload title/text length, payload/reference
   counts, image and mask data-URL sizes, 500 triggers per profile. Keeps
   profile.json — which every viewer downloads — from being bloated.
3. **Content-type checks.** `dataUrl`/`maskDataUrl` must be png/jpeg/webp data
   URLs. `popupOffset` and `rotation` are normalised to clamped finite numbers
   (a rotation `step ≤ 0` would hang every viewer's angle loop; the client
   clamps too, in `matcher-core.js anglesForRotation`).
4. **Rate limits** (per-IP, hourly, in KV): 20 untrusted writes, 5
   create-profiles. Trusted contributors bypass them.
5. **Untrusted writes become PRs**, never direct commits. Only holders of a
   contributor key scoped to that game/profile can commit directly or review.
6. **Rendering.** Viewer-facing popup and the popup UI use `textContent` for all
   community text. Never add an `innerHTML` that interpolates profile, catalog,
   or proposal data.

### Abuse playbook

- **Bad trigger merged:** delete it via the curator panel (trusted key), or edit
  profile.json in the profiles repo directly.
- **Contributor key misused:** delete that UUID from the `CONTRIBUTOR_KEYS` KV
  namespace (Cloudflare dashboard → Workers KV). Their next write becomes a PR.
- **Spam PRs / junk profiles:** close PRs and delete catalog entries in the
  profiles repo directly; git history preserves everything.
- **Worst case (token leak):** rotate the GitHub PAT, `wrangler secret put GITHUB_TOKEN`,
  force-push the profiles repo to a known-good commit.
- **Secret rotation:** change `SUBMIT_SECRET` in the worker and ship a new
  extension version with the new `config.js`. Old installs lose submit (not
  viewing) until updated.

### Known-accepted risks

- Anyone can `create-profile` (5/hour/IP) and pollute the catalog. Moderation is
  manual repo cleanup. Fine at current scale; revisit if it becomes a problem.
- `activate` pings write to the catalog through the GitHub API — noisy commit
  history, SHA races dropped silently. Cosmetic.
- jsDelivr URLs still exist in older catalog entries; `ensureRawUrl()` in the
  extension converts them at load.

## Matching: better / faster (post-beta roadmap, in priority order)

Current pipeline (good): hover-scoped capture → dHash sliding window at native
crop size → NCC verification with shared summed-area table (M9). Rotated
reference hashes are precomputed at profile load, not per hover.

1. **Canonical-size hashing** for sub-720p streams: resize both the reference
   and the capture window to a fixed 32×32 before hashing, so a 35px ref at 480p
   stops being skipped. Biggest gap in viewer experience today; medium effort in
   `matcher-core.js` (`buildRefHash` / `findBestMatch`).
2. **Coarse-to-fine search:** before the full dHash slide, prefilter candidate
   positions with a 4×-downsampled absolute-difference pass and only run dHash
   on the top K positions. Cuts per-hover cost roughly 5–10×; helps most when a
   profile has many triggers.
3. **pHash (DCT) as a secondary hash** for refs whose dHash is low-entropy
   (flat art, gradients). Compute at authoring time, store alongside; only
   consult when dHash is ambiguous.
4. **Color-histogram confirmation:** cheap 8-bucket hue histogram comparison as
   a tiebreaker when NCC is borderline (0.55–0.65). Low effort, kills the
   remaining false positives on grayscale-similar shapes.
5. **Bench first:** `tests/bench-ncc.js` exists — extend it before optimizing so
   wins are measured, not guessed.

## Before the Chrome Web Store listing

- Manifest is v0.10.1, MV3, permissions are already minimal (`activeTab`,
  `storage`, scoped host permissions) — good.
- Privacy disclosure: first-run banner + privacy link exist and are e2e-tested
  (`tests/e2e/privacy-disclosure.spec.js`). The store listing text must repeat
  it: pixels are read locally, nothing leaves the device except explicit
  contribution submissions.
- Store assets needed: 1280×800 screenshots, 440×280 promo tile, privacy policy
  URL (the `streamGenie/privacy` page the banner links to must be live).
- Pack `extension/` as a zip **including** `config.js` — it is required at
  runtime for submissions. Keeping it out of git is about accident-prevention,
  not secrecy: the secret is extractable from any install, which is why the
  worker treats every request as untrusted.
