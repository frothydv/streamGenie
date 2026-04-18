// Popup script — profile selection + saved trigger management.

const ACTIVE_PROFILE_KEY = "streamGenie_active_profile";
const DEFAULT_PROFILE = {
  gameId:    "slay-the-spire-2",
  profileId: "community",
  name:      "STS2 Community",
  url:       "https://cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@v1/games/slay-the-spire-2/profiles/community/profile.json",
};

const CATALOG = [
  {
    gameId: "slay-the-spire-2",
    gameName: "Slay the Spire 2",
    profiles: [
      { id: "community", name: "STS2 Community", url: DEFAULT_PROFILE.url },
    ],
  },
];

const userTriggersKey = (gId, pId) => `streamGenie_triggers_${gId}_${pId}`;

(async function () {
  // --- Tab status ---
  const statusEl = document.getElementById("status");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

  // --- Load active profile ---
  const r = await chrome.storage.local.get(ACTIVE_PROFILE_KEY);
  let active = r[ACTIVE_PROFILE_KEY] || DEFAULT_PROFILE;

  // --- Build game selector ---
  const gameSelect    = document.getElementById("game-select");
  const profileSelect = document.getElementById("profile-select");
  const applyBtn      = document.getElementById("apply-btn");
  const applyNote     = document.getElementById("apply-note");

  for (const game of CATALOG) {
    const opt = document.createElement("option");
    opt.value = game.gameId;
    opt.textContent = game.gameName;
    if (game.gameId === active.gameId) opt.selected = true;
    gameSelect.appendChild(opt);
  }

  function rebuildProfileSelect() {
    profileSelect.innerHTML = "";
    const game = CATALOG.find(g => g.gameId === gameSelect.value);
    if (!game) return;
    for (const p of game.profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      if (game.gameId === active.gameId && p.id === active.profileId) opt.selected = true;
      profileSelect.appendChild(opt);
    }
  }

  rebuildProfileSelect();
  gameSelect.addEventListener("change", rebuildProfileSelect);

  applyBtn.addEventListener("click", async () => {
    const game = CATALOG.find(g => g.gameId === gameSelect.value);
    const prof = game && game.profiles.find(p => p.id === profileSelect.value);
    if (!game || !prof) return;
    active = { gameId: game.gameId, profileId: prof.id, name: prof.name, url: prof.url };
    await chrome.storage.local.set({ [ACTIVE_PROFILE_KEY]: active });
    applyNote.textContent = "Reload the Twitch page to activate.";
    applyNote.style.color = "#00f593";
    renderTriggers();
  });

  // --- Saved triggers ---
  async function renderTriggers() {
    const listEl    = document.getElementById("triggers-list");
    const labelEl   = document.getElementById("profile-label");
    labelEl.textContent = active.name;
    listEl.innerHTML = "";

    const key = userTriggersKey(active.gameId, active.profileId);
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
      delBtn.onclick = async () => {
        const r2 = await chrome.storage.local.get(key);
        const saved = r2[key] || [];
        saved.splice(idx, 1);
        await chrome.storage.local.set({ [key]: saved });
        renderTriggers();
      };

      row.appendChild(labelEl);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  renderTriggers();
})();
