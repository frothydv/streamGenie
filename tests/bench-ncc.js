#!/usr/bin/env node
// Benchmark: dHash sliding window vs NCC sliding window vs hybrid.
// Run: node tests/bench-ncc.js
//
// NCC implementation uses a summed-area table (integral image) for O(1) mean
// lookup per window — the dot-product inner loop is still O(refW × refH).

const fs   = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const MatcherCore = require("../extension/matcher-core.js");

const PROFILE_DIR = path.resolve(__dirname, "../../streamGenieProfiles/games/slay-the-spire-2/profiles/community");
const REFS_DIR    = path.join(PROFILE_DIR, "references");
const CAPTURE_SIZE = 160;
const CANONICAL    = MatcherCore.DEFAULTS.canonicalSize;
const RUNS         = 200;  // repetitions for stable timing

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
      const di = (y  * dstW + x)  * 4;
      out[di]=srcPx[si]; out[di+1]=srcPx[si+1]; out[di+2]=srcPx[si+2]; out[di+3]=srcPx[si+3];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// NCC implementation
// ---------------------------------------------------------------------------

// Build summed-area table (SAT) and squared SAT from a gray buffer.
// sat[y*W+x] = sum of gray[0..y-1][0..x-1]  (0-based, 1-indexed in the SAT).
function buildSAT(gray, W, H) {
  const sat  = new Float64Array((W + 1) * (H + 1));
  const sat2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 1; y <= H; y++) {
    for (let x = 1; x <= W; x++) {
      const g = gray[(y - 1) * W + (x - 1)];
      sat [y * (W+1) + x] = g     + sat [(y-1)*(W+1)+x] + sat [y*(W+1)+(x-1)] - sat [(y-1)*(W+1)+(x-1)];
      sat2[y * (W+1) + x] = g * g + sat2[(y-1)*(W+1)+x] + sat2[y*(W+1)+(x-1)] - sat2[(y-1)*(W+1)+(x-1)];
    }
  }
  return { sat, sat2, W };
}

// O(1) sum of gray[ry..ry+rh-1][rx..rx+rw-1] using SAT.
function satSum(sat, W, rx, ry, rw, rh) {
  const W1 = W + 1;
  return sat[(ry+rh)*W1+(rx+rw)] - sat[ry*W1+(rx+rw)] - sat[(ry+rh)*W1+rx] + sat[ry*W1+rx];
}

// Precompute: ref gray values (mean-centred), ref variance.
function buildRefStats(refPx, refW, refH) {
  const n = refW * refH;
  const gray = new Float32Array(n);
  let sumG = 0;
  for (let i = 0; i < n; i++) {
    const v = 0.299 * refPx[i*4] + 0.587 * refPx[i*4+1] + 0.114 * refPx[i*4+2];
    gray[i] = v;
    sumG += v;
  }
  const meanG = sumG / n;
  let varG = 0;
  for (let i = 0; i < n; i++) {
    gray[i] -= meanG;           // centred
    varG += gray[i] * gray[i];
  }
  return { gray, varG };       // gray is mean-centred
}

// NCC score at scene position (sx, sy).
// Returns value in [-1, 1]; 1.0 = perfect match.
function nccAt(sceneGray, sceneW, sat, sat2, sx, sy, refStats, refW, refH) {
  const { gray: refGray, varG: refVar } = refStats;
  const n = refW * refH;

  // O(1) scene mean and variance via SAT
  const sceneSum  = satSum(sat,  sceneW, sx, sy, refW, refH);
  const sceneSum2 = satSum(sat2, sceneW, sx, sy, refW, refH);
  const sceneMean = sceneSum / n;
  const sceneVar  = sceneSum2 - sceneSum * sceneSum / n;

  if (refVar < 1e-6 || sceneVar < 1e-6) return 0;  // flat region

  // Dot product of centred values — O(refW × refH)
  let dot = 0;
  for (let y = 0; y < refH; y++) {
    for (let x = 0; x < refW; x++) {
      const sceneG = sceneGray[(sy + y) * sceneW + (sx + x)] - sceneMean;
      dot += refGray[y * refW + x] * sceneG;
    }
  }

  return dot / Math.sqrt(refVar * sceneVar);
}

