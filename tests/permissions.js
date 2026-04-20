#!/usr/bin/env node
// Tests for permission-system logic: contributor codes, trust path selection, status UI.
// Run with: node tests/permissions.js

let passed = 0, failed = 0;
const asyncTests = [];

function test(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    asyncTests.push(
      result
        .then(() => { console.log(`  ✓ ${name}`); passed++; })
        .catch(err => { console.log(`  ✗ ${name}: ${err.message}`); failed++; })
    );
  } else {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.log(`  ✗ ${name}: ${err.message}`); failed++; }
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEqual(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---------------------------------------------------------------------------
// 1. contributorCodeKey — storage key format
// ---------------------------------------------------------------------------

function contributorCodeKey(gId, pId) { return `streamGenie_code_${gId}_${pId}`; }

console.log("\n— contributorCodeKey format ---");

test("key uses gameId and profileId", () => {
  assertEqual(contributorCodeKey("slay-the-spire-2", "community"), "streamGenie_code_slay-the-spire-2_community");
});
test("key differs for different profiles of same game", () => {
  assert(
    contributorCodeKey("slay-the-spire-2", "community") !== contributorCodeKey("slay-the-spire-2", "dcsts2"),
    "keys must be distinct"
  );
});
test("key differs for same profile id in different games", () => {
  assert(
    contributorCodeKey("slay-the-spire-2", "community") !== contributorCodeKey("music", "community"),
    "keys must be distinct"
  );
});

// ---------------------------------------------------------------------------
// 2. contributorHint — attribution in commit messages
// ---------------------------------------------------------------------------

function contributorHint(key) {
  if (!key) return "anonymous";
  return key.replace(/-/g, "").slice(0, 8);
}

console.log("\n— contributorHint ---");

test("null key → anonymous", () => { assertEqual(contributorHint(null), "anonymous"); });
test("undefined key → anonymous", () => { assertEqual(contributorHint(undefined), "anonymous"); });
test("UUID key → 8-char hex hint (no dashes)", () => {
  const hint = contributorHint("550e8400-e29b-41d4-a716-446655440000");
  assertEqual(hint, "550e8400");
  assert(!hint.includes("-"), "hint must not contain dashes");
});
test("hint is always exactly 8 chars for valid UUID", () => {
  const hint = contributorHint("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assertEqual(hint.length, 8);
});

// ---------------------------------------------------------------------------
// 3. isTrustedContributor — KV lookup simulation
// ---------------------------------------------------------------------------

function makeFakeKV(entries) {
  return {
    async get(key) {
      return entries[key] !== undefined ? JSON.stringify(entries[key]) : null;
    },
  };
}

async function isTrustedContributor(kv, key, gameId, profileId) {
  if (!key || !kv) return false;
  try {
    const value = await kv.get(key);
    if (!value) return false;
    const data = JSON.parse(value);
    return data.gameId === gameId && data.profileId === profileId;
  } catch { return false; }
}

console.log("\n— isTrustedContributor ---");

test("no key → not trusted", async () => {
  assert(!(await isTrustedContributor(makeFakeKV({}), null, "g", "p")));
});
test("key not in KV → not trusted", async () => {
  assert(!(await isTrustedContributor(makeFakeKV({}), "unknown", "g", "p")));
});
test("key matches gameId and profileId → trusted", async () => {
  const kv = makeFakeKV({ code: { gameId: "sts2", profileId: "community" } });
  assert(await isTrustedContributor(kv, "code", "sts2", "community"));
});
test("correct code but wrong profileId → not trusted", async () => {
  const kv = makeFakeKV({ code: { gameId: "sts2", profileId: "community" } });
  assert(!(await isTrustedContributor(kv, "code", "sts2", "other")));
});
test("correct code but wrong gameId → not trusted", async () => {
  const kv = makeFakeKV({ code: { gameId: "sts2", profileId: "community" } });
  assert(!(await isTrustedContributor(kv, "code", "other-game", "community")));
});
test("code scoped to profile cannot unlock sibling profile", async () => {
  const kv = makeFakeKV({ code: { gameId: "sts2", profileId: "community" } });
  assert(!(await isTrustedContributor(kv, "code", "sts2", "competitive")));
});

// ---------------------------------------------------------------------------
// 4. Commit message format
// ---------------------------------------------------------------------------

const addMsg    = (title, hint) => `feat: add trigger "${title}" [contributor: ${hint}]`;
const updateMsg = (title, hint) => `fix: update trigger "${title}" [contributor: ${hint}]`;
const removeMsg = (title, hint) => `fix: remove trigger "${title}" [contributor: ${hint}]`;

console.log("\n— commit message format ---");

test("add format", () => {
  assertEqual(addMsg("Iron Wave", "abc12345"), 'feat: add trigger "Iron Wave" [contributor: abc12345]');
});
test("update format", () => {
  assertEqual(updateMsg("Iron Wave", "abc12345"), 'fix: update trigger "Iron Wave" [contributor: abc12345]');
});
test("remove format", () => {
  assertEqual(removeMsg("Iron Wave", "abc12345"), 'fix: remove trigger "Iron Wave" [contributor: abc12345]');
});
test("anonymous hint appears in add commit", () => {
  assert(addMsg("T", contributorHint(null)).includes("anonymous"));
});

// ---------------------------------------------------------------------------
// 5. PR vs direct path selection
// ---------------------------------------------------------------------------

const choosePath = (trusted) => trusted ? "direct" : "pr";

console.log("\n— PR vs direct path ---");

test("trusted → direct commit", () => { assertEqual(choosePath(true), "direct"); });
test("untrusted → PR", ()       => { assertEqual(choosePath(false), "pr"); });
test("no code → PR by default", async () => {
  const trusted = await isTrustedContributor(makeFakeKV({}), null, "g", "p");
  assertEqual(choosePath(trusted), "pr");
});

// ---------------------------------------------------------------------------
// 6. Popup contributor status display logic
// ---------------------------------------------------------------------------

function contributorStatusView(code) {
  if (code) return { mode: "trusted", hint: code.replace(/-/g, "").slice(0, 8) + "…" };
  return { mode: "pr" };
}

console.log("\n— popup contributor status ---");

test("code present → trusted view with hint", () => {
  const v = contributorStatusView("550e8400-e29b-41d4-a716-446655440000");
  assertEqual(v.mode, "trusted");
  assertEqual(v.hint, "550e8400…");
});
test("no code → pr view", () => {
  assertEqual(contributorStatusView(null).mode, "pr");
  assertEqual(contributorStatusView("").mode, "pr");
});
test("hint ends with ellipsis", () => {
  assert(contributorStatusView("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").hint.endsWith("…"));
});

// ---------------------------------------------------------------------------
// 7. Verify request shape
// ---------------------------------------------------------------------------

function buildVerifyRequest(gameId, profileId, code) {
  const body    = { gameId, profileId, mode: "verify" };
  const headers = { "Content-Type": "application/json", "X-Submit-Secret": "<secret>" };
  if (code) headers["X-Contributor-Key"] = code;
  return { body, headers };
}

console.log("\n— verify request shape ---");

test("mode is verify", () => {
  assertEqual(buildVerifyRequest("g", "p", "c").body.mode, "verify");
});
test("key header present when code given", () => {
  assertEqual(buildVerifyRequest("g", "p", "my-code").headers["X-Contributor-Key"], "my-code");
});
test("key header absent when no code", () => {
  assert(!("X-Contributor-Key" in buildVerifyRequest("g", "p", null).headers));
});
test("body carries gameId and profileId", () => {
  const { body } = buildVerifyRequest("slay-the-spire-2", "community", "c");
  assertEqual(body.gameId, "slay-the-spire-2");
  assertEqual(body.profileId, "community");
});

// ---------------------------------------------------------------------------

Promise.all(asyncTests).then(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});
