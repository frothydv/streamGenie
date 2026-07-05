#!/usr/bin/env node
// Tests for the detection-precision improvements:
//   - occlusion-tolerant block NCC matching
//   - NCC local refinement around near-miss positions
//   - mask-aware NCC (majority-coverage alpha threshold)
//   - dynamic/large capture windows (refs bigger than 160px)
// Run with: node tests/detection-improvements.js

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

const CANONICAL_SIZE = MatcherCore.DEFAULTS.canonicalSize; // 32
const matcher = MatcherCore.createMatcher({ captureSize: 160 });

// ---------------------------------------------------------------------------
// Image synthesis helpers (mirrors rotation-matching.js style)
// ---------------------------------------------------------------------------

function solidPixels(w, h, r, g, b) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  return px;
}

// Distinctive card: horizontal gradient top half, vertical gradient bottom half.
function makeCard(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (y < h / 2) {
        const v = Math.round(40 + (x / w) * 180);
        px[i] = v; px[i+1] = Math.round(v * 0.5); px[i+2] = 20;
      } else {
        const v = Math.round(220 - ((y - h/2) / (h/2)) * 180);
        px[i] = 20; px[i+1] = Math.round(v * 0.7); px[i+2] = v;
      }
      px[i + 3] = 255;
    }
  }
  return px;
}

// Gradient card with seeded per-pixel noise on top. Pure gradients (and even
// periodic textures) produce a dist-0 plateau — several window positions hash
// identically because dHash never samples the outer edge pixels — which is a
// synthetic degeneracy; real triggers have aperiodic texture. Use this
// wherever a test asserts exact positions or occlusion behavior.
function makeTexturedCard(w, h, seed = 99) {
  const px = makeCard(w, h);
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < px.length; i += 4) {
    const d = Math.round((rand() - 0.5) * 60);
    px[i]   = Math.max(0, Math.min(255, px[i] + d));
    px[i+1] = Math.max(0, Math.min(255, px[i+1] + d));
    px[i+2] = Math.max(0, Math.min(255, px[i+2] + d));
  }
  return px;
}

// A structurally different card: checkerboard tiles.
function makeCheckerCard(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      const v = on ? 230 : 30;
      px[i] = v; px[i+1] = v; px[i+2] = v; px[i+3] = 255;
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

// Invert an axis-aligned rect of the scene — a maximally hostile occluder
// (high variance, negatively correlated with the ref underneath).
function invertRect(scene, sceneSize, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * sceneSize + x) * 4;
      scene[i] = 255 - scene[i];
      scene[i+1] = 255 - scene[i+1];
      scene[i+2] = 255 - scene[i+2];
    }
  }
}

// Seeded LCG noise fill.
function fillNoise(px, seed) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.floor(rand() * 256);
    px[i+1] = Math.floor(rand() * 256);
    px[i+2] = Math.floor(rand() * 256);
    px[i+3] = 255;
  }
  return px;
}

// Nearest-neighbour canonicalization — same floor mapping rehashRef's
// smoothing-off draw produces.
function canonicalize(px, w, h) {
  const out = new Uint8Array(CANONICAL_SIZE * CANONICAL_SIZE * 4);
  for (let y = 0; y < CANONICAL_SIZE; y++) {
    for (let x = 0; x < CANONICAL_SIZE; x++) {
      const sx = Math.floor((x * w) / CANONICAL_SIZE);
      const sy = Math.floor((y * h) / CANONICAL_SIZE);
      const si = (sy * w + sx) * 4;
      const di = (y * CANONICAL_SIZE + x) * 4;
      out[di] = px[si]; out[di+1] = px[si+1]; out[di+2] = px[si+2]; out[di+3] = px[si+3];
    }
  }
  return out;
}

// Area-average mask canonicalization — mirrors the smoothing-on mask draw in
// rehashRef: each canonical mask pixel is the mean alpha of its source cell.
function canonicalizeMask(maskPx, w, h) {
  const out = new Uint8Array(CANONICAL_SIZE * CANONICAL_SIZE * 4);
  for (let y = 0; y < CANONICAL_SIZE; y++) {
    for (let x = 0; x < CANONICAL_SIZE; x++) {
      const sx0 = Math.floor((x * w) / CANONICAL_SIZE), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / CANONICAL_SIZE));
      const sy0 = Math.floor((y * h) / CANONICAL_SIZE), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / CANONICAL_SIZE));
      let sum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) { sum += maskPx[(sy * w + sx) * 4 + 3]; n++; }
      }
      const di = (y * CANONICAL_SIZE + x) * 4;
      out[di] = out[di+1] = out[di+2] = 255;
      out[di+3] = Math.round(sum / n);
    }
  }
  return out;
}