// Full NCC sliding window — returns best {x, y, score}.
function nccSlide(scenePixels, sceneGray, sceneW, sceneH, refPx, refW, refH) {
  const { sat, sat2 } = buildSAT(sceneGray, sceneW, sceneH);
  const refStats = buildRefStats(refPx, refW, refH);
  let best = { x: 0, y: 0, score: -1 };
  for (let y = 0; y <= sceneH - refH; y++) {
    for (let x = 0; x <= sceneW - refW; x++) {
      const s = nccAt(sceneGray, sceneW, sat, sat2, x, y, refStats, refW, refH);
      if (s > best.score) best = { x, y, score: s };
    }
  }
  return best;
}

// NCC at a specific set of candidate positions (for the hybrid verification pass).
function nccAtPositions(positions, sceneGray, sceneW, sat, sat2, refStats, refW, refH) {
  let best = { x: 0, y: 0, score: -1 };
  for (const { x, y } of positions) {
    const s = nccAt(sceneGray, sceneW, sat, sat2, x, y, refStats, refW, refH);
    if (s > best.score) best = { x, y, score: s };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

const matcher = MatcherCore.createMatcher({ captureSize: CAPTURE_SIZE });

const capturePath = path.join(__dirname, "fixtures/streamgenie-cap-map.png");
if (!fs.existsSync(capturePath)) {
  console.error("Need tests/fixtures/streamgenie-cap-map.png");
  process.exit(1);
}

const cap = loadPng(capturePath);
const capPixels = new Uint8Array(cap.pixels);
const capGray   = matcher.fillGrayBuffer(capPixels);

// Load map-icon reference
const profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, "profile.json"), "utf8"));
const mapTrigger = profile.triggers.find(t => t.id === "map-icon");
if (!mapTrigger) { console.error("map-icon not in profile"); process.exit(1); }
const refFile = mapTrigger.references[0].file;
const { pixels: refPx, width: refW, height: refH } = loadPng(path.join(REFS_DIR, refFile));
const canPx = resize(refPx, refW, refH, CANONICAL, CANONICAL);
const refHash = matcher.dHashFromPixels(canPx, CANONICAL, 0, 0, CANONICAL, CANONICAL);
const refObj = {
  w: refW, h: refH,
  refHash, refBitMask: null, refValidBits: 64,
  refVerifyValues: null, rotatedHashes: null,
};

const maxX = CAPTURE_SIZE - refW;  // 83
const maxY = CAPTURE_SIZE - refH;  // 87
const totalPositions = (maxX + 1) * (maxY + 1);

console.log(`\nRef: ${refW}×${refH} (map-icon)  →  ${totalPositions} valid positions in 160×160 capture\n`);

// ---------------------------------------------------------------------------
// Timing helper
// ---------------------------------------------------------------------------

