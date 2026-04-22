#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const CAPTURE_SIZE = 160;
const CANONICAL_SIZE = 32;
const MASK_VERIFY_GRID = 16;
const MATCH_THRESHOLD_RATIO = 10 / 64;
const MASKED_MATCH_THRESHOLD_RATIO = 6 / 64;
const MASK_VERIFY_THRESHOLD = 0.16;
const SLIDE_STEP = 1;
const MIN_MASKED_BITS = 16;

const _gray = new Float32Array(72);
const _allBitMask = new Uint8Array(64).fill(1);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function pngToImageData(filePath) {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  return { width: png.width, height: png.height, data: png.data };
}

function clonePng(image) {
  return new PNG({
    width: image.width,
    height: image.height,
    data: Buffer.from(image.data),
  });
}

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

function buildVerifyRefFromPixels(refPixels, maskPixels) {
  const gray = new Float32Array(MASK_VERIFY_GRID * MASK_VERIFY_GRID);
  const mask = new Uint8Array(MASK_VERIFY_GRID * MASK_VERIFY_GRID);
  let active = 0;
  for (let y = 0; y < MASK_VERIFY_GRID; y++) {
    for (let x = 0; x < MASK_VERIFY_GRID; x++) {
      const px = Math.min(CANONICAL_SIZE - 1, Math.floor(((x + 0.5) * CANONICAL_SIZE) / MASK_VERIFY_GRID));
      const py = Math.min(CANONICAL_SIZE - 1, Math.floor(((y + 0.5) * CANONICAL_SIZE) / MASK_VERIFY_GRID));
      const idx = y * MASK_VERIFY_GRID + x;
      const pixelIdx = (py * CANONICAL_SIZE + px) * 4;
      gray[idx] = 0.299 * refPixels[pixelIdx] + 0.587 * refPixels[pixelIdx + 1] + 0.114 * refPixels[pixelIdx + 2];
      const alpha = maskPixels ? maskPixels[pixelIdx + 3] : 255;
      mask[idx] = alpha >= 128 ? 1 : 0;
      active += mask[idx];
    }
  }
  return { gray, mask, active };
}

function maskedVerifyScoreFromPixels(pixels, srcW, sx, sy, sw, sh, refVerifyGray, refVerifyMask, refVerifyActive) {
  if (!refVerifyGray || !refVerifyMask || !refVerifyActive) return { score: 1, active: 0 };
  let total = 0;
  for (let y = 0; y < MASK_VERIFY_GRID; y++) {
    for (let x = 0; x < MASK_VERIFY_GRID; x++) {
      const idx = y * MASK_VERIFY_GRID + x;
      if (!refVerifyMask[idx]) continue;
      const px = sx + Math.min(sw - 1, Math.max(0, Math.floor(((x + 0.5) * sw) / MASK_VERIFY_GRID)));
      const py = sy + Math.min(sh - 1, Math.max(0, Math.floor(((y + 0.5) * sh) / MASK_VERIFY_GRID)));
      const pixelIdx = (py * srcW + px) * 4;
      const gray = 0.299 * pixels[pixelIdx] + 0.587 * pixels[pixelIdx + 1] + 0.114 * pixels[pixelIdx + 2];
      total += Math.abs(gray - refVerifyGray[idx]);
    }
  }
  return { score: total / (refVerifyActive * 255), active: refVerifyActive };
}

function matchThresholdForRef(ref) {
  return ref.refValidBits < 64 ? MASKED_MATCH_THRESHOLD_RATIO : MATCH_THRESHOLD_RATIO;
}

function verifyThresholdForRef(ref) {
  return ref.refValidBits < 64 ? MASK_VERIFY_THRESHOLD : null;
}

function profileDirFromFixture(fixture, repoRoot) {
  if (fixture.profileDir) return path.resolve(repoRoot, fixture.profileDir);
  return path.resolve(
    repoRoot,
    "..",
    "streamGenieProfiles",
    "games",
    fixture.gameId,
    "profiles",
    fixture.profileId
  );
}

function loadMaskPixels(ref) {
  if (!ref.maskDataUrl) return null;
  const prefix = "data:image/png;base64,";
  if (!ref.maskDataUrl.startsWith(prefix)) return null;
  const buf = Buffer.from(ref.maskDataUrl.slice(prefix.length), "base64");
  return PNG.sync.read(buf).data;
}

function loadProfileReferences(profileDir) {
  const profile = readJson(path.join(profileDir, "profile.json"));
  return profile.triggers.flatMap((trigger) =>
    (trigger.references || []).map((ref, refIndex) => ({
      triggerId: trigger.id,
      title: trigger.payloads?.[0]?.title || trigger.id,
      payloads: trigger.payloads || [],
      refIndex,
      ...ref,
    }))
  );
}

