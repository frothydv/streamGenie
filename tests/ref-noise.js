#!/usr/bin/env node
// Noise-margin test for every reference in the STS2 community profile.
// Run: node tests/ref-noise.js
//
// For each reference PNG, embeds it in a 160×160 capture (gray background),
// then applies increasing levels of H.264-like correlated noise and runs the
// full matcher.  Reports the noise level at which each trigger stops matching.
//
// This simulates the gap between "reference captured once" and "live stream
// frame with fresh H.264 artifacts".  A trigger that fails at ±5 noise has
// almost no live-stream margin; one that survives ±15 is robust.
//
// Also reports the "strong-bit count" for each ref: bits where adjacent sample
// pairs differ by >20 luma units.  Strong bits don't flip under compression
// noise.  Refs with few strong bits are inherently fragile regardless of
// threshold settings.

const fs   = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const MatcherCore = require("../extension/matcher-core.js");

const PROFILE_DIR = path.resolve(__dirname, "../../streamGenieProfiles/games/slay-the-spire-2/profiles/community");
const REFS_DIR    = path.join(PROFILE_DIR, "references");
const CAPTURE_SIZE = 160;
const CANONICAL    = MatcherCore.DEFAULTS.canonicalSize;  // 32
const TRIALS       = 20;
const NOISE_LEVELS = [5, 10, 15, 20];
const STRONG_BIT_THRESHOLD = 20;  // luma difference considered noise-immune

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadPng(p) {
  const png = PNG.sync.read(fs.readFileSync(p));
  return { pixels: new Uint8Array(png.data), width: png.width, height: png.height };
}

function resize(srcPx, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.floor((x * srcW) / dstW);
      const sy = Math.floor((y * srcH) / dstH);
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = srcPx[si]; out[di+1] = srcPx[si+1];
      out[di+2] = srcPx[si+2]; out[di+3] = srcPx[si+3];
    }
  }
  return out;
}

function grayScene() {
  // Slightly textured gray so the background doesn't accidentally hash-match refs.
  const px = new Uint8Array(CAPTURE_SIZE * CAPTURE_SIZE * 4);
  for (let y = 0; y < CAPTURE_SIZE; y++) {
    for (let x = 0; x < CAPTURE_SIZE; x++) {
      const v = 85 + ((x + y) % 5);  // gentle dither
      const i = (y * CAPTURE_SIZE + x) * 4;
      px[i] = v; px[i+1] = v; px[i+2] = v; px[i+3] = 255;
    }
  }
  return px;
}

function embed(scene, refPx, refW, refH, tx, ty) {
  const s = Uint8Array.from(scene);
  for (let y = 0; y < refH; y++) {
    for (let x = 0; x < refW; x++) {
      const dx = tx + x, dy = ty + y;
      if (dx < 0 || dy < 0 || dx >= CAPTURE_SIZE || dy >= CAPTURE_SIZE) continue;
      const si = (y * refW + x) * 4;
      const di = (dy * CAPTURE_SIZE + dx) * 4;
      s[di] = refPx[si]; s[di+1] = refPx[si+1]; s[di+2] = refPx[si+2]; s[di+3] = 255;
    }
  }
  return s;
}

// H.264-like spatially correlated block noise applied to the whole capture.
function addCorrelatedNoise(px, w, h, halfRange, blockSize = 8, correlation = 0.8) {
  const out = new Uint8Array(px);
  const cols = Math.ceil(w / blockSize);
  const rows = Math.ceil(h / blockSize);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const blockOffset = (Math.random() - 0.5) * halfRange * 2;
      for (let dy = 0; dy < blockSize && (by * blockSize + dy) < h; dy++) {
        for (let dx = 0; dx < blockSize && (bx * blockSize + dx) < w; dx++) {
          const i = ((by * blockSize + dy) * w + (bx * blockSize + dx)) * 4;
          const n = Math.round(blockOffset * correlation +
            (Math.random() - 0.5) * halfRange * 2 * (1 - correlation));
          for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, out[i + c] + n));
        }
      }
    }
  }
  return out;
}

// Count bits whose adjacent luma pair differ by more than STRONG_BIT_THRESHOLD.
// These bits won't flip under typical H.264 noise and represent the "reliable core"
// of the hash.  A ref with few strong bits is fragile.
function countStrongBits(canPx) {
  let strong = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const lIdx = y * 9 + x;
      const rIdx = lIdx + 1;
      const lCx = Math.floor((lIdx % 9) * CANONICAL / 9);
      const rCx = Math.floor((rIdx % 9) * CANONICAL / 9);
      const cy  = Math.floor(y * CANONICAL / 8);
      const li  = (cy * CANONICAL + lCx) * 4;
      const ri  = (cy * CANONICAL + rCx) * 4;
      const lGray = 0.299 * canPx[li] + 0.587 * canPx[li+1] + 0.114 * canPx[li+2];
      const rGray = 0.299 * canPx[ri] + 0.587 * canPx[ri+1] + 0.114 * canPx[ri+2];
      if (Math.abs(rGray - lGray) >= STRONG_BIT_THRESHOLD) strong++;
    }
  }
  return strong;
}

// ---------------------------------------------------------------------------
// Load profile
// ---------------------------------------------------------------------------

