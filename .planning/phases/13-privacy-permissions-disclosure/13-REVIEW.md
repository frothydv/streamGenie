---
phase: 13-privacy-permissions-disclosure
reviewed: 2026-05-16T00:00:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - extension/popup.html
  - README.md
  - STORE-LISTING.md
findings:
  critical: 2
  warning: 2
  info: 2
  total: 6
status: issues_found
---

# Phase 13: Code Review Report

**Reviewed:** 2026-05-16
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Phase 13 added a "Privacy →" anchor link to the first-run banner in `popup.html`, a permissions table to `README.md`, and created `STORE-LISTING.md` with Chrome Web Store copy. The anchor tag in `popup.html` is structurally correct, but the extension ships a hardcoded plaintext secret in `config.js` — a credential that belongs in environment configuration, not committed source. Additionally, the catalog is fetched exclusively from `raw.githubusercontent.com` (not `cdn.jsdelivr.net` as the permissions table implies), and the short-description char count annotation in `STORE-LISTING.md` is wrong by 4 characters, which could cause a rejected submission to the Chrome Web Store.

---

## Critical Issues

### CR-01: Hardcoded secret committed to repository

**File:** `extension/config.js:3`

**Issue:** `config.js` contains a plaintext API secret (`SUBMIT_SECRET: "YorkshireTractorFactor"`) that is committed to the repository. This secret is used to authenticate trusted contributor operations against the Cloudflare Worker (`streamgenie-submit.vbjosh.workers.dev`). Any person who clones or forks the repository — or reads the file via GitHub's web UI — can impersonate a trusted contributor and commit directly to the profiles repository, bypassing the PR review flow. The file header even acknowledges this (`// DO NOT COMMIT — see config.example.js`), confirming the commit was unintentional.

**Fix:** Remove `config.js` from version control immediately. Add it to `.gitignore`. The secret itself must be rotated in the Cloudflare Worker's allowed-key list, because it is already public if it was ever pushed. Use `config.example.js` as a template with a placeholder:

```js
// config.example.js — copy to config.js and fill in your key
const StreamGenieConfig = {
  SUBMIT_SECRET: "REPLACE_ME",
};
```

Then add to `.gitignore`:
```
extension/config.js
```

### CR-02: Privacy claim redundant phrase signals inaccuracy to CWS reviewers

**File:** `STORE-LISTING.md:24`

**Issue:** The Privacy paragraph contains a logically redundant and self-contradicting double-claim: "Nothing leaves your device during normal use." followed two sentences later by "Pixel processing stays on your device — nothing is transmitted." These two sentences say the same thing. Chrome Web Store reviewers are trained to flag internally inconsistent privacy disclosures and may read the repetition as an attempt to obscure a distinction (i.e., "what does 'normal use' exclude?"). More concretely, the phrase "during normal use" implies there are abnormal situations where data *does* leave the device. This is technically true (contributions upload a reference image to the worker), but the second sentence drops the qualifier and claims nothing is ever transmitted — which is false when a user submits a trigger.

**Fix:** Collapse the two claims into one accurate sentence that covers both the passive-matching case and the contribution case:

```
Pixel matching runs locally in your browser using perceptual image hashing. 
The only outbound requests Stream Genie makes are: downloading community 
profiles from GitHub, and uploading the reference image and description you 
explicitly submit when contributing an annotation. No analytics. No telemetry. 
No account required.
```

---

## Warnings

### WR-01: Permissions table lists `cdn.jsdelivr.net` with wrong description

**File:** `README.md:45` and `STORE-LISTING.md:57`

**Issue:** Both permissions tables include:

```
| `https://cdn.jsdelivr.net/*` | Fetch the game catalog |
```

The actual code in `popup.js` fetches the catalog exclusively from `raw.githubusercontent.com`:

```js
const CATALOG_URL = "https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/catalog.json";
```

The `ensureRawUrl()` function converts any `cdn.jsdelivr.net` URL to `raw.githubusercontent.com`. The `cdn.jsdelivr.net` host permission exists in `manifest.json` as a safety net (in case profile URLs embedded in the catalog still reference jsDelivr), but it is not used by the catalog fetch itself. Describing it as "Fetch the game catalog" is factually wrong and misrepresents what the permission is for. Chrome Web Store reviewers must be able to match each declared permission to its actual use; a misdescribed permission can cause rejection.

**Fix:** Update both tables to accurately describe the jsDelivr permission:

```
| `https://cdn.jsdelivr.net/*` | Load community profiles served via jsDelivr CDN (fallback) |
```

Or, if jsDelivr is truly not used in any current code path, remove the host_permission from `manifest.json` and both tables. Confirm by auditing whether any profile URL in the catalog JSON can still contain a jsDelivr hostname that would be fetched by `content.js`.

### WR-02: `popup.html` `action` title is stale ("Stream Overlay")

**File:** `extension/manifest.json:27` (surfaced via `popup.html` context)

**Issue:** The manifest `action.default_title` is `"Stream Overlay"` while the product has been renamed to `"Stream Genie"`. This title appears in the browser tooltip when users hover over the toolbar icon. It is inconsistent with `popup.html` line 146 (`<h1>Stream Genie (pre-alpha)</h1>`) and the store listing name. While this is in `manifest.json` rather than one of the three reviewed files, it is directly visible to users via the toolbar icon that the privacy disclosure (popup.html) is embedded in, and contradicts the branding in the store listing.

**Fix:** In `manifest.json` line 27, change:
```json
"default_title": "Stream Overlay"
```
to:
```json
"default_title": "Stream Genie"
```

---

## Info

### IN-01: Short description char count annotation is wrong

**File:** `STORE-LISTING.md:7`

**Issue:** The annotation `_(128 chars)_` is incorrect. The short description "Hover over anything in a Twitch stream and get instant community-built explanations. No streamer setup. Works with any game." is 124 characters, not 128. The Chrome Web Store limit is 132 characters. At 124 chars the description is well within limits, but the wrong annotation means anyone checking compliance against the annotation will get a false number.

**Fix:** Update the annotation:
```
_(124 chars)_
```

### IN-02: Full description char count annotation is wrong

**File:** `STORE-LISTING.md:46`

**Issue:** The annotation `_(1,647 chars)_` is incorrect. The full description block (including markdown bold markers `**`) is approximately 2,029 characters. Even without markdown symbols, it exceeds 1,647. The Chrome Web Store limit for the full description is 16,000 characters, so this is not a hard blocker, but the annotation is wrong by ~23–38% depending on how markdown is counted. If the intent was to track proximity to the limit, the annotation gives a false sense of room to expand.

**Fix:** Recount and update the annotation to the actual character length. If markdown formatting (bold markers, etc.) will be stripped when pasting into the CWS form, use the plain-text count; otherwise use the raw count:
```
_(~2,029 chars with markdown / ~1,993 chars plain text)_
```

---

_Reviewed: 2026-05-16_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
