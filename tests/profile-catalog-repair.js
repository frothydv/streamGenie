#!/usr/bin/env node
// Tests for active-profile reconstruction and twitchSlug propagation during catalog merge.
// Run with: node tests/profile-catalog-repair.js

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
// 1. Active profile reconstruction
//    If the stored active profile isn't in the catalog (CDN stale, local cache missed),
//    reconstruct it so the dropdown shows it.
// ---------------------------------------------------------------------------

function reconstructActiveInCatalog(catalog, active) {
  if (!active?.url) return catalog;
  const result = catalog.map(g => ({ ...g, profiles: [...g.profiles] }));
  let game = result.find(g => g.gameId === active.gameId);
  if (!game) {
    game = { gameId: active.gameId, gameName: active.gameId, twitchSlug: null, profiles: [] };
    result.push(game);
  }
  if (!game.profiles.find(p => p.id === active.profileId)) {
    game.profiles.push({ id: active.profileId, name: active.name, url: active.url });
  }
  return result;
}

const BASE_CATALOG = [
  { gameId: "slay-the-spire-2", gameName: "Slay the Spire 2", twitchSlug: null,
    profiles: [{ id: "community", name: "STS2 Community", url: "cdn://sts2/community" }] },
];

console.log("\n— Active profile reconstruction ---");

test("known profile already in catalog → no change", () => {
  const active = { gameId: "slay-the-spire-2", profileId: "community", name: "STS2 Community", url: "cdn://sts2/community" };
  const result = reconstructActiveInCatalog(BASE_CATALOG, active);
  assertEqual(result[0].profiles.length, 1);
});

test("active profile missing from catalog → added to existing game", () => {
  const active = { gameId: "slay-the-spire-2", profileId: "dcsts2", name: "DCSTS2", url: "cdn://sts2/dcsts2" };
  const result = reconstructActiveInCatalog(BASE_CATALOG, active);
  assertEqual(result[0].profiles.length, 2);
  assert(result[0].profiles.find(p => p.id === "dcsts2"), "dcsts2 should be in profiles");
});

test("active game not in catalog at all → game and profile added", () => {
  const active = { gameId: "music", profileId: "community", name: "Music Community", url: "gh://music/community" };
  const result = reconstructActiveInCatalog(BASE_CATALOG, active);
  assertEqual(result.length, 2);
  assertEqual(result[1].gameId, "music");
  assertEqual(result[1].profiles[0].id, "community");
});

test("active with no url → catalog unchanged (can't reconstruct)", () => {
  const active = { gameId: "music", profileId: "community", name: "Music Community" };
  const result = reconstructActiveInCatalog(BASE_CATALOG, active);
  assertEqual(result.length, 1);
});

test("null active → catalog unchanged", () => {
  const result = reconstructActiveInCatalog(BASE_CATALOG, null);
  assertEqual(result.length, 1);
});

test("reconstruction does not mutate input catalog", () => {
  const active = { gameId: "slay-the-spire-2", profileId: "dcsts2", name: "DCSTS2", url: "url" };
  reconstructActiveInCatalog(BASE_CATALOG, active);
  assertEqual(BASE_CATALOG[0].profiles.length, 1);
});

// ---------------------------------------------------------------------------
// 2. twitchSlug propagation during local catalog merge
//    When the CDN catalog entry is missing twitchSlug but the local addition has it,
//    propagate it so catalogMatch works correctly.
// ---------------------------------------------------------------------------

function mergeCatalogWithSlugPropagation(cdnCatalog, localAdditions) {
  const merged = cdnCatalog.map(g => ({ ...g, profiles: [...g.profiles] }));
  for (const localGame of localAdditions) {
    const existing = merged.find(g => g.gameId === localGame.gameId);
    if (existing) {
      // Propagate twitchSlug if CDN entry is missing it
      if (!existing.twitchSlug && localGame.twitchSlug) existing.twitchSlug = localGame.twitchSlug;
      for (const p of localGame.profiles) {
        if (!existing.profiles.find(ep => ep.id === p.id)) existing.profiles.push(p);
      }
    } else {
      merged.push({ ...localGame });
    }
  }
  return merged;
}

const CDN_NO_SLUG = [
  { gameId: "slay-the-spire-2", gameName: "Slay the Spire 2", twitchSlug: null,
    profiles: [{ id: "community", name: "STS2 Community", url: "cdn://sts2/community" }] },
];

