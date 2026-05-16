# Research: YouTube Support — Key Findings

## Summary

The pixel pipeline (capture → dHash → match → popup) is already platform-agnostic. No changes needed there.

The YouTube-specific work breaks into four areas:

### 1. Manifest & Permissions (trivial)
Add `*.youtube.com/*` to content_scripts, host_permissions, web_accessible_resources.

### 2. Platform Detection (small)
One helper function checks `location.hostname` → `"twitch"` or `"youtube"`.

### 3. Game Detection (moderate)
Two-stage: title scrape → catalog match → fallback manual. New selector for YouTube video title. Fuzzy matching client-side.

### 4. Twitch-Specific Guards (medium)
- Game detection: `detectTwitchGame()` → only on Twitch
- Extension interference: `detectTwitchExtensions()` → skip on YouTube
- `clientToVideoCoords()` letterbox math → YouTube doesn't use `object-fit: contain`

### Key Risk
YouTube's `object-fit: initial` means the existing letterbox compensation in `clientToVideoCoords()` could misfire. Need to handle this case.
