(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.StreamGenieMatcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DEFAULTS = {
    captureSize: 160,
    canonicalSize: 32,
    maskVerifyGrid: 16,
    matchThresholdRatio: 10 / 64,
    maskedMatchThresholdRatio: 6 / 64,
    rotationMatchThresholdRatio: 7 / 64,
    maskVerifyThreshold: 0.16,
    maskVerifyThresholdMidBits: 0.14,
    maskVerifyThresholdLowBits: 0.12,
    unmaskedVerifyThreshold: 0.16,
    slideStep: 1,
    coarseStep: 4,
    coarseCandidates: 16,
    coarseThresholdFactor: 1.5,
    minMaskedBits: 16,
    centerBiasWeight: 0.01,
    maskedCenterBiasWeight: 0.018,
    // NCC (Normalized Cross-Correlation) verification threshold.
    // NCC runs on the dHash-best position as a secondary match criterion.
    // Unlike dHash, NCC normalizes for local mean and variance, making it
    // immune to H.264 brightness shifts that cause dHash near-misses on live streams.
    // A true match typically scores ≥ 0.85; unrelated content scores ≤ 0.3.
    nccMatchThreshold: 0.65,
    // Rotation: angles (degrees) tried when trigger.rotates = true.
    // Fine (±1°–±5°) + coarse (±5°–±30° at 5° steps), skipping 0° (handled by base hash).
    rotationAngles: [-30, -25, -20, -15, -10, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 10, 15, 20, 25, 30],
    // Two-pass matching: Phase 2 rotation runs for all rotating triggers whose Phase 1
    // dist is within rotationDistWindow bits of the closest Phase 1 miss. This is
    // adaptive: scenes with nothing card-like have best-dist ~30+, so the window
    // contains nothing and Phase 2 cost is zero. Scenes with a rotated card include
    // all similar candidates automatically, regardless of total trigger count.
    // rotationCandidateMax is a hard cap to bound worst-case cost.
    rotationDistWindow: 10,
    rotationCandidateMax: 50,
  };

  // Pure-JS bilinear rotation of an RGBA pixel buffer.
  // Output is the same w×h; out-of-bounds pixels are transparent/black.
  function rotatePixels(srcPixels, srcW, srcH, angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = srcW / 2;
    const cy = srcH / 2;
    const dst = new Uint8Array(srcW * srcH * 4);
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const dx = x - cx, dy = y - cy;
        // Inverse-rotate to find source pixel
        const sx = cos * dx + sin * dy + cx;
        const sy = -sin * dx + cos * dy + cy;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const x1 = x0 + 1,        y1 = y0 + 1;
        if (x0 < 0 || y0 < 0 || x1 >= srcW || y1 >= srcH) continue; // leaves dst as 0
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * srcW + x0) * 4;
        const i10 = (y0 * srcW + x1) * 4;
        const i01 = (y1 * srcW + x0) * 4;
        const i11 = (y1 * srcW + x1) * 4;
        const dstIdx = (y * srcW + x) * 4;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        dst[dstIdx]     = Math.round(srcPixels[i00]     * w00 + srcPixels[i10]     * w10 + srcPixels[i01]     * w01 + srcPixels[i11]     * w11);
        dst[dstIdx + 1] = Math.round(srcPixels[i00 + 1] * w00 + srcPixels[i10 + 1] * w10 + srcPixels[i01 + 1] * w01 + srcPixels[i11 + 1] * w11);
        dst[dstIdx + 2] = Math.round(srcPixels[i00 + 2] * w00 + srcPixels[i10 + 2] * w10 + srcPixels[i01 + 2] * w01 + srcPixels[i11 + 2] * w11);
        dst[dstIdx + 3] = 255;
      }
    }
    return dst;
  }

  // Given RGBA pixels for a reference at native dimensions (refW×refH), pre-compute
  // hashes for each rotation angle. Rotation happens at native size to preserve the
  // ref's aspect ratio. Sampling uses the same double-floor formula as buildHashSamples
  // so comparison against scene windows is consistent.
  // canonicalSize defaults to 32 (matches DEFAULTS.canonicalSize).
  function computeRotatedHashes(refPixels, refW, refH, angles, canonicalSize) {
    const cs = canonicalSize || 32;
    return angles.map(angleDeg => {
      const rotated = rotatePixels(refPixels, refW, refH, angleDeg);
      const scratch = new Float32Array(72);
      // Collect sample positions so we can check alpha (in-bounds) per-bit below.
      const samplePX = new Int32Array(72);
      const samplePY = new Int32Array(72);
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 9; dx++) {
          // Mirror buildHashSamples: map through canonical coords first so
          // sample positions exactly match what dHashDistFromGray uses on the scene.
          const cx = Math.floor((dx * cs) / 9);
          const cy = Math.floor((dy * cs) / 8);
          const px = Math.floor((cx * refW) / cs);
          const py = Math.floor((cy * refH) / cs);
          const idx = dy * 9 + dx;
          samplePX[idx] = px;
          samplePY[idx] = py;
          const i = (py * refW + px) * 4;
          scratch[idx] = 0.299 * rotated[i] + 0.587 * rotated[i + 1] + 0.114 * rotated[i + 2];
        }
      }
      // Build hash bits and a clip mask.  Each dHash bit compares scratch[y*9+x] vs
      // scratch[y*9+x+1].  If either sample pixel was outside the rotation bounds
      // (alpha === 0 from rotatePixels), the comparison is against black — unreliable.
      // Mask those bits out so they don't count as mismatches when matched to the scene.
      const bits = new Uint8Array(64);
      const clipMask = new Uint8Array(64);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const lIdx = y * 9 + x;
          const rIdx = lIdx + 1;
          const lAlpha = rotated[(samplePY[lIdx] * refW + samplePX[lIdx]) * 4 + 3];
          const rAlpha = rotated[(samplePY[rIdx] * refW + samplePX[rIdx]) * 4 + 3];
          const bitIdx = y * 8 + x;
          bits[bitIdx] = scratch[rIdx] > scratch[lIdx] ? 1 : 0;
          clipMask[bitIdx] = (lAlpha === 255 && rAlpha === 255) ? 1 : 0;
        }
      }
      const validCount = clipMask.reduce((s, b) => s + b, 0);
      return { angle: angleDeg, hash: bits, clipMask, validCount };
    });
  }

  // Convert a trigger's rotation descriptor into the angle array passed to
  // computeRotatedHashes.  Phase 1 covers the ref at 0° (as captured), so 0 is
  // always excluded from the returned list.
  //
  // rotation can be:
  //   null / false / {mode:'none'}   → no rotation → returns null
  //   true (legacy rotates:true)     → free ±30° + fine ±1°–±4°
  //   {mode:'orthogonal'}            → [90, 180, 270]
  //   {mode:'free', minAngle?, maxAngle?, step?, fineStepNearZero?}
  function anglesForRotation(rotation) {
    if (!rotation || rotation === false) return null;
    if (typeof rotation === "object" && rotation.mode === "none") return null;

    // Legacy: rotates:true → same as DEFAULTS.rotationAngles
    if (rotation === true) return DEFAULTS.rotationAngles.slice();

    const mode = rotation.mode || "free";
    if (mode === "none") return null;

    if (mode === "orthogonal") {
      // Cards that appear at 90° increments; Phase 1 covers 0°.
      return [90, 180, 270];
    }

    // Free mode — build from explicit params or fall back to defaults.
    // baseAngle is "preview only" — it does not shift the search range.
    // Phase 1 covers 0° (the ref as-captured at baseAngle). Phase 2 adds the range
    // as *additional* rotations applied to the already-at-baseAngle ref.
    const minAngle = rotation.minAngle !== undefined ? rotation.minAngle : -30;
    const maxAngle = rotation.maxAngle !== undefined ? rotation.maxAngle : 30;
    const step     = rotation.step     !== undefined ? rotation.step     : 5;
    const fineStepNearZero = rotation.fineStepNearZero !== false; // default true

    const angleSet = new Set();
    for (let a = minAngle; a <= maxAngle + 0.001; a += step) {
      const r = Math.round(a * 10) / 10;
      if (r !== 0) angleSet.add(r);
    }
    if (fineStepNearZero) {
      for (let a = -4; a <= 4; a++) {
        if (a !== 0) angleSet.add(a);
      }
    }
    return [...angleSet].sort((a, b) => a - b);
  }

  function createMatcher(options = {}) {
    const config = { ...DEFAULTS, ...options };
    const grayScratch = new Float32Array(72);
    const allBitMask = new Uint8Array(64).fill(1);

    function createGrayBuffer() {
      return new Float32Array(config.captureSize * config.captureSize);
    }

    function fillGrayBuffer(pixels, out) {
      const gray = out || new Float32Array(pixels.length / 4);
      for (let src = 0, dst = 0; src < pixels.length; src += 4, dst++) {
        gray[dst] = 0.299 * pixels[src] + 0.587 * pixels[src + 1] + 0.114 * pixels[src + 2];
      }
      return gray;
    }

    function buildHashSamples(sw, sh) {
      const sampleX = new Int16Array(72);
      const sampleY = new Int16Array(72);
      let i = 0;
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 9; dx++) {
          const cx = Math.floor((dx * config.canonicalSize) / 9);
          const cy = Math.floor((dy * config.canonicalSize) / 8);
          sampleX[i] = Math.floor((cx * sw) / config.canonicalSize);
          sampleY[i] = Math.floor((cy * sh) / config.canonicalSize);
          i++;
        }
      }
      return { sampleX, sampleY };
    }

    function buildVerifySamples(sw, sh) {
      const count = config.maskVerifyGrid * config.maskVerifyGrid;
      const sampleX = new Int16Array(count);
      const sampleY = new Int16Array(count);
      let i = 0;
      for (let y = 0; y < config.maskVerifyGrid; y++) {
        for (let x = 0; x < config.maskVerifyGrid; x++) {
          sampleX[i] = Math.min(sw - 1, Math.max(0, Math.floor(((x + 0.5) * sw) / config.maskVerifyGrid)));
          sampleY[i] = Math.min(sh - 1, Math.max(0, Math.floor(((y + 0.5) * sh) / config.maskVerifyGrid)));
          i++;
        }
      }
      return { sampleX, sampleY };
    }

    function ensureRefRuntime(ref) {
      if (!ref.hashSampleX || ref.hashSampleW !== ref.w || ref.hashSampleH !== ref.h) {
        const hashSamples = buildHashSamples(ref.w, ref.h);
        ref.hashSampleX = hashSamples.sampleX;
        ref.hashSampleY = hashSamples.sampleY;
        ref.hashSampleW = ref.w;
        ref.hashSampleH = ref.h;
      }
      if (ref.refVerifyValues && (!ref.verifySampleX || ref.verifySampleW !== ref.w || ref.verifySampleH !== ref.h)) {
        const verifySamples = buildVerifySamples(ref.w, ref.h);
        ref.verifySampleX = verifySamples.sampleX;
        ref.verifySampleY = verifySamples.sampleY;
        ref.verifySampleW = ref.w;
        ref.verifySampleH = ref.h;
      }
    }

    // Summed-area table (SAT) and squared SAT for O(1) rectangular mean/variance.
    // Build once per hover event in findBestMatch; thread into evaluateReference.
    function buildSAT(grayBuffer, W, H) {
      const W1 = W + 1;
      const sat  = new Float64Array(W1 * (H + 1));
      const sat2 = new Float64Array(W1 * (H + 1));
      for (let y = 1; y <= H; y++) {
        for (let x = 1; x <= W; x++) {
          const g = grayBuffer[(y - 1) * W + (x - 1)];
          sat [y * W1 + x] = g     + sat [(y-1)*W1+x] + sat [y*W1+(x-1)] - sat [(y-1)*W1+(x-1)];
          sat2[y * W1 + x] = g * g + sat2[(y-1)*W1+x] + sat2[y*W1+(x-1)] - sat2[(y-1)*W1+(x-1)];
        }
      }
      return { sat, sat2 };
    }

    function satRectSum(sat, W, rx, ry, rw, rh) {
      const W1 = W + 1;
      return sat[(ry+rh)*W1+(rx+rw)] - sat[ry*W1+(rx+rw)] - sat[(ry+rh)*W1+rx] + sat[ry*W1+rx];
    }

    // Pre-compute mean-centred ref gray values and variance for NCC.
    // refPixels: RGBA Uint8Array at native ref dimensions (refW×refH).
    // Returns { gray: Float32Array (mean-centred luma), varG: number }.
    // Pre-compute mean-centred ref gray values and variance for NCC.
    // refPixels: RGBA Uint8Array at native ref dimensions (refW×refH).
    // maskPx: optional RGBA Uint8Array at same dimensions; only pixels with
    //         alpha > 0 contribute to stats. Pass null for no mask.
    // Returns { gray, varG, activeIndices } where activeIndices is non-null
    // when a mask was provided.
    function buildRefNCC(refPixels, refW, refH, maskPx) {
      const n = refW * refH;
      const gray = new Float32Array(n);
      const masked = maskPx ? new Uint8Array(n) : null;
      let activeCount = 0;
      let sumG = 0;
      for (let i = 0; i < n; i++) {
        const active = !maskPx || maskPx[i*4+3] > 0;
        if (masked) masked[i] = active ? 1 : 0;
        if (active) {
          const v = 0.299 * refPixels[i*4] + 0.587 * refPixels[i*4+1] + 0.114 * refPixels[i*4+2];
          gray[i] = v;
          sumG += v;
          activeCount++;
        } else {
          gray[i] = 0;
        }
      }
      if (masked && activeCount === 0) {
        // Degenerate mask: nothing active. Return unmasked stats as fallback.
        return buildRefNCC(refPixels, refW, refH, null);
      }
      const denom = masked ? activeCount : n;
      const meanG = denom > 0 ? sumG / denom : 0;
      let varG = 0;
      if (masked) {
        for (let i = 0; i < n; i++) {
          if (masked[i]) {
            gray[i] -= meanG;
            varG += gray[i] * gray[i];
          } else {
            gray[i] = 0;
          }
        }
      } else {
        for (let i = 0; i < n; i++) {
          gray[i] -= meanG;
          varG += gray[i] * gray[i];
        }
      }
      // Build compact activeIndex list for fast iteration in nccScoreAt.
      let activeIdx = null;
      if (masked && activeCount > 0 && activeCount < n) {
        activeIdx = new Uint32Array(activeCount);
        let j = 0;
        for (let i = 0; i < n; i++) {
          if (masked[i]) activeIdx[j++] = i;
        }
      }
      return { gray, varG, activeIndices: activeIdx };
    }

    // NCC score at scene position (sx, sy). Returns value in [-1, 1].
    // Flat regions (low variance) return 0 to avoid false positives.
    function nccScoreAt(sceneGray, sceneW, sat, sat2, sx, sy, refNCC, refW, refH) {
      const { gray, varG, activeIndices } = refNCC;
      if (activeIndices) {
        // Masked NCC: compute scene mean/variance over ONLY the masked
        // positions at this offset. Can't use SAT shortcut — need per-pixel.
        const n = activeIndices.length;
        let sceneSum = 0, sceneSum2 = 0;
        for (let k = 0; k < n; k++) {
          const ai = activeIndices[k];
          const sceneIdx = (sy + Math.floor(ai / refW)) * sceneW + (sx + (ai % refW));
          const v = sceneGray[sceneIdx];
          sceneSum += v;
          sceneSum2 += v * v;
        }
        const sceneMean = sceneSum / n;
        const sceneVar  = sceneSum2 - sceneSum * sceneSum / n;
        if (varG < 1e-6 || sceneVar < 1e-6) return 0;
        let dot = 0;
        for (let k = 0; k < n; k++) {
          const ai = activeIndices[k];
          const sceneIdx = (sy + Math.floor(ai / refW)) * sceneW + (sx + (ai % refW));
          dot += gray[ai] * (sceneGray[sceneIdx] - sceneMean);
        }
        return dot / Math.sqrt(varG * sceneVar);
      }
      const { gray: g } = refNCC;
      const n = refW * refH;
      const sceneSum  = satRectSum(sat,  sceneW, sx, sy, refW, refH);
      const sceneSum2 = satRectSum(sat2, sceneW, sx, sy, refW, refH);
      const sceneMean = sceneSum / n;
      const sceneVar  = sceneSum2 - sceneSum * sceneSum / n;
      if (varG < 1e-6 || sceneVar < 1e-6) return 0;
      let dot = 0;
      for (let y = 0; y < refH; y++) {
        for (let x = 0; x < refW; x++) {
          dot += g[y * refW + x] * (sceneGray[(sy + y) * sceneW + (sx + x)] - sceneMean);
        }
      }
      return dot / Math.sqrt(varG * sceneVar);
    }

    function dHashFromPixels(pixels, srcW, sx, sy, sw, sh) {
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 9; dx++) {
          const cx = Math.floor((dx * config.canonicalSize) / 9);
          const cy = Math.floor((dy * config.canonicalSize) / 8);
          const px = sx + Math.floor((cx * sw) / config.canonicalSize);
          const py = sy + Math.floor((cy * sh) / config.canonicalSize);
          const i = (py * srcW + px) * 4;
          grayScratch[dy * 9 + dx] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        }
      }
      const bits = new Uint8Array(64);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          bits[y * 8 + x] = grayScratch[y * 9 + x + 1] > grayScratch[y * 9 + x] ? 1 : 0;
        }
      }
      return bits;
    }

    function dHashDistFromGray(grayBuffer, srcW, sx, sy, refHash, refBitMask, refValidBits, sampleX, sampleY) {
      for (let i = 0; i < 72; i++) {
        grayScratch[i] = grayBuffer[(sy + sampleY[i]) * srcW + (sx + sampleX[i])];
      }
      const mask = refBitMask || allBitMask;
      const validBits = refValidBits ?? 64;
      if (validBits < config.minMaskedBits) return { dist: 64, validBits, ratio: 1 };
      let dist = 0;
      for (let i = 0; i < 64; i++) {
        if (!mask[i]) continue;
        const y = Math.floor(i / 8);
        const x = i % 8;
        const bit = grayScratch[y * 9 + x + 1] > grayScratch[y * 9 + x] ? 1 : 0;
        if (bit !== refHash[i]) dist++;
      }
      return { dist, validBits, ratio: dist / validBits };
    }

    function maskBitsFromPixels(maskPixels, srcW, sx, sy, sw, sh) {
      const bits = new Uint8Array(64);
      let validBits = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const leftCx = Math.floor((x * config.canonicalSize) / 9);
          const rightCx = Math.floor(((x + 1) * config.canonicalSize) / 9);
          const cy = Math.floor((y * config.canonicalSize) / 8);
          const leftPx = sx + Math.floor((leftCx * sw) / config.canonicalSize);
          const rightPx = sx + Math.floor((rightCx * sw) / config.canonicalSize);
          const py = sy + Math.floor((cy * sh) / config.canonicalSize);
          const leftA = maskPixels[(py * srcW + leftPx) * 4 + 3];
          const rightA = maskPixels[(py * srcW + rightPx) * 4 + 3];
          const idx = y * 8 + x;
          bits[idx] = leftA >= 128 && rightA >= 128 ? 1 : 0;
          validBits += bits[idx];
        }
      }
      return { bits, validBits };
    }

    function buildVerifyRefFromPixels(refPixels, maskPixels) {
      const values = new Uint8Array(config.maskVerifyGrid * config.maskVerifyGrid * 3);
      const mask = new Uint8Array(config.maskVerifyGrid * config.maskVerifyGrid);
      let active = 0;
      for (let y = 0; y < config.maskVerifyGrid; y++) {
        for (let x = 0; x < config.maskVerifyGrid; x++) {
          const px = Math.min(
            config.canonicalSize - 1,
            Math.floor(((x + 0.5) * config.canonicalSize) / config.maskVerifyGrid)
          );
          const py = Math.min(
            config.canonicalSize - 1,
            Math.floor(((y + 0.5) * config.canonicalSize) / config.maskVerifyGrid)
          );
          const idx = y * config.maskVerifyGrid + x;
          const pixelIdx = (py * config.canonicalSize + px) * 4;
          const valueIdx = idx * 3;
          values[valueIdx] = refPixels[pixelIdx];
          values[valueIdx + 1] = refPixels[pixelIdx + 1];
          values[valueIdx + 2] = refPixels[pixelIdx + 2];
          const alpha = maskPixels ? maskPixels[pixelIdx + 3] : 255;
          mask[idx] = alpha >= 128 ? 1 : 0;
          active += mask[idx];
        }
      }
      return { values, mask, active };
    }

    function verifyScoreFromPixels(pixels, srcW, sx, sy, refVerifyValues, refVerifyMask, refVerifyActive, verifySampleX, verifySampleY) {
      if (!refVerifyValues || !refVerifyMask || !refVerifyActive || !verifySampleX || !verifySampleY) {
        return { score: 1, active: 0 };
      }
      let total = 0;
      for (let idx = 0; idx < refVerifyMask.length; idx++) {
        if (!refVerifyMask[idx]) continue;
        const pixelIdx = ((sy + verifySampleY[idx]) * srcW + (sx + verifySampleX[idx])) * 4;
        const valueIdx = idx * 3;
        total += Math.abs(pixels[pixelIdx] - refVerifyValues[valueIdx]);
        total += Math.abs(pixels[pixelIdx + 1] - refVerifyValues[valueIdx + 1]);
        total += Math.abs(pixels[pixelIdx + 2] - refVerifyValues[valueIdx + 2]);
      }
      return { score: total / (refVerifyActive * 255 * 3), active: refVerifyActive };
    }

    function matchThresholdForRef(ref) {
      return ref && ref.refValidBits < 64 ? config.maskedMatchThresholdRatio : config.matchThresholdRatio;
    }

    function verifyThresholdForRef(ref) {
      if (!ref) return null;
      if (ref.refValidBits >= 64) return config.unmaskedVerifyThreshold;
      if (ref.refValidBits < 24) return config.maskVerifyThresholdLowBits;
      if (ref.refValidBits < 32) return config.maskVerifyThresholdMidBits;
      return config.maskVerifyThreshold;
    }

    function windowPenalty(ref, x, y) {
      const center = config.captureSize / 2;
      const wx = x + ref.w / 2;
      const wy = y + ref.h / 2;
      const dx = (wx - center) / center;
      const dy = (wy - center) / center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const weight = ref.refValidBits < 64 ? config.maskedCenterBiasWeight : config.centerBiasWeight;
      return dist * weight;
    }

    function keepTopCandidate(list, entry) {
      let inserted = false;
      for (let i = 0; i < list.length; i++) {
        const cur = list[i];
        if (
          entry.score < cur.score ||
          (entry.score === cur.score && (entry.ratio < cur.ratio || (entry.ratio === cur.ratio && entry.dist < cur.dist)))
        ) {
          list.splice(i, 0, entry);
          inserted = true;
          break;
        }
      }
      if (!inserted) list.push(entry);
      if (list.length > config.coarseCandidates) list.length = config.coarseCandidates;
    }

    function slidingWindowMatch(ref, capturePixels, captureGray) {
      const { refHash, refBitMask, refValidBits, w, h } = ref;
      if (!refHash || w > config.captureSize || h > config.captureSize) {
        return { dist: 64, ratio: 1, validBits: refValidBits ?? 64, x: 0, y: 0, score: 1 };
      }
      ensureRefRuntime(ref);
      let best = { dist: 64, ratio: 1, validBits: refValidBits ?? 64, x: 0, y: 0, score: 1 };
      const coarseStep = Math.max(config.slideStep, config.coarseStep);
      const coarseThreshold = Math.min(0.35, matchThresholdForRef(ref) * config.coarseThresholdFactor);
      const coarse = [];
      const maxX = config.captureSize - w;
      const maxY = config.captureSize - h;
      // ref._noCoarse: skip coarse pass and scan every position at slideStep.
      // Used by Phase 2 rotation to guarantee the exact match position is evaluated —
      // rotated hashes can have very sharp match peaks that the coarse filter misses.
      const useCoarse = !ref._noCoarse && coarseStep > config.slideStep && (maxX > coarseStep || maxY > coarseStep);

      const scanWindow = (x, y) => {
        const result = dHashDistFromGray(
          captureGray,
          config.captureSize,
          x,
          y,
          refHash,
          refBitMask,
          refValidBits,
          ref.hashSampleX,
          ref.hashSampleY
        );
        const score = result.ratio + windowPenalty(ref, x, y);
        if (
          score < best.score ||
          (score === best.score && (result.ratio < best.ratio || (result.ratio === best.ratio && result.dist < best.dist)))
        ) {
          best = { ...result, x, y, score };
        }
        return { ...result, x, y, score };
      };

      if (!useCoarse) {
        const searchMinX = ref._searchBounds ? Math.max(0, ref._searchBounds.minX) : 0;
        const searchMaxX = ref._searchBounds ? Math.min(maxX, ref._searchBounds.maxX) : maxX;
        const searchMinY = ref._searchBounds ? Math.max(0, ref._searchBounds.minY) : 0;
        const searchMaxY = ref._searchBounds ? Math.min(maxY, ref._searchBounds.maxY) : maxY;
        for (let y = searchMinY; y <= searchMaxY; y += config.slideStep) {
          for (let x = searchMinX; x <= searchMaxX; x += config.slideStep) {
            scanWindow(x, y);
          }
        }
        return best;
      }

      for (let y = 0; y <= maxY; y += coarseStep) {
        for (let x = 0; x <= maxX; x += coarseStep) {
          const entry = scanWindow(x, y);
          if (entry.ratio <= coarseThreshold) keepTopCandidate(coarse, entry);
        }
      }
      if (!coarse.length) {
        // No coarse position passed the ratio threshold — the scene likely contains nothing
        // matching the ref. The single-seed fallback can miss the true match when it falls
        // between coarse grid lines (e.g., true match at x=21, coarse step=4, best seed at
        // x=16 → fine range [12..20] never evaluates x=21). Fall back to a full step-1 scan
        // so we never silently skip the correct position.
        for (let y = 0; y <= maxY; y += config.slideStep) {
          for (let x = 0; x <= maxX; x += config.slideStep) {
            scanWindow(x, y);
          }
        }
        return best;
      }

      const visited = new Set();
      for (const seed of coarse) {
        for (let y = Math.max(0, seed.y - coarseStep); y <= Math.min(maxY, seed.y + coarseStep); y += config.slideStep) {
          for (let x = Math.max(0, seed.x - coarseStep); x <= Math.min(maxX, seed.x + coarseStep); x += config.slideStep) {
            const key = y * config.captureSize + x;
            if (visited.has(key)) continue;
            visited.add(key);
            scanWindow(x, y);
          }
        }
      }

      // Targeted refinement: if ref._refinement is set, do a step-1 scan within
      // refineRadius pixels of the current best position.  Used by Phase 2 rotation
      // to catch sharp-peak matches that the coarse filter places outside ±coarseStep.
      // Cost: (2R+1)² positions minus already-visited — cheap relative to a full scan.
      if (ref._refinement) {
        const radius = ref._refinement;
        for (let y = Math.max(0, best.y - radius); y <= Math.min(maxY, best.y + radius); y++) {
          for (let x = Math.max(0, best.x - radius); x <= Math.min(maxX, best.x + radius); x++) {
            const key = y * config.captureSize + x;
            if (visited.has(key)) continue;
            visited.add(key);
            scanWindow(x, y);
          }
        }
      }

      return best;
    }

    function evaluateReference(ref, capturePixels, captureGray, skipRotation, sat, sat2) {
      const threshold = matchThresholdForRef(ref);
      const verifyThreshold = verifyThresholdForRef(ref);

      // Phase 1: dHash sliding window locates the best position.
      const baseResult = slidingWindowMatch(ref, capturePixels, captureGray);

      // NCC verification at the dHash-found position. NCC normalizes for local mean and
      // variance, making it immune to H.264 brightness/contrast shifts that cause dHash
      // near-misses on live streams. When available, NCC can rescue a dHash near-miss.
      let nccScore = null;
      if (sat && sat2 && ref.refNCC && ref.w > 0 && ref.h > 0) {
        nccScore = nccScoreAt(captureGray, config.captureSize, sat, sat2,
          baseResult.x, baseResult.y, ref.refNCC, ref.w, ref.h);
      }

      const baseVerify = ref.refVerifyValues
        ? verifyScoreFromPixels(capturePixels, config.captureSize, baseResult.x, baseResult.y,
            ref.refVerifyValues, ref.refVerifyMask, ref.refVerifyActive,
            ref.verifySampleX, ref.verifySampleY)
        : null;

      const dHashPassed = baseResult.ratio <= threshold && baseResult.validBits >= config.minMaskedBits;
      const nccPassed   = nccScore !== null && nccScore >= config.nccMatchThreshold;
      const verifyOk    = verifyThreshold == null || baseVerify == null || baseVerify.score <= verifyThreshold;
      // NCC alone is sufficient: it normalizes for brightness/contrast so H.264 level shifts
      // can't cause false positives. dHash still requires verify as a second opinion because
      // structural similarity (dHash) doesn't guarantee color match.
      const baseMatched = nccPassed || (dHashPassed && verifyOk);

      if (baseMatched) {
        return {
          ...baseResult, angle: 0, threshold,
          verifyScore: baseVerify ? baseVerify.score : null,
          verifyThreshold, nccScore, matched: true,
        };
      }

      // Phase 2: base hash failed (ratio or verify). Try rotated hashes as fallback.
      // Verify is skipped for rotated candidates — color distribution shifts with rotation.
      //
      // Threshold strategy: rotationMatchThresholdRatio (7/64) is tighter than the base
      // matchThresholdRatio (10/64). False positives from unrelated images tend to get
      // 6-10 bit mismatches; true positives rotated to their matching angle get 0 mismatches.
      //
      // slidingWindowMatch keeps refValidBits=64 so its coarse-pass threshold stays loose
      // (0.234) and doesn't prune the correct position. After the scan, we recompute the
      // ratio as dist/validCount (where validCount is the number of unclipped bits in the
      // clipMask) before comparing to rotationMatchThresholdRatio. This gives a fair ratio
      // even when rotation clips many corner bits.
      if (!skipRotation && ref.rotatedHashes && ref.rotatedHashes.length) {
        const rotThreshold = config.rotationMatchThresholdRatio;
        let bestRot = null;
        let bestRotAngle = 0;
        let bestRotValidCount = 64;
        // The capture is always centered on the cursor, and the ref must contain the cursor.
        // So the ref's top-left is bounded: x ∈ [center-W+1, center], y ∈ [center-H+1, center].
        // A center-constrained step-1 scan covers ~45% fewer positions than the full range
        // while guaranteeing the exact embed position is evaluated — critical because rotated
        // hashes have sharp peaks (dist=0 only at the exact pixel, 22+ at ±2px) that the
        // coarse filter can't reliably find.
        const center = Math.floor(config.captureSize / 2);
        const rotSearchBounds = {
          minX: Math.max(0, center - ref.w + 1),
          maxX: Math.min(config.captureSize - ref.w, center),
          minY: Math.max(0, center - ref.h + 1),
          maxY: Math.min(config.captureSize - ref.h, center),
        };
        for (const rotHash of ref.rotatedHashes) {
          const rotRef = Object.assign(Object.create(null), ref, {
            refHash: rotHash.hash,
            refBitMask: rotHash.clipMask || null,
            // Keep refValidBits=64 so matchThresholdForRef returns the loose unmasked ratio.
            refValidBits: 64,
            refVerifyValues: null,
            // Step-1 scan within the center-constrained region: every position where the
            // cursor (at capture center) falls inside the ref bounding box.
            _noCoarse: true,
            _searchBounds: rotSearchBounds,
          });
          const rotResult = slidingWindowMatch(rotRef, capturePixels, captureGray);
          if (
            bestRot == null ||
            rotResult.score < bestRot.score ||
            (rotResult.score === bestRot.score && rotResult.ratio < bestRot.ratio)
          ) {
            bestRot = rotResult;
            bestRotAngle = rotHash.angle;
            bestRotValidCount = rotHash.validCount ?? 64;
          }
        }
        // Re-derive ratio using actual valid-bit count as denominator so that clipped
        // corner bits don't inflate the numerator while 64 deflates the denominator.
        const adjustedRatio = bestRot ? bestRot.dist / bestRotValidCount : 1;
        if (bestRot && adjustedRatio <= rotThreshold && bestRot.validBits >= config.minMaskedBits) {
          return {
            ...bestRot, ratio: adjustedRatio, angle: bestRotAngle, threshold: rotThreshold,
            verifyScore: null, verifyThreshold: null, matched: true,
          };
        }
        // Neither phase matched — return best info for debug display.
        const useBase = !bestRot || baseResult.score <= bestRot.score;
        return {
          ...(useBase ? baseResult : bestRot),
          ...(useBase ? {} : { ratio: adjustedRatio }),
          angle: useBase ? 0 : bestRotAngle, threshold: useBase ? threshold : rotThreshold,
          verifyScore: useBase ? (baseVerify ? baseVerify.score : null) : null,
          verifyThreshold: useBase ? verifyThreshold : null,
          nccScore, matched: false,
        };
      }

      // No rotation hashes — standard unmatched result.
      return {
        ...baseResult, angle: 0, threshold,
        verifyScore: baseVerify ? baseVerify.score : null,
        verifyThreshold, nccScore, matched: false,
      };
    }

    function findBestMatch(triggers, capturePixels, captureGray) {
      // Build summed-area table once for all NCC calls in this hover event.
      const { sat, sat2 } = buildSAT(captureGray, config.captureSize, config.captureSize);

      // Pass 1: run Phase 1 (base hash only, no rotation) for every trigger.
      const ranked = [];
      for (const trigger of triggers) {
        if (!trigger.references) continue;
        for (const ref of trigger.references) {
          if (!ref.refHash) continue;
          const result = evaluateReference(ref, capturePixels, captureGray, /*skipRotation=*/true, sat, sat2);
          ranked.push({
            trigger,
            ref,
            title: trigger.payloads?.[0]?.title || trigger.id,
            ...result,
          });
        }
      }

      // If Phase 1 already found a match, skip Phase 2 entirely.
      const phase1Match = ranked.find(e => e.matched);

      if (!phase1Match) {
        // Pass 2: rotation search for rotating triggers whose Phase 1 dist is within
        // rotationDistWindow bits of the best Phase 1 miss. This is adaptive: when
        // nothing card-like is under the cursor, best-dist is ~30+ and the window is
        // empty so Phase 2 cost is zero. When a rotated card is present, the correct
        // trigger and its nearest competitors are all included regardless of rank.
        // rotationCandidateMax is a hard cap to bound worst-case cost.
        const sortedRotating = ranked
          .filter(e => e.ref.rotatedHashes && e.ref.rotatedHashes.length)
          .sort((a, b) => a.dist - b.dist);
        const bestDist = sortedRotating[0]?.dist ?? Infinity;
        const distCutoff = bestDist + config.rotationDistWindow;
        const rotatingMisses = sortedRotating
          .filter(e => e.dist <= distCutoff)
          .slice(0, config.rotationCandidateMax);

        for (const entry of rotatingMisses) {
          const result = evaluateReference(entry.ref, capturePixels, captureGray, /*skipRotation=*/false, sat, sat2);
          // Overwrite the Phase 1 result for this entry with the full Phase 1+2 result.
          Object.assign(entry, result);
        }
      }

      ranked.sort((a, b) => {
        if (a.matched !== b.matched) return a.matched ? -1 : 1;
        if (a.score !== b.score) return a.score - b.score;
        if (a.ratio !== b.ratio) return a.ratio - b.ratio;
        if (a.dist !== b.dist) return a.dist - b.dist;
        return (a.verifyScore ?? Infinity) - (b.verifyScore ?? Infinity);
      });
      const best = ranked[0]
        ? {
            trigger: ranked[0].trigger,
            ref: ranked[0].ref,
            dist: ranked[0].dist,
            ratio: ranked[0].ratio,
            validBits: ranked[0].validBits,
            x: ranked[0].x,
            y: ranked[0].y,
            score: ranked[0].score,
            threshold: ranked[0].threshold,
            verifyScore: ranked[0].verifyScore,
            verifyThreshold: ranked[0].verifyThreshold,
            nccScore: ranked[0].nccScore ?? null,
            angle: ranked[0].angle ?? 0,
            matched: ranked[0].matched,
          }
        : null;
      return {
        best,
        candidates: ranked.slice(0, 3).map((entry) => ({
          title: entry.title,
          dist: entry.dist,
          ratio: entry.ratio,
          validBits: entry.validBits,
          threshold: entry.threshold,
          verifyScore: entry.verifyScore,
          verifyThreshold: entry.verifyThreshold,
          nccScore: entry.nccScore ?? null,
          angle: entry.angle ?? 0,
          matched: entry.matched,
          score: entry.score,
        })),
      };
    }

    return {
      config,
      allBitMask,
      createGrayBuffer,
      fillGrayBuffer,
      dHashFromPixels,
      maskBitsFromPixels,
      buildVerifyRefFromPixels,
      buildHashSamples,
      buildVerifySamples,
      matchThresholdForRef,
      verifyThresholdForRef,
      verifyScoreFromPixels,
      buildSAT,
      buildRefNCC,
      nccScoreAt,
      slidingWindowMatch,
      evaluateReference,
      findBestMatch,
      // Wrap to pass config.canonicalSize so callers don't need to supply it.
      computeRotatedHashes: (px, w, h, angles) =>
        computeRotatedHashes(px, w, h, angles, config.canonicalSize),
      anglesForRotation,
    };
  }

  return { DEFAULTS, createMatcher, rotatePixels, computeRotatedHashes, anglesForRotation };
});
