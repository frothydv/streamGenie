/**
 * Stream Genie — Submit Trigger Worker
 *
 * POST /  { gameId, profileId, trigger }
 * Header: X-Submit-Secret: <secret>
 *
 * Creates a branch in streamGenieProfiles, uploads the reference PNG,
 * updates profile.json, and opens a PR. The GitHub Action in that repo
 * auto-merges PRs opened by the trusted account.
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

    const { gameId, profileId, trigger } = body;
    if (!gameId || !profileId || !trigger?.payloads || !trigger?.references?.length) {
      return json({ ok: false, error: "Missing required fields" }, 400);
    }
    if (!trigger.references[0]?.dataUrl) {
      return json({ ok: false, error: "Missing reference image" }, 400);
    }

    try {
      const prUrl = await submitTrigger(env.GITHUB_TOKEN, gameId, profileId, trigger);
      return json({ ok: true, prUrl });
    } catch (err) {
      console.error("submitTrigger failed:", err.message);
      return json({ ok: false, error: err.message }, 500);
    }
  },
};

// ---------------------------------------------------------------------------

async function submitTrigger(token, gameId, profileId, trigger) {
  const gh = githubClient(token);
  const profilePath = `games/${gameId}/profiles/${profileId}`;

  // Derive a clean ID from the first payload title, falling back to timestamp.
  const rawId = (trigger.payloads[0]?.title || trigger.id || Date.now().toString())
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const triggerId = `${rawId}-${Date.now()}`;
  const branchName = `trigger/${triggerId}`;

  // 1. Get main branch SHA.
  const { object: { sha: baseSha } } = await gh(
    `repos/${OWNER}/${REPO}/git/refs/heads/${BASE}`, "GET"
  );

  // 2. Create branch.
  await gh(`repos/${OWNER}/${REPO}/git/refs`, "POST", {
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // 3. Upload reference images.
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

  // 4. Read current profile.json from the new branch.
  const profileFile = await gh(
    `repos/${OWNER}/${REPO}/contents/${profilePath}/profile.json?ref=${branchName}`,
    "GET"
  );
  const profile = JSON.parse(b64decode(profileFile.content));

  // 5. Append new trigger.
  const newTrigger = {
    id: rawId,
    payloads: trigger.payloads.map(p => ({
      title:       p.title       ?? "",
      text:        p.text        ?? "",
      image:       null,
      popupOffset: p.popupOffset ?? { x: 14, y: 22 },
    })),
    references: profileRefs,
  };
  profile.triggers.push(newTrigger);

  // 6. Commit updated profile.json.
  await gh(`repos/${OWNER}/${REPO}/contents/${profilePath}/profile.json`, "PUT", {
    message: `feat: add trigger "${newTrigger.payloads[0]?.title || rawId}"`,
    content: b64encode(JSON.stringify(profile, null, 2)),
    sha:     profileFile.sha,
    branch:  branchName,
  });

  // 7. Open PR.
  const firstTitle = newTrigger.payloads[0]?.title || rawId;
  const pr = await gh(`repos/${OWNER}/${REPO}/pulls`, "POST", {
    title: `Add trigger: ${firstTitle}`,
    body: [
      `New trigger submitted via Stream Genie.`,
      ``,
      `**Game:** ${gameId}`,
      `**Profile:** ${profileId}`,
      `**Payloads:** ${trigger.payloads.length}`,
    ].join("\n"),
    head: branchName,
    base: BASE,
  });

  return pr.html_url;
}

// ---------------------------------------------------------------------------

function githubClient(token) {
  return async function gh(path, method, body) {
    const res = await fetch(`https://api.github.com/${path}`, {
      method,
      headers: {
        Authorization:         `Bearer ${token}`,
        Accept:                "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type":        "application/json",
        "User-Agent":          "StreamGenie-Worker/1.0",
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
  // UTF-8 safe base64 encode.
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
