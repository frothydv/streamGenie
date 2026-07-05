# Recognition architecture — where matching goes after templates

The product goal is to compete with "a knowledgeable human sitting next to you
telling you what things are." This document maps that ambition onto concrete
recognition tiers, records which tier the current engine covers, and specifies
how the later tiers arrive **as upgrades to the existing chassis, not a
rewrite**. Written 2026-07 as a design handoff; nothing in tiers 3–4 is built.

## The four tiers

| Tier | Content | Example | Technique | Status |
|---|---|---|---|---|
| 1 | Rigid UI art | card in hand, relic icon, map button | dHash + NCC template matching | ✅ shipped (M1–M9) |
| 2 | Rigid art under transform | zoomed / rotated / partially covered / larger than 160px | rotation sweep (M8), occlusion blocks (M10), scale sweep + dynamic window (M11) | ✅ shipped |
| 3 | Same object, different renders | animated sprite, 3D relic spinning, foil/damaged variants | multi-reference triggers today; short-clip references or embeddings later | ⚠️ partial (multi-ref works, authoring UX is manual) |
| 4 | Deformable instance recognition | "which player is Ronaldo while he's running" | learned embeddings + temporal tracking | ❌ future |

Templates cannot reach tier 4 — no amount of extra angles/scales/references
covers pose change, motion blur, and 3D viewpoint. Do not try; the cost is
combinatorial and the benchmark history in CHANGELOG 0.11.0 shows the budget
is already carefully spent.

## Why the current chassis survives the jump

Three architectural decisions made for other reasons turn out to be exactly
what a learned recognizer needs:

1. **Hover-scoping.** Tier-4 systems die on full-frame detection cost. We only
   ever need to classify ONE crop per hover event (~10Hz). A small embedding
   model on a 224×224 crop via WebGPU (ONNX Runtime Web / Transformers.js) runs
   in tens of milliseconds on 2026 consumer hardware — viewer-side, no server.
2. **Community profiles.** An embedding recognizer needs labeled examples per
   game. That is precisely what the contribution flow already collects — a
   labeled crop with payload text. The capture → editor → worker → PR pipeline
   is recognition-method agnostic.
3. **Trigger/payload separation.** A trigger is "recognizer config + payloads."
   Today the config is pixel references; nothing downstream (popups, editor
   payloads, moderation) cares how recognition happened.

## Tier 3–4 design sketch

### Schema evolution (backwards compatible)

A reference gains an optional `kind` field; absent = `"template"` (current
behavior, forever). New kinds are additive:

```json
{
  "id": "ronaldo",
  "payloads": [{ "title": "Cristiano Ronaldo", "text": "..." }],
  "references": [
    { "kind": "embedding", "model": "sg-embed-v1", "vector": "<b64 f16[256]>",
      "sources": ["ron-1.png", "ron-2.png", "ron-3.png"] }
  ]
}
```

- `model` names a versioned embedding model shipped as an extension asset (or
  lazily fetched, cached in `chrome.storage`). Version bumps invalidate vectors;
  the worker can re-embed from `sources` server-side if needed.
- Multiple example crops → one averaged vector (or a small set; k-NN with
  cosine distance). Contributors add examples the same way they add refs today.

### Matching pipeline evolution

`findBestMatch` becomes a dispatcher over recognizer kinds:

1. Template refs run exactly the current pipeline (Phase 1 → Phase 2).
2. Embedding refs: embed the hover crop once (shared across all embedding
   triggers — mirror of the shared SAT), then cosine-score against every
   trigger vector. Thresholds calibrated per model version; ship with a
   validation set in the profiles repo.
3. Temporal tracking (helps both kinds): once matched, track the region across
   frames (NCC against last frame's patch at ±small offsets is enough — the
   pieces already exist in matcher-core) instead of re-matching from scratch.
   This is what makes "recognize it while it moves" feel human, and it is also
   a perf win. Build this BEFORE embeddings; it is small and self-contained.

### What to prototype first (in order)

1. **Temporal tracking** (tier 2.5) — pure matcher-core work, no model, no new
   infra. Success metric: popup stays anchored on a dragged/scrolled card.
2. **Offline embedding feasibility** — Node script: embed the STS2 reference
   set + distractor crops with an off-the-shelf small vision model (e.g.
   MobileNet/CLIP-tiny class), measure separation. Decides model choice before
   any extension work.
3. **In-extension inference spike** — ONNX Runtime Web + WebGPU on one hover
   crop; measure latency on mid-range hardware. Gate: p95 < 50ms.
4. **Schema + worker support** for `kind: "embedding"` (validation mirrors
   `normalisedScale` — clamp sizes, verify base64 length against model dims).

### Non-goals

- Full-frame object detection, YOLO-style. Hover-scoping is the product.
- Server-side inference. Viewer-side-only is a privacy commitment already made
  in the store listing and first-run disclosure.
- Replacing templates. For rigid UI art they are faster, exact, and free;
  embeddings are the fallback for content templates cannot hold.
