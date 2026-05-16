/**
 * E2E tests for Phase 13 — first-run banner privacy link.
 *
 * Run:  npx playwright test tests/e2e/privacy-disclosure.spec.js
 *   or: npm run test:e2e
 *
 * Opens the extension popup directly via chrome-extension://{id}/popup.html,
 * clears the first-run storage key so the banner is visible, then asserts
 * the "Privacy →" link attributes and the dismiss flow.
 *
 * Prerequisite: npx playwright install chromium
 */

const { test, expect } = require('@playwright/test');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { launchWithExtension, getServiceWorker } = require('./helpers');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-privacy-'));
}

/** Derive the extension ID from the service worker URL. */
async function getExtensionId(context) {
  const worker = await getServiceWorker(context);
  return new URL(worker.url()).hostname;
}

/**
 * Open the popup page with the first-run banner forced visible.
 * Clears streamGenie_first_run_seen from chrome.storage.local via the
 * service worker, then navigates to popup.html and returns the page.
 */
async function openPopupWithBanner(context) {
  const worker = await getServiceWorker(context);
  await worker.evaluate(() =>
    chrome.storage.local.remove('streamGenie_first_run_seen')
  );

  const extId = await getExtensionId(context);
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup.html`);

  // Banner is rendered async after chrome.storage.local.get resolves.
  await popupPage.waitForSelector('#first-run-banner', { state: 'visible', timeout: 4000 });
  return popupPage;
}

// ─── Test 1: Privacy link present with correct attributes ─────────────────────

test('first-run banner shows Privacy link with correct href and security attributes', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const popup = await openPopupWithBanner(context);
    const link = popup.locator('#first-run-banner a[href*="streamGenie/privacy"]');

    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://frothydv.github.io/streamGenie/privacy');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveText('Privacy →');
  } finally {
    await context.close();
  }
});

// ─── Test 2: Privacy link is inside the flex:1 text container ─────────────────
// Regression guard: the link must be a child of the text div, not outside the
// banner or next to the dismiss button.

test('Privacy link is inside the banner text div, not adjacent to dismiss button', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const popup = await openPopupWithBanner(context);

    // The link must be a descendant of the first flex:1 child of the banner,
    // which is the div containing the banner text. The dismiss button is a
    // sibling of that div, not a child.
    const linkInsideText = popup.locator(
      '#first-run-banner > div:first-child a[href*="streamGenie/privacy"]'
    );
    await expect(linkInsideText).toBeVisible();

    // Dismiss button must still be a direct child of the banner (not moved).
    const dismissBtn = popup.locator('#first-run-banner > #first-run-dismiss');
    await expect(dismissBtn).toBeVisible();
  } finally {
    await context.close();
  }
});

// ─── Test 3: Dismiss still works after privacy link was added ─────────────────

test('"Got it" dismiss hides the banner and the privacy link with it', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const popup = await openPopupWithBanner(context);

    // Banner and link both visible before dismiss.
    await expect(popup.locator('#first-run-banner')).toBeVisible();
    await expect(popup.locator('#first-run-banner a[href*="streamGenie/privacy"]')).toBeVisible();

    await popup.locator('#first-run-dismiss').click();

    // Banner hidden after dismiss (not just the link).
    await expect(popup.locator('#first-run-banner')).toBeHidden();
  } finally {
    await context.close();
  }
});

// ─── Test 4: Banner stays gone on popup reopen after dismiss ──────────────────

test('banner does not reappear after dismiss when popup is reopened', async () => {
  const context = await launchWithExtension(tmpDir());
  try {
    const popup = await openPopupWithBanner(context);
    await popup.locator('#first-run-dismiss').click();
    await expect(popup.locator('#first-run-banner')).toBeHidden();

    // Reopen popup (simulate closing and re-clicking the toolbar icon).
    const extId = await getExtensionId(context);
    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extId}/popup.html`);
    // Give the async storage.get time to resolve.
    await popup2.waitForTimeout(800);

    await expect(popup2.locator('#first-run-banner')).toBeHidden();
  } finally {
    await context.close();
  }
});
