#!/usr/bin/env node
// Tests for mask-aware dHash matching.
// Run with: node tests/masked-matching.js

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

const CANONICAL_SIZE = 32;
const MIN_MASKED_BITS = 12;
const _gray = new Float32Array(72);
const _allBitMask = new Uint8Array(64).fill(1);

function dHashFromPixels(pixels, srcW, sx, sy, sw, sh) {
  for (let dy = 0; dy < 8; dy++) {
    for (let dx = 0; dx < 9; dx++) {
      const cx = Math.floor((dx * CANONICAL_SIZE) / 9);
      const cy = Math.floor((dy * CANONICAL_SIZE) / 8);
      const px = sx + Math.floor((cx * sw) / CANONICAL_SIZE);
      const py = sy + Math.floor((cy * sh) / CANONICAL_SIZE);
      const i = (py * srcW + px) * 4;
      _gray[dy * 9 + dx] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    }
  }
  const bits = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits[y * 8 + x] = _gray[y * 9 + x + 1] > _gray[y * 9 + x] ? 1 : 0;
    }
  }
  return bits;
}

function dHashDistFromPixels(pixels, srcW, sx, sy, sw, sh, refHash, refBitMask, refValidBits) {
  for (let dy = 0; dy < 8; dy++) {
    for (let dx = 0; dx < 9; dx++) {
      const cx = Math.floor((dx * CANONICAL_SIZE) / 9);
      const cy = Math.floor((dy * CANONICAL_SIZE) / 8);
      const px = sx + Math.floor((cx * sw) / CANONICAL_SIZE);
      const py = sy + Math.floor((cy * sh) / CANONICAL_SIZE);
      const i = (py * srcW + px) * 4;
      _gray[dy * 9 + dx] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    }
  }
  const mask = refBitMask || _allBitMask;
  const validBits = refValidBits ?? 64;
  if (validBits < MIN_MASKED_BITS) return { dist: 64, validBits, ratio: 1 };
  let dist = 0;
  for (let i = 0; i < 64; i++) {
    if (!mask[i]) continue;
    const y = Math.floor(i / 8);
    const x = i % 8;
    const bit = _gray[y * 9 + x + 1] > _gray[y * 9 + x] ? 1 : 0;
    if (bit !== refHash[i]) dist++;
  }
  return { dist, validBits, ratio: dist / validBits };
}

function maskBitsFromPixels(maskPixels, srcW, sx, sy, sw, sh) {
  const bits = new Uint8Array(64);
  let validBits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const leftCx = Math.floor((x * CANONICAL_SIZE) / 9);
      const rightCx = Math.floor(((x + 1) * CANONICAL_SIZE) / 9);
      const cy = Math.floor((y * CANONICAL_SIZE) / 8);
      const leftPx = sx + Math.floor((leftCx * sw) / CANONICAL_SIZE);
      const rightPx = sx + Math.floor((rightCx * sw) / CANONICAL_SIZE);
      const py = sy + Math.floor((cy * sh) / CANONICAL_SIZE);
      const leftA = maskPixels[(py * srcW + leftPx) * 4 + 3];
      const rightA = maskPixels[(py * srcW + rightPx) * 4 + 3];
      const idx = y * 8 + x;
      bits[idx] = (leftA >= 128 && rightA >= 128) ? 1 : 0;
      validBits += bits[idx];
    }
  }
  return { bits, validBits };
}

function makePixels(width, height, backgroundFn, objectFn) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inObject = x >= 8 && x < 24 && y >= 8 && y < 24;
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
      const on = x >= 8 && x < 24 && y >= 8 && y < 24;
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
  const refHash = dHashFromPixels(ref, 32, 0, 0, 32, 32);
  const exact = dHashDistFromPixels(ref, 32, 0, 0, 32, 32, refHash, null, 64);
  assertEqual(exact.dist, 0);
  assertEqual(exact.validBits, 64);
  assertEqual(exact.ratio, 0);
});

test("mask ignores changed background when foreground stays the same", () => {
  const ref = scene(false, false);
  const candidate = scene(true, false);
  const refHash = dHashFromPixels(ref, 32, 0, 0, 32, 32);
  const maskBits = maskBitsFromPixels(makeCenterMask(32, 32), 32, 0, 0, 32, 32);
  const unmasked = dHashDistFromPixels(candidate, 32, 0, 0, 32, 32, refHash, null, 64);
  const masked = dHashDistFromPixels(candidate, 32, 0, 0, 32, 32, refHash, maskBits.bits, maskBits.validBits);
  assert(unmasked.dist > 0, "background change should disturb the full-image hash");
  assertEqual(masked.dist, 0);
  assert(masked.validBits >= MIN_MASKED_BITS, "mask should leave enough valid bits");
});

test("mask still rejects wrong foreground", () => {
  const ref = scene(false, false);
  const candidate = scene(true, true);
  const refHash = dHashFromPixels(ref, 32, 0, 0, 32, 32);
  const maskBits = maskBitsFromPixels(makeCenterMask(32, 32), 32, 0, 0, 32, 32);
  const masked = dHashDistFromPixels(candidate, 32, 0, 0, 32, 32, refHash, maskBits.bits, maskBits.validBits);
  assert(masked.dist > 0, "foreground change should still produce mismatches");
  assert(masked.ratio > 0, "foreground change should survive masking");
});

test("tiny masks are rejected as too weak", () => {
  const ref = scene(false, false);
  const refHash = dHashFromPixels(ref, 32, 0, 0, 32, 32);
  const tinyMask = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 4; i++) tinyMask[i + 3] = 255;
  const bits = maskBitsFromPixels(tinyMask, 32, 0, 0, 32, 32);
  const result = dHashDistFromPixels(ref, 32, 0, 0, 32, 32, refHash, bits.bits, bits.validBits);
  assert(bits.validBits < MIN_MASKED_BITS, "test mask should be tiny");
  assertEqual(result.ratio, 1);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