// Build a full production-like ref (hash + verify + NCC stats), like rehashRef.
function makeFullRef(m, nativePx, w, h, maskPx /* native RGBA or null */) {
  const canon = canonicalize(nativePx, w, h);
  const canonMask = maskPx ? canonicalizeMask(maskPx, w, h) : null;
  const hash = m.dHashFromPixels(canon, CANONICAL_SIZE, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
  const maskBits = canonMask ? m.maskBitsFromPixels(canonMask, CANONICAL_SIZE, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE) : null;
  const verify = m.buildVerifyRefFromPixels(canon, canonMask);
  return {
    w, h,
    refHash: hash,
    refBitMask: maskBits ? maskBits.bits : null,
    refValidBits: maskBits ? maskBits.validBits : 64,
    refVerifyValues: verify.values,
    refVerifyMask: verify.mask,
    refVerifyActive: verify.active,
    refNCC: m.buildRefNCC(nativePx, w, h, maskPx),
    rotatedHashes: null,
  };
}

function runMatch(m, ref, scene, sceneSize) {
  const gray = m.fillGrayBuffer(scene);
  const trigger = { id: "t", payloads: [{ title: "T" }], references: [ref] };
  return m.findBestMatch([trigger], scene, gray).best;
}

// ---------------------------------------------------------------------------
// 1. Occlusion-tolerant block matching
// ---------------------------------------------------------------------------

console.log("\n— occlusion-tolerant block matching ---");

const CARD_W = 88, CARD_H = 104;
const CARD = makeTexturedCard(CARD_W, CARD_H);
const CARD_X = 36, CARD_Y = 30;

test("unoccluded card matches at exact position (sanity)", () => {
  const ref = makeFullRef(matcher, CARD, CARD_W, CARD_H, null);
  const best = runMatch(matcher, ref, embedInScene(160, CARD, CARD_W, CARD_H, CARD_X, CARD_Y), 160);
  assert(best && best.matched, "expected a match");
  assert(!best.occluded, "clean match must not be flagged occluded");
  assert(Math.abs(best.x - CARD_X) <= 2 && Math.abs(best.y - CARD_Y) <= 2,
    `position off: got (${best.x},${best.y}), want (${CARD_X},${CARD_Y})`);
});

test("top-left quadrant occluded (inverted content) still matches, flagged occluded", () => {
  const ref = makeFullRef(matcher, CARD, CARD_W, CARD_H, null);
  const scene = embedInScene(160, CARD, CARD_W, CARD_H, CARD_X, CARD_Y);
  invertRect(scene, 160, CARD_X, CARD_Y, Math.floor(CARD_W / 2), Math.floor(CARD_H / 2));
  const best = runMatch(matcher, ref, scene, 160);
  assert(best && best.matched, `expected occluded match (dist=${best && best.dist}, ncc=${best && best.nccScore})`);
  assert(best.occluded === true, "expected occluded flag");
  assert(best.blocks && best.blocks.valid === 16, `expected 16 valid blocks, got ${best.blocks && best.blocks.valid}`);
  assert(best.blocks.passed >= 12, `expected ≥12 passing blocks, got ${best.blocks.passed}`);
  assert(Math.abs(best.x - CARD_X) <= 2 && Math.abs(best.y - CARD_Y) <= 2,
    `position off: got (${best.x},${best.y})`);
});

test("bottom edge strip occluded (solid) still matches", () => {
  const ref = makeFullRef(matcher, CARD, CARD_W, CARD_H, null);
  const scene = embedInScene(160, CARD, CARD_W, CARD_H, CARD_X, CARD_Y);
  // Solid occluder over the bottom quarter — e.g. a tooltip bar.
  const stripH = Math.floor(CARD_H / 4);
  for (let y = CARD_Y + CARD_H - stripH; y < CARD_Y + CARD_H; y++) {
    for (let x = CARD_X; x < CARD_X + CARD_W; x++) {
      const i = (y * 160 + x) * 4;
      scene[i] = 24; scene[i+1] = 24; scene[i+2] = 28;
    }
  }
  const best = runMatch(matcher, ref, scene, 160);
  assert(best && best.matched, `expected match under strip occlusion (dist=${best && best.dist}, ncc=${best && best.nccScore})`);
});

test("majority occlusion (60% covered) does not match", () => {
  const ref = makeFullRef(matcher, CARD, CARD_W, CARD_H, null);
  const scene = embedInScene(160, CARD, CARD_W, CARD_H, CARD_X, CARD_Y);
  invertRect(scene, 160, CARD_X, CARD_Y, Math.floor(CARD_W * 0.6), CARD_H);
  const best = runMatch(matcher, ref, scene, 160);
  assert(!best || !best.matched, "60% occlusion must not fire a match");
});

test("no occlusion false positives on random noise scenes", () => {
  const ref = makeFullRef(matcher, CARD, CARD_W, CARD_H, null);
  for (const seed of [1, 42, 1337, 90210, 424242]) {
    const scene = fillNoise(new Uint8Array(160 * 160 * 4), seed);
    const best = runMatch(matcher, ref, scene, 160);
    assert(!best || !best.matched, `noise seed ${seed} produced a false match`);
  }
});

test("structurally different card does not match (occlusion path stays closed)", () => {
  const ref = makeFullRef(matcher, CARD, CARD_W, CARD_H, null);
  const other = makeCheckerCard(CARD_W, CARD_H);
  const best = runMatch(matcher, ref, embedInScene(160, other, CARD_W, CARD_H, CARD_X, CARD_Y), 160);
  assert(!best || !best.matched, "different card must not match");
});

// ---------------------------------------------------------------------------
// 2. NCC local refinement
// ---------------------------------------------------------------------------

console.log("\n— NCC local refinement ---");

test("refineNCC recovers exact position from a 2px-off start", () => {
  const scene = embedInScene(160, CARD, CARD_W, CARD_H, 35, 47);
  const gray = matcher.fillGrayBuffer(scene);
  const { sat, sat2 } = matcher.buildSAT(gray, 160, 160);
  const refNCC = matcher.buildRefNCC(CARD, CARD_W, CARD_H, null);
  const off = matcher.nccScoreAt(gray, 160, sat, sat2, 37, 49, refNCC, CARD_W, CARD_H);
  const refined = matcher.refineNCC(gray, sat, sat2, refNCC, CARD_W, CARD_H, 37, 49, off, 2);
  assert(refined.x === 35 && refined.y === 47, `expected (35,47), got (${refined.x},${refined.y})`);
  assert(refined.score > off, "refined score should improve");
  assert(refined.score > 0.99, `expected near-perfect NCC at true position, got ${refined.score}`);
});

test("refineNCC respects capture bounds", () => {
  const scene = embedInScene(160, CARD, CARD_W, CARD_H, 0, 0);
  const gray = matcher.fillGrayBuffer(scene);
  const { sat, sat2 } = matcher.buildSAT(gray, 160, 160);
  const refNCC = matcher.buildRefNCC(CARD, CARD_W, CARD_H, null);
  const base = matcher.nccScoreAt(gray, 160, sat, sat2, 1, 1, refNCC, CARD_W, CARD_H);
  const refined = matcher.refineNCC(gray, sat, sat2, refNCC, CARD_W, CARD_H, 1, 1, base, 2);
  assert(refined.x === 0 && refined.y === 0, `expected (0,0), got (${refined.x},${refined.y})`);
});

// ---------------------------------------------------------------------------
// 3. Mask handling
// ---------------------------------------------------------------------------

console.log("\n— mask handling ---");

// Circular mask over a square card: only the disc counts as the trigger.
function makeCircleMask(w, h, radius) {
  const px = new Uint8Array(w * h * 4);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const on = (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
      px[i] = px[i+1] = px[i+2] = 255;
      px[i+3] = on ? 255 : 0;
    }
  }
  return px;
}

