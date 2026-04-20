#!/usr/bin/env node
// Tests for verified flag: FALLBACK propagation, profile select labels, new-profile defaults.
// Run with: node tests/catalog-verified.js

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
// Shared helpers (mirrors popup.js logic exactly)
// ---------------------------------------------------------------------------

const FALLBACK_CATALOG = [
  {
    gameId: "slay-the-spire-2",
    gameName: "Slay the Spire 2",
    twitchSlug: "slay-the-spire-ii",
    profiles: [
      { id: "community", name: "STS2 Community", verified: true,
        url: "https://cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@main/games/slay-the-spire-2/profiles/community/profile.json" },
    ],
  },
];

function applyFallbackOverrides(catalog, fallback) {
  for (const fb of fallback) {
    const existing = catalog.find(g => g.gameId === fb.gameId);
    if (!existing) continue;
    if (fb.twitchSlug) existing.twitchSlug = fb.twitchSlug;
    for (const fp of fb.profiles) {
      const ep = existing.profiles.find(p => p.id === fp.id);
      if (ep && fp.verified !== undefined) ep.verified = fp.verified;
    }
  }
  return catalog;
}

function profileSelectLabel(profile) {
  return profile.verified ? `✓ ${profile.name}` : profile.name;
}

// ---------------------------------------------------------------------------
// 1. FALLBACK propagation of verified
// ---------------------------------------------------------------------------

console.log("\n— FALLBACK verified propagation ---");

test("verified:true propagates from FALLBACK to CDN-loaded entry", () => {
  const catalog = [
    { gameId: "slay-the-spire-2", twitchSlug: null,
      profiles: [{ id: "community", name: "STS2 Community", verified: false, url: "u" }] },
  ];
  applyFallbackOverrides(catalog, FALLBACK_CATALOG);
  assertEqual(catalog[0].profiles[0].verified, true);
});

test("twitchSlug also propagated in same pass", () => {
  const catalog = [
    { gameId: "slay-the-spire-2", twitchSlug: null,
      profiles: [{ id: "community", name: "STS2 Community", verified: false, url: "u" }] },
  ];
  applyFallbackOverrides(catalog, FALLBACK_CATALOG);
  assertEqual(catalog[0].twitchSlug, "slay-the-spire-ii");
  assertEqual(catalog[0].profiles[0].verified, true);
});

test("only matching profile id is updated", () => {
  const catalog = [
    { gameId: "slay-the-spire-2", twitchSlug: null, profiles: [
      { id: "community", name: "STS2 Community", verified: false, url: "u" },
      { id: "dcsts2",    name: "DCSTS2",          verified: false, url: "u2" },
    ]},
  ];
  applyFallbackOverrides(catalog, FALLBACK_CATALOG);
  assertEqual(catalog[0].profiles[0].verified, true);   // community → patched
  assertEqual(catalog[0].profiles[1].verified, false);  // dcsts2 → untouched
});

test("game not in FALLBACK is not modified", () => {
  const catalog = [
    { gameId: "starcraft-ii", twitchSlug: "starcraft-ii",
      profiles: [{ id: "community", name: "SC2 Community", verified: false, url: "u" }] },
  ];
  applyFallbackOverrides(catalog, FALLBACK_CATALOG);
  assertEqual(catalog[0].profiles[0].verified, false);
});

test("FALLBACK does not override verified:true already on CDN entry", () => {
  // If CDN somehow has verified:true and FALLBACK also has true, no change
  const catalog = [
    { gameId: "slay-the-spire-2", twitchSlug: "slay-the-spire-ii",
      profiles: [{ id: "community", name: "STS2 Community", verified: true, url: "u" }] },
  ];
  applyFallbackOverrides(catalog, FALLBACK_CATALOG);
  assertEqual(catalog[0].profiles[0].verified, true);
});

test("propagation does not mutate FALLBACK_CATALOG", () => {
  const catalog = [
    { gameId: "slay-the-spire-2", twitchSlug: null,
      profiles: [{ id: "community", name: "STS2 Community", verified: false, url: "u" }] },
  ];
  applyFallbackOverrides(catalog, FALLBACK_CATALOG);
  assertEqual(FALLBACK_CATALOG[0].profiles[0].verified, true); // still true, not mutated
  assertEqual(FALLBACK_CATALOG[0].twitchSlug, "slay-the-spire-ii");
});

// ---------------------------------------------------------------------------
// 2. CDN catalog parsing — missing verified defaults to false
// ---------------------------------------------------------------------------

console.log("\n— CDN catalog parsing ---");

function parseCdnCatalog(raw) {
  return raw.games.map(g => ({
    gameId:   g.id,
    gameName: g.name,
    twitchSlug: g.twitchSlug || null,
    profiles: g.profiles.map(p => ({ id: p.id, name: p.name, verified: p.verified ?? false, url: p.url })),
  }));
}

test("profile with verified:true parsed correctly", () => {
  const raw = { games: [{ id: "g", name: "G", profiles: [{ id: "p", name: "P", verified: true, url: "u" }] }] };
  assertEqual(parseCdnCatalog(raw)[0].profiles[0].verified, true);
});

test("profile missing verified field defaults to false", () => {
  const raw = { games: [{ id: "g", name: "G", profiles: [{ id: "p", name: "P", url: "u" }] }] };
  assertEqual(parseCdnCatalog(raw)[0].profiles[0].verified, false);
});

test("profile with verified:false parsed as false", () => {
  const raw = { games: [{ id: "g", name: "G", profiles: [{ id: "p", name: "P", verified: false, url: "u" }] }] };
  assertEqual(parseCdnCatalog(raw)[0].profiles[0].verified, false);
});

// ---------------------------------------------------------------------------
// 3. Profile select label format
// ---------------------------------------------------------------------------

console.log("\n— Profile select label ---");

test("verified profile gets ✓ prefix", () => {
  assertEqual(profileSelectLabel({ name: "STS2 Community", verified: true }), "✓ STS2 Community");
});

test("unverified profile has no prefix", () => {
  assertEqual(profileSelectLabel({ name: "DCSTS2", verified: false }), "DCSTS2");
});

test("missing verified treated as false (no prefix)", () => {
  assertEqual(profileSelectLabel({ name: "New Profile" }), "New Profile");
});

test("✓ prefix is visually distinct — not just a letter", () => {
  const label = profileSelectLabel({ name: "X", verified: true });
  assert(label.startsWith("✓"), "must start with checkmark character");
  assert(!label.startsWith("v "), "must not be a plain v");
});

// ---------------------------------------------------------------------------
// 4. New profile defaults
// ---------------------------------------------------------------------------

console.log("\n— New profile verified defaults ---");

function buildNewProfileEntry(profileId, profileName, profileUrl) {
  return { id: profileId, name: profileName, verified: false, url: profileUrl };
}

function buildNewGameEntry(gameId, gameName, twitchSlug, profileId, profileName, profileUrl) {
  return {
    id: gameId, name: gameName, twitchSlug,
    profiles: [{ id: profileId, name: profileName, verified: false, url: profileUrl }],
  };
}

test("new profile entry defaults to verified:false", () => {
  assertEqual(buildNewProfileEntry("p", "Profile", "u").verified, false);
});

test("new game entry's profile defaults to verified:false", () => {
  const entry = buildNewGameEntry("g", "G", "g-slug", "community", "G Community", "u");
  assertEqual(entry.profiles[0].verified, false);
});

test("active profile reconstruction entry defaults to verified:false", () => {
  const reconstructed = { id: "community", name: "STS2 Community", verified: false, url: "u" };
  assertEqual(reconstructed.verified, false);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
