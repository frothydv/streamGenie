#!/usr/bin/env node
// Diagnostic test using real reference images from the STS2 community profile.
// Tests rotation matching quality and false positive rate at all angles.
// Run with: node tests/rotation-realdata.js

const fs   = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const MatcherCore = require("../extension/matcher-core.js");

const PROFILE_DIR = path.resolve(__dirname, "../../streamGenieProfiles/games/slay-the-spire-2/profiles/community");
const REFS_DIR    = path.join(PROFILE_DIR, "references");

const CAPTURE_SIZE = 160;
const matcher = MatcherCore.createMatcher({ captureSize: CAPTURE_SIZE });

let passed = 0, failed = 0, warnings = 0;
function pass(msg)  { console.log(`  ✓ ${msg}`); passed++; }
function fail(msg)  { console.log(`  ✗ ${msg}`); failed++; }
function warn(msg)  { console.log(`  ~ ${msg}`); warnings++; }

// ---------------------------------------------------------------------------
// PNG helpers
// ---------------------------------------------------------------------------

function loadPng(filePath) {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf);
  return { pixels: new Uint8Array(png.data), width: png.width, height: png.height };
}

// Nearest-neighbour resize to dstW×dstH.
function resize(srcPx, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.floor((x * srcW) / dstW);
      const sy = Math.floor((y * srcH) / dstH);
      const si = (sy * srcW + sx) * 4;
      const di = (y  * dstW + x)  * 4;
      out[di]   = srcPx[si];
      out[di+1] = srcPx[si+1];
      out[di+2] = srcPx[si+2];
      out[di+3] = srcPx[si+3];
    }
  }
  return out;
}

// Fill a CAPTURE_SIZE×CAPTURE_SIZE gray scene.
function grayScene(r = 90, g = 90, b = 90) {
  const px = new Uint8Array(CAPTURE_SIZE * CAPTURE_SIZE * 4);
  for (let i = 0; i < CAPTURE_SIZE * CAPTURE_SIZE; i++) {
    px[i*4]=r; px[i*4+1]=g; px[i*4+2]=b; px[i*4+3]=255;
  }
  return px;
}