const MCARD_W = 64, MCARD_H = 64;
const MCARD = makeCard(MCARD_W, MCARD_H);
const MMASK = makeCircleMask(MCARD_W, MCARD_H, 28);

test("masked ref matches when unmasked corners differ from capture-time background", () => {
  const maskedRef = makeFullRef(matcher, MCARD, MCARD_W, MCARD_H, MMASK);
  assert(maskedRef.refValidBits < 64 && maskedRef.refValidBits >= 16,
    `mask should exclude some bits but keep enough (got ${maskedRef.refValidBits})`);
  // Scene: card embedded, but everything OUTSIDE the mask disc replaced with noise —
  // simulates the trigger appearing over a different background than at capture time.
  const scene = embedInScene(160, MCARD, MCARD_W, MCARD_H, 50, 44);
  let s = 7;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const cx = 50 + MCARD_W / 2, cy = 44 + MCARD_H / 2;
  for (let y = 44; y < 44 + MCARD_H; y++) {
    for (let x = 50; x < 50 + MCARD_W; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > 28 * 28) {
        const i = (y * 160 + x) * 4;
        scene[i] = Math.floor(rand() * 256);
        scene[i+1] = Math.floor(rand() * 256);
        scene[i+2] = Math.floor(rand() * 256);
      }
    }
  }
  const best = runMatch(matcher, maskedRef, scene, 160);
  assert(best && best.matched, `masked ref should match (dist=${best && best.dist}/${best && best.validBits}, ncc=${best && best.nccScore})`);
});

