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
    // Rotation: angles (degrees) tried when trigger.rotates = true.
    // 5° steps, ±30°, skipping 0° (handled by the base hash).
    rotationAngles: [-30, -25, -20, -15, -10, -5, 5, 10, 15, 20, 25, 30],
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

  // Given canonical-size (32×32) RGBA pixels for a reference, pre-compute hashes
  // for each rotation angle. Returns [{angle, hash}] — no mask support (unmasked only).
  function computeRotatedHashes(refPixels, refW, refH, angles) {
    return angles.map(angleDeg => {
      const rotated = rotatePixels(refPixels, refW, refH, angleDeg);
      const hash = (function () {
        const scratch = new Float32Array(72);
        for (let dy = 0; dy < 8; dy++) {
          for (let dx = 0; dx < 9; dx++) {
            const px = Math.floor((dx * refW) / 9);
            const py = Math.floor((dy * refH) / 8);
            const i = (py * refW + px) * 4;
            scratch[dy * 9 + dx] = 0.299 * rotated[i] + 0.587 * rotated[i + 1] + 0.114 * rotated[i + 2];
          }
        }
        const bits = new Uint8Array(64);
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            bits[y * 8 + x] = scratch[y * 9 + x + 1] > scratch[y * 9 + x] ? 1 : 0;
          }
        }
        return bits;
      })();
      return { angle: angleDeg, hash };
    });
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
      const useCoarse = coarseStep > config.slideStep && (maxX > coarseStep || maxY > coarseStep);

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
        for (let y = 0; y <= maxY; y += config.slideStep) {
          for (let x = 0; x <= maxX; x += config.slideStep) {
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
      if (!coarse.length) keepTopCandidate(coarse, best);

      const visited = new Set();
      for (const seed of coarse) {
        for (let y = Math.max(0, seed.y - coarseStep + 1); y <= Math.min(maxY, seed.y + coarseStep - 1); y += config.slideStep) {
          for (let x = Math.max(0, seed.x - coarseStep + 1); x <= Math.min(maxX, seed.x + coarseStep - 1); x += config.slideStep) {
            const key = y * config.captureSize + x;
            if (visited.has(key)) continue;
            visited.add(key);
            scanWindow(x, y);
          }
        }
      }

      return best;
    }

    function evaluateReference(ref, capturePixels, captureGray) {
      const threshold = matchThresholdForRef(ref);
      const verifyThreshold = verifyThresholdForRef(ref);

      // Phase 1: try base hash with full verify protection.
      const baseResult = slidingWindowMatch(ref, capturePixels, captureGray);
      const baseVerify = ref.refVerifyValues
        ? verifyScoreFromPixels(capturePixels, config.captureSize, baseResult.x, baseResult.y,
            ref.refVerifyValues, ref.refVerifyMask, ref.refVerifyActive,
            ref.verifySampleX, ref.verifySampleY)
        : null;
      const baseMatched =
        baseResult.ratio <= threshold &&
        baseResult.validBits >= config.minMaskedBits &&
        (verifyThreshold == null || baseVerify == null || baseVerify.score <= verifyThreshold);

      if (baseMatched) {
        return {
          ...baseResult, angle: 0, threshold,
          verifyScore: baseVerify ? baseVerify.score : null,
          verifyThreshold, matched: true,
        };
      }

      // Phase 2: base hash failed (ratio or verify). Try rotated hashes as fallback.
      // Verify is skipped for rotated candidates — color distribution shifts with rotation.
      if (ref.rotatedHashes && ref.rotatedHashes.length) {
        let bestRot = null;
        let bestRotAngle = 0;
        for (const rotHash of ref.rotatedHashes) {
          const rotRef = Object.assign(Object.create(null), ref, {
            refHash: rotHash.hash, refBitMask: null, refValidBits: 64, refVerifyValues: null,
          });
          const rotResult = slidingWindowMatch(rotRef, capturePixels, captureGray);
          if (
            bestRot == null ||
            rotResult.score < bestRot.score ||
            (rotResult.score === bestRot.score && rotResult.ratio < bestRot.ratio)
          ) {
            bestRot = rotResult;
            bestRotAngle = rotHash.angle;
          }
        }
        if (bestRot && bestRot.ratio <= threshold && bestRot.validBits >= config.minMaskedBits) {
          return {
            ...bestRot, angle: bestRotAngle, threshold,
            verifyScore: null, verifyThreshold: null, matched: true,
          };
        }
        // Neither phase matched — return best info for debug display.
        const useBase = !bestRot || baseResult.score <= bestRot.score;
        return {
          ...(useBase ? baseResult : bestRot),
          angle: useBase ? 0 : bestRotAngle, threshold,
          verifyScore: useBase ? (baseVerify ? baseVerify.score : null) : null,
          verifyThreshold: useBase ? verifyThreshold : null,
          matched: false,
        };
      }

      // No rotation hashes — standard unmatched result.
      return {
        ...baseResult, angle: 0, threshold,
        verifyScore: baseVerify ? baseVerify.score : null,
        verifyThreshold, matched: false,
      };
    }

    function findBestMatch(triggers, capturePixels, captureGray) {
      const ranked = [];
      for (const trigger of triggers) {
        if (!trigger.references) continue;
        for (const ref of trigger.references) {
          if (!ref.refHash) continue;
          const result = evaluateReference(ref, capturePixels, captureGray);
          ranked.push({
            trigger,
            ref,
            title: trigger.payloads?.[0]?.title || trigger.id,
            ...result,
          });
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
      slidingWindowMatch,
      evaluateReference,
      findBestMatch,
      computeRotatedHashes,
    };
  }

  return { DEFAULTS, createMatcher, rotatePixels, computeRotatedHashes };
});
