# Phase 5: AI Profile Population - Research

**Researched:** 2026-05-17
**Domain:** Node.js CLI tooling — video frame extraction, vision API, GitHub API, NCC validation
**Confidence:** HIGH (all critical claims verified against live environment and official docs)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Invocation**
- D-01: Local Claude Code skill + Node.js scripts — user invokes with YouTube URL + game ID + profile ID
- D-02: Vision model inherits from user's CLI context (not hardcoded) — user can try different models

**Frame Extraction**
- D-03: yt-dlp + ffmpeg for frame extraction — standardized at 1080p
- D-04: Scene-change detection as default sampling strategy — ffmpeg `select='gt(scene,0.3)'` filter
- D-05: Configurable floor interval — at least one frame every N seconds (default 30s); user can override with `--interval`
- D-06: Pivot to alternative tools if yt-dlp/ffmpeg unavailable — detect and prompt with install instructions

**Wiki Grounding**
- D-07: Opportunistic wiki discovery — no locked source (Fandom, official wikis, whatever is findable)
- D-08: Pre-identification approach — inject wiki item list into vision model context
- D-09: Wiki lookup produces structured item list: names + brief descriptions for payload accuracy

**Crop Extraction & Validation**
- D-10: Model returns approximate bounding box per identified item
- D-11: Bbox + small fixed padding → NCC self-validation against same frame at that position
- D-12: NCC threshold ≥ 0.65 = pass; one retry on fail (re-crop tighter, re-validate)
- D-13: Soft gate — failures after retry flagged in summary (⚠ needs review), not dropped
- D-14: Confidence tiers: ✓ high (NCC ≥ 0.85), ~ medium (0.65–0.85), ⚠ needs review (< 0.65 after retry)
- D-15: User can re-crop and edit flagged triggers via existing editor UI after loading branch profile

**Node.js Validation**
- D-16: matcher-core.js + node-canvas runs in Node — no porting needed (UMD module already has module.exports)
- D-17: Validation: grab frames at known trigger timestamps, run matcher, report pass/fail per trigger
- D-18: Validation runs automatically before PR is opened

**Profile Branch & PR**
- D-19: Branch naming `ai/{game-id}-{profile-id}-{YYYY-MM-DD}` in streamGenieProfiles
- D-20: PR opened automatically via GitHub API after branch is created
- D-21: Merge path reuses existing accept-proposal Worker op
- D-22: Trusted contributor key used for direct branch commits

**Popup Dev Override**
- D-23: New "dev profile URL" input in popup.html/js — overrides catalog fetch for that game
- D-24: User pastes raw GitHub branch URL to load AI-generated branch profile
- D-25: Override is session-scoped (not persisted beyond popup close)

**Multi-Video Additive**
- D-26: Running tool against a second video adds to existing profile branch, does not overwrite
- D-27: Dedup: name match first (fast), then hash proximity check (Hamming distance ≤ 8 bits)
- D-28: Name match but hash far apart → treat as VARIANT, add as additional reference on existing trigger

**Summary Report**
- D-29: Markdown summary file written locally + console output
- D-30: Summary includes: wiki item count, % mapped, retry counts, confidence tiers, timestamps, dev URL, PR link
- D-31: Approve command shown at bottom of summary

### Claude's Discretion
- Script entry point name and exact CLI flags (`--interval`, `--game`, `--profile`, etc.)
- Directory layout for new scripts (`scripts/ai-populate/` or `tools/`)
- Exact GitHub API call approach (Octokit vs raw fetch)
- Whether wiki fetching is a separate pre-step or inline during the vision pass
- Error handling for missing yt-dlp/ffmpeg (detect at startup, show install link)
- Whether the skill is a single `.md` file or multiple coordinated scripts

### Deferred Ideas (OUT OF SCOPE)
- Firefox / YouTube extension support (post-beta)
- Batch processing multiple VODs in a single run
- AI-suggested mask painting
- Telemetry on AI-generated trigger match rates
- UI for reviewing AI-generated triggers in the extension itself
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AI-01 | Frame extraction — yt-dlp + ffmpeg, 1080p, scene-change detection with configurable floor interval | Verified: yt-dlp 2026.03.17 at WinGet path; ffmpeg 4.3.1 with `select` filter; exact commands confirmed |
| AI-02 | Wiki grounding — opportunistic wiki lookup, item list injected as pre-identification prompt | Pattern established via vision API docs; web scraping with `fetch` is sufficient |
| AI-03 | Vision pass — model identifies items in frame, returns bbox per item | Verified: Claude API base64 PNG messages format confirmed from official docs |
| AI-04 | Crop validation — bbox + padding → NCC self-validation (≥0.65 pass), one retry, soft gate | Verified: matcher-core.js works in Node.js; pngjs sufficient (no canvas needed) |
| AI-05 | node-canvas + matcher-core.js validator runs in Node.js for automated pre-PR testing | Verified: canvas 3.2.3 installs and works on Node 22/Windows; pngjs also sufficient for all required ops |
| AI-06 | Profile branch builder — writes reference PNGs + profile.json to named branch in streamGenieProfiles | Verified: GitHub raw fetch API pattern already in workers/submit-trigger/index.js |
| AI-07 | PR creation — opens PR via GitHub API; merge path uses existing accept-proposal Worker op | Verified: exact API call pattern from existing worker code |
| AI-08 | Popup dev override — URL input in popup.html/js loads branch profile URL | Verified: popup.js profile load path and session storage pattern identified |
| AI-09 | Multi-video additive — name match + hash proximity dedup; duplicates become additional references | Pattern clear from matcher-core.js API; Hamming distance via dHash output |
| AI-10 | Summary report — wiki item count, % mapped per pass, retry counts, confidence tiers, timestamps, dev URL, PR link | Simple fs.writeFileSync output; no library needed |
</phase_requirements>