test("buildRefNCC alpha threshold: feathered (sub-majority) mask pixels are excluded", () => {
  const feathered = new Uint8Array(MMASK);
  for (let i = 0; i < feathered.length; i += 4) {
    if (feathered[i + 3] === 0) feathered[i + 3] = 100; // below the ≥128 majority bar
  }
  const refNCC = matcher.buildRefNCC(MCARD, MCARD_W, MCARD_H, feathered);
  assert(refNCC.activeIndices, "expected a masked refNCC");
  assert(refNCC.activeIndices.length < MCARD_W * MCARD_H,
    "alpha-100 pixels must not count as active");
  assert(refNCC.blocks && refNCC.blocks.length === matcher.config.blockGrid ** 2,
    "masked refNCC should still carry block stats");
});

test("masked ref survives occlusion of an unmasked-adjacent region", () => {
  const maskedRef = makeFullRef(matcher, MCARD, MCARD_W, MCARD_H, MMASK);
  const scene = embedInScene(160, MCARD, MCARD_W, MCARD_H, 50, 44);
  // Occlude the top ~22% of the disc.
  invertRect(scene, 160, 50, 44, MCARD_W, 14);
  const best = runMatch(matcher, maskedRef, scene, 160);
  assert(best && best.matched, `expected masked+occluded match (dist=${best && best.dist}/${best && best.validBits}, ncc=${best && best.nccScore})`);
});

// ---------------------------------------------------------------------------
// 4. Large capture windows / large refs
// ---------------------------------------------------------------------------

console.log("\n— large capture windows ---");

test("220×140 ref matches in a 320px capture window", () => {
  const m320 = MatcherCore.createMatcher({ captureSize: 320 });
  const bigW = 220, bigH = 140;
  const big = makeTexturedCard(bigW, bigH);
  const ref = makeFullRef(m320, big, bigW, bigH, null);
  const scene = embedInScene(320, big, bigW, bigH, 40, 60);
  const best = runMatch(m320, ref, scene, 320);
  assert(best && best.matched, `expected match (dist=${best && best.dist}, ncc=${best && best.nccScore})`);
  assert(Math.abs(best.x - 40) <= 2 && Math.abs(best.y - 60) <= 2,
    `position off: got (${best.x},${best.y}), want (40,60)`);
});

test("occlusion pass works at 320px too", () => {
  const m320 = MatcherCore.createMatcher({ captureSize: 320 });
  const bigW = 220, bigH = 140;
  const big = makeTexturedCard(bigW, bigH);
  const ref = makeFullRef(m320, big, bigW, bigH, null);
  const scene = embedInScene(320, big, bigW, bigH, 40, 60);
  invertRect(scene, 320, 40, 60, Math.floor(bigW / 2), Math.floor(bigH / 2));
  const best = runMatch(m320, ref, scene, 320);
  assert(best && best.matched, `expected occluded match at 320 (dist=${best && best.dist}, ncc=${best && best.nccScore})`);
});

test("ref larger than the capture window fails gracefully (no crash, no match)", () => {
  const ref = makeFullRef(matcher, makeCard(220, 140), 220, 140, null);
  const scene = solidPixels(160, 160, 100, 100, 100);
  const best = runMatch(matcher, ref, scene, 160);
  assert(!best || !best.matched, "oversized ref must not match in a small window");
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