function buildReferenceRuntime(ref, profileDir, targetVideoWidth) {
  const imagePath = path.join(profileDir, "references", ref.file);
  const image = pngToImageData(imagePath);

  let w = ref.w || image.width;
  let h = ref.h || image.height;
  if (targetVideoWidth && ref.srcW) {
    const scale = targetVideoWidth / ref.srcW;
    w = Math.max(1, Math.round((ref.w || image.width) * scale));
    h = Math.max(1, Math.round((ref.h || image.height) * scale));
  }

  const refHash = dHashFromPixels(image.data, image.width, 0, 0, image.width, image.height);

  let refBitMask = new Uint8Array(_allBitMask);
  let refValidBits = 64;
  let refVerifyGray = null;
  let refVerifyMask = null;
  let refVerifyActive = 0;

  const maskPixels = loadMaskPixels(ref);
  if (maskPixels) {
    const maskBits = maskBitsFromPixels(maskPixels, image.width, 0, 0, image.width, image.height);
    refBitMask = maskBits.bits;
    refValidBits = maskBits.validBits;
    const verify = buildVerifyRefFromPixels(image.data, maskPixels);
    refVerifyGray = verify.gray;
    refVerifyMask = verify.mask;
    refVerifyActive = verify.active;
  }

  return {
    ...ref,
    origW: image.width,
    origH: image.height,
    w,
    h,
    refHash,
    refBitMask,
    refValidBits,
    refVerifyGray,
    refVerifyMask,
    refVerifyActive,
  };
}

function extractCapturePixels(image, centerX, centerY) {
  const pixels = new Uint8ClampedArray(CAPTURE_SIZE * CAPTURE_SIZE * 4);
  const half = CAPTURE_SIZE / 2;
  for (let cy = 0; cy < CAPTURE_SIZE; cy++) {
    for (let cx = 0; cx < CAPTURE_SIZE; cx++) {
      const srcX = centerX - half + cx;
      const srcY = centerY - half + cy;
      const srcIdx = (srcY * image.width + srcX) * 4;
      const dstIdx = (cy * CAPTURE_SIZE + cx) * 4;
      pixels[dstIdx] = image.data[srcIdx];
      pixels[dstIdx + 1] = image.data[srcIdx + 1];
      pixels[dstIdx + 2] = image.data[srcIdx + 2];
      pixels[dstIdx + 3] = image.data[srcIdx + 3];
    }
  }
  return pixels;
}

function slidingWindowMatch(ref, capturePixels) {
  if (!ref.refHash || ref.w > CAPTURE_SIZE || ref.h > CAPTURE_SIZE) {
    return { dist: 64, ratio: 1, validBits: ref.refValidBits ?? 64, x: 0, y: 0, verifyScore: null };
  }
  let best = { dist: 64, ratio: 1, validBits: ref.refValidBits ?? 64, x: 0, y: 0, verifyScore: null };
  for (let y = 0; y <= CAPTURE_SIZE - ref.h; y += SLIDE_STEP) {
    for (let x = 0; x <= CAPTURE_SIZE - ref.w; x += SLIDE_STEP) {
      const result = dHashDistFromPixels(capturePixels, CAPTURE_SIZE, x, y, ref.w, ref.h, ref.refHash, ref.refBitMask, ref.refValidBits);
      if (result.ratio < best.ratio || (result.ratio === best.ratio && result.dist < best.dist)) {
        const verify = ref.refVerifyGray
          ? maskedVerifyScoreFromPixels(capturePixels, CAPTURE_SIZE, x, y, ref.w, ref.h, ref.refVerifyGray, ref.refVerifyMask, ref.refVerifyActive)
          : null;
        best = { ...result, x, y, verifyScore: verify ? verify.score : null };
      }
    }
  }
  return best;
}

function classifyPoint(regions, x, y, defaultRegion) {
  for (const region of regions) {
    if (x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h) return region;
  }
  return defaultRegion;
}

