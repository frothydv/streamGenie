// Runs when the toolbar popup opens. Inspects the active tab and reports status.

(async function () {
  const statusEl = document.getElementById("status");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      statusEl.className = "status off";
      statusEl.textContent = "No active tab.";
      return;
    }

    const url = tab.url || "";
    if (url.includes("twitch.tv")) {
      statusEl.className = "status ok";
      statusEl.textContent = "Active on Twitch: " + new URL(url).pathname;
    } else {
      statusEl.className = "status off";
      statusEl.textContent = "Not on Twitch. Navigate to a stream to activate.";
    }
  } catch (err) {
    statusEl.className = "status off";
    statusEl.textContent = "Error: " + err.message;
  }
})();
