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
    await waitForProfileCycle(page);

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
    await waitForProfileCycle(page);

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
    await waitForProfileCycle(page);

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

test('Popup shows red error note near profile selector when CDN fails with no cache', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    // Load the Twitch test page with CDN blocked so content.js sets profileLoadError.
    const page = await openTestPage(context, 'fail');
    await waitForProfileCycle(page);

    // Bring the test page to the front (popup queries the active tab).
    await page.bringToFront();

    // Get extension ID from service worker and open popup.
    const worker = await getServiceWorker(context);
    const extensionId = worker.url().split('/')[2];
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

    // Wait for popup's async init (get-game message + catalog fetch).
    await popupPage.waitForTimeout(2500);

    const applyNote  = popupPage.locator('#apply-note');
    const noteText   = await applyNote.innerText();
    const noteColor  = await applyNote.evaluate(el => el.style.color);

    expect(noteText).toMatch(/profile failed to load/i);
    expect(noteColor).toBe('rgb(255, 92, 92)'); // #ff5c5c
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