---

## Summary

This phase builds a standalone CLI tool (`scripts/ai-populate/`) that automates the most labor-intensive part of profile creation: extracting reference images and descriptive text from game footage. The tool downloads a YouTube VOD, extracts representative frames using ffmpeg scene-change detection, fetches a game wiki item list for grounding, and asks a vision model "which of these items are in this frame and where?" for each frame. Identified items become trigger candidates: a crop is taken, validated against itself using the existing NCC matcher, and committed to a new branch in streamGenieProfiles.

The implementation is entirely in Node.js scripts — no new runtime dependencies beyond what is already in place, no changes to the extension matching pipeline, and one small addition to popup.html/popup.js for dev override testing. The most important finding is that **pngjs (already a project dependency) handles all pixel operations needed for NCC validation** — canvas is not required and should not be used. The existing worker code provides a complete, copy-paste-ready pattern for all GitHub API operations (branch creation, file commits, PR opening).

The ANTHROPIC_API_KEY is not currently in the shell environment; the script must read it from the environment at runtime (fail fast with a clear message if absent). The vision model is not hardcoded — the script reads `process.env.CLAUDE_MODEL` or a `--model` flag, defaulting to a sensible value at runtime.

**Primary recommendation:** Implement as `scripts/ai-populate/index.js` (CLI entry point) + `lib/*.js` helpers. Use raw `fetch` for the GitHub API (mirroring the worker pattern exactly), `@anthropic-ai/sdk` for the vision calls, `pngjs` for PNG decoding (already installed), and the existing `matcher-core.js` for NCC validation. Do not install `canvas`.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Frame extraction | CLI script (Node.js) | — | Downloads video and extracts frames locally before any API call |
| Wiki grounding | CLI script (Node.js) | External web (Fandom/wikis) | Fetches wiki pages at runtime; no server-side component needed |
| Vision model calls | CLI script (Node.js) | Anthropic API | Reads ANTHROPIC_API_KEY from env; model name from env/flag |
| NCC crop validation | CLI script (Node.js) | matcher-core.js | Same validation logic as extension; runs before any write |
| GitHub branch/PR | CLI script (Node.js) | GitHub API (raw fetch) | Mirrors exact pattern from workers/submit-trigger/index.js |
| Popup dev override | Browser extension (popup.js) | — | Session-scoped URL field; overrides catalog fetch for testing |
| Profile merge review | Existing Worker + popup | — | accept-proposal op already built; no new code needed |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| pngjs | 7.0.0 | PNG encode/decode for crops and reference images | Already installed; pure JS (no native build); handles all required ops |
| @anthropic-ai/sdk | 0.96.0 | Vision model API calls | Official SDK; handles auth, retry, streaming |
| matcher-core.js | in-repo | dHash + NCC validation | Already works in Node (UMD + module.exports); tested |

[VERIFIED: npm registry + local node_modules]

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| yt-dlp | 2026.03.17 | YouTube VOD download | At WinGet path; use `--format bestvideo+bestaudio` |
| ffmpeg | 4.3.1 | Scene-change frame extraction | At miniconda PATH; `select` filter confirmed available |
| node:child_process | built-in | Spawning yt-dlp and ffmpeg | Standard — no extra library needed |
| node:fs, node:path | built-in | File operations, temp dir | Standard |
| node:fetch | built-in (Node 18+) | GitHub API + wiki fetching | No need for axios or node-fetch |

[VERIFIED: local environment checks]

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pngjs for image decode | canvas (node-canvas) | canvas requires prebuilt binary (works on this machine, but adds a fragile native dep). pngjs is pure JS, already installed, and sufficient |
| raw fetch for GitHub | @octokit/rest | Octokit is 200KB+ extra dep; existing worker already shows raw fetch works for all needed ops |
| @anthropic-ai/sdk | raw fetch to API | SDK handles auth header, versioning, retry logic; worth the install |

**Installation:**
```bash
npm install @anthropic-ai/sdk
```
pngjs is already installed. No other new dependencies.

**Version verification:** [VERIFIED: npm view @anthropic-ai/sdk version → 0.96.0]

---

## Architecture Patterns

### System Architecture Diagram

