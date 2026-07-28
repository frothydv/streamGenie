# AI-Populate Methodology — Empirical Findings

Captured from the Guildrun relic proof-of-concept (2026-07-28). These findings
drove the pipeline design in `scripts/ai-populate/`.

## Core insight: wiki text + game icons, matched by ID

The wiki (guildrunwiki.com) has **zero images** but perfect structured text
(name, description, rarity, stable ID like `Relic_504`). The game install
(Unity IL2CPP) has icon sprites named with the **same ID scheme**. Matching is
deterministic — no AI guessing needed. 346/408 wiki relics (84.8%) had a
same-ID sprite; the 62 misses were `Relic_5000+` (demo-build gap).

This inverts the old branch's VOD-first approach (vision model guesses items
from frames). Wiki-first is higher quality and fully deterministic on the
text side.

## Reference image source cascade

Priority order, shared across games:
1. **Game-file icons** (Unity/Unreal/Godot extract) — highest quality, free
   alpha masks. Used for Guildrun.
2. **Wiki/API images** (MediaWiki `image1=`, Scryfall, official card APIs) —
   covers the long tail of Fandom/wiki.gg wikis. Not yet wired.
3. **VOD crops** — universal fallback when neither exists.

## Mask dilation: 4px is the sweet spot

Extracted icons are thin line-art on transparent backgrounds. The raw alpha
mask gives too few valid dHash bits (the 8×8 grid falls in dead margins),
killing localization. Dilating the mask before building the reference recovers
bits without much NCC cost.

| Dilation | Avg validBits | Dead refs | Active pass rate (1080p H.264) |
|----------|---------------|-----------|-------------------------------|
| 0px (raw alpha) | 20 | 7 | 57.2% |
| 2px | 25 | 3 | 63.0% |
| **4px** | **27** | **1** | **69.3%** |

The remaining ~31% fail because their art is too sparse even after dilation —
they ship as ⚠ review-tier (correct popup text, matching needs live testing).

**Proper fix (not yet done):** separate dHash-mask and NCC-mask in
`matcher-core.js` so dHash uses a dilated mask (better localization) while NCC
uses a tight mask (better correlation). Likely pushes coverage to ~85%.

## Hard-edge compositing matches real game UI

When compositing icons into frames for validation, **hard pixel replacement**
(alpha ≥ 128 → overwrite) matches how the game actually renders icons. Alpha
blending the semi-transparent edges into the background tanks NCC, because the
NCC template has pure icon RGB but the blended scene has icon+background mix.
Real game UI draws icons with hard edges over the panel.

## Scale sweep is essential

The same icon appears at 60px (sidebar), 96px (pick list), and 144px (tooltip)
on a 1080p stream. A reference built at one size fails at others without the
scale sweep. Declaring `scale: {min:0.4, max:2.0, step:1.1}` on every trigger
lets Phase-2 re-search the scale-invariant hash at 16 window geometries. In
the 3-icon proof, the 48px placement only matched via the 1.52× scale variant.

## Unmasked refs are a dead end

Filling transparent pixels with white and using all 64 dHash bits (looser
10/64 threshold) gave **1.4% pass rate**. The white margin dominates the hash
and disagrees with whatever background the icon sits on in-stream. Masked
matching with dilation is strictly better.

## Synthetic vs real-frame validation

A synthetic H.264 proxy (random 8×8 block jitter + 3×3 blur) was **too crude**
to model real encoding — positives were inconsistent and the blur-isolation
diagnostic was inconclusive. The composite-into-real-frame-then-ffmpeg-encode
method is the only reliable proxy: it runs the icon through a real codec at
real quality (CRF 23). For final confidence, test against an actual captured
stream frame.

## srcW/srcH must reflect on-screen size, not atlas size

Extracted sprites are 128×128 in the game's texture atlas — NOT 128px on
screen. The extension computes the search window as
`spriteWidth × (videoWidth / srcW)`. Setting `srcW: 1920` made the base
window 128px at 1080p — 2-3× too large for on-screen relic icons (40-70px).
The scale sweep's minimum (0.4×128=51px) barely reached sidebar icons and
missed smaller ones.

**Fix:** set `srcW: 3840, srcH: 2160` so the base window halves to 64px at
1080p (realistic for pick-screen icons). Widen scale to 0.3–2.5×, covering
19–160px — includes sidebar (40px), pick-screen (64px), tooltip (96px).

VOD-crop references don't have this problem because the crop dimensions ARE
the on-screen pixel size. Extracted sprites need the srcW/srcH adjustment
to bridge the atlas-to-screen coordinate gap.

## Resolution floor

At 360p the icons are 20-32px — too small for any matcher (the proof's 360p
run failed across the board). At 1080p they are 60-144px and match reliably.
**1080p is the target** (matches AGENTS.md); sub-720p is out of scope.

## robots.txt / ToS gate

guildrunwiki.com carries `Content-Signal: ai-train=no, use=reference` and
disallows `ClaudeBot`. Using it as reference data for an overlay is arguably
the permitted "reference" tier, not training — but this is a **per-source
human judgment call**, never auto-bypassed. Every new wiki/source gets a
30-second ToS/robots check before the pipeline runs against it.

## Per-game cost model

A new game that uses an already-supported wiki engine + image source + art
style needs **zero new code — just a config entry** (`configs/*.json`). The
per-game work collapses into:
- wiki engine adapter (MediaWiki covers ~80% of games; custom sites need a
  per-site scraper tweak)
- game-engine extractor (Unity/UnityPy done; Unreal/Godot not yet)
- art-style threshold preset (often auto-pickable)

The long tail (weird custom wikis + weird engines) is where one-off adapters
live, and even there ~80% of the pipeline is reused.
