// Content script. Runs in the context of twitch.tv pages.

(function () {
  if (window.__streamOverlayLoaded) {
    console.log("[overlay/content] already loaded, skipping");
    return;
  }
  window.__streamOverlayLoaded = true;

  // Child frame (Twitch Extension iframe on ext.twitch.tv): relay mouse
  // position to the parent frame so the overlay stays active while the
  // cursor is inside the extension overlay. No capture or popup logic runs here.
  //
  // IMPORTANT: send NORMALISED coordinates (0–1 fraction of the child window's
  // inner dimensions), NOT raw clientX/Y. Many Twitch Extensions (e.g. Slay
  // the Relics) render at a fixed internal resolution (1920×1080) that is
  // CSS-scaled down to fit the player. Raw clientX would be e.g. 1200 even
  // though the iframe is only 400 px wide on screen, causing the parent to
  // reconstruct a wildly over-shot coordinate. Normalising avoids the issue
  // entirely — the parent just multiplies by the iframe's visual dimensions.
  if (window !== window.top) {
    document.addEventListener("mousemove", (e) => {
      const nx = window.innerWidth  > 0 ? e.clientX / window.innerWidth  : 0;
      const ny = window.innerHeight > 0 ? e.clientY / window.innerHeight : 0;
      window.parent.postMessage(
        { type: "streamGenie_mousemove", nx, ny },
        "*"
      );
    }, { passive: true });
    return;
  }

  console.log("[overlay/content] loaded on", location.href);

  // --- Config ---------------------------------------------------------------

  const CAPTURE_SIZE = 160;
  const CAPTURE_INTERVAL_MS = 100;     // throttle mouse-driven captures (10Hz)
  const HEARTBEAT_MS = 500;
  const MIN_VIDEO_SIZE = 100;
  const MATCH_THRESHOLD_RATIO = 10 / 64; // unmasked references preserve old 10/64 cutoff
  const MASKED_MATCH_THRESHOLD_RATIO = 6 / 64; // masked refs need a tighter cutoff to avoid false positives
  const MASK_VERIFY_GRID = 16;
  const MASK_VERIFY_THRESHOLD = 0.16; // average grayscale delta / 255 for masked refs
  const SLIDE_STEP = 1;                // 1px step — ensures no alignment misses
  const MIN_REF_PX = 8;               // only skip truly microscopic refs
  const MIN_MASKED_BITS = 16;         // reject masks that leave too little signal
  // Both reference and each capture window are normalised through this virtual
  // size before hashing, so small refs produce equally discriminative hashes.
  const CANONICAL_SIZE = 32;
  const FIRST_RUN_KEY = "streamGenie_first_run_shown";

  // --- Profile config -------------------------------------------------------

  const PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;
  const ACTIVE_PROFILE_KEY = "streamGenie_active_profile";
  const DEFAULT_PROFILE = {
    gameId:    "slay-the-spire-2",
    profileId: "community",
    name:      "STS2 Community",
    url:       "https://cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@main/games/slay-the-spire-2/profiles/community/profile.json",
  };

  const profileCacheKey    = (gId, pId) => `streamGenie_profile_${gId}_${pId}`;
  const userTriggersKey    = (gId, pId) => `streamGenie_triggers_${gId}_${pId}`;
  const contributorCodeKey = (gId, pId) => `streamGenie_code_${gId}_${pId}`;

  // --- Worker config --------------------------------------------------------
  // Set WORKER_URL after deploying the Cloudflare Worker (`wrangler deploy`).
  // SUBMIT_SECRET must match the SUBMIT_SECRET secret set on the Worker.
  // NOTE: this secret is readable by anyone who unpacks the extension — acceptable
  // for a dev build; use proper OAuth for a production release.
  const WORKER_URL    = "https://streamgenie-submit.vbjosh.workers.dev";
  const SUBMIT_SECRET = "YorkshireTractorFactor";

  // Triggers populated from the loaded profile. Each entry mirrors the profile
  // schema trigger shape, augmented with runtime fields (sourceImg, refHash, w, h).
  let TRIGGERS = [];

  // --- State ----------------------------------------------------------------

  let currentVideo = null;
  let captureCanvas = null;
  let captureCtx = null;
  let debugPanel = null;
  let lastCaptureTime = 0;
  let mouseOverVideo = false;
  let lastMatchInfo = null; // { title, dist, ratio, validBits, threshold, verifyScore, verifyThreshold, noMatch?, candidates? } for debug panel
  let activeProfile = null; // set by loadProfile(); used by editor + saveUserTrigger
  let overPopup = false;   // true while cursor is over an active popup
  let currentMatchedTrigger = null;
  let editorModalOpen = false;
  let detectedGame = null;  // { name, slug } scraped from Twitch category link
  let lastUrl = location.href;
  let firstRunHintDone = false;

  // --- Game detection -------------------------------------------------------

  function detectTwitchGame() {
    // Prefer the stream-info panel link (stable data-a-target); fall back to the
    // first match inside <main> to avoid sidebar recommendations picking up the wrong game.
    const link =
      document.querySelector('[data-a-target="stream-game-link"]') ||
      document.querySelector('main a[href*="/directory/category/"], main a[href*="/directory/game/"]') ||
      document.querySelector('a[href*="/directory/category/"], a[href*="/directory/game/"]');
    if (!link) return;
    const href = link.getAttribute("href") || "";
    const m = href.match(/\/directory\/(?:category|game)\/([^/?#]+)/);
    if (!m) return;
    const slug = decodeURIComponent(m[1]);
    const name = link.textContent.trim();
    if (detectedGame && detectedGame.slug === slug) return; // no change
    detectedGame = { name, slug };
    console.log(`[overlay/content] game detected: "${name}" (${slug})`);
  }

  async function maybeShowFirstRunHint() {
    if (firstRunHintDone) return;
    firstRunHintDone = true;
    const r = await chrome.storage.local.get(FIRST_RUN_KEY);
    if (r[FIRST_RUN_KEY]) return;
    await chrome.storage.local.set({ [FIRST_RUN_KEY]: true });
    setTimeout(() =>
      showToast("Stream Genie ready — hover over game elements for info, or click the toolbar icon to contribute.", "info"),
    1500);
  }

  // --- Video discovery ------------------------------------------------------

  function findBestVideo() {
    const all = Array.from(document.querySelectorAll("video"));
    if (all.length === 0) return { video: null, total: 0, visible: 0 };

    const scored = all
      .map((v) => { const rect = v.getBoundingClientRect(); return { v, rect, area: rect.width * rect.height }; })
      .filter((s) => s.rect.width >= MIN_VIDEO_SIZE && s.rect.height >= MIN_VIDEO_SIZE);

    if (scored.length === 0) return { video: null, total: all.length, visible: 0 };

    const withMedia = scored.filter((s) => s.v.videoWidth > 0 && s.v.videoHeight > 0);
    const pool = withMedia.length > 0 ? withMedia : scored;
    pool.sort((a, b) => b.area - a.area);
    return { video: pool[0].v, total: all.length, visible: scored.length };
  }

  function attachToVideo(video) {
    if (currentVideo === video) return;
    detachFromVideo();
    currentVideo = video;
    maybeShowFirstRunHint();
    const rect = video.getBoundingClientRect();
    console.log("[overlay/content] attaching to video:", {
      layoutSize: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      nativeSize: `${video.videoWidth}x${video.videoHeight}`,
    });
    if (video.videoWidth === 0) {
      video.addEventListener("loadedmetadata", () => {
        console.log("[overlay/content] video metadata loaded:", `${video.videoWidth}x${video.videoHeight}`);
        rehashAllTriggers();
      }, { once: true });
    } else {
      rehashAllTriggers();
    }
    updateDebugPanelStatus();
  }

  function detachFromVideo() {
    currentVideo = null;
    mouseOverVideo = false;
    updateDebugPanelStatus();
  }

  let lastKnownVideoDims = "";
  function heartbeat() {
    // SPA navigation — Twitch navigates client-side; reset detection on URL change.
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detectedGame = null;
    }
    detectTwitchGame();

    const { video, total, visible } = findBestVideo();
    window.__streamOverlayStats = { total, visible, attached: !!currentVideo };
    if (currentVideo) {
      if (!document.body.contains(currentVideo)) {
        detachFromVideo();
      } else if (video && video !== currentVideo) {
        attachToVideo(video);
      } else if (currentVideo.videoWidth) {
        const dims = `${currentVideo.videoWidth}x${currentVideo.videoHeight}`;
        if (dims !== lastKnownVideoDims) {
          lastKnownVideoDims = dims;
          console.log("[overlay/content] video dims changed:", dims);
          rehashAllTriggers();
        }
      }
    } else if (video) {
      attachToVideo(video);
    }
    updateDebugPanelStatus();
  }
  setInterval(heartbeat, HEARTBEAT_MS);

  // --- Pixel capture --------------------------------------------------------

  function clientToVideoCoords(video, clientX, clientY) {
    const rect = video.getBoundingClientRect();
    if (!video.videoWidth || !video.videoHeight) return null;

    // Only apply letterbox math when the browser is actually rendering the video
    // with object-fit:contain (black bars). Twitch uses other values in some
    // layouts and the video fills the element exactly in those cases.
    const objectFit = window.getComputedStyle(video).objectFit;
    const elementAspect = rect.width / rect.height;
    const videoAspect = video.videoWidth / video.videoHeight;
    let renderW, renderH, offsetX, offsetY;
    if (objectFit === "contain") {
      if (elementAspect > videoAspect) {
        renderH = rect.height;
        renderW = renderH * videoAspect;
        offsetX = (rect.width - renderW) / 2;
        offsetY = 0;
      } else {
        renderW = rect.width;
        renderH = renderW / videoAspect;
        offsetX = 0;
        offsetY = (rect.height - renderH) / 2;
      }
    } else {
      renderW = rect.width;
      renderH = rect.height;
      offsetX = 0;
      offsetY = 0;
    }

    const scaleX = video.videoWidth / renderW;
    const scaleY = video.videoHeight / renderH;
    return {
      x: (clientX - rect.left - offsetX) * scaleX,
      y: (clientY - rect.top - offsetY) * scaleY,
      rectLeft: Math.round(rect.left), rectTop: Math.round(rect.top),
      rectW: Math.round(rect.width),   rectH: Math.round(rect.height),
      offsetX: Math.round(offsetX),    offsetY: Math.round(offsetY),
      scaleX, scaleY, objectFit,
    };
  }

  function ensureCaptureCanvas() {
    if (!captureCanvas) {
      captureCanvas = document.createElement("canvas");
      captureCanvas.width = CAPTURE_SIZE;
      captureCanvas.height = CAPTURE_SIZE;
      captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });
    }
    return captureCtx;
  }

  function captureRegion(video, videoX, videoY) {
    const ctx = ensureCaptureCanvas();
    const halfSize = CAPTURE_SIZE / 2;
    const sx = Math.max(0, Math.min(video.videoWidth  - CAPTURE_SIZE, videoX - halfSize));
    const sy = Math.max(0, Math.min(video.videoHeight - CAPTURE_SIZE, videoY - halfSize));
    try {
      ctx.drawImage(video, sx, sy, CAPTURE_SIZE, CAPTURE_SIZE, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
      return { sx, sy };
    } catch (err) {
      console.warn("[overlay/content] capture failed:", err.message);
      return null;
    }
  }

  // --- Perceptual hashing ---------------------------------------------------
  //
  // We read the entire captureCanvas into a pixel array ONCE per mouse event,
  // then do all sliding-window hash comparisons in pure JS — no further canvas
  // or GPU ops. This avoids the hundreds of getImageData calls that were
  // stalling the main thread and making captures appear to lag behind the cursor.

  // Reusable scratch buffer — avoids GC pressure inside the hot matching loop.
  const _gray = new Float32Array(72); // 9×8
  const _allBitMask = new Uint8Array(64).fill(1);

  // Compute 64-bit dHash for a region of a flat RGBA pixel array.
  // Samples 9×8 positions mapped through CANONICAL_SIZE so that small and large
  // windows are compared at the same effective density as the reference hash.
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

  // Same, but computes distance against a known refHash in one pass without
  // allocating a new Uint8Array — used in the hot sliding-window loop.
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
    let dist = 0;
    const mask = refBitMask || _allBitMask;
    const validBits = refValidBits ?? 64;
    if (validBits < MIN_MASKED_BITS) return { dist: 64, validBits, ratio: 1 };
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

  // Slide a reference entry across the capture pixels, return best position + distance.
  function slidingWindowMatch(ref, capturePixels) {
    const { refHash, refBitMask, refValidBits, w, h } = ref;
    if (!refHash || w > CAPTURE_SIZE || h > CAPTURE_SIZE) {
      return { dist: 64, ratio: 1, validBits: refValidBits ?? 64, x: 0, y: 0 };
    }
    let best = { dist: 64, ratio: 1, validBits: refValidBits ?? 64, x: 0, y: 0 };
    for (let y = 0; y <= CAPTURE_SIZE - h; y += SLIDE_STEP) {
      for (let x = 0; x <= CAPTURE_SIZE - w; x += SLIDE_STEP) {
        const result = dHashDistFromPixels(capturePixels, CAPTURE_SIZE, x, y, w, h, refHash, refBitMask, refValidBits);
        if (
          result.ratio < best.ratio ||
          (result.ratio === best.ratio && result.dist < best.dist)
        ) {
          best = { ...result, x, y };
        }
      }
    }
    return best;
  }

  function matchThresholdForRef(ref) {
    return ref && ref.refValidBits < 64 ? MASKED_MATCH_THRESHOLD_RATIO : MATCH_THRESHOLD_RATIO;
  }

  function verifyThresholdForRef(ref) {
    return ref && ref.refValidBits < 64 ? MASK_VERIFY_THRESHOLD : null;
  }

  // Run all triggers/references in a single pass. Returns the overall best result.
  function findBestMatch(capturePixels) {
    let best = null;
    const candidates = [];
    for (const trigger of TRIGGERS) {
      if (!trigger.references) continue;
      for (const ref of trigger.references) {
        if (!ref.refHash) continue;
        const result = slidingWindowMatch(ref, capturePixels);
        const threshold = matchThresholdForRef(ref);
        const verify = ref.refVerifyGray
          ? maskedVerifyScoreFromPixels(capturePixels, CAPTURE_SIZE, result.x, result.y, ref.w, ref.h, ref.refVerifyGray, ref.refVerifyMask, ref.refVerifyActive)
          : null;
        const verifyThreshold = verifyThresholdForRef(ref);
        candidates.push({
          title: trigger.payloads?.[0]?.title || trigger.id,
          dist: result.dist,
          ratio: result.ratio,
          validBits: result.validBits,
          threshold,
          verifyScore: verify ? verify.score : null,
          verifyThreshold,
        });
        if (
          !best ||
          result.ratio < best.ratio ||
          (result.ratio === best.ratio && result.dist < best.dist)
        ) {
          best = { trigger, ref, ...result, verifyScore: verify ? verify.score : null, verifyActive: verify ? verify.active : 0 };
        }
      }
    }
    candidates.sort((a, b) => a.ratio - b.ratio || a.dist - b.dist);
    return { best, candidates: candidates.slice(0, 3) }; // best may be null
  }

  // --- Profile loading ------------------------------------------------------

  function profileBaseUrl(profileUrl) {
    return profileUrl.substring(0, profileUrl.lastIndexOf("/") + 1);
  }

  function loadReferencesForTriggers(baseUrl) {
    for (const trigger of TRIGGERS) {
      if (!trigger.references) continue;
      for (const ref of trigger.references) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          ref.sourceImg = img;
          ref.origW = img.naturalWidth;
          ref.origH = img.naturalHeight;
          const finish = () => {
            rehashRef(ref);
            console.log(`[overlay/content] reference loaded: ${ref.file} (${ref.origW}x${ref.origH})`);
            updateDebugPanelStatus();
          };
          if (ref.maskDataUrl) {
            const maskImg = new Image();
            maskImg.onload = () => { ref.maskImg = maskImg; finish(); };
            maskImg.onerror = finish;
            maskImg.src = ref.maskDataUrl;
          } else {
            finish();
          }
        };
        img.onerror = () => console.warn(`[overlay/content] failed to load reference: ${ref.file}`);
        img.src = baseUrl + "references/" + ref.file;
      }
    }
  }

  function applyProfile(profile, sourceUrl) {
    // Preserve in-memory user triggers so background CDN refreshes don't wipe them.
    const userTriggers = TRIGGERS.filter(t => t.id && t.id.startsWith("user-"));
    TRIGGERS = [...profile.triggers.map(t => ({ ...t })), ...userTriggers];
    console.log(`[overlay/content] profile loaded: ${profile.name} v${profile.version} (${profile.triggers.length} profile + ${userTriggers.length} user)`);
    loadReferencesForTriggers(profileBaseUrl(sourceUrl));
    updateDebugPanelStatus();
  }

  async function loadProfile() {
    const r = await chrome.storage.local.get(ACTIVE_PROFILE_KEY);
    activeProfile = r[ACTIVE_PROFILE_KEY] || DEFAULT_PROFILE;
    const cKey = profileCacheKey(activeProfile.gameId, activeProfile.profileId);

    try {
      const cached = JSON.parse(localStorage.getItem(cKey) || "null");
      if (cached && Date.now() - cached.ts < PROFILE_CACHE_TTL_MS) {
        console.log("[overlay/content] profile: using cached version");
        applyProfile(cached.profile, activeProfile.url);
        fetchAndCacheProfile(); // background refresh
        return;
      }
    } catch (_) {}

    await fetchAndCacheProfile();
  }

  async function fetchAndCacheProfile() {
    const ap = activeProfile || DEFAULT_PROFILE;
    const cKey = profileCacheKey(ap.gameId, ap.profileId);
    try {
      const res = await fetch(ap.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const profile = await res.json();
      localStorage.setItem(cKey, JSON.stringify({ ts: Date.now(), profile }));
      console.log("[overlay/content] profile: fetched from CDN");
      applyProfile(profile, ap.url);
    } catch (err) {
      console.warn("[overlay/content] profile fetch failed:", err.message);
      try {
        const cached = JSON.parse(localStorage.getItem(cKey) || "null");
        if (cached) {
          console.warn("[overlay/content] profile: using stale cache");
          applyProfile(cached.profile, ap.url);
        }
      } catch (_) {}
    }
  }

  // Rescale a reference entry to the current stream resolution and recompute its hash.
  // The reference is always drawn to a CANONICAL_SIZE×CANONICAL_SIZE intermediate
  // canvas so the hash quality is resolution-independent. The sliding-window search
  // still uses the native w×h for spatial positioning.
  function rehashRef(ref) {
    if (!ref.sourceImg) return;
    let w = ref.origW, h = ref.origH;
    if (currentVideo && currentVideo.videoWidth && ref.srcW) {
      const scale = currentVideo.videoWidth / ref.srcW;
      w = Math.max(1, Math.round(ref.origW * scale));
      h = Math.max(1, Math.round(ref.origH * scale));
    }
    ref.w = w;
    ref.h = h;
    if (w < MIN_REF_PX || h < MIN_REF_PX || w > CAPTURE_SIZE || h > CAPTURE_SIZE) {
      ref.refHash = null;
      ref.refBitMask = null;
      ref.refValidBits = 0;
      return;
    }
    // Draw reference at canonical size for consistent hash quality at all resolutions.
    const tmp = document.createElement("canvas");
    tmp.width = CANONICAL_SIZE; tmp.height = CANONICAL_SIZE;
    const ctx = tmp.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(ref.sourceImg, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
    const px = ctx.getImageData(0, 0, CANONICAL_SIZE, CANONICAL_SIZE).data;
    ref.refHash = dHashFromPixels(px, CANONICAL_SIZE, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
    if (ref.maskDataUrl) {
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = CANONICAL_SIZE;
      maskCanvas.height = CANONICAL_SIZE;
      const maskCtx = maskCanvas.getContext("2d");
      maskCtx.clearRect(0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
      if (ref.maskImg) {
        maskCtx.imageSmoothingEnabled = true;
        maskCtx.imageSmoothingQuality = "high";
        maskCtx.drawImage(ref.maskImg, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
      } else {
        maskCtx.fillStyle = "#fff";
        maskCtx.fillRect(0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
      }
      const maskPx = maskCtx.getImageData(0, 0, CANONICAL_SIZE, CANONICAL_SIZE).data;
      const maskBits = maskBitsFromPixels(maskPx, CANONICAL_SIZE, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
      ref.refBitMask = maskBits.bits;
      ref.refValidBits = maskBits.validBits;
      const verifyRef = buildVerifyRefFromPixels(px, maskPx);
      ref.refVerifyGray = verifyRef.gray;
      ref.refVerifyMask = verifyRef.mask;
      ref.refVerifyActive = verifyRef.active;
      if (ref.refValidBits < MIN_MASKED_BITS) ref.refHash = null;
    } else {
      ref.refBitMask = new Uint8Array(_allBitMask);
      ref.refValidBits = 64;
      ref.refVerifyGray = null;
      ref.refVerifyMask = null;
      ref.refVerifyActive = 0;
    }
  }

  function rehashAllTriggers() {
    for (const t of TRIGGERS) {
      if (!t.references) continue;
      for (const ref of t.references) rehashRef(ref);
    }
    updateDebugPanelStatus();
  }

  // --- User triggers (locally saved) ---------------------------------------

  async function loadUserTriggers() {
    try {
      const ap = activeProfile || DEFAULT_PROFILE;
      const key = userTriggersKey(ap.gameId, ap.profileId);
      const result = await chrome.storage.local.get(key);
      const saved = result[key] || [];
      for (const trigger of saved) {
        if (!TRIGGERS.find(t => t.id === trigger.id)) {
          TRIGGERS.push(trigger);
          loadRefImages(trigger);
        }
      }
      if (saved.length) console.log(`[overlay/content] user triggers loaded: ${saved.length} for ${ap.profileId}`);
    } catch (e) {
      console.warn("[overlay/content] failed to load user triggers:", e.message);
    }
  }

  function loadRefImages(trigger) {
    if (!trigger.references) return;
    for (const ref of trigger.references) {
      if (!ref.dataUrl) continue;
      const img = new Image();
      img.onload = () => {
        ref.sourceImg = img;
        ref.origW = img.naturalWidth;
        ref.origH = img.naturalHeight;
        const finish = () => {
          rehashRef(ref);
          updateDebugPanelStatus();
        };
        if (ref.maskDataUrl) {
          const maskImg = new Image();
          maskImg.onload = () => { ref.maskImg = maskImg; finish(); };
          maskImg.onerror = finish;
          maskImg.src = ref.maskDataUrl;
        } else {
          finish();
        }
      };
      img.src = ref.dataUrl;
    }
  }

  async function saveUserTrigger(trigger, update = false) {
    try {
      const ap = activeProfile || DEFAULT_PROFILE;
      const key = userTriggersKey(ap.gameId, ap.profileId);
      const storable = {
        id: trigger.id,
        payloads: trigger.payloads,
        references: trigger.references.map(({ dataUrl, maskDataUrl, file, w, h, srcW, srcH }) => ({ dataUrl, maskDataUrl, file, w, h, srcW, srcH })),
      };
      const result = await chrome.storage.local.get(key);
      const saved = result[key] || [];
      if (update) {
        const idx = saved.findIndex(t => t.id === trigger.id);
        if (idx >= 0) saved[idx] = storable;
        else saved.push(storable);
      } else {
        saved.push(storable);
      }
      await chrome.storage.local.set({ [key]: saved });
      console.log(`[overlay/content] user trigger ${update ? "updated" : "saved"} in ${ap.profileId} (${saved.length} total)`);
    } catch (e) {
      console.warn("[overlay/content] failed to save user trigger:", e.message);
      showToast("Could not save trigger — storage may be full.", "error");
    }
  }

  async function submitToProfile(trigger, mode = "add") {
    if (!WORKER_URL) throw new Error("Worker URL not configured");
    const ap = activeProfile || DEFAULT_PROFILE;

    const codeStore = await chrome.storage.local.get(contributorCodeKey(ap.gameId, ap.profileId));
    const contributorCode = codeStore[contributorCodeKey(ap.gameId, ap.profileId)] || null;
    console.log(`[overlay/submit] mode=${mode} game=${ap.gameId} profile=${ap.profileId} trusted=${!!contributorCode}`);

    const triggerPayload = {
      id:       trigger.id,
      payloads: trigger.payloads,
    };
    if (mode === "add" || mode === "update") {
      triggerPayload.references = trigger.references.map(
        ({ dataUrl, maskDataUrl, file, w, h, srcW, srcH }) => ({ dataUrl, maskDataUrl, file, w, h, srcW, srcH })
      );
    }

    const headers = {
      "Content-Type":    "application/json",
      "X-Submit-Secret": SUBMIT_SECRET,
    };
    if (contributorCode) headers["X-Contributor-Key"] = contributorCode;

    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        gameId:    ap.gameId,
        profileId: ap.profileId,
        mode,
        trigger:   triggerPayload,
      }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    console.log(`[overlay/submit] worker response (${res.status}):`, JSON.stringify(data));
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data; // { ok, direct } or { ok, prUrl }
  }

  // --- Trigger editor -------------------------------------------------------

  function showSubmitError(container, message) {
    let el = container.querySelector(".sg-submit-error");
    if (!el) {
      el = document.createElement("div");
      el.className = "sg-submit-error";
      Object.assign(el.style, {
        width: "100%", padding: "8px 10px", marginBottom: "8px",
        background: "rgba(255,92,92,0.12)", border: "1px solid #ff5c5c",
        borderRadius: "4px", color: "#ff5c5c", fontSize: "12px",
        lineHeight: "1.4", boxSizing: "border-box", wordBreak: "break-word",
      });
      container.insertBefore(el, container.firstChild);
    }
    el.textContent = "Submit error: " + message;
  }

  // opts = { mode: 'edit', trigger: existingTrigger } for suggest-edit flow.
  function openTriggerEditor(dataUrl, meta, opts = {}) {
    const isEdit = opts.mode === "edit";
    // Profile triggers → propose update PR. User triggers → re-submit as add.
    const isProfileEdit = isEdit && !opts.trigger?.id?.startsWith("user-");
    let destroyMaskEditor = null;
    editorModalOpen = true;
    function closeEditor(message = "Cancelled.", level = "info") {
      if (destroyMaskEditor) destroyMaskEditor();
      editorModalOpen = false;
      backdrop.remove();
      if (message) showToast(message, level);
    }
    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,0.82)",
      zIndex: "2147483646", display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "sans-serif",
    });
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeEditor();
    });

    const modal = document.createElement("div");
    Object.assign(modal.style, {
      background: "#18181b", border: "1px solid #9146ff", borderRadius: "8px",
      padding: "20px", width: "500px", maxHeight: "85vh", overflowY: "auto",
      color: "#efeff1", fontSize: "13px", boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
      boxSizing: "border-box",
    });
    backdrop.appendChild(modal);

    // Header
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;";
    const titleEl = document.createElement("span");
    titleEl.style.cssText = "font-size:15px;font-weight:bold;color:#bf94ff;";
    const modeLabel = isProfileEdit ? "Edit Trigger" : isEdit ? "Edit My Trigger" : "New Trigger";
    titleEl.textContent = `${modeLabel} · ${(activeProfile || DEFAULT_PROFILE).name}`;
    const xBtn = document.createElement("button");
    xBtn.innerHTML = "&#10005;";
    xBtn.style.cssText = "background:none;border:none;color:#adadb8;font-size:16px;cursor:pointer;padding:0;line-height:1;";
    xBtn.onclick = () => closeEditor();
    header.appendChild(titleEl); header.appendChild(xBtn);
    modal.appendChild(header);

    // Reference preview
    const refSec = document.createElement("div");
    refSec.style.cssText = "margin-bottom:16px;";
    refSec.appendChild(editorLabel("Reference Image"));
    const refImg = document.createElement("img");
    refImg.src = dataUrl;
    refImg.style.cssText = "max-width:120px;max-height:80px;border:1px solid #444;border-radius:4px;display:block;padding:8px;background:#0e0e10;box-sizing:border-box;";
    refSec.appendChild(refImg);
    const refMetaEl = document.createElement("div");
    refMetaEl.style.cssText = "color:#adadb8;font-size:10px;margin-top:4px;";
    refMetaEl.textContent = `${meta.cropW}×${meta.cropH} px · from ${meta.videoW}×${meta.videoH} source`;
    refSec.appendChild(refMetaEl);
    modal.appendChild(refSec);

    const initialMaskDataUrl = (isEdit && opts.trigger?.references?.[0]?.maskDataUrl) || null;
    const maskSec = document.createElement("div");
    maskSec.style.cssText = "margin-bottom:16px;";
    maskSec.appendChild(editorLabel("Match Mask"));
    const maskHint = document.createElement("div");
    maskHint.style.cssText = "color:#adadb8;font-size:11px;line-height:1.4;margin-bottom:8px;";
    maskHint.textContent = "Paint what should count as the match. Ignored background is tinted red. Mouse wheel changes brush size.";
    maskSec.appendChild(maskHint);
    const maskEditor = buildMaskEditor(dataUrl, initialMaskDataUrl);
    destroyMaskEditor = maskEditor.destroy;
    maskSec.appendChild(maskEditor.el);
    modal.appendChild(maskSec);

    // Payloads
    modal.appendChild(editorLabel("Payloads"));
    const payloadsContainer = document.createElement("div");
    modal.appendChild(payloadsContainer);

    const payloadStates = isEdit && opts.trigger?.payloads?.length
      ? opts.trigger.payloads.map(p => ({
          title: p.title || "",
          text:  p.text  || "",
          ox:    p.popupOffset?.x ?? 14,
          oy:    p.popupOffset?.y ?? 22,
        }))
      : [{ title: "", text: "", ox: 14, oy: 22 }];

    function renderPayloads() {
      payloadsContainer.innerHTML = "";
      payloadStates.forEach((state, idx) => payloadsContainer.appendChild(buildPayloadRow(state, idx)));
    }

    function buildPayloadRow(state, idx) {
      const row = document.createElement("div");
      row.style.cssText = "background:#0e0e10;border:1px solid #333;border-radius:6px;padding:12px;margin-bottom:10px;";

      const rowHead = document.createElement("div");
      rowHead.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;";
      const rowNum = document.createElement("span");
      rowNum.style.cssText = "font-size:11px;color:#adadb8;font-weight:bold;letter-spacing:.05em;";
      rowNum.textContent = `PAYLOAD ${idx + 1}`;
      rowHead.appendChild(rowNum);
      if (payloadStates.length > 1) {
        const removeBtn = editorBtn("Remove", false);
        removeBtn.style.fontSize = "11px";
        removeBtn.onclick = () => { payloadStates.splice(idx, 1); renderPayloads(); };
        rowHead.appendChild(removeBtn);
      }
      row.appendChild(rowHead);

      row.appendChild(editorLabel("Title"));
      const titleInput = document.createElement("input");
      Object.assign(titleInput.style, {
        width: "100%", boxSizing: "border-box", background: "#18181b", border: "1px solid #555",
        borderRadius: "4px", color: "#efeff1", padding: "6px 8px", fontSize: "13px",
        marginBottom: "10px", display: "block",
      });
      titleInput.type = "text";
      titleInput.value = state.title;
      titleInput.placeholder = "e.g. Ice Cream";
      titleInput.oninput = () => { state.title = titleInput.value; updatePreview(); };
      row.appendChild(titleInput);

      row.appendChild(editorLabel("Text"));
      const textArea = document.createElement("textarea");
      Object.assign(textArea.style, {
        width: "100%", boxSizing: "border-box", background: "#18181b", border: "1px solid #555",
        borderRadius: "4px", color: "#efeff1", padding: "6px 8px", fontSize: "13px",
        resize: "vertical", minHeight: "56px", marginBottom: "10px", display: "block",
      });
      textArea.value = state.text;
      textArea.placeholder = "e.g. Relic — Ice Cream. Gain 3 Energy at the start of each turn.";
      textArea.oninput = () => { state.text = textArea.value; updatePreview(); };
      row.appendChild(textArea);

      row.appendChild(editorLabel("Popup Position — drag to adjust"));
      const { el: dragEl, updatePreview } = buildOffsetDragArea(state, refImg);
      row.appendChild(dragEl);

      return row;
    }

    renderPayloads();

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Add Payload";
    addBtn.style.cssText =
      "width:100%;background:none;border:1px dashed #555;border-radius:4px;" +
      "color:#adadb8;font-size:13px;cursor:pointer;padding:8px;margin-bottom:16px;";
    addBtn.onmouseenter = () => { addBtn.style.borderColor = "#9146ff"; addBtn.style.color = "#9146ff"; };
    addBtn.onmouseleave = () => { addBtn.style.borderColor = "#555"; addBtn.style.color = "#adadb8"; };
    addBtn.onclick = () => { payloadStates.push({ title: "", text: "", ox: 14, oy: 22 }); renderPayloads(); };
    modal.appendChild(addBtn);

    function validate() {
      if (payloadStates.every(p => !p.title.trim() && !p.text.trim())) {
        showToast("Add a title or text to at least one payload.", "warn");
        return false;
      }
      if (maskEditor.getMaskSummary().coverage === 0) {
        showToast("Your mask is fully erased — paint at least some pixels to match.", "warn");
        return false;
      }
      return true;
    }

    function buildTrigger() {
      const maskDataUrl = maskEditor.getMaskDataUrl();
      const payloads = payloadStates.map(p => ({
        title: p.title.trim(),
        text:  p.text.trim(),
        image: null,
        popupOffset: { x: p.ox, y: p.oy },
      }));
      if (isProfileEdit) {
        return {
          id: opts.trigger.id,
          payloads,
          references: (opts.trigger.references || []).map((ref, idx) => ({
            file: ref.file ?? null,
            w: ref.w ?? null,
            h: ref.h ?? null,
            srcW: ref.srcW ?? null,
            srcH: ref.srcH ?? null,
            maskDataUrl: idx === 0 ? maskDataUrl : (ref.maskDataUrl || null),
          })),
        };
      }
      if (isEdit) {
        // User trigger: preserve ID, carry existing dataUrl references so they can be re-submitted
        const refs = (opts.trigger.references || []).map(
          ({ dataUrl: du, maskDataUrl: existingMask, file, w, h, srcW, srcH }, idx) => ({
            dataUrl: du,
            maskDataUrl: idx === 0 ? maskDataUrl : (existingMask || null),
            file,
            w,
            h,
            srcW,
            srcH,
          })
        );
        return { id: opts.trigger.id, payloads, references: refs };
      }
      return {
        id: "user-" + Date.now(),
        payloads,
        references: [{ dataUrl, maskDataUrl, w: meta.cropW, h: meta.cropH, srcW: meta.videoW, srcH: meta.videoH }],
      };
    }

    async function saveLocally(trigger) {
      // Replace in-memory entry if editing an existing trigger, otherwise append.
      const existingIdx = TRIGGERS.findIndex(t => t.id === trigger.id);
      if (existingIdx >= 0) TRIGGERS[existingIdx] = trigger;
      else TRIGGERS.push(trigger);
      loadRefImages(trigger);
      await saveUserTrigger(trigger, isEdit);
    }

    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;gap:10px;align-items:center;";

    const cancelBtn = editorBtn("Cancel", false);
    cancelBtn.onclick = () => closeEditor();

    const submitLabel = isProfileEdit ? "Propose Update" : (WORKER_URL ? "Submit to Profile" : "Save Trigger");
    const submitBtn = editorBtn(submitLabel, true);
    submitBtn.style.flex = "1";
    submitBtn.onclick = async () => {
      if (!validate()) return;
      const trigger = buildTrigger();

      if (isProfileEdit) {
        // Profile trigger edit: propose update PR only, no local save
        if (!WORKER_URL) {
          showToast("Worker not configured — cannot propose updates.", "warn");
          return;
        }
        submitBtn.textContent = "Submitting…";
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
          const result = await submitToProfile(trigger, "update");
          closeEditor(result.direct ? "Update submitted directly!" : "Update proposed! PR opened.", "ok");
          if (result.prUrl) console.log("[overlay/content] update PR:", result.prUrl);
        } catch (err) {
          console.error("[overlay/content] update submit FAILED:", err.message, err);
          submitBtn.textContent = "Retry Submit";
          submitBtn.disabled = false;
          cancelBtn.disabled = false;
          showSubmitError(footer, err.message);
          showToast("Submit failed — see error above in editor.", "warn");
        }
        return;
      }

      // New trigger or user-trigger re-edit: save locally then optionally submit
      await saveLocally(trigger);

      if (!WORKER_URL) {
        closeEditor(isEdit ? "Trigger updated!" : "Trigger saved!", "ok");
        return;
      }

      submitBtn.textContent = "Submitting…";
      submitBtn.disabled = true;
      cancelBtn.disabled = true;

      try {
        const result = await submitToProfile(trigger, "add");
        closeEditor(result.direct ? "Submitted directly!" : "Submitted! PR opened.", "ok");
        if (result.prUrl) console.log("[overlay/content] add PR:", result.prUrl);
      } catch (err) {
        console.error("[overlay/content] submit FAILED:", err.message, err);
        submitBtn.textContent = "Retry Submit";
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        showSubmitError(footer, err.message);
        showToast("Submit failed — see error above in editor.", "warn");
      }
    };

    footer.appendChild(cancelBtn);
    footer.appendChild(submitBtn);

    if (!isProfileEdit && WORKER_URL) {
      const localLink = document.createElement("a");
      localLink.href = "#";
      localLink.textContent = "local only";
      localLink.style.cssText = "font-size:11px;color:#adadb8;white-space:nowrap;cursor:pointer;";
      localLink.onclick = async (e) => {
        e.preventDefault();
        if (!validate()) return;
        await saveLocally(buildTrigger());
        closeEditor(isEdit ? "Trigger updated locally." : "Saved locally.", "ok");
      };
      footer.appendChild(localLink);
    }

    modal.appendChild(footer);
  }

  function buildOffsetDragArea(state, refImg) {
    const AREA_H = 130;
    const CX = 70, CY = 65; // cursor anchor within the drag area

    const area = document.createElement("div");
    Object.assign(area.style, {
      position: "relative", width: "100%", height: AREA_H + "px",
      background: "#111", border: "1px solid #333", borderRadius: "4px",
      marginBottom: "10px", overflow: "hidden", userSelect: "none", boxSizing: "border-box",
    });

    // Reference thumbnail centered on anchor
    const thumb = document.createElement("img");
    thumb.src = refImg.src;
    Object.assign(thumb.style, {
      position: "absolute", maxWidth: "56px", maxHeight: "48px",
      left: (CX - 28) + "px", top: (CY - 24) + "px",
      border: "1px solid #9146ff", borderRadius: "2px", pointerEvents: "none",
    });
    area.appendChild(thumb);

    // Cursor dot at anchor
    const dot = document.createElement("div");
    Object.assign(dot.style, {
      position: "absolute", width: "8px", height: "8px", borderRadius: "50%",
      background: "#ff3860", left: (CX - 4) + "px", top: (CY - 4) + "px",
      pointerEvents: "none", zIndex: "2",
    });
    area.appendChild(dot);

    // Offset readout
    const readout = document.createElement("div");
    Object.assign(readout.style, {
      position: "absolute", bottom: "4px", left: "6px",
      color: "#adadb8", fontSize: "10px", pointerEvents: "none", zIndex: "2",
    });
    area.appendChild(readout);

    // Draggable popup preview
    const popupEl = document.createElement("div");
    Object.assign(popupEl.style, {
      position: "absolute", background: "rgba(24,24,27,0.95)", color: "#efeff1",
      border: "1px solid #9146ff", borderRadius: "6px", padding: "5px 9px",
      fontSize: "11px", lineHeight: "1.4", maxWidth: "180px",
      cursor: "grab", zIndex: "3",
      left: (CX + state.ox) + "px", top: (CY + state.oy) + "px",
    });
    area.appendChild(popupEl);

    function updatePreview() {
      const t = state.title || "(title)";
      const b = state.text  || "(body text)";
      popupEl.innerHTML =
        `<div style="font-weight:bold;color:#bf94ff;margin-bottom:2px">${t}</div>` +
        `<div style="color:#ccc;">${b.length > 60 ? b.slice(0, 60) + "…" : b}</div>`;
      readout.textContent = `x: ${state.ox}  y: ${state.oy}`;
    }
    updatePreview();

    popupEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startCX = e.clientX, startCY = e.clientY;
      const startLeft = CX + state.ox, startTop = CY + state.oy;
      popupEl.style.cursor = "grabbing";

      // Measure the area at drag-start to clamp correctly
      const areaRect = area.getBoundingClientRect();

      function onMove(e) {
        const newLeft = Math.max(0, Math.min(areaRect.width  - 20, startLeft + e.clientX - startCX));
        const newTop  = Math.max(0, Math.min(AREA_H - 20,          startTop  + e.clientY - startCY));
        popupEl.style.left = newLeft + "px";
        popupEl.style.top  = newTop  + "px";
        state.ox = Math.round(newLeft - CX);
        state.oy = Math.round(newTop  - CY);
        readout.textContent = `x: ${state.ox}  y: ${state.oy}`;
      }
      function onUp() {
        popupEl.style.cursor = "grab";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });

    return { el: area, updatePreview };
  }

  function buildMaskEditor(imageUrl, initialMaskDataUrl) {
    const state = {
      brushShape: "round",
      brushMode: "erase",
      tool: "brush",
      brushSize: 18,
      hoverX: 0,
      hoverY: 0,
      hovering: false,
      painting: false,
      imageLoaded: false,
      polygonPoints: [],
      polygonHover: null,
      summary: { coverage: 1, keptPixels: 0, totalPixels: 0 },
    };

    const wrap = document.createElement("div");
    wrap.style.cssText = "background:#0e0e10;border:1px solid #333;border-radius:6px;padding:10px;";

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;";
    wrap.appendChild(toolbar);

    const info = document.createElement("div");
    info.style.cssText = "margin-left:auto;color:#adadb8;font-size:11px;white-space:nowrap;";
    toolbar.appendChild(info);

    function makeToggleButton(label, active = false) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText =
        `background:${active ? "#9146ff" : "#18181b"};border:1px solid ${active ? "#9146ff" : "#555"};` +
        `border-radius:4px;color:${active ? "#fff" : "#adadb8"};font-size:12px;cursor:pointer;padding:6px 10px;`;
      return btn;
    }

    function setToggleState(btn, active) {
      btn.style.background = active ? "#9146ff" : "#18181b";
      btn.style.borderColor = active ? "#9146ff" : "#555";
      btn.style.color = active ? "#fff" : "#adadb8";
    }

    const brushBtn = makeToggleButton("Brush", true);
    const polygonBtn = makeToggleButton("Polygon");
    const roundBtn = makeToggleButton("Round", true);
    const squareBtn = makeToggleButton("Square");
    const paintBtn = makeToggleButton("Paint");
    const eraseBtn = makeToggleButton("Erase", true);
    const fillBtn = makeToggleButton("Fill All");
    const clearBtn = makeToggleButton("Clear All");
    const applyPolygonBtn = makeToggleButton("Apply Polygon");
    const cancelPolygonBtn = makeToggleButton("Cancel Polygon");

    [brushBtn, polygonBtn, roundBtn, squareBtn, paintBtn, eraseBtn, fillBtn, clearBtn, applyPolygonBtn, cancelPolygonBtn]
      .forEach(btn => toolbar.appendChild(btn));

    const canvasWrap = document.createElement("div");
    canvasWrap.style.cssText = "display:flex;justify-content:center;align-items:center;background:#111;border:1px solid #222;border-radius:4px;padding:8px;overflow:auto;";
    wrap.appendChild(canvasWrap);

    const stage = document.createElement("div");
    stage.style.cssText = "position:relative;display:inline-block;line-height:0;cursor:none;";
    canvasWrap.appendChild(stage);

    const imageCanvas = document.createElement("canvas");
    imageCanvas.style.cssText = "display:block;max-width:100%;image-rendering:auto;";
    stage.appendChild(imageCanvas);
    const imageCtx = imageCanvas.getContext("2d");

    const tintCanvas = document.createElement("canvas");
    tintCanvas.style.cssText = "position:absolute;inset:0;display:block;pointer-events:none;";
    stage.appendChild(tintCanvas);
    const tintCtx = tintCanvas.getContext("2d");

    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.style.cssText = "position:absolute;inset:0;display:block;cursor:none;pointer-events:none;";
    stage.appendChild(overlayCanvas);
    const overlayCtx = overlayCanvas.getContext("2d");

    const maskCanvas = document.createElement("canvas");
    const maskCtx = maskCanvas.getContext("2d");
    const sourceImg = new Image();
    const maskImg = initialMaskDataUrl ? new Image() : null;
    let tintDirty = false;
    let overlayDirty = false;
    let rafPending = false;
    let summaryDirty = false;

    function updateInfo() {
      const toolLabel = state.tool === "polygon" ? "polygon include" : `${state.brushShape} ${state.brushMode}`;
      const polySuffix = state.tool === "polygon" ? ` · ${state.polygonPoints.length} pts` : "";
      info.textContent = `${toolLabel} · ${state.brushSize}px${polySuffix} · ${Math.round(state.summary.coverage * 100)}% kept`;
      roundBtn.style.display = state.tool === "brush" ? "inline-block" : "none";
      squareBtn.style.display = state.tool === "brush" ? "inline-block" : "none";
      paintBtn.style.display = state.tool === "brush" ? "inline-block" : "none";
      eraseBtn.style.display = state.tool === "brush" ? "inline-block" : "none";
      applyPolygonBtn.style.display = state.tool === "polygon" ? "inline-block" : "none";
      cancelPolygonBtn.style.display = state.tool === "polygon" ? "inline-block" : "none";
    }

    function canvasCoords(event) {
      const rect = stage.getBoundingClientRect();
      const scaleX = imageCanvas.width / rect.width;
      const scaleY = imageCanvas.height / rect.height;
      return {
        x: Math.max(0, Math.min(imageCanvas.width - 1, Math.round((event.clientX - rect.left) * scaleX))),
        y: Math.max(0, Math.min(imageCanvas.height - 1, Math.round((event.clientY - rect.top) * scaleY))),
      };
    }

    function drawBrushPreview() {
      if (!state.hovering || state.painting || state.tool !== "brush") return;
      overlayCtx.save();
      overlayCtx.strokeStyle = state.brushMode === "paint" ? "#00f593" : "#ff3860";
      overlayCtx.lineWidth = Math.max(1, Math.round(imageCanvas.width / 180));
      if (state.brushShape === "round") {
        overlayCtx.beginPath();
        overlayCtx.arc(state.hoverX, state.hoverY, state.brushSize / 2, 0, Math.PI * 2);
        overlayCtx.stroke();
      } else {
        const half = state.brushSize / 2;
        overlayCtx.strokeRect(state.hoverX - half, state.hoverY - half, state.brushSize, state.brushSize);
      }
      overlayCtx.restore();
    }

    function drawPolygonCrosshair() {
      if (!state.hovering || state.tool !== "polygon") return;
      overlayCtx.save();
      overlayCtx.strokeStyle = "#f5f5f5";
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.moveTo(state.hoverX - 7, state.hoverY);
      overlayCtx.lineTo(state.hoverX + 7, state.hoverY);
      overlayCtx.moveTo(state.hoverX, state.hoverY - 7);
      overlayCtx.lineTo(state.hoverX, state.hoverY + 7);
      overlayCtx.stroke();
      overlayCtx.restore();
    }

    function drawPolygonPreview() {
      if (state.tool !== "polygon" || state.polygonPoints.length === 0) return;
      overlayCtx.save();
      overlayCtx.lineWidth = Math.max(1, Math.round(imageCanvas.width / 180));
      overlayCtx.strokeStyle = "#00f593";
      overlayCtx.fillStyle = "rgba(0,245,147,0.20)";
      overlayCtx.beginPath();
      overlayCtx.moveTo(state.polygonPoints[0].x, state.polygonPoints[0].y);
      for (let i = 1; i < state.polygonPoints.length; i++) {
        overlayCtx.lineTo(state.polygonPoints[i].x, state.polygonPoints[i].y);
      }
      if (state.polygonHover) {
        overlayCtx.lineTo(state.polygonHover.x, state.polygonHover.y);
      }
      overlayCtx.stroke();
      for (const pt of state.polygonPoints) {
        overlayCtx.beginPath();
        overlayCtx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
        overlayCtx.fillStyle = "#00f593";
        overlayCtx.fill();
      }
      overlayCtx.restore();
    }

    function refreshSummary() {
      if (!state.imageLoaded) {
        state.summary = { coverage: 1, keptPixels: 0, totalPixels: 0 };
        return state.summary;
      }
      const image = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
      let kept = 0;
      for (let i = 3; i < image.length; i += 4) {
        if (image[i] >= 128) kept++;
      }
      const total = maskCanvas.width * maskCanvas.height;
      state.summary = { coverage: total ? kept / total : 0, keptPixels: kept, totalPixels: total };
      summaryDirty = false;
      return state.summary;
    }

    function renderTint() {
      if (!state.imageLoaded) return;
      tintCtx.clearRect(0, 0, tintCanvas.width, tintCanvas.height);
      tintCtx.save();
      tintCtx.fillStyle = "rgba(255,56,96,0.30)";
      tintCtx.fillRect(0, 0, tintCanvas.width, tintCanvas.height);
      tintCtx.globalCompositeOperation = "destination-out";
      tintCtx.drawImage(maskCanvas, 0, 0);
      tintCtx.restore();

      tintCtx.save();
      tintCtx.fillStyle = "rgba(0,245,147,0.24)";
      tintCtx.fillRect(0, 0, tintCanvas.width, tintCanvas.height);
      tintCtx.globalCompositeOperation = "destination-in";
      tintCtx.drawImage(maskCanvas, 0, 0);
      tintCtx.restore();
      updateInfo();
    }

    function renderOverlay() {
      if (!state.imageLoaded) return;
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      updateInfo();
      drawBrushPreview();
      drawPolygonCrosshair();
      drawPolygonPreview();
    }

    function scheduleRender(needsTint = false, needsOverlay = true) {
      tintDirty = tintDirty || needsTint;
      overlayDirty = overlayDirty || needsOverlay;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (tintDirty) {
          renderTint();
          tintDirty = false;
          overlayDirty = true;
        }
        if (overlayDirty) {
          renderOverlay();
          overlayDirty = false;
        }
      });
    }

    function applyBrush(x, y) {
      const half = state.brushSize / 2;
      maskCtx.save();
      if (state.brushMode === "paint") {
        maskCtx.globalCompositeOperation = "source-over";
        maskCtx.fillStyle = "#fff";
      } else {
        maskCtx.globalCompositeOperation = "destination-out";
      }
      if (state.brushShape === "round") {
        maskCtx.beginPath();
        maskCtx.arc(x, y, half, 0, Math.PI * 2);
        maskCtx.fill();
      } else if (state.brushMode === "paint") {
        maskCtx.fillRect(x - half, y - half, state.brushSize, state.brushSize);
      } else {
        maskCtx.clearRect(x - half, y - half, state.brushSize, state.brushSize);
      }
      maskCtx.restore();
      summaryDirty = true;
      scheduleRender(true, true);
    }

    function getMaskSummary() {
      if (summaryDirty) refreshSummary();
      return state.summary;
    }

    function getMaskDataUrl() {
      if (!state.imageLoaded) return null;
      const summary = getMaskSummary();
      if (summary.coverage >= 0.999) return null;
      return maskCanvas.toDataURL("image/png");
    }

    function fillMask() {
      if (!state.imageLoaded) return;
      maskCtx.globalCompositeOperation = "source-over";
      maskCtx.fillStyle = "#fff";
      maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
      state.polygonPoints = [];
      state.polygonHover = null;
      refreshSummary();
      scheduleRender(true, true);
    }

    function clearMask() {
      if (!state.imageLoaded) return;
      maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      state.polygonPoints = [];
      state.polygonHover = null;
      refreshSummary();
      scheduleRender(true, true);
    }

    function applyPolygon() {
      if (!state.imageLoaded || state.polygonPoints.length < 3) return;
      maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      maskCtx.save();
      maskCtx.fillStyle = "#fff";
      maskCtx.beginPath();
      maskCtx.moveTo(state.polygonPoints[0].x, state.polygonPoints[0].y);
      for (let i = 1; i < state.polygonPoints.length; i++) {
        maskCtx.lineTo(state.polygonPoints[i].x, state.polygonPoints[i].y);
      }
      maskCtx.closePath();
      maskCtx.fill();
      maskCtx.restore();
      state.polygonPoints = [];
      state.polygonHover = null;
      refreshSummary();
      scheduleRender(true, true);
    }

    brushBtn.onclick = () => {
      state.tool = "brush";
      state.polygonHover = null;
      setToggleState(brushBtn, true);
      setToggleState(polygonBtn, false);
      scheduleRender(false, true);
    };
    polygonBtn.onclick = () => {
      state.tool = "polygon";
      setToggleState(brushBtn, false);
      setToggleState(polygonBtn, true);
      scheduleRender(false, true);
    };
    roundBtn.onclick = () => {
      state.brushShape = "round";
      setToggleState(roundBtn, true);
      setToggleState(squareBtn, false);
      scheduleRender(false, true);
    };
    squareBtn.onclick = () => {
      state.brushShape = "square";
      setToggleState(roundBtn, false);
      setToggleState(squareBtn, true);
      scheduleRender(false, true);
    };
    paintBtn.onclick = () => {
      state.brushMode = "paint";
      setToggleState(paintBtn, true);
      setToggleState(eraseBtn, false);
      scheduleRender(false, true);
    };
    eraseBtn.onclick = () => {
      state.brushMode = "erase";
      setToggleState(paintBtn, false);
      setToggleState(eraseBtn, true);
      scheduleRender(false, true);
    };
    fillBtn.onclick = fillMask;
    clearBtn.onclick = clearMask;
    applyPolygonBtn.onclick = applyPolygon;
    cancelPolygonBtn.onclick = () => {
      state.polygonPoints = [];
      state.polygonHover = null;
      scheduleRender(false, true);
    };

    stage.addEventListener("mousedown", (event) => {
      if (!state.imageLoaded) return;
      const coords = canvasCoords(event);
      state.hovering = true;
      state.hoverX = coords.x;
      state.hoverY = coords.y;
      if (state.tool === "polygon") {
      state.polygonPoints.push(coords);
      state.polygonHover = coords;
      scheduleRender(false, true);
      return;
    }
      state.painting = true;
      applyBrush(coords.x, coords.y);
    });
    stage.addEventListener("mousemove", (event) => {
      if (!state.imageLoaded) return;
      const coords = canvasCoords(event);
      state.hovering = true;
      state.hoverX = coords.x;
      state.hoverY = coords.y;
      if (state.tool === "polygon") {
        state.polygonHover = coords;
        scheduleRender(false, true);
      } else if (state.painting) applyBrush(coords.x, coords.y);
      else scheduleRender(false, true);
    });
    stage.addEventListener("mouseenter", (event) => {
      if (!state.imageLoaded) return;
      const coords = canvasCoords(event);
      state.hovering = true;
      state.hoverX = coords.x;
      state.hoverY = coords.y;
      scheduleRender(false, true);
    });
    stage.addEventListener("mouseleave", () => {
      state.hovering = false;
      state.polygonHover = null;
      scheduleRender(false, true);
    });
    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      const next = event.deltaY < 0 ? state.brushSize + 2 : state.brushSize - 2;
      state.brushSize = Math.max(4, Math.min(96, next));
      scheduleRender(false, true);
    }, { passive: false });

    function stopPainting() {
      state.painting = false;
      if (summaryDirty) refreshSummary();
      scheduleRender(false, true);
    }
    document.addEventListener("mouseup", stopPainting);

    sourceImg.onload = () => {
      imageCanvas.width = sourceImg.naturalWidth;
      imageCanvas.height = sourceImg.naturalHeight;
      tintCanvas.width = sourceImg.naturalWidth;
      tintCanvas.height = sourceImg.naturalHeight;
      overlayCanvas.width = sourceImg.naturalWidth;
      overlayCanvas.height = sourceImg.naturalHeight;
      const scale = Math.min(1, 260 / sourceImg.naturalWidth, 180 / sourceImg.naturalHeight);
      const cssW = Math.max(48, Math.round(sourceImg.naturalWidth * scale)) + "px";
      const cssH = Math.max(48, Math.round(sourceImg.naturalHeight * scale)) + "px";
      imageCanvas.style.width = cssW;
      imageCanvas.style.height = cssH;
      tintCanvas.style.width = cssW;
      tintCanvas.style.height = cssH;
      overlayCanvas.style.width = cssW;
      overlayCanvas.style.height = cssH;
      imageCtx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
      imageCtx.drawImage(sourceImg, 0, 0, imageCanvas.width, imageCanvas.height);
      maskCanvas.width = sourceImg.naturalWidth;
      maskCanvas.height = sourceImg.naturalHeight;
      maskCtx.fillStyle = "#fff";
      maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
      state.imageLoaded = true;
      if (maskImg) {
        maskImg.onload = () => {
          maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
          maskCtx.drawImage(maskImg, 0, 0, maskCanvas.width, maskCanvas.height);
          refreshSummary();
          scheduleRender(true, true);
        };
        maskImg.onerror = () => {
          refreshSummary();
          scheduleRender(true, true);
        };
        maskImg.src = initialMaskDataUrl;
      } else {
        refreshSummary();
        scheduleRender(true, true);
      }
    };
    sourceImg.src = imageUrl;

    function destroy() {
      document.removeEventListener("mouseup", stopPainting);
    }

    updateInfo();
    return { el: wrap, getMaskDataUrl, getMaskSummary, destroy };
  }

  function editorLabel(text) {
    const el = document.createElement("div");
    el.style.cssText = "font-size:11px;color:#adadb8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;";
    el.textContent = text;
    return el;
  }

  function editorBtn(text, primary) {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.style.cssText = primary
      ? "background:#9146ff;border:none;border-radius:4px;color:#fff;font-size:13px;font-weight:bold;cursor:pointer;padding:9px 16px;"
      : "background:none;border:1px solid #555;border-radius:4px;color:#adadb8;font-size:13px;cursor:pointer;padding:9px 16px;";
    return btn;
  }

  // --- Popup ----------------------------------------------------------------

  const activePopups = [];

  function makePopupEl() {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed",
      background: "rgba(24,24,27,0.95)",
      color: "#efeff1",
      border: "1px solid #9146ff",
      borderRadius: "6px",
      padding: "10px 14px",
      fontFamily: "sans-serif",
      fontSize: "13px",
      lineHeight: "1.5",
      maxWidth: "260px",
      zIndex: "2147483645",
      pointerEvents: "auto",
      boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
    });
    el.addEventListener("mouseenter", () => { overPopup = true; });
    el.addEventListener("mouseleave", () => { overPopup = false; });
    document.body.appendChild(el);
    return el;
  }

  function showPopups(payloads, clientX, clientY, trigger) {
    currentMatchedTrigger = trigger || null;
    // Reuse or create one DOM element per payload.
    while (activePopups.length < payloads.length) activePopups.push(makePopupEl());

    const isProfileTrigger = trigger && !trigger.id?.startsWith("user-");
    const editLabel = isProfileTrigger ? "✏ Suggest edit" : "✏ Edit";

    payloads.forEach((payload, i) => {
      const el = activePopups[i];
      const ox = (payload.popupOffset && payload.popupOffset.x != null) ? payload.popupOffset.x : 14;
      const oy = (payload.popupOffset && payload.popupOffset.y != null) ? payload.popupOffset.y : 22;

      let html =
        `<div style="font-weight:bold;color:#bf94ff;margin-bottom:4px;">${payload.title}</div>` +
        `<div>${payload.text}</div>`;

      // Add edit link on the first popup for any matched trigger.
      if (i === 0 && trigger) {
        html +=
          `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #333;">` +
          `<a class="sg-edit-link" href="#" style="font-size:11px;color:#adadb8;text-decoration:none;">` +
          `${editLabel}</a></div>`;
      }

      el.innerHTML = html;
      el.style.left = Math.min(clientX + ox, window.innerWidth  - 280) + "px";
      el.style.top  = Math.min(clientY + oy, window.innerHeight - 100) + "px";
      el.style.display = "block";

      if (i === 0 && trigger) {
        const editLink = el.querySelector(".sg-edit-link");
        if (editLink) {
          editLink.onmouseenter = () => { editLink.style.color = "#9146ff"; };
          editLink.onmouseleave = () => { editLink.style.color = "#adadb8"; };
          editLink.onclick = (e) => {
            e.preventDefault();
            hidePopups();
            openEditTriggerEditor(trigger);
          };
        }
      }
    });

    // Hide any extras from a previous trigger that had more payloads.
    for (let i = payloads.length; i < activePopups.length; i++)
      activePopups[i].style.display = "none";
  }

  function hidePopups() {
    currentMatchedTrigger = null;
    overPopup = false;
    for (const el of activePopups) el.style.display = "none";
  }

  function refToDataUrl(ref) {
    if (ref.dataUrl) return ref.dataUrl;
    if (!ref.sourceImg) return null;
    const c = document.createElement("canvas");
    c.width  = ref.origW || ref.sourceImg.naturalWidth;
    c.height = ref.origH || ref.sourceImg.naturalHeight;
    c.getContext("2d").drawImage(ref.sourceImg, 0, 0);
    return c.toDataURL("image/png");
  }

  function openEditTriggerEditor(trigger) {
    const ref = trigger.references?.[0];
    if (!ref) { showToast("No reference image for this trigger.", "warn"); return; }
    const dataUrl = refToDataUrl(ref);
    if (!dataUrl) { showToast("Reference image not loaded yet — try again.", "warn"); return; }
    const meta = {
      videoW: ref.srcW || 1920,
      videoH: ref.srcH || 1080,
      cropW:  ref.w    || ref.origW || 0,
      cropH:  ref.h    || ref.origH || 0,
    };
    openTriggerEditor(dataUrl, meta, { mode: "edit", trigger });
  }

  // --- Mouse handler --------------------------------------------------------

  let lastMouseX = 0;
  let lastMouseY = 0;

  function onDocumentMouseMove(event) {
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;

    if (editorModalOpen) {
      hidePopups();
      return;
    }

    // Cursor is hovering over a popup — don't disturb it.
    if (overPopup) return;

    const prevOver = mouseOverVideo;
    let inBounds = false;
    if (currentVideo) {
      const rect = currentVideo.getBoundingClientRect();
      inBounds =
        event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top  && event.clientY <= rect.bottom &&
        rect.width > 0 && rect.height > 0;
    }
    mouseOverVideo = inBounds;
    if (prevOver !== mouseOverVideo) updateDebugPanelStatus();

    if (!mouseOverVideo || !currentVideo || !currentVideo.videoWidth) {
      renderDebugInfoOnly();
      hidePopups();
      return;
    }

    const now = performance.now();
    if (now - lastCaptureTime < CAPTURE_INTERVAL_MS) return;
    lastCaptureTime = now;

    const coords = clientToVideoCoords(currentVideo, event.clientX, event.clientY);
    if (!coords) return;

    const result = captureRegion(currentVideo, coords.x, coords.y);
    if (!result) return;

    // Single getImageData read — all matching runs against this array.
    const capturePixels = captureCtx.getImageData(0, 0, CAPTURE_SIZE, CAPTURE_SIZE).data;
    const matchResult = findBestMatch(capturePixels);
    const best = matchResult.best;
    const threshold = best ? matchThresholdForRef(best.ref) : MATCH_THRESHOLD_RATIO;
    const verifyThreshold = best ? verifyThresholdForRef(best.ref) : null;
    const verifyOk = verifyThreshold == null || (best && best.verifyScore != null && best.verifyScore <= verifyThreshold);
    if (best && best.ratio <= threshold && best.validBits >= MIN_MASKED_BITS && verifyOk) {
      const label = best.trigger.payloads ? best.trigger.payloads[0].title : best.trigger.id;
      lastMatchInfo = {
        title: label,
        dist: best.dist,
        ratio: best.ratio,
        validBits: best.validBits,
        threshold,
        verifyScore: best.verifyScore,
        verifyThreshold,
        candidates: matchResult.candidates,
      };
      showPopups(best.trigger.payloads || [], event.clientX, event.clientY, best.trigger);
    } else {
      const label = best ? (best.trigger.payloads ? best.trigger.payloads[0].title : best.trigger.id) : null;
      lastMatchInfo = best ? {
        title: label,
        dist: best.dist,
        ratio: best.ratio,
        validBits: best.validBits,
        threshold,
        verifyScore: best.verifyScore,
        verifyThreshold,
        noMatch: true,
        candidates: matchResult.candidates,
      } : null;
      hidePopups();
    }

    // Cursor position within the 160×160 capture window.
    const cursorInCapX = Math.round(coords.x - result.sx);
    const cursorInCapY = Math.round(coords.y - result.sy);

    renderDebugPanel({
      clientX: event.clientX,
      clientY: event.clientY,
      videoX: Math.round(coords.x),
      videoY: Math.round(coords.y),
      captureX: Math.round(result.sx),
      captureY: Math.round(result.sy),
      videoW: currentVideo.videoWidth,
      videoH: currentVideo.videoHeight,
      cursorInCapX,
      cursorInCapY,
      rectLeft: coords.rectLeft, rectTop: coords.rectTop,
      offsetX: coords.offsetX,   offsetY: coords.offsetY,
      objectFit: coords.objectFit,
    });
  }

  function renderDebugInfoOnly() {
    const infoEl = document.getElementById("stream-overlay-debug-info");
    if (!infoEl) return;
    infoEl.innerHTML = `mouse: ${lastMouseX}, ${lastMouseY}<br>(not over video)`;
  }

  // --- Debug panel ----------------------------------------------------------

  function ensureDebugPanel() {
    if (debugPanel) return debugPanel;

    debugPanel = document.createElement("div");
    debugPanel.id = "stream-overlay-debug";
    Object.assign(debugPanel.style, {
      position: "fixed", top: "80px", right: "16px", width: "200px",
      padding: "8px", background: "rgba(24,24,27,0.92)", border: "1px solid #9146ff",
      borderRadius: "6px", color: "#efeff1", fontFamily: "monospace", fontSize: "11px",
      zIndex: "2147483647", pointerEvents: "none", backdropFilter: "blur(4px)",
    });

    const title = document.createElement("div");
    title.textContent = "overlay debug";
    title.style.cssText = "color:#bf94ff;font-weight:bold;margin-bottom:6px;";
    debugPanel.appendChild(title);

    const status = document.createElement("div");
    status.id = "stream-overlay-debug-status";
    status.style.cssText = "margin-bottom:6px;line-height:1.4;";
    debugPanel.appendChild(status);

    const canvasWrap = document.createElement("div");
    canvasWrap.style.cssText = "width:160px;height:160px;background:#000;border:1px solid #333;";
    debugPanel.appendChild(canvasWrap);

    const displayCanvas = document.createElement("canvas");
    displayCanvas.id = "stream-overlay-debug-canvas";
    displayCanvas.width = CAPTURE_SIZE;
    displayCanvas.height = CAPTURE_SIZE;
    displayCanvas.style.cssText = "width:160px;height:160px;display:block;";
    canvasWrap.appendChild(displayCanvas);

    const info = document.createElement("div");
    info.id = "stream-overlay-debug-info";
    info.style.cssText = "margin-top:6px;line-height:1.4;";
    debugPanel.appendChild(info);

    document.body.appendChild(debugPanel);
    updateDebugPanelStatus();
    return debugPanel;
  }

  function updateDebugPanelStatus() {
    ensureDebugPanel();
    const status = document.getElementById("stream-overlay-debug-status");
    if (!status) return;
    const stats = window.__streamOverlayStats || { total: 0, visible: 0 };
    const refsLoaded = TRIGGERS.reduce((n, t) => n + (t.references ? t.references.filter(r => r.refHash).length : 0), 0);
    const refsTotal  = TRIGGERS.reduce((n, t) => n + (t.references ? t.references.length : 0), 0);
    const lines = [
      `<span style="color:#adadb8">videos: ${stats.total}t ${stats.visible}v | refs: ${refsLoaded}/${refsTotal}</span>`,
    ];
    if (!currentVideo) {
      lines.unshift(`<span style="color:#f5b000">no video</span>`);
    } else if (!currentVideo.videoWidth) {
      lines.unshift(`<span style="color:#f5b000">video loading…</span>`);
    } else if (!mouseOverVideo) {
      lines.unshift(`<span style="color:#adadb8">hover to capture</span>`);
    } else {
      lines.unshift(`<span style="color:#00f593">capturing</span>`);
    }
    status.innerHTML = lines.join("<br>");
  }

  function renderDebugPanel(info) {
    ensureDebugPanel();
    const displayCanvas = document.getElementById("stream-overlay-debug-canvas");
    if (!displayCanvas) return;
    const dctx = displayCanvas.getContext("2d");
    dctx.drawImage(captureCanvas, 0, 0);

    // Crosshair at the cursor's computed position within the capture.
    // If this dot sits over what you're pointing at, the coordinate transform is correct.
    const cx = info.cursorInCapX, cy = info.cursorInCapY;
    dctx.strokeStyle = "#ff3860";
    dctx.lineWidth = 1;
    dctx.beginPath();
    dctx.moveTo(cx - 8, cy); dctx.lineTo(cx + 8, cy);
    dctx.moveTo(cx, cy - 8); dctx.lineTo(cx, cy + 8);
    dctx.stroke();

    const infoEl = document.getElementById("stream-overlay-debug-info");
    if (!infoEl) return;
    let matchLine = "";
    if (lastMatchInfo) {
      const verifyText = lastMatchInfo.verifyThreshold != null && lastMatchInfo.verifyScore != null
        ? ` · v=${Math.round(lastMatchInfo.verifyScore * 100)}% <= ${Math.round(lastMatchInfo.verifyThreshold * 100)}%`
        : "";
      matchLine = lastMatchInfo.noMatch
        ? `<span style="color:#adadb8">best: ${lastMatchInfo.dist}/${lastMatchInfo.validBits} (${Math.round(lastMatchInfo.ratio * 100)}%) <= ${Math.round(lastMatchInfo.threshold * 100)}%${verifyText} "${lastMatchInfo.title}"</span>`
        : `<span style="color:#00f593">MATCH "${lastMatchInfo.title}" ${lastMatchInfo.dist}/${lastMatchInfo.validBits} (${Math.round(lastMatchInfo.ratio * 100)}%) <= ${Math.round(lastMatchInfo.threshold * 100)}%${verifyText}</span>`;
    }
    const candidateLines = (lastMatchInfo?.candidates || [])
      .map((c, idx) => {
        const verifyText = c.verifyThreshold != null && c.verifyScore != null
          ? ` · v${Math.round(c.verifyScore * 100)}<=${Math.round(c.verifyThreshold * 100)}`
          : "";
        return `#${idx + 1} ${Math.round(c.ratio * 100)}% (${c.dist}/${c.validBits}) <= ${Math.round(c.threshold * 100)}%${verifyText} ${c.title}`;
      })
      .join("<br>");
    infoEl.innerHTML =
      `client: ${info.clientX}, ${info.clientY}<br>` +
      `video:  ${info.videoX}, ${info.videoY}<br>` +
      `rect:   ${info.rectLeft}, ${info.rectTop}<br>` +
      `offset: ${info.offsetX}, ${info.offsetY}<br>` +
      `fit:    ${info.objectFit}<br>` +
      `source: ${info.videoW}x${info.videoH}` +
      (matchLine ? `<br>${matchLine}` : "") +
      (candidateLines ? `<br><span style="color:#888">top:</span><br>${candidateLines}` : "");
  }

  // --- Capture mode ---------------------------------------------------------

  let captureMode = null;

  function startCaptureMode() {
    if (captureMode) return;
    if (!currentVideo || !currentVideo.videoWidth) {
      showToast("Can't capture — no video playing.", "warn");
      return;
    }
    const rect = currentVideo.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
      showToast("Can't capture — video isn't visible.", "warn");
      return;
    }

    const snapshot = document.createElement("canvas");
    snapshot.width = currentVideo.videoWidth;
    snapshot.height = currentVideo.videoHeight;
    try {
      snapshot.getContext("2d").drawImage(currentVideo, 0, 0);
    } catch (err) {
      showToast("Capture failed: " + err.message, "error");
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = "stream-overlay-capture";
    Object.assign(overlay.style, {
      position: "fixed", left: rect.left + "px", top: rect.top + "px",
      width: rect.width + "px", height: rect.height + "px",
      zIndex: "2147483646", cursor: "crosshair", pointerEvents: "auto", userSelect: "none",
    });

    const displayCanvas = document.createElement("canvas");
    displayCanvas.width = snapshot.width;
    displayCanvas.height = snapshot.height;
    displayCanvas.style.cssText = "width:100%;height:100%;display:block;";
    displayCanvas.getContext("2d").drawImage(snapshot, 0, 0);
    overlay.appendChild(displayCanvas);

    const hint = document.createElement("div");
    hint.style.cssText =
      "position:absolute;top:12px;left:50%;transform:translateX(-50%);" +
      "background:rgba(24,24,27,0.92);color:#efeff1;padding:8px 16px;" +
      "border:1px solid #9146ff;border-radius:6px;font-family:sans-serif;" +
      "font-size:13px;pointer-events:none;";
    hint.textContent = "Drag a box around the thing to annotate — Esc to cancel";
    overlay.appendChild(hint);

    const selection = document.createElement("div");
    selection.style.cssText =
      "position:absolute;border:2px solid #00f593;background:rgba(0,245,147,0.18);" +
      "box-shadow:0 0 0 9999px rgba(255,56,96,0.26);" +
      "display:none;pointer-events:none;";
    overlay.appendChild(selection);

    document.body.appendChild(overlay);
    captureMode = { overlay, snapshot, videoRect: rect, selection, dragStart: null };

    overlay.addEventListener("mousedown", onCaptureMouseDown);
    overlay.addEventListener("mousemove", onCaptureMouseMove);
    overlay.addEventListener("mouseup", onCaptureMouseUp);
    document.addEventListener("keydown", onCaptureKeyDown, true);
  }

  function cancelCaptureMode() {
    if (!captureMode) return;
    captureMode.overlay.remove();
    document.removeEventListener("keydown", onCaptureKeyDown, true);
    captureMode = null;
  }

  function onCaptureKeyDown(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelCaptureMode(); showToast("Capture cancelled.", "info"); }
  }

  function onCaptureMouseDown(e) {
    if (!captureMode) return;
    const r = captureMode.overlay.getBoundingClientRect();
    captureMode.dragStart = { x: e.clientX - r.left, y: e.clientY - r.top };
    Object.assign(captureMode.selection.style, {
      left: captureMode.dragStart.x + "px", top: captureMode.dragStart.y + "px",
      width: "0px", height: "0px", display: "block",
    });
  }

  function onCaptureMouseMove(e) {
    if (!captureMode || !captureMode.dragStart) return;
    const r = captureMode.overlay.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const { dragStart, selection } = captureMode;
    Object.assign(selection.style, {
      left: Math.min(dragStart.x, x) + "px", top: Math.min(dragStart.y, y) + "px",
      width: Math.abs(x - dragStart.x) + "px", height: Math.abs(y - dragStart.y) + "px",
    });
  }

  function onCaptureMouseUp(e) {
    if (!captureMode || !captureMode.dragStart) return;
    const r = captureMode.overlay.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const { dragStart, snapshot } = captureMode;
    const dispX = Math.min(dragStart.x, x), dispY = Math.min(dragStart.y, y);
    const dispW = Math.abs(x - dragStart.x), dispH = Math.abs(y - dragStart.y);

    if (dispW < 8 || dispH < 8) { showToast("Selection too small — try again.", "warn"); cancelCaptureMode(); return; }

    const scaleX = snapshot.width / r.width, scaleY = snapshot.height / r.height;
    const sx = Math.round(dispX * scaleX), sy = Math.round(dispY * scaleY);
    const sw = Math.round(dispW * scaleX), sh = Math.round(dispH * scaleY);

    const crop = document.createElement("canvas");
    crop.width = sw; crop.height = sh;
    crop.getContext("2d").drawImage(snapshot, sx, sy, sw, sh, 0, 0, sw, sh);

    cancelCaptureMode();
    openTriggerEditor(crop.toDataURL("image/png"), {
      videoW: snapshot.width, videoH: snapshot.height, cropW: sw, cropH: sh,
    });
  }

  // --- Toast ----------------------------------------------------------------

  function showToast(text, level) {
    const colors = { ok: "#00f593", info: "#bf94ff", warn: "#f5b000", error: "#ff5c5c" };
    const toast = document.createElement("div");
    Object.assign(toast.style, {
      position: "fixed", bottom: "32px", left: "50%", transform: "translateX(-50%)",
      background: "rgba(24,24,27,0.95)", color: "#efeff1",
      border: `1px solid ${colors[level] || colors.info}`, borderRadius: "6px",
      padding: "10px 16px", fontFamily: "sans-serif", fontSize: "13px",
      zIndex: "2147483647", pointerEvents: "none",
      boxShadow: "0 4px 16px rgba(0,0,0,0.4)", transition: "opacity 300ms",
    });
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, 2500);
  }

  // --- React to active profile changes made in the popup --------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[ACTIVE_PROFILE_KEY]) return;
    const next = changes[ACTIVE_PROFILE_KEY].newValue;
    if (!next) return;
    const cur = activeProfile || DEFAULT_PROFILE;
    if (next.gameId !== cur.gameId || next.profileId !== cur.profileId) {
      console.log(`[overlay/content] profile changed to ${next.gameId}/${next.profileId}, reloading`);
      loadProfile();
    }
  });

  // --- Messages from background ---------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "capture-trigger") { startCaptureMode(); sendResponse({ ok: true }); }
    if (msg && msg.type === "get-game") { sendResponse({ game: detectedGame }); }
    return true;
  });

  // --- Startup --------------------------------------------------------------

  // --- Diagnostic: Shift+click dumps transform data ------------------------

  window.__streamOverlayClicks = [];

  function onDocumentClick(event) {
    if (!event.shiftKey) return;
    console.log("[overlay/click] shift+mousedown fired", {
      button: event.button,
      hasVideo: !!currentVideo,
      videoW: currentVideo && currentVideo.videoWidth,
    });
    if (!currentVideo || !currentVideo.videoWidth) {
      showToast("Shift+click: no video attached yet.", "warn");
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const rect = currentVideo.getBoundingClientRect();
    const style = window.getComputedStyle(currentVideo);
    const coords = clientToVideoCoords(currentVideo, event.clientX, event.clientY);

    // Walk ancestors looking for CSS transforms that could shift the rect vs. actual paint.
    const transformedAncestors = [];
    for (let el = currentVideo.parentElement; el && el !== document.body; el = el.parentElement) {
      const t = window.getComputedStyle(el).transform;
      if (t && t !== "none") {
        const r = el.getBoundingClientRect();
        transformedAncestors.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 60),
          transform: t,
          rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
    }

    const data = {
      click: { x: event.clientX, y: event.clientY },
      rect: {
        l: Math.round(rect.left), t: Math.round(rect.top),
        w: Math.round(rect.width), h: Math.round(rect.height),
        r: Math.round(rect.right), b: Math.round(rect.bottom),
      },
      native: { w: currentVideo.videoWidth, h: currentVideo.videoHeight },
      style: {
        objectFit: style.objectFit,
        objectPosition: style.objectPosition,
        transform: style.transform,
        width: style.width,
        height: style.height,
      },
      computed: coords ? {
        videoX: Math.round(coords.x), videoY: Math.round(coords.y),
        offsetX: coords.offsetX, offsetY: coords.offsetY,
        scaleX: +coords.scaleX.toFixed(4), scaleY: +coords.scaleY.toFixed(4),
      } : null,
      aspect: {
        element: +(rect.width / rect.height).toFixed(4),
        video: +(currentVideo.videoWidth / currentVideo.videoHeight).toFixed(4),
      },
      window: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      transformedAncestors,
    };

    window.__streamOverlayClicks.push(data);
    console.log(`[overlay/click #${window.__streamOverlayClicks.length}]`, data);

    // Drop a numbered marker at the click location so the user can visually confirm
    // what they clicked vs. what the code thinks is under the cursor in video-space.
    const marker = document.createElement("div");
    Object.assign(marker.style, {
      position: "fixed",
      left: (event.clientX - 8) + "px",
      top: (event.clientY - 8) + "px",
      width: "16px", height: "16px",
      borderRadius: "50%",
      background: "rgba(255,56,96,0.85)",
      border: "2px solid #fff",
      color: "#fff",
      fontFamily: "monospace",
      fontSize: "10px",
      fontWeight: "bold",
      textAlign: "center",
      lineHeight: "14px",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    marker.textContent = String(window.__streamOverlayClicks.length);
    document.body.appendChild(marker);
    setTimeout(() => marker.remove(), 5000);

    showToast(`Click #${window.__streamOverlayClicks.length} logged. window.__streamOverlayClicks to dump.`, "info");
  }

  loadProfile().then(() => loadUserTriggers());
  ensureDebugPanel();
  document.addEventListener("mousemove", onDocumentMouseMove, { passive: true });
  document.addEventListener("mousedown", onDocumentClick, true);

  // Receive relayed mouse coordinates from Twitch Extension child frames
  // (ext.twitch.tv iframes injected by all_frames:true). The child sends
  // normalised coordinates (nx/ny, each a 0–1 fraction of the child window's
  // inner size) so that CSS-scaled iframes (e.g. Slay the Relics at 1920×1080
  // internal res displayed at ~400 px) produce correct parent-frame positions.
  window.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "streamGenie_mousemove") return;
    // Accept both old raw format and new normalised format for safety.
    const { nx, ny, clientX: rawX, clientY: rawY } = event.data;
    const iframes = Array.from(document.querySelectorAll("iframe"));
    const sourceFrame = iframes.find(f => f.contentWindow === event.source);
    if (!sourceFrame) return;
    const rect = sourceFrame.getBoundingClientRect();
    const absX = nx !== undefined ? rect.left + nx * rect.width  : rect.left + rawX;
    const absY = ny !== undefined ? rect.top  + ny * rect.height : rect.top  + rawY;
    onDocumentMouseMove({ clientX: absX, clientY: absY });
  });

  heartbeat();
})();
