# Stream Genie — Chrome Web Store Listing

## Short Description

Hover over anything in a Twitch stream and get instant community-built explanations. No streamer setup. Works with any game.

_(128 chars)_

## Full Description

**Stream Genie turns Twitch streams into living wikis.**

Hover over a card, a relic, an icon — anything the community has annotated — and a popup appears near your cursor explaining what it is. Move away and it disappears. No setup for streamers. No game API. It runs entirely in your browser.

**How it works**

1. Open any Twitch stream. Stream Genie detects the game from the Twitch category.
2. Click the toolbar icon to select a community annotation profile for that game.
3. Hover over items in the video — cards, relics, UI icons, anything annotated.
4. A tooltip appears near your cursor. Move away and it's gone.

**Privacy**

Pixel matching runs locally in your browser using perceptual image hashing. Nothing leaves your device during normal use. The only outbound requests are to download community profiles from GitHub (raw.githubusercontent.com / cdn.jsdelivr.net) and to submit contributions (workers.dev). No analytics. No telemetry. No account required. Pixel processing stays on your device — nothing is transmitted.

**Contributing annotations**

Anyone can add annotations — no setup beyond a GitHub account.

1. While watching a stream, press **Alt+Shift+C** or click **+ Contribute a Trigger** in the popup.
2. The frame freezes. Drag a box around the thing you want to annotate.
3. Fill in a title and description. Click **Submit to Profile**.

Your submission goes to the streamGenieProfiles repository as a pull request. The profile owner reviews and merges it. Once merged, all viewers see your annotation automatically.

**For streamers and game developers**

Profile owners can create and manage annotation sets for their game. Creating a profile generates a contributor code to share with trusted contributors, who can commit directly without a PR step.

**Known limitations**

- Best at 1080p. Small elements may miss at 720p; most small elements skip at 480p and below.
- Profiles cache for 2 minutes. New contributions may take up to 2 minutes to appear.
- Chrome only. Firefox planned post-beta.

_(1,647 chars)_

## Permissions Justification

Stream Genie requests only the permissions needed to run the overlay and load community profiles.

| Permission | Why it's needed |
|---|---|
| `activeTab` | Detect which game you're watching |
| `storage` | Save profile selections and first-run state |
| `https://*.twitch.tv/*` | Run the hover overlay on Twitch pages |
| `https://raw.githubusercontent.com/*` | Download community annotation profiles |
| `https://cdn.jsdelivr.net/*` | Fetch the game catalog |
| `https://*.workers.dev/*` | Submit new trigger contributions |

## Version

v0.9.2
