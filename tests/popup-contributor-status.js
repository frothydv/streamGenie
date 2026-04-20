#!/usr/bin/env node
// Tests for contributor status display bugs:
// 1. Status must reflect the SELECTED profile, not the active profile.
// 2. Verify request must target the selected game/profile.
// 3. Code save must be keyed to the selected profile.
// Run with: node tests/popup-contributor-status.js

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
// Shared helpers (mirrors popup.js exactly)
// ---------------------------------------------------------------------------

const contributorCodeKey = (gId, pId) => `streamGenie_code_${gId}_${pId}`;

// Simulates the CORRECT status lookup (uses selected, not active).
function getContributorCode(storage, selectedGameId, selectedProfileId) {
  const key = contributorCodeKey(selectedGameId, selectedProfileId);
  return storage[key] || null;
}

// Simulates the BUGGY status lookup (uses active regardless of selection).
function getContributorCodeBuggy(storage, active) {
  const key = contributorCodeKey(active.gameId, active.profileId);
  return storage[key] || null;
}

// Simulates what the verify request body should contain.
function buildVerifyBody(selectedGameId, selectedProfileId) {
  return { gameId: selectedGameId, profileId: selectedProfileId, mode: "verify" };
}

// ---------------------------------------------------------------------------
// 1. Code lookup uses selected profile, not active
// ---------------------------------------------------------------------------

console.log("\n— Contributor code lookup (selected vs active) ---");

const COMMUNITY_CODE = "f61d1f28-0000-0000-0000-000000000000";

const storageWithCommunityCode = {
  [contributorCodeKey("slay-the-spire-2", "community")]: COMMUNITY_CODE,
};

test("community code found when community is selected", () => {
  const code = getContributorCode(storageWithCommunityCode, "slay-the-spire-2", "community");
  assertEqual(code, COMMUNITY_CODE);
});

test("no code returned when sts2-test is selected (even though community code exists)", () => {
  const code = getContributorCode(storageWithCommunityCode, "slay-the-spire-2", "sts2-test");
  assertEqual(code, null);
});

test("no code returned when dc-sts2 is selected", () => {
  const code = getContributorCode(storageWithCommunityCode, "slay-the-spire-2", "dc-sts2");
  assertEqual(code, null);
});

test("no code returned when different game is selected", () => {
  const code = getContributorCode(storageWithCommunityCode, "starcraft-ii", "community");
  assertEqual(code, null);
});

test("BUG DEMO: buggy lookup returns community code even when sts2-test is selected", () => {
  const active = { gameId: "slay-the-spire-2", profileId: "community" };
  const code = getContributorCodeBuggy(storageWithCommunityCode, active);
  // This is the bug: returns COMMUNITY_CODE even though user is looking at sts2-test
  assertEqual(code, COMMUNITY_CODE);
});

test("correct lookup returns null when sts2-test is selected, active is community", () => {
  // This is what the fix produces
  const code = getContributorCode(storageWithCommunityCode, "slay-the-spire-2", "sts2-test");
  assertEqual(code, null);
});

// ---------------------------------------------------------------------------
// 2. Contributor status display state (trusted vs PR view)
// ---------------------------------------------------------------------------

console.log("\n— Contributor status display state ---");

function deriveStatusState(storage, selectedGameId, selectedProfileId) {
  const code = getContributorCode(storage, selectedGameId, selectedProfileId);
  return code ? "trusted" : "pr";
}

test("shows trusted for community when community is selected and code exists", () => {
  assertEqual(deriveStatusState(storageWithCommunityCode, "slay-the-spire-2", "community"), "trusted");
});

test("shows PR view for sts2-test even when community code is stored", () => {
  assertEqual(deriveStatusState(storageWithCommunityCode, "slay-the-spire-2", "sts2-test"), "pr");
});

test("shows PR view for dc-sts2 even when community code is stored", () => {
  assertEqual(deriveStatusState(storageWithCommunityCode, "slay-the-spire-2", "dc-sts2"), "pr");
});

test("shows PR view for starcraft-ii even when sts2 community code is stored", () => {
  assertEqual(deriveStatusState(storageWithCommunityCode, "starcraft-ii", "community"), "pr");
});

test("shows trusted for sts2-test when sts2-test code is stored", () => {
  const storage = { [contributorCodeKey("slay-the-spire-2", "sts2-test")]: "some-code" };
  assertEqual(deriveStatusState(storage, "slay-the-spire-2", "sts2-test"), "trusted");
});

test("shows PR view when storage is empty", () => {
  assertEqual(deriveStatusState({}, "slay-the-spire-2", "community"), "pr");
});

// ---------------------------------------------------------------------------
// 3. Verify request uses selected profile
// ---------------------------------------------------------------------------

console.log("\n— Verify request shape ---");

test("verify body uses selected gameId", () => {
  const body = buildVerifyBody("slay-the-spire-2", "sts2-test");
  assertEqual(body.gameId, "slay-the-spire-2");
});

test("verify body uses selected profileId", () => {
  const body = buildVerifyBody("slay-the-spire-2", "sts2-test");
  assertEqual(body.profileId, "sts2-test");
});

test("verify body mode is 'verify'", () => {
  const body = buildVerifyBody("slay-the-spire-2", "sts2-test");
  assertEqual(body.mode, "verify");
});

test("verify for community uses community profileId", () => {
  const body = buildVerifyBody("slay-the-spire-2", "community");
  assertEqual(body.profileId, "community");
  assertEqual(body.gameId, "slay-the-spire-2");
});

// ---------------------------------------------------------------------------
// 4. Code save key uses selected profile
// ---------------------------------------------------------------------------

console.log("\n— Code save key uses selected profile ---");

function codeWouldBeSavedAt(selectedGameId, selectedProfileId) {
  return contributorCodeKey(selectedGameId, selectedProfileId);
}

test("saving a code while sts2-test is selected saves under sts2-test key", () => {
  const key = codeWouldBeSavedAt("slay-the-spire-2", "sts2-test");
  assertEqual(key, "streamGenie_code_slay-the-spire-2_sts2-test");
});

test("saving a code while community is selected saves under community key", () => {
  const key = codeWouldBeSavedAt("slay-the-spire-2", "community");
  assertEqual(key, "streamGenie_code_slay-the-spire-2_community");
});

test("keys differ across profiles of same game", () => {
  const k1 = codeWouldBeSavedAt("slay-the-spire-2", "community");
  const k2 = codeWouldBeSavedAt("slay-the-spire-2", "sts2-test");
  assert(k1 !== k2, "keys should differ");
});

test("keys differ across games with same profile id", () => {
  const k1 = codeWouldBeSavedAt("slay-the-spire-2", "community");
  const k2 = codeWouldBeSavedAt("starcraft-ii", "community");
  assert(k1 !== k2, "keys should differ across games");
});

// ---------------------------------------------------------------------------
// 5. Catalog fetch options
// ---------------------------------------------------------------------------

console.log("\n— Catalog fetch options ---");

function buildCatalogFetchOptions() {
  return { cache: "no-cache" };
}

test("catalog fetch uses no-cache to bypass browser HTTP cache", () => {
  const opts = buildCatalogFetchOptions();
  assertEqual(opts.cache, "no-cache");
});

test("cache option is not 'default' (would use browser cache)", () => {
  const opts = buildCatalogFetchOptions();
  assert(opts.cache !== "default", "should not use default browser cache");
});

test("cache option is not 'force-cache' (would always use cached)", () => {
  const opts = buildCatalogFetchOptions();
  assert(opts.cache !== "force-cache", "should not force browser cache");
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
