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
      { id: "community", name: "STS2 Community", verified: true, url: DEFAULT_PROFILE.url },
    ],
  },
];

const userTriggersKey     = (gId, pId) => `streamGenie_triggers_${gId}_${pId}`;
const modifiedTriggersKey = (gId, pId) => `streamGenie_modified_${gId}_${pId}`;
const contributorCodeKey  = (gId, pId) => `streamGenie_code_${gId}_${pId}`;

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
    const res = await fetch(CATALOG_URL, { cache: "no-cache" });
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

  // Always apply FALLBACK_CATALOG overrides — twitchSlug and verified are authoritative
  // here so CDN cache staleness never breaks matching or badge display.
  for (const fallback of FALLBACK_CATALOG) {
    const existing = CATALOG.find(g => g.gameId === fallback.gameId);
    if (!existing) continue;
    if (fallback.twitchSlug) existing.twitchSlug = fallback.twitchSlug;
    for (const fp of fallback.profiles) {
      const ep = existing.profiles.find(p => p.id === fp.id);
      if (ep && fp.verified !== undefined) ep.verified = fp.verified;
    }
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
  gameSelect.addEventListener("change", () => { rebuildProfileSelect(); renderTriggers(); renderContributorStatus(); });
  profileSelect.addEventListener("change", () => { renderTriggers(); renderContributorStatus(); });

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

    const gId = gameSelect.value || active.gameId;
    const pId = profileSelect.value || active.profileId;
    const codeKey = contributorCodeKey(gId, pId);
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

    // Get local triggers (only show actual user-created triggers)
    const uKey = userTriggersKey(gId, pId);
    const mKey = modifiedTriggersKey(gId, pId);
    const res = await chrome.storage.local.get([uKey, mKey]);
    
    const localTriggers = (res[uKey] || []).filter(t => t.id && t.id.startsWith("user-"));
    const modifiedTriggers = res[mKey] || [];

    // Load remote profile triggers
    let remoteTriggers = [];
    try {
      if (prof?.url) {
        const profileRes = await fetch(prof.url, { cache: "no-cache" });
        if (profileRes.ok) {
          const profileData = await profileRes.json();
          remoteTriggers = profileData.triggers || [];
        }
      }
    } catch (err) {
      console.warn("[overlay/popup] Failed to load remote profile:", err);
    }

    // Combine all triggers:
    // 1. Profile triggers (overridden by local modifications if they exist)
    const mergedRemote = remoteTriggers.map(rt => {
      const mod = modifiedTriggers.find(mt => mt.id === rt.id);
      return mod ? { ...mod, source: "profile", _isModified: true } : { ...rt, source: "profile" };
    });

    // 2. User-created triggers
    const allTriggers = [
      ...mergedRemote,
      ...localTriggers.map(t => ({ ...t, source: "local" }))
    ];

    if (allTriggers.length === 0) {
      const note = document.createElement("div");
      note.className = "empty-note";
      note.textContent = "No triggers found.";
      listEl.appendChild(note);
      return;
    }

    allTriggers.forEach((trigger, idx) => {
      const first = (trigger.payloads || [])[0] || {};
      const label = first.title || first.text || trigger.id;
      const extras = (trigger.payloads || []).length - 1;
      const sourceBadge = trigger.source === "local" ? "[Local]" : "[Profile]";

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

      const sourceEl = document.createElement("small");
      sourceEl.textContent = sourceBadge;
      sourceEl.style.cssText = "color:" + (trigger.source === "local" ? "#00f593" : "#adadb8");

      labelContainer.appendChild(labelEl);
      labelContainer.appendChild(sourceEl);

      const editBtn = document.createElement("button");
      editBtn.className = "edit-btn";
      editBtn.textContent = "Edit";
      editBtn.onclick = () => openTriggerEditorFromPopup(trigger);

      const delBtn = document.createElement("button");
      delBtn.className = "delete-btn";
      delBtn.textContent = "Delete";
      delBtn.style.display = trigger.source === "local" ? "block" : "none";
      delBtn.onclick = () => showDeleteConfirm(row, trigger, localTriggers.indexOf(trigger), key);

      row.appendChild(labelContainer);
      row.appendChild(editBtn);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  renderTriggers();
  renderContributorStatus();

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