function summarizeBuckets(bucket, topN = 5) {
  const sorted = [...bucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  return sorted.map(([k, v]) => `${k}:${v}`).join(", ");
}

function analyzeFixture(fixture, image, refs) {
  const step = fixture.gridStep || 5;
  const regions = fixture.regions || [];
  const defaultRegion = { name: fixture.defaultRegion?.name || "unlabeled", type: fixture.defaultRegion?.type || "ignore" };
  const perRegion = new Map();
  const points = [];
  const scanPoints = [];
  const startedAt = Date.now();

  for (let y = CAPTURE_SIZE / 2; y < image.height - CAPTURE_SIZE / 2; y += step) {
    for (let x = CAPTURE_SIZE / 2; x < image.width - CAPTURE_SIZE / 2; x += step) {
      const region = classifyPoint(regions, x, y, defaultRegion);
      if (region.type !== "ignore") scanPoints.push({ x, y, region });
    }
  }

  console.log(`Scanning ${scanPoints.length} points at ${step}px grid with ${refs.length} refs...`);

  const progressEvery = Math.max(10, Math.floor(scanPoints.length / 100));

  for (let index = 0; index < scanPoints.length; index++) {
    const { x, y, region } = scanPoints[index];

    const capturePixels = extractCapturePixels(image, x, y);
    const candidates = refs.map((ref) => {
      const match = slidingWindowMatch(ref, capturePixels);
      const hashThreshold = matchThresholdForRef(ref);
      const verifyThreshold = verifyThresholdForRef(ref);
      const matched =
        match.ratio <= hashThreshold &&
        match.validBits >= MIN_MASKED_BITS &&
        (verifyThreshold == null || (match.verifyScore != null && match.verifyScore <= verifyThreshold));
      return {
        triggerId: ref.triggerId,
        title: ref.title,
        ratio: match.ratio,
        dist: match.dist,
        validBits: match.validBits,
        verifyScore: match.verifyScore,
        hashThreshold,
        verifyThreshold,
        matched,
      };
    }).sort((a, b) => a.ratio - b.ratio || a.dist - b.dist);

    const best = candidates[0];
    const point = { x, y, region: region.name, expected: region.triggerId || null, type: region.type, best, top3: candidates.slice(0, 3) };
    points.push(point);

    if (!perRegion.has(region.name)) {
      perRegion.set(region.name, {
        region,
        total: 0,
        correct: 0,
        matched: 0,
        falsePositive: 0,
        falseNegative: 0,
        winners: new Map(),
        misses: [],
      });
    }
    const bucket = perRegion.get(region.name);
    bucket.total++;
    bucket.winners.set(best.triggerId, (bucket.winners.get(best.triggerId) || 0) + 1);

    if (best.matched) bucket.matched++;

    if (region.type === "expect") {
      if (best.matched && best.triggerId === region.triggerId) bucket.correct++;
      else bucket.falseNegative++;
    } else if (region.type === "negative") {
      if (best.matched) bucket.falsePositive++;
    }

    if (
      (region.type === "expect" && !(best.matched && best.triggerId === region.triggerId)) ||
      (region.type === "negative" && best.matched)
    ) {
      bucket.misses.push(point);
    }

    if ((index + 1) % progressEvery === 0 || index === scanPoints.length - 1) {
      const pct = (((index + 1) / scanPoints.length) * 100).toFixed(1);
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const pointsDone = index + 1;
      const matchAttempts = pointsDone * refs.length;
      const secPerPoint = elapsedSec / pointsDone;
      const secPerAttempt = elapsedSec / matchAttempts;
      const pointsPerSec = pointsDone / elapsedSec;
      process.stdout.write(
        `  progress ${pointsDone}/${scanPoints.length} (${pct}%)` +
        ` | elapsed ${elapsedSec.toFixed(1)}s` +
        ` | ${secPerPoint.toFixed(4)} s/point` +
        ` | ${secPerAttempt.toFixed(5)} s/attempt` +
        ` | ${pointsPerSec.toFixed(2)} points/s\n`
      );
    }
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const totalAttempts = scanPoints.length * refs.length;
  return {
    points,
    perRegion,
    metrics: {
      elapsedSec,
      scanPoints: scanPoints.length,
      refsPerPoint: refs.length,
      totalAttempts,
      secPerPoint: scanPoints.length ? elapsedSec / scanPoints.length : 0,
      secPerAttempt: totalAttempts ? elapsedSec / totalAttempts : 0,
      pointsPerSec: elapsedSec ? scanPoints.length / elapsedSec : 0,
      attemptsPerSec: elapsedSec ? totalAttempts / elapsedSec : 0,
    },
  };
}

function drawRect(png, x, y, w, h, rgba) {
  for (let px = x; px < x + w; px++) {
    setPixel(png, px, y, rgba);
    setPixel(png, px, y + h - 1, rgba);
  }
  for (let py = y; py < y + h; py++) {
    setPixel(png, x, py, rgba);
    setPixel(png, x + w - 1, py, rgba);
  }
}

function setPixel(png, x, y, rgba) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (y * png.width + x) * 4;
  png.data[idx] = rgba[0];
  png.data[idx + 1] = rgba[1];
  png.data[idx + 2] = rgba[2];
  png.data[idx + 3] = rgba[3];
}

function drawDot(png, x, y, rgba, radius = 2) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) setPixel(png, x + dx, y + dy, rgba);
    }
  }
}

