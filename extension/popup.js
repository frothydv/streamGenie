// Popup script — profile selection + saved trigger management.

const CATALOG_URL        = "https://cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@main/catalog.json";
const ACTIVE_PROFILE_KEY = "streamGenie_active_profile";
const WORKER_URL         = "https://streamgenie-submit.vbjosh.workers.dev";
const SUBMIT_SECRET      = "YorkshireTractorFactor";
const LOCAL_CATALOG_KEY  = "streamGenie_local_catalog";
const DEFAULT_PROFILE = {
  gameId:    "slay-the-spire-2",
  profileId: "community",
  name:      "STS2 Community",
  url:       "https://cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@main/games/slay-the-spire-2/profiles/community/profile.json",
};

const FALLBACK_CATALOG = [
  {
    gameId:     "slay-the-spire-2",
    gameName:   "Slay the Spire 2",
    twitchSlug: "slay-the-spire-ii",
    profiles: [
      { id: "community", name: "STS2 Community", url: DEFAULT_PROFILE.url },
    ],
  },
];

const userTriggersKey    = (gId, pId) => `streamGenie_triggers_${gId}_${pId}`;
const contributorCodeKey = (gId, pId) => `streamGenie_code_${gId}_${pId}`;

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
    } else {
      statusEl.className = "status off";
      statusEl.textContent = "Not on Twitch.";
    }
  } catch (err) {
    statusEl.className = "status off";
    statusEl.textContent = "Error: " + err.message;
  }

  // --- Load catalog from CDN (fall back to hardcoded if unavailable) ---
  let CATALOG = FALLBACK_CATALOG;
  try {
    const res = await fetch(CATALOG_URL);
    if (res.ok) {
      const raw = await res.json();
      CATALOG = raw.games.map(g => ({
        gameId:      g.id,
        gameName:    g.name,
        twitchSlug:  g.twitchSlug  || null,
        profiles:    g.profiles.map(p => ({ id: p.id, name: p.name, verified: p.verified ?? false, url: p.url })),
      }));
    }
  } catch (_) {
    // Network unavailable — fallback catalog still works
  }

  // Always apply FALLBACK_CATALOG twitchSlugs — they are authoritative.
  // CDN may have a wrong or missing value (e.g. "slay-the-spire-2" instead of
  // "slay-the-spire-ii"), and we can't fix the CDN immediately.
  for (const fallback of FALLBACK_CATALOG) {
    const existing = CATALOG.find(g => g.gameId === fallback.gameId);
    if (existing && fallback.twitchSlug) existing.twitchSlug = fallback.twitchSlug;
  }

  // Merge in locally-created profiles (persist across reloads until CDN cache refreshes).
  // Also propagates twitchSlug if CDN entry is missing it, fixing catalogMatch.
  const localCatalogStore = await chrome.storage.local.get(LOCAL_CATALOG_KEY);
  for (const localGame of (localCatalogStore[LOCAL_CATALOG_KEY] || [])) {
    const existing = CATALOG.find(g => g.gameId === localGame.gameId);
    if (existing) {
      if (!existing.twitchSlug && localGame.twitchSlug) existing.twitchSlug = localGame.twitchSlug;
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
  if (currentTab && (currentTab.url || "").includes("twitch.tv")) {
    try {
      const resp = await new Promise((resolve) => {
        chrome.tabs.sendMessage(currentTab.id, { type: "get-game" }, (r) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      });
      if (resp?.game?.slug) { detectedSlug = resp.game.slug; detectedName = resp.game.name; }
    } catch (_) {}
  }

  // --- Load active profile ---
  const r = await chrome.storage.local.get(ACTIVE_PROFILE_KEY);
  let active = r[ACTIVE_PROFILE_KEY] || DEFAULT_PROFILE;

  // Reconstruct active profile in catalog if CDN is stale and local cache missed it.
  // Uses the stored active.url so the profile can be loaded even before CDN refreshes.
  if (active?.url) {
    let game = CATALOG.find(g => g.gameId === active.gameId);
    if (!game) {
      game = { gameId: active.gameId, gameName: active.gameId, twitchSlug: null, profiles: [] };
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

  // Match detectedSlug against gameId OR twitchSlug (Twitch slugs often differ from our IDs).
  const catalogMatch = detectedSlug
    ? CATALOG.find(g => g.gameId === detectedSlug || g.twitchSlug === detectedSlug)
    : null;
  const selectedGameId = catalogMatch ? catalogMatch.gameId : active.gameId;

  for (const game of CATALOG) {
    const opt = document.createElement("option");
    opt.value = game.gameId;
    opt.textContent = game.gameName;
    if (game.gameId === selectedGameId) opt.selected = true;
    gameSelect.appendChild(opt);
  }

  // Show detected game badge or no-profile banner.
  if (detectedSlug && catalogMatch) {
    detectedEl.textContent = "✓ Auto-detected from stream";
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
        const fbMatch  = FALLBACK_CATALOG.find(g => g.gameId === detectedSlug || g.twitchSlug === detectedSlug);
        const cId      = fbMatch ? fbMatch.gameId                      : detectedSlug;
        const cName    = fbMatch ? fbMatch.gameName                    : (detectedName || detectedSlug);
        const cSlug    = fbMatch ? (fbMatch.twitchSlug || detectedSlug): detectedSlug;
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
      await doCreateProfile(currentGame.gameId, currentGame.gameName, currentGame.twitchSlug || currentGame.gameId, profileId, rawName);
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
      localGame = { gameId, gameName, twitchSlug, profiles: [] };
      localAdditions.push(localGame);
    }
    if (!localGame.profiles.find(p => p.id === data.profileId)) localGame.profiles.push(newProf);
    await chrome.storage.local.set({ [LOCAL_CATALOG_KEY]: localAdditions });

    // Update in-memory catalog immediately.
    let game = CATALOG.find(g => g.gameId === gameId);
    if (game) {
      if (!game.profiles.find(p => p.id === data.profileId)) game.profiles.push(newProf);
    } else {
      game = { gameId, gameName, twitchSlug, profiles: [newProf] };
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
    console.log("[overlay/popup] profile created:", data.profileUrl);
  }

  function rebuildProfileSelect() {
    profileSelect.innerHTML = "";
    const game = CATALOG.find(g => g.gameId === gameSelect.value);
    if (!game) return;
    for (const p of game.profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.verified ? `✓ ${p.name}` : p.name;
      if (game.gameId === active.gameId && p.id === active.profileId) opt.selected = true;
      profileSelect.appendChild(opt);
    }
  }

  rebuildProfileSelect();
  gameSelect.addEventListener("change", () => { rebuildProfileSelect(); renderTriggers(); });
  profileSelect.addEventListener("change", renderTriggers);

  applyBtn.addEventListener("click", async () => {
    const game = CATALOG.find(g => g.gameId === gameSelect.value);
    const prof = game && game.profiles.find(p => p.id === profileSelect.value);
    if (!game || !prof) return;
    const unchanged = game.gameId === active.gameId && prof.id === active.profileId;
    active = { gameId: game.gameId, profileId: prof.id, name: prof.name, url: prof.url };
    await chrome.storage.local.set({ [ACTIVE_PROFILE_KEY]: active });
    if (unchanged) {
      applyNote.textContent = "Already active.";
      applyNote.style.color = "#adadb8";
    } else {
      applyNote.textContent = "Reload the Twitch page to activate.";
      applyNote.style.color = "#00f593";
    }
    renderTriggers();
    renderContributorStatus();
  });

  // --- Contribute button ---
  document.getElementById("contribute-btn").addEventListener("click", async () => {
    if (!currentTab) return;
    try {
      await chrome.tabs.sendMessage(currentTab.id, { type: "capture-trigger" });
    } catch (_) {}
    window.close();
  });

  // --- Delete confirmation ---

  async function deleteLocally(key, idx) {
    const r2 = await chrome.storage.local.get(key);
    const saved = r2[key] || [];
    saved.splice(idx, 1);
    await chrome.storage.local.set({ [key]: saved });
    renderTriggers();
  }

  async function workerPost(body) {
    const codeKey = contributorCodeKey(active.gameId, active.profileId);
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

  function showDeleteConfirm(row, trigger, idx, key) {
    const name = (trigger.payloads?.[0]?.title || trigger.payloads?.[0]?.text || trigger.id);

    const confirmRow = document.createElement("div");
    confirmRow.className = "trigger-row";
    confirmRow.style.cssText = "flex-direction:column;align-items:flex-start;gap:6px;";

    const msg = document.createElement("div");
    msg.style.cssText = "font-size:11px;color:#efeff1;";
    msg.textContent = `Delete "${name}"?`;
    confirmRow.appendChild(msg);

    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "delete-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => row.parentNode.replaceChild(row, confirmRow);

    const localBtn = document.createElement("button");
    localBtn.className = "delete-btn";
    localBtn.textContent = "Delete locally";
    localBtn.onclick = () => deleteLocally(key, idx);

    btns.appendChild(cancelBtn);
    btns.appendChild(localBtn);
    confirmRow.appendChild(btns);

    row.parentNode.replaceChild(confirmRow, row);
  }

  // --- Contributor status ---
  async function renderContributorStatus() {
    const trustedEl  = document.getElementById("contributor-trusted");
    const prEl       = document.getElementById("contributor-pr");
    const codeHintEl = document.getElementById("contributor-code-hint");
    const codeClearEl = document.getElementById("contributor-clear");
    const codeInput  = document.getElementById("contributor-code-input");
    const codeSaveBtn = document.getElementById("contributor-code-save");
    const codeNote   = document.getElementById("contributor-code-note");

    const codeKey = contributorCodeKey(active.gameId, active.profileId);
    const stored  = await chrome.storage.local.get(codeKey);
    const code    = stored[codeKey] || null;

    if (code) {
      trustedEl.style.display = "block";
      prEl.style.display = "none";
      codeHintEl.textContent = `(${code.replace(/-/g, "").slice(0, 8)}…)`;
      codeClearEl.onclick = async (e) => {
        e.preventDefault();
        await chrome.storage.local.remove(codeKey);
        renderContributorStatus();
      };
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
            body: JSON.stringify({ gameId: active.gameId, profileId: active.profileId, mode: "verify" }),
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

    const key = userTriggersKey(gId, pId);
    const res = await chrome.storage.local.get(key);
    const triggers = res[key] || [];

    if (triggers.length === 0) {
      const note = document.createElement("div");
      note.className = "empty-note";
      note.textContent = "No saved triggers yet.";
      listEl.appendChild(note);
      return;
    }

    triggers.forEach((trigger, idx) => {
      const first = (trigger.payloads || [])[0] || {};
      const label = first.title || first.text || trigger.id;
      const extras = (trigger.payloads || []).length - 1;

      const row = document.createElement("div");
      row.className = "trigger-row";

      const labelEl = document.createElement("div");
      labelEl.className = "trigger-label";
      labelEl.textContent = label;
      if (extras > 0) {
        const sm = document.createElement("small");
        sm.textContent = `+${extras} more`;
        labelEl.appendChild(sm);
      }

      const delBtn = document.createElement("button");
      delBtn.className = "delete-btn";
      delBtn.textContent = "Delete";
      delBtn.onclick = () => showDeleteConfirm(row, trigger, idx, key);

      row.appendChild(labelEl);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  renderTriggers();
  renderContributorStatus();
})();