```
User invokes: node scripts/ai-populate/index.js <youtube-url> --game sts2 --profile community

1. PREFLIGHT
   ├── Detect yt-dlp (WinGet path or PATH)
   ├── Detect ffmpeg (PATH or miniconda path)
   └── Check ANTHROPIC_API_KEY in env

2. FRAME EXTRACTION
   ├── yt-dlp → download 1080p video to temp dir (MP4)
   └── ffmpeg → scene-change frames + floor-interval frames → temp/frames/*.png

3. WIKI GROUNDING
   ├── fetch() Fandom/wiki for gameId
   └── Parse: [{name, description}, ...] item list

4. VISION PASS (per frame)
   ├── Read frame PNG → base64
   ├── POST to Anthropic API (image + text: "which of these items are visible, and where?")
   └── Parse response → [{name, bbox: {x,y,w,h}}, ...]

5. CROP + VALIDATE (per identified item per frame)
   ├── Crop PNG at bbox + padding → candidatePng
   ├── pngjs.sync.read → RGBA pixels
   ├── matcher-core.buildRefNCC(pixels, w, h) → refNCC
   ├── NCC self-check: score = nccScoreAt(sceneGray, ..., refNCC, ...)
   │   ├── score ≥ 0.85 → ✓ high confidence
   │   ├── score ≥ 0.65 → ~ medium confidence
   │   └── score < 0.65 → retry with tighter crop → if still fails → ⚠
   └── Emit: {triggerId, name, pngBuf, refW, refH, srcW, srcH, nccScore, confidence}

6. DEDUP (multi-video additive)
   ├── Load existing branch profile.json (if branch exists)
   ├── For each new candidate: name match against existing triggers
   └── If name match: Hamming(newHash, existingHash)
       ├── ≤ 8 bits → skip (true duplicate)
       └── > 8 bits → add as additional reference (variant)

7. PROFILE BRANCH BUILD
   ├── Get main SHA via GitHub API
   ├── Create branch ai/{game-id}-{profile-id}-{YYYY-MM-DD} (or reuse if exists)
   ├── For each trigger: PUT reference PNG to branch
   └── PUT profile.json to branch

8. VALIDATION PASS
   ├── For each trigger: re-extract frame at source timestamp
   ├── Run matcher-core.findBestMatch against known cursor position
   └── Report pass/fail per trigger

9. PR CREATION
   └── POST /repos/.../pulls (title, body, head=branch, base=main)

10. SUMMARY REPORT
    ├── Write summary.md locally
    └── Print to console: item counts, confidence breakdown, PR URL, dev override URL
```

### Recommended Project Structure
```
scripts/
└── ai-populate/
    ├── index.js           # CLI entry — arg parsing, orchestration, error handling
    ├── lib/
    │   ├── extract.js     # yt-dlp + ffmpeg frame extraction
    │   ├── wiki.js        # Wiki scraping + item list parser
    │   ├── vision.js      # Anthropic API calls — image + prompt
    │   ├── crop.js        # Bbox-to-PNG crop with padding
    │   ├── validate.js    # NCC self-validation using matcher-core + pngjs
    │   ├── github.js      # Branch create, file PUT, PR open (mirrors worker pattern)
    │   ├── dedup.js       # Name match + Hamming distance dedup
    │   └── report.js      # Markdown summary generation
    └── README.md          # Usage, env vars, examples
```

### Pattern 1: Anthropic Vision API Call (Node.js, base64 PNG)
**What:** Send a frame image to the vision model with a pre-identification prompt
**When to use:** For each extracted frame during the vision pass

```javascript
// Source: https://platform.claude.com/docs/en/docs/build-with-claude/vision
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,  // required — fail fast if absent
});

async function identifyItemsInFrame(framePngBuf, wikiItems, model) {
  const base64 = framePngBuf.toString('base64');
  const itemList = wikiItems.map(i => `- ${i.name}: ${i.description}`).join('\n');

  const msg = await client.messages.create({
    model: model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: base64 },
        },
        {
          type: 'text',
          text: [
            'Here is a list of game items from a wiki:',
            itemList,
            '',
            'Which of these items are visible in this frame?',
            'For each visible item, return a JSON array entry with:',
            '  { "name": "<exact name from list>", "bbox": { "x": <px>, "y": <px>, "w": <px>, "h": <px> } }',
            'Use pixel coordinates in the original image dimensions.',
            'Return ONLY valid JSON, no prose.',
          ].join('\n'),
        },
      ],
    }],
  });

  return JSON.parse(msg.content[0].text);
}
```

**IMPORTANT — coordinate rescaling:** Claude resizes images that exceed 1568px on the long edge. A 1920x1080 frame is downscaled internally. The bbox returned is in the *resized* image's coordinate space. Rescale back to original:
```javascript
// resizedW = 1568 (for 1920x1080), resizedH = Math.round(1568 * 1080/1920) = 882
const scaleX = originalW / resizedW;
const scaleY = originalH / resizedH;
bbox.x = Math.round(bbox.x * scaleX);
bbox.y = Math.round(bbox.y * scaleY);
bbox.w = Math.round(bbox.w * scaleX);
bbox.h = Math.round(bbox.h * scaleY);
```
[VERIFIED: official Anthropic docs — "coordinates will be expressed with respect to the resized/padded image and will need to be rescaled/translated accordingly"]

