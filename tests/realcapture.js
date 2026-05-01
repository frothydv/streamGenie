#!/usr/bin/env node
// Test a real capture PNG from the browser extension against all profile triggers.
// Usage:  node tests/realcapture.js path/to/streamgenie-cap-*.png
//
// Workflow:
//   1. In the extension's debug panel click "save capture" while hovering
//      over the thing you want to detect.
//   2. Run this script against the saved PNG.
//   3. It reports the score for every trigger so you can see what the matcher
//      sees and why a match is or isn't firing.
//
// Noise tolerance section (added after the main match report):
//   For each matched trigger, applies increasing levels of H.264-like correlated
//   noise to the capture and re-runs the matcher.  The "margin" shows how much
//   additional noise the fixture can absorb before the match breaks — captures
//   with a thin margin are likely to miss on live streams whose H.264 artifacts
//   differ from the reference session.

const fs   = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const MatcherCore = require("../extension/matcher-core.js");

const PROFILE_DIR = path.resolve(__dirname, "../../streamGenieProfiles/games/slay-the-spire-2/profiles/community");
const REFS_DIR    = path.join(PROFILE_DIR, "references");
const CAPTURE_SIZE = 160;
const NOISE_TRIALS = 20;  // trials per noise level
const NOISE_LEVELS = [0, 3, 5, 8, 10, 15, 20];

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const capturePath = process.argv[2];
if (!capturePath) {
  console.error("Usage: node tests/realcapture.js <path-to-capture.png>");
  process.exit(1);
}
if (!fs.existsSync(capturePath)) {
  console.error("File not found:", capturePath);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadPng(filePath) {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf);
  return { pixels: new Uint8Array(png.data), width: png.width, height: png.height };
}

function resize(srcPx, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.floor((x * srcW) / dstW);
      const sy = Math.floor((y * srcH) / dstH);
      const si = (sy * srcW + sx) * 4;
      const di = (y  * dstW + x)  * 4;
      out[di] = srcPx[si]; out[di+1] = srcPx[si+1];
      out[di+2] = srcPx[si+2]; out[di+3] = srcPx[si+3];
    }
  }
  return out;
}

// H.264-like spatially correlated block noise.
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

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const matcher = MatcherCore.createMatcher({ captureSize: CAPTURE_SIZE });
const CANONICAL = MatcherCore.DEFAULTS.canonicalSize;

let profile;
try {
  profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, "profile.json"), "utf8"));
} catch (e) {
  console.error("Could not load profile.json:", e.message);
  process.exit(1);
}

// Load the capture PNG. The extension saves the captureCanvas which is always
// CAPTURE_SIZE×CAPTURE_SIZE, but resize gracefully in case of any mismatch.
const cap = loadPng(capturePath);
const capPixels = cap.width === CAPTURE_SIZE && cap.height === CAPTURE_SIZE
  ? cap.pixels
  : resize(cap.pixels, cap.width, cap.height, CAPTURE_SIZE, CAPTURE_SIZE);
const capGray = matcher.fillGrayBuffer(capPixels);

console.log(`\nCapture: ${path.basename(capturePath)}  (${cap.width}×${cap.height})\n`);

// ---------------------------------------------------------------------------
// Build refs and evaluate every trigger
// ---------------------------------------------------------------------------

const results = [];

for (const trigger of profile.triggers) {
  if (!trigger.references?.length) continue;

  for (const ref0 of trigger.references) {
    if (!ref0.file) continue;
    const refPath = path.join(REFS_DIR, ref0.file);
    if (!fs.existsSync(refPath)) continue;

    const { pixels: refPx, width: refW, height: refH } = loadPng(refPath);
    const canPx  = resize(refPx, refW, refH, CANONICAL, CANONICAL);
    const hash   = matcher.dHashFromPixels(canPx, CANONICAL, 0, 0, CANONICAL, CANONICAL);
    const verify = matcher.buildVerifyRefFromPixels(canPx, null);
    const ref = {
      w: refW, h: refH,
      refHash: hash,
      refBitMask: null, refValidBits: 64,
      refVerifyValues: verify.values,
      refVerifyMask:   verify.mask,
      refVerifyActive: verify.active,
      refNCC: matcher.buildRefNCC(refPx, refW, refH),
      rotatedHashes: trigger.rotates
        ? matcher.computeRotatedHashes(refPx, refW, refH, matcher.config.rotationAngles)
        : null,
    };

    const { sat, sat2 } = matcher.buildSAT(capGray, CAPTURE_SIZE, CAPTURE_SIZE);
    const result = matcher.evaluateReference(ref, capPixels, capGray, false, sat, sat2);
    results.push({ trigger, ref0, ref, result });
    break; // use first reference only
  }
}

// Sort: matched first, then by ascending ratio.
results.sort((a, b) => {
  if (a.result.matched !== b.result.matched) return a.result.matched ? -1 : 1;
  return a.result.ratio - b.result.ratio;
});

// ---------------------------------------------------------------------------
// Report — match results
// ---------------------------------------------------------------------------

const matched = results.filter(r => r.result.matched);
const unmatched = results.filter(r => !r.result.matched);