function writeVisualization(fixturePath, image, fixture, analysis) {
  const out = clonePng(image);
  const colorByType = {
    expect: [0, 200, 255, 255],
    negative: [255, 255, 255, 255],
  };
  for (const region of fixture.regions || []) {
    drawRect(out, region.x, region.y, region.w, region.h, colorByType[region.type] || [180, 180, 180, 255]);
  }

  for (const point of analysis.points) {
    let color;
    if (point.type === "expect") {
      color = point.best.matched && point.best.triggerId === point.expected
        ? [0, 255, 0, 255]
        : [255, 0, 0, 255];
    } else if (point.type === "negative") {
      color = point.best.matched ? [255, 0, 255, 255] : [120, 120, 120, 255];
    } else {
      color = [80, 80, 80, 255];
    }
    drawDot(out, point.x, point.y, color, 2);
  }

  const outPath = path.resolve(path.dirname(fixturePath), `${path.basename(fixturePath, path.extname(fixturePath))}-results.png`);
  fs.writeFileSync(outPath, PNG.sync.write(out));
  console.log(`\nVisualization written to ${outPath}`);
}

function printReport(fixture, analysis) {
  console.log(`\n=== ${fixture.name || path.basename(fixture.imagePath)} ===`);
  console.log(`grid: ${fixture.gridStep || 5}px`);
  if (analysis.metrics) {
    console.log(
      `timing: ${analysis.metrics.elapsedSec.toFixed(1)}s total` +
      ` | ${analysis.metrics.secPerPoint.toFixed(4)} s/point` +
      ` | ${analysis.metrics.secPerAttempt.toFixed(5)} s/attempt` +
      ` | ${analysis.metrics.pointsPerSec.toFixed(2)} points/s` +
      ` | ${analysis.metrics.attemptsPerSec.toFixed(2)} attempts/s`
    );
  }
  for (const bucket of analysis.perRegion.values()) {
    console.log(`\nRegion: ${bucket.region.name} (${bucket.region.type})`);
    console.log(`  points: ${bucket.total}`);
    if (bucket.region.type === "expect") {
      const rate = bucket.total ? ((bucket.correct / bucket.total) * 100).toFixed(1) : "0.0";
      console.log(`  expected trigger: ${bucket.region.triggerId}`);
      console.log(`  correct hits: ${bucket.correct}/${bucket.total} (${rate}%)`);
      console.log(`  misses: ${bucket.falseNegative}`);
    } else if (bucket.region.type === "negative") {
      const rate = bucket.total ? ((bucket.falsePositive / bucket.total) * 100).toFixed(1) : "0.0";
      console.log(`  false positives: ${bucket.falsePositive}/${bucket.total} (${rate}%)`);
    }
    console.log(`  winning triggers: ${summarizeBuckets(bucket.winners)}`);
    if (bucket.misses.length) {
      console.log(`  sample anomalies:`);
      for (const miss of bucket.misses.slice(0, 5)) {
        const best = miss.best;
        const verifyText = best.verifyThreshold != null && best.verifyScore != null
          ? ` v=${Math.round(best.verifyScore * 100)}<=${Math.round(best.verifyThreshold * 100)}`
          : "";
        console.log(`    (${miss.x},${miss.y}) -> ${best.matched ? "MATCH" : "MISS"} ${best.triggerId} ${Math.round(best.ratio * 100)}% (${best.dist}/${best.validBits}) <= ${Math.round(best.hashThreshold * 100)}%${verifyText}`);
      }
    }
  }
}

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error("Usage: node test-matching-node.js <fixture.json>");
    process.exit(1);
  }

  const repoRoot = __dirname;
  const fixture = readJson(path.resolve(repoRoot, fixturePath));
  const profileDir = profileDirFromFixture(fixture, repoRoot);
  const image = pngToImageData(path.resolve(repoRoot, fixture.imagePath));
  const rawRefs = loadProfileReferences(profileDir);
  const refs = rawRefs.map((ref) => buildReferenceRuntime(ref, profileDir, fixture.videoWidth || image.width));

  const analysis = analyzeFixture(fixture, image, refs);
  printReport(fixture, analysis);
  writeVisualization(path.resolve(repoRoot, fixturePath), image, fixture, analysis);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
