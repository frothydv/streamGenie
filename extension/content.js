// Content script. Runs in the context of twitch.tv pages.

(function () {
  if (window.__streamOverlayLoaded) {
    console.log("[overlay/content] already loaded, skipping");
    return;
  }
  window.__streamOverlayLoaded = true;

  console.log("[overlay/content] loaded on", location.href);

  // --- Config ---------------------------------------------------------------

  const MatcherCore = globalThis.StreamGenieMatcher;
  if (!MatcherCore) {
    console.error("[overlay/content] matcher core failed to load");
    return;
  }

  const CAPTURE_SIZE = 160;
  const CAPTURE_INTERVAL_MS = 100;     // throttle mouse-driven captures (10Hz)
  const HEARTBEAT_MS = 500;
  const MIN_VIDEO_SIZE = 100;
  const MATCH_THRESHOLD_RATIO = MatcherCore.DEFAULTS.matchThresholdRatio;
  const MASKED_MATCH_THRESHOLD_RATIO = MatcherCore.DEFAULTS.maskedMatchThresholdRatio;
  const MASK_VERIFY_GRID = MatcherCore.DEFAULTS.maskVerifyGrid;
  const MASK_VERIFY_THRESHOLD = MatcherCore.DEFAULTS.maskVerifyThreshold;
  const SLIDE_STEP = MatcherCore.DEFAULTS.slideStep;
  const MIN_REF_PX = 8;               // only skip truly microscopic refs
  const MIN_MASKED_BITS = MatcherCore.DEFAULTS.minMaskedBits;
  // Both reference and each capture window are normalised through this virtual
  // size before hashing, so small refs produce equally discriminative hashes.
  const CANONICAL_SIZE = MatcherCore.DEFAULTS.canonicalSize;
  const FIRST_RUN_KEY = "streamGenie_first_run_shown";
  const matcher = MatcherCore.createMatcher({ captureSize: CAPTURE_SIZE });

  // --- Profile config -------------------------------------------------------

  const PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;  // 2 minutes (frequent refresh for pre-alpha)
  const ACTIVE_PROFILE_KEY = "streamGenie_active_profile";
  const DEFAULT_PROFILE = {
    gameId:    "slay-the-spire-2",
    profileId: "community",
    name:      "STS2 Community",
    url:       "https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/games/slay-the-spire-2/profiles/community/profile.json",
  };

  const profileCacheKey        = (gId, pId) => `streamGenie_profile_${gId}_${pId}`;
  const userTriggersKey        = (gId, pId) => `streamGenie_triggers_${gId}_${pId}`;
  const modifiedTriggersKey     = (gId, pId) => `streamGenie_modified_${gId}_${pId}`;
  const contributorCodeKey     = (gId, pId) => `streamGenie_code_${gId}_${pId}`;

  /**
   * Ensures a URL for our profile repo uses raw.githubusercontent.com instead of jsdelivr.
   * This bypasses CDN branch lag during active development.
   */
  function ensureRawUrl(urlStr) {
    if (!urlStr) return urlStr;
    if (urlStr.includes("cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@main")) {
      return urlStr.replace("cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@main", "raw.githubusercontent.com/frothydv/streamGenieProfiles/main");
    }
    return urlStr;
  }

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

  // --- Extension Interference State ---
  let extensionToggleUI = null;
  let disabledElements = [];
  let extensionsDisabled = false;
  let extensionInterferenceState = "unknown"; // "unknown", "accepted", "rejected", "auto"
  let lastExtCount = 0;
  const EXT_SETTING_PREFIX = "streamGenie_ext_pref_";

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

  // --- Twitch Extension Interference ----------------------------------------

  function detectTwitchExtensions() {
    const iframes = Array.from(document.querySelectorAll("iframe"));
    const exts = iframes.filter(f => f.src && (f.src.includes("ext-twitch.tv") || f.src.includes("extension")));
    const containers = new Set();
    exts.forEach(f => {
      containers.add(f);
      let p = f.parentElement;
      if (p && (p.className.includes("extension") || p.classList.contains("video-player__overlay"))) {
        containers.add(p);
      }
    });
    return Array.from(containers);
  }

  function disableTwitchExtensions(exts) {
    if (!exts) exts = detectTwitchExtensions();
    for (const el of exts) {
      if (!el.dataset) continue;
      if (el.dataset.sgOrigPointerEvents === undefined) {
        el.dataset.sgOrigPointerEvents = el.style.pointerEvents || '';
      }
      el.style.pointerEvents = 'none';
      if (!disabledElements.includes(el)) disabledElements.push(el);
    }
    extensionsDisabled = true;
  }

  function enableTwitchExtensions() {
    if (!disabledElements) return; // safety
    for (const el of disabledElements) {
      if (!el.dataset) continue;
      el.style.pointerEvents = el.dataset.sgOrigPointerEvents || '';
      delete el.dataset.sgOrigPointerEvents;
    }
    disabledElements = [];
    extensionsDisabled = false;
  }

  async function maybeShowExtensionWarning() {
    if (extensionInterferenceState !== "unknown") {
       if (extensionInterferenceState === "accepted" || extensionInterferenceState === "auto") {
          disableTwitchExtensions(); // reapplies to dynamically loaded DOM nodes
       }
       return;
    }
    const exts = detectTwitchExtensions();
    if (exts.length === 0) return;
    if (exts.length === lastExtCount) return;
    lastExtCount = exts.length;

    const currentChannel = location.pathname.split("/").filter(p => p)[0] || "unknown";
    
    const storageKeys = ["streamGenie_global_disable_ext", EXT_SETTING_PREFIX + currentChannel];
    const storage = await chrome.storage.local.get(storageKeys);
    
    if (storage.streamGenie_global_disable_ext) {
       extensionInterferenceState = "auto";
       disableTwitchExtensions(exts);
       return;
    }

    const channelSetting = storage[EXT_SETTING_PREFIX + currentChannel];
    if (channelSetting !== undefined) {
       if (channelSetting === true) {
           extensionInterferenceState = "accepted";
           disableTwitchExtensions(exts);
           return;
       } else if (channelSetting === false) {
           extensionInterferenceState = "rejected";
           return;
       }
    }

    showExtensionWarningUI(currentChannel, exts.length);
  }

  function showExtensionWarningUI(channelName, count) {
    if (extensionToggleUI) return;
    
    extensionToggleUI = document.createElement("div");
    Object.assign(extensionToggleUI.style, {
      position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)",
      padding: "12px 16px", background: "rgba(24,24,27,0.95)", border: "1px solid #f5a623",
      borderRadius: "8px", color: "#efeff1", fontFamily: "sans-serif", fontSize: "13px",
      zIndex: "2147483647", display: "flex", flexDirection: "column", gap: "8px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.5)", width: "max-content", maxWidth: "450px"
    });

    extensionToggleUI.innerHTML = `
      <div><strong style="color:#f5a623;">⚡ Potential Interference Detected (${count})</strong></div>
      <div style="font-size:11px; color:#adadb8; line-height:1.4;">
        Active Twitch Extensions may block StreamGenie's ability to "see" your mouse.
        <span style="display:block; margin-top:4px;"><strong>Tip:</strong> Open the StreamGenie debug panel to check coordinate alignment.</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px; margin-top:4px;">
        <button id="sg-ext-btn-disable" style="background:#00f593; color:#000; border:none; padding:6px 10px; border-radius:4px; font-weight:bold; cursor:pointer;">Disable Overlays</button>
        <button id="sg-ext-btn-ignore"  style="background:#333; color:#efeff1; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-weight:bold;">Ignore</button>
        <label style="font-size:11px; color:#adadb8; margin-left:auto; display:flex; align-items:center; cursor:pointer;">
          <input type="checkbox" id="sg-ext-chk-remember" style="margin-right:4px;" /> Remember for ${channelName}
        </label>
      </div>
    `;
    document.body.appendChild(extensionToggleUI);

    document.getElementById("sg-ext-btn-disable").onclick = async () => {
      const remember = document.getElementById("sg-ext-chk-remember").checked;
      if (remember) await chrome.storage.local.set({ [EXT_SETTING_PREFIX + channelName]: true });
      extensionInterferenceState = "accepted";
      disableTwitchExtensions();
      extensionToggleUI.remove();
      extensionToggleUI = null;
      showToast("Twitch extensions disabled for StreamGenie.", "ok");
    };

    document.getElementById("sg-ext-btn-ignore").onclick = async () => {
      const remember = document.getElementById("sg-ext-chk-remember").checked;
      if (remember) await chrome.storage.local.set({ [EXT_SETTING_PREFIX + channelName]: false });
      extensionInterferenceState = "rejected";
      extensionToggleUI.remove();
      extensionToggleUI = null;
    };
  }

  let lastKnownVideoDims = "";
  function heartbeat() {
    // SPA navigation — Twitch navigates client-side; reset detection on URL change.
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detectedGame = null;
      enableTwitchExtensions();
      extensionInterferenceState = "unknown";
      lastExtCount = 0;
      if (extensionToggleUI) { extensionToggleUI.remove(); extensionToggleUI = null; }
    }
    detectTwitchGame();
    maybeShowExtensionWarning();

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

  const _allBitMask = matcher.allBitMask;
  const captureGrayBuffer = matcher.createGrayBuffer();

  function dHashFromPixels(pixels, srcW, sx, sy, sw, sh) {
    return matcher.dHashFromPixels(pixels, srcW, sx, sy, sw, sh);
  }

  function maskBitsFromPixels(maskPixels, srcW, sx, sy, sw, sh) {
    return matcher.maskBitsFromPixels(maskPixels, srcW, sx, sy, sw, sh);
  }

  function buildVerifyRefFromPixels(refPixels, maskPixels) {
    return matcher.buildVerifyRefFromPixels(refPixels, maskPixels);
  }

  function matchThresholdForRef(ref) {
    return matcher.matchThresholdForRef(ref);
  }

  function verifyThresholdForRef(ref) {
    return matcher.verifyThresholdForRef(ref);
  }

  function findBestMatch(capturePixels, captureGray) {
    return matcher.findBestMatch(TRIGGERS, capturePixels, captureGray);
  }

  // --- Profile loading ------------------------------------------------------

  function profileBaseUrl(profileUrl) {
    return profileUrl.substring(0, profileUrl.lastIndexOf("/") + 1);
  }

  function loadReferencesForTriggers(baseUrl) {
    for (const trigger of TRIGGERS) {
      if (!trigger.references) continue;
      for (const ref of trigger.references) {
        // Skip if no file and no dataUrl
        if (!ref.file && !ref.dataUrl) {
          console.warn(`[DEBUG] Skipping reference with no file and no dataUrl`);
          continue;
        }

        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          ref.sourceImg = img;
          ref.origW = img.naturalWidth;
          ref.origH = img.naturalHeight;
          const finish = () => {
            rehashRef(ref);
            console.log(`[overlay/content] reference loaded: ${ref.file || 'data-url'} (${ref.origW}x${ref.origH})`);
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
        img.onerror = () => {
  console.warn(`[overlay/content] failed to load reference: ${ref.file || 'undefined'}`);
  console.warn(`[DEBUG] ref object:`, {
    file: ref.file,
    dataUrl: ref.dataUrl ? 'exists' : 'missing',
    maskDataUrl: ref.maskDataUrl ? 'exists' : 'missing',
    w: ref.w,
    h: ref.h
  });
};

        // Use dataUrl if available, otherwise fetch from CDN
        if (ref.dataUrl) {
          img.src = ref.dataUrl;
        } else if (ref.file) {
          img.src = baseUrl + "references/" + ref.file;
        } else {
          console.warn(`[DEBUG] Reference has no dataUrl or file:`, ref);
        }
      }
    }
  }

  async function applyProfile(profile, sourceUrl) {
    const profileTriggers = profile.triggers.map(t => ({ ...t, source: "profile" }));
    const userTriggers = TRIGGERS.filter(t => t.id && t.id.startsWith("user-"));

    // Load modified profile triggers from storage (survives page reloads)
    const modifiedTriggers = await loadModifiedProfileTriggers();

    // Deduplicate: fresh profile triggers are overridden by locally modified versions
    const mergedMap = new Map();
    
    // 1. Profile triggers from CDN (base)
    profileTriggers.forEach(t => mergedMap.set(t.id, t));
    
    // 2. Locally modified profile triggers (override CDN)
    modifiedTriggers.forEach(t => {
      t.source = "profile"; 
      mergedMap.set(t.id, t);
    });
    
    // 3. Locally created user triggers
    userTriggers.forEach(t => mergedMap.set(t.id, t));

    TRIGGERS = Array.from(mergedMap.values());

    console.log("[DEBUG] Trigger merge:");
    console.log(`  - Profile triggers: ${profileTriggers.length}`);
    console.log(`  - Modified triggers: ${modifiedTriggers.length}`);
    console.log(`  - User triggers: ${userTriggers.length}`);
    console.log(`  - Total unique: ${TRIGGERS.length}`);

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
        await applyProfile(cached.profile, activeProfile.url);
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
      // Cache-bust the CDN request to ensure fresh content
      const url = new URL(ensureRawUrl(ap.url));
      url.searchParams.set("_cb", Date.now());
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const profile = await res.json();
      localStorage.setItem(cKey, JSON.stringify({ ts: Date.now(), profile }));
      console.log("[overlay/content] profile: fetched from CDN (cache-busted)");
      await applyProfile(profile, ap.url);
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
    // imageSmoothingEnabled MUST be false: dHashDistFromGray samples the scene at
    // floor-mapped pixel positions, so the ref hash must use the same floor-sampling.
    // Bilinear blending at non-integer positions flips gradient bits, causing ~16 extra
    // mismatches even for a perfect scene match.
    const tmp = document.createElement("canvas");
    tmp.width = CANONICAL_SIZE; tmp.height = CANONICAL_SIZE;
    const ctx = tmp.getContext("2d");
    ctx.imageSmoothingEnabled = false;
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
        maskCtx.imageSmoothingEnabled = false;
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
      ref.refVerifyValues = verifyRef.values;
      ref.refVerifyMask = verifyRef.mask;
      ref.refVerifyActive = verifyRef.active;
      if (ref.refValidBits < MIN_MASKED_BITS) ref.refHash = null;
    } else {
      ref.refBitMask = new Uint8Array(_allBitMask);
      ref.refValidBits = 64;
      const verifyRef = buildVerifyRefFromPixels(px, null);
      ref.refVerifyValues = verifyRef.values;
      ref.refVerifyMask = verifyRef.mask;
      ref.refVerifyActive = verifyRef.active;
    }

    // Pre-compute rotated hashes if the trigger opts into rotation-aware matching.
    // Rotation schema takes precedence over legacy rotates:true flag.
    // Rotate at native dimensions (w×h) so aspect ratio is preserved — rotating a
    // squished 32×32 canonical of a wide card produces wrong geometry.
    const rotAngles = ref.rotation
      ? matcher.anglesForRotation(ref.rotation)
      : ref.rotates ? matcher.config.rotationAngles : null;
    if (rotAngles && rotAngles.length && ref.refHash) {
      const nativeTmp = document.createElement("canvas");
      nativeTmp.width = w; nativeTmp.height = h;
      const nCtx = nativeTmp.getContext("2d");
      nCtx.imageSmoothingEnabled = false;
      nCtx.drawImage(ref.sourceImg, 0, 0, w, h);
      const nativePx = nCtx.getImageData(0, 0, w, h).data;
      ref.rotatedHashes = matcher.computeRotatedHashes(nativePx, w, h, rotAngles);
    } else {
      ref.rotatedHashes = null;
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
      // Only load actual user-created triggers (IDs starting with "user-")
      const saved = (result[key] || []).filter(t => t.id && t.id.startsWith("user-"));
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
      // Skip if no file and no dataUrl
      if (!ref.file && !ref.dataUrl) continue;

      ref.rotates = !!trigger.rotates;         // legacy flag
      ref.rotation = trigger.rotation || null; // structured rotation schema

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
        rotates: !!trigger.rotates,
        rotation: trigger.rotation || null,
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

  async function saveModifiedProfileTrigger(trigger) {
    try {
      const ap = activeProfile || DEFAULT_PROFILE;
      const key = modifiedTriggersKey(ap.gameId, ap.profileId);
      const storable = {
        id: trigger.id,
        rotates: !!trigger.rotates,
        rotation: trigger.rotation || null,
        payloads: trigger.payloads,
        references: trigger.references.map(({ dataUrl, maskDataUrl, file, w, h, srcW, srcH }) => ({ dataUrl, maskDataUrl, file, w, h, srcW, srcH })),
        _isModified: true,
      };
      const result = await chrome.storage.local.get(key);
      const saved = result[key] || [];
      const idx = saved.findIndex(t => t.id === trigger.id);
      if (idx >= 0) saved[idx] = storable;
      else saved.push(storable);
      await chrome.storage.local.set({ [key]: saved });
      console.log(`[overlay/content] modified profile trigger saved: ${trigger.id} (${saved.length} total)`);
    } catch (e) {
      console.warn("[overlay/content] failed to save modified trigger:", e.message);
    }
  }

  async function loadModifiedProfileTriggers() {
    try {
      const ap = activeProfile || DEFAULT_PROFILE;
      const key = modifiedTriggersKey(ap.gameId, ap.profileId);
      const result = await chrome.storage.local.get(key);
      const saved = result[key] || [];
      const triggers = saved.map(t => ({ ...t, source: "profile" }));
      console.log(`[overlay/content] modified profile triggers loaded: ${triggers.length}`);
      return triggers;
    } catch (e) {
      console.warn("[overlay/content] failed to load modified triggers:", e.message);
      return [];
    }
  }

  async function cleanupUserTriggers() {
    try {
      const ap = activeProfile || DEFAULT_PROFILE;
      const key = userTriggersKey(ap.gameId, ap.profileId);
      const result = await chrome.storage.local.get(key);
      const saved = result[key] || [];
      const filtered = saved.filter(t => t.id && t.id.startsWith("user-"));
      if (filtered.length < saved.length) {
        await chrome.storage.local.set({ [key]: filtered });
        console.log(`[overlay/content] cleaned up ${saved.length - filtered.length} incorrectly saved profile triggers from user storage`);
      }
    } catch (e) {
      console.warn("[overlay/content] cleanup failed:", e.message);
    }
  }

  async function submitToProfile(trigger, mode = "add", profileHint = null) {
    if (!WORKER_URL) throw new Error("Worker URL not configured");
    const ap = profileHint || activeProfile || DEFAULT_PROFILE;

    const codeStore = await chrome.storage.local.get(contributorCodeKey(ap.gameId, ap.profileId));
    const contributorCode = codeStore[contributorCodeKey(ap.gameId, ap.profileId)] || null;
    console.log(`[overlay/submit] mode=${mode} game=${ap.gameId} profile=${ap.profileId} trusted=${!!contributorCode}`);

    const triggerPayload = {
      id:      trigger.id,
      rotates: !!trigger.rotates,
      payloads: trigger.payloads,
    };
    if (mode === "add" || mode === "update") {
      triggerPayload.references = trigger.references.map(
        ({ dataUrl, maskDataUrl, file, w, h, srcW, srcH }) => ({ dataUrl, maskDataUrl, file, w, h, srcW, srcH })
      );
    }

    console.log("[overlay/submit] Submitting trigger payload:", JSON.stringify(triggerPayload, null, 2));

    console.log("[overlay/submit] Sending request to:", WORKER_URL);
    console.log("[overlay/submit] Request body:", JSON.stringify({
      gameId: ap.gameId,
      profileId: ap.profileId,
      trigger: triggerPayload,
      mode: mode
    }, null, 2));

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

  async function reviewWorkerCall(body, contributorCode) {
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "X-Submit-Secret":   SUBMIT_SECRET,
        "X-Contributor-Key": contributorCode,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // opts = { mode: 'edit', trigger: existingTrigger } for suggest-edit flow.
  // opts = { mode: 'review', proposal, gameId, profileId, contributorCode } for proposal review.
  function openTriggerEditor(dataUrl, meta, opts = {}) {
    const isReview = opts.mode === "review";
    const isEdit = opts.mode === "edit";
    // Profile triggers → propose update PR. User triggers → re-submit as add.
    const isProfileEdit = isEdit && !opts.trigger?.id?.startsWith("user-");
    // sourceTrigger: the trigger being edited or reviewed.
    const sourceTrigger = isReview ? opts.proposal?.trigger : opts.trigger;
    // Profile to submit to — may differ from activeProfile when popup has a different game selected.
    const profileHint = opts.profileHint || null;

    console.log("[DEBUG] === Opening Trigger Editor ===");
    console.log("[DEBUG] Trigger ID:", sourceTrigger?.id);
    console.log("[DEBUG] Is profile edit:", isProfileEdit);
    console.log("[DEBUG] Is review:", isReview);
    console.log("[DEBUG] Is modified:", !!sourceTrigger?._isModified);
    console.log("[DEBUG] Trigger mask URL:", sourceTrigger?.references[0]?.maskDataUrl?.substring(0, 50) + "...");
    console.log("[DEBUG] Trigger payload title:", sourceTrigger?.payloads[0]?.title);
    console.log("[DEBUG] Trigger payload offset:", sourceTrigger?.payloads[0]?.popupOffset);

    let destroyMaskEditor = null;
    let stopRotationAnim = () => {};
    editorModalOpen = true;
    function closeEditor(message = "Cancelled.", level = "info") {
      stopRotationAnim();
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
    const modeLabel = isReview ? "Review Proposal" : isProfileEdit ? "Edit Trigger" : isEdit ? "Edit My Trigger" : "New Trigger";
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
    const refTooBig = meta.cropW > CAPTURE_SIZE || meta.cropH > CAPTURE_SIZE;
    const refMetaEl = document.createElement("div");
    refMetaEl.style.cssText = "font-size:10px;margin-top:4px;";
    if (refTooBig) {
      refMetaEl.innerHTML =
        `<span style="color:#f5b000">${meta.cropW}×${meta.cropH} px — too large to match</span>` +
        `<br><span style="color:#adadb8">Max size is ${CAPTURE_SIZE}×${CAPTURE_SIZE} px (the hover capture window). ` +
        `Re-capture a smaller crop of this image.</span>`;
    } else {
      refMetaEl.style.color = "#adadb8";
      refMetaEl.textContent = `${meta.cropW}×${meta.cropH} px · from ${meta.videoW}×${meta.videoH} source`;
    }
    refSec.appendChild(refMetaEl);
    modal.appendChild(refSec);

    const initialMaskDataUrl = sourceTrigger?.references?.[0]?.maskDataUrl || null;
    console.log("[DEBUG] initialMaskDataUrl:", initialMaskDataUrl ? "exists" : "null");
    if (initialMaskDataUrl) {
      console.log("[DEBUG] initialMask length:", initialMaskDataUrl.length);
      console.log("[DEBUG] initialMask preview:", initialMaskDataUrl.substring(0, 50) + "...");
    }
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

    const payloadStates = (isEdit || isReview) && sourceTrigger?.payloads?.length
      ? sourceTrigger.payloads.map(p => ({
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

    // ── Rotation UI ────────────────────────────────────────────────────────────
    // Determine initial rotation from source trigger (structured schema first,
    // then legacy rotates:true, then null for new triggers).
    const initRotation = (isEdit || isReview)
      ? (sourceTrigger?.rotation || (sourceTrigger?.rotates ? { mode: "free" } : null))
      : null;

    function rotEditorInput(type, min, max, value, step) {
      const el = document.createElement("input");
      el.type = type; el.min = min; el.max = max; el.value = value; el.step = step || 1;
      Object.assign(el.style, {
        width: "52px", background: "#18181b", border: "1px solid #555",
        borderRadius: "4px", color: "#efeff1", padding: "3px 5px", fontSize: "12px",
      });
      return el;
    }
    function rotEditorLabel(text) {
      const sp = document.createElement("span");
      sp.style.cssText = "font-size:12px;color:#adadb8;white-space:nowrap;";
      sp.textContent = text;
      return sp;
    }

    const rotSec = document.createElement("div");
    rotSec.style.cssText = "margin-bottom:14px;";
    rotSec.appendChild(editorLabel("Rotation"));

    // Mode radio row
    const modeRow = document.createElement("div");
    modeRow.style.cssText = "display:flex;flex-wrap:wrap;gap:14px;margin:6px 0 10px;";
    const ROTATION_MODES = [
      { value: "none",       label: "None" },
      { value: "orthogonal", label: "Orthogonal (90°/180°/270°)" },
      { value: "free",       label: "Free (±range, fine steps)" },
    ];
    let currentRotMode = initRotation ? (initRotation.mode || "free") : "none";
    const modeRadios = {};
    for (const { value, label } of ROTATION_MODES) {
      const lbl = document.createElement("label");
      lbl.style.cssText = "display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:#efeff1;user-select:none;";
      const radio = document.createElement("input");
      radio.type = "radio"; radio.name = "sg-rotation-mode"; radio.value = value;
      radio.checked = currentRotMode === value; radio.style.cursor = "pointer";
      modeRadios[value] = radio;
      lbl.appendChild(radio); lbl.appendChild(document.createTextNode(label));
      modeRow.appendChild(lbl);
    }
    rotSec.appendChild(modeRow);

    // Free-mode parameter panel
    const freePanel = document.createElement("div");
    freePanel.style.cssText = "display:none;background:#0e0e10;border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:8px;";

    const rangeRow = document.createElement("div");
    rangeRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;";
    const minInput = rotEditorInput("number", -180, 0,   initRotation?.minAngle ?? -30);
    const maxInput = rotEditorInput("number", 0,   180,  initRotation?.maxAngle ??  30);
    const stepInput = rotEditorInput("number", 1,  45,   initRotation?.step     ??   5);
    rangeRow.appendChild(rotEditorLabel("Range:"));
    rangeRow.appendChild(minInput); rangeRow.appendChild(rotEditorLabel("to"));
    rangeRow.appendChild(maxInput); rangeRow.appendChild(rotEditorLabel("°, step"));
    rangeRow.appendChild(stepInput); rangeRow.appendChild(rotEditorLabel("°"));
    freePanel.appendChild(rangeRow);

    const fineRow = document.createElement("label");
    fineRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;cursor:pointer;font-size:12px;color:#efeff1;";
    const fineCheck = document.createElement("input");
    fineCheck.type = "checkbox";
    fineCheck.checked = initRotation?.fineStepNearZero !== false;
    fineRow.appendChild(fineCheck); fineRow.appendChild(rotEditorLabel("Fine steps near 0° (±1°–±4°)"));
    freePanel.appendChild(fineRow);

    const baseRow2 = document.createElement("div");
    baseRow2.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";
    const baseInput = rotEditorInput("number", -180, 180, initRotation?.baseAngle ?? 0);
    baseRow2.appendChild(rotEditorLabel("Base angle:"));
    baseRow2.appendChild(baseInput);
    const baseHintEl = document.createElement("span");
    baseHintEl.style.cssText = "font-size:10px;color:#adadb8;";
    baseHintEl.textContent = "° (tilt of the captured ref — preview only)";
    baseRow2.appendChild(baseHintEl);
    freePanel.appendChild(baseRow2);
    rotSec.appendChild(freePanel);

    // Size warning for large refs at free rotation
    const ROTATE_SAFE = Math.floor(CAPTURE_SIZE / 1.366); // ~117px
    const rotateWarnEl = document.createElement("div");
    rotateWarnEl.style.cssText = "font-size:10px;color:#f5b000;margin:4px 0 0;display:none;";
    rotateWarnEl.textContent =
      `Ref is ${meta.cropW}×${meta.cropH} px — corners will clip at ±30°. ` +
      `Under ${ROTATE_SAFE}px works more reliably when rotating.`;
    rotSec.appendChild(rotateWarnEl);
    modal.appendChild(rotSec);

    // Preview animation: rotate the ref image through the configured angle range.
    let _animTimer = null;
    let _animAngle = 0, _animDir = 1;
    // stopRotationAnim was declared as a let no-op above closeEditor; reassign here.
    stopRotationAnim = function() {
      if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
      refImg.style.transform = "";
      refImg.style.transition = "";
    };
    function startRotationAnim() {
      stopRotationAnim();
      if (currentRotMode === "none") return;
      if (currentRotMode === "orthogonal") {
        const steps = [0, 90, 180, 270]; let si = 0;
        _animTimer = setInterval(() => {
          si = (si + 1) % steps.length;
          refImg.style.transition = "transform 0.2s";
          refImg.style.transform = `rotate(${steps[si]}deg)`;
        }, 800);
        return;
      }
      const base = parseFloat(baseInput.value) || 0;
      const minA = parseFloat(minInput.value) || -30;
      const maxA = parseFloat(maxInput.value) ||  30;
      _animAngle = minA; _animDir = 1;
      _animTimer = setInterval(() => {
        refImg.style.transition = "transform 0.05s linear";
        refImg.style.transform = `rotate(${base + _animAngle}deg)`;
        _animAngle += _animDir * 1;
        if (_animAngle > maxA) { _animAngle = maxA; _animDir = -1; }
        if (_animAngle < minA) { _animAngle = minA; _animDir = 1; }
      }, 50);
    }

    const refMarginal = !refTooBig && (meta.cropW > ROTATE_SAFE || meta.cropH > ROTATE_SAFE);
    function onRotModeChange() {
      currentRotMode = Object.entries(modeRadios).find(([, r]) => r.checked)?.[0] || "none";
      freePanel.style.display = currentRotMode === "free" ? "" : "none";
      rotateWarnEl.style.display = (refMarginal && currentRotMode === "free") ? "" : "none";
      startRotationAnim();
    }
    for (const radio of Object.values(modeRadios)) radio.addEventListener("change", onRotModeChange);
    [minInput, maxInput, baseInput].forEach(el => el.addEventListener("input", () => {
      if (currentRotMode === "free") startRotationAnim();
    }));
    onRotModeChange();

    function getRotationObject() {
      if (currentRotMode === "none") return null;
      if (currentRotMode === "orthogonal") return { mode: "orthogonal" };
      return {
        mode: "free",
        minAngle: parseFloat(minInput.value) || -30,
        maxAngle: parseFloat(maxInput.value) ||  30,
        step:     parseFloat(stepInput.value) ||   5,
        fineStepNearZero: fineCheck.checked,
        baseAngle: parseFloat(baseInput.value) || 0,
      };
    }

    // ── Heat-map match test ─────────────────────────────────────────────────
    // Available only when wider capture was provided (fresh capture flow).
    // When present, the submit button is gated on at least one passing test.
    let heatMapPassed = !meta.wideDataUrl; // no gate if no wide capture

    function hmLoadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = src;
      });
    }
    function hmHashDist(a, b, mask) {
      let d = 0;
      for (let i = 0; i < 64; i++) {
        if (mask && !mask[i]) continue;
        if (a[i] !== b[i]) d++;
      }
      return d;
    }

    if (meta.wideDataUrl) {
      const hmSec = document.createElement("div");
      hmSec.style.cssText = "margin-bottom:16px;";
      hmSec.appendChild(editorLabel("Match Test"));

      const hmHint = document.createElement("div");
      hmHint.style.cssText = "color:#adadb8;font-size:11px;line-height:1.4;margin-bottom:8px;";
      hmHint.textContent = "Run a test match to verify this trigger detects correctly. Green = match, yellow = close miss. Required before submitting.";
      hmSec.appendChild(hmHint);

      // Wide-capture display with overlay canvas
      const hmWrap = document.createElement("div");
      hmWrap.style.cssText = "position:relative;display:inline-block;margin-bottom:8px;max-width:100%;";
      const hmImg = document.createElement("img");
      hmImg.src = meta.wideDataUrl;
      hmImg.style.cssText = "display:block;max-width:300px;border:1px solid #333;border-radius:4px;";
      const hmOverlay = document.createElement("canvas");
      hmOverlay.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;border-radius:4px;";
      hmOverlay.width = 1; hmOverlay.height = 1;
      hmWrap.appendChild(hmImg); hmWrap.appendChild(hmOverlay);
      hmSec.appendChild(hmWrap);

      const hmStatus = document.createElement("div");
      hmStatus.style.cssText = "font-size:11px;margin-bottom:8px;min-height:14px;";
      hmSec.appendChild(hmStatus);

      const hmRunBtn = editorBtn("Run Test Match", false);
      hmRunBtn.style.marginBottom = "0";
      hmSec.appendChild(hmRunBtn);
      modal.appendChild(hmSec);

      async function runHeatMap() {
        hmRunBtn.disabled = true;
        hmRunBtn.textContent = "Running…";
        hmStatus.textContent = ""; hmStatus.style.color = "#adadb8";
        try {
          // Load wide capture
          const wideImgEl = await hmLoadImage(meta.wideDataUrl);
          const wideCanvas2 = document.createElement("canvas");
          wideCanvas2.width = wideImgEl.naturalWidth; wideCanvas2.height = wideImgEl.naturalHeight;
          wideCanvas2.getContext("2d").drawImage(wideImgEl, 0, 0);
          const widePx = wideCanvas2.getContext("2d").getImageData(0, 0, wideCanvas2.width, wideCanvas2.height).data;
          const wideW = wideCanvas2.width, wideH = wideCanvas2.height;

          // Build ref hash at canonical size
          const cropImgEl = await hmLoadImage(dataUrl);
          const cc = document.createElement("canvas");
          cc.width = CANONICAL_SIZE; cc.height = CANONICAL_SIZE;
          const cCtx = cc.getContext("2d");
          cCtx.imageSmoothingEnabled = false;
          cCtx.drawImage(cropImgEl, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
          const cropPx = cCtx.getImageData(0, 0, CANONICAL_SIZE, CANONICAL_SIZE).data;
          const refHash = matcher.dHashFromPixels(cropPx, CANONICAL_SIZE, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);

          // Build mask bits from current mask editor state
          let refMaskResult = null;
          const curMaskUrl = maskEditor.getMaskDataUrl();
          if (curMaskUrl) {
            const mImgEl = await hmLoadImage(curMaskUrl);
            const mc = document.createElement("canvas");
            mc.width = CANONICAL_SIZE; mc.height = CANONICAL_SIZE;
            const mCtx = mc.getContext("2d");
            mCtx.imageSmoothingEnabled = false;
            mCtx.drawImage(mImgEl, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
            const mPx = mCtx.getImageData(0, 0, CANONICAL_SIZE, CANONICAL_SIZE).data;
            const mr = matcher.maskBitsFromPixels(mPx, CANONICAL_SIZE, 0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
            if (mr.validBits >= 16) refMaskResult = mr;
          }
          const refMaskBits = refMaskResult?.bits || matcher.allBitMask;
          const refValidBits = refMaskResult?.validBits || 64;

          // Compute rotated hashes from the crop at native size
          const rotation = getRotationObject();
          const hmAngles = rotation ? matcher.anglesForRotation(rotation) : null;
          let rotHashes = null;
          if (hmAngles && hmAngles.length) {
            const cW = meta.cropW || CANONICAL_SIZE, cH = meta.cropH || CANONICAL_SIZE;
            const nc = document.createElement("canvas");
            nc.width = cW; nc.height = cH;
            const nCtx = nc.getContext("2d");
            nCtx.imageSmoothingEnabled = false;
            nCtx.drawImage(cropImgEl, 0, 0, cW, cH);
            const nPx = nCtx.getImageData(0, 0, cW, cH).data;
            rotHashes = matcher.computeRotatedHashes(nPx, cW, cH, hmAngles);
          }

          // Sliding window scan across wide capture
          const WIN = CAPTURE_SIZE; // 160
          const STRIDE = 16;
          const threshold   = Math.ceil(matcher.config.rotationMatchThresholdRatio * refValidBits);
          const closeThresh = Math.ceil(matcher.config.matchThresholdRatio * refValidBits);

          const results = [];
          for (let ty = 0; ty + WIN <= wideH; ty += STRIDE) {
            for (let tx = 0; tx + WIN <= wideW; tx += STRIDE) {
              const winHash = matcher.dHashFromPixels(widePx, wideW, tx, ty, WIN, WIN);
              // Compare base hash; track best ratio across all angles.
              let bestRatio = hmHashDist(winHash, refHash, refMaskBits) / refValidBits;
              if (rotHashes) {
                for (const rh of rotHashes) {
                  if (rh.validCount < 16) continue;
                  const ratio = hmHashDist(winHash, rh.hash, rh.clipMask) / rh.validCount;
                  if (ratio < bestRatio) bestRatio = ratio;
                }
              }
              // Convert back to dist units relative to refValidBits for threshold comparison.
              results.push({ tx, ty, dist: bestRatio * refValidBits });
            }
          }

          // Render overlay on top of the wide capture image
          const dispW = hmImg.offsetWidth  || hmImg.naturalWidth;
          const dispH = hmImg.offsetHeight || hmImg.naturalHeight;
          hmOverlay.width = dispW; hmOverlay.height = dispH;
          const scX = dispW / wideW, scY = dispH / wideH;
          const oCtx = hmOverlay.getContext("2d");
          oCtx.clearRect(0, 0, dispW, dispH);

          let matchCount = 0;
          for (const { tx, ty, dist } of results) {
            if (dist <= threshold) {
              oCtx.fillStyle = "rgba(0,245,147,0.30)"; matchCount++;
            } else if (dist <= closeThresh) {
              oCtx.fillStyle = "rgba(245,176,0,0.20)";
            } else { continue; }
            oCtx.fillRect(tx * scX, ty * scY, WIN * scX, WIN * scY);
          }
          // Purple outline at the original crop position
          oCtx.strokeStyle = "#bf94ff"; oCtx.lineWidth = 2;
          oCtx.strokeRect(
            (meta.wideCropX || 0) * scX, (meta.wideCropY || 0) * scY,
            (meta.cropW || WIN) * scX, (meta.cropH || WIN) * scY
          );

          if (matchCount > 0) {
            hmStatus.style.color = "#00f593";
            hmStatus.textContent = `Match found (${matchCount} window${matchCount > 1 ? "s" : ""}) — looks good!`;
            heatMapPassed = true;
          } else {
            hmStatus.style.color = "#ff5c5c";
            hmStatus.textContent = "No match — adjust the mask, rotation settings, or re-capture.";
            heatMapPassed = false;
          }
        } catch (err) {
          hmStatus.style.color = "#ff5c5c";
          hmStatus.textContent = `Error: ${err.message}`;
        }
        hmRunBtn.disabled = false;
        hmRunBtn.textContent = "Run Test Match";
      }
      hmRunBtn.onclick = runHeatMap;
    }

    function validate() {
      if (refTooBig) {
        showToast(`Reference is ${meta.cropW}×${meta.cropH} — larger than the ${CAPTURE_SIZE}px capture window. Re-capture a smaller crop.`, "warn");
        return false;
      }
      if (payloadStates.every(p => !p.title.trim() && !p.text.trim())) {
        showToast("Add a title or text to at least one payload.", "warn");
        return false;
      }
      if (maskEditor.getMaskSummary().coverage === 0) {
        showToast("Your mask is fully erased — paint at least some pixels to match.", "warn");
        return false;
      }
      if (!heatMapPassed) {
        showToast("Run the Match Test first and confirm a green match before submitting.", "warn");
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
      const rotationObj = getRotationObject();
      if (isProfileEdit || isReview) {
        return {
          id: sourceTrigger.id,
          rotates: !!rotationObj,
          rotation: rotationObj,
          payloads,
          references: (sourceTrigger.references || []).map((ref, idx) => ({
            file: ref.file ?? null,
            w: ref.w ?? null,
            h: ref.h ?? null,
            srcW: ref.srcW ?? null,
            srcH: ref.srcH ?? null,
            maskDataUrl: idx === 0 ? maskDataUrl : (ref.maskDataUrl || null),
          })),
        };
      }
      const trigger = {
        id: isEdit ? opts.trigger.id : "user-" + Date.now(),
        rotates: !!rotationObj,
        rotation: rotationObj,
        payloads,
        references: isEdit ?
          (opts.trigger.references || []).map(
            ({ dataUrl: du, maskDataUrl: existingMask, file, w, h, srcW, srcH }, idx) => ({
              dataUrl: du,
              maskDataUrl: idx === 0 ? maskDataUrl : (existingMask || null),
              file,
              w,
              h,
              srcW,
              srcH,
            })
          ) :
          [{ dataUrl, maskDataUrl, w: meta.cropW, h: meta.cropH, srcW: meta.videoW, srcH: meta.videoH }]
      };

      console.log("[DEBUG] Built trigger with mask:", trigger.id);
      console.log("[DEBUG] New mask URL:", trigger.references[0]?.maskDataUrl?.substring(0, 50) + "...");
      console.log("[DEBUG] New payload title:", trigger.payloads[0]?.title);
      console.log("[DEBUG] New payload offset:", trigger.payloads[0]?.popupOffset);

      // Mark as modified if it's a profile trigger being edited
      if (isEdit && !opts.trigger.id.startsWith("user-")) {
        trigger._isModified = true;
        console.log("[DEBUG] Marked as modified:", trigger._isModified);
      }

      return trigger;
    }

    async function saveLocally(trigger) {
      // Replace in-memory entry if editing an existing trigger, otherwise append.
      const existingIdx = TRIGGERS.findIndex(t => t.id === trigger.id);
      if (existingIdx >= 0) {
        TRIGGERS[existingIdx] = trigger;
        // Mark as modified if it's not a user trigger
        if (!trigger.id.startsWith("user-")) {
          TRIGGERS[existingIdx]._isModified = true;
        }
      } else {
        TRIGGERS.push(trigger);
      }
      loadRefImages(trigger);
      // Only save user-created triggers to user storage.
      // Profile triggers are managed remotely and preserved via _isModified flag + modifiedTriggers storage.
      if (trigger.id.startsWith("user-")) {
        await saveUserTrigger(trigger, isEdit);
      } else {
        // Save modified profile trigger to separate storage so it survives page reloads.
        await saveModifiedProfileTrigger(trigger);
      }
    }

    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;gap:10px;align-items:center;";

    const cancelBtn = editorBtn("Cancel", false);
    cancelBtn.onclick = () => closeEditor();

    if (isReview) {
      const proposal = opts.proposal;
      const acceptBtn = editorBtn("Accept", true);
      acceptBtn.style.flex = "1";
      const rejectBtn = editorBtn("Reject", false);
      Object.assign(rejectBtn.style, { flex: "1", borderColor: "#ff5c5c", color: "#ff5c5c" });

      acceptBtn.onclick = async () => {
        if (!validate()) return;
        const trigger = buildTrigger();
        acceptBtn.disabled = rejectBtn.disabled = cancelBtn.disabled = true;
        acceptBtn.textContent = "Accepting…";
        try {
          await reviewWorkerCall(
            { gameId: opts.gameId, profileId: opts.profileId, mode: "accept-proposal",
              prNumber: proposal.prNumber, branch: proposal.branch, trigger },
            opts.contributorCode
          );
          closeEditor("Proposal accepted!", "ok");
        } catch (err) {
          acceptBtn.textContent = "Accept";
          acceptBtn.disabled = rejectBtn.disabled = cancelBtn.disabled = false;
          showSubmitError(footer, err.message);
        }
      };

      rejectBtn.onclick = async () => {
        rejectBtn.disabled = acceptBtn.disabled = cancelBtn.disabled = true;
        rejectBtn.textContent = "Rejecting…";
        try {
          await reviewWorkerCall(
            { gameId: opts.gameId, profileId: opts.profileId, mode: "reject-proposal",
              prNumber: proposal.prNumber },
            opts.contributorCode
          );
          closeEditor("Proposal rejected.", "info");
        } catch (err) {
          rejectBtn.textContent = "Reject";
          rejectBtn.disabled = acceptBtn.disabled = cancelBtn.disabled = false;
          showSubmitError(footer, err.message);
        }
      };

      footer.appendChild(cancelBtn);
      footer.appendChild(acceptBtn);
      footer.appendChild(rejectBtn);
      modal.appendChild(footer);
      return;
    }

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
          console.log("[content] About to submit update for trigger:", trigger.id);
          console.log("[content] Full trigger object before submit:", JSON.stringify(trigger, null, 2));
          const result = await submitToProfile(trigger, "update", profileHint);
          closeEditor(result.direct ? "Update submitted directly!" : "Update proposed! PR opened.", "ok");
          if (result.prUrl) console.log("[overlay/content] update PR:", result.prUrl);

          // Save modified trigger locally so it survives CDN staleness
          await saveModifiedProfileTrigger(trigger);

          // Refresh profile cache after successful update
          console.log("[content] Refreshing profile cache after update...");
          const cKey = profileCacheKey(activeProfile.gameId, activeProfile.profileId);
          localStorage.removeItem(cKey); // Clear the cache
          await fetchAndCacheProfile(); // Fetch fresh profile
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
        const result = await submitToProfile(trigger, "add", profileHint);
        closeEditor(result.direct ? "Submitted directly!" : "Submitted! PR opened.", "ok");
        if (result.prUrl) console.log("[overlay/content] add PR:", result.prUrl);

        // Refresh profile cache after successful add
        console.log("[content] Refreshing profile cache after add...");
        const cKey = profileCacheKey(activeProfile.gameId, activeProfile.profileId);
        localStorage.removeItem(cKey); // Clear the cache
        await fetchAndCacheProfile(); // Fetch fresh profile
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
    console.log("[DEBUG] === openEditTriggerEditor ===");
    console.log("[DEBUG] Incoming trigger:", JSON.stringify({
      id: trigger.id,
      title: trigger.payloads[0]?.title,
      _isModified: trigger._isModified,
      maskUrl: trigger.references[0]?.maskDataUrl?.substring(0, 50) + "..."
    }, null, 2));

    // Find the trigger in TRIGGERS — prefer the modified version if it exists
    const allMatches = TRIGGERS.filter(t => t.id === trigger.id);
    const foundTrigger = allMatches.find(t => t._isModified) || allMatches[0] || null;
    console.log("[DEBUG] Found in TRIGGERS:", foundTrigger ? "yes" : "no");
    if (foundTrigger) {
      console.log("[DEBUG] TRIGGERS version _isModified:", !!foundTrigger._isModified);
      console.log("[DEBUG] TRIGGERS version title:", foundTrigger.payloads[0]?.title);
    }

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
    openTriggerEditor(dataUrl, meta, { mode: "edit", trigger: foundTrigger || trigger });
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
    matcher.fillGrayBuffer(capturePixels, captureGrayBuffer);
    const matchResult = findBestMatch(capturePixels, captureGrayBuffer);
    const best = matchResult.best;
    const threshold = best ? best.threshold : MATCH_THRESHOLD_RATIO;
    const verifyThreshold = best ? best.verifyThreshold : null;
    const verifyOk = !best || best.matched;
    if (best && verifyOk) {
      const label = best.trigger.payloads ? best.trigger.payloads[0].title : best.trigger.id;
      lastMatchInfo = {
        title: label,
        dist: best.dist,
        ratio: best.ratio,
        validBits: best.validBits,
        threshold,
        verifyScore: best.verifyScore,
        verifyThreshold,
        angle: best.angle ?? 0,
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
        angle: best.angle ?? 0,
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

    const saveBtn = document.createElement("button");
    saveBtn.id = "stream-overlay-debug-save";
    saveBtn.textContent = "save capture";
    saveBtn.title = "Download the current 160×160 capture as PNG for offline testing";
    saveBtn.style.cssText = [
      "margin-top:8px;width:100%;",
      "background:#1f1f23;color:#bf94ff;",
      "border:1px solid #9146ff;border-radius:3px;",
      "padding:3px 6px;font-family:monospace;font-size:11px;",
      "cursor:pointer;pointer-events:auto;",
    ].join("");
    saveBtn.addEventListener("click", saveDebugCapture);
    debugPanel.appendChild(saveBtn);

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
        ? ` v=${Math.round(lastMatchInfo.verifyScore * 100)}%<=${Math.round(lastMatchInfo.verifyThreshold * 100)}%`
        : "";
      const angleText = lastMatchInfo.angle ? ` @${lastMatchInfo.angle}°` : "";
      matchLine = lastMatchInfo.noMatch
        ? `<span style="color:#adadb8">best: ${lastMatchInfo.dist}/${lastMatchInfo.validBits} (${Math.round(lastMatchInfo.ratio * 100)}%)<=${Math.round(lastMatchInfo.threshold * 100)}%${angleText}${verifyText} "${lastMatchInfo.title}"</span>`
        : `<span style="color:#00f593">MATCH "${lastMatchInfo.title}" ${lastMatchInfo.dist}/${lastMatchInfo.validBits} (${Math.round(lastMatchInfo.ratio * 100)}%)<=${Math.round(lastMatchInfo.threshold * 100)}%${angleText}${verifyText}</span>`;
    }
    const candidateLines = (lastMatchInfo?.candidates || [])
      .map((c, idx) => {
        const verifyText = c.verifyThreshold != null && c.verifyScore != null
          ? ` v${Math.round(c.verifyScore * 100)}<=${Math.round(c.verifyThreshold * 100)}`
          : "";
        const angleText = c.angle ? `@${c.angle}°` : "";
        return `#${idx + 1} ${Math.round(c.ratio * 100)}%(${c.dist}/${c.validBits})<=${Math.round(c.threshold * 100)}%${angleText}${verifyText} ${c.title}`;
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

  // --- Debug capture save ---------------------------------------------------

  function saveDebugCapture() {
    if (!captureCanvas) {
      showToast("No capture yet — hover over the video first.", "warn");
      return;
    }
    const trigger = lastMatchInfo?.title
      ? lastMatchInfo.title.replace(/[^a-z0-9-]/gi, "_").slice(0, 40)
      : "none";
    const link = document.createElement("a");
    link.href = captureCanvas.toDataURL("image/png");
    link.download = `streamgenie-cap-${trigger}-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // --- Capture mode ---------------------------------------------------------

  let captureMode = null;

  function startCaptureMode(profileHint = null) {
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

    const sizeLabel = document.createElement("div");
    sizeLabel.style.cssText =
      "position:absolute;bottom:-22px;left:0;font-family:sans-serif;font-size:11px;" +
      "font-weight:600;padding:1px 5px;border-radius:3px;white-space:nowrap;pointer-events:none;";
    selection.appendChild(sizeLabel);
    overlay.appendChild(selection);

    document.body.appendChild(overlay);
    captureMode = { overlay, snapshot, videoRect: rect, selection, sizeLabel, dragStart: null, profileHint };

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
    const { dragStart, selection, sizeLabel, snapshot } = captureMode;
    const dispW = Math.abs(x - dragStart.x), dispH = Math.abs(y - dragStart.y);
    Object.assign(selection.style, {
      left: Math.min(dragStart.x, x) + "px", top: Math.min(dragStart.y, y) + "px",
      width: dispW + "px", height: dispH + "px",
    });

    const scaleX = snapshot.width / r.width, scaleY = snapshot.height / r.height;
    const srcW = Math.round(dispW * scaleX), srcH = Math.round(dispH * scaleY);
    const ROTATE_SAFE = Math.floor(CAPTURE_SIZE / 1.366); // ~117px — fits at ±30° rotation
    const tooBig   = srcW > CAPTURE_SIZE || srcH > CAPTURE_SIZE;
    const marginal = !tooBig && (srcW > ROTATE_SAFE || srcH > ROTATE_SAFE);
    const color = tooBig ? "#ff3860" : marginal ? "#f5b000" : "#00f593";
    selection.style.borderColor = color;
    selection.style.background  = tooBig   ? "rgba(255,56,96,0.15)"  :
                                   marginal ? "rgba(245,176,0,0.13)" :
                                              "rgba(0,245,147,0.18)";
    sizeLabel.style.background = color;
    sizeLabel.style.color = tooBig ? "#fff" : "#18181b";
    sizeLabel.textContent = `${srcW}×${srcH}` +
      (tooBig   ? ` — too large (max ${CAPTURE_SIZE})` :
       marginal ? ` — corners clip when rotating` : "");
  }

  function onCaptureMouseUp(e) {
    if (!captureMode || !captureMode.dragStart) return;
    const r = captureMode.overlay.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const { dragStart, snapshot, profileHint } = captureMode;
    const dispX = Math.min(dragStart.x, x), dispY = Math.min(dragStart.y, y);
    const dispW = Math.abs(x - dragStart.x), dispH = Math.abs(y - dragStart.y);

    if (dispW < 8 || dispH < 8) { showToast("Selection too small — try again.", "warn"); cancelCaptureMode(); return; }

    const scaleX = snapshot.width / r.width, scaleY = snapshot.height / r.height;
    const sx = Math.round(dispX * scaleX), sy = Math.round(dispY * scaleY);
    const sw = Math.round(dispW * scaleX), sh = Math.round(dispH * scaleY);

    const crop = document.createElement("canvas");
    crop.width = sw; crop.height = sh;
    crop.getContext("2d").drawImage(snapshot, sx, sy, sw, sh, 0, 0, sw, sh);

    // Capture a wider 480×480 region centered on the crop for the heat-map preview.
    const WIDE_SIZE = 480;
    const cropCx = sx + sw / 2, cropCy = sy + sh / 2;
    const wsx = Math.max(0, Math.round(cropCx - WIDE_SIZE / 2));
    const wsy = Math.max(0, Math.round(cropCy - WIDE_SIZE / 2));
    const wex = Math.min(snapshot.width,  wsx + WIDE_SIZE);
    const wey = Math.min(snapshot.height, wsy + WIDE_SIZE);
    const wideCanvas = document.createElement("canvas");
    wideCanvas.width = wex - wsx; wideCanvas.height = wey - wsy;
    wideCanvas.getContext("2d").drawImage(snapshot, wsx, wsy, wex - wsx, wey - wsy, 0, 0, wex - wsx, wey - wsy);

    cancelCaptureMode();
    openTriggerEditor(crop.toDataURL("image/png"), {
      videoW: snapshot.width, videoH: snapshot.height, cropW: sw, cropH: sh,
      wideDataUrl: wideCanvas.toDataURL("image/png"),
      wideCropX: sx - wsx,
      wideCropY: sy - wsy,
    }, { profileHint });
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
    console.log("[content] Received message:", msg);

    // Handle ping message
    if (msg && msg.type === "ping") {
      console.log("[content] Ping received, responding");
      sendResponse({ pong: true, loaded: true });
      return true;
    }

    if (msg && msg.type === "capture-trigger") {
      if (currentVideo && !editorModalOpen) {
        const hint = (msg.gameId && msg.profileId)
          ? { gameId: msg.gameId, profileId: msg.profileId, url: msg.profileUrl, name: msg.profileName }
          : null;
        startCaptureMode(hint);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "No video or editor open" });
      }
    }
    if (msg && msg.type === "get-game") { sendResponse({ game: detectedGame }); }
    if (msg && msg.type === "review-proposal") {
      if (!editorModalOpen) {
        const { proposal, gameId, profileId, contributorCode } = msg;
        const trigger = proposal.trigger;
        const ref = trigger.references?.[0];
        if (!ref || !ref.file) {
          sendResponse({ ok: false, error: "No reference image" });
          return true;
        }
        const imageUrl = `https://raw.githubusercontent.com/frothydv/streamGenieProfiles/${proposal.branch}/games/${gameId}/profiles/${profileId}/references/${ref.file}`;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width  = ref.w || 160;
          canvas.height = ref.h || 160;
          canvas.getContext("2d").drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL("image/png");
          openTriggerEditor(dataUrl, {
            videoW: ref.srcW || 1920,
            videoH: ref.srcH || 1080,
            cropW:  ref.w    || 160,
            cropH:  ref.h    || 160,
          }, { mode: "review", proposal, gameId, profileId, contributorCode });
        };
        img.onerror = () => showToast("Could not load proposal reference image.", "warn");
        img.src = imageUrl;
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Editor already open" });
      }
      return true;
    }
    if (msg && msg.type === "edit-trigger") {
      console.log("[content] Edit trigger request received");
      if (!editorModalOpen) {
        const trigger = msg.trigger;
        console.log("[content] Full trigger object:", JSON.stringify(trigger, null, 2));
        console.log("[content] Processing trigger for edit:", trigger.id);
        // Load the reference image
        const ref = trigger.references?.[0];
        if (ref) {
          console.log("[content] Found reference:", JSON.stringify(ref, null, 2));

          // Try different possible URL properties
          let imageUrl = ref.dataUrl || ref.imageDataUrl;

          // If no dataUrl but we have a filename, construct the URL
          if (!imageUrl && ref.file) {
            // Get the profile URL to construct the base path
            const profileUrl = activeProfile?.url || DEFAULT_PROFILE.url;
            const baseUrl = profileBaseUrl(profileUrl);
            imageUrl = baseUrl + "references/" + ref.file;
            console.log("[content] Constructed URL from filename:", imageUrl);
          }

          console.log("[content] Image URL to load:", imageUrl);

          // Create a canvas to draw the reference at the original size
          const canvas = document.createElement("canvas");
          canvas.width = ref.w || ref.origW || 160;
          canvas.height = ref.h || ref.origH || 160;
          const ctx = canvas.getContext("2d");

          // Draw the reference image
          const img = new Image();
          img.crossOrigin = "anonymous"; // Allow loading from CDN
          img.onload = () => {
            console.log("[content] Image loaded successfully");
            ctx.drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL("image/png");
            console.log("[content] Canvas converted to data URL");

            // Open the editor with the trigger data
            openTriggerEditor(dataUrl, {
              videoW: ref.srcW || 1920,
              videoH: ref.srcH || 1080,
              cropW: ref.w || ref.origW || 160,
              cropH: ref.h || ref.origH || 160,
            }, { mode: "edit", trigger });
            sendResponse({ success: true });
          };
          img.onerror = (err) => {
            console.error("[content] Failed to load reference image:", err);
            // Try to construct a URL for web-accessible resources
            if (ref.file && !ref.file.startsWith('http')) {
              const fullUrl = chrome.runtime.getURL('references/' + ref.file);
              console.log("[content] Trying web accessible resource:", fullUrl);
              img.src = fullUrl;
            } else {
              sendResponse({ success: false, error: "Failed to load reference image" });
            }
          };
          img.src = imageUrl;
        } else {
          console.error("[content] No reference image found in trigger.references");
          console.log("[content] Available trigger properties:", Object.keys(trigger));
          sendResponse({ success: false, error: "No reference image found" });
        }
      } else {
        console.error("[content] Cannot edit trigger: Editor already open");
        sendResponse({ success: false, error: "Editor already open" });
      }
    }
    if (msg && msg.type === "reload-profile") {
      console.log("[content] Reload profile request received");
      loadProfile();
      sendResponse({ ok: true });
    }
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

  // Clean up any profile triggers incorrectly saved as user triggers
  cleanupUserTriggers().then(() => {
    loadProfile().then(() => loadUserTriggers());
  });
  ensureDebugPanel();
  document.addEventListener("mousemove", onDocumentMouseMove, { passive: true });
  document.addEventListener("mousedown", onDocumentClick, true);
  heartbeat();
})();