### Pattern 2: Frame Extraction (yt-dlp + ffmpeg)
**What:** Download 1080p video, extract scene-change frames with floor interval
**When to use:** Step 1 of the pipeline

```javascript
// Source: CONTEXT.md D-04, verified against local ffmpeg 4.3.1 filters list
const { execFile, spawnSync } = require('child_process');
const path = require('path');

async function extractFrames(videoUrl, outputDir, intervalSeconds = 30) {
  const ytDlpPath = findYtDlp(); // check PATH, then WinGet path
  const ffmpegPath = findFfmpeg(); // check PATH, then miniconda path
  const videoPath = path.join(outputDir, 'video.mp4');

  // Step 1: Download 1080p
  spawnSync(ytDlpPath, [
    '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]',
    '--merge-output-format', 'mp4',
    '-o', videoPath,
    videoUrl,
  ], { stdio: 'inherit' });

  // Step 2: Extract frames — scene change OR floor interval
  // select filter: scene change (threshold 0.3) OR first frame after N seconds
  // fps=1/N ensures floor: at most one frame per N seconds from the fps gate
  // -vsync vfr: variable frame rate output (only write selected frames)
  spawnSync(ffmpegPath, [
    '-i', videoPath,
    '-vf', `select='gt(scene\\,0.3)+not(mod(t\\,${intervalSeconds}))',fps=1/${intervalSeconds}`,
    '-vsync', 'vfr',
    path.join(outputDir, 'frame_%04d.png'),
  ], { stdio: 'inherit' });
}
```

**Note on filter escaping:** The `select` filter's comma inside the expression must be escaped with `\,` to prevent ffmpeg from interpreting it as a filter chain separator. `gt(scene,0.3)` becomes `gt(scene\\,0.3)` in a JS string passed as a shell argument.

[VERIFIED: ffmpeg 4.3.1 has `select` and `scdet` filters; filter syntax matches documented pattern]

### Pattern 3: NCC Self-Validation (pngjs + matcher-core)
**What:** Validate a crop against itself — high NCC confirms the crop contains a visually coherent, non-noisy region
**When to use:** After each bbox crop, before committing to the profile

```javascript
// Source: test-matching-node.js (existing working pattern in project)
const { PNG } = require('pngjs');
const MatcherCore = require('../../extension/matcher-core.js');

const matcher = MatcherCore.createMatcher();

function validateCrop(cropPngBuf) {
  const png = PNG.sync.read(cropPngBuf);
  const pixels = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  const w = png.width, h = png.height;

  // Build NCC data for the crop as both reference and scene
  const refNCC = matcher.buildRefNCC(pixels, w, h);
  const grayBuffer = matcher.createGrayBuffer();
  // Note: createGrayBuffer creates a 160x160 buffer; for crops smaller than 160px
  // we need a custom gray buffer sized to the crop
  const cropGray = new Float32Array(w * h);
  matcher.fillGrayBuffer(pixels, cropGray);  // fills in-place

  // Build SAT for the crop-as-scene
  const { sat, sat2 } = matcher.buildSAT(cropGray, w, h);

  // Self-NCC: the crop at position (0,0) against itself = should be ~1.0 for coherent crops
  const score = matcher.nccScoreAt(cropGray, w, sat, sat2, 0, 0, refNCC, w, h);
  return score;
}
```

**Self-NCC limitation:** Self-NCC at position (0,0) against itself always returns 1.0 because the crop IS the reference. The real validation is: after obtaining the NCC data, call `nccScoreAt` with the *full frame* as scene and the crop bbox position — confirms the crop at that position is a real match, not noise.

Correct approach:
```javascript
// Full frame as scene, crop as reference — validates the bbox position in the frame
const frameGray = new Float32Array(frameW * frameH);
matcher.fillGrayBuffer(framePixels, frameGray);
const { sat, sat2 } = matcher.buildSAT(frameGray, frameW, frameH);
const score = matcher.nccScoreAt(frameGray, frameW, sat, sat2, bboxX, bboxY, refNCC, bboxW, bboxH);
```

[VERIFIED: matcher-core.js source read; test-matching-node.js already does this correctly; pngjs integration tested in this session]

### Pattern 4: GitHub Branch + File Commit + PR (raw fetch)
**What:** Create a branch, PUT reference PNGs + profile.json, open PR
**When to use:** After validation passes

The exact pattern is already in `workers/submit-trigger/index.js`. The Node.js script replicates the `githubClient` + `addTrigger` pattern:

```javascript
// Source: workers/submit-trigger/index.js (copy pattern exactly)
function githubClient(token) {
  return async function gh(path, method, body) {
    const res = await fetch(`https://api.github.com/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'StreamGenie-AiPopulate/1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.status);
      throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${msg}`);
    }
    return res.status === 204 ? null : res.json();
  };
}

// Branch creation
async function createBranch(gh, branchName) {
  const { object: { sha } } = await gh(
    `repos/${OWNER}/${REPO}/git/refs/heads/main`, 'GET'
  );
  await gh(`repos/${OWNER}/${REPO}/git/refs`, 'POST', {
    ref: `refs/heads/${branchName}`,
    sha,
  });
}

// File PUT (creates or updates — include sha for updates)
async function putFile(gh, filePath, branch, contentBuf, message, existingSha) {
  const body = {
    message,
    content: contentBuf.toString('base64'),
    branch,
  };
  if (existingSha) body.sha = existingSha;
  await gh(`repos/${OWNER}/${REPO}/contents/${filePath}`, 'PUT', body);
}

// PR open
async function openPR(gh, branchName, title, body) {
  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, 'POST', {
    title,
    body,
    head: branchName,
    base: 'main',
  });
  return pr.html_url;
}
```

