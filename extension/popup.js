// Popup script — profile selection + saved trigger management.

const CATALOG_URL        = "https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/catalog.json";
const PROFILES_REPO_BASE = "https://raw.githubusercontent.com/frothydv/streamGenieProfiles";
const ACTIVE_PROFILE_KEY = "streamGenie_active_profile";
const WORKER_URL         = "https://streamgenie-submit.vbjosh.workers.dev";
const SUBMIT_SECRET      = StreamGenieConfig.SUBMIT_SECRET;
const LOCAL_CATALOG_KEY  = "streamGenie_local_catalog";
const DEFAULT_PROFILE = {
  gameId:    "slay-the-spire-2",
  profileId: "community",
  name:      "STS2 Community",
  url:       "https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/games/slay-the-spire-2/profiles/community/profile.json",
};

const FALLBACK_CATALOG = [
  {
    gameId:     "slay-the-spire-2",
    gameName:   "Slay the Spire 2",
    legacyTwitchSlug: "slay-the-spire-ii",
    profiles: [
      { id: "community", name: "STS2 Community", verified: true, url: DEFAULT_PROFILE.url },
    ],
  },
];

const contributorCodeKey  = (gId, pId) => `streamGenie_code_${gId}_${pId}`;

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

(async function () {
  // --- Tab status ---
  const statusEl = document.getElementById("status");
  let currentTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
    if (!tab) {
      statusEl.className = "status off";
      statusEl.textContent = "No active tab.";
    } else if ((tab.url || "").includes("twitch.tv")) {
      statusEl.className = "status ok";
      statusEl.textContent = "Active on Twitch: " + new URL(tab.url).pathname;
    } else if ((tab.url || "").includes("youtube.com/watch")) {
      statusEl.className = "status ok";
      const ytUrl = new URL(tab.url);
      const v = ytUrl.searchParams.get("v");
      statusEl.textContent = "Active on YouTube: " + (v ? "/watch?v=" + v : ytUrl.pathname);
    } else {
      statusEl.className = "status off";
      statusEl.textContent = "Not on Twitch or YouTube.";
    }
  } catch (err) {
    statusEl.className = "status off";
    statusEl.textContent = "Error: " + err.message;
  }

  // --- Load catalog from CDN (fall back to hardcoded if unavailable) ---
  let CATALOG = FALLBACK_CATALOG;
  let catalogLoadedOk = false;
  try {
    const url = new URL(CATALOG_URL);
    url.searchParams.set("_cb", Date.now());
    console.log("[overlay/popup] Fetching catalog:", url.toString());
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (res.ok) {
      const raw = await res.json();
      CATALOG = raw.games.map(g => ({
        gameId:      g.id,
        gameName:    g.name,
        legacyTwitchSlug: g.legacyTwitchSlug || g.twitchSlug || null,
        profiles:    g.profiles.map(p => ({
          id:           p.id,
          name:         p.name,
          verified:     p.verified     ?? false,
          url:          ensureRawUrl(p.url),
          triggerCount: p.triggerCount ?? null,
          timesUsed:    p.timesUsed    ?? null,
          upvotes:      p.upvotes      ?? null,
        })),
      }));
      catalogLoadedOk = true;
    }
  } catch (_) {
    // Network unavailable — fallback catalog still works
  }

  if (!catalogLoadedOk) {
    const connNote = document.getElementById("connectivity-note");
    if (connNote) connNote.style.display = "block";
  }

  // Always apply FALLBACK_CATALOG overrides — legacyTwitchSlug and verified are authoritative
  // here so CDN cache staleness never breaks matching or badge display.
  for (const fallback of FALLBACK_CATALOG) {
    const existing = CATALOG.find(g => g.gameId === fallback.gameId);
    if (!existing) continue;
    if (fallback.legacyTwitchSlug) existing.legacyTwitchSlug = fallback.legacyTwitchSlug;
    for (const fp of fallback.profiles) {
      const ep = existing.profiles.find(p => p.id === fp.id);
      if (ep && fp.verified !== undefined) ep.verified = fp.verified;
    }
  }

  // Merge in locally-created profiles (persist across reloads until CDN cache refreshes).
  // Also propagates legacyTwitchSlug if CDN entry is missing it, fixing catalogMatch.
  const localCatalogStore = await chrome.storage.local.get(LOCAL_CATALOG_KEY);
  for (const localGame of (localCatalogStore[LOCAL_CATALOG_KEY] || [])) {
    const existing = CATALOG.find(g => g.gameId === localGame.gameId);
    if (existing) {
      if (!existing.legacyTwitchSlug && (localGame.legacyTwitchSlug || localGame.twitchSlug)) existing.legacyTwitchSlug = localGame.legacyTwitchSlug || localGame.twitchSlug;
      for (const p of localGame.profiles) {
        if (!existing.profiles.find(ep => ep.id === p.id)) existing.profiles.push(p);
      }
    } else {
      CATALOG.push({ ...localGame });
    }
  }

  // --- Detect game from content script ---
  let detectedSlug = null;
  let detectedName = null;
  let detectedVideoTitle = null;
  let contentProfileLoadError = null;
  let contentProfileStaleWarning = null;
  const isYouTube = currentTab && (currentTab.url || "").includes("youtube.com/watch");
  if (currentTab && ((currentTab.url || "").includes("twitch.tv") || isYouTube)) {
    try {
      const resp = await new Promise((resolve) => {
        chrome.tabs.sendMessage(currentTab.id, { type: "get-game" }, (r) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      });
      if (resp?.game?.slug) { detectedSlug = resp.game.slug; detectedName = resp.game.name; }
      if (resp?.videoTitle) { detectedVideoTitle = resp.videoTitle; }
      contentProfileLoadError = resp?.profileLoadError || null;
      contentProfileStaleWarning = resp?.profileStaleWarning || null;
    } catch (_) {}
  }

  // --- YouTube title-based game detection (client-side fuzzy match) ---
  function fuzzyMatchTitle(title, catalog) {
    if (!title) return null;
    const tl = title.toLowerCase();
    let best = null, bestScore = 0;
    for (const game of catalog) {
      const gn = game.gameName.toLowerCase();
      let score = 0;
      if (tl === gn) score = 1.0;
      else if (tl.includes(gn)) score = gn.length / tl.length;
      else if (gn.includes(tl)) score = tl.length / gn.length;
      // Word overlap scoring
      const titleWords = new Set(tl.split(/\s+/));
      const gameWords = gn.split(/\s+/);
      const common = gameWords.filter(w => titleWords.has(w));
      if (common.length > 0) {
        const wordScore = common.length / Math.max(gameWords.length, 1);
        score = Math.max(score, wordScore * 0.8);
      }
      if (score > bestScore) {
        bestScore = score;
        best = game;
      }
    }
    return bestScore >= 0.4 ? best : null;
  }

  if (isYouTube && detectedVideoTitle) {
    const match = fuzzyMatchTitle(detectedVideoTitle, CATALOG);
    if (match) {
      detectedSlug = match.gameId;
      detectedName = match.gameName;
    }
  }

  // --- Load active profile ---
  const r = await chrome.storage.local.get(ACTIVE_PROFILE_KEY);
  let active = r[ACTIVE_PROFILE_KEY] || DEFAULT_PROFILE;

  // Reconstruct active profile in catalog if CDN is stale and local cache missed it.
  // Uses the stored active.url so the profile can be loaded even before CDN refreshes.
  if (active?.url) {
    let game = CATALOG.find(g => g.gameId === active.gameId);
    if (!game) {
      game = { gameId: active.gameId, gameName: active.gameId, legacyTwitchSlug: null, profiles: [] };
      CATALOG.push(game);
    }
    if (!game.profiles.find(p => p.id === active.profileId)) {
      game.profiles.push({ id: active.profileId, name: active.name, verified: false, url: active.url });
    }
  }

  // --- Build game selector ---
  const gameSelect    = document.getElementById("game-select");
  const profileSelect = document.getElementById("profile-select");
  const applyBtn      = document.getElementById("apply-btn");
  const applyNote          = document.getElementById("apply-note");
  const detectedEl         = document.getElementById("detected-game");
  const noProfileBanner    = document.getElementById("no-profile-banner");
  const noProfileText      = document.getElementById("no-profile-text");
  const createProfileBtn   = document.getElementById("create-profile-btn");
  const newProfileLink     = document.getElementById("new-profile-link");
  const newProfileForm     = document.getElementById("new-profile-form");
  const newProfileNameEl   = document.getElementById("new-profile-name");
  const newProfileSubmit   = document.getElementById("new-profile-submit");
  const newProfileCancel   = document.getElementById("new-profile-cancel");
  const newProfileNote     = document.getElementById("new-profile-note");

  // --- Reflect content.js profile load errors in the popup near profile selector ---
  if (contentProfileLoadError && applyNote) {
    applyNote.textContent = `Profile failed to load: ${contentProfileLoadError}`;
    applyNote.style.color = "#ff5c5c";
    applyNote.style.display = "block";
  } else if (contentProfileStaleWarning && applyNote) {
    applyNote.textContent = "CDN unreachable — using cached profile";
    applyNote.style.color = "#f5b000";
    applyNote.style.display = "block";
  }

  // Match detectedSlug against gameId, legacyTwitchSlug, or twitchSlug (backward compat).
  const catalogMatch = detectedSlug
    ? CATALOG.find(g => g.gameId === detectedSlug || g.legacyTwitchSlug === detectedSlug || g.twitchSlug === detectedSlug)
    : null;
  const selectedGameId = catalogMatch ? catalogMatch.gameId : active.gameId;

  for (const game of CATALOG) {
    const opt = document.createElement("option");
    opt.value = game.gameId;
    opt.textContent = game.gameName;
    if (game.gameId === selectedGameId) opt.selected = true;
    gameSelect.appendChild(opt);
  }

  // Show detected game badge, no-profile banner, or waiting hint.
  if (detectedSlug && catalogMatch) {
    detectedEl.textContent = "✓ Auto-detected from stream";
    detectedEl.style.display = "block";
  } else if (!detectedSlug && currentTab && ((currentTab.url || "").includes("twitch.tv") || isYouTube)) {
    detectedEl.textContent = "No game detected — browse to a live stream";
    detectedEl.style.color = "#777";
    detectedEl.style.display = "block";
  } else if (detectedSlug && !catalogMatch) {
    const label = detectedName || detectedSlug;
    noProfileText.textContent = `"${label}" has no profile yet.`;
    createProfileBtn.textContent = `+ Create profile for ${label}`;
    noProfileBanner.style.display = "block";
    createProfileBtn.addEventListener("click", async () => {
      createProfileBtn.disabled = true;
      createProfileBtn.textContent = "Creating…";
      try {
        // Use the canonical gameId — if detectedSlug is a Twitch category slug for a
        // known game (e.g. "slay-the-spire-ii" → "slay-the-spire-2"), use that ID.
        const fbMatch  = FALLBACK_CATALOG.find(g => g.gameId === detectedSlug || g.legacyTwitchSlug === detectedSlug || g.twitchSlug === detectedSlug);
        const cId      = fbMatch ? fbMatch.gameId                      : detectedSlug;
        const cName    = fbMatch ? fbMatch.gameName                    : (detectedName || detectedSlug);
        const cSlug    = fbMatch ? (fbMatch.legacyTwitchSlug || fbMatch.twitchSlug || detectedSlug): detectedSlug;
        await doCreateProfile(cId, cName, cSlug, "community");
        noProfileBanner.style.display = "none";
        detectedEl.textContent = "✓ Profile created — ready to use";
        detectedEl.style.color = "#00f593";
        detectedEl.style.display = "block";
      } catch (err) {
        noProfileText.textContent = `Error: ${err.message}`;
        createProfileBtn.textContent = `+ Create profile for ${label}`;
        createProfileBtn.disabled = false;
      }
    });
  }

  // --- New profile form (always accessible) ---
  newProfileLink.addEventListener("click", (e) => {
    e.preventDefault();
    newProfileForm.style.display = newProfileForm.style.display === "none" ? "block" : "none";
    newProfileNote.textContent = "";
    newProfileNameEl.value = "";
    newProfileNameEl.focus();
  });
  newProfileCancel.addEventListener("click", () => {
    newProfileForm.style.display = "none";
  });
  newProfileSubmit.addEventListener("click", async () => {
    const rawName = newProfileNameEl.value.trim();
    if (!rawName) { newProfileNote.textContent = "Enter a profile name."; return; }
    const profileId = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const currentGame = CATALOG.find(g => g.gameId === gameSelect.value);
    if (!currentGame) { newProfileNote.textContent = "Select a game first."; return; }
    newProfileSubmit.disabled = true;
    newProfileSubmit.textContent = "Creating…";
    newProfileNote.textContent = "";
    try {
      await doCreateProfile(currentGame.gameId, currentGame.gameName, currentGame.legacyTwitchSlug || currentGame.twitchSlug || currentGame.gameId, profileId, rawName);
      newProfileForm.style.display = "none";
      newProfileNote.textContent = "";
    } catch (err) {
      newProfileNote.textContent = `Error: ${err.message}`;
    } finally {
      newProfileSubmit.disabled = false;
      newProfileSubmit.textContent = "Create";
    }
  });

  async function doCreateProfile(gameId, gameName, twitchSlug, profileId, profileName) {
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Submit-Secret": SUBMIT_SECRET },
      body: JSON.stringify({ gameId, gameName, twitchSlug, newProfileId: profileId, newProfileName: profileName || profileId, mode: "create-profile" }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // Save contributor code — profile creator is automatically trusted.
    if (data.code) {
      await chrome.storage.local.set({ [contributorCodeKey(gameId, data.profileId)]: data.code });
    }

    // Persist to local catalog so the profile survives popup reloads until CDN refreshes.
    const newProf = { id: data.profileId, name: data.profileName, verified: false, url: data.profileUrl };
    const stored = await chrome.storage.local.get(LOCAL_CATALOG_KEY);
    const localAdditions = stored[LOCAL_CATALOG_KEY] || [];
    let localGame = localAdditions.find(g => g.gameId === gameId);
    if (!localGame) {
      localGame = { gameId, gameName, legacyTwitchSlug: twitchSlug, profiles: [] };
      localAdditions.push(localGame);
    }
    if (!localGame.profiles.find(p => p.id === data.profileId)) localGame.profiles.push(newProf);
    await chrome.storage.local.set({ [LOCAL_CATALOG_KEY]: localAdditions });

    // Update in-memory catalog immediately.
    let game = CATALOG.find(g => g.gameId === gameId);
    if (game) {
      if (!game.profiles.find(p => p.id === data.profileId)) game.profiles.push(newProf);
    } else {
      game = { gameId, gameName, legacyTwitchSlug: twitchSlug, profiles: [newProf] };
      CATALOG.push(game);
      const opt = document.createElement("option");
      opt.value = gameId; opt.textContent = gameName; opt.selected = true;
      gameSelect.appendChild(opt);
    }

    // Select the new game/profile and update active.
    gameSelect.value = gameId;
    rebuildProfileSelect();
    profileSelect.value = data.profileId;
    active = { gameId, profileId: data.profileId, name: data.profileName, url: data.profileUrl };
    await chrome.storage.local.set({ [ACTIVE_PROFILE_KEY]: active });
    renderTriggers();
    renderContributorStatus();
    console.log("[overlay/popup] profile created:", data.profileUrl);
  }

  let profileSortBy = "upvotes";

  function sortProfiles(profiles, sortBy) {
    return [...profiles].sort((a, b) => {
      if (sortBy === "upvotes")  return (b.upvotes      ?? -1) - (a.upvotes      ?? -1);
      if (sortBy === "triggers") return (b.triggerCount ?? -1) - (a.triggerCount ?? -1);
      if (sortBy === "used")     return (b.timesUsed    ?? -1) - (a.timesUsed    ?? -1);
      return 0;
    });
  }

  function profileOptionLabel(p) {
    const badge = p.verified ? "✓ " : "";
    const stats = [];
    if (p.triggerCount != null) stats.push(`${p.triggerCount}T`);
    if (p.timesUsed    != null) stats.push(`${p.timesUsed}×`);
    if (p.upvotes      != null) stats.push(`▲${p.upvotes}`);
    return stats.length ? `${badge}${p.name}  ·  ${stats.join("  ")}` : `${badge}${p.name}`;
  }

  function rebuildProfileSelect() {
    profileSelect.innerHTML = "";
    const game = CATALOG.find(g => g.gameId === gameSelect.value);
    if (!game) return;
    const sorted = sortProfiles(game.profiles, profileSortBy);
    for (const p of sorted) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = profileOptionLabel(p);
      if (game.gameId === active.gameId && p.id === active.profileId) opt.selected = true;
      profileSelect.appendChild(opt);
    }
  }

  rebuildProfileSelect();
  gameSelect.addEventListener("change", () => { rebuildProfileSelect(); renderTriggers(); renderContributorStatus(); });
  profileSelect.addEventListener("change", () => { renderTriggers(); renderContributorStatus(); });

  document.querySelectorAll(".sort-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      profileSortBy = btn.dataset.sort;
      document.querySelectorAll(".sort-pill").forEach(b => b.classList.toggle("active", b.dataset.sort === profileSortBy));
      rebuildProfileSelect();
    });
  });

  applyBtn.addEventListener("click", async () => {
    const game = CATALOG.find(g => g.gameId === gameSelect.value);
    const prof = game && game.profiles.find(p => p.id === profileSelect.value);
    if (!game || !prof) return;
    const unchanged = game.gameId === active.gameId && prof.id === active.profileId;
    // Activation ping — fire-and-forget, non-blocking
    if (!unchanged) {
      fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Submit-Secret": SUBMIT_SECRET },
        body: JSON.stringify({ gameId: game.gameId, profileId: prof.id, mode: "activate" }),
      }).catch(() => {});
    }
    active = { gameId: game.gameId, profileId: prof.id, name: prof.name, url: prof.url };
    await chrome.storage.local.set({ [ACTIVE_PROFILE_KEY]: active });
    if (unchanged) {
      // Don't clobber error/stale notes — "already active" isn't a state change
      if (!contentProfileLoadError && !contentProfileStaleWarning) {
        applyNote.textContent = "Already active.";
        applyNote.style.color = "#adadb8";
      }
    } else {
      applyNote.textContent = "Reload the Twitch page to activate.";
      applyNote.style.color = "#00f593";
    }
    renderTriggers();
    renderContributorStatus();
  });

  // --- Contribute button ---
  document.getElementById("refresh-profile-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    const gId = gameSelect.value || active.gameId;
    const pId = profileSelect.value || active.profileId;
    const cKey = `streamGenie_profile_${gId}_${pId}`;
    
    // Clear the cache
    localStorage.removeItem(cKey);
    
    // Notify content script if active
    if (currentTab) {
      chrome.tabs.sendMessage(currentTab.id, { type: "reload-profile" }).catch(() => {});
    }
    
    // Re-render UI
    renderTriggers();
  });

  document.getElementById("contribute-btn").addEventListener("click", async () => {
    if (!currentTab) return;
    const gId  = gameSelect.value  || active.gameId;
    const pId  = profileSelect.value || active.profileId;
    const game = CATALOG.find(g => g.gameId === gId);
    const prof = game?.profiles.find(p => p.id === pId);
    try {
      await chrome.tabs.sendMessage(currentTab.id, {
        type:        "capture-trigger",
        gameId:      gId,
        profileId:   pId,
        profileUrl:  prof?.url  || active.url,
        profileName: prof?.name || active.name,
      });
    } catch (_) {}
    window.close();
  });

  document.getElementById("manage-profile-btn").addEventListener("click", async () => {
    if (!currentTab) return;
    try {
      await chrome.tabs.sendMessage(currentTab.id, { type: "open-curator" });
    } catch (_) {}
    window.close();
  });

  document.getElementById("debug-panel-btn").addEventListener("click", async () => {
    const KEY = "streamGenie_debugPanel";
    const stored = await chrome.storage.local.get(KEY);
    await chrome.storage.local.set({ [KEY]: !stored[KEY] });
    window.close();
  });


  async function workerPost(body) {
    const gId     = body.gameId    || active.gameId;
    const pId     = body.profileId || active.profileId;
    const codeKey = contributorCodeKey(gId, pId);
    const stored  = await chrome.storage.local.get(codeKey);
    const code    = stored[codeKey] || null;
    const headers = { "Content-Type": "application/json", "X-Submit-Secret": SUBMIT_SECRET };
    if (code) headers["X-Contributor-Key"] = code;
    const res  = await fetch(WORKER_URL, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function submitRemoval(trigger) {
    const data = await workerPost({
      gameId:    active.gameId,
      profileId: active.profileId,
      trigger:   { id: trigger.id },
      mode:      "remove",
    });
    return data.prUrl;
  }

  // ---------------------------------------------------------------------------
  // Proposal review
  // ---------------------------------------------------------------------------

  function showProposalsPanel(gId, pId) {
    document.getElementById("triggers-section").style.display = "none";
    const panel = document.getElementById("proposals-panel");
    panel.style.display = "block";
    renderProposals(gId, pId);
  }

  document.getElementById("proposals-back").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("proposals-panel").style.display = "none";
    document.getElementById("triggers-section").style.display = "block";
  });

  async function renderProposals(gId, pId) {
    const listEl = document.getElementById("proposals-list");
    listEl.innerHTML = '<div class="empty-note">Loading proposals…</div>';

    let proposals, existingTriggers = [];
    try {
      const data = await workerPost({ gameId: gId, profileId: pId, mode: "list-proposals" });
      proposals = data.proposals || [];
    } catch (err) {
      const errEl = document.createElement("div");
      errEl.className = "empty-note";
      errEl.textContent = `Error: ${err.message}`;
      listEl.innerHTML = "";
      listEl.appendChild(errEl);
      return;
    }

    // Load current profile triggers for dupe check
    try {
      const game = CATALOG.find(g => g.gameId === gId);
      const prof = game?.profiles.find(p => p.id === pId);
      if (prof?.url) {
        const url = new URL(ensureRawUrl(prof.url));
        url.searchParams.set("_cb", Date.now());
        const res = await fetch(url.toString(), { cache: "no-store" });
        if (res.ok) {
          const profileData = await res.json();
          existingTriggers = (profileData.triggers || []).sort((a, b) => {
            const tA = (a.payloads?.[0]?.title || a.id).toLowerCase();
            const tB = (b.payloads?.[0]?.title || b.id).toLowerCase();
            return tA.localeCompare(tB);
          });
        }
      }
    } catch {}

    listEl.innerHTML = "";
    if (proposals.length === 0) {
      listEl.innerHTML = '<div class="empty-note">No pending proposals.</div>';
      document.getElementById("review-btn").style.display = "none";
      return;
    }

    proposals.forEach(p => listEl.appendChild(buildProposalRow(p, gId, pId, existingTriggers, listEl)));
  }

  function buildProposalRow(proposal, gId, pId, existingTriggers, listEl) {
    const trigger = proposal.trigger;
    const payload = trigger.payloads?.[0] || {};
    const ref     = trigger.references?.[0];
    const title   = payload.title || trigger.id;
    const actionColor = proposal.action === "add" ? "#00f593" : proposal.action === "update" ? "#f5b000" : "#ff5c5c";

    const row = document.createElement("div");
    row.className = "trigger-row";
    row.style.cssText = "flex-direction:column; align-items:stretch; gap:0;";

    // ── Header ───────────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.style.cssText = "display:flex; align-items:center; gap:6px;";

    if (ref?.file) {
      const imgBranch = proposal.action === "remove" ? "main" : proposal.branch;
      const img = document.createElement("img");
      img.className = "proposal-img-thumb";
      img.src = `${PROFILES_REPO_BASE}/${imgBranch}/games/${gId}/profiles/${pId}/references/${ref.file}`;
      img.onerror = () => {
        img.replaceWith(noImgPlaceholder());
      };
      header.appendChild(img);
    } else {
      header.appendChild(noImgPlaceholder());
    }

    function noImgPlaceholder() {
      const ph = document.createElement("div");
      ph.className = "proposal-img-thumb";
      ph.style.cssText = "display:flex;align-items:center;justify-content:center;background:#1a0a0a;color:#ff5c5c;font-size:16px;flex-shrink:0;";
      ph.textContent = "✕";
      return ph;
    }

    const info = document.createElement("div");
    info.style.cssText = "flex:1; overflow:hidden;";
    const titleEl = document.createElement("div");
    titleEl.className = "trigger-label";
    titleEl.textContent = title;
    const badgeEl = document.createElement("small");
    badgeEl.textContent = proposal.action.toUpperCase();
    badgeEl.style.cssText = `color:${actionColor}; display:block; font-size:10px;`;
    info.appendChild(titleEl);
    info.appendChild(badgeEl);
    header.appendChild(info);

    const reviewBtn = document.createElement("button");
    reviewBtn.className = "edit-btn";
    reviewBtn.textContent = "Review";
    reviewBtn.onclick = async () => {
      if (!currentTab) {
        reviewBtn.textContent = "No active tab";
        setTimeout(() => { reviewBtn.textContent = "Review"; }, 2000);
        return;
      }
      const codeKey = contributorCodeKey(gId, pId);
      const stored = await chrome.storage.local.get(codeKey);
      const code = stored[codeKey] || null;
      try {
        await chrome.tabs.sendMessage(currentTab.id, {
          type: "review-proposal",
          proposal,
          gameId: gId,
          profileId: pId,
          contributorCode: code,
        });
        window.close();
      } catch (err) {
        reviewBtn.textContent = "Open Twitch first";
        setTimeout(() => { reviewBtn.textContent = "Review"; }, 2000);
      }
    };
    header.appendChild(reviewBtn);
    row.appendChild(header);
    return row;
  }

  function updateReviewCount(listEl) {
    const remaining = listEl.querySelectorAll(".trigger-row").length;
    const btn = document.getElementById("review-btn");
    if (remaining === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-note";
      empty.textContent = "All proposals reviewed.";
      listEl.appendChild(empty);
      btn.style.display = "none";
    } else {
      btn.textContent = `Review Proposed Triggers (${remaining})`;
    }
  }

  // ---------------------------------------------------------------------------

  // --- Contributor status ---
  async function renderContributorStatus() {
    const trustedEl  = document.getElementById("contributor-trusted");
    const prEl       = document.getElementById("contributor-pr");
    const codeHintEl = document.getElementById("contributor-code-hint");
    const codeClearEl = document.getElementById("contributor-clear");
    const codeInput  = document.getElementById("contributor-code-input");
    const codeSaveBtn = document.getElementById("contributor-code-save");
    const codeNote   = document.getElementById("contributor-code-note");

    const gId = gameSelect.value || active.gameId;
    const pId = profileSelect.value || active.profileId;
    const codeKey = contributorCodeKey(gId, pId);
    const stored  = await chrome.storage.local.get(codeKey);
    const code    = stored[codeKey] || null;

    if (code) {
      trustedEl.style.display = "block";
      prEl.style.display = "none";
      codeHintEl.textContent = `(${code.replace(/-/g, "").slice(0, 8)}…)`;
      const copyLinkEl = document.getElementById("contributor-copy");
      if (copyLinkEl) {
        copyLinkEl.onclick = async (e) => {
          e.preventDefault();
          await navigator.clipboard.writeText(code);
          const prev = copyLinkEl.textContent;
          copyLinkEl.textContent = "Copied!";
          setTimeout(() => { copyLinkEl.textContent = prev; }, 1500);
        };
      }
      codeClearEl.onclick = async (e) => {
        e.preventDefault();
        await chrome.storage.local.remove(codeKey);
        document.getElementById("review-btn").style.display = "none";
        renderContributorStatus();
      };
      // Fetch open proposal count and wire review button
      const reviewBtn = document.getElementById("review-btn");
      reviewBtn.style.display = "none";
      try {
        const data = await workerPost({ gameId: gId, profileId: pId, mode: "list-proposals" });
        const count = (data.proposals || []).length;
        if (count > 0) {
          reviewBtn.textContent = `Review Proposed Triggers (${count})`;
          reviewBtn.style.display = "block";
          reviewBtn.onclick = () => showProposalsPanel(gId, pId);
        }
      } catch { /* network unavailable — just hide the button */ }
    } else {
      trustedEl.style.display = "none";
      prEl.style.display = "block";
      codeNote.textContent = "";
      codeInput.value = "";

      codeSaveBtn.onclick = async () => {
        const input = codeInput.value.trim();
        if (!input) { codeNote.textContent = "Paste a code first."; codeNote.style.color = "#f5b000"; return; }
        codeSaveBtn.disabled = true;
        codeSaveBtn.textContent = "Verifying…";
        codeNote.textContent = "";
        try {
          const res = await fetch(WORKER_URL, {
            method: "POST",
            headers: {
              "Content-Type":     "application/json",
              "X-Submit-Secret":  SUBMIT_SECRET,
              "X-Contributor-Key": input,
            },
            body: JSON.stringify({ gameId: gId, profileId: pId, mode: "verify" }),
          });
          const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
          if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          if (data.trusted) {
            await chrome.storage.local.set({ [codeKey]: input });
            renderContributorStatus();
          } else {
            codeNote.textContent = "Code not recognized for this profile.";
            codeNote.style.color = "#ff5c5c";
            codeSaveBtn.textContent = "Save";
            codeSaveBtn.disabled = false;
          }
        } catch (err) {
          codeNote.textContent = `Error: ${err.message}`;
          codeNote.style.color = "#ff5c5c";
          codeSaveBtn.textContent = "Save";
          codeSaveBtn.disabled = false;
        }
      };
    }
  }

  // --- Saved triggers ---
  async function renderTriggers() {
    const listEl  = document.getElementById("triggers-list");
    const labelEl = document.getElementById("profile-label");
    // Always reflect the selected dropdowns so the user sees the right list
    // even before clicking Apply.
    const gId  = gameSelect.value || active.gameId;
    const pId  = profileSelect.value || active.profileId;
    const game = CATALOG.find(g => g.gameId === gId);
    const prof = game?.profiles.find(p => p.id === pId);
    labelEl.textContent = prof?.name || active.name;
    listEl.innerHTML = "";

    // Load remote profile triggers
    let allTriggers = [];
    let profileLoadError = null;
    try {
      const pUrl = ensureRawUrl(prof?.url);
      if (pUrl) {
        const url = new URL(pUrl);
        url.searchParams.set("_cb", Date.now());
        const profileRes = await fetch(url.toString(), { cache: "no-store" });
        if (profileRes.ok) {
          const profileData = await profileRes.json();
          allTriggers = (profileData.triggers || []).map(t => ({ ...t, source: "profile" }));
          // Sync triggerCount into in-memory catalog so the dropdown shows it immediately.
          if (prof && prof.triggerCount !== allTriggers.length) {
            prof.triggerCount = allTriggers.length;
            rebuildProfileSelect();
          }
        } else {
          profileLoadError = `HTTP ${profileRes.status}`;
        }
      }
    } catch (err) {
      console.warn("[overlay/popup] Failed to load remote profile:", err);
      profileLoadError = "network error";
    }

    if (profileLoadError) {
      const note = document.createElement("div");
      note.className = "empty-note";
      note.style.color = "#f5b000";
      note.textContent = `⚠ Couldn't load profile (${profileLoadError}) — check your connection.`;
      listEl.appendChild(note);
      return;
    }

    allTriggers.sort((a, b) => {
      const tA = (a.payloads?.[0]?.title || a.id || "").toLowerCase();
      const tB = (b.payloads?.[0]?.title || b.id || "").toLowerCase();
      return tA.localeCompare(tB);
    });

    if (allTriggers.length === 0) {
      const note = document.createElement("div");
      note.className = "empty-note";
      const onDetectedGame = detectedSlug && catalogMatch && gId === catalogMatch.gameId;
      if (onDetectedGame) {
        note.innerHTML = 'No triggers yet for this profile. <span style="color:#9146ff;cursor:pointer;text-decoration:underline;" id="contribute-from-empty">Add the first one →</span>';
      } else {
        note.textContent = "No triggers found.";
      }
      listEl.appendChild(note);
      document.getElementById("contribute-from-empty")?.addEventListener("click", () => {
        document.getElementById("contribute-btn").click();
      });
      return;
    }

    allTriggers.forEach((trigger, idx) => {
      const first = (trigger.payloads || [])[0] || {};
      const label = first.title || first.text || trigger.id;
      const extras = (trigger.payloads || []).length - 1;

      const row = document.createElement("div");
      row.className = "trigger-row";

      const labelContainer = document.createElement("div");
      labelContainer.style.cssText = "display:flex;align-items:center;gap:6px;flex:1;";

      const labelEl = document.createElement("div");
      labelEl.className = "trigger-label";
      labelEl.textContent = label;
      if (extras > 0) {
        const sm = document.createElement("small");
        sm.textContent = `+${extras} more`;
        labelEl.appendChild(sm);
      }

      labelContainer.appendChild(labelEl);

      const editBtn = document.createElement("button");
      editBtn.className = "edit-btn";
      editBtn.textContent = "Edit";
      editBtn.onclick = () => openTriggerEditorFromPopup(trigger);

      row.appendChild(labelContainer);
      row.appendChild(editBtn);
      listEl.appendChild(row);
    });
  }

  renderTriggers();
  renderContributorStatus();

  // --- First-run onboarding banner ---
  const FIRST_RUN_KEY = "streamGenie_first_run_seen";
  const firstRunStore = await chrome.storage.local.get(FIRST_RUN_KEY);
  if (!firstRunStore[FIRST_RUN_KEY]) {
    const banner = document.getElementById("first-run-banner");
    if (banner) banner.style.display = "flex";
    document.getElementById("first-run-dismiss")?.addEventListener("click", async () => {
      await chrome.storage.local.set({ [FIRST_RUN_KEY]: true });
      document.getElementById("first-run-banner").style.display = "none";
    });
  }

  // --- Interference Settings ---
  const globalDisableExtEl = document.getElementById("global-disable-ext");
  if (globalDisableExtEl) {
    const extKey = "streamGenie_global_disable_ext";
    chrome.storage.local.get(extKey).then(res => {
      globalDisableExtEl.checked = !!res[extKey];
    });
    globalDisableExtEl.addEventListener("change", async () => {
      await chrome.storage.local.set({ [extKey]: globalDisableExtEl.checked });
      // Clear all channel-specific preferences when the global toggle is changed
      if (globalDisableExtEl.checked) {
        chrome.storage.local.get(null, items => {
          const keysToRemove = Object.keys(items).filter(k => k.startsWith("streamGenie_ext_pref_"));
          if (keysToRemove.length > 0) chrome.storage.local.remove(keysToRemove);
        });
      }
    });
  }

  async function openTriggerEditorFromPopup(trigger) {
    if (!currentTab) {
      alert("No active tab found. Please open a Twitch page first.");
      return;
    }

    console.log("[popup] Attempting to open trigger editor for trigger:", trigger.id);
    console.log("[popup] Current tab URL:", currentTab.url);

    try {
      // First, check if the content script is loaded by trying to get a simple response
      console.log("[popup] Checking if content script is loaded...");
      const checkResponse = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(currentTab.id, { type: "ping" }, (r) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(r);
          }
        });
      });

      console.log("[popup] Content script check response:", checkResponse);
      console.log("[popup] Sending trigger object:", JSON.stringify(trigger, null, 2));

      // Now try to send the edit trigger message
      const resp = await new Promise((resolve, reject) => {
        console.log("[popup] Sending edit-trigger message to tab", currentTab.id);
        chrome.tabs.sendMessage(currentTab.id, {
          type: "edit-trigger",
          trigger: trigger
        }, (r) => {
          console.log("[popup] Response received:", r, "Error:", chrome.runtime.lastError);
          if (chrome.runtime.lastError) {
            console.error("[popup] Runtime error:", chrome.runtime.lastError.message);
            reject(chrome.runtime.lastError);
          } else {
            resolve(r);
          }
        });
      });

      if (resp?.success) {
        window.close(); // Close popup after opening editor
      } else {
        console.error("[popup] Failed response:", resp);
        alert("Failed to open trigger editor: " + (resp?.error || "Unknown error"));
      }
    } catch (err) {
      console.error("[popup] Failed to open trigger editor:", err);
      console.error("[popup] Error details:", err.message);
      alert("Failed to open trigger editor. Make sure you're on a Twitch page with the extension active.\nError: " + err.message);
    }
  }
})();
