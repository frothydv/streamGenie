# Stream Overlay — development build

Hover-to-reveal overlays for Twitch streams.

## Current milestone: 2 — hover + pixel capture

The extension now:
- Finds the Twitch video player
- Tracks your mouse while it's over the video
- Captures a 160×160 pixel region under your cursor
- Displays the captured region live in a debug panel in the top-right of the page
- Registers Alt+Shift+C as the capture hotkey (still a no-op; reserved for milestone 7)

No matching or popups yet. This milestone is about confirming we can reliably read clean pixels out of the stream.

## Updating your installed extension

1. Go to `chrome://extensions/`
2. Find "Stream Overlay (dev)"
3. Click the **reload** icon (circular arrow) on its card
4. If you point Chrome at a different folder now, use **Load unpacked** and pick the new `extension/` folder

You do **not** need to remove and reinstall — reload is enough.

## Testing milestone 2

**Should take about 2 minutes.**

### 1. Open a Twitch stream

Go to any live stream on Twitch. A stream of a game (anything, doesn't matter which) is ideal — lots of visual variety makes the debug panel more interesting.

### 2. Look for the debug panel

In the top-right corner of the page, under Twitch's own header, you should see a small dark panel labeled **"overlay debug"** with:
- A status line
- A 160×160 black box (the live capture preview)
- Coordinate info

If status says **"no video"** — wait a few seconds for Twitch to fully load, or reload the page.

### 3. Hover over the video

Move your mouse onto the video player. You should see:
- Status changes to **"capturing"** in green
- The 160×160 box fills with live video content — specifically, whatever your cursor is pointing at
- The coordinate info updates continuously:
  - `client` = mouse position on your screen
  - `video` = corresponding position in the video's native resolution
  - `crop` = top-left corner of what we captured
  - `source` = video's native resolution (e.g. 1920×1080)

Move your cursor around the video. The capture preview should track your cursor's position through the video.

### 4. Check quality

Hover over something distinct — a face, a UI element, some text on screen. The preview should show that region legibly. If it's a blurry mess or frozen or blank, something's wrong and I need to know.

### 5. Test SPA navigation (optional but helpful)

While the panel is active, click another stream in Twitch's sidebar. The URL changes without a full page reload. The debug panel should stay attached, re-find the new video, and resume capturing when you hover.

## What to report back

- Does the debug panel appear?
- Does the capture preview show live video when you hover?
- Is the preview quality readable? (Blurry / pixelated is expected at small text, but major objects should be clearly identifiable)
- Do the coordinates change as you move?
- Does it still work after you navigate to a different stream?

**Screenshots of the debug panel in action are enormously helpful** — especially one showing the preview successfully capturing something recognizable.

## Known non-issues

- Twitch's cursor auto-hide over the video is a Twitch feature, not us. We're not fixing it here.
- The debug panel is visible on all Twitch pages including non-stream ones. That's intentional for now (easier to debug). It'll be removed / made toggleable in a later milestone.
- The hotkey Alt+Shift+C fires but does nothing user-visible yet — still just logs to console.

## What's next

Milestone 3: dummy matching. We'll hard-code a single reference image and a single payload. When you hover over the right spot on a stream and our capture matches the reference, a real popup will appear. End-to-end pipeline proven, still with no cloud-loaded profiles.

To make milestone 3 testable, we'll first have you capture a reference image from a real stream using the debug panel — so we have a known-good reference to match against.