[VERIFIED: direct code read of workers/submit-trigger/index.js — pattern confirmed working in production]

### Pattern 5: Popup Dev Override Hook
**What:** Session-scoped URL input that overrides catalog profile URL for testing
**When to use:** User pastes branch profile.json URL to test AI-generated profile live

popup.html addition (in Developer Tools section, after debug-panel-btn):
```html
<div class="section-title" style="margin-top:12px;">AI Branch Testing</div>
<div style="background:#1f1f23; border-radius:4px; padding:6px 8px; margin-bottom:8px;">
  <label class="field-label" for="dev-profile-url">Dev Profile URL (session only)</label>
  <input id="dev-profile-url" type="text"
    placeholder="Paste branch profile.json URL…"
    style="width:100%;box-sizing:border-box;background:#0e0e10;border:1px solid #555;
           border-radius:4px;color:#efeff1;padding:4px 8px;font-size:11px;margin-top:4px;" />
  <button id="dev-profile-apply" class="delete-btn" style="margin-top:4px;padding:4px 10px;width:100%;">
    Apply Override
  </button>
  <div id="dev-profile-note" class="note" style="margin-top:4px;"></div>
</div>
```

popup.js: The override does NOT use `chrome.storage.local` (session-scoped = popup lifetime only). It stores in a module-level variable and intercepts the `fetch` in `renderTriggers()`:

```javascript
let devProfileOverrideUrl = null;  // module-level, cleared on popup close

document.getElementById('dev-profile-apply')?.addEventListener('click', () => {
  const url = document.getElementById('dev-profile-url').value.trim();
  if (!url) { document.getElementById('dev-profile-note').textContent = 'Paste a URL first.'; return; }
  devProfileOverrideUrl = ensureRawUrl(url);
  document.getElementById('dev-profile-note').textContent = 'Override active — hover on stream to test.';
  document.getElementById('dev-profile-note').style.color = '#00f593';
  // Notify content script to use this URL instead of its cached profile
  if (currentTab) {
    chrome.tabs.sendMessage(currentTab.id, {
      type: 'load-dev-profile',
      profileUrl: devProfileOverrideUrl,
    }).catch(() => {});
  }
});
```

The content script needs a `load-dev-profile` message handler that replaces the in-memory profile for the current session (already has a `reload-profile` message handler — this is an extension of that pattern).

[VERIFIED: popup.js source read — ensureRawUrl, renderTriggers, message pattern all confirmed; content.js has reload-profile handler]

### Anti-Patterns to Avoid

- **Do not use canvas for PNG operations.** pngjs is pure JS, already installed, and handles all needed operations (`PNG.sync.read`, `PNG.sync.write`). canvas requires a prebuilt binary and adds installation risk.
- **Do not hardcode the model name.** `process.env.CLAUDE_MODEL` or a `--model` flag; default to `claude-sonnet-4-5` at most as a runtime fallback — never burned into code.
- **Do not call yt-dlp/ffmpeg without detection.** Check binary existence at startup; print actionable install instructions if missing (not a crash with a useless error).
- **Do not open a PR if no triggers pass validation.** Guard: if 0 triggers have NCC ≥ 0.65 after retry, print summary and exit without creating a PR.
- **Do not mix additive mode (multi-video) with first-run mode silently.** If branch already exists, print "Additive mode: extending existing branch" clearly.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PNG decode/encode | Custom image parser | pngjs | Already installed; battle-tested; handles all RGBA operations needed |
| Vision API auth/retry | Raw fetch loop | @anthropic-ai/sdk | SDK handles auth header, 2023-06-01 version header, streaming, retry |
| GitHub file commit | Custom git operations | GitHub Contents API via raw fetch | Pattern already in codebase; 3 API calls (get SHA, put file, create PR) is all that's needed |
| Hamming distance | Bit-twiddling from scratch | XOR + popcount on dHashFromPixels output | matcher-core.js `dHashFromPixels` returns `Uint8Array(64)`; XOR and sum gives Hamming distance |
| Video download | Custom YouTube scraper | yt-dlp | yt-dlp handles auth, format selection, throttling, DASH manifests |
| Frame extraction | Custom video decoder | ffmpeg with `select` filter | ffmpeg handles all codec variants; `select` filter is standard and tested |

**Key insight:** Every hard part of this pipeline has an established tool. The script's job is to orchestrate existing tools, not implement them.

---

## Common Pitfalls

