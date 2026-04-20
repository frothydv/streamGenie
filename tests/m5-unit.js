#!/usr/bin/env node
// Unit tests for M5 game-detection logic — no browser required.
// Run with: node tests/m5-unit.js

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(a, b) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---------------------------------------------------------------------------
// Slug extraction — mirrors detectTwitchGame() in content.js
// ---------------------------------------------------------------------------

function extractSlug(href) {
  const m = href.match(/\/directory\/(?:category|game)\/([^/?#]+)/);
  if (!m) return null;
  return decodeURIComponent(m[1]);
}

console.log("\n— Slug extraction ---");

test("category path returns slug", () => {
  assertEqual(extractSlug("/directory/category/slay-the-spire-2"), "slay-the-spire-2");
});

test("game path returns slug", () => {
  assertEqual(extractSlug("/directory/game/slay-the-spire-2"), "slay-the-spire-2");
});

test("URL-encoded slug is decoded", () => {
  assertEqual(extractSlug("/directory/category/Slay%20the%20Spire%202"), "Slay the Spire 2");
});

test("query params are not included in slug", () => {
  assertEqual(extractSlug("/directory/category/foo?ref=nav"), "foo");
});

test("hash fragment is not included in slug", () => {
  assertEqual(extractSlug("/directory/category/foo#anchor"), "foo");
});

test("absolute URL works too", () => {
  assertEqual(extractSlug("https://www.twitch.tv/directory/category/minecraft"), "minecraft");
});

test("non-matching path returns null", () => {
  assertEqual(extractSlug("/some/other/path"), null);
});

test("empty string returns null", () => {
  assertEqual(extractSlug(""), null);
});

test("slug with hyphens and numbers preserved", () => {
  assertEqual(extractSlug("/directory/category/slay-the-spire-2"), "slay-the-spire-2");
});

// ---------------------------------------------------------------------------
// Auto-select logic — mirrors popup.js selectedGameId
// ---------------------------------------------------------------------------

console.log("\n— Auto-select logic ---");

function selectedGameId(detectedSlug, activeGameId) {
  return detectedSlug || activeGameId;
}

test("detected slug takes priority over stored", () => {
  assertEqual(selectedGameId("minecraft", "slay-the-spire-2"), "minecraft");
});

test("falls back to stored when no detection", () => {
  assertEqual(selectedGameId(null, "slay-the-spire-2"), "slay-the-spire-2");
});

test("falls back to stored when detection is empty string", () => {
  assertEqual(selectedGameId("", "slay-the-spire-2"), "slay-the-spire-2");
});

test("uses detected slug when stored is also set to same value", () => {
  assertEqual(selectedGameId("slay-the-spire-2", "slay-the-spire-2"), "slay-the-spire-2");
});

// ---------------------------------------------------------------------------
// Catalog badge message — mirrors popup.js detected-game text logic
// ---------------------------------------------------------------------------

console.log("\n— Catalog badge message ---");

const CATALOG = [
  { gameId: "slay-the-spire-2", gameName: "Slay the Spire 2" },
  { gameId: "minecraft",        gameName: "Minecraft" },
];

function badgeText(detectedSlug, catalog) {
  if (!detectedSlug) return null;
  const match = catalog.find(g => g.gameId === detectedSlug);
  return match
    ? "✓ Auto-detected from stream"
    : `Detected: ${detectedSlug} (no profile yet)`;
}

test("known game shows auto-detected message", () => {
  assertEqual(badgeText("slay-the-spire-2", CATALOG), "✓ Auto-detected from stream");
});

test("unknown game shows slug + no-profile message", () => {
  assertEqual(badgeText("some-unknown-game", CATALOG), "Detected: some-unknown-game (no profile yet)");
});

test("null slug returns null (badge hidden)", () => {
  assertEqual(badgeText(null, CATALOG), null);
});

test("empty catalog with known slug shows no-profile message", () => {
  assertEqual(badgeText("slay-the-spire-2", []), "Detected: slay-the-spire-2 (no profile yet)");
});

// ---------------------------------------------------------------------------
// SPA navigation reset — detectedGame should clear on URL change
// ---------------------------------------------------------------------------

console.log("\n— SPA navigation reset ---");

test("URL change nulls detected game", () => {
  let detectedGame = { name: "Slay the Spire 2", slug: "slay-the-spire-2" };
  let lastUrl = "https://www.twitch.tv/calpey";
  const newUrl = "https://www.twitch.tv/some_other_streamer";

  if (newUrl !== lastUrl) {
    lastUrl = newUrl;
    detectedGame = null;
  }

  assert(detectedGame === null, "detectedGame should be null after URL change");
  assertEqual(lastUrl, newUrl);
});

test("same URL does not reset detected game", () => {
  let detectedGame = { name: "Slay the Spire 2", slug: "slay-the-spire-2" };
  const url = "https://www.twitch.tv/calpey";
  let lastUrl = url;

  if (url !== lastUrl) {
    detectedGame = null;
  }

  assert(detectedGame !== null, "detectedGame should not be reset on same URL");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