// Embed refPx (refW×refH) into a CAPTURE_SIZE scene at (tx, ty).
function embed(scene, refPx, refW, refH, tx, ty) {
  const s = Uint8Array.from(scene);
  for (let y = 0; y < refH; y++) {
    for (let x = 0; x < refW; x++) {
      const dx = tx + x, dy = ty + y;
      if (dx < 0 || dy < 0 || dx >= CAPTURE_SIZE || dy >= CAPTURE_SIZE) continue;
      const si = (y * refW + x) * 4;
      const di = (dy * CAPTURE_SIZE + dx) * 4;
      s[di]=refPx[si]; s[di+1]=refPx[si+1]; s[di+2]=refPx[si+2]; s[di+3]=255;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Build a ref object the same way content.js rehashRef does.
// ---------------------------------------------------------------------------

const CANONICAL = MatcherCore.DEFAULTS.canonicalSize; // 32

function buildRef(refPx, refW, refH, rotates) {
  // Canonical for base hash (same as drawing to 32×32 canvas)
  const canPx = resize(refPx, refW, refH, CANONICAL, CANONICAL);

  const hash   = matcher.dHashFromPixels(canPx, CANONICAL, 0, 0, CANONICAL, CANONICAL);
  const verify = matcher.buildVerifyRefFromPixels(canPx, null);
  return {
    w: refW, h: refH,
    refHash: hash,
    refBitMask: null,
    refValidBits: 64,
    refVerifyValues: verify.values,
    refVerifyMask:   verify.mask,
    refVerifyActive: verify.active,
    rotatedHashes: rotates
      ? matcher.computeRotatedHashes(refPx, refW, refH, matcher.config.rotationAngles)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Load profile triggers that have rotates:true and a local ref file.
// ---------------------------------------------------------------------------

let profile;
try {
  profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, "profile.json"), "utf8"));
} catch (e) {
  console.error("Could not load profile.json:", e.message);
  process.exit(1);
}

const rotatingTriggers = profile.triggers.filter(t =>
  t.rotates && t.references?.length && t.references[0].file
);

console.log(`\nLoaded ${rotatingTriggers.length} rotating trigger(s) from profile.\n`);

// ---------------------------------------------------------------------------
// Section 1: True-positive accuracy — ref should match itself at all angles
// ---------------------------------------------------------------------------

console.log("=== True-positive accuracy (ref vs itself, rotated) ===\n");

for (const trigger of rotatingTriggers) {
  const ref0 = trigger.references[0];
  const refPath = path.join(REFS_DIR, ref0.file);
  if (!fs.existsSync(refPath)) { warn(`${trigger.id}: file missing ${ref0.file}`); continue; }

  const { pixels: refPx, width: refW, height: refH } = loadPng(refPath);

  // Scale to match what rehashRef does at 1920px source
  // (srcW stored = ref0.srcW; at 1920 playback, scale = 1920/srcW = 1)
  const scale = 1; // same source resolution
  const nW = Math.round(refW * scale);
  const nH = Math.round(refH * scale);
  const nativePx = nW === refW ? refPx : resize(refPx, refW, refH, nW, nH);

  const ref = buildRef(nativePx, nW, nH, true);

  const cx = Math.floor((CAPTURE_SIZE - nW) / 2);
  const cy = Math.floor((CAPTURE_SIZE - nH) / 2);

  const testAngles = [0, -5, -10, -15, -20, -25, -30, 5, 10, 15, 20, 25, 30];
  let anyFail = false;

  for (const angle of testAngles) {
    const rotPx    = MatcherCore.rotatePixels(nativePx, nW, nH, angle);
    const scene    = embed(grayScene(), rotPx, nW, nH, cx, cy);
    const gray     = matcher.fillGrayBuffer(scene);
    const result   = matcher.evaluateReference(ref, scene, gray);
    const label    = `${trigger.id} @${angle}°`;
    if (!result.matched) {
      fail(`${label}: NO MATCH  ratio=${result.ratio.toFixed(3)} threshold=${result.threshold.toFixed(3)}` +
           (result.verifyScore != null ? ` verify=${result.verifyScore.toFixed(3)}` : "") +
           ` resultAngle=${result.angle}`);
      anyFail = true;
    }
  }
  if (!anyFail) pass(`${trigger.id}: matches itself at all ${testAngles.length} test angles`);
}

// ---------------------------------------------------------------------------
// Section 2: False-positive check — no trigger fires on a plain gray scene
// ---------------------------------------------------------------------------

console.log("\n=== False-positive check (plain gray scene, no card) ===\n");

const allRefs = [];
for (const trigger of profile.triggers) {
  if (!trigger.references?.length) continue;
  const ref0 = trigger.references[0];
  if (!ref0.file || !fs.existsSync(path.join(REFS_DIR, ref0.file))) continue;
  const { pixels: refPx, width: refW, height: refH } = loadPng(path.join(REFS_DIR, ref0.file));
  const ref = buildRef(refPx, refW, refH, !!trigger.rotates);
  if (ref.refHash) allRefs.push({ trigger, ref });
}

const bgScene = grayScene(85, 85, 90); // slightly bluish, like STS2 battle background
const bgGray  = matcher.fillGrayBuffer(bgScene);

const triggers = allRefs.map(({ trigger, ref }) => ({
  id: trigger.id,
  payloads: trigger.payloads,
  references: [ref],
}));

const { best: bgBest } = matcher.findBestMatch(triggers, bgScene, bgGray);
if (!bgBest || !bgBest.matched) {
  pass(`No trigger fires on plain gray scene`);
} else {
  fail(`FALSE POSITIVE on gray scene: "${bgBest.trigger.id}" ratio=${bgBest.ratio.toFixed(3)} threshold=${bgBest.threshold.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// Section 3: Cross-trigger isolation — trigger A shouldn't fire on trigger B's ref
// ---------------------------------------------------------------------------

console.log("\n=== Cross-trigger false positives ===\n");

let crossFail = false;
for (const { trigger: tA, ref: refA } of allRefs) {
  for (const { trigger: tB, ref: refB } of allRefs) {
    if (tA.id === tB.id) continue;
    // embed refB's image in scene, check if refA fires
    if (!refB.w || !refB.h) continue;
    const bPath = path.join(REFS_DIR, tB.references[0].file);
    if (!fs.existsSync(bPath)) continue;
    const { pixels: bPx, width: bW, height: bH } = loadPng(bPath);
    const bNative = resize(bPx, bW, bH, refB.w, refB.h);
    const cx = Math.floor((CAPTURE_SIZE - refB.w) / 2);
    const cy = Math.floor((CAPTURE_SIZE - refB.h) / 2);
    const scene = embed(grayScene(), bNative, refB.w, refB.h, cx, cy);
    const gray  = matcher.fillGrayBuffer(scene);
    const result = matcher.evaluateReference(refA, scene, gray);
    if (result.matched) {
      fail(`"${tA.id}" fires on "${tB.id}" scene — ratio=${result.ratio.toFixed(3)} threshold=${result.threshold.toFixed(3)} angle=${result.angle}`);
      crossFail = true;
    }
  }
}
if (!crossFail) pass(`No cross-trigger false positives among ${allRefs.length} refs`);

// ---------------------------------------------------------------------------
// Section 4: Rotation resolution — how many degrees off before match breaks
// ---------------------------------------------------------------------------

console.log("\n=== Rotation resolution (what angle gap causes misses?) ===\n");

for (const trigger of rotatingTriggers.slice(0, 3)) {
  const ref0 = trigger.references[0];
  const refPath = path.join(REFS_DIR, ref0.file);
  if (!fs.existsSync(refPath)) continue;
  const { pixels: refPx, width: refW, height: refH } = loadPng(refPath);
  const nativePx = resize(refPx, refW, refH, refW, refH);
  const ref = buildRef(nativePx, refW, refH, true);
  const cx = Math.floor((CAPTURE_SIZE - refW) / 2);
  const cy = Math.floor((CAPTURE_SIZE - refH) / 2);

  const missAngles = [];
  for (let angle = -35; angle <= 35; angle++) {
    const rotPx = MatcherCore.rotatePixels(nativePx, refW, refH, angle);
    const scene  = embed(grayScene(), rotPx, refW, refH, cx, cy);
    const gray   = matcher.fillGrayBuffer(scene);
    const result = matcher.evaluateReference(ref, scene, gray);
    if (!result.matched) missAngles.push(angle);
  }

  if (missAngles.length === 0) {
    pass(`${trigger.id}: matches every 1° from -35° to +35°`);
  } else {
    warn(`${trigger.id}: misses at ${missAngles.length} angle(s): ${missAngles.join(", ")}°`);
  }
}

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed + warnings} checks: ${passed} passed, ${failed} failed, ${warnings} warnings\n`);
if (failed > 0) process.exit(1);
