# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase2-youtube-content-script.spec.js >> content script loads on YouTube pages with correct platform
- Location: tests/e2e/phase2-youtube-content-script.spec.js:40:1

# Error details

```
Error: browserType.launchPersistentContext: Target page, context or browser has been closed
Browser logs:

<launching> /home/dev/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --no-sandbox --disable-extensions-except=/mnt/c/ClaudeCodeProjects/twitch-overlay-sidekick/extension --load-extension=/mnt/c/ClaudeCodeProjects/twitch-overlay-sidekick/extension --no-sandbox --disable-dev-shm-usage --headless=new --user-data-dir=/tmp/sg-e2e-fb1uW1 --remote-debugging-pipe about:blank
<launched> pid=89194
[pid=89194][err] /home/dev/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory
Call log:
  - <launching> /home/dev/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --no-sandbox --disable-extensions-except=/mnt/c/ClaudeCodeProjects/twitch-overlay-sidekick/extension --load-extension=/mnt/c/ClaudeCodeProjects/twitch-overlay-sidekick/extension --no-sandbox --disable-dev-shm-usage --headless=new --user-data-dir=/tmp/sg-e2e-fb1uW1 --remote-debugging-pipe about:blank
  - <launched> pid=89194
  - [pid=89194][err] /home/dev/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory
  - [pid=89194] <gracefully close start>
  - [pid=89194] <kill>
  - [pid=89194] <will force kill>
  - [pid=89194] exception while trying to kill process: Error: kill ESRCH
  - [pid=89194] <process did exit: exitCode=127, signal=null>
  - [pid=89194] starting temporary directories cleanup
  - [pid=89194] finished temporary directories cleanup
  - [pid=89194] <gracefully close end>

```

# Test source

