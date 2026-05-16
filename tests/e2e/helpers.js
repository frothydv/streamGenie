// Shared helpers for Stream Genie e2e tests.
// Requires: @playwright/test, Chromium installed via `npx playwright install chromium`.
//
// Extensions don't run in true headless mode. Use --headless=new (Chrome 112+) or
// set HEADED=1 in the environment. CI: add `--headless=new` to the launch args.

const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '../../extension');
const FIXTURE_PAGE = fs.readFileSync(
  path.join(__dirname, 'fixtures/twitch-page.html'), 'utf8'
);
const YT_FIXTURE_PAGE = fs.readFileSync(
  path.join(__dirname, 'fixtures/youtube-page.html'), 'utf8'
);

// The DEFAULT_PROFILE URL in content.js — intercepted in tests.
const PROFILE_URL =
  'https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/games/slay-the-spire-2/profiles/community/profile.json';

const VALID_PROFILE = {
  triggers: [{
    id: 'map-button',
    payloads: [{ title: 'Map', text: 'Opens the map.', popupOffset: { x: 0, y: 0 }, image: null }],
    references: [{ file: 'map-button.png', w: 95, h: 116, srcW: 1920, srcH: 1080 }],
    rotates: false,
  }],
};

// First trigger has numeric id (fails typeof id === 'string' check).
const PROFILE_WITH_BAD_TRIGGER = {
  triggers: [
    { id: 123, references: [{ file: 'bad.png', w: 10, h: 10 }] },
    {
      id: 'map-button',
      references: [{ file: 'map-button.png', w: 95, h: 116 }],
      payloads: [{ title: 'Map', text: 'Opens the map.', popupOffset: { x: 0, y: 0 }, image: null }],
      rotates: false,
    },
  ],
};

// triggers field is null — triggers the structure-error path.
const PROFILE_WITH_MISSING_TRIGGERS = { triggers: null };

/**
 * Launch Chromium with the extension loaded. Returns a persistent context.
 * Call context.close() in afterAll / finally.
 */
async function launchWithExtension(userDataDir) {
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--headless=new',   // Chrome 112+ headless supports extensions
    ],
  });
}

/**
 * Set up route interception for the profile CDN request.
 * Shared helper used by both Twitch and YouTube page openers.
 */
function setupProfileRoute(page, profileResponse) {
  return page.route('https://raw.githubusercontent.com/**', route => {
    // Content script adds a ?_cb=timestamp cache-buster — strip it before comparing.
    const requestBase = route.request().url().split('?')[0];
    if (requestBase === PROFILE_URL) {
      if (profileResponse === 'fail' || profileResponse === 'stale-fail') {
        route.abort('failed');
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(profileResponse),
        });
      }
    } else {
      route.fulfill({ status: 200, body: '' });
    }
  });
}

/**
 * Open a Twitch-like test page at https://www.twitch.tv/teststream.
 * The content script injects because the URL matches https://*.twitch.tv/*.
 *
 * profileResponse:
 *   object       → fulfilled with that JSON (valid or malformed profile)
 *   'fail'       → network abort (CDN completely unreachable, no cache)
 *   'stale-fail' → network abort (CDN unreachable; caller should seed localStorage cache first)
 */
async function openTestPage(context, profileResponse) {
  const page = await context.newPage();

  await page.route('https://www.twitch.tv/teststream', route =>
    route.fulfill({ contentType: 'text/html', body: FIXTURE_PAGE })
  );

  await setupProfileRoute(page, profileResponse);

  await page.goto('https://www.twitch.tv/teststream');
  return page;
}

/**
 * Open a YouTube test page at https://www.youtube.com/watch?v=test123.
 * The content script injects because the manifest matches https://*.youtube.com/*.
 *
 * profileResponse: same semantics as openTestPage.
 *
 * Use this when you don't need pre-navigation console listeners.
 * For console-sensitive tests, create the page externally:
 *
 *   const page = await context.newPage();
 *   const logs = [];
 *   page.on('console', msg => logs.push(msg));
 *   await page.route('https://www.youtube.com/watch?v=test123', ...);
 *   await setupProfileRoute(page, profileResponse);
 *   await page.goto('https://www.youtube.com/watch?v=test123');
 */
async function openYouTubeTestPage(context, profileResponse) {
  const page = await context.newPage();

  await page.route('https://www.youtube.com/watch?v=test123', route =>
    route.fulfill({ contentType: 'text/html', body: YT_FIXTURE_PAGE })
  );

  await setupProfileRoute(page, profileResponse);

  await page.goto('https://www.youtube.com/watch?v=test123');
  return page;
}

/** Get the extension's service worker. Waits up to 5 s for it to register. */
async function getServiceWorker(context) {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  return context.waitForEvent('serviceworker', { timeout: 5000 });
}

/**
 * Show the debug panel on page by toggling chrome.storage via the service worker.
 * Returns after #stream-overlay-debug is visible.
 */
async function showDebugPanel(context, page) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ streamGenie_debugPanel: true }));
  await page.waitForSelector('#stream-overlay-debug', { state: 'visible', timeout: 5000 });
}

/**
 * Seed localStorage with a valid cached profile so the stale-cache branch
 * has data when the CDN fetch fails.
 */
async function seedProfileCache(page, profile) {
  profile = profile || VALID_PROFILE;
  const cacheKey = 'streamGenie_profile_slay-the-spire-2_community';
  await page.evaluate(function(args) {
    // Use a timestamp older than the 2-minute TTL so loadProfile() goes through
    // fetchAndCacheProfile() synchronously instead of as a background refresh.
    localStorage.setItem(args[0], JSON.stringify({ ts: Date.now() - 200000, profile: args[1] }));
  }, [cacheKey, profile]);
}

/**
 * Poll the debug panel text until it contains a settled state indicator,
 * or give up after timeout ms.
 */
async function waitForProfileCycle(page, timeout) {
  timeout = timeout || 6000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const text = await page.evaluate(function() {
      const el = document.getElementById('stream-overlay-debug');
      return el ? el.innerText : '';
    });
    if (text.includes('refs:') || text.includes('profile error') ||
        text.includes('CDN unreachable') || text.includes('trigger(s) skipped') ||
        text.includes('profile structure invalid')) {
      return;
    }
  }
}

module.exports = {
  EXT_PATH,
  FIXTURE_PAGE,
  PROFILE_URL,
  VALID_PROFILE,
  PROFILE_WITH_BAD_TRIGGER,
  PROFILE_WITH_MISSING_TRIGGERS,
  launchWithExtension,
  setupProfileRoute,
  openTestPage,
  openYouTubeTestPage,
  getServiceWorker,
  showDebugPanel,
  seedProfileCache,
  waitForProfileCycle,
};