if (matched.length) {
  console.log("=== MATCHED ===\n");
  for (const { trigger, result } of matched) {
    const angleStr  = result.angle  ? ` @${result.angle}°` : "";
    const verifyStr = result.verifyScore != null
      ? ` verify=${(result.verifyScore * 100).toFixed(1)}%<=${(result.verifyThreshold * 100).toFixed(1)}%`
      : "";
    const nccStr = result.nccScore != null ? ` ncc=${result.nccScore.toFixed(3)}` : "";
    console.log(`  ✓ "${trigger.id}"${angleStr}  ratio=${result.ratio.toFixed(3)}<=${result.threshold.toFixed(3)}  dist=${result.dist}/${result.validBits}${verifyStr}${nccStr}`);
  }
} else {
  console.log("=== NO MATCH ===\n");
}

// Show the top-10 non-matched — sorted by NCC score (descending) when available,
// then by ratio. NCC score shows which near-misses are visually closest.
if (unmatched.length) {
  const sorted = unmatched.slice().sort((a, b) => {
    const an = a.result.nccScore ?? -1, bn = b.result.nccScore ?? -1;
    if (an !== bn) return bn - an;
    return a.result.ratio - b.result.ratio;
  });
  console.log(`\n=== CLOSEST NON-MATCHES (top 10 of ${unmatched.length}, by NCC) ===\n`);
  for (const { trigger, result } of sorted.slice(0, 10)) {
    const angleStr = result.angle ? ` @${result.angle}°` : "";
    const nccStr = result.nccScore != null ? `  ncc=${result.nccScore.toFixed(3)}` : "";
    console.log(`  ~ "${trigger.id}"${angleStr}  ratio=${result.ratio.toFixed(3)}>threshold=${result.threshold.toFixed(3)}  dist=${result.dist}/${result.validBits}${nccStr}`);
  }
}

// ---------------------------------------------------------------------------
// Noise tolerance sweep — for each matched trigger, how much H.264-like noise
// can the capture absorb before the match breaks?
//
// This is the key gap between the saved-fixture test and live-stream reality:
// a live frame has different H.264 compression artifacts than the fixture.
// If the margin is thin here, the same trigger will miss on a fresh stream.
// ---------------------------------------------------------------------------

if (matched.length) {
  console.log("\n=== NOISE TOLERANCE (H.264-like correlated noise, matched triggers only) ===");
  console.log(`    ${NOISE_TRIALS} trials per level. "pass rate" = fraction that still match.\n`);

  for (const { trigger, ref, result } of matched) {
    const baseDistStr = `${result.dist}/${result.validBits}`;
    console.log(`  "${trigger.id}"  (base dist=${baseDistStr}, threshold=${Math.ceil(result.threshold * result.validBits)}/${result.validBits})`);

    let brokeAt = null;
    for (const level of NOISE_LEVELS) {
      if (level === 0) {
        // Zero noise: should always match (same as the base test).
        console.log(`    ±${String(level).padStart(2)} noise: 20/20 pass  (base)`);
        continue;
      }
      let passes = 0;
      let totalDist = 0;
      for (let t = 0; t < NOISE_TRIALS; t++) {
        const noisy = addCorrelatedNoise(capPixels, CAPTURE_SIZE, CAPTURE_SIZE, level);
        const noisyGray = matcher.fillGrayBuffer(noisy);
        const { sat, sat2 } = matcher.buildSAT(noisyGray, CAPTURE_SIZE, CAPTURE_SIZE);
        const r = matcher.evaluateReference(ref, noisy, noisyGray, false, sat, sat2);
        if (r.matched) passes++;
        totalDist += r.dist ?? Math.round(r.ratio * r.validBits);
      }
      const avgDist = (totalDist / NOISE_TRIALS).toFixed(1);
      const bar = '█'.repeat(Math.round(passes / NOISE_TRIALS * 10)) +
                  '░'.repeat(10 - Math.round(passes / NOISE_TRIALS * 10));
      const flag = passes === NOISE_TRIALS ? '' : passes === 0 ? '  ✗ BROKEN' : '  ~ degraded';
      console.log(`    ±${String(level).padStart(2)} noise: ${String(passes).padStart(2)}/${NOISE_TRIALS} pass  avgDist=${avgDist}  ${bar}${flag}`);
      if (brokeAt === null && passes < NOISE_TRIALS) brokeAt = level;
    }
    const marginBits = result.validBits
      ? Math.ceil(result.threshold * result.validBits) - result.dist
      : '?';
    console.log(`    → hash margin: ${marginBits} bit(s) remaining`);
    if (brokeAt !== null) {
      console.log(`    → match starts degrading at ±${brokeAt} noise`);
      console.log(`    → live stream H.264 typically adds ±5–10 noise equivalent`);
      if (brokeAt <= 5) {
        console.log(`    ⚠ thin margin — this trigger likely misses on live streams`);
        console.log(`      fix: recapture the reference from the live stream to align artifacts`);
      }
    } else {
      console.log(`    → robust at all tested noise levels`);
    }
    console.log();
  }
}

console.log();
