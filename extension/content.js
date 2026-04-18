// Content script. Runs in the context of twitch.tv pages.

(function () {
  if (window.__streamOverlayLoaded) {
    console.log("[overlay/content] already loaded, skipping");
    return;
  }
  window.__streamOverlayLoaded = true;

  console.log("[overlay/content] loaded on", location.href);

  // --- Config ---------------------------------------------------------------

  const CAPTURE_SIZE = 160;
  const CAPTURE_INTERVAL_MS = 100;     // throttle mouse-driven captures (10Hz)
  const HEARTBEAT_MS = 500;
  const MIN_VIDEO_SIZE = 100;
  const MATCH_THRESHOLD = 10;          // max Hamming distance (out of 64)
  // px between sliding-window positions. We use 1px for small (low-res) refs
  // because dHash sampling becomes coarse and sub-pixel alignment matters more.
  const SLIDE_STEP_SMALL = 1;
  const SLIDE_STEP_LARGE = 2;
  const SMALL_REF_THRESHOLD = 40;      // refs shorter than this get the fine step

  // --- Profile config -------------------------------------------------------

  const PROFILE_URL = "https://cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@v1/games/slay-the-spire-2/profiles/community/profile.json";
  const PROFILE_CACHE_KEY = "streamGenie_profile_v1";
  const PROFILE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  let lastMatchInfo = null; // { title, dist, noMatch? } for debug panel

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

  // Compute 64-bit dHash for a region of a flat RGBA pixel array.
  // Nearest-neighbor resize to 9×8, then compare adjacent horizontal pixels.
  function dHashFromPixels(pixels, srcW, sx, sy, sw, sh) {
    for (let dy = 0; dy < 8; dy++) {
      for (let dx = 0; dx < 9; dx++) {
        const px = sx + Math.floor((dx * sw) / 9);
        const py = sy + Math.floor((dy * sh) / 8);
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
  function dHashDistFromPixels(pixels, srcW, sx, sy, sw, sh, refHash) {
    for (let dy = 0; dy < 8; dy++) {
      for (let dx = 0; dx < 9; dx++) {
        const px = sx + Math.floor((dx * sw) / 9);
        const py = sy + Math.floor((dy * sh) / 8);
        const i = (py * srcW + px) * 4;
        _gray[dy * 9 + dx] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      }
    }
    let dist = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const bit = _gray[y * 9 + x + 1] > _gray[y * 9 + x] ? 1 : 0;
        if (bit !== refHash[y * 8 + x]) dist++;
      }
    }
    return dist;
  }

  function hammingDistance(a, b) {
    let d = 0;
    for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
    return d;
  }

  // Slide reference across the capture pixels, return best position + distance.
  function slidingWindowMatch(trigger, capturePixels) {
    const { refHash, w, h } = trigger;
    if (!refHash || w > CAPTURE_SIZE || h > CAPTURE_SIZE) return { dist: 64, x: 0, y: 0 };
    const step = (Math.min(w, h) < SMALL_REF_THRESHOLD) ? SLIDE_STEP_SMALL : SLIDE_STEP_LARGE;
    let bestDist = 64, bestX = 0, bestY = 0;
    for (let y = 0; y <= CAPTURE_SIZE - h; y += step) {
      for (let x = 0; x <= CAPTURE_SIZE - w; x += step) {
        const dist = dHashDistFromPixels(capturePixels, CAPTURE_SIZE, x, y, w, h, refHash);
        if (dist < bestDist) { bestDist = dist; bestX = x; bestY = y; }
      }
    }
    return { dist: bestDist, x: bestX, y: bestY };
  }

  // Run all triggers in a single pass. Returns the overall best result
  // (caller decides whether dist is below threshold).
  function findBestMatch(capturePixels) {
    let best = null;
    for (const trigger of TRIGGERS) {
      if (!trigger.refHash) continue;
      const result = slidingWindowMatch(trigger, capturePixels);
      if (!best || result.dist < best.dist) best = { trigger, ...result };
    }
    return best; // may be null if no refs loaded
  }

  // --- Profile loading ------------------------------------------------------

  function profileBaseUrl(profileUrl) {
    return profileUrl.substring(0, profileUrl.lastIndexOf("/") + 1);
  }

  function loadReferencesForTriggers(baseUrl) {
    for (const trigger of TRIGGERS) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        trigger.sourceImg = img;
        trigger.origW = img.naturalWidth;
        trigger.origH = img.naturalHeight;
        rehashTrigger(trigger);
        console.log(`[overlay/content] reference loaded: ${trigger.file} (${trigger.origW}x${trigger.origH})`);
        updateDebugPanelStatus();
      };
      img.onerror = () => console.warn(`[overlay/content] failed to load reference: ${trigger.file}`);
      img.src = baseUrl + "references/" + trigger.file;
    }
  }

  function applyProfile(profile, sourceUrl) {
    TRIGGERS = profile.triggers.map(t => ({ ...t }));
    console.log(`[overlay/content] profile loaded: ${profile.name} v${profile.version} (${TRIGGERS.length} triggers)`);
    loadReferencesForTriggers(profileBaseUrl(sourceUrl));
    updateDebugPanelStatus();
  }

  async function loadProfile() {
    // Try cache first.
    try {
      const cached = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "null");
      if (cached && Date.now() - cached.ts < PROFILE_CACHE_TTL_MS) {
        console.log("[overlay/content] profile: using cached version");
        applyProfile(cached.profile, PROFILE_URL);
        fetchAndCacheProfile(); // refresh in background
        return;
      }
    } catch (_) {}

    await fetchAndCacheProfile();
  }

  async function fetchAndCacheProfile() {
    try {
      const res = await fetch(PROFILE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const profile = await res.json();
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ ts: Date.now(), profile }));
      console.log("[overlay/content] profile: fetched from CDN");
      applyProfile(profile, PROFILE_URL);
    } catch (err) {
      console.warn("[overlay/content] profile fetch failed:", err.message);
      // If we have any stale cache, use it rather than leaving TRIGGERS empty.
      try {
        const cached = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "null");
        if (cached) {
          console.warn("[overlay/content] profile: using stale cache");
          applyProfile(cached.profile, PROFILE_URL);
        }
      } catch (_) {}
    }
  }

  // Rescale a reference to the current stream's native video dimensions and
  // recompute its hash. If no video is attached yet, hash at native size as a
  // fallback. Triggers whose scaled size falls outside usable bounds get
  // refHash=null and are skipped by matching.
  function rehashTrigger(trigger) {
    if (!trigger.sourceImg) return;
    let w = trigger.origW, h = trigger.origH;
    if (currentVideo && currentVideo.videoWidth && trigger.srcW) {
      const scale = currentVideo.videoWidth / trigger.srcW;
      w = Math.max(1, Math.round(trigger.origW * scale));
      h = Math.max(1, Math.round(trigger.origH * scale));
    }
    trigger.w = w;
    trigger.h = h;
    if (w < SMALL_REF_THRESHOLD || h < SMALL_REF_THRESHOLD || w > CAPTURE_SIZE || h > CAPTURE_SIZE) {
      trigger.refHash = null;
      return;
    }
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(trigger.sourceImg, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    trigger.refHash = dHashFromPixels(px, w, 0, 0, w, h);
  }

  function rehashAllTriggers() {
    for (const t of TRIGGERS) rehashTrigger(t);
    updateDebugPanelStatus();
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
      pointerEvents: "none",
      boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
    });
    document.body.appendChild(el);
    return el;
  }

  function showPopups(payloads, clientX, clientY) {
    // Reuse or create one DOM element per payload.
    while (activePopups.length < payloads.length) activePopups.push(makePopupEl());

    payloads.forEach((payload, i) => {
      const el = activePopups[i];
      el.innerHTML =
        `<div style="font-weight:bold;color:#bf94ff;margin-bottom:4px;">${payload.title}</div>` +
        `<div>${payload.text}</div>`;
      const ox = (payload.popupOffset && payload.popupOffset.x != null) ? payload.popupOffset.x : 14;
      const oy = (payload.popupOffset && payload.popupOffset.y != null) ? payload.popupOffset.y : 22;
      el.style.left = Math.min(clientX + ox, window.innerWidth  - 280) + "px";
      el.style.top  = Math.min(clientY + oy, window.innerHeight - 100) + "px";
      el.style.display = "block";
    });

    // Hide any extras from a previous trigger that had more payloads.
    for (let i = payloads.length; i < activePopups.length; i++)
      activePopups[i].style.display = "none";
  }

  function hidePopups() {
    for (const el of activePopups) el.style.display = "none";
  }

  // --- Mouse handler --------------------------------------------------------

  let lastMouseX = 0;
  let lastMouseY = 0;

  function onDocumentMouseMove(event) {
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;

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
      hidePopup();
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
    const best = findBestMatch(capturePixels);

    if (best && best.dist <= MATCH_THRESHOLD) {
      const label = best.trigger.payloads ? best.trigger.payloads[0].title : best.trigger.id;
      lastMatchInfo = { title: label, dist: best.dist };
      showPopups(best.trigger.payloads || [], event.clientX, event.clientY);
    } else {
      const label = best ? (best.trigger.payloads ? best.trigger.payloads[0].title : best.trigger.id) : null;
      lastMatchInfo = best ? { title: label, dist: best.dist, noMatch: true } : null;
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
    const refsLoaded = TRIGGERS.filter((t) => t.refHash).length;
    const lines = [
      `<span style="color:#adadb8">videos: ${stats.total}t ${stats.visible}v | refs: ${refsLoaded}/${TRIGGERS.length}</span>`,
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
      matchLine = lastMatchInfo.noMatch
        ? `<span style="color:#adadb8">best: ${lastMatchInfo.dist} "${lastMatchInfo.title}"</span>`
        : `<span style="color:#00f593">MATCH "${lastMatchInfo.title}" d=${lastMatchInfo.dist}</span>`;
    }
    infoEl.innerHTML =
      `client: ${info.clientX}, ${info.clientY}<br>` +
      `video:  ${info.videoX}, ${info.videoY}<br>` +
      `rect:   ${info.rectLeft}, ${info.rectTop}<br>` +
      `offset: ${info.offsetX}, ${info.offsetY}<br>` +
      `fit:    ${info.objectFit}<br>` +
      `source: ${info.videoW}x${info.videoH}` +
      (matchLine ? `<br>${matchLine}` : "");
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
      "position:absolute;border:2px solid #00f593;background:rgba(0,245,147,0.15);" +
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

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `capture-${ts}-${sw}x${sh}-of-${snapshot.width}x${snapshot.height}.png`;
    crop.toBlob((blob) => {
      if (!blob) { showToast("Failed to encode PNG.", "error"); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`Saved ${filename} (${sw}×${sh})`, "ok");
    }, "image/png");

    cancelCaptureMode();
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

  // --- Messages from background ---------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "capture-trigger") { startCaptureMode(); sendResponse({ ok: true }); }
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

  loadProfile();
  ensureDebugPanel();
  document.addEventListener("mousemove", onDocumentMouseMove, { passive: true });
  document.addEventListener("mousedown", onDocumentClick, true);
  heartbeat();
})();
