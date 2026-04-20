#!/usr/bin/env node
// End-to-end tests for the submit-trigger worker logic.
// Extracts the core functions (mirrors workers/submit-trigger/index.js exactly)
// and exercises them against a mock GitHub client so no real API calls are made.
// Run with: node tests/worker-submit.js

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => { console.log(`  ✓ ${name}`); passed++; },
        (err) => { console.log(`  ✗ ${name}: ${err.message}`); failed++; }
      );
    }
    console.log(`  ✓ ${name}`); passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`); failed++;
  }
  return Promise.resolve();
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEqual(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---------------------------------------------------------------------------
// Functions copied verbatim from workers/submit-trigger/index.js
// ---------------------------------------------------------------------------

const OWNER = "frothydv";
const REPO  = "streamGenieProfiles";
const BASE  = "main";

function b64decode(str) {
  const binary = atob(str.replace(/\n/g, ""));
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary  = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function normalisedPayloads(payloads) {
  return payloads.map(p => ({
    title:       p.title       ?? "",
    text:        p.text        ?? "",
    image:       null,
    popupOffset: p.popupOffset ?? { x: 14, y: 22 },
  }));
}

function prBody(intro, gameId, profileId, extras = []) {
  return [intro, "", `**Game:** ${gameId}`, `**Profile:** ${profileId}`, ...extras].join("\n");
}

function contributorHint(key) {
  if (!key) return "anonymous";
  return key.replace(/-/g, "").slice(0, 8);
}

async function isTrustedContributor(env, key, gameId, profileId) {
  if (!key || !env.CONTRIBUTOR_KEYS) return false;
  try {
    const value = await env.CONTRIBUTOR_KEYS.get(key);
    if (!value) return false;
    const data = JSON.parse(value);
    return data.gameId === gameId && data.profileId === profileId;
  } catch { return false; }
}

async function getMainSha(gh) {
  const { object: { sha } } = await gh(`repos/${OWNER}/${REPO}/git/refs/heads/${BASE}`, "GET");
  return sha;
}

async function readProfile(gh, profilePath, ref) {
  const file = await gh(
    `repos/${OWNER}/${REPO}/contents/${profilePath}/profile.json?ref=${ref}`, "GET"
  );
  const profile = JSON.parse(b64decode(file.content));
  return { file, profile };
}

async function writeProfile(gh, profilePath, profile, sha, branch, message) {
  const body = { message, content: b64encode(JSON.stringify(profile, null, 2)), sha };
  if (branch) body.branch = branch;
  await gh(`repos/${OWNER}/${REPO}/contents/${profilePath}/profile.json`, "PUT", body);
}

async function addTrigger(gh, gameId, profileId, trigger, direct, hint) {
  const profilePath = `games/${gameId}/profiles/${profileId}`;
  const rawId = (trigger.payloads[0]?.title || trigger.id || Date.now().toString())
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const triggerId = `${rawId}-${Date.now()}`;
  const branch = direct ? null : `trigger/${triggerId}`;

  if (!direct) {
    const baseSha = await getMainSha(gh);
    await gh(`repos/${OWNER}/${REPO}/git/refs`, "POST", {
      ref: `refs/heads/${branch}`, sha: baseSha,
    });
  }

  const profileRefs = [];
  for (let i = 0; i < trigger.references.length; i++) {
    const ref      = trigger.references[i];
    const imageB64 = ref.dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const suffix   = trigger.references.length > 1 ? `-${i}` : "";
    const filename = `${triggerId}${suffix}.png`;
    const filePath = `${profilePath}/references/${filename}`;
    const fileBody = { message: `feat: add reference image ${filename}`, content: imageB64 };
    if (branch) fileBody.branch = branch;
    await gh(`repos/${OWNER}/${REPO}/contents/${filePath}`, "PUT", fileBody);
    profileRefs.push({
      file: filename,
      w: ref.w ?? null,
      h: ref.h ?? null,
      srcW: ref.srcW ?? null,
      srcH: ref.srcH ?? null,
      maskDataUrl: ref.maskDataUrl ?? null,
    });
  }

  const { file: profileFile, profile } = await readProfile(gh, profilePath, branch || BASE);
  const newTrigger = {
    id:         rawId,
    payloads:   normalisedPayloads(trigger.payloads),
    references: profileRefs,
  };
  profile.triggers.push(newTrigger);

  const title = newTrigger.payloads[0]?.title || rawId;
  await writeProfile(gh, profilePath, profile, profileFile.sha, branch,
    `feat: add trigger "${title}" [contributor: ${hint}]`);

  if (direct) return { direct: true };

  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, "POST", {
    title: `Add trigger: ${title}`,
    body:  prBody("New trigger submitted via Stream Genie.", gameId, profileId, [`**Payloads:** ${trigger.payloads.length}`]),
    head:  branch, base: BASE,
  });
  return { prUrl: pr.html_url };
}

async function updateTrigger(gh, gameId, profileId, trigger, direct, hint) {
  const profilePath = `games/${gameId}/profiles/${profileId}`;
  const triggerId   = trigger.id;
  const branch      = direct ? null : `update/${triggerId}-${Date.now()}`;

  if (!direct) {
    const baseSha = await getMainSha(gh);
    await gh(`repos/${OWNER}/${REPO}/git/refs`, "POST", {
      ref: `refs/heads/${branch}`, sha: baseSha,
    });
  }

  const { file: profileFile, profile } = await readProfile(gh, profilePath, branch || BASE);
  const idx = profile.triggers.findIndex(t => t.id === triggerId);
  if (idx === -1) throw new Error(`Trigger "${triggerId}" not found in profile`);

  const nextTrigger = { ...profile.triggers[idx], payloads: normalisedPayloads(trigger.payloads) };
  if (trigger.references?.length) {
    nextTrigger.references = trigger.references.map((ref, idx2) => ({
      ...(profile.triggers[idx].references?.[idx2] || {}),
      file: ref.file ?? profile.triggers[idx].references?.[idx2]?.file ?? null,
      w: ref.w ?? profile.triggers[idx].references?.[idx2]?.w ?? null,
      h: ref.h ?? profile.triggers[idx].references?.[idx2]?.h ?? null,
      srcW: ref.srcW ?? profile.triggers[idx].references?.[idx2]?.srcW ?? null,
      srcH: ref.srcH ?? profile.triggers[idx].references?.[idx2]?.srcH ?? null,
      maskDataUrl: ref.maskDataUrl ?? null,
    }));
  }
  profile.triggers[idx] = nextTrigger;
  const title = trigger.payloads[0]?.title || triggerId;

  await writeProfile(gh, profilePath, profile, profileFile.sha, branch,
    `fix: update trigger "${title}" [contributor: ${hint}]`);

  if (direct) return { direct: true };

  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, "POST", {
    title: `Update trigger: ${title}`,
    body:  prBody("Proposed update via Stream Genie.", gameId, profileId, [`**Trigger ID:** ${triggerId}`]),
    head:  branch, base: BASE,
  });
  return { prUrl: pr.html_url };
}

async function removeTrigger(gh, gameId, profileId, trigger, direct, hint) {
  const profilePath = `games/${gameId}/profiles/${profileId}`;
  const triggerId   = trigger.id;
  const branch      = direct ? null : `remove/${triggerId}-${Date.now()}`;

  if (!direct) {
    const baseSha = await getMainSha(gh);
    await gh(`repos/${OWNER}/${REPO}/git/refs`, "POST", {
      ref: `refs/heads/${branch}`, sha: baseSha,
    });
  }

  const { file: profileFile, profile } = await readProfile(gh, profilePath, branch || BASE);
  const idx = profile.triggers.findIndex(t => t.id === triggerId);
  if (idx === -1) throw new Error(`Trigger "${triggerId}" not found in profile`);

  const removed = profile.triggers.splice(idx, 1)[0];
  const title   = removed.payloads?.[0]?.title || triggerId;

  await writeProfile(gh, profilePath, profile, profileFile.sha, branch,
    `fix: remove trigger "${title}" [contributor: ${hint}]`);

  if (direct) return { direct: true };

  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, "POST", {
    title: `Remove trigger: ${title}`,
    body:  prBody("Requested removal via Stream Genie.", gameId, profileId, [`**Trigger ID:** ${triggerId}`]),
    head:  branch, base: BASE,
  });
  return { prUrl: pr.html_url };
}

// ---------------------------------------------------------------------------
// Mock GitHub client builder
// Returns { gh, calls } where calls records every API call made.
// profileContent: the profile.json object to return for GET requests.
// ---------------------------------------------------------------------------

function makeGh(profileContent = { triggers: [] }, mainSha = "deadbeef") {
  const calls = [];
  const gh = async (path, method, body) => {
    calls.push({ path: path.split("?")[0], method, body });
    if (method === "GET" && path.includes("/git/refs/heads/")) {
      return { object: { sha: mainSha } };
    }
    if (method === "GET" && path.includes("/contents/") && path.includes("profile.json")) {
      return { sha: "profile-sha-123", content: b64encode(JSON.stringify(profileContent)) };
    }
    if (method === "PUT" && path.includes("/contents/")) {
      return { commit: { sha: "new-sha-456" } };
    }
    if (method === "POST" && path.includes("/git/refs")) {
      return { ref: body?.ref };
    }
    if (method === "POST" && path.includes("/pulls")) {
      return { html_url: "https://github.com/frothydv/streamGenieProfiles/pull/99" };
    }
    throw new Error(`Unexpected gh call: ${method} ${path}`);
  };
  return { gh, calls };
}

const SAMPLE_TRIGGER = {
  id: "user-1776700000000",
  payloads: [{ title: "Ice Cream", text: "Gain 3 Energy at start of each turn." }],
  references: [{ dataUrl: "data:image/png;base64,iVBORw0KGgo=", maskDataUrl: "data:image/png;base64,mask123", w: 40, h: 40, srcW: 1920, srcH: 1080 }],
};

const PROFILE_WITH_TRIGGER = {
  triggers: [
    {
      id: "existing-trigger",
      payloads: [{ title: "Old Title", text: "Old text", image: null, popupOffset: { x: 14, y: 22 } }],
      references: [{ file: "existing-1234.png", maskDataUrl: null, w: 30, h: 30, srcW: 1920, srcH: 1080 }],
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. addTrigger — trusted (direct commit to main)
// ---------------------------------------------------------------------------

console.log("\n— addTrigger (trusted → direct commit) ---");

await test("image PUT goes to main (no branch field)", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  const imgPut = calls.find(c => c.method === "PUT" && c.path.includes("/references/"));
  assert(imgPut, "should PUT image");
  assert(!imgPut.body.branch, "image PUT should not have a branch field (commits to default/main)");
});

await test("profile.json read from main", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  const read = calls.find(c => c.method === "GET" && c.path.includes("profile.json"));
  assert(read, "should GET profile.json");
  assert(read.path.includes("?ref=") === false || read.path.includes("main"), "should read from main");
});

await test("profile.json write goes to main (no branch field)", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  assert(write, "should PUT profile.json");
  assert(!write.body.branch, "profile write should not have a branch field");
});

await test("profile.json write uses correct SHA from read", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  assertEqual(write.body.sha, "profile-sha-123");
});

await test("new trigger appears in written profile", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  const written = JSON.parse(b64decode(write.body.content));
  const added = written.triggers.find(t => t.id === "ice-cream");
  assert(added, "should contain the new trigger with id 'ice-cream'");
  assertEqual(added.payloads[0].title, "Ice Cream");
});

await test("trigger references list references uploaded image filename", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  const written = JSON.parse(b64decode(write.body.content));
  const added = written.triggers.find(t => t.id === "ice-cream");
  assert(added.references[0].file.startsWith("ice-cream-"), "reference filename should start with trigger id");
  assert(added.references[0].file.endsWith(".png"), "reference filename should end with .png");
});

await test("new trigger preserves maskDataUrl in profile.json", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  const written = JSON.parse(b64decode(write.body.content));
  const added = written.triggers.find(t => t.id === "ice-cream");
  assertEqual(added.references[0].maskDataUrl, "data:image/png;base64,mask123");
});

await test("commit message includes title and contributor hint", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  assert(write.body.message.includes("Ice Cream"), "commit message should contain trigger title");
  assert(write.body.message.includes("f61d1f28"), "commit message should contain contributor hint");
});

await test("returns { direct: true }", async () => {
  const { gh } = makeGh();
  const result = await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  assertEqual(result, { direct: true });
});

await test("no branch is created for trusted submission", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "f61d1f28");
  const branchCreate = calls.find(c => c.method === "POST" && c.path.includes("/git/refs"));
  assert(!branchCreate, "should not create a branch for trusted submission");
});

// ---------------------------------------------------------------------------
// 2. addTrigger — untrusted (PR path)
// ---------------------------------------------------------------------------

console.log("\n— addTrigger (untrusted → PR) ---");

await test("creates branch from main SHA", async () => {
  const { gh, calls } = makeGh({ triggers: [] }, "main-sha-aaa");
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, false, "anonymous");
  const branchCreate = calls.find(c => c.method === "POST" && c.path.includes("/git/refs"));
  assert(branchCreate, "should create a branch");
  assertEqual(branchCreate.body.sha, "main-sha-aaa");
  assert(branchCreate.body.ref.startsWith("refs/heads/trigger/"), "branch should be under refs/heads/trigger/");
});

await test("image PUT targets the new branch", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, false, "anonymous");
  const imgPut = calls.find(c => c.method === "PUT" && c.path.includes("/references/"));
  assert(imgPut?.body.branch?.startsWith("trigger/"), "image PUT should target the trigger branch");
});

await test("profile.json write targets the new branch", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, false, "anonymous");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  assert(write?.body.branch?.startsWith("trigger/"), "profile write should target the trigger branch");
});

await test("creates PR against main", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, false, "anonymous");
  const pr = calls.find(c => c.method === "POST" && c.path.includes("/pulls"));
  assert(pr, "should create a PR");
  assertEqual(pr.body.base, "main");
  assert(pr.body.head.startsWith("trigger/"), "PR head should be the trigger branch");
  assert(pr.body.title.includes("Ice Cream"), "PR title should include trigger title");
});

await test("returns prUrl from PR creation response", async () => {
  const { gh } = makeGh();
  const result = await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, false, "anonymous");
  assertEqual(result, { prUrl: "https://github.com/frothydv/streamGenieProfiles/pull/99" });
});

// ---------------------------------------------------------------------------
// 3. updateTrigger
// ---------------------------------------------------------------------------

console.log("\n— updateTrigger ---");

await test("patches payloads of existing trigger (trusted)", async () => {
  const { gh, calls } = makeGh(PROFILE_WITH_TRIGGER);
  const update = { id: "existing-trigger", payloads: [{ title: "New Title", text: "New text." }] };
  await updateTrigger(gh, "slay-the-spire-2", "community", update, true, "f61d1f28");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  const written = JSON.parse(b64decode(write.body.content));
  assertEqual(written.triggers[0].payloads[0].title, "New Title");
});

await test("throws if trigger id not found in profile", async () => {
  const { gh } = makeGh(PROFILE_WITH_TRIGGER);
  const update = { id: "nonexistent", payloads: [{ title: "X", text: "Y" }] };
  try {
    await updateTrigger(gh, "slay-the-spire-2", "community", update, true, "f61d1f28");
    assert(false, "should have thrown");
  } catch (err) {
    assert(err.message.includes("nonexistent"), `expected 'nonexistent' in error, got: ${err.message}`);
  }
});

await test("update untrusted path creates PR", async () => {
  const { gh, calls } = makeGh(PROFILE_WITH_TRIGGER);
  const update = { id: "existing-trigger", payloads: [{ title: "New Title", text: "New text." }] };
  const result = await updateTrigger(gh, "slay-the-spire-2", "community", update, false, "anon");
  const pr = calls.find(c => c.method === "POST" && c.path.includes("/pulls"));
  assert(pr, "should create PR");
  assert(result.prUrl, "should return prUrl");
});

await test("updateTrigger can patch maskDataUrl on existing references", async () => {
  const { gh, calls } = makeGh(PROFILE_WITH_TRIGGER);
  const update = {
    id: "existing-trigger",
    payloads: [{ title: "New Title", text: "New text." }],
    references: [{ file: "existing-1234.png", maskDataUrl: "data:image/png;base64,newmask", w: 30, h: 30, srcW: 1920, srcH: 1080 }],
  };
  await updateTrigger(gh, "slay-the-spire-2", "community", update, true, "f61d1f28");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  const written = JSON.parse(b64decode(write.body.content));
  assertEqual(written.triggers[0].references[0].maskDataUrl, "data:image/png;base64,newmask");
  assertEqual(written.triggers[0].references[0].file, "existing-1234.png");
});

// ---------------------------------------------------------------------------
// 4. removeTrigger
// ---------------------------------------------------------------------------

console.log("\n— removeTrigger ---");

await test("removes trigger from profile (trusted)", async () => {
  const { gh, calls } = makeGh(PROFILE_WITH_TRIGGER);
  await removeTrigger(gh, "slay-the-spire-2", "community", { id: "existing-trigger" }, true, "f61d1f28");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  const written = JSON.parse(b64decode(write.body.content));
  assertEqual(written.triggers.length, 0);
});

await test("throws if trigger id not found", async () => {
  const { gh } = makeGh(PROFILE_WITH_TRIGGER);
  try {
    await removeTrigger(gh, "slay-the-spire-2", "community", { id: "missing" }, true, "f61d1f28");
    assert(false, "should have thrown");
  } catch (err) {
    assert(err.message.includes("missing"), `expected 'missing' in error, got: ${err.message}`);
  }
});

await test("remove untrusted path creates PR", async () => {
  const { gh } = makeGh(PROFILE_WITH_TRIGGER);
  const result = await removeTrigger(gh, "slay-the-spire-2", "community", { id: "existing-trigger" }, false, "anon");
  assert(result.prUrl, "should return prUrl");
});

// ---------------------------------------------------------------------------
// 5. normalisedPayloads
// ---------------------------------------------------------------------------

console.log("\n— normalisedPayloads ---");

test("fills missing fields with defaults", () => {
  const result = normalisedPayloads([{ title: "X" }]);
  assertEqual(result[0].text, "");
  assertEqual(result[0].image, null);
  assertEqual(result[0].popupOffset, { x: 14, y: 22 });
});

test("preserves present fields", () => {
  const result = normalisedPayloads([{ title: "T", text: "B", popupOffset: { x: 5, y: 10 } }]);
  assertEqual(result[0].title, "T");
  assertEqual(result[0].text, "B");
  assertEqual(result[0].popupOffset, { x: 5, y: 10 });
});

test("multiple payloads all normalised", () => {
  const result = normalisedPayloads([{ title: "A" }, { title: "B", text: "X" }]);
  assertEqual(result.length, 2);
  assertEqual(result[1].text, "X");
  assertEqual(result[1].image, null);
});

// ---------------------------------------------------------------------------
// 6. isTrustedContributor
// ---------------------------------------------------------------------------

console.log("\n— isTrustedContributor ---");

function makeKv(entries = {}) {
  return { get: async (key) => entries[key] || null };
}

await test("null key → not trusted", async () => {
  const env = { CONTRIBUTOR_KEYS: makeKv() };
  assertEqual(await isTrustedContributor(env, null, "g", "p"), false);
});

await test("key not in KV → not trusted", async () => {
  const env = { CONTRIBUTOR_KEYS: makeKv() };
  assertEqual(await isTrustedContributor(env, "unknown-uuid", "g", "p"), false);
});

await test("key in KV, game and profile match → trusted", async () => {
  const uuid = "f61d1f28-1234-5678-abcd-000000000000";
  const env = { CONTRIBUTOR_KEYS: makeKv({
    [uuid]: JSON.stringify({ gameId: "slay-the-spire-2", profileId: "community", label: "owner", createdAt: "2024-01-01" }),
  })};
  assertEqual(await isTrustedContributor(env, uuid, "slay-the-spire-2", "community"), true);
});

await test("key in KV but wrong profileId → not trusted", async () => {
  const uuid = "f61d1f28-1234-5678-abcd-000000000000";
  const env = { CONTRIBUTOR_KEYS: makeKv({
    [uuid]: JSON.stringify({ gameId: "slay-the-spire-2", profileId: "community", label: "owner", createdAt: "2024-01-01" }),
  })};
  assertEqual(await isTrustedContributor(env, uuid, "slay-the-spire-2", "sts2-test"), false);
});

await test("key in KV but wrong gameId → not trusted", async () => {
  const uuid = "f61d1f28-1234-5678-abcd-000000000000";
  const env = { CONTRIBUTOR_KEYS: makeKv({
    [uuid]: JSON.stringify({ gameId: "slay-the-spire-2", profileId: "community", label: "owner", createdAt: "2024-01-01" }),
  })};
  assertEqual(await isTrustedContributor(env, uuid, "starcraft-ii", "community"), false);
});

await test("no CONTRIBUTOR_KEYS binding → not trusted", async () => {
  const env = {};
  assertEqual(await isTrustedContributor(env, "any-key", "g", "p"), false);
});

await test("KV value is malformed JSON → not trusted (no crash)", async () => {
  const uuid = "bad-json-uuid";
  const env = { CONTRIBUTOR_KEYS: makeKv({ [uuid]: "not json" }) };
  assertEqual(await isTrustedContributor(env, uuid, "g", "p"), false);
});

// ---------------------------------------------------------------------------
// 7. contributorHint
// ---------------------------------------------------------------------------

console.log("\n— contributorHint ---");

test("null key → 'anonymous'", () => assertEqual(contributorHint(null), "anonymous"));
test("undefined key → 'anonymous'", () => assertEqual(contributorHint(undefined), "anonymous"));
test("UUID → 8-char hex with no dashes", () => {
  const hint = contributorHint("f61d1f28-0000-0000-0000-000000000000");
  assertEqual(hint, "f61d1f28");
});

// ---------------------------------------------------------------------------
// 8. Profile path construction
// ---------------------------------------------------------------------------

console.log("\n— Profile path construction ---");

await test("addTrigger writes to correct gameId/profileId path", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "starcraft-ii", "community", SAMPLE_TRIGGER, true, "hint");
  const write = calls.find(c => c.method === "PUT" && c.path.includes("profile.json"));
  assert(write.path.includes("games/starcraft-ii/profiles/community"), "path should include game/profile");
});

await test("image is stored under the profile's references/ directory", async () => {
  const { gh, calls } = makeGh();
  await addTrigger(gh, "slay-the-spire-2", "community", SAMPLE_TRIGGER, true, "hint");
  const imgPut = calls.find(c => c.method === "PUT" && c.path.includes("/references/"));
  assert(imgPut.path.includes("games/slay-the-spire-2/profiles/community/references/"), "wrong path");
});

// ---------------------------------------------------------------------------

// Wait for all async tests to settle
await new Promise(r => setTimeout(r, 50));
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
