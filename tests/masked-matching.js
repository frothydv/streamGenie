#!/usr/bin/env node
// Tests for mask-aware dHash matching.
// Run with: node tests/masked-matching.js

const MatcherCore = require("../extension/matcher-core.js");

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEqual(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const CANONICAL_SIZE = MatcherCore.DEFAULTS.canonicalSize;
const MIN_MASKED_BITS = MatcherCore.DEFAULTS.minMaskedBits;
const matcher = MatcherCore.createMatcher({ captureSize: CANONICAL_SIZE });

function makePixels(width, height, backgroundFn, objectFn) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inObject = x >= 6 && x < 26 && y >= 6 && y < 26;
      const v = inObject ? objectFn(x, y) : backgroundFn(x, y);
      const idx = (y * width + x) * 4;
      pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = v;
      pixels[idx + 3] = 255;
    }
  }
  return pixels;
}

function makeCenterMask(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const on = x >= 6 && x < 26 && y >= 6 && y < 26;
      pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = 255;
      pixels[idx + 3] = on ? 255 : 0;
    }
  }
  return pixels;
}

function scene(bgFlip, fgFlip) {
  return makePixels(
    32,
    32,
    (x) => {
      const left = bgFlip ? 210 : 20;
      const right = bgFlip ? 20 : 210;
      return x < 16 ? left : right;
    },
    (x) => {
      const left = fgFlip ? 230 : 30;
      const right = fgFlip ? 30 : 230;
      return x < 16 ? left : right;
    }
  );
}

console.log("\n— mask-aware matching ---");

test("unmasked matching preserves old exact-match behavior", () => {
  const ref = scene(false, false);
  const refHash = matcher.dHashFromPixels(ref, 32, 0, 0, 32, 32);
  const captureGray = matcher.fillGrayBuffer(ref);
  const refBits = { refHash, refBitMask: null, refValidBits: 64, w: 32, h: 32 };
  const exact = matcher.evaluateReference(refBits, ref, captureGray);
  assertEqual(exact.dist, 0);
  assertEqual(exact.validBits, 64);
  assertEqual(exact.ratio, 0);
});

test("mask ignores changed background when foreground stays the same", () => {
  const ref = scene(false, false);
  const candidate = scene(true, false);
  const refHash = matcher.dHashFromPixels(ref, 32, 0, 0, 32, 32);
  const maskBits = matcher.maskBitsFromPixels(makeCenterMask(32, 32), 32, 0, 0, 32, 32);
  const candidateGray = matcher.fillGrayBuffer(candidate);
  const unmasked = matcher.evaluateReference({ refHash, refBitMask: null, refValidBits: 64, w: 32, h: 32 }, candidate, candidateGray);
  const masked = matcher.evaluateReference({ refHash, refBitMask: maskBits.bits, refValidBits: maskBits.validBits, w: 32, h: 32 }, candidate, candidateGray);
  assert(unmasked.dist > 0, "background change should disturb the full-image hash");
  assertEqual(masked.dist, 0);
  assert(masked.validBits >= MIN_MASKED_BITS, "mask should leave enough valid bits");
});

test("mask still rejects wrong foreground", () => {
  const ref = scene(false, false);
  const candidate = scene(true, true);
  const refHash = matcher.dHashFromPixels(ref, 32, 0, 0, 32, 32);
  const maskBits = matcher.maskBitsFromPixels(makeCenterMask(32, 32), 32, 0, 0, 32, 32);
  const candidateGray = matcher.fillGrayBuffer(candidate);
  const masked = matcher.evaluateReference({ refHash, refBitMask: maskBits.bits, refValidBits: maskBits.validBits, w: 32, h: 32 }, candidate, candidateGray);
  assert(masked.dist > 0, "foreground change should still produce mismatches");
  assert(masked.ratio > 0, "foreground change should survive masking");
});

test("masked verifier ignores background-only changes", () => {
  const ref = scene(false, false);
  const candidate = scene(true, false);
  const verifyRef = matcher.buildVerifyRefFromPixels(ref, makeCenterMask(32, 32));
  const verifySamples = matcher.buildVerifySamples(32, 32);
  const verify = matcher.verifyScoreFromPixels(candidate, 32, 0, 0, verifyRef.values, verifyRef.mask, verifyRef.active, verifySamples.sampleX, verifySamples.sampleY);
  assert(verify.score < 0.05, `expected low verify score, got ${verify.score}`);
});

test("masked verifier rejects wrong foreground", () => {
  const ref = scene(false, false);
  const candidate = scene(true, true);
  const verifyRef = matcher.buildVerifyRefFromPixels(ref, makeCenterMask(32, 32));
  const verifySamples = matcher.buildVerifySamples(32, 32);
  const verify = matcher.verifyScoreFromPixels(candidate, 32, 0, 0, verifyRef.values, verifyRef.mask, verifyRef.active, verifySamples.sampleX, verifySamples.sampleY);
  assert(verify.score > 0.3, `expected high verify score, got ${verify.score}`);
});

test("color-aware verifier rejects same-shape different-color foreground", () => {
  const ref = makePixels(32, 32, () => 20, () => 0);
  const candidate = new Uint8ClampedArray(ref);
  for (let y = 6; y < 26; y++) {
    for (let x = 6; x < 26; x++) {
      const idx = (y * 32 + x) * 4;
      candidate[idx] = 0;
      candidate[idx + 1] = 220;
      candidate[idx + 2] = 220;
    }
  }
  const verifyRef = matcher.buildVerifyRefFromPixels(ref, makeCenterMask(32, 32));
  const verifySamples = matcher.buildVerifySamples(32, 32);
  const verify = matcher.verifyScoreFromPixels(candidate, 32, 0, 0, verifyRef.values, verifyRef.mask, verifyRef.active, verifySamples.sampleX, verifySamples.sampleY);
  assert(verify.score > 0.2, `expected color mismatch to score high, got ${verify.score}`);
});

test("tiny masks are rejected as too weak", () => {
  const ref = scene(false, false);
  const refHash = matcher.dHashFromPixels(ref, 32, 0, 0, 32, 32);
  const tinyMask = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 4; i++) tinyMask[i + 3] = 255;
  const bits = matcher.maskBitsFromPixels(tinyMask, 32, 0, 0, 32, 32);
  const captureGray = matcher.fillGrayBuffer(ref);
  const result = matcher.evaluateReference({ refHash, refBitMask: bits.bits, refValidBits: bits.validBits, w: 32, h: 32 }, ref, captureGray);
  assert(bits.validBits < MIN_MASKED_BITS, "test mask should be tiny");
  assertEqual(result.ratio, 1);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
