/**
 * Phase 1 e2e test — extension loads and initializes on YouTube pages.
 *
 * Run:  npm run test:e2e
 *   or: npm run test:e2e:headed   (visible browser window)
 *
 * Prerequisite: npx playwright install chromium
 */

const { test, expect } = require('@playwright/test');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { launchWithExtension, openTestPage, openYouTubeTestPage, getServiceWorker, VALID_PROFILE } = require('./helpers');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-'));
}

// ─── Test 1: Content script injected on YouTube ────────────────────────────

test('content script is injected on YouTube pages', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openYouTubeTestPage(context, VALID_PROFILE);

    // Verify the content script's guard marker is set (from the isolated world)
    // and the dataset attribute is exposed to the main world
    const loaded = await page.evaluate(() =>
      document.documentElement.dataset.streamGenieLoaded === "true"
    );
    expect(loaded).toBe(true);
  } finally {
    await context.close();
  }
});

// ─── Test 2: Video element discovered on YouTube ───────────────────────────

test('video element is discovered by findBestVideo on YouTube', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openYouTubeTestPage(context, VALID_PROFILE);

    // findBestVideo runs in the heartbeat (500ms interval) and exposes attach status via dataset
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

// ─── Test 3: Game detection extracts YouTube video title ───────────────────

test('YouTube video title is extractable from page DOM', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openYouTubeTestPage(context, VALID_PROFILE);

    // Manually extract the title from the DOM (as Phase 3 game detection will do)
    const title = await page.evaluate(() => {
      const el = document.querySelector('h1 yt-formatted-string.ytd-video-primary-info-renderer');
      return el ? el.textContent.trim() : null;
    });

    expect(title).toBe('Slay the Spire 2 — First Impressions Gameplay');
  } finally {
    await context.close();
  }
});

// ─── Test 4: Twitch pages still work (regression) ──────────────────────────

test('Twitch pages still load the extension (regression)', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openTestPage(context, VALID_PROFILE);

    const loaded = await page.evaluate(() =>
      document.documentElement.dataset.streamGenieLoaded === "true"
    );
    expect(loaded).toBe(true);
  } finally {
    await context.close();
  }
});
