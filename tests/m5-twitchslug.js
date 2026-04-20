#!/usr/bin/env node
// Unit tests for twitchSlug catalog matching and delete-PR logic.
// Run with: node tests/m5-twitchslug.js

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
// Catalog matching with twitchSlug — mirrors popup.js catalogMatch logic
// ---------------------------------------------------------------------------

const CATALOG = [
  { gameId: "slay-the-spire-2",            gameName: "Slay the Spire 2",            twitchSlug: "slay-the-spire-ii",              profiles: [] },
  { gameId: "tomodachi-life-living-dream",  gameName: "Tomodachi Life: Living Dream", twitchSlug: "tomodachi-life-living-the-dream", profiles: [] },
  { gameId: "minecraft",                    gameName: "Minecraft",                    twitchSlug: null,                              profiles: [] },
];

function findCatalogMatch(detectedSlug, catalog) {
  if (!detectedSlug) return null;
  return catalog.find(g => g.gameId === detectedSlug || g.twitchSlug === detectedSlug) || null;
}

function resolveSelectedGameId(detectedSlug, catalog, activeGameId) {
  const match = findCatalogMatch(detectedSlug, catalog);
  return match ? match.gameId : activeGameId;
}

console.log("\n— twitchSlug catalog matching ---");

test("STS2: Twitch slug slay-the-spire-ii matches catalog entry", () => {
  const m = findCatalogMatch("slay-the-spire-ii", CATALOG);
  assert(m !== null, "should find match");
  assertEqual(m.gameId, "slay-the-spire-2");
});

test("STS2: direct gameId match still works", () => {
  const m = findCatalogMatch("slay-the-spire-2", CATALOG);
  assert(m !== null, "should find match");
  assertEqual(m.gameId, "slay-the-spire-2");
});

test("Tomodachi Life: long Twitch slug matches", () => {
  const m = findCatalogMatch("tomodachi-life-living-the-dream", CATALOG);
  assert(m !== null, "should find match");
  assertEqual(m.gameId, "tomodachi-life-living-dream");
});

test("Minecraft: no twitchSlug but gameId match works", () => {
  const m = findCatalogMatch("minecraft", CATALOG);
  assert(m !== null, "should find match");
  assertEqual(m.gameId, "minecraft");
});

test("Unknown game returns null", () => {
  assertEqual(findCatalogMatch("some-unknown-game", CATALOG), null);
});

test("null detectedSlug returns null", () => {
  assertEqual(findCatalogMatch(null, CATALOG), null);
});

test("empty string detectedSlug returns null", () => {
  assertEqual(findCatalogMatch("", CATALOG), null);
});

console.log("\n— selectedGameId resolution with twitchSlug ---");

test("STS2 Twitch slug resolves to slay-the-spire-2 gameId", () => {
  assertEqual(resolveSelectedGameId("slay-the-spire-ii", CATALOG, "minecraft"), "slay-the-spire-2");
});

test("Tomodachi slug resolves to correct gameId", () => {
  assertEqual(resolveSelectedGameId("tomodachi-life-living-the-dream", CATALOG, "slay-the-spire-2"), "tomodachi-life-living-dream");
});

test("Unknown slug falls back to active gameId", () => {
  assertEqual(resolveSelectedGameId("no-profile-game", CATALOG, "slay-the-spire-2"), "slay-the-spire-2");
});

test("null slug always falls back to active gameId", () => {
  assertEqual(resolveSelectedGameId(null, CATALOG, "slay-the-spire-2"), "slay-the-spire-2");
});

// ---------------------------------------------------------------------------
// Badge text with twitchSlug
// ---------------------------------------------------------------------------

function badgeText(detectedSlug, catalog) {
  if (!detectedSlug) return null;
  const match = catalog.find(g => g.gameId === detectedSlug || g.twitchSlug === detectedSlug);
  return match
    ? "✓ Auto-detected from stream"
    : `Detected: ${detectedSlug} (no profile yet)`;
}

console.log("\n— Badge text with twitchSlug ---");

test("STS2 via twitchSlug shows auto-detected badge", () => {
  assertEqual(badgeText("slay-the-spire-ii", CATALOG), "✓ Auto-detected from stream");
});

test("Tomodachi via twitchSlug shows auto-detected badge", () => {
  assertEqual(badgeText("tomodachi-life-living-the-dream", CATALOG), "✓ Auto-detected from stream");
});

test("Unknown slug shows no-profile badge with slug name", () => {
  assertEqual(badgeText("some-new-game", CATALOG), "Detected: some-new-game (no profile yet)");
});

// ---------------------------------------------------------------------------
// Worker remove-mode validation — mirrors index.js logic
// ---------------------------------------------------------------------------

function validateRemoveRequest(body) {
  const { gameId, profileId, trigger, mode } = body;
  if (!gameId || !profileId || !trigger) return "Missing required fields";
  if (mode !== "remove" && !trigger.payloads) return "Missing trigger payloads";
  if ((mode === "update" || mode === "remove") && !trigger.id) return `Missing trigger id for ${mode}`;
  return null;
}

console.log("\n— Worker remove-mode validation ---");

test("valid remove request passes", () => {
  assertEqual(validateRemoveRequest({
    gameId: "slay-the-spire-2", profileId: "community",
    trigger: { id: "map-button-123" }, mode: "remove",
  }), null);
});

test("remove without trigger id is rejected", () => {
  const err = validateRemoveRequest({
    gameId: "slay-the-spire-2", profileId: "community",
    trigger: {}, mode: "remove",
  });
  assert(err !== null, "should fail");
  assert(err.includes("trigger id"), `got: ${err}`);
});

test("remove without gameId is rejected", () => {
  const err = validateRemoveRequest({
    profileId: "community", trigger: { id: "map-button" }, mode: "remove",
  });
  assert(err !== null, "should fail");
});

test("add mode still requires payloads", () => {
  const err = validateRemoveRequest({
    gameId: "slay-the-spire-2", profileId: "community",
    trigger: { id: "map-button" }, mode: "add",
  });
  assert(err !== null, "should fail");
  assert(err.includes("payloads"), `got: ${err}`);
});

test("update mode still requires trigger id", () => {
  const err = validateRemoveRequest({
    gameId: "slay-the-spire-2", profileId: "community",
    trigger: { payloads: [{ title: "x" }] }, mode: "update",
  });
  assert(err !== null, "should fail");
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
