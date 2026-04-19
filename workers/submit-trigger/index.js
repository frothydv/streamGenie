/**
 * Stream Genie — Submit Trigger Worker
 *
 * POST /  { gameId, profileId, trigger, mode? }
 * Header: X-Submit-Secret: <secret>
 *
 * mode "add"    (default) — upload reference PNG(s), append trigger, open PR
 * mode "update" — patch existing trigger payloads by id, open PR (no new images)
 *
 * Required Worker secrets (set via `wrangler secret put`):
 *   GITHUB_TOKEN   — PAT with repo write access to streamGenieProfiles
 *   SUBMIT_SECRET  — shared secret the extension sends in X-Submit-Secret
 */

const OWNER = "frothydv";
const REPO  = "streamGenieProfiles";
const BASE  = "main";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Submit-Secret",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    if (request.headers.get("X-Submit-Secret") !== env.SUBMIT_SECRET) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const { gameId, profileId, trigger, mode = "add" } = body;

    if (!gameId || !profileId || !trigger?.payloads) {
      return json({ ok: false, error: "Missing required fields" }, 400);
    }

    if (mode === "add") {
      if (!trigger.references?.length) {
        return json({ ok: false, error: "Missing references array" }, 400);
      }
      if (!trigger.references[0]?.dataUrl) {
        return json({ ok: false, error: "Missing reference image" }, 400);
      }
    }

    if (mode === "update" && !trigger.id) {
      return json({ ok: false, error: "Missing trigger id for update" }, 400);
    }

    try {
      const gh = githubClient(env.GITHUB_TOKEN);
      const prUrl = mode === "update"
        ? await updateTrigger(gh, gameId, profileId, trigger)
        : await addTrigger(gh, gameId, profileId, trigger);
      return json({ ok: true, prUrl });
    } catch (err) {
      console.error(`${mode}Trigger failed:`, err.message);
      return json({ ok: false, error: err.message }, 500);
    }
  },
};

// ---------------------------------------------------------------------------

async function addTrigger(gh, gameId, profileId, trigger) {
  const profilePath = `games/${gameId}/profiles/${profileId}`;

  const rawId = (trigger.payloads[0]?.title || trigger.id || Date.now().toString())
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const triggerId = `${rawId}-${Date.now()}`;
  const branchName = `trigger/${triggerId}`;

  const baseSha = await getMainSha(gh);

  await gh(`repos/${OWNER}/${REPO}/git/refs`, "POST", {
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // Upload reference images
  const profileRefs = [];
  for (let i = 0; i < trigger.references.length; i++) {
    const ref = trigger.references[i];
    const imageB64 = ref.dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const suffix = trigger.references.length > 1 ? `-${i}` : "";
    const filename = `${triggerId}${suffix}.png`;
    const filePath = `${profilePath}/references/${filename}`;

    await gh(`repos/${OWNER}/${REPO}/contents/${filePath}`, "PUT", {
      message: `feat: add reference image ${filename}`,
      content: imageB64,
      branch: branchName,
    });

    profileRefs.push({
      file: filename,
      w:    ref.w    ?? null,
      h:    ref.h    ?? null,
      srcW: ref.srcW ?? null,
      srcH: ref.srcH ?? null,
    });
  }

  const { file: profileFile, profile } = await readProfile(gh, profilePath, branchName);

  const newTrigger = {
    id: rawId,
    payloads: normalisedPayloads(trigger.payloads),
    references: profileRefs,
  };
  profile.triggers.push(newTrigger);

  await writeProfile(gh, profilePath, profile, profileFile.sha, branchName,
    `feat: add trigger "${newTrigger.payloads[0]?.title || rawId}"`);

  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, "POST", {
    title: `Add trigger: ${newTrigger.payloads[0]?.title || rawId}`,
    body: prBody("New trigger submitted via Stream Genie.", gameId, profileId, [
      `**Payloads:** ${trigger.payloads.length}`,
    ]),
    head: branchName,
    base: BASE,
  });

  return pr.html_url;
}

async function updateTrigger(gh, gameId, profileId, trigger) {
  const profilePath = `games/${gameId}/profiles/${profileId}`;
  const triggerId = trigger.id;
  const branchName = `update/${triggerId}-${Date.now()}`;

  const baseSha = await getMainSha(gh);

  await gh(`repos/${OWNER}/${REPO}/git/refs`, "POST", {
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  const { file: profileFile, profile } = await readProfile(gh, profilePath, branchName);

  const idx = profile.triggers.findIndex(t => t.id === triggerId);
  if (idx === -1) throw new Error(`Trigger "${triggerId}" not found in profile`);

  profile.triggers[idx] = {
    ...profile.triggers[idx],
    payloads: normalisedPayloads(trigger.payloads),
  };

  const title = trigger.payloads[0]?.title || triggerId;

  await writeProfile(gh, profilePath, profile, profileFile.sha, branchName,
    `fix: update trigger "${title}"`);

  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, "POST", {
    title: `Update trigger: ${title}`,
    body: prBody("Proposed update to an existing trigger via Stream Genie.", gameId, profileId, [
      `**Trigger ID:** ${triggerId}`,
    ]),
    head: branchName,
    base: BASE,
  });

  return pr.html_url;
}

// ---------------------------------------------------------------------------

async function getMainSha(gh) {
  const { object: { sha } } = await gh(
    `repos/${OWNER}/${REPO}/git/refs/heads/${BASE}`, "GET"
  );
  return sha;
}

async function readProfile(gh, profilePath, ref) {
  const file = await gh(
    `repos/${OWNER}/${REPO}/contents/${profilePath}/profile.json?ref=${ref}`,
    "GET"
  );
  const profile = JSON.parse(b64decode(file.content));
  return { file, profile };
}

async function writeProfile(gh, profilePath, profile, sha, branch, message) {
  await gh(`repos/${OWNER}/${REPO}/contents/${profilePath}/profile.json`, "PUT", {
    message,
    content: b64encode(JSON.stringify(profile, null, 2)),
    sha,
    branch,
  });
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

// ---------------------------------------------------------------------------

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
  return atob(str.replace(/\n/g, ""));
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
