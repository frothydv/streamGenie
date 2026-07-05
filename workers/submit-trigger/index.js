/**
 * Stream Genie — Submit Trigger Worker
 *
 * POST /  { gameId, profileId, trigger, mode? }
 * Headers: X-Submit-Secret: <secret>
 *          X-Contributor-Key: <uuid>   (optional — unlocks direct-commit path)
 *
 * Modes:
 *   "add"            — add trigger; trusted → direct commit, untrusted → PR
 *   "update"         — patch trigger payloads; trusted → direct, untrusted → PR
 *   "remove"         — delete trigger; trusted → direct, untrusted → PR
 *   "create-profile" — create new profile stub + catalog entry; always direct;
 *                      returns a contributor code for the new profile
 *   "verify"         — check if X-Contributor-Key is trusted for gameId/profileId
 *
 * KV (CONTRIBUTOR_KEYS):
 *   key:   UUID contributor code
 *   value: JSON { gameId, profileId, label, createdAt }
 *
 * Secrets (set via `wrangler secret put`):
 *   GITHUB_TOKEN   — PAT with repo write access to streamGenieProfiles
 *   SUBMIT_SECRET  — shared secret the extension sends in X-Submit-Secret
 */

const OWNER = "frothydv";
const REPO  = "streamGenieProfiles";
const BASE  = "main";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Submit-Secret, X-Contributor-Key",
};

// ---------------------------------------------------------------------------
// Input validation
//
// The submit secret ships inside the extension, so anyone can extract it and
// craft raw requests. Every ID below is interpolated into GitHub API paths —
// an unvalidated gameId like "../.github/workflows" would let an attacker
// write arbitrary files anywhere in the repo. Reject anything that isn't a
// plain slug, and cap sizes so a hostile client can't bloat profile.json
// (which every viewer downloads) or the references folder.
// ---------------------------------------------------------------------------

const ID_RE       = /^[a-z0-9][a-z0-9-]{0,63}$/;           // gameId, profileId, twitchSlug
const TRIG_ID_RE  = /^[a-z0-9][a-z0-9-]{0,99}$/;           // trigger IDs (slug-ts-rand)
const BRANCH_RE   = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,120}$/;  // branches this worker created
const REF_FILE_RE = /^[a-z0-9][a-z0-9-]{0,99}\.png$/;      // reference filenames on disk
const IMG_URL_RE  = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const LIMITS = {
  title: 120,                 // payload title chars
  text: 2000,                 // payload body chars
  name: 80,                   // gameName / profileName chars
  payloads: 5,
  references: 3,
  imageB64: 1_500_000,        // ~1.1 MB decoded reference image
  maskB64: 600_000,           // masks are stored inline in profile.json
  triggersPerProfile: 500,
};

