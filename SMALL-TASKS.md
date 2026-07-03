# Small tasks — safe for a small model

Rules for whoever (or whatever) picks these up:

- Do ONE task per session/branch. Each is independent.
- After each task run: `node tests/rotation-matching.js && node tests/worker-submit.js && node tests/pending-duplicate.test.js` — all must pass.
- If a task turns out to need judgment beyond what's written here, stop and leave it.
- Do not touch matching math (`matcher-core.js` internals), the worker's
  validation section, or anything in `tests/e2e/` beyond what a task says.

## 1. Remove debug JSON dumps from the worker

`workers/submit-trigger/index.js`, inside `updateTrigger`: four `console.log`
calls starting with `"[worker]"` that stringify entire triggers/references.
Delete all four. They log full mask data URLs into Cloudflare logs on every
update. Do not touch `console.warn`/`console.error` calls.

## 2. Quiet the edit-flow logging in content.js

`extension/content.js`, in the `edit-trigger` message handler (search for
`"[content] Full trigger object:"`): delete the log that stringifies the whole
trigger, and the `"[content] Processing trigger for edit:"` /
`"[content] Constructed URL from filename:"` / `"[content] Canvas converted to
data URL"` logs. Keep error-path logs (`console.error`/`console.warn`).
Similarly in `extension/popup.js`, delete the logs
`"[popup] Sending trigger object:"` and `"[popup] Content script check response:"`.

## 3. Rename Node test files to .mjs to silence the module warning

Running the Node suites prints `MODULE_TYPELESS_PACKAGE_JSON` warnings. Do NOT
add `"type": "module"` to package.json (the Playwright e2e specs are CommonJS).
Instead rename:

- `tests/worker-submit.js` → `tests/worker-submit.mjs`
- `tests/pending-duplicate.test.js` → `tests/pending-duplicate.test.mjs` (only if it uses `import`/`export` syntax — check first)
- `tests/bench-ncc.js` → `tests/bench-ncc.mjs` (same check)
- `tests/rotation-matching.js` — same check

Then update every mention of the old filenames in: `package.json` scripts,
`CLAUDE.md`, `HANDOFF.md`, `SMALL-TASKS.md`.

## 4. Update stale facts in CLAUDE.md

CLAUDE.md drifted from reality. Fix only these factual points, keep everything
else:

- Header says "Current state — v0.9.0"; manifest is 0.10.1. Change to 0.10.1
  and keep it in sync going forward.
- "File layout" section lists only `tests/rotation-matching.js`; add
  `tests/worker-submit.js` (worker ops), `tests/pending-duplicate.test.js`,
  `tests/bench-ncc.js`, and `tests/e2e/` (Playwright).
- "Testing workflow" says the e2e suite is "6 tests"; it is 19. Also note e2e
  uses Edge by default (see `tests/e2e/helpers.js`).
- "Must-haves before beta" lists viewer onboarding and privacy disclosure as
  open; both are built and e2e-tested (first-run banner with privacy link,
  no-profile banner). Move them to shipped, or delete.

## 5. Extract shared constants in popup.js

`extension/popup.js` builds profile URLs from
`https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/...` in
more than one place, and `extension/content.js` hardcodes the same base in the
`edit-trigger` handler. Add a single `PROFILES_RAW_BASE` constant in each file
(they cannot share modules) and use it everywhere the literal appears. Pure
find-and-replace; no behavior change.

## 6. Add a `npm test` script

`package.json` has `test:e2e` but no aggregate unit-test script. Add:
`"test": "node tests/rotation-matching.js && node tests/worker-submit.js && node tests/pending-duplicate.test.js"`
(adjust filenames if task 3 renamed them). Update CLAUDE.md's testing section
to mention `npm test`.

## 7. Timestamped trigger IDs in the curator panel

Trigger IDs now look like `map-button-1751500000000-a3f2`. Anywhere the
extension UI displays a raw trigger id to the user (curator panel card
subtitle, debug panel match line), prefer the payload title and show the id
only as a tooltip/secondary line. Search `extension/content.js` for places that
set `textContent` to `trigger.id`. Visual-only change; do not change any logic
that compares or stores ids.

