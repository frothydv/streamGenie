// Background service worker.
// In Manifest V3 this replaces the old persistent background page.
// It wakes up for events and goes to sleep otherwise.

console.log("[overlay/bg] service worker started");

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[overlay/bg] installed:", details.reason);
});

// Hotkey handler. Registered in manifest under "commands".
// For now just logs; milestone 7 will wire this to the capture flow.
chrome.commands.onCommand.addListener(async (command) => {
  console.log("[overlay/bg] command received:", command);

  if (command === "capture-trigger") {
    // Forward to the active Twitch tab, if any.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes("twitch.tv")) {
      chrome.tabs.sendMessage(tab.id, { type: "capture-trigger" }).catch((err) => {
        // Content script may not be loaded on this page; that's fine for now.
        console.log("[overlay/bg] no listener in tab:", err.message);
      });
    } else {
      console.log("[overlay/bg] active tab is not Twitch; ignoring hotkey");
    }
  }
});
