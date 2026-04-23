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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Submit-Secret, X-Contributor-Key",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

    if (request.headers.get("X-Submit-Secret") !== env.SUBMIT_SECRET) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const {
      gameId, profileId, trigger, mode = "add",
      gameName, twitchSlug, newProfileId, newProfileName,
    } = body;

    const contributorKey = request.headers.get("X-Contributor-Key") || null;

    // --- verify mode --------------------------------------------------------
    if (mode === "verify") {
      if (!gameId || !profileId) return json({ ok: false, error: "Missing gameId/profileId" }, 400);
      const trusted = await isTrustedContributor(env, contributorKey, gameId, profileId);
      return json({ ok: true, trusted });
    }

    // --- create-profile mode ------------------------------------------------
    if (mode === "create-profile") {
      if (!gameId || !gameName || !newProfileId) {
        return json({ ok: false, error: "Missing gameId, gameName, or newProfileId" }, 400);
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

    const trusted = await isTrustedContributor(env, contributorKey, gameId, profileId);
    const hint    = contributorHint(contributorKey);

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
