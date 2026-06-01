/**
 * Phase 2 e2e tests — content script runs on YouTube without errors,
 * discovers video, handles coordinate math, skips Twitch-specific logic.
 *
 * Run:  npm run test:e2e
 *   or: npm run test:e2e:headed   (visible browser window)
 *
 * Prerequisite: npx playwright install chromium
 *
 * Note: These tests use manual profile interception (no real CDN calls).
 * The YouTube test page is served at https://www.youtube.com/watch?v=test123
 * via Playwright route interception. The content script injects because
 * the manifest matches https://*.youtube.com/*.
 */

const { test, expect } = require('@playwright/test');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  launchWithExtension,
  setupProfileRoute,
  openTestPage,
  openYouTubeTestPage,
  getServiceWorker,
  showDebugPanel,
  VALID_PROFILE,
} = require('./helpers');

const YT_FIXTURE_PAGE = fs.readFileSync(
  path.join(__dirname, 'fixtures/youtube-page.html'), 'utf8'
);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-'));
}

// ─── Test 1: Content script loads on YouTube ─────────────────────────────

test('content script loads on YouTube pages with correct platform', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    // Create page + set up console listener before navigation so we capture early logs
    const page = await context.newPage();
    const logs = [];
    page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }));

    await page.route('https://www.youtube.com/watch?v=test123', route =>
      route.fulfill({ contentType: 'text/html', body: YT_FIXTURE_PAGE })
    );
    await setupProfileRoute(page, VALID_PROFILE);
    await page.goto('https://www.youtube.com/watch?v=test123');

    // Verify content script initialized (dataset exposed to main world)
    await page.waitForFunction(() =>
      document.documentElement.dataset.streamGenieLoaded === "true",
      { timeout: 5000 }
    );

    // Verify loaded log mentions YouTube
    const loadLog = logs.find(l => l.text.includes('[overlay/content] loaded on'));
    expect(loadLog).toBeTruthy();
    expect(loadLog.text).toContain('youtube.com');

    // Verify no Twitch-specific errors appear after multiple heartbeats
    // (heartbeat runs every 500ms and used to call detectTwitchGame + maybeShowExtensionWarning)
    await page.waitForTimeout(2000);

    const twitchLogs = logs.filter(l =>
      l.text.includes('ext-twitch') ||
      l.text.includes('stream-game-link') ||
      l.text.includes('Extension Interference') ||
      l.text.includes('enableTwitchExtensions')
    );
    expect(twitchLogs.length).toBe(0);
  } finally {
    await context.close();
  }
});

// ─── Test 2: Video discovered on YouTube ─────────────────────────────────

test('findBestVideo discovers YouTube video element', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openYouTubeTestPage(context, VALID_PROFILE);

    // findBestVideo stores results on window.__streamOverlayStats
    await page.waitForFunction(
      () => document.documentElement.dataset.streamGenieAttached === "true",
      { timeout: 5000 }
    );

    const total = await page.evaluate(
      () => parseInt(document.documentElement.dataset.streamGenieVideoTotal || "0")
    );
    const visible = await page.evaluate(
      () => parseInt(document.documentElement.dataset.streamGenieVideoVisible || "0")
    );
    expect(total).toBeGreaterThanOrEqual(1);
    expect(visible).toBeGreaterThanOrEqual(1);
  } finally {
    await context.close();
  }
});

// ─── Test 3: No Twitch extension code path runs on YouTube ────────────────

test('Twitch extension interference code never executes on YouTube', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await context.newPage();
    const logs = [];
    page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }));

    await page.route('https://www.youtube.com/watch?v=test123', route =>
      route.fulfill({ contentType: 'text/html', body: YT_FIXTURE_PAGE })
    );
    await setupProfileRoute(page, VALID_PROFILE);
    await page.goto('https://www.youtube.com/watch?v=test123');

    await page.waitForFunction(() =>
      document.documentElement.dataset.streamGenieLoaded === "true",
      { timeout: 5000 }
    );
    // Wait several heartbeats to ensure any periodic Twitch code would have fired
    await page.waitForTimeout(3000);

    // detectTwitchExtensions hunts "ext-twitch.tv" iframes — verify it never ran
    const extIframeLogs = logs.filter(l =>
      l.text.includes('ext-twitch') ||
      l.text.includes('enableTwitchExtensions') ||
      l.text.includes('disableTwitchExtensions')
    );
    expect(extIframeLogs.length).toBe(0);

    // detectTwitchGame scrapes [data-a-target="stream-game-link"] — verify it never ran
    const gameDetectLogs = logs.filter(l =>
      l.text.includes('[overlay/content] game detected')
    );
    expect(gameDetectLogs.length).toBe(0);
  } finally {
    await context.close();
  }
});

// ─── Test 4: Debug panel coordinates update on hover ──────────────────────

test('debug panel shows capture coordinates when hovering over YouTube video', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openYouTubeTestPage(context, VALID_PROFILE);

    // Wait for video to be attached
    await page.waitForFunction(
      () => document.documentElement.dataset.streamGenieAttached === "true",
      { timeout: 5000 }
    );

    // Enable debug panel
    await showDebugPanel(context, page);

    // Verify debug panel is visible and shows initial status
    await expect(page.locator('#stream-overlay-debug')).toBeVisible();

    // Hover over the video element — coordinates should appear in debug panel
    const video = page.locator('video#test-video');
    await video.hover({ force: true });
    await page.waitForTimeout(500);

    // The debug panel info should contain coordinate data from the mouse handler
    const debugText = await page.locator('#stream-overlay-debug').innerText();
    expect(debugText).toContain('video');
  } finally {
    await context.close();
  }
});

// ─── Test 5: Regression — Twitch pages still work ────────────────────────

test('Twitch pages still load and work normally (regression)', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openTestPage(context, VALID_PROFILE);

    // Wait for content script to load
    await page.waitForFunction(() =>
      document.documentElement.dataset.streamGenieLoaded === "true",
      { timeout: 5000 }
    );

    // Wait for video attachment
    await page.waitForFunction(
      () => document.documentElement.dataset.streamGenieAttached === "true",
      { timeout: 5000 }
    );

    // Enable debug panel and verify it works
    await showDebugPanel(context, page);
    await expect(page.locator('#stream-overlay-debug')).toBeVisible();
  } finally {
    await context.close();
  }
});
