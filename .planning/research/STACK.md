# Research: YouTube Support for Stream Genie

## Video Discovery on YouTube

### Key Finding: `findBestVideo()` is already platform-agnostic

The existing `findBestVideo()` function uses `document.querySelectorAll("video")`, filters by visible size, and picks the largest. This works on YouTube without changes.

**YouTube video element details:**
- Primary video element: `video.html5-main-video` — the `<video>` element behind the YouTube player
- YouTube uses a single main video element. No hidden preloaders like Twitch.
- The element is a standard HTML5 `<video>` with proper `videoWidth`/`videoHeight` metadata.
- **No `object-fit: contain`** — YouTube uses `object-fit: initial` (stretch to fill), so the letterbox math in `clientToVideoCoords()` may need adjustment. YouTube letterboxes by setting the element to a specific aspect ratio rather than using CSS `object-fit`.

### YouTube SPA Navigation

YouTube's SPA (Single Page Application) navigation works differently from Twitch's:
- URL changes from `/watch?v=XXXX` to another `/watch?v=YYYY` without full page reload
- The `<video>` element is **replaced** on new video navigation (new element, new reference)
- The page doesn't fire `popstate` for same-site navigation — YouTube intercepts clicks and uses its own navigation
- `location.href` changes when URL changes

**Implication:** The existing heartbeat that checks `location.href !== lastUrl` will catch YouTube SPA navigation. However, since the `<video>` element is replaced, `findBestVideo()` needs to pick up the new element — which it does on each heartbeat tick.

### Video Size/Dimensions

- YouTube's video player container: `#movie_player` or `#player-container`
- The `<video>` element's dimensions match the visible player area (no black bars in the element itself)
- YouTube handles aspect ratio by sizing the container, not using `object-fit` on the video
- This means `clientToVideoCoords()` may need a different letterbox handling path for YouTube

## Game Detection on YouTube

### No game category system

Unlike Twitch, YouTube has no official game category accessible from the video page DOM. Options for title-based detection:

**Video title location:**
- `document.querySelector('h1 yt-formatted-string.ytd-video-primary-info-renderer')` — the main video title
- `document.title` — browser tab title (includes channel name)
- Meta tags: `<meta itemprop="name" content="...">`

**Channel/livestream indicators:**
- Live streams have `yt-icon.ytd-badge-supported-renderer` with a "LIVE" badge
- For gaming live streams, the title often contains game name in brackets or at the start
- Gaming-specific tabs: `/gaming` URLs

**Title matching approach:**
- Extract title from `h1 yt-formatted-string` element
- Normalize: lowercase, strip punctuation
- Against catalog game names (already have `catalog.gameName` for each game)
- Simple substring match first, then fuzzy (Levenshtein/dice coefficient) fallback
- Show detected game in popup with "change" option

## Manifest & Permissions

- Content script injection: YouTube uses `*.youtube.com/*` — but content scripts also run on subdomains like `music.youtube.com`, `www.youtube.com`
- YouTube's video pages are at `https://www.youtube.com/watch?v=XXXX`
- Host permissions: `https://*.youtube.com/*` is sufficient

## Platform Detection Strategy

The simplest approach: check `location.hostname` in the content script.
- `includes("twitch.tv")` → use Twitch-specific logic
- `includes("youtube.com")` → use YouTube-specific logic

This branching can be done with a single helper:

```js
const PLATFORM = (() => {
  const h = location.hostname;
  if (h.includes("twitch.tv")) return "twitch";
  if (h.includes("youtube.com")) return "youtube";
  return "unknown";
})();
```

## Popup Status

- YouTube tab URL pattern: `https://www.youtube.com/watch?v=XXXX` or `https://www.youtube.com/live/XXXX`
- Status format: "Active on YouTube: [video title]" or "Not on a supported platform."
- Popup game detection: send `get-video-info` message to content script → content script returns video title from DOM

## Risk Areas

1. **YouTube DOM is volatile** — Google frequently updates the YouTube UI. Selectors like `h1 yt-formatted-string` may break.
2. **YouTube's `<video>` element replacement on SPA nav** — The heartbeat must handle the element being removed and re-added.
3. **`object-fit` behavior difference** — YouTube doesn't use `object-fit: contain` like Twitch. The `clientToVideoCoords()` function may compute wrong video-space coordinates if it applies letterbox math when none exists.
4. **Twitch-specific code must be guarded** — Extension interference detection must not run on YouTube (no `ext-twitch.tv` iframes exist).
5. **Profile catalog uses `twitchSlug`** — Need to rename or dual-key so games can match via name on YouTube.
