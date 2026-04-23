# Stream Genie — pre-alpha (v0.6.5)

Hover-to-reveal overlays for Twitch streams. Point your cursor at something on screen — a card, a relic, a UI icon — and a popup tells you what it is. No streamer setup required; it all runs in your browser.

> **Pre-alpha:** Profiles exist for Slay the Spire 2. Everything else is rough edges.

## Install

1. Download **[stream-genie-pre-alpha.zip](https://github.com/frothydv/streamGenie/releases/latest)** and unzip it anywhere.
2. In Chrome, go to `chrome://extensions/` and enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the unzipped `extension/` folder.
4. The Stream Genie icon appears in your toolbar.

## Using it

1. Open a Twitch stream. Stream Genie auto-detects the game from the Twitch category.
2. Click the toolbar icon to confirm the active profile or switch games/profiles.
3. Hover over things in the video. If a match is found, a popup appears near your cursor.
4. Move your cursor away and the popup disappears.

**Keyboard shortcut:** Alt+Shift+C opens the trigger capture editor (for contributors).

## Contributing triggers

Anyone can contribute. Stream Genie sends your contributions as GitHub pull requests, which the profile owner can review and merge.

**If you have a contributor code** (shared by the profile owner), your submissions go directly — no PR needed.

To add a trigger:
1. Click **+ Contribute a Trigger** in the popup while watching a stream.
2. A frame freezes. Drag a box around the thing you want to annotate.
3. Fill in the title and description, then click **Submit to Profile**.

If you have a code, paste it in the **Contributor Status** section of the popup.

## For profile owners

When you create a new profile via the popup, you receive a **contributor code**. Share it with people you trust to submit directly.

Your contributors' PRs (from untrusted users) appear at:  
[github.com/frothydv/streamGenieProfiles/pulls](https://github.com/frothydv/streamGenieProfiles/pulls)

## Updating

To update to a newer version:

1. Download the new zip from [Releases](https://github.com/frothydv/streamGenie/releases).
2. Unzip it, replacing the old folder.
3. Go to `chrome://extensions/`, find **Stream Genie (pre-alpha)**, and click the reload icon (↺).

You do **not** need to remove and reinstall — reload is enough. Your saved profiles and contributor codes are preserved in Chrome storage.

## Supported games

| Game | Profile | Status |
|------|---------|--------|
| Slay the Spire 2 | community | Active |

More games and profiles can be added by anyone — see [Contributing triggers](#contributing-triggers) above.

## Known limitations
- **Matching resolution:** Matching works best at 1080p. At 720p some small UI elements may miss; at 480p and below most small elements won't match.
- **Sync delay:** The extension caches profiles for **2 minutes**. If someone merges a change to the GitHub repository, it may take up to 2 minutes (plus CDN propagation time) for other users to see it automatically. Refreshing the page will fetch the latest if the cache is older than 2 minutes.
- **Debug panel:** The debug panel (top-right) is visible on all Twitch pages. Toggle it with the hotkey or ignore it.
- **Browser support:** Chrome only for now. Firefox support is planned.
