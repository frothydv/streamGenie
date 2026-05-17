# Phase 5: AI Profile Population - Context

**Gathered:** 2026-05-17
**Status:** Ready for planning
**Source:** Grilling session (all decisions locked)

<domain>
## Phase Boundary

A local CLI skill + supporting Node.js scripts that accept a YouTube VOD URL, a game ID, and a profile ID, then automatically generate a populated profile branch in the streamGenieProfiles repo. The AI identifies game items using wiki grounding, extracts reference crops, validates them with the existing NCC matcher, and opens a PR. The user tests via a new popup dev override URL field, then approves via the existing accept-proposal Worker op.

This is an experimental branch feature. No changes to existing extension matching pipeline. One new UI addition to popup.html/js (dev override field). New scripts live in `scripts/` or a new `tools/` directory.

</domain>

<decisions>
## Implementation Decisions

### Invocation
- **D-01** Local Claude Code skill + Node.js scripts — user invokes with YouTube URL + game ID + profile ID
- **D-02** Vision model inherits from user's CLI context (not hardcoded) — user can try different models

### Frame Extraction
- **D-03** yt-dlp + ffmpeg for frame extraction — standardized at 1080p
- **D-04** Scene-change detection as default sampling strategy — ffmpeg `select='gt(scene,0.3)'` filter
- **D-05** Configurable floor interval — at least one frame every N seconds even with no scene change (default 30s); user can override with `--interval`
- **D-06** Pivot to alternative tools if yt-dlp/ffmpeg unavailable — detect and prompt with install instructions

### Wiki Grounding
- **D-07** Opportunistic wiki discovery — no locked source (Fandom, official wikis, whatever is findable)
- **D-08** Pre-identification approach — inject wiki item list into vision model context ("which of these items are visible in this frame, and where?"), not open-ended scanning
- **D-09** Wiki lookup produces structured item list: names + brief descriptions used for payload text accuracy

### Crop Extraction & Validation
- **D-10** Model returns approximate bounding box per identified item
- **D-11** Bbox + small fixed padding → NCC self-validation against same frame at that position
- **D-12** NCC threshold ≥ 0.65 = pass; one retry on fail (re-crop tighter, re-validate)
- **D-13** Soft gate — failures after retry are FLAGGED in summary (⚠ needs review), not dropped
- **D-14** Confidence tiers: ✓ high (NCC ≥ 0.85), ~ medium (0.65–0.85), ⚠ needs review (failed after retry)
- **D-15** User can re-crop and edit flagged triggers via existing editor UI after loading branch profile

### Node.js Validation
- **D-16** matcher-core.js + node-canvas runs in Node — no porting needed (UMD module already has module.exports)
- **D-17** Validation: grab frames at known trigger timestamps, run matcher, report pass/fail per trigger
- **D-18** Validation runs automatically before PR is opened

### Profile Branch & PR
- **D-19** Profile committed to a named branch in streamGenieProfiles (e.g. `ai/sts2-community-2026-05-17`)
- **D-20** PR opened automatically via GitHub API after branch is created
- **D-21** Merge path reuses existing accept-proposal Worker op — maintainer approves from popup proposal review UI
- **D-22** Trusted contributor key used for direct branch commits (same as human contributor path)

### Popup Dev Override
- **D-23** New "dev profile URL" input in popup.html/js — when set, overrides catalog fetch for that game in current session
- **D-24** User pastes raw GitHub branch URL to load AI-generated branch profile for testing
- **D-25** Override is session-scoped (not persisted beyond popup close)

### Multi-Video Additive
- **D-26** Running tool against a second video adds to existing profile branch, does not overwrite
- **D-27** Dedup: name match first (fast), then hash proximity check (Hamming distance ≤ 8 bits)
- **D-28** If name matches but hash is far apart → treat as VARIANT, add as additional reference on existing trigger (improves matching robustness)

### Summary Report
- **D-29** Markdown summary file written locally + console output
- **D-30** Summary includes: wiki item count, % mapped this pass, retry counts, confidence tiers per trigger, detectable timestamps, dev override URL, PR link
- **D-31** Approve command shown at bottom of summary (e.g. reference to accepting PR)

### Claude's Discretion
- Script entry point name and exact CLI flags (`--interval`, `--game`, `--profile`, etc.)
- Directory layout for new scripts (`scripts/ai-populate/` or `tools/`)
- Exact GitHub API call approach (Octokit vs raw fetch)
- Whether wiki fetching is a separate pre-step or inline during the vision pass
- Error handling for missing yt-dlp/ffmpeg (detect at startup, show install link)
- Whether the skill is a single `.md` file or multiple coordinated scripts

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Extension matching pipeline (do not break)
- `extension/matcher-core.js` — dHash + NCC implementation; must run in Node via node-canvas
- `extension/content.js` — main content script; popup dev override integrates here minimally
- `extension/popup.html` + `extension/popup.js` — dev override URL field goes here

### Profiles repo structure
- Profile schema in CLAUDE.md (profile.json, catalog.json, reference PNGs at `{profileBaseUrl}/references/{file}`)
- Cloudflare Worker at `streamgenie-submit.vbjosh.workers.dev` — existing ops: add, update, create-profile, accept-proposal

### Planning context
- CLAUDE.md (project primer) — architecture decisions, gotchas, working style
- `.planning/ROADMAP.md` — phase requirements AI-01 through AI-10

</canonical_refs>

<specifics>
## Specific Ideas

- ffmpeg scene-change filter: `ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)',fps=1/30" -vsync vfr frame_%04d.png`
- node-canvas shim for matcher-core.js: `const { createCanvas, loadImage } = require('canvas')`
- Branch naming: `ai/{game-id}-{profile-id}-{YYYY-MM-DD}`
- Summary timestamp format: `HH:MM:SS — Item Name (trigger-id) [confidence]`
- Popup override: `<input id="dev-profile-url" placeholder="Paste branch profile URL...">` in popup.html

</specifics>

<deferred>
## Deferred Ideas

- Firefox / YouTube extension support (post-beta)
- Batch processing multiple VODs in a single run
- AI-suggested mask painting (auto-generate masks for irregular shapes)
- Telemetry on AI-generated trigger match rates
- UI for reviewing AI-generated triggers in the extension itself (beyond popup override)

</deferred>

---

*Phase: 05-ai-profile-population*
*Context gathered: 2026-05-17 via grilling session*