// Returns an error string, or null if the trigger is acceptable.
function validateTriggerInput(trigger, mode) {
  if (mode !== "add" && !TRIG_ID_RE.test(trigger.id || "")) return "Invalid trigger id";
  if (mode === "remove") return null;

  const payloads = trigger.payloads;
  if (!Array.isArray(payloads) || payloads.length < 1 || payloads.length > LIMITS.payloads)
    return `payloads must be an array of 1–${LIMITS.payloads} entries`;
  for (const p of payloads) {
    if (p == null || typeof p !== "object")   return "each payload must be an object";
    if (p.title != null && (typeof p.title !== "string" || p.title.length > LIMITS.title))
      return `payload title must be a string of ≤${LIMITS.title} chars`;
    if (p.text != null && (typeof p.text !== "string" || p.text.length > LIMITS.text))
      return `payload text must be a string of ≤${LIMITS.text} chars`;
  }

  const refs = trigger.references || [];
  if (!Array.isArray(refs) || refs.length > LIMITS.references)
    return `references must be an array of ≤${LIMITS.references} entries`;
  for (const r of refs) {
    if (r == null || typeof r !== "object") return "each reference must be an object";
    if (r.dataUrl != null) {
      if (typeof r.dataUrl !== "string" || r.dataUrl.length > LIMITS.imageB64)
        return "reference image too large";
      if (!IMG_URL_RE.test(r.dataUrl))
        return "reference image must be a png/jpeg/webp data URL";
    }
    if (r.maskDataUrl != null) {
      if (typeof r.maskDataUrl !== "string" || r.maskDataUrl.length > LIMITS.maskB64)
        return "mask image too large";
      if (!IMG_URL_RE.test(r.maskDataUrl))
        return "mask must be a png/jpeg/webp data URL";
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST" && request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

    if (request.headers.get("X-Submit-Secret") !== env.SUBMIT_SECRET) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    let body;
    try { body = request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await request.json(); }
    catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const {
      gameId, profileId, trigger, mode = "add",
      gameName, twitchSlug, newProfileId, newProfileName,
    } = body;

    const contributorKey = request.headers.get("X-Contributor-Key") || null;

    // Slug validation up front — these values feed GitHub API paths in every
    // mode. Presence is checked per-mode below; here we only reject bad shapes.
    if (gameId       != null && !ID_RE.test(gameId))       return json({ ok: false, error: "Invalid gameId" }, 400);
    if (profileId    != null && !ID_RE.test(profileId))    return json({ ok: false, error: "Invalid profileId" }, 400);
    if (newProfileId != null && !ID_RE.test(newProfileId)) return json({ ok: false, error: "Invalid newProfileId" }, 400);
    if (twitchSlug   != null && !ID_RE.test(twitchSlug))   return json({ ok: false, error: "Invalid twitchSlug" }, 400);
    if (gameName       != null && (typeof gameName !== "string" || gameName.length > LIMITS.name))
      return json({ ok: false, error: `Invalid gameName (max ${LIMITS.name} chars)` }, 400);
    if (newProfileName != null && (typeof newProfileName !== "string" || newProfileName.length > LIMITS.name))
      return json({ ok: false, error: `Invalid newProfileName (max ${LIMITS.name} chars)` }, 400);

    // --- activate mode (anonymous usage ping) --------------------------------
    if (mode === "activate") {
      if (!gameId || !profileId) return json({ ok: false, error: "Missing gameId/profileId" }, 400);
      try {
        let timesUsed = 1;
        if (env.PROFILE_STATS) {
          const key = `timesUsed:${gameId}:${profileId}`;
          const current = await env.PROFILE_STATS.get(key);
          timesUsed = parseInt(current || "0", 10) + 1;
          await env.PROFILE_STATS.put(key, String(timesUsed));
        }
        const gh = githubClient(env.GITHUB_TOKEN);
        await updateCatalogStats(gh, gameId, profileId, { timesUsed });
        return json({ ok: true, timesUsed });
      } catch (err) {
        console.error("activate failed:", err.message);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // --- verify mode --------------------------------------------------------
    if (mode === "verify") {
      if (!gameId || !profileId) return json({ ok: false, error: "Missing gameId/profileId" }, 400);
      const trusted = await isTrustedContributor(env, contributorKey, gameId, profileId);
      return json({ ok: true, trusted });
    }

    // --- reissue-code mode (admin only) ---------------------------------------
    // Recovery path for lost contributor codes. Codes live only in KV and the
    // contributor's browser storage; a dead PC loses the local copy. The
    // maintainer verifies the requester out-of-band (e.g. they comment from the
    // GitHub account whose PRs seeded the profile, or they're known in the
    // community), then reissues. All existing codes for the profile are revoked
    // by default so a stolen machine can't keep committing.
    // Gated on env.ADMIN_KEY (wrangler secret) via X-Admin-Key — never ships in
    // the extension. Absent secret = op disabled.
    if (mode === "reissue-code") {
      const adminKey = request.headers.get("X-Admin-Key");
      if (!env.ADMIN_KEY || !adminKey || adminKey !== env.ADMIN_KEY) {
        return json({ ok: false, error: "Unauthorized" }, 403);
      }
      if (!gameId || !profileId) return json({ ok: false, error: "Missing gameId/profileId" }, 400);
      if (!env.CONTRIBUTOR_KEYS) return json({ ok: false, error: "KV not configured" }, 500);
      try {
        let revoked = 0;
        if (body.revokeOld !== false) {
          const list = await env.CONTRIBUTOR_KEYS.list({ limit: 1000 });
          for (const k of list.keys) {
            try {
              const data = JSON.parse(await env.CONTRIBUTOR_KEYS.get(k.name));
              if (data && data.gameId === gameId && data.profileId === profileId) {
                await env.CONTRIBUTOR_KEYS.delete(k.name);
                revoked++;
              }
            } catch { /* unparsable entry — leave it */ }
          }
        }
        const code = crypto.randomUUID();
        await env.CONTRIBUTOR_KEYS.put(code, JSON.stringify({
          gameId, profileId,
          label: typeof body.label === "string" ? body.label.slice(0, 80) : "reissued",
          createdAt: new Date().toISOString(),
        }));
        return json({ ok: true, code, revoked });
      } catch (err) {
        console.error("reissue-code failed:", err.message);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // --- list-proposals mode ------------------------------------------------
    if (mode === "list-proposals") {
      if (!gameId || !profileId) return json({ ok: false, error: "Missing gameId/profileId" }, 400);
      const trusted = await isTrustedContributor(env, contributorKey, gameId, profileId);
      if (!trusted) return json({ ok: false, error: "Unauthorized" }, 403);
      try {
        const gh = githubClient(env.GITHUB_TOKEN);
        const proposals = await listProposals(gh, gameId, profileId);
        return json({ ok: true, proposals });
      } catch (err) {
        console.error("listProposals failed:", err.message);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // --- accept-proposal mode -----------------------------------------------
    if (mode === "accept-proposal") {
      if (!gameId || !profileId) return json({ ok: false, error: "Missing gameId/profileId" }, 400);
      const trusted = await isTrustedContributor(env, contributorKey, gameId, profileId);
      if (!trusted) return json({ ok: false, error: "Unauthorized" }, 403);
      const { prNumber, branch, trigger: editedTrigger } = body;
      if (!prNumber || !branch) return json({ ok: false, error: "Missing prNumber or branch" }, 400);
      if (!Number.isInteger(Number(prNumber)) || Number(prNumber) < 1)
        return json({ ok: false, error: "Invalid prNumber" }, 400);
      if (!BRANCH_RE.test(branch) || branch.includes(".."))
        return json({ ok: false, error: "Invalid branch" }, 400);
      if (editedTrigger) {
        const vErr = validateTriggerInput(editedTrigger, "update");
        if (vErr) return json({ ok: false, error: vErr }, 400);
      }
      try {
        const gh   = githubClient(env.GITHUB_TOKEN);
        const hint = contributorHint(contributorKey);
        await acceptProposal(gh, gameId, profileId, prNumber, branch, editedTrigger || null, hint);
        return json({ ok: true });
      } catch (err) {
        console.error("acceptProposal failed:", err.message);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // --- reject-proposal mode -----------------------------------------------
    if (mode === "reject-proposal") {
      if (!gameId || !profileId) return json({ ok: false, error: "Missing gameId/profileId" }, 400);
      const trusted = await isTrustedContributor(env, contributorKey, gameId, profileId);
      if (!trusted) return json({ ok: false, error: "Unauthorized" }, 403);
      const { prNumber, comment } = body;
      if (!prNumber) return json({ ok: false, error: "Missing prNumber" }, 400);
      if (!Number.isInteger(Number(prNumber)) || Number(prNumber) < 1)
        return json({ ok: false, error: "Invalid prNumber" }, 400);
      if (comment != null && (typeof comment !== "string" || comment.length > 2000))
        return json({ ok: false, error: "Invalid comment (max 2000 chars)" }, 400);
      try {
        const gh = githubClient(env.GITHUB_TOKEN);
        await rejectProposal(gh, prNumber, comment || null);
        return json({ ok: true });
      } catch (err) {
        console.error("rejectProposal failed:", err.message);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // --- create-profile mode ------------------------------------------------
    if (mode === "create-profile") {
      if (!gameId || !gameName || !newProfileId) {
        return json({ ok: false, error: "Missing gameId, gameName, or newProfileId" }, 400);
      }
      if (!await checkRateLimit(env, request, "create-profile", 5)) {
        return json({ ok: false, error: "Rate limit exceeded — try again later" }, 429);
      }
      try {
        const gh = githubClient(env.GITHUB_TOKEN);
        const result = await createProfile(gh, env, gameId, gameName, twitchSlug || gameId, newProfileId, newProfileName || newProfileId);
        return json({ ok: true, ...result });
      } catch (err) {
        console.error("createProfile failed:", err.message);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // --- trigger modes (add / update / remove) ------------------------------
    if (!gameId || !profileId || !trigger) {
      return json({ ok: false, error: "Missing required fields" }, 400);
    }
    if (mode !== "remove" && !trigger.payloads) {
      return json({ ok: false, error: "Missing trigger payloads" }, 400);
    }
    if (mode === "add") {
      if (!trigger.references?.length)      return json({ ok: false, error: "Missing references array" }, 400);
      if (!trigger.references[0]?.dataUrl)  return json({ ok: false, error: "Missing reference image" }, 400);
    }
    if ((mode === "update" || mode === "remove") && !trigger.id) {
      return json({ ok: false, error: `Missing trigger id for ${mode}` }, 400);
    }
    {
      const vErr = validateTriggerInput(trigger, mode);
      if (vErr) return json({ ok: false, error: vErr }, 400);
    }

    const trusted = await isTrustedContributor(env, contributorKey, gameId, profileId);
    const hint    = contributorHint(contributorKey);

    if (!trusted && !await checkRateLimit(env, request, "write", 20)) {
      return json({ ok: false, error: "Rate limit exceeded — try again later" }, 429);
    }

    try {
      const gh = githubClient(env.GITHUB_TOKEN);
      const result = mode === "update"
        ? await updateTrigger(gh, gameId, profileId, trigger, trusted, hint)
        : mode === "remove"
          ? await removeTrigger(gh, gameId, profileId, trigger, trusted, hint)
          : await addTrigger(gh, gameId, profileId, trigger, trusted, hint);
      return json({ ok: true, ...result });
    } catch (err) {
      console.error(`${mode}Trigger failed:`, err.message);
      return json({ ok: false, error: err.message }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

async function isTrustedContributor(env, key, gameId, profileId) {
  if (!key || !env.CONTRIBUTOR_KEYS) return false;
  try {
    const value = await env.CONTRIBUTOR_KEYS.get(key);
    if (!value) return false;
    const data = JSON.parse(value);
    return data.gameId === gameId && data.profileId === profileId;
  } catch { return false; }
}

// Returns true if under limit, false if limit exceeded.
// Uses PROFILE_STATS KV with rl: prefix; allows through on KV error.
async function checkRateLimit(env, request, bucket, limit) {
  if (!env.PROFILE_STATS) return true;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const hour = Math.floor(Date.now() / (60 * 60 * 1000));
  const key = `rl:${bucket}:${ip}:${hour}`;
  try {
    const current = parseInt(await env.PROFILE_STATS.get(key) || "0", 10);
    if (current >= limit) return false;
    await env.PROFILE_STATS.put(key, String(current + 1), { expirationTtl: 7200 });
    return true;
  } catch { return true; }
}

function contributorHint(key) {
  if (!key) return "anonymous";
  return key.replace(/-/g, "").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Trigger operations (trusted = direct commit to main; untrusted = PR)
// ---------------------------------------------------------------------------

async function addTrigger(gh, gameId, profileId, trigger, direct, hint) {
  const profilePath = `games/${gameId}/profiles/${profileId}`;
  const rawId = (trigger.payloads[0]?.title || trigger.id || Date.now().toString())
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Append a small random hex suffix to prevent same-millisecond collisions
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 65536).toString(16).padStart(4, "0");
  const triggerId = `${rawId}-${ts}-${rand}`;
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
  if (profile.triggers.length >= LIMITS.triggersPerProfile) {
    throw new Error(`Profile is full (${LIMITS.triggersPerProfile} triggers max)`);
  }
  const rotation = normalisedRotation(trigger.rotation);
  const scale = normalisedScale(trigger.scale);
  const newTrigger = {
    id:         rawId,
    ...(trigger.rotates ? { rotates: true } : {}),
    ...(rotation ? { rotation } : {}),
    ...(scale ? { scale } : {}),
    payloads:   normalisedPayloads(trigger.payloads),
    references: profileRefs,
  };
  // Prevent duplicate IDs: use the unique triggerId (includes timestamp) instead of rawId
  // so even if addTrigger is called again for the same title, IDs won't collide.
  newTrigger.id = triggerId;
  profile.triggers.push(newTrigger);

  const title = newTrigger.payloads[0]?.title || rawId;
  await writeProfile(gh, profilePath, profile, profileFile.sha, branch,
    `feat: add trigger "${title}" [contributor: ${hint}]`);

  if (direct) {
    await updateCatalogStats(gh, gameId, profileId, { triggerCount: profile.triggers.length });
    return { direct: true };
  }

  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, "POST", {
    title: `Add trigger: ${title}`,
    body:  prBody("New trigger submitted via Stream Genie.", gameId, profileId, [`**Action:** add`, `**Trigger ID:** ${triggerId}`]),
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
  if (trigger.rotates) { nextTrigger.rotates = true; } else { delete nextTrigger.rotates; }
  const rotation = normalisedRotation(trigger.rotation);
  if (rotation) { nextTrigger.rotation = rotation; } else { delete nextTrigger.rotation; }
  const scale = normalisedScale(trigger.scale);
  if (scale) { nextTrigger.scale = scale; } else { delete nextTrigger.scale; }
  if (trigger.references?.length) {
    console.log("[worker] Updating references for trigger:", trigger.id);
    console.log("[worker] Original reference:", JSON.stringify(profile.triggers[idx].references?.[0] || {}, null, 2));
    console.log("[worker] New reference data:", JSON.stringify(trigger.references[0], null, 2));

    nextTrigger.references = trigger.references.map((ref, idx2) => ({
      ...(profile.triggers[idx].references?.[idx2] || {}),
      file: ref.file ?? profile.triggers[idx].references?.[idx2]?.file ?? null,
      w: ref.w ?? profile.triggers[idx].references?.[idx2]?.w ?? null,
      h: ref.h ?? profile.triggers[idx].references?.[idx2]?.h ?? null,
      srcW: ref.srcW ?? profile.triggers[idx].references?.[idx2]?.srcW ?? null,
      srcH: ref.srcH ?? profile.triggers[idx].references?.[idx2]?.srcH ?? null,
      maskDataUrl: ref.maskDataUrl ?? null,
    }));

    console.log("[worker] Final reference after merge:", JSON.stringify(nextTrigger.references[0], null, 2));
  }
  profile.triggers[idx] = nextTrigger;
  const title = trigger.payloads[0]?.title || triggerId;

  console.log("[worker] Writing updated profile with trigger:", JSON.stringify(profile.triggers[idx], null, 2));
  await writeProfile(gh, profilePath, profile, profileFile.sha, branch,
    `fix: update trigger "${title}" [contributor: ${hint}]`);

  if (direct) {
    await updateCatalogStats(gh, gameId, profileId, { triggerCount: profile.triggers.length });
    return { direct: true };
  }

  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, "POST", {
    title: `Update trigger: ${title}`,
    body:  prBody("Proposed update via Stream Genie.", gameId, profileId, [`**Action:** update`, `**Trigger ID:** ${triggerId}`]),
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

  if (direct) {
    await updateCatalogStats(gh, gameId, profileId, { triggerCount: profile.triggers.length });
    return { direct: true };
  }

  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, "POST", {
    title: `Remove trigger: ${title}`,
    body:  prBody("Requested removal via Stream Genie.", gameId, profileId, [`**Action:** remove`, `**Trigger ID:** ${triggerId}`]),
    head:  branch, base: BASE,
  });
  return { prUrl: pr.html_url };
}

async function createProfile(gh, env, gameId, gameName, twitchSlug, profileId, profileName) {
  const profilePath = `games/${gameId}/profiles/${profileId}`;
  const profileUrl  = `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@main/${profilePath}/profile.json`;

  // Fail fast if profile already exists on main.
  try {
    await gh(`repos/${OWNER}/${REPO}/contents/${profilePath}/profile.json?ref=${BASE}`, "GET");
    throw new Error(`Profile "${profileId}" for "${gameId}" already exists`);
  } catch (err) {
    if (err.message.includes("already exists")) throw err;
  }

  await gh(`repos/${OWNER}/${REPO}/contents/${profilePath}/profile.json`, "PUT", {
    message: `feat: create ${gameName} ${profileName} profile`,
    content: b64encode(JSON.stringify({ triggers: [] }, null, 2)),
  });

  const catalogFile = await gh(`repos/${OWNER}/${REPO}/contents/catalog.json?ref=${BASE}`, "GET");
  const catalog     = JSON.parse(b64decode(catalogFile.content));
  const existingGame = catalog.games.find(g => g.id === gameId);
  if (existingGame) {
    if (!existingGame.twitchSlug && twitchSlug) existingGame.twitchSlug = twitchSlug;
    if (!existingGame.profiles.find(p => p.id === profileId)) {
      existingGame.profiles.push({ id: profileId, name: profileName, verified: false, url: profileUrl });
    }
  } else {
    catalog.games.push({ id: gameId, name: gameName, twitchSlug, profiles: [{ id: profileId, name: profileName, verified: false, url: profileUrl }] });
  }
  await gh(`repos/${OWNER}/${REPO}/contents/catalog.json`, "PUT", {
    message: `feat: add ${profileName} profile for ${gameName}`,
    content: b64encode(JSON.stringify(catalog, null, 2)),
    sha:     catalogFile.sha,
  });

  // Generate and store contributor code for the profile owner.
  const code = crypto.randomUUID();
  if (env.CONTRIBUTOR_KEYS) {
    await env.CONTRIBUTOR_KEYS.put(code, JSON.stringify({
      gameId, profileId, label: "owner", createdAt: new Date().toISOString(),
    }));
  }

  return { profileUrl, profileId, profileName, code };
}

// ---------------------------------------------------------------------------
// Proposal review operations
// ---------------------------------------------------------------------------

async function listProposals(gh, gameId, profileId) {
  const profilePath = `games/${gameId}/profiles/${profileId}`;
  const prs = await gh(`repos/${OWNER}/${REPO}/pulls?state=open&base=${BASE}&per_page=100`, "GET");

  const relevant = prs.filter(pr =>
    pr.body &&
    pr.body.includes(`**Game:** ${gameId}`) &&
    pr.body.includes(`**Profile:** ${profileId}`)
  );
  if (relevant.length === 0) return [];

  const proposals = [];
  const seen = new Set(); // dedup key: `${prNumber}` or `${action}:${triggerId}`

  for (const pr of relevant) {
    try {
      const branch = pr.head.ref;
      const body   = pr.body || "";

      const actionMatch = body.match(/\*\*Action:\*\* (add|update|remove)/);
      const idMatch     = body.match(/\*\*Trigger ID:\*\* ([^\s\n]+)/);

      if (actionMatch && idMatch) {
        // New PRs: use embedded metadata — immune to branch drift
        const action    = actionMatch[1];
        const triggerId = idMatch[1];
        const dedupKey  = `${action}:${triggerId}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        if (action === "add") {
          const { profile: branchProfile } = await readProfile(gh, profilePath, branch);
          const trigger = branchProfile.triggers.find(t => t.id === triggerId);
          if (trigger) proposals.push({ prNumber: pr.number, prUrl: pr.html_url, branch, prTitle: pr.title, action, trigger });

        } else if (action === "update") {
          const [{ profile: branchProfile }, { profile: mainProfile }] = await Promise.all([
            readProfile(gh, profilePath, branch),
            readProfile(gh, profilePath, BASE),
          ]);
          const trigger       = branchProfile.triggers.find(t => t.id === triggerId);
          const triggerBefore = mainProfile.triggers.find(t => t.id === triggerId);
          if (trigger) proposals.push({ prNumber: pr.number, prUrl: pr.html_url, branch, prTitle: pr.title, action, trigger, triggerBefore });

        } else if (action === "remove") {
          const { profile: mainProfile } = await readProfile(gh, profilePath, BASE);
          const trigger = mainProfile.triggers.find(t => t.id === triggerId);
          if (trigger) proposals.push({ prNumber: pr.number, prUrl: pr.html_url, branch, prTitle: pr.title, action, trigger });
        }

      } else {
        // Legacy PRs (created before this fix): diff approach with deduplication
        const { profile: branchProfile } = await readProfile(gh, profilePath, branch);
        let mainTriggers = [];
        try { ({ profile: { triggers: mainTriggers } } = await readProfile(gh, profilePath, BASE)); } catch {}
        const mainById  = new Map(mainTriggers.map(t => [t.id, t]));
        const branchIds = new Set(branchProfile.triggers.map(t => t.id));

        for (const t of branchProfile.triggers) {
          const mainT    = mainById.get(t.id);
          const dedupKey = mainT ? `update:${t.id}` : `add:${t.id}`;
          if (seen.has(dedupKey)) continue;
          if (!mainT) {
            seen.add(dedupKey);
            proposals.push({ prNumber: pr.number, prUrl: pr.html_url, branch, prTitle: pr.title, action: "add", trigger: t });
          } else if (JSON.stringify(t.payloads) !== JSON.stringify(mainT.payloads)) {
            seen.add(dedupKey);
            proposals.push({ prNumber: pr.number, prUrl: pr.html_url, branch, prTitle: pr.title, action: "update", trigger: t, triggerBefore: mainT });
          }
        }
        for (const mainT of mainTriggers) {
          const dedupKey = `remove:${mainT.id}`;
          if (!branchIds.has(mainT.id) && !seen.has(dedupKey)) {
            seen.add(dedupKey);
            proposals.push({ prNumber: pr.number, prUrl: pr.html_url, branch, prTitle: pr.title, action: "remove", trigger: mainT });
          }
        }
      }
    } catch (err) {
      console.error(`[worker] Skipping PR #${pr.number}: ${err.message}`);
    }
  }
  return proposals;
}

async function acceptProposal(gh, gameId, profileId, prNumber, branch, editedTrigger, hint) {
  const profilePath = `games/${gameId}/profiles/${profileId}`;

  // Resolve the final trigger: prefer reviewer-edited version, fall back to reading from PR branch.
  let trigger = editedTrigger;
  if (!trigger) {
    const { profile: branchProfile } = await readProfile(gh, profilePath, branch);
    const { profile: mainProfile }   = await readProfile(gh, profilePath, BASE);
    const mainIds = new Set(mainProfile.triggers.map(t => t.id));
    trigger = branchProfile.triggers.find(t => !mainIds.has(t.id))
           || branchProfile.triggers.find(t => {
                const m = mainProfile.triggers.find(m => m.id === t.id);
                return m && JSON.stringify(t.payloads) !== JSON.stringify(m.payloads);
              });
    if (!trigger) throw new Error("Could not identify the proposed trigger in the PR branch");
  }

  // Copy reference PNG files from PR branch to main.
  for (const ref of (trigger.references || [])) {
    if (!ref.file) continue;
    // Filenames become GitHub API path segments — only accept worker-generated shapes.
    if (!REF_FILE_RE.test(ref.file)) {
      console.warn(`[worker] Skipping reference with invalid filename: ${JSON.stringify(ref.file)}`);
      continue;
    }
    const filePath = `${profilePath}/references/${ref.file}`;
    try {
      const branchFile = await gh(`repos/${OWNER}/${REPO}/contents/${filePath}?ref=${branch}`, "GET");
      let existingSha;
      try {
        const mainFile = await gh(`repos/${OWNER}/${REPO}/contents/${filePath}?ref=${BASE}`, "GET");
        existingSha = mainFile.sha;
      } catch { /* file doesn't exist on main yet — that's fine */ }
      const body = {
        message: `feat: add reference image ${ref.file} [reviewer: ${hint}]`,
        content:  branchFile.content.replace(/\n/g, ""),
        branch:   BASE,
      };
      if (existingSha) body.sha = existingSha;
      await gh(`repos/${OWNER}/${REPO}/contents/${filePath}`, "PUT", body);
    } catch (err) {
      console.warn(`[worker] Failed to copy reference ${ref.file}: ${err.message}`);
    }
  }

  // Apply trigger to main profile.json.
  const { file: mainFile, profile: mainProfile } = await readProfile(gh, profilePath, BASE);
  const existingIdx = mainProfile.triggers.findIndex(t => t.id === trigger.id);
  const acceptedRotation = normalisedRotation(trigger.rotation);
  const finalTrigger = {
    id:         trigger.id,
    ...(trigger.rotates ? { rotates: true } : {}),
    ...(acceptedRotation ? { rotation: acceptedRotation } : {}),
    ...(normalisedScale(trigger.scale) ? { scale: normalisedScale(trigger.scale) } : {}),
    payloads:   normalisedPayloads(trigger.payloads),
    references: (trigger.references || []).map(({ file, w, h, srcW, srcH, maskDataUrl }) =>
                  ({ file: file || null, w: w || null, h: h || null,
                     srcW: srcW || null, srcH: srcH || null, maskDataUrl: maskDataUrl || null })),
  };
  if (existingIdx !== -1) {
    mainProfile.triggers[existingIdx] = finalTrigger;
  } else {
    mainProfile.triggers.push(finalTrigger);
  }
  const title = trigger.payloads?.[0]?.title || trigger.id;
  await writeProfile(gh, profilePath, mainProfile, mainFile.sha, null,
    `feat: accept "${title}" from PR #${prNumber} [reviewer: ${hint}]`);
  await updateCatalogStats(gh, gameId, profileId, { triggerCount: mainProfile.triggers.length });

  // Close PR with acceptance comment (shown as "closed" not "merged", but clearly accepted).
  await gh(`repos/${OWNER}/${REPO}/issues/${prNumber}/comments`, "POST",
    { body: `✅ Accepted by reviewer \`${hint}\`. Applied directly to \`main\`.` });
  await gh(`repos/${OWNER}/${REPO}/pulls/${prNumber}`, "PATCH", { state: "closed" });
}

async function rejectProposal(gh, prNumber, comment) {
  if (comment) {
    await gh(`repos/${OWNER}/${REPO}/issues/${prNumber}/comments`, "POST", { body: comment });
  }
  await gh(`repos/${OWNER}/${REPO}/pulls/${prNumber}`, "PATCH", { state: "closed" });
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

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

async function updateCatalogStats(gh, gameId, profileId, stats) {
  // stats = { triggerCount?, timesUsed? }
  // Non-fatal: SHA conflicts from concurrent activations are silently dropped.
  try {
    const catalogFile = await gh(`repos/${OWNER}/${REPO}/contents/catalog.json?ref=${BASE}`, "GET");
    const catalog = JSON.parse(b64decode(catalogFile.content));
    const game = catalog.games.find(g => g.id === gameId);
    if (!game) return;
    const prof = game.profiles.find(p => p.id === profileId);
    if (!prof) return;
    if (stats.triggerCount != null) prof.triggerCount = stats.triggerCount;
    if (stats.timesUsed    != null) prof.timesUsed    = stats.timesUsed;
    await gh(`repos/${OWNER}/${REPO}/contents/catalog.json`, "PUT", {
      message: `chore: update stats for ${gameId}/${profileId}`,
      content: b64encode(JSON.stringify(catalog, null, 2)),
      sha:     catalogFile.sha,
    });
  } catch (err) {
    console.warn("[worker] updateCatalogStats failed (non-fatal):", err.message);
  }
}

function normalisedPayloads(payloads) {
  return payloads.map(p => ({
    title:       p.title       ?? "",
    text:        p.text        ?? "",
    image:       null,
    popupOffset: normalisedOffset(p.popupOffset),
  }));
}

// Rotation schema (M8). Clamping matters: the client's angle loop is
// `for (a = minAngle; a <= maxAngle; a += step)` — a step ≤ 0 in profile.json
// would hang every viewer's tab, so never let one through.
function normalisedRotation(r) {
  if (!r || typeof r !== "object") return null;
  if (r.mode === "orthogonal") return { mode: "orthogonal" };
  if (r.mode !== "free") return null;
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  };
  return {
    mode: "free",
    minAngle: num(r.minAngle, -30, -180, 0),
    maxAngle: num(r.maxAngle,  30,    0, 180),
    step:     num(r.step,       5,  0.5, 90),
    fineStepNearZero: r.fineStepNearZero !== false,
    baseAngle: num(r.baseAngle, 0, -180, 180),
  };
}

// Scale schema: {min, max, step} multiplicative sweep range. Clamped to the
// same bounds the extension's scalesForSchema enforces, so a hostile client
// can't ship a range that grinds viewers' matching to a halt.
function normalisedScale(s) {
  if (!s || typeof s !== "object") return null;
  if (s.mode === "none") return null;
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  };
  return {
    min:  num(s.min, 0.75, 0.25, 1),
    max:  num(s.max, 1.5,  1,    4),
    step: num(s.step, 1.12, 1.03, 2),
  };
}

// Only finite, clamped numbers reach profile.json — anything else gets defaults.
function normalisedOffset(o) {
  const x = Number(o?.x), y = Number(o?.y);
  return {
    x: Number.isFinite(x) ? Math.max(-2000, Math.min(2000, Math.round(x))) : 14,
    y: Number.isFinite(y) ? Math.max(-2000, Math.min(2000, Math.round(y))) : 22,
  };
}

function prBody(intro, gameId, profileId, extras = []) {
  return [intro, "", `**Game:** ${gameId}`, `**Profile:** ${profileId}`, ...extras].join("\n");
}

function githubClient(token) {
  return async function gh(path, method, body) {
    const res = await fetch(`https://api.github.com/${path}`, {
      method,
      headers: {
        Authorization:          `Bearer ${token}`,
        Accept:                 "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type":         "application/json",
        "User-Agent":           "StreamGenie-Worker/1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.status);
      throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${msg}`);
    }
    return res.status === 204 ? null : res.json();
  };
}

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Named exports exist solely so tests/worker-submit.js can exercise the real
// implementations against a mock GitHub client. Wrangler only uses `default`.
export {
  OWNER, REPO, BASE, LIMITS,
  ID_RE, TRIG_ID_RE, BRANCH_RE, REF_FILE_RE, IMG_URL_RE,
  validateTriggerInput, normalisedPayloads, normalisedRotation, normalisedScale, normalisedOffset,
  isTrustedContributor, checkRateLimit, contributorHint,
  addTrigger, updateTrigger, removeTrigger, createProfile,
  listProposals, acceptProposal, rejectProposal,
  getMainSha, readProfile, writeProfile, updateCatalogStats,
  prBody, b64decode, b64encode,
};