```ts
  1   | /**
  2   |  * Phase 2 e2e tests — content script runs on YouTube without errors,
  3   |  * discovers video, handles coordinate math, skips Twitch-specific logic.
  4   |  *
  5   |  * Run:  npm run test:e2e
  6   |  *   or: npm run test:e2e:headed   (visible browser window)
  7   |  *
  8   |  * Prerequisite: npx playwright install chromium
  9   |  *
  10  |  * Note: These tests use manual profile interception (no real CDN calls).
  11  |  * The YouTube test page is served at https://www.youtube.com/watch?v=test123
  12  |  * via Playwright route interception. The content script injects because
  13  |  * the manifest matches https://*.youtube.com/*.
  14  |  */
  15  | 
  16  | const { test, expect } = require('@playwright/test');
  17  | const os = require('os');
  18  | const path = require('path');
  19  | const fs = require('fs');
  20  | const {
  21  |   launchWithExtension,
  22  |   setupProfileRoute,
  23  |   openTestPage,
  24  |   openYouTubeTestPage,
  25  |   getServiceWorker,
  26  |   showDebugPanel,
  27  |   VALID_PROFILE,
  28  | } = require('./helpers');
  29  | 
  30  | const YT_FIXTURE_PAGE = fs.readFileSync(
  31  |   path.join(__dirname, 'fixtures/youtube-page.html'), 'utf8'
  32  | );
  33  | 
  34  | function tmpDir() {
  35  |   return fs.mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-'));
  36  | }
  37  | 
  38  | // ─── Test 1: Content script loads on YouTube ─────────────────────────────
  39  | 
  40  | test('content script loads on YouTube pages with correct platform', async () => {
> 41  |   const context = await launchWithExtension(tmpDir());
      |                   ^ Error: browserType.launchPersistentContext: Target page, context or browser has been closed
  42  |   try {
  43  |     // Create page + set up console listener before navigation so we capture early logs
  44  |     const page = await context.newPage();
  45  |     const logs = [];
  46  |     page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }));
  47  | 
  48  |     await page.route('https://www.youtube.com/watch?v=test123', route =>
  49  |       route.fulfill({ contentType: 'text/html', body: YT_FIXTURE_PAGE })
  50  |     );
  51  |     await setupProfileRoute(page, VALID_PROFILE);
  52  |     await page.goto('https://www.youtube.com/watch?v=test123');
  53  | 
  54  |     // Verify content script initialized
  55  |     await page.waitForFunction(() => window.__streamOverlayLoaded === true, { timeout: 5000 });
  56  | 
  57  |     // Verify loaded log mentions YouTube
  58  |     const loadLog = logs.find(l => l.text.includes('[overlay/content] loaded on'));
  59  |     expect(loadLog).toBeTruthy();
  60  |     expect(loadLog.text).toContain('youtube.com');
  61  | 
  62  |     // Verify no Twitch-specific errors appear after multiple heartbeats
  63  |     // (heartbeat runs every 500ms and used to call detectTwitchGame + maybeShowExtensionWarning)
  64  |     await page.waitForTimeout(2000);
  65  | 
  66  |     const twitchLogs = logs.filter(l =>
  67  |       l.text.includes('ext-twitch') ||
  68  |       l.text.includes('stream-game-link') ||
  69  |       l.text.includes('Extension Interference') ||
  70  |       l.text.includes('enableTwitchExtensions')
  71  |     );
  72  |     expect(twitchLogs.length).toBe(0);
  73  |   } finally {
  74  |     await context.close();
  75  |   }
  76  | });
  77  | 
  78  | // ─── Test 2: Video discovered on YouTube ─────────────────────────────────
  79  | 
  80  | test('findBestVideo discovers YouTube video element', async () => {
  81  |   const context = await launchWithExtension(tmpDir());
  82  |   try {
  83  |     const page = await openYouTubeTestPage(context, VALID_PROFILE);
  84  | 
  85  |     // findBestVideo stores results on window.__streamOverlayStats
  86  |     await page.waitForFunction(() => window.__streamOverlayStats?.attached === true, { timeout: 5000 });
  87  | 
  88  |     const stats = await page.evaluate(() => window.__streamOverlayStats);
  89  |     expect(stats.attached).toBe(true);
  90  |     expect(stats.total).toBeGreaterThanOrEqual(1);
  91  |     expect(stats.visible).toBeGreaterThanOrEqual(1);
  92  |   } finally {
  93  |     await context.close();
  94  |   }
  95  | });
  96  | 
  97  | // ─── Test 3: No Twitch extension code path runs on YouTube ────────────────
  98  | 
  99  | test('Twitch extension interference code never executes on YouTube', async () => {
  100 |   const context = await launchWithExtension(tmpDir());
  101 |   try {
  102 |     const page = await context.newPage();
  103 |     const logs = [];
  104 |     page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }));
  105 | 
  106 |     await page.route('https://www.youtube.com/watch?v=test123', route =>
  107 |       route.fulfill({ contentType: 'text/html', body: YT_FIXTURE_PAGE })
  108 |     );
  109 |     await setupProfileRoute(page, VALID_PROFILE);
  110 |     await page.goto('https://www.youtube.com/watch?v=test123');
  111 | 
  112 |     await page.waitForFunction(() => window.__streamOverlayLoaded === true, { timeout: 5000 });
  113 |     // Wait several heartbeats to ensure any periodic Twitch code would have fired
  114 |     await page.waitForTimeout(3000);
  115 | 
  116 |     // detectTwitchExtensions hunts "ext-twitch.tv" iframes — verify it never ran
  117 |     const extIframeLogs = logs.filter(l =>
  118 |       l.text.includes('ext-twitch') ||
  119 |       l.text.includes('enableTwitchExtensions') ||
  120 |       l.text.includes('disableTwitchExtensions')
  121 |     );
  122 |     expect(extIframeLogs.length).toBe(0);
  123 | 
  124 |     // detectTwitchGame scrapes [data-a-target="stream-game-link"] — verify it never ran
  125 |     const gameDetectLogs = logs.filter(l =>
  126 |       l.text.includes('[overlay/content] game detected')
  127 |     );
  128 |     expect(gameDetectLogs.length).toBe(0);
  129 |   } finally {
  130 |     await context.close();
  131 |   }
  132 | });
  133 | 
  134 | // ─── Test 4: Debug panel coordinates update on hover ──────────────────────
  135 | 
  136 | test('debug panel shows capture coordinates when hovering over YouTube video', async () => {
  137 |   const context = await launchWithExtension(tmpDir());
  138 |   try {
  139 |     const page = await openYouTubeTestPage(context, VALID_PROFILE);
  140 | 
  141 |     // Wait for video to be attached
```