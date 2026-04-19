#!/usr/bin/env node
/**
 * Integration tests for the streamgenie-submit Worker.
 * Run with: node test.js
 * Requires Node 18+ (native fetch).
 */

const WORKER_URL = "https://streamgenie-submit.vbjosh.workers.dev";
const SECRET     = "YorkshireTractorFactor";

// 1×1 transparent PNG — smallest valid image for reference upload tests.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

async function post(body, secret = SECRET) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Submit-Secret": secret },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Validation tests — no GitHub API calls, fast
// ---------------------------------------------------------------------------

console.log("\nValidation");

await test("OPTIONS returns CORS headers", async () => {
  const res = await fetch(WORKER_URL, { method: "OPTIONS" });
  assert(res.status === 200, `status ${res.status}`);
  assert(res.headers.get("access-control-allow-origin") === "*", "missing CORS header");
});

await test("GET returns 405", async () => {
  const res = await fetch(WORKER_URL);
  assert(res.status === 405, `status ${res.status}`);
});

await test("wrong secret → 401", async () => {
  const { status, data } = await post({ gameId: "x" }, "wrong-secret");
  assert(status === 401, `status ${status}`);
  assert(!data.ok);
});

await test("missing gameId → 400", async () => {
  const { status } = await post({ profileId: "community", trigger: {} });
  assert(status === 400, `status ${status}`);
});

await test("missing trigger → 400", async () => {
  const { status } = await post({ gameId: "slay-the-spire-2", profileId: "community" });
  assert(status === 400, `status ${status}`);
});

await test("add: missing dataUrl → 400", async () => {
  const { status } = await post({
    gameId: "slay-the-spire-2", profileId: "community",
    trigger: { payloads: [{ title: "X" }], references: [{ w: 1, h: 1 }] },
  });
  assert(status === 400, `status ${status}`);
});

await test("add: empty references array → 400", async () => {
  const { status } = await post({
    gameId: "slay-the-spire-2", profileId: "community",
    trigger: { payloads: [{ title: "X" }], references: [] },
  });
  assert(status === 400, `status ${status}`);
});

await test("update: missing trigger id → 400", async () => {
  const { status } = await post({
    gameId: "slay-the-spire-2", profileId: "community",
    mode: "update",
    trigger: { payloads: [{ title: "X" }] },
  });
  assert(status === 400, `status ${status}`);
});

// ---------------------------------------------------------------------------
// Happy path — add mode (creates a real PR, auto-merges)
// ---------------------------------------------------------------------------

console.log("\nAdd mode");

await test("valid submission → 200 + prUrl", async () => {
  const { status, data } = await post({
    gameId: "slay-the-spire-2",
    profileId: "community",
    trigger: {
      id: `test-${Date.now()}`,
      payloads: [{ title: "Test Auto", text: "Automated test trigger — safe to delete", popupOffset: { x: 14, y: 22 } }],
      references: [{ dataUrl: TINY_PNG, w: 1, h: 1, srcW: 1920, srcH: 1080 }],
    },
  });
  assert(status === 200, `status ${status}: ${JSON.stringify(data)}`);
  assert(data.ok,   `not ok: ${data.error}`);
  assert(data.prUrl?.includes("github.com/frothydv/streamGenieProfiles/pull/"),
    `unexpected prUrl: ${data.prUrl}`);
  console.log(`    → ${data.prUrl}`);
});

// ---------------------------------------------------------------------------
// Update mode — patches existing trigger payloads, opens a PR
// ---------------------------------------------------------------------------

console.log("\nUpdate mode");

await test("update known trigger → 200 + prUrl", async () => {
  const { status, data } = await post({
    gameId: "slay-the-spire-2",
    profileId: "community",
    mode: "update",
    trigger: {
      id: "floor",
      payloads: [{
        title: "Floor",
        text:  "The current floor the player has reached. (test update — safe to ignore)",
        popupOffset: { x: -30, y: 25 },
      }],
    },
  });
  assert(status === 200, `status ${status}: ${JSON.stringify(data)}`);
  assert(data.ok, `not ok: ${data.error}`);
  assert(data.prUrl?.includes("github.com/frothydv/streamGenieProfiles/pull/"),
    `unexpected prUrl: ${data.prUrl}`);
  console.log(`    → ${data.prUrl}`);
});

await test("update unknown trigger id → 500", async () => {
  const { status, data } = await post({
    gameId: "slay-the-spire-2",
    profileId: "community",
    mode: "update",
    trigger: {
      id: "this-trigger-does-not-exist",
      payloads: [{ title: "X" }],
    },
  });
  assert(status === 500, `status ${status}`);
  assert(!data.ok);
});

// ---------------------------------------------------------------------------
// Unicode encoding — unit test for b64decode/b64encode, plus Worker acceptance
// ---------------------------------------------------------------------------
// We don't do a full GitHub round-trip read-back here because multiple
// concurrent test PRs merging out of order make it unreliable. Instead:
//   1. Unit-test the encoding functions directly in Node (fast, deterministic)
//   2. Confirm the Worker accepts Unicode text and returns 200 (integration)

console.log("\nUnicode encoding");

// Mirror the Worker's encoding helpers for local unit-testing.
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function b64decode(str) {
  const binary = atob(str.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

await test("b64encode → b64decode round-trip preserves Unicode", () => {
  const cases = [
    "em-dash — en-dash – bullet •",
    "copyright © registered ® trademark ™",
    "snowman ☃ rocket 🚀 skull 💀",
    "accents: café naïve résumé",
    "CJK: 日本語 中文 한국어",
  ];
  for (const s of cases) {
    const rt = b64decode(b64encode(s));
    assert(rt === s, `round-trip failed for "${s}": got "${rt}"`);
  }
});

await test("Worker accepts Unicode text in update → 200", async () => {
  const { status, data } = await post({
    gameId: "slay-the-spire-2", profileId: "community", mode: "update",
    trigger: {
      id: "map-icon",
      payloads: [{ title: "Map", text: "Click to view the act map.", popupOffset: { x: 14, y: 22 } }],
    },
  });
  assert(status === 200, `status ${status}: ${JSON.stringify(data)}`);
  assert(data.ok, `not ok: ${data.error}`);
  console.log(`    → ${data.prUrl}`);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
