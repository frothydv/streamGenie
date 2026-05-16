/**
 * E2E tests for Phase 12 error states — CDN failure indicators and schema validation.
 *
 * Run:  npx playwright test tests/e2e/error-states.spec.js
 *   or: npm run test:e2e
 *   or: npm run test:e2e:headed   (visible browser window)
 *
 * Intercepts the profile CDN request with page.route() instead of DevTools network
 * blocking. Asserts on the injected #stream-overlay-debug panel DOM.
 *
 * Prerequisite: npx playwright install chromium
 */

const { test, expect } = require('@playwright/test');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  launchWithExtension,
  openTestPage,
  getServiceWorker,
  showDebugPanel,
  seedProfileCache,
  waitForProfileCycle,
  VALID_PROFILE,
  PROFILE_WITH_BAD_TRIGGER,
  PROFILE_WITH_MISSING_TRIGGERS,
} = require('./helpers');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-'));
}

// ─── Test 1: CDN unreachable + stale cache → amber debug panel ────────────────

test('CDN unreachable with stale cache shows amber debug panel warning', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    // Open with CDN blocked. Seed localStorage before reload so the stale-cache
    // branch in fetchAndCacheProfile() has data to fall back to.
    const page = await openTestPage(context, 'stale-fail');
    await seedProfileCache(page);
    await page.reload();

    await showDebugPanel(context, page);
    // Stale-cache path applies the cached profile (sets refs:) then fires CDN fetch which fails.
    // waitForProfileCycle exits on 'refs:' before profileStaleWarning is set — use explicit waiter.
    await page.waitForFunction(
      () => document.getElementById('stream-overlay-debug')?.innerText.includes('CDN unreachable'),
      { timeout: 8000 }
    );

    const debugText = await page.locator('#stream-overlay-debug').innerText();

    expect(debugText).toContain('CDN unreachable');
    expect(debugText).toContain('using cached profile');
    expect(debugText).not.toContain('profile error');
  } finally {
    await context.close();
  }
});

// ─── Test 2: CDN unreachable + no cache → red debug panel line ────────────────

test('CDN unreachable with no cache shows red profile error in debug panel', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openTestPage(context, 'fail');
    await showDebugPanel(context, page);
    // 'refs: 0/0' renders before the async CDN fail sets profileLoadError — use explicit waiter.
    await page.waitForFunction(
      () => document.getElementById('stream-overlay-debug')?.innerText.includes('profile error'),
      { timeout: 8000 }
    );

    const debugText = await page.locator('#stream-overlay-debug').innerText();

    expect(debugText).toContain('profile error');
    expect(debugText).not.toContain('CDN unreachable');
  } finally {
    await context.close();
  }
});

// ─── Test 3: Fresh fetch clears all warning lines ─────────────────────────────

test('Successful fetch clears amber CDN warning from debug panel', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    // First: fail + stale → amber warning appears.
    const page = await openTestPage(context, 'stale-fail');
    await seedProfileCache(page);
    await page.reload();
    await showDebugPanel(context, page);
    // Wait specifically for the CDN warning — generic poller may exit on 'refs:' before
    // the stale-cache branch sets profileStaleWarning and the panel re-renders.
    await page.waitForFunction(
      () => document.getElementById('stream-overlay-debug')?.innerText.includes('CDN unreachable'),
      { timeout: 8000 }
    );

    const textAfterFail = await page.locator('#stream-overlay-debug').innerText();
    expect(textAfterFail).toContain('CDN unreachable');

    // Re-route CDN to succeed, then reload.
    await page.route('https://raw.githubusercontent.com/**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(VALID_PROFILE),
      })
    );
    await page.reload();
    await waitForProfileCycle(page);

    const textAfterSuccess = await page.locator('#stream-overlay-debug').innerText();
    expect(textAfterSuccess).not.toContain('CDN unreachable');
    expect(textAfterSuccess).not.toContain('profile error');
  } finally {
    await context.close();
  }
});

// ─── Test 4: Popup shows error note when CDN fails with no cache ───────────────

test('content.js get-game response carries profileLoadError when CDN fails with no cache', async () => {
  // Tests the same behaviour the popup reads, but avoids chrome.tabs.query({ active:true })
  // tab-identity issues: the popup window becomes the active tab the moment it opens,
  // so popup.js's currentTab ends up being itself rather than our test page.
  // Instead we send the get-game message directly via the service worker.
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openTestPage(context, 'fail');
    await waitForProfileCycle(page);

    const worker = await getServiceWorker(context);

    // Find our test tab by URL and send get-game directly.
    const resp = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.twitch.tv/teststream' });
      const tabId = tabs[0]?.id;
      if (!tabId) return null;
      return new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, { type: 'get-game' }, r => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      });
    });

    expect(resp).not.toBeNull();
    expect(resp.profileLoadError).toBeTruthy();
    expect(resp.profileLoadError).toMatch(/failed|HTTP|fetch/i);
    expect(resp.profileStaleWarning).toBeNull();
  } finally {
    await context.close();
  }
});

// ─── Test 5: Schema validation — invalid trigger id is skipped ────────────────

test('Profile with numeric trigger id skips it and shows amber schema warning', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openTestPage(context, PROFILE_WITH_BAD_TRIGGER);
    await showDebugPanel(context, page);
    await waitForProfileCycle(page);

    const debugText = await page.locator('#stream-overlay-debug').innerText();

    // Exactly 1 trigger skipped; valid trigger still loaded (refs line not "0/0").
    expect(debugText).toContain('1 trigger(s) skipped');
    expect(debugText).toContain('invalid schema');
    expect(debugText).toContain('(unknown)');
    expect(debugText).not.toContain('0/0');
  } finally {
    await context.close();
  }
});

// ─── Bonus: triggers field is null → structure-error panel line ───────────────

test('Profile where triggers is null shows structure-invalid panel line', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const page = await openTestPage(context, PROFILE_WITH_MISSING_TRIGGERS);
    await showDebugPanel(context, page);
    await waitForProfileCycle(page);

    const debugText = await page.locator('#stream-overlay-debug').innerText();

    expect(debugText).toContain('profile structure invalid');
    expect(debugText).toContain('triggers is not an array');
    expect(debugText).not.toContain('trigger(s) skipped');
  } finally {
    await context.close();
  }
});