### Pitfall 1: Claude Resizes Images Before Returning Bbox Coordinates
**What goes wrong:** Model returns bbox at (x=200, y=100) but the frame was downscaled from 1920px to 1568px before processing. Applied directly to the 1920x1080 frame, the crop misses the actual item.
**Why it happens:** Claude automatically resizes images larger than 1568px on the long edge before processing. Bboxes are in resized coordinates.
**How to avoid:** Compute the resize ratio before sending. For a 1920x1080 frame: `resizedW = 1568`, `resizedH = Math.round(1568 * 1080/1920) = 882`. Apply `bbox.x *= 1920/1568`, etc. before cropping.
**Warning signs:** Crops that are visually offset from the actual item; crops that capture border/background instead of the icon.

[CITED: https://platform.claude.com/docs/en/docs/build-with-claude/vision — "coordinates will be expressed with respect to the resized/padded image"]

### Pitfall 2: ffmpeg select Filter Comma Escaping
**What goes wrong:** `select='gt(scene,0.3)'` — the comma inside the expression makes ffmpeg parse it as two separate filter arguments, producing a "No such filter: gt(scene" error.
**Why it happens:** ffmpeg filter expressions use comma as chain separator; commas inside expressions must be escaped.
**How to avoid:** Use `select='gt(scene\\,0.3)'` (backslash-escaped comma). In a Node.js spawn arg string: `"select='gt(scene\\\\,0.3)'"` or use ffmpeg's semicolon notation with `-filter_complex`.
**Warning signs:** `Error while opening encoder for output stream` or `Invalid option` on the ffmpeg command.

[VERIFIED: tested locally against ffmpeg 4.3.1]

### Pitfall 3: NCC Self-Validation Always Returns 1.0
**What goes wrong:** Calling `nccScoreAt(cropGray, cropW, sat, sat2, 0, 0, refNCC, cropW, cropH)` where cropGray IS the same data as refNCC — always returns 1.0 regardless of crop quality.
**Why it happens:** NCC of a signal with itself is mathematically 1.0 by definition.
**How to avoid:** The scene for NCC validation must be the **full frame**, not the crop. Position `(bboxX, bboxY)` in the full frame is the correct call.
**Warning signs:** All crops report NCC = 1.0 during validation.

[VERIFIED: matcher-core.js source code read; `nccScoreAt` signature confirmed]

### Pitfall 4: yt-dlp Not in PATH on Windows
**What goes wrong:** `spawnSync('yt-dlp', ...)` returns `ENOENT` even though yt-dlp is installed.
**Why it happens:** WinGet installs yt-dlp to `%LOCALAPPDATA%\Microsoft\WinGet\Packages\yt-dlp.yt-dlp...\yt-dlp.exe` which is not on the default PATH in bash/node.
**How to avoid:** `findYtDlp()` helper checks: (1) `which yt-dlp` / `where yt-dlp`, (2) known WinGet path, (3) `%APPDATA%\Python\Scripts\yt-dlp.exe`. Fail with: "yt-dlp not found. Install: winget install yt-dlp".
**Warning signs:** `spawnSync` returns `status: null, signal: null, error: { code: 'ENOENT' }`.

[VERIFIED: local environment check — yt-dlp at WinGet path `C:\Users\spick\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.yt-dlp...\yt-dlp.exe`]

### Pitfall 5: Branch Already Exists on Second Video Run
**What goes wrong:** `POST /git/refs` fails with 422 "Reference already exists" when running the tool against a second video for the same game+profile on the same date.
**Why it happens:** Branch name is `ai/{game-id}-{profile-id}-{YYYY-MM-DD}` — collision if re-run on same day.
**How to avoid:** Before creating: `GET /git/refs/heads/{branch}` — if it exists (200), switch to additive mode (load existing profile.json from branch, merge new triggers). If 404, create fresh branch.
**Warning signs:** 422 error from GitHub API on branch creation.

[VERIFIED: GitHub API — creating an existing ref returns 422 Unprocessable Entity]

### Pitfall 6: Vision Model Returns Malformed JSON
**What goes wrong:** Model returns prose around the JSON, or uses single quotes, or adds trailing commas — `JSON.parse` throws.
**Why it happens:** Despite explicit "return ONLY valid JSON" instructions, models occasionally add caveats or markdown code fences.
**How to avoid:** Wrap parse in try/catch. Use regex extraction: `const match = response.match(/\[[\s\S]*\]/); if (match) JSON.parse(match[0])`. If extraction fails, treat frame as "no items identified" and continue.
**Warning signs:** `SyntaxError: Unexpected token` on `JSON.parse`.

[ASSUMED — based on common vision API behavior pattern; verify against actual model responses during implementation]

---

## Code Examples

### Hamming Distance Between Two dHash Outputs
```javascript
// Source: derived from matcher-core.js dHashFromPixels return type (Uint8Array(64))
function hammingDistance(hashA, hashB) {
  let dist = 0;
  for (let i = 0; i < 64; i++) {
    if (hashA[i] !== hashB[i]) dist++;
  }
  return dist;
}
```

### Loading Existing Profile.json from Branch (for additive mode)
```javascript
// Source: pattern from workers/submit-trigger/index.js readProfile()
async function loadBranchProfile(gh, gameId, profileId, branch) {
  try {
    const file = await gh(
      `repos/${OWNER}/${REPO}/contents/games/${gameId}/profiles/${profileId}/profile.json?ref=${branch}`,
      'GET'
    );
    const content = Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return { profile: JSON.parse(content), sha: file.sha };
  } catch (err) {
    if (err.message.includes('404')) return null; // branch or file doesn't exist
    throw err;
  }
}
```

### Trigger ID Generation (consistent with worker)
```javascript
// Source: workers/submit-trigger/index.js addTrigger() — keep IDs consistent
function makeTriggerRawId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
// Do NOT append timestamp for AI-generated triggers — use stable name-based IDs
// so additive runs deduplicate by ID correctly.
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| jsDelivr CDN for profile serving | raw.githubusercontent.com (ensureRawUrl) | v0.9.x | Branch URLs work immediately; CDN has 24h lag |
| `twitchSlug` in catalog | `legacyTwitchSlug` | Phase 3 | Backward compat rename; scripts must use `legacyTwitchSlug` when writing catalog entries |
| canvas for Node.js pixel ops | pngjs (pure JS) | test-matching-node.js | All matching test scripts use pngjs; canvas not needed |

**Deprecated/outdated:**
- jsDelivr URLs in new profile entries: `ensureRawUrl()` converts them, but write raw.githubusercontent.com directly from scripts.
- `twitchSlug` field name: still accepted as fallback by popup.js but write `legacyTwitchSlug` in new entries.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Vision model returns bbox in resized coordinate space (1568px cap) | Pitfall 1 + Pattern 1 | If bbox is in original coordinates, rescaling code would corrupt crops. Verify against first real run. |
| A2 | Model will return malformed JSON occasionally despite instructions | Pitfall 6 | If model is perfectly reliable, defensive parsing is unnecessary but harmless overhead. |
| A3 | NCC self-check of a crop against the full frame at the same position reliably distinguishes coherent crops from noise at threshold 0.65 | Pattern 3 | Threshold may need tuning for small icons vs backgrounds. Can adjust after first real run. |
| A4 | Fandom/wiki pages for common games have parseable item lists accessible via unauthenticated fetch | Wiki Grounding section | Some wikis may require JavaScript rendering or have bot protection. May need fallback to manual item list input. |
| A5 | ANTHROPIC_API_KEY is available in the user's shell environment when running the CLI (or set via .env) | Pattern 1 | Script must fail fast with clear instructions if absent — confirmed key is NOT in current bash session |

---

## Open Questions

1. **Wiki scraping approach for arbitrary games**
   - What we know: Fandom wikis are common; `fetch()` works for most; some have Cloudflare protection
   - What's unclear: Whether a generic `fetchWikiItems(gameId)` can handle the variety, or whether game-specific parsers are needed
   - Recommendation: Start with a manual `--wiki-url` flag + generic HTML text extraction; add game-specific parsers only when needed

2. **Vision model accuracy on small game UI elements (sub-40px)**
   - What we know: Bboxes will be imprecise for very small items; NCC will flag them with low confidence
   - What's unclear: Whether the soft gate (⚠) produces useful-enough data for manual correction or just noise
   - Recommendation: Run against one real VOD first; evaluate ⚠ output before deciding on minimum item size filtering

3. **GITHUB_TOKEN scope for the CLI script**
   - What we know: The Worker uses its own GITHUB_TOKEN stored as a Wrangler secret; the CLI needs its own token
   - What's unclear: Whether to use the same PAT or a separate developer token
   - Recommendation: Read `GITHUB_TOKEN` from environment; document in README that it needs `contents:write` + `pull-requests:write` scopes

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| yt-dlp | AI-01 frame extraction | ✓ (WinGet, not in PATH) | 2026.03.17 | Script must build path explicitly; D-06: prompt with install if not found |
| ffmpeg | AI-01 frame extraction | ✓ (miniconda, in PATH) | 4.3.1 | D-06: prompt with install if not found |
| Node.js | All scripts | ✓ | v22.13.0 | — |
| pngjs | AI-04/AI-05 validation | ✓ (already in node_modules) | 7.0.0 | — |
| @anthropic-ai/sdk | AI-03 vision pass | ✗ (needs install) | 0.96.0 | `npm install @anthropic-ai/sdk` |
| ANTHROPIC_API_KEY | AI-03 vision pass | ✗ (not in current env) | — | User must set in env or pass via --api-key flag |
| GITHUB_TOKEN | AI-06/AI-07 branch+PR | ✗ (not in current env) | — | User must set; document required scopes |
| canvas | AI-05 (optional) | ✓ (prebuilt, installed) | 3.2.3 | Not needed — pngjs handles all required ops |

**Missing dependencies with no fallback:**
- None — all missing items have clear install paths or env var solutions

**Missing dependencies with fallback:**
- yt-dlp: not in PATH but accessible at WinGet path; script must auto-detect or error with instructions
- ANTHROPIC_API_KEY + GITHUB_TOKEN: user environment variables; fail fast with instructions

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js custom test runners (existing pattern: `node tests/*.js`) |
| Config file | No config — scripts use `process.exit(1)` on failure |
| Quick run command | `node tests/rotation-matching.js` (existing; AI-populate tests will follow same pattern) |
| Full suite command | `npm test` (no existing shortcut; add to package.json in Wave 0) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AI-01 | ffmpeg command produces frames from scene changes | unit (mock video) | `node tests/ai-populate/test-extract.js` | ❌ Wave 0 |
| AI-02 | wiki fetch returns structured item list | unit (mock HTTP) | `node tests/ai-populate/test-wiki.js` | ❌ Wave 0 |
| AI-03 | vision pass parses model response + rescales bbox | unit (mock API) | `node tests/ai-populate/test-vision.js` | ❌ Wave 0 |
| AI-04 | NCC validation rejects noise crops, passes coherent crops | unit | `node tests/ai-populate/test-validate.js` | ❌ Wave 0 |
| AI-05 | matcher-core + pngjs integration computes valid NCC | unit | included in test-validate.js | ❌ Wave 0 |
| AI-06 | GitHub branch builder creates branch + writes files (mock) | unit (mock fetch) | `node tests/ai-populate/test-github.js` | ❌ Wave 0 |
| AI-07 | PR creation call (mock) returns html_url | unit (mock fetch) | included in test-github.js | ❌ Wave 0 |
| AI-08 | Popup dev override field: input → session var → message sent | manual | Open popup, paste URL, click Apply, verify toast | manual |
| AI-09 | Dedup: same-name, close hash → skip; same-name, far hash → variant | unit | `node tests/ai-populate/test-dedup.js` | ❌ Wave 0 |
| AI-10 | Summary report contains all required fields | unit | included in end-to-end smoke test | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `node tests/ai-populate/test-validate.js` (fastest — pure logic, no network)
- **Per wave merge:** All 5 test files in tests/ai-populate/
- **Phase gate:** All tests green before final verification

### Wave 0 Gaps
- [ ] `tests/ai-populate/test-extract.js` — covers AI-01; uses a 3-second test video or mocked spawn
- [ ] `tests/ai-populate/test-wiki.js` — covers AI-02; mocks fetch, validates item list schema
- [ ] `tests/ai-populate/test-vision.js` — covers AI-03; mocks Anthropic SDK, validates bbox rescaling
- [ ] `tests/ai-populate/test-validate.js` — covers AI-04/AI-05; uses known PNG fixture from test-captures/
- [ ] `tests/ai-populate/test-github.js` — covers AI-06/AI-07; mocks fetch, validates API call structure
- [ ] `tests/ai-populate/test-dedup.js` — covers AI-09; pure logic, no I/O

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | yes | GITHUB_TOKEN + ANTHROPIC_API_KEY read from env, never hardcoded or logged |
| V5 Input Validation | yes | YouTube URL validated before passing to yt-dlp; bbox coordinates clamped before crop |
| V6 Cryptography | no | — |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| API key logged to summary/console | Information Disclosure | Never include token values in logs; mask with `***` if echoing config |
| Shell injection via YouTube URL | Tampering | Use `spawnSync` with array args (not shell string); never interpolate URL into shell command string |
| Malformed bbox from vision model | Tampering | Clamp: `Math.max(0, Math.min(frameW - 1, bbox.x + bbox.w))` before crop; reject negative-dimension crops |
| Unauthorized branch writes | Spoofing | GITHUB_TOKEN is maintainer-level; document to use a scoped PAT with only `contents:write` + `pull-requests:write` |

---

## Sources

### Primary (HIGH confidence)
- `extension/matcher-core.js` — full source read; NCC, dHash, pngjs integration all verified
- `extension/popup.js` + `extension/popup.html` — full source read; dev override hook point identified
- `workers/submit-trigger/index.js` — full source read; GitHub API pattern extracted
- `test-matching-node.js` — full source read; confirms pngjs-only approach for Node matching
- `https://platform.claude.com/docs/en/docs/build-with-claude/vision` — base64 PNG API format, coordinate rescaling requirement, image size limits

### Secondary (MEDIUM confidence)
- Local environment probing: yt-dlp 2026.03.17 at WinGet path; ffmpeg 4.3.1 at miniconda; Node v22.13.0; pngjs 7.0.0; canvas 3.2.3 (prebuilt, available but not recommended)
- `npm view @anthropic-ai/sdk version` → 0.96.0
- ffmpeg `select` filter confirmed in `ffmpeg -filters` output for local version 4.3.1

### Tertiary (LOW confidence)
- A4: Fandom wiki accessibility via unauthenticated fetch — assumed from general knowledge, not tested
- A2: Vision model JSON reliability — assumed from general model behavior patterns

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified against local environment
- Architecture: HIGH — GitHub API pattern copied from existing production code; vision API verified from official docs
- Pitfalls: HIGH (P1-P5) / MEDIUM (P6) — P1-P5 verified against code/environment; P6 assumed from model behavior

**Research date:** 2026-05-17
**Valid until:** 2026-06-17 (stable stack; Anthropic API format unlikely to change; yt-dlp/ffmpeg minor version drift acceptable)