console.log("\n— twitchSlug propagation in merge ---");

test("local addition propagates missing twitchSlug to CDN entry", () => {
  const local = [{ gameId: "slay-the-spire-2", gameName: "Slay the Spire 2",
                   twitchSlug: "slay-the-spire-ii",
                   profiles: [{ id: "dcsts2", name: "DCSTS2", url: "gh://sts2/dcsts2" }] }];
  const merged = mergeCatalogWithSlugPropagation(CDN_NO_SLUG, local);
  assertEqual(merged[0].twitchSlug, "slay-the-spire-ii");
});

test("after propagation, catalogMatch finds STS2 by Twitch slug", () => {
  const local = [{ gameId: "slay-the-spire-2", twitchSlug: "slay-the-spire-ii", profiles: [] }];
  const merged = mergeCatalogWithSlugPropagation(CDN_NO_SLUG, local);
  const match = merged.find(g => g.gameId === "slay-the-spire-ii" || g.twitchSlug === "slay-the-spire-ii");
  assert(match !== undefined, "should find STS2 by twitchSlug after propagation");
});

test("existing twitchSlug in CDN is not overwritten", () => {
  const cdnWithSlug = [{ gameId: "slay-the-spire-2", twitchSlug: "slay-the-spire-ii", profiles: [] }];
  const local = [{ gameId: "slay-the-spire-2", twitchSlug: "wrong-slug", profiles: [] }];
  const merged = mergeCatalogWithSlugPropagation(cdnWithSlug, local);
  assertEqual(merged[0].twitchSlug, "slay-the-spire-ii");
});

test("merge still adds profiles alongside slug propagation", () => {
  const local = [{ gameId: "slay-the-spire-2", twitchSlug: "slay-the-spire-ii",
                   profiles: [{ id: "dcsts2", name: "DCSTS2", url: "gh://dcsts2" }] }];
  const merged = mergeCatalogWithSlugPropagation(CDN_NO_SLUG, local);
  assertEqual(merged[0].profiles.length, 2);
  assertEqual(merged[0].twitchSlug, "slay-the-spire-ii");
});

// ---------------------------------------------------------------------------
// 3. Worker: twitchSlug written to existing game on profile creation
// ---------------------------------------------------------------------------

function workerPatchExistingGame(catalog, gameId, twitchSlug, profileId, profileName, profileUrl) {
  const game = catalog.find(g => g.id === gameId);
  if (!game) throw new Error(`Game ${gameId} not found`);
  if (!game.twitchSlug && twitchSlug) game.twitchSlug = twitchSlug;  // ← the fix
  if (!game.profiles.find(p => p.id === profileId)) {
    game.profiles.push({ id: profileId, name: profileName, url: profileUrl });
  }
  return catalog;
}

console.log("\n— Worker twitchSlug fix for existing games ---");

test("creates profile and sets missing twitchSlug on existing game", () => {
  const catalog = { games: [{ id: "slay-the-spire-2", name: "STS2", twitchSlug: undefined, profiles: [{ id: "community" }] }] };
  workerPatchExistingGame(catalog.games, "slay-the-spire-2", "slay-the-spire-ii", "dcsts2", "DCSTS2", "url");
  assertEqual(catalog.games[0].twitchSlug, "slay-the-spire-ii");
  assertEqual(catalog.games[0].profiles.length, 2);
});

test("does not overwrite existing twitchSlug", () => {
  const catalog = { games: [{ id: "slay-the-spire-2", twitchSlug: "slay-the-spire-ii", profiles: [] }] };
  workerPatchExistingGame(catalog.games, "slay-the-spire-2", "wrong", "dcsts2", "DCSTS2", "url");
  assertEqual(catalog.games[0].twitchSlug, "slay-the-spire-ii");
});

test("null twitchSlug passed to worker does not null out existing", () => {
  const catalog = { games: [{ id: "slay-the-spire-2", twitchSlug: "slay-the-spire-ii", profiles: [] }] };
  workerPatchExistingGame(catalog.games, "slay-the-spire-2", null, "dcsts2", "DCSTS2", "url");
  assertEqual(catalog.games[0].twitchSlug, "slay-the-spire-ii");
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
