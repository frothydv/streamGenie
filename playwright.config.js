const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  workers: 1,    // extension tests must be serial — each gets its own temp profile dir
  reporter: 'list',

  projects: [
    {
      name: 'chromium-extension',
      use: {
        browserName: 'chromium',
        // Extensions require non-headless or --headless=new (Chrome 112+).
        // launchPersistentContext args are set per-test in helpers.js.
      },
    },
  ],
});
