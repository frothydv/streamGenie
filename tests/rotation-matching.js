#!/usr/bin/env node
// Tests for rotation-aware dHash matching.
// Exercises the actual matcher-core.js matching pipeline against synthetically
// rotated images, checks accuracy, false-positive rate, and performance.
// Run with: node tests/rotation-matching.js

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
function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg || "value"}: expected ~${b}, got ${a} (tol ${tol})`);
}

const CAPTURE_SIZE = 160;
const CANONICAL_SIZE = MatcherCore.DEFAULTS.canonicalSize; // 32
const matcher = MatcherCore.createMatcher({ captureSize: CAPTURE_SIZE });

// ---------------------------------------------------------------------------
// Image synthesis helpers
// ---------------------------------------------------------------------------

// Create a w×h RGBA pixel buffer filled with a solid color.
function solidPixels(w, h, r, g, b, a = 255) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = a;
  }
  return px;
}

// Create a distinctive w×h card-like image with a strong horizontal gradient
// in the top half and a vertical gradient in the bottom half. This gives dHash
// a strong signal in both orientations.
function makeCard(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (y < h / 2) {
        // Top half: horizontal gradient dark→light
        const v = Math.round(40 + (x / w) * 180);
        px[i] = v; px[i+1] = Math.round(v * 0.5); px[i+2] = 20;
      } else {
        // Bottom half: vertical gradient light→dark
        const v = Math.round(220 - ((y - h/2) / (h/2)) * 180);
        px[i] = 20; px[i+1] = Math.round(v * 0.7); px[i+2] = v;
      }
      px[i + 3] = 255;
    }
  }
  return px;
}

// Embed a small image (w×h) into a larger CAPTURE_SIZE×CAPTURE_SIZE scene at (tx, ty).
// Returns the scene as RGBA Uint8Array.
function embedInScene(cardPixels, cardW, cardH, tx, ty, bgR = 100, bgG = 100, bgB = 100) {
  const scene = solidPixels(CAPTURE_SIZE, CAPTURE_SIZE, bgR, bgG, bgB);
  for (let y = 0; y < cardH; y++) {
    for (let x = 0; x < cardW; x++) {
      const si = ((ty + y) * CAPTURE_SIZE + (tx + x)) * 4;
      const ci = (y * cardW + x) * 4;
      if (ty + y < CAPTURE_SIZE && tx + x < CAPTURE_SIZE) {
        scene[si] = cardPixels[ci];
        scene[si+1] = cardPixels[ci+1];
        scene[si+2] = cardPixels[ci+2];
        scene[si+3] = 255;
      }
    }
  }
  return scene;
}

// Rotate card pixels by angleDeg and embed in scene at (tx, ty).
function embedRotatedInScene(cardPixels, cardW, cardH, angleDeg, tx, ty) {
  const rotated = MatcherCore.rotatePixels(cardPixels, cardW, cardH, angleDeg);
  return embedInScene(rotated, cardW, cardH, tx, ty);
}

// Build a ref object suitable for evaluateReference from pixel data.
// px must be CANONICAL_SIZE×CANONICAL_SIZE RGBA (like what rehashRef produces).
// nativePx (optional) is the full-resolution image — used for rotation so aspect ratio is preserved.
function makeRef(px, nativeW, nativeH, rotates = false, nativePx = null) {
  const hash = matcher.dHashFromPixels(px, CANONICAL_SIZE, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
  const verify = matcher.buildVerifyRefFromPixels(px, null);
  const rotPx = nativePx || px;
  const rotW  = nativePx ? nativeW : CANONICAL_SIZE;
  const rotH  = nativePx ? nativeH : CANONICAL_SIZE;
  const ref = {
    w: nativeW,
    h: nativeH,
    refHash: hash,
    refBitMask: null,
    refValidBits: 64,
    refVerifyValues: verify.values,
    refVerifyMask: verify.mask,
    refVerifyActive: verify.active,
    rotatedHashes: rotates
      ? matcher.computeRotatedHashes(rotPx, rotW, rotH, matcher.config.rotationAngles)
      : null,
  };
  return ref;
}

// ---------------------------------------------------------------------------
// 1. rotatePixels — correctness
// ---------------------------------------------------------------------------

console.log("\n— rotatePixels correctness ---");

test("0° rotation returns identical pixels", () => {
  const px = makeCard(32, 32);
  const rot = MatcherCore.rotatePixels(px, 32, 32, 0);
  // Center pixels should be identical (edges may differ due to boundary handling)
  let diffs = 0;
  for (let y = 4; y < 28; y++) {
    for (let x = 4; x < 28; x++) {
      const i = (y * 32 + x) * 4;
      if (rot[i] !== px[i] || rot[i+1] !== px[i+1] || rot[i+2] !== px[i+2]) diffs++;
    }
  }
  assert(diffs === 0, `Center pixels changed after 0° rotation: ${diffs} diffs`);
});

test("180° rotation flips image around center", () => {
  const w = 32, h = 32;
  const px = makeCard(w, h);
  const rot = MatcherCore.rotatePixels(px, w, h, 180);
  // Top-left of rotated should approximate bottom-right of original (center pixels)
  const cx = 16, cy = 16; // center
  // Pixel at (4,4) in rotated ≈ pixel at (28,28) in original
  const ri = (4 * w + 4) * 4;
  const oi = (27 * w + 27) * 4;
  // Should be within bilinear interpolation tolerance
  assert(Math.abs(rot[ri] - px[oi]) < 30, `180° flip: R channel mismatch ${rot[ri]} vs ${px[oi]}`);
});

test("90° rotation: pixel (x,y) maps to (h-1-y, x) approximately", () => {
  const w = 32, h = 32;
  // Create a horizontal gradient so we can verify axis flip
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = x * 8; px[i+1] = 0; px[i+2] = 0; px[i+3] = 255;
    }
  }
  const rot = MatcherCore.rotatePixels(px, w, h, 90);
  // After 90° CW: x-axis becomes y-axis. Center column of original → center row of rotated.
  // Original center row (y=16) had x=16 → R=128. After 90° CW, this should appear at (y=16, x=15).
  const ri = (16 * w + 15) * 4;
  assert(rot[ri] > 60 && rot[ri] < 200, `90° rotation: center R=${rot[ri]} out of expected range`);
});

test("rotatePixels output has same dimensions as input", () => {
  const px = makeCard(40, 40);
  const rot = MatcherCore.rotatePixels(px, 40, 40, 15);
  assert(rot.length === 40 * 40 * 4, "output size mismatch");
});

test("rotatePixels alpha channel is set to 255 for in-bounds pixels", () => {
  const px = makeCard(32, 32);
  const rot = MatcherCore.rotatePixels(px, 32, 32, 10);
  // Center pixels should have alpha=255
  for (let y = 8; y < 24; y++) {
    for (let x = 8; x < 24; x++) {
      assert(rot[(y * 32 + x) * 4 + 3] === 255, `alpha not 255 at (${x},${y})`);
      break; // just check one row
    }
  }
});

// ---------------------------------------------------------------------------
// 2. computeRotatedHashes — structure
// ---------------------------------------------------------------------------

console.log("\n— computeRotatedHashes structure ---");

test("returns one hash per angle", () => {
  const px = makeCard(CANONICAL_SIZE, CANONICAL_SIZE);
  const angles = [-15, -10, 10, 15];
  const hashes = matcher.computeRotatedHashes(px, CANONICAL_SIZE, CANONICAL_SIZE, angles);
  assert(hashes.length === 4, `expected 4, got ${hashes.length}`);
  for (const h of hashes) {
    assert(h.hash instanceof Uint8Array, "hash should be Uint8Array");
    assert(h.hash.length === 64, "hash should be 64 bits");
    assert(typeof h.angle === "number", "angle should be number");
  }
});

test("angles are preserved on returned objects", () => {
  const px = makeCard(CANONICAL_SIZE, CANONICAL_SIZE);
  const angles = [-30, -15, 15, 30];
  const hashes = matcher.computeRotatedHashes(px, CANONICAL_SIZE, CANONICAL_SIZE, angles);
  for (let i = 0; i < angles.length; i++) {
    assert(hashes[i].angle === angles[i], `angle mismatch: expected ${angles[i]}, got ${hashes[i].angle}`);
  }
});

test("rotated hashes differ from base hash", () => {
  const px = makeCard(CANONICAL_SIZE, CANONICAL_SIZE);
  const baseHash = matcher.dHashFromPixels(px, CANONICAL_SIZE, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
  const hashes = matcher.computeRotatedHashes(px, CANONICAL_SIZE, CANONICAL_SIZE, [-20, 20]);
  // At least one bit should differ for a 20° rotation of a non-symmetric image
  let anyDiff = false;
  for (const rh of hashes) {
    let diffs = 0;
    for (let i = 0; i < 64; i++) if (rh.hash[i] !== baseHash[i]) diffs++;
    if (diffs > 0) anyDiff = true;
  }
  assert(anyDiff, "rotated hashes should differ from base hash for a non-symmetric image");
});

test("default rotation angles cover ±1°–±30°, no 0° (handled by base hash)", () => {
  const angles = MatcherCore.DEFAULTS.rotationAngles;
  assert(!angles.includes(0), "0° should not be in rotation angles (handled by base hash)");
  assert(Math.min(...angles) === -30, "min angle should be -30");
  assert(Math.max(...angles) === 30, "max angle should be 30");
  assert(angles.includes(1) && angles.includes(-1), "fine angles ±1° should be present");
  assert(angles.includes(5) && angles.includes(-5), "coarse angles ±5° should be present");
});

// ---------------------------------------------------------------------------
// 2b. anglesForRotation
// ---------------------------------------------------------------------------

console.log("\n— anglesForRotation ---");

test("null/false/mode:none returns null", () => {
  assert(MatcherCore.anglesForRotation(null) === null, "null → null");
  assert(MatcherCore.anglesForRotation(false) === null, "false → null");
  assert(MatcherCore.anglesForRotation({ mode: "none" }) === null, "mode:none → null");
});

test("legacy true returns same angles as DEFAULTS.rotationAngles", () => {
  const a = MatcherCore.anglesForRotation(true);
  const b = MatcherCore.DEFAULTS.rotationAngles;
  assert(a.length === b.length, `length mismatch: ${a.length} vs ${b.length}`);
  assert(JSON.stringify(a.slice().sort((x,y)=>x-y)) === JSON.stringify(b.slice().sort((x,y)=>x-y)), "sets differ");
});

test("orthogonal mode returns [90, 180, 270]", () => {
  const a = MatcherCore.anglesForRotation({ mode: "orthogonal" });
  assert(a.length === 3, `expected 3 angles, got ${a.length}`);
  assert(a.includes(90) && a.includes(180) && a.includes(270), "must include 90, 180, 270");
  assert(!a.includes(0), "must not include 0");
});

test("free mode with defaults has no 0° and covers ±30°", () => {
  const a = MatcherCore.anglesForRotation({ mode: "free" });
  assert(!a.includes(0), "0° must be excluded");
  assert(Math.min(...a) <= -30, "must reach -30");
  assert(Math.max(...a) >= 30, "must reach 30");
  assert(a.includes(1) && a.includes(-1), "fine angles ±1° must be present (fineStepNearZero defaults true)");
});

test("free mode with fineStepNearZero:false omits ±1°–±4°", () => {
  const a = MatcherCore.anglesForRotation({ mode: "free", minAngle: -30, maxAngle: 30, step: 5, fineStepNearZero: false });
  assert(!a.includes(1) && !a.includes(-1), "±1° must not be present");
  assert(a.includes(5) && a.includes(-5), "±5° must be present");
});

test("free mode with custom range [0, 30] step 10 has no 0°", () => {
  const a = MatcherCore.anglesForRotation({ mode: "free", minAngle: 0, maxAngle: 30, step: 10, fineStepNearZero: false });
  assert(!a.includes(0), "0° must be excluded even when minAngle=0");
  assert(a.includes(10) && a.includes(20) && a.includes(30), "must include 10, 20, 30");
});

// ---------------------------------------------------------------------------
// 3. Accuracy — rotation-aware matching finds rotated triggers
// ---------------------------------------------------------------------------

console.log("\n— rotation matching accuracy ---");

const CARD_W = 40, CARD_H = 50;
const CARD_PX = makeCard(CARD_W, CARD_H);

// Build a canonical (32×32) version for hashing — simulate what rehashRef does
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

const CARD_CANONICAL = canonicalize(CARD_PX, CARD_W, CARD_H);

// Build a ref with rotation support, using CARD_W×CARD_H native dimensions.
// Passes native pixels for rotation (matches production rehashRef behaviour).
function makeRotatingRef(rotates = true) {
  return makeRef(CARD_CANONICAL, CARD_W, CARD_H, rotates, CARD_PX);
}

test("unrotated card matches at 0° (sanity)", () => {
  const ref = makeRotatingRef(false);
  const scene = embedInScene(CARD_PX, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(result.matched, `0° card should match (ratio=${result.ratio.toFixed(3)}, threshold=${result.threshold.toFixed(3)})`);
  assertClose(result.x, 60, 8, "x position");
  assertClose(result.y, 55, 8, "y position");
});

test("rotation-aware ref matches 15° rotated card", () => {
  const ref = makeRotatingRef(true);
  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, 15);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(result.matched, `15° rotated card should match with rotation-aware ref (ratio=${result.ratio.toFixed(3)}, threshold=${result.threshold.toFixed(3)})`);
});

test("rotation-aware ref matches -20° rotated card", () => {
  const ref = makeRotatingRef(true);
  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, -20);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(result.matched, `-20° rotated card should match with rotation-aware ref (ratio=${result.ratio.toFixed(3)})`);
});

test("rotation-aware ref matches 25° rotated card", () => {
  const ref = makeRotatingRef(true);
  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, 25);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(result.matched, `25° rotated card should match with rotation-aware ref (ratio=${result.ratio.toFixed(3)})`);
});

test("matched angle is reported correctly for 15° rotation", () => {
  const ref = makeRotatingRef(true);
  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, 15);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(result.matched, "should match");
  // Matched angle should be within ±10° of the true rotation (5° step resolution)
  assert(Math.abs(result.angle - 15) <= 10, `reported angle ${result.angle}° should be near 15°`);
});

test("matched angle is 0 for unrotated card", () => {
  const ref = makeRotatingRef(true);
  const scene = embedInScene(CARD_PX, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(result.matched, "should match");
  assert(result.angle === 0, `unrotated card: expected angle=0, got angle=${result.angle}`);
});

test("card placed at different position still found after rotation", () => {
  const ref = makeRotatingRef(true);
  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, -10);
  // Place near edge of capture
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 10, 15);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(result.matched, `-10° card near edge should match (ratio=${result.ratio.toFixed(3)})`);
  assertClose(result.x, 10, 12, "x position");
  assertClose(result.y, 15, 12, "y position");
});

// ---------------------------------------------------------------------------
// 4. False negatives — non-rotation-aware ref misses steeply rotated card
// ---------------------------------------------------------------------------

console.log("\n— false negatives without rotation ---");

test("non-rotation-aware ref misses 25° rotated card", () => {
  const ref = makeRotatingRef(false); // no rotatedHashes
  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, 25);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  // Should NOT match at 25° without rotation support
  assert(!result.matched, `without rotation, 25° card should NOT match (ratio=${result.ratio.toFixed(3)}, threshold=${result.threshold.toFixed(3)})`);
});

test("non-rotation-aware ref misses -20° rotated card", () => {
  const ref = makeRotatingRef(false);
  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, -20);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(!result.matched, `without rotation, -20° card should NOT match (ratio=${result.ratio.toFixed(3)})`);
});

// ---------------------------------------------------------------------------
// 5. False positives — unrelated image doesn't trigger rotation match
// ---------------------------------------------------------------------------

console.log("\n— false positives ---");

test("unrelated solid-color scene doesn't match a rotating ref", () => {
  const ref = makeRotatingRef(true);
  const scene = solidPixels(CAPTURE_SIZE, CAPTURE_SIZE, 200, 30, 80);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(!result.matched, `solid-color scene should not match (ratio=${result.ratio.toFixed(3)})`);
});

test("different card pattern doesn't match via rotation", () => {
  const ref = makeRotatingRef(true);
  // A completely different card: all uniform grey (no gradient)
  const otherCard = solidPixels(CARD_W, CARD_H, 150, 150, 150);
  const scene = embedInScene(otherCard, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const result = matcher.evaluateReference(ref, scene, gray);
  assert(!result.matched, `uniform grey card should not match colored gradient ref (ratio=${result.ratio.toFixed(3)})`);
});

test("high-frequency striped pattern doesn't match gradient card ref at any rotation angle", () => {
  // Alternating bright/dark horizontal stripes — fundamentally different dHash structure
  // from any gradient card.  Each row has alternating 255/0 brightness, so adjacent pixel
  // differences alternate sign rather than monotonically increasing/decreasing as in makeCard.
  const striped = new Uint8Array(CARD_W * CARD_H * 4);
  for (let y = 0; y < CARD_H; y++) {
    const v = (y % 6 < 3) ? 230 : 25; // ~3px stripes
    for (let x = 0; x < CARD_W; x++) {
      const i = (y * CARD_W + x) * 4;
      striped[i] = v; striped[i+1] = v; striped[i+2] = v; striped[i+3] = 255;
    }
  }
  const ref = makeRotatingRef(true);

  let anyMatch = false;
  for (const angle of [0, -15, 15, -25, 25]) {
    const rotStriped = MatcherCore.rotatePixels(striped, CARD_W, CARD_H, angle);
    const scene = embedInScene(rotStriped, CARD_W, CARD_H, 60, 55);
    const gray = matcher.fillGrayBuffer(scene);
    const result = matcher.evaluateReference(ref, scene, gray);
    if (result.matched) anyMatch = true;
  }
  assert(!anyMatch, "striped pattern should not match gradient card ref at any rotation angle");
});

// ---------------------------------------------------------------------------
// 6. findBestMatch integration — rotating trigger found among non-rotating
// ---------------------------------------------------------------------------

console.log("\n— findBestMatch integration ---");

test("findBestMatch finds rotating trigger among non-rotating triggers", () => {
  const rotatingRef = makeRotatingRef(true);

  // Two distinctive static cards with strong gradients perpendicular to the rotating card.
  // Avoid uniform colors — those produce all-zero dHashes that match any background.
  const staticCard1 = new Uint8Array(CARD_W * CARD_H * 4);
  for (let y = 0; y < CARD_H; y++) for (let x = 0; x < CARD_W; x++) {
    const i = (y * CARD_W + x) * 4;
    staticCard1[i] = Math.round(255 * y / CARD_H); staticCard1[i+1] = 0; staticCard1[i+2] = 0; staticCard1[i+3] = 255;
  }
  const staticCard2 = new Uint8Array(CARD_W * CARD_H * 4);
  for (let y = 0; y < CARD_H; y++) for (let x = 0; x < CARD_W; x++) {
    const i = (y * CARD_W + x) * 4;
    staticCard2[i] = 0; staticCard2[i+1] = Math.round(255 * (1 - y / CARD_H)); staticCard2[i+2] = Math.round(255 * x / CARD_W); staticCard2[i+3] = 255;
  }
  const staticRef1 = makeRef(canonicalize(staticCard1, CARD_W, CARD_H), CARD_W, CARD_H, false);
  const staticRef2 = makeRef(canonicalize(staticCard2, CARD_W, CARD_H), CARD_W, CARD_H, false);

  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, 20);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);

  const triggers = [
    { id: "static-1",  payloads: [{ title: "Static 1" }],        references: [staticRef1] },
    { id: "rotating",  payloads: [{ title: "Rotating Card" }],   references: [rotatingRef] },
    { id: "static-2",  payloads: [{ title: "Static 2" }],        references: [staticRef2] },
  ];
  const { best } = matcher.findBestMatch(triggers, scene, gray);
  assert(best && best.matched, `findBestMatch should find a match (got ${best ? 'no-match' : 'null'})`);
  assert(best.trigger.id === "rotating", `expected rotating trigger, got ${best?.trigger?.id}`);
});

test("non-rotating trigger not matched when only rotation of it is present in scene", () => {
  const nonRotRef = makeRef(CARD_CANONICAL, CARD_W, CARD_H, false);
  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, 25);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const triggers = [{ id: "no-rotate", payloads: [{ title: "Static" }], references: [nonRotRef] }];
  const { best } = matcher.findBestMatch(triggers, scene, gray);
  assert(!best || !best.matched, `non-rotating ref should not match 25° rotated card`);
});

// ---------------------------------------------------------------------------
// 7. Speed benchmark
// ---------------------------------------------------------------------------

console.log("\n— performance benchmark ---");

test("rotation matching 5 triggers × 12 angles completes in <150ms", () => {
  const refs = Array.from({ length: 5 }, () => makeRotatingRef(true));
  const triggers = refs.map((ref, i) => ({
    id: `trigger-${i}`,
    payloads: [{ title: `Card ${i}` }],
    references: [ref],
  }));

  // 20° rotated card at center
  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, 20);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);

  const N = 10; // run 10 "hover events"
  const start = Date.now();
  for (let i = 0; i < N; i++) {
    matcher.findBestMatch(triggers, scene, gray);
  }
  const elapsed = Date.now() - start;
  const perEvent = elapsed / N;
  console.log(`    5 rotating triggers, ${matcher.config.rotationAngles.length} angles: ${perEvent.toFixed(1)}ms/event (${N} runs)`);
  assert(perEvent < 150, `${perEvent.toFixed(1)}ms/event exceeds 150ms budget`);
});

test("rotation matching 20 triggers × 12 angles completes in <500ms", () => {
  const refs = Array.from({ length: 20 }, () => makeRotatingRef(true));
  const triggers = refs.map((ref, i) => ({
    id: `trigger-${i}`,
    payloads: [{ title: `Card ${i}` }],
    references: [ref],
  }));

  const rotCardPx = MatcherCore.rotatePixels(CARD_PX, CARD_W, CARD_H, 15);
  const scene = embedInScene(rotCardPx, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);

  const N = 5;
  const start = Date.now();
  for (let i = 0; i < N; i++) {
    matcher.findBestMatch(triggers, scene, gray);
  }
  const elapsed = Date.now() - start;
  const perEvent = elapsed / N;
  console.log(`    20 rotating triggers, ${matcher.config.rotationAngles.length} angles: ${perEvent.toFixed(1)}ms/event (${N} runs)`);
  assert(perEvent < 500, `${perEvent.toFixed(1)}ms/event exceeds 500ms budget`);
});

test("mixed profile (10 static + 10 rotating) is faster than all-rotating", () => {
  const rotRefs   = Array.from({ length: 10 }, () => makeRotatingRef(true));
  const statRefs  = Array.from({ length: 10 }, () => makeRotatingRef(false));
  const mixedTriggers = [
    ...rotRefs.map((r, i)  => ({ id: `rot-${i}`,  payloads: [{ title: `Rotating ${i}` }],  references: [r] })),
    ...statRefs.map((r, i) => ({ id: `stat-${i}`, payloads: [{ title: `Static ${i}` }],    references: [r] })),
  ];
  const allRotTriggers = Array.from({ length: 20 }, (_, i) => ({
    id: `rot-${i}`, payloads: [{ title: `Card ${i}` }], references: [makeRotatingRef(true)],
  }));

  const scene = embedInScene(CARD_PX, CARD_W, CARD_H, 60, 55);
  const gray = matcher.fillGrayBuffer(scene);
  const N = 5;

  const startMix = Date.now();
  for (let i = 0; i < N; i++) matcher.findBestMatch(mixedTriggers, scene, gray);
  const mixTime = (Date.now() - startMix) / N;

  const startAll = Date.now();
  for (let i = 0; i < N; i++) matcher.findBestMatch(allRotTriggers, scene, gray);
  const allTime = (Date.now() - startAll) / N;

  console.log(`    mixed: ${mixTime.toFixed(1)}ms/event  all-rotating: ${allTime.toFixed(1)}ms/event`);
  assert(mixTime < allTime * 1.2, "mixed profile should be ≤ all-rotating in time");
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
