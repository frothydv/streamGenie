#!/usr/bin/env node
// Tests for scale-aware matching and cursor-bounded search:
//   - scalesForSchema / scalePixels helpers
//   - Phase 2 scale sweep (same hash, scaled geometry + NCC)
//   - cursor-centered search bounds semantics
// Run with: node tests/scale-matching.js

const MatcherCore = require("../extension/matcher-core.js");

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`); passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`); failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

const CANONICAL_SIZE = MatcherCore.DEFAULTS.canonicalSize;
const matcher = MatcherCore.createMatcher({ captureSize: 160 });

// ---------------------------------------------------------------------------
// Synthesis helpers (mirrors detection-improvements.js)
// ---------------------------------------------------------------------------

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function solidPixels(w, h, r, g, b) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i*4] = r; px[i*4+1] = g; px[i*4+2] = b; px[i*4+3] = 255;
  }
  return px;
}

// "Art" card: muted background + seeded solid shapes. Two properties matter
// for scale tests, and per-pixel noise has neither:
//  - structure survives resampling (shapes are still shapes at 0.8× or 1.3×),
//  - different seeds produce genuinely different content (a full-card gradient
//    would dominate variance and let ANY same-layout card cross the global
//    NCC threshold — that's a property of degenerate synthetic art, not of
//    real card art).
function makeArtCard(w, h, seed = 99) {
  const px = new Uint8Array(w * h * 4);
  const rand = lcg(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = 50 + Math.round((y / h) * 40); // mild vertical shading
      px[i] = v; px[i+1] = v; px[i+2] = v + 10; px[i+3] = 255;
    }
  }
  for (let n = 0; n < 9; n++) {
    const cx = Math.floor(rand() * w), cy = Math.floor(rand() * h);
    const rad = Math.floor((0.08 + rand() * 0.14) * Math.min(w, h));
    const r = Math.floor(rand() * 256), g = Math.floor(rand() * 256), b = Math.floor(rand() * 256);
    const circle = rand() > 0.5;
    for (let y = Math.max(0, cy - rad); y < Math.min(h, cy + rad); y++) {
      for (let x = Math.max(0, cx - rad); x < Math.min(w, cx + rad); x++) {
        if (circle && (x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue;
        const i = (y * w + x) * 4;
        px[i] = r; px[i+1] = g; px[i+2] = b;
      }
    }
  }
  return px;
}

function embedInScene(sceneSize, cardPixels, cardW, cardH, tx, ty, bg = 100) {
  const scene = solidPixels(sceneSize, sceneSize, bg, bg, bg);
  for (let y = 0; y < cardH; y++) {
    for (let x = 0; x < cardW; x++) {
      if (ty + y >= sceneSize || tx + x >= sceneSize) continue;
      const si = ((ty + y) * sceneSize + (tx + x)) * 4;
      const ci = (y * cardW + x) * 4;
      scene[si] = cardPixels[ci]; scene[si+1] = cardPixels[ci+1];
      scene[si+2] = cardPixels[ci+2]; scene[si+3] = 255;
    }
  }
  return scene;
}

function canonicalize(px, w, h) {
  const out = new Uint8Array(CANONICAL_SIZE * CANONICAL_SIZE * 4);
  for (let y = 0; y < CANONICAL_SIZE; y++) {
    for (let x = 0; x < CANONICAL_SIZE; x++) {
      const sx = Math.floor((x * w) / CANONICAL_SIZE);
      const sy = Math.floor((y * h) / CANONICAL_SIZE);
      const si = (sy * w + sx) * 4, di = (y * CANONICAL_SIZE + x) * 4;
      out[di] = px[si]; out[di+1] = px[si+1]; out[di+2] = px[si+2]; out[di+3] = 255;
    }
  }
  return out;
}

// Build a ref with scale support the way content.js rehashRef does: same hash
// shared across variants, per-variant dims + NCC stats from resampled pixels.
function makeScalableRef(m, nativePx, w, h, scaleSchema) {
  const canon = canonicalize(nativePx, w, h);
  const hash = m.dHashFromPixels(canon, CANONICAL_SIZE, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
  const verify = m.buildVerifyRefFromPixels(canon, null);
  const ref = {
    w, h,
    refHash: hash,
    refBitMask: null, refValidBits: 64,
    refVerifyValues: verify.values, refVerifyMask: verify.mask, refVerifyActive: verify.active,
    refNCC: m.buildRefNCC(nativePx, w, h, null),
    rotatedHashes: null,
    scaledRefs: null,
  };
  const factors = m.scalesForSchema(scaleSchema);
  if (factors) {
    ref.scaledRefs = factors.map((s) => {
      const sw = Math.round(w * s), sh = Math.round(h * s);
      const spx = m.scalePixels(nativePx, w, h, sw, sh);
      return {
        scale: s, w: sw, h: sh,
        refHash: hash, refBitMask: null, refValidBits: 64,
        refNCC: m.buildRefNCC(spx, sw, sh, null),
      };
    });
  }
  return ref;
}

function runMatch(m, ref, scene, cursor) {
  const gray = m.fillGrayBuffer(scene);
  const trigger = { id: "t", payloads: [{ title: "T" }], references: [ref] };
  const opts = cursor ? { cursorX: cursor.x, cursorY: cursor.y } : undefined;
  return m.findBestMatch([trigger], scene, gray, opts).best;
}

// ---------------------------------------------------------------------------
// 1. Schema and resampling helpers
// ---------------------------------------------------------------------------

console.log("\n— scale schema / helpers ---");

test("scalesForSchema defaults cover 0.75×–1.5× and exclude ~1.0", () => {
  const s = MatcherCore.scalesForSchema({});
  assert(Array.isArray(s) && s.length >= 5, `expected several factors, got ${JSON.stringify(s)}`);
  assert(s[0] >= 0.74 && s[s.length - 1] <= 1.51, `range out of bounds: ${JSON.stringify(s)}`);
  assert(s.every((f) => Math.abs(f - 1) >= 0.04), "factors within 4% of 1 must be excluded");
});

test("scalesForSchema: null/none disable, true gives defaults", () => {
  assert(MatcherCore.scalesForSchema(null) === null);
  assert(MatcherCore.scalesForSchema({ mode: "none" }) === null);
  const t = MatcherCore.scalesForSchema(true);
  assert(Array.isArray(t) && t.length >= 5, "scale:true should give defaults");
});

test("scalesForSchema clamps hostile values", () => {
  const s = MatcherCore.scalesForSchema({ min: 0.0001, max: 999, step: 1.0000001 });
  assert(s.length <= MatcherCore.DEFAULTS.scaleMaxSteps, `unbounded factor list: ${s.length}`);
  assert(s[0] >= 0.25 && s[s.length - 1] <= 4.01, "range must be clamped");
});

test("scalePixels 2× downscale preserves gradient structure", () => {
  // Pure horizontal gradient: downscaled pixel (x) should ≈ source pixel (2x).
  const grad = new Uint8Array(80 * 80 * 4);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
    const i = (y * 80 + x) * 4;
    grad[i] = grad[i+1] = grad[i+2] = x * 3; grad[i+3] = 255;
  }
  const half = MatcherCore.scalePixels(grad, 80, 80, 40, 40);
  for (const x of [5, 15, 25, 35]) {
    const got = half[(20 * 40 + x) * 4];
    const want = (2 * x + 0.5) * 3;
    assert(Math.abs(got - want) <= 4, `resample off at x=${x}: got ${got}, want ~${want}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Scale sweep end-to-end
// ---------------------------------------------------------------------------

console.log("\n— scale sweep matching ---");

const CARD_W = 84, CARD_H = 100;
const CARD = makeArtCard(CARD_W, CARD_H);
const SCHEMA = { min: 0.75, max: 1.5, step: 1.12 };

function sceneWithScaledCard(factor, tx, ty) {
  const sw = Math.round(CARD_W * factor), sh = Math.round(CARD_H * factor);
  const scaled = MatcherCore.scalePixels(CARD, CARD_W, CARD_H, sw, sh);
  return { scene: embedInScene(160, scaled, sw, sh, tx, ty), sw, sh };
}

test("as-captured size still matches via Phase 1 (sanity)", () => {
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, SCHEMA);
  const scene = embedInScene(160, CARD, CARD_W, CARD_H, 38, 30);
  const best = runMatch(matcher, ref, scene, { x: 38 + CARD_W / 2, y: 30 + CARD_H / 2 });
  assert(best && best.matched, "expected Phase 1 match");
  assert((best.scale ?? 1) === 1, `expected scale 1, got ${best.scale}`);
});

test("art rendered at ~1.32× matches with correct scale and dims", () => {
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, SCHEMA);
  const { scene, sw, sh } = sceneWithScaledCard(1.322, 20, 15);
  const best = runMatch(matcher, ref, scene, { x: 20 + sw / 2, y: 15 + sh / 2 });
  assert(best && best.matched, `expected scale match (dist=${best && best.dist}, ncc=${best && best.nccScore})`);
  assert(Math.abs(best.scale - 1.322) < 0.08, `wrong scale: ${best.scale}`);
  assert(Math.abs(best.matchW - sw) <= 3 && Math.abs(best.matchH - sh) <= 3,
    `wrong dims: ${best.matchW}×${best.matchH}, want ${sw}×${sh}`);
  assert(Math.abs(best.x - 20) <= 3 && Math.abs(best.y - 15) <= 3,
    `position off: (${best.x},${best.y})`);
});

test("art rendered at ~0.84× is still detected (Phase 1 scale tolerance)", () => {
  // Mild downscales sit inside the canonical hash's natural tolerance: the
  // base window covers the smaller render plus background margin and still
  // hashes close. The trigger fires — possibly at scale 1 with a slightly
  // loose anchor — which is the desired user-facing behavior.
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, SCHEMA);
  const { scene, sw, sh } = sceneWithScaledCard(0.84, 50, 40);
  const best = runMatch(matcher, ref, scene, { x: 50 + sw / 2, y: 40 + sh / 2 });
  assert(best && best.matched, `expected detection (dist=${best && best.dist}, ncc=${best && best.nccScore})`);
});

test("art rendered at ~0.56× (beyond Phase 1 tolerance) matches via sweep", () => {
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, { min: 0.5, max: 1.5, step: 1.12 });
  const { scene, sw, sh } = sceneWithScaledCard(0.56, 60, 50);
  const best = runMatch(matcher, ref, scene, { x: 60 + sw / 2, y: 50 + sh / 2 });
  assert(best && best.matched, `expected scale match (dist=${best && best.dist}, ncc=${best && best.nccScore})`);
  assert(best.scale < 0.7, `expected a downscale factor, got ${best.scale}`);
  assert(Math.abs(best.matchW - sw) <= 6 && Math.abs(best.matchH - sh) <= 6,
    `wrong dims: ${best.matchW}×${best.matchH}, want ${sw}×${sh}`);
});

test("trigger WITHOUT scale schema misses the 1.32× appearance (documents opt-in)", () => {
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, null);
  const { scene, sw, sh } = sceneWithScaledCard(1.322, 20, 15);
  const best = runMatch(matcher, ref, scene, { x: 20 + sw / 2, y: 15 + sh / 2 });
  assert(!best || !best.matched, "scale matching must be opt-in");
});

test("different card at 1.32× does not false-positive through the sweep", () => {
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, SCHEMA);
  const other = makeArtCard(CARD_W, CARD_H, 777);
  const sw = Math.round(CARD_W * 1.322), sh = Math.round(CARD_H * 1.322);
  const scaled = MatcherCore.scalePixels(other, CARD_W, CARD_H, sw, sh);
  const scene = embedInScene(160, scaled, sw, sh, 20, 15);
  const best = runMatch(matcher, ref, scene, { x: 20 + sw / 2, y: 15 + sh / 2 });
  assert(!best || !best.matched, "different card must not match via scale sweep");
});

test("no false positives on noise scenes with scale enabled", () => {
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, SCHEMA);
  for (const seed of [3, 44, 2024]) {
    const noise = new Uint8Array(160 * 160 * 4);
    const rand = lcg(seed);
    for (let i = 0; i < noise.length; i += 4) {
      noise[i] = rand() * 256; noise[i+1] = rand() * 256; noise[i+2] = rand() * 256; noise[i+3] = 255;
    }
    const best = runMatch(matcher, ref, noise, { x: 80, y: 80 });
    assert(!best || !best.matched, `noise seed ${seed} matched`);
  }
});

// ---------------------------------------------------------------------------
// 3. Cursor-bounded search semantics
// ---------------------------------------------------------------------------

console.log("\n— cursor-bounded search ---");

test("cursor over the trigger → match; cursor elsewhere → no match", () => {
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, null);
  const scene = embedInScene(160, CARD, CARD_W, CARD_H, 10, 10);
  const over = runMatch(matcher, ref, scene, { x: 10 + CARD_W / 2, y: 10 + CARD_H / 2 });
  assert(over && over.matched, "cursor inside the trigger should match");
  const away = runMatch(matcher, ref, scene, { x: 150, y: 150 });
  assert(!away || !away.matched, "cursor outside the trigger must not match (hover semantics)");
});

test("no cursor → exhaustive search still finds off-center trigger (test back-compat)", () => {
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, null);
  const scene = embedInScene(160, CARD, CARD_W, CARD_H, 10, 10);
  const best = runMatch(matcher, ref, scene, null);
  assert(best && best.matched, "unbounded search should match anywhere");
});

test("cursor near the trigger edge still matches (searchPad slack)", () => {
  const ref = makeScalableRef(matcher, CARD, CARD_W, CARD_H, null);
  const scene = embedInScene(160, CARD, CARD_W, CARD_H, 30, 20);
  const best = runMatch(matcher, ref, scene, { x: 31, y: 21 }); // 1px inside top-left corner
  assert(best && best.matched, "cursor just inside the trigger should match");
});

test("sharp-peaked ref (1px checkerboard) flagged and still matched at any parity", () => {
  // Pixel-art-like content: the hash is unrecognizable 1px off-position, so
  // the stride-2 fallback would miss it on the wrong parity. refPeakSharpness
  // must flag it, and the flagged ref must match at an odd embed position.
  const w = 48, h = 48;
  const px = new Uint8Array(w * h * 4);
  const rand = lcg(31337);
  for (let i = 0; i < w * h; i++) {
    const v = Math.floor(rand() * 256);
    px[i*4] = v; px[i*4+1] = v; px[i*4+2] = 255 - v; px[i*4+3] = 255;
  }
  const ref = makeScalableRef(matcher, px, w, h, null);
  const sharpness = matcher.refPeakSharpness(px, w, h, ref.refHash, null);
  assert(sharpness > matcher.config.sharpPeakBits, `expected sharp peak, sharpness=${sharpness}`);
  ref.sharpPeak = true;
  const scene = embedInScene(160, px, w, h, 37, 41); // odd position — wrong stride-2 parity
  const best = runMatch(matcher, ref, scene, { x: 37 + w / 2, y: 41 + h / 2 });
  assert(best && best.matched, `sharp ref must match at odd position (dist=${best && best.dist})`);
  // Art-like cards must NOT be flagged — they'd pay step-1 cost for nothing.
  const artRef = makeScalableRef(matcher, CARD, CARD_W, CARD_H, null);
  const artScore = matcher.refPeakSharpness(CARD, CARD_W, CARD_H, artRef.refHash, null);
  assert(artScore <= matcher.config.sharpPeakBits, `art card wrongly flagged sharp (${artScore})`);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
