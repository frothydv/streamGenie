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

    // --- verify mode --------------------------------------------------------
    if (mode === "verify") {
      if (!gameId || !profileId) return json({ ok: false, error: "Missing gameId/profileId" }, 400);
      const trusted = await isTrustedContributor(env, contributorKey, gameId, profileId);
      return json({ ok: true, trusted });
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

  let mainTriggers = [];
  try {
    const { profile } = await readProfile(gh, profilePath, BASE);
    mainTriggers = profile.triggers;
  } catch {}
  const mainById = new Map(mainTriggers.map(t => [t.id, t]));

  const proposals = [];
  for (const pr of relevant) {
    try {
      const branch = pr.head.ref;
      const { profile: branchProfile } = await readProfile(gh, profilePath, branch);
      const branchIds = new Set(branchProfile.triggers.map(t => t.id));

      for (const t of branchProfile.triggers) {
        const mainT = mainById.get(t.id);
        if (!mainT) {
          proposals.push({ prNumber: pr.number, prUrl: pr.html_url, branch, prTitle: pr.title, action: "add", trigger: t });
        } else if (JSON.stringify(t.payloads) !== JSON.stringify(mainT.payloads)) {
          proposals.push({ prNumber: pr.number, prUrl: pr.html_url, branch, prTitle: pr.title, action: "update", trigger: t, triggerBefore: mainT });
        }
      }
      for (const mainT of mainTriggers) {
        if (!branchIds.has(mainT.id)) {
          proposals.push({ prNumber: pr.number, prUrl: pr.html_url, branch, prTitle: pr.title, action: "remove", trigger: mainT });
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
  const finalTrigger = {
    id:         trigger.id,
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
