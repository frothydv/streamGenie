#!/usr/bin/env node
// Unit tests for profile reload logic and local catalog persistence.
// Run with: node tests/profile-reload.js

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}: ${err.message}`); failed++; }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEqual(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---------------------------------------------------------------------------
// 1. Should content.js reload triggers? — mirrors storage change listener logic
// ---------------------------------------------------------------------------

function shouldReloadProfile(storedActive, currentlyLoaded) {
  if (!currentlyLoaded) return true;
  return storedActive.gameId    !== currentlyLoaded.gameId ||
         storedActive.profileId !== currentlyLoaded.profileId;
}

console.log("\n— Content script profile reload logic ---");

test("reload when game changes", () => {
  assert(shouldReloadProfile(
    { gameId: "music",            profileId: "community" },
    { gameId: "slay-the-spire-2", profileId: "community" }
  ));
});

test("reload when profileId changes", () => {
  assert(shouldReloadProfile(
    { gameId: "slay-the-spire-2", profileId: "dcsts2" },
    { gameId: "slay-the-spire-2", profileId: "community" }
  ));
});

test("no reload when same game+profile", () => {
  assert(!shouldReloadProfile(
    { gameId: "slay-the-spire-2", profileId: "community" },
    { gameId: "slay-the-spire-2", profileId: "community" }
  ));
});

test("reload when nothing currently loaded", () => {
  assert(shouldReloadProfile({ gameId: "slay-the-spire-2", profileId: "community" }, null));
});

// ---------------------------------------------------------------------------
// 2. Local catalog merge — supplements CDN catalog with locally-created entries
// ---------------------------------------------------------------------------

function mergeCatalog(cdnCatalog, localAdditions) {
  const merged = cdnCatalog.map(g => ({ ...g, profiles: [...g.profiles] }));
  for (const localGame of localAdditions) {
    const existing = merged.find(g => g.gameId === localGame.gameId);
    if (existing) {
      for (const p of localGame.profiles) {
        if (!existing.profiles.find(ep => ep.id === p.id)) existing.profiles.push(p);
      }
    } else {
      merged.push({ ...localGame });
    }
  }
  return merged;
}

const CDN_CATALOG = [
  { gameId: "slay-the-spire-2", gameName: "Slay the Spire 2", twitchSlug: "slay-the-spire-ii",
    profiles: [{ id: "community", name: "STS2 Community", url: "cdn://sts2/community" }] },
];

console.log("\n— Local catalog merge ---");

test("empty local additions leaves CDN catalog unchanged", () => {
  const merged = mergeCatalog(CDN_CATALOG, []);
  assertEqual(merged.length, 1);
  assertEqual(merged[0].profiles.length, 1);
});

test("new game from local is added to merged catalog", () => {
  const local = [{ gameId: "music", gameName: "Music", twitchSlug: "music",
                   profiles: [{ id: "community", name: "Music Community", url: "gh://music/community" }] }];
  const merged = mergeCatalog(CDN_CATALOG, local);
  assertEqual(merged.length, 2);
  assert(merged.find(g => g.gameId === "music"), "music should be present");
});

test("new profile on existing game is appended", () => {
  const local = [{ gameId: "slay-the-spire-2", gameName: "Slay the Spire 2", twitchSlug: "slay-the-spire-ii",
                   profiles: [{ id: "dcsts2", name: "DCSTS2", url: "gh://sts2/dcsts2" }] }];
  const merged = mergeCatalog(CDN_CATALOG, local);
  assertEqual(merged.length, 1);
  assertEqual(merged[0].profiles.length, 2);
  assert(merged[0].profiles.find(p => p.id === "dcsts2"), "dcsts2 should be present");
});

test("duplicate profile from local is not double-added", () => {
  const local = [{ gameId: "slay-the-spire-2", gameName: "Slay the Spire 2", twitchSlug: "slay-the-spire-ii",
                   profiles: [{ id: "community", name: "STS2 Community", url: "cdn://sts2/community" }] }];
  const merged = mergeCatalog(CDN_CATALOG, local);
  assertEqual(merged[0].profiles.length, 1);
});

test("CDN catalog is not mutated by merge", () => {
  const local = [{ gameId: "music", gameName: "Music", twitchSlug: "music",
                   profiles: [{ id: "community", name: "Music Community", url: "gh://music/community" }] }];
  mergeCatalog(CDN_CATALOG, local);
  assertEqual(CDN_CATALOG.length, 1);
});

// ---------------------------------------------------------------------------
// 3. Local catalog accumulation — saving newly created profiles
// ---------------------------------------------------------------------------

function saveToLocalCatalog(existing, gameId, gameName, twitchSlug, profileId, profileName, profileUrl) {
  const additions = existing.map(g => ({ ...g, profiles: [...g.profiles] }));
  let gameEntry = additions.find(g => g.gameId === gameId);
  if (!gameEntry) {
    gameEntry = { gameId, gameName, twitchSlug, profiles: [] };
    additions.push(gameEntry);
  }
  if (!gameEntry.profiles.find(p => p.id === profileId)) {
    gameEntry.profiles.push({ id: profileId, name: profileName, url: profileUrl });
  }
  return additions;
}

console.log("\n— Local catalog accumulation ---");

test("first local creation produces one entry", () => {
  const result = saveToLocalCatalog([], "music", "Music", "music", "community", "Music Community", "gh://music/community");
  assertEqual(result.length, 1);
  assertEqual(result[0].profiles.length, 1);
  assertEqual(result[0].profiles[0].id, "community");
});

test("second profile for same game is appended", () => {
  const existing = saveToLocalCatalog([], "music", "Music", "music", "community", "Music Community", "gh://music/community");
  const result   = saveToLocalCatalog(existing, "music", "Music", "music", "competitive", "Music Competitive", "gh://music/competitive");
  assertEqual(result.length, 1);
  assertEqual(result[0].profiles.length, 2);
});

test("duplicate save is idempotent", () => {
  const existing = saveToLocalCatalog([], "music", "Music", "music", "community", "Music Community", "gh://music/community");
  const result   = saveToLocalCatalog(existing, "music", "Music", "music", "community", "Music Community", "gh://music/community");
  assertEqual(result[0].profiles.length, 1);
});

test("different games produce separate entries", () => {
  const a = saveToLocalCatalog([], "music", "Music", "music", "community", "Music Community", "gh://music/community");
  const b = saveToLocalCatalog(a, "minecraft", "Minecraft", "minecraft", "community", "Minecraft Community", "gh://mc/community");
  assertEqual(b.length, 2);
});

test("input existing array is not mutated", () => {
  const existing = [];
  saveToLocalCatalog(existing, "music", "Music", "music", "community", "Music Community", "gh://url");
  assertEqual(existing.length, 0);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