const matcher = MatcherCore.createMatcher({ captureSize: CAPTURE_SIZE });

let profile;
try {
  profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, "profile.json"), "utf8"));
} catch (e) {
  console.error("Could not load profile.json:", e.message);
  process.exit(1);
}

const bg = grayScene();

console.log(`\nRef noise-margin test — STS2 community profile`);
console.log(`${TRIALS} trials per noise level.  Noise is H.264-like (8×8 correlated blocks).\n`);
console.log(`Columns: trigger | size | strong/64 bits | base dist | ±5 | ±10 | ±15 | ±20\n`);

let fragileCount = 0;
let skippedCount = 0;

for (const trigger of profile.triggers) {
  if (!trigger.references?.length) continue;

  for (const ref0 of trigger.references) {
    if (!ref0.file) break;
    const refPath = path.join(REFS_DIR, ref0.file);
    if (!fs.existsSync(refPath)) { skippedCount++; break; }

    const { pixels: refPx, width: refW, height: refH } = loadPng(refPath);

    // Skip refs too large for the capture window — same rule as content.js.
    if (refW > CAPTURE_SIZE || refH > CAPTURE_SIZE) {
      console.log(`  SKIP  "${trigger.id}"  (${refW}×${refH} > capture size ${CAPTURE_SIZE})`);
      skippedCount++;
      break;
    }

    const canPx = resize(refPx, refW, refH, CANONICAL, CANONICAL);
    const hash  = matcher.dHashFromPixels(canPx, CANONICAL, 0, 0, CANONICAL, CANONICAL);
    const verify = matcher.buildVerifyRefFromPixels(canPx, null);
    const strongBits = countStrongBits(canPx);

    const ref = {
      w: refW, h: refH,
      refHash: hash,
      refBitMask: null, refValidBits: 64,
      refVerifyValues: verify.values,
      refVerifyMask:   verify.mask,
      refVerifyActive: verify.active,
      rotatedHashes: trigger.rotates
        ? matcher.computeRotatedHashes(refPx, refW, refH, matcher.config.rotationAngles)
        : null,
    };

    // Embed at center of capture.
    const tx = Math.floor((CAPTURE_SIZE - refW) / 2);
    const ty = Math.floor((CAPTURE_SIZE - refH) / 2);
    const cleanScene  = embed(bg, refPx, refW, refH, tx, ty);
    const cleanGray   = matcher.fillGrayBuffer(cleanScene);
    const baseResult  = matcher.evaluateReference(ref, cleanScene, cleanGray);

    const baseDist = baseResult.dist ?? '?';
    const threshold = Math.ceil(matcher.config.matchThresholdRatio * 64);

    if (!baseResult.matched) {
      // Self-match at zero noise should always pass — if it doesn't, the ref
      // has a quality issue unrelated to noise.
      console.log(`  FAIL  "${trigger.id}"  (${refW}×${refH})  self-match fails at zero noise!`);
      fragileCount++;
      break;
    }

    // Noise sweep.
    const passRates = [];
    for (const level of NOISE_LEVELS) {
      let passes = 0;
      for (let t = 0; t < TRIALS; t++) {
        const noisy    = addCorrelatedNoise(cleanScene, CAPTURE_SIZE, CAPTURE_SIZE, level);
        const noisyGray = matcher.fillGrayBuffer(noisy);
        const r = matcher.evaluateReference(ref, noisy, noisyGray);
        if (r.matched) passes++;
      }
      passRates.push(passes);
    }

    const firstDegraded = NOISE_LEVELS.find((l, i) => passRates[i] < TRIALS);
    const firstBroken   = NOISE_LEVELS.find((l, i) => passRates[i] === 0);
    const fragile = firstDegraded !== undefined && firstDegraded <= 5;
    if (fragile) fragileCount++;

    const rateStr = passRates.map((p, i) => {
      if (p === TRIALS) return `${NOISE_LEVELS[i]}:✓`;
      if (p === 0)      return `${NOISE_LEVELS[i]}:✗`;
      return `${NOISE_LEVELS[i]}:${p}/${TRIALS}`;
    }).join('  ');

    const sizeStr = `${refW}×${refH}`;
    const marginBits = threshold - baseDist;
    const fragileFlag = fragile ? '  ⚠ fragile' : '';

    console.log(
      `  ${fragile ? '!' : ' '} "${trigger.id.padEnd(24)}"` +
      `  ${sizeStr.padEnd(8)}` +
      `  strong=${String(strongBits).padStart(2)}/64` +
      `  base=${String(baseDist).padStart(2)}/${threshold}(margin=${marginBits})` +
      `    ${rateStr}${fragileFlag}`
    );

    break; // first reference only
  }
}

console.log(`\n${fragileCount} fragile ref(s), ${skippedCount} skipped (missing file or too large)`);
console.log(`\nInterpretation:`);
console.log(`  strong bits: how many of the 64 hash bits compare adjacent pairs with >20 luma`);
console.log(`               difference.  Bits below this threshold flip under H.264 noise.`);
console.log(`  base dist:   Hamming distance from clean self-embed to the ref hash (should be 0).`);
console.log(`  ±N noise:    pass rate at H.264-like noise level N (20 = very aggressive).`);
console.log(`  ⚠ fragile:   match starts degrading at ±5 — likely to miss on live streams.\n`);
