#!/usr/bin/env node
// Unit tests for create-profile mode validation and no-profile banner logic.
// Run with: node tests/m5-create-profile.js

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
// Worker create-profile validation — mirrors index.js dispatch logic
// ---------------------------------------------------------------------------

function validateRequest(body) {
  const { gameId, profileId, trigger, mode = "add", gameName, newProfileId } = body;

  if (mode === "create-profile") {
    if (!gameId || !gameName) return "Missing gameId or gameName for create-profile";
    if (!newProfileId)        return "Missing newProfileId for create-profile";
    return null;
  }
  if (!gameId || !profileId || !trigger) return "Missing required fields";
  if (mode !== "remove" && !trigger.payloads) return "Missing trigger payloads";
  if (mode === "add") {
    if (!trigger.references?.length) return "Missing references array";
    if (!trigger.references[0]?.dataUrl) return "Missing reference image";
  }
  if ((mode === "update" || mode === "remove") && !trigger.id) return `Missing trigger id for ${mode}`;
  return null;
}

console.log("\n— create-profile validation ---");

test("valid create-profile request passes", () => {
  assertEqual(validateRequest({
    gameId: "pillars-of-eternity", gameName: "Pillars of Eternity",
    newProfileId: "community", mode: "create-profile",
  }), null);
});

test("create-profile missing gameName is rejected", () => {
  const err = validateRequest({ gameId: "pillars-of-eternity", newProfileId: "community", mode: "create-profile" });
  assert(err !== null && err.includes("gameName"), `got: ${err}`);
});

test("create-profile missing gameId is rejected", () => {
  const err = validateRequest({ gameName: "Pillars of Eternity", newProfileId: "community", mode: "create-profile" });
  assert(err !== null, `should fail, got null`);
});

test("create-profile missing newProfileId is rejected", () => {
  const err = validateRequest({ gameId: "new-game", gameName: "New Game", mode: "create-profile" });
  assert(err !== null && err.includes("newProfileId"), `got: ${err}`);
});

test("create-profile does not require trigger", () => {
  assertEqual(validateRequest({
    gameId: "new-game", gameName: "New Game", newProfileId: "competitive", mode: "create-profile",
  }), null);
});

test("other modes still validate normally", () => {
  // add still requires references
  const err = validateRequest({
    gameId: "slay-the-spire-2", profileId: "community",
    trigger: { payloads: [{ title: "x" }], references: [] },
    mode: "add",
  });
  assert(err !== null && err.includes("references"), `got: ${err}`);
});

// ---------------------------------------------------------------------------
// No-profile banner state logic — mirrors popup.js branching
// ---------------------------------------------------------------------------

function bannerState(detectedSlug, detectedName, catalogMatch) {
  if (detectedSlug && catalogMatch) return { type: "matched", text: "✓ Auto-detected from stream" };
  if (detectedSlug && !catalogMatch) {
    const label = detectedName || detectedSlug;
    return {
      type: "no-profile",
      text: `"${label}" has no profile yet.`,
      btnText: `+ Create profile for ${label}`,
    };
  }
  return { type: "none" };
}

const CATALOG = [
  { gameId: "slay-the-spire-2", twitchSlug: "slay-the-spire-ii" },
];

function findMatch(slug) {
  return slug ? CATALOG.find(g => g.gameId === slug || g.twitchSlug === slug) || null : null;
}

console.log("\n— No-profile banner state ---");

test("known game shows matched badge", () => {
  const state = bannerState("slay-the-spire-ii", "Slay the Spire II", findMatch("slay-the-spire-ii"));
  assertEqual(state.type, "matched");
  assertEqual(state.text, "✓ Auto-detected from stream");
});

test("unknown game shows no-profile banner with display name", () => {
  const state = bannerState("pillars-of-eternity", "Pillars of Eternity", findMatch("pillars-of-eternity"));
  assertEqual(state.type, "no-profile");
  assert(state.text.includes("Pillars of Eternity"), `text: ${state.text}`);
  assert(state.btnText.includes("Pillars of Eternity"), `btn: ${state.btnText}`);
});

test("unknown game with no name falls back to slug in banner", () => {
  const state = bannerState("pillars-of-eternity", null, null);
  assertEqual(state.type, "no-profile");
  assert(state.text.includes("pillars-of-eternity"), `text: ${state.text}`);
  assert(state.btnText.includes("pillars-of-eternity"), `btn: ${state.btnText}`);
});

test("no detection shows nothing", () => {
  const state = bannerState(null, null, null);
  assertEqual(state.type, "none");
});

// ---------------------------------------------------------------------------
// catalog.json patch logic — mirrors createProfile() in worker
// ---------------------------------------------------------------------------

function patchCatalog(catalog, gameId, gameName, twitchSlug, profileId, profileName) {
  const updated = { ...catalog, games: catalog.games.map(g => ({ ...g, profiles: [...g.profiles] })) };
  const newProfile = { id: profileId, name: profileName, url: `.../${gameId}/profiles/${profileId}/profile.json` };
  const existing = updated.games.find(g => g.id === gameId);
  if (existing) {
    if (!existing.profiles.find(p => p.id === profileId)) existing.profiles.push(newProfile);
  } else {
    updated.games.push({ id: gameId, name: gameName, twitchSlug, profiles: [newProfile] });
  }
  return updated;
}

console.log("\n— Catalog patch logic ---");

test("new game is added to catalog with specified profileId", () => {
  const catalog = { games: [{ id: "slay-the-spire-2", name: "STS2", profiles: [] }] };
  const updated = patchCatalog(catalog, "pillars-of-eternity", "Pillars of Eternity", "pillars-of-eternity", "community", "Pillars Community");
  assertEqual(updated.games.length, 2);
  const added = updated.games.find(g => g.id === "pillars-of-eternity");
  assert(added !== undefined, "new game should be in catalog");
  assertEqual(added.twitchSlug, "pillars-of-eternity");
  assertEqual(added.profiles[0].id, "community");
});

test("new profile added to existing game", () => {
  const catalog = { games: [{ id: "music", name: "Music", twitchSlug: "music", profiles: [{ id: "community", name: "Music Community" }] }] };
  const updated = patchCatalog(catalog, "music", "Music", "music", "competitive", "Music Competitive");
  assertEqual(updated.games.length, 1);
  assertEqual(updated.games[0].profiles.length, 2);
  assert(updated.games[0].profiles.find(p => p.id === "competitive"), "competitive profile should exist");
});

test("duplicate profile on existing game is not double-added", () => {
  const catalog = { games: [{ id: "music", name: "Music", twitchSlug: "music", profiles: [{ id: "community", name: "Music Community" }] }] };
  const updated = patchCatalog(catalog, "music", "Music", "music", "community", "Music Community");
  assertEqual(updated.games[0].profiles.length, 1);
});

test("original catalog is not mutated", () => {
  const catalog = { games: [{ id: "slay-the-spire-2", profiles: [] }] };
  patchCatalog(catalog, "new-game", "New Game", "new-game", "community", "New Game Community");
  assertEqual(catalog.games.length, 1);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
