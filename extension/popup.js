// Runs when the toolbar popup opens.

const USER_TRIGGERS_KEY = "streamGenie_user_triggers_v1";

(async function () {
  const statusEl = document.getElementById("status");
  const listEl   = document.getElementById("triggers-list");

  // Tab status
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
      statusEl.textContent = "Not on Twitch. Navigate to a stream to activate.";
    }
  } catch (err) {
    statusEl.className = "status off";
    statusEl.textContent = "Error: " + err.message;
  }

  // Saved triggers list
  async function renderTriggers() {
    listEl.innerHTML = "";
    const result = await chrome.storage.local.get(USER_TRIGGERS_KEY);
    const triggers = result[USER_TRIGGERS_KEY] || [];

    if (triggers.length === 0) {
      const note = document.createElement("div");
      note.className = "empty-note";
      note.textContent = "No saved triggers yet.";
      listEl.appendChild(note);
      return;
    }

    triggers.forEach((trigger, idx) => {
      const firstPayload = (trigger.payloads || [])[0] || {};
      const label = firstPayload.title || firstPayload.text || trigger.id;
      const extraCount = (trigger.payloads || []).length - 1;

      const row = document.createElement("div");
      row.className = "trigger-row";

      const labelEl = document.createElement("div");
      labelEl.className = "trigger-label";
      labelEl.textContent = label;
      if (extraCount > 0) {
        const small = document.createElement("small");
        small.textContent = `+${extraCount} more`;
        labelEl.appendChild(small);
      }

      const delBtn = document.createElement("button");
      delBtn.className = "delete-btn";
      delBtn.textContent = "Delete";
      delBtn.onclick = async () => {
        const r = await chrome.storage.local.get(USER_TRIGGERS_KEY);
        const saved = r[USER_TRIGGERS_KEY] || [];
        saved.splice(idx, 1);
        await chrome.storage.local.set({ [USER_TRIGGERS_KEY]: saved });
        renderTriggers();
      };

      row.appendChild(labelEl);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  renderTriggers();
})();
