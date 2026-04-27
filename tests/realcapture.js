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

const fs   = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const MatcherCore = require("../extension/matcher-core.js");

const PROFILE_DIR = path.resolve(__dirname, "../../streamGenieProfiles/games/slay-the-spire-2/profiles/community");
const REFS_DIR    = path.join(PROFILE_DIR, "references");
const CAPTURE_SIZE = 160;

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
      rotatedHashes: trigger.rotates
        ? matcher.computeRotatedHashes(refPx, refW, refH, matcher.config.rotationAngles)
        : null,
    };

    const result = matcher.evaluateReference(ref, capPixels, capGray);
    results.push({ trigger, ref0, result });
    break; // use first reference only
  }
}

// Sort: matched first, then by ascending ratio.
results.sort((a, b) => {
  if (a.result.matched !== b.result.matched) return a.result.matched ? -1 : 1;
  return a.result.ratio - b.result.ratio;
});

// ---------------------------------------------------------------------------
// Report
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
    console.log(`  ✓ "${trigger.id}"${angleStr}  ratio=${result.ratio.toFixed(3)}<=${result.threshold.toFixed(3)}  dist=${result.dist}/${result.validBits}${verifyStr}`);
  }
} else {
  console.log("=== NO MATCH ===\n");
}

// Show the top-10 non-matched by ratio so you can see what came closest.
if (unmatched.length) {
  console.log(`\n=== CLOSEST NON-MATCHES (top 10 of ${unmatched.length}) ===\n`);
  for (const { trigger, result } of unmatched.slice(0, 10)) {
    const angleStr = result.angle ? ` @${result.angle}°` : "";
    console.log(`  ~ "${trigger.id}"${angleStr}  ratio=${result.ratio.toFixed(3)}>threshold=${result.threshold.toFixed(3)}  dist=${result.dist}/${result.validBits}`);
  }
}

console.log();