function bench(label, fn, runs) {
  // Warmup
  for (let i = 0; i < 5; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const elapsed = performance.now() - t0;
  const perCall = elapsed / runs;
  console.log(`  ${label.padEnd(42)} ${perCall.toFixed(3).padStart(7)} ms/call`);
  return fn();  // return a result for correctness check
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

console.log("=== Sliding-window full scan ===\n");

// 1. dHash full scan (via slidingWindowMatch)
let dHashResult;
bench("dHash full scan", () => {
  dHashResult = matcher.slidingWindowMatch(refObj, capPixels, capGray);
}, RUNS);

// 2. NCC full scan
const refStats = buildRefStats(refPx, refW, refH);
let nccResult;
bench("NCC full scan (with SAT build)", () => {
  const { sat, sat2 } = buildSAT(capGray, CAPTURE_SIZE, CAPTURE_SIZE);
  nccResult = nccSlide(capPixels, capGray, CAPTURE_SIZE, CAPTURE_SIZE, refPx, refW, refH);
}, RUNS);

// 3. NCC full scan, SAT prebuilt (isolate inner loop cost)
const { sat, sat2 } = buildSAT(capGray, CAPTURE_SIZE, CAPTURE_SIZE);
bench("NCC full scan (SAT prebuilt)", () => {
  nccSlide(capPixels, capGray, CAPTURE_SIZE, CAPTURE_SIZE, refPx, refW, refH);
}, RUNS);

// 4. SAT build cost in isolation
bench("SAT build only", () => {
  buildSAT(capGray, CAPTURE_SIZE, CAPTURE_SIZE);
}, RUNS);

console.log(`\n=== Verification pass (16 candidates) ===\n`);

// 5. Simulate hybrid: get dHash coarse candidates, then NCC those positions
// Extract top-16 coarse positions from a manual coarse scan
const coarseStep = 4;
const coarseCandidates = [];
for (let y = 0; y <= maxY; y += coarseStep) {
  for (let x = 0; x <= maxX; x += coarseStep) {
    const h = matcher.dHashFromPixels(capPixels, CAPTURE_SIZE, x, y, refW, refH);
    let dist = 0;
    for (let i = 0; i < 64; i++) if (h[i] !== refHash[i]) dist++;
    coarseCandidates.push({ x, y, dist });
  }
}
coarseCandidates.sort((a, b) => a.dist - b.dist);
const top16 = coarseCandidates.slice(0, 16);
const top1  = coarseCandidates.slice(0, 1);

bench("NCC on top-16 dHash candidates", () => {
  nccAtPositions(top16, capGray, CAPTURE_SIZE, sat, sat2, refStats, refW, refH);
}, RUNS);

bench("NCC on top-1 dHash candidate", () => {
  nccAtPositions(top1, capGray, CAPTURE_SIZE, sat, sat2, refStats, refW, refH);
}, RUNS);

bench("dHash coarse scan only (step=4)", () => {
  const cs = [];
  for (let y = 0; y <= maxY; y += coarseStep) {
    for (let x = 0; x <= maxX; x += coarseStep) {
      const h = matcher.dHashFromPixels(capPixels, CAPTURE_SIZE, x, y, refW, refH);
      let dist = 0;
      for (let i = 0; i < 64; i++) if (h[i] !== refHash[i]) dist++;
      cs.push({ x, y, dist });
    }
  }
  cs.sort((a, b) => a.dist - b.dist);
}, RUNS);

console.log(`\n=== Correctness check ===\n`);
console.log(`  dHash best:  (${dHashResult.x},${dHashResult.y}) dist=${dHashResult.dist}/64`);
console.log(`  NCC best:    (${nccResult.x},${nccResult.y}) score=${nccResult.score.toFixed(4)} (1.0=perfect)`);
const nccTop16 = nccAtPositions(top16, capGray, CAPTURE_SIZE, sat, sat2, refStats, refW, refH);
console.log(`  NCC@top-16:  (${nccTop16.x},${nccTop16.y}) score=${nccTop16.score.toFixed(4)}`);
console.log(`  NCC@coarse-1:(${top1[0].x},${top1[0].y}) dHash dist=${top1[0].dist}`);

console.log(`\n  Top 5 dHash coarse candidates:`);
for (const c of coarseCandidates.slice(0, 5)) {
  const s = nccAt(capGray, CAPTURE_SIZE, sat, sat2, c.x, c.y, refStats, refW, refH);
  console.log(`    (${String(c.x).padStart(2)},${String(c.y).padStart(2)}) dHash dist=${c.dist}  NCC score=${s.toFixed(4)}`);
}

console.log();
