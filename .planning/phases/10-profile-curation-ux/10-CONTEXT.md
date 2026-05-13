# Phase 10: Profile Curation UX - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Give trusted contributors the tools to manage an existing profile: delete individual triggers, overwrite a trigger with a new reference image while preserving its metadata, review all triggers in a compact grid/thumbnail view, and surface near-duplicate triggers before they pollute the profile.

All four requirements (CUR-01 through CUR-04) are additive UI work in `content.js` and/or `popup.js`. No schema changes, no new Worker ops (delete/update already exist).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion

User has no strong preferences on curation UX — all implementation decisions are delegated to the researcher and planner. This includes:

- Where the profile grid/review mode lives (popup vs. content.js panel)
- How the overwrite flow is triggered (re-capture then pick, or open existing then re-capture)
- When near-duplicate detection runs (on submit, on grid open, or manual scan)
- Delete confirmation UX (toast with undo vs. confirm dialog)
- Thumbnail generation approach for the grid
- Navigation between grid view and individual trigger editor

Pick the approach that fits naturally into the existing vanilla-DOM, no-framework codebase and keeps contributor friction low.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — CUR-01 through CUR-04 (the four requirements for this phase)

### Project Primer
- `CLAUDE.md` — full architectural context, Worker ops table, profile/catalog schema, and working style notes

### Codebase Maps
- `.planning/codebase/STRUCTURE.md` — file responsibilities; trigger editor is content.js lines ~1600–3200, popup.js handles contributor key + proposals
- `.planning/codebase/CONVENTIONS.md` — DOM patterns (vanilla, inline styles, Twitch palette), logging tags, `parseOrDef` rule, XSS note on innerHTML
- `.planning/codebase/STACK.md` — no build step, no framework, Chrome MV3, Worker ops

No external specs — requirements fully captured in decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Trigger editor (`content.js` ~1600–3200): full CRUD UI already exists for creating/editing triggers; delete and overwrite extend this
- `popup.js` proposal review UI: already renders a list of triggers with accept/reject actions — pattern reusable for the grid view
- `showToast()` (`content.js` ~3200+): existing toast utility for non-modal feedback
- Worker ops `remove` and `update`: already implemented in `workers/submit-trigger/index.js` — delete and overwrite just need UI entry points

### Established Patterns
- Vanilla DOM + `Object.assign(el.style, {...})` for all UI construction — no framework, no templates
- Dark Twitch palette: background `#18181b`, text `#efeff1`, purple `#9146ff` / `#bf94ff`
- Contributor key gated: contributor-only actions require `chrome.storage.local` key → Worker `verify` check before destructive ops
- `textContent` (not `innerHTML`) for user-supplied text — XSS fix already in place

### Integration Points
- Trigger editor in `content.js`: extend with delete button and overwrite-capture entry point
- Popup in `popup.js`: extend with a "Review Profile" / grid mode tab or section
- Worker `remove` op: `{ op: "remove", gameId, profileId, triggerId, contributorKey }`
- Worker `update` op: `{ op: "update", gameId, profileId, trigger, contributorKey }`
- Reference images available at `{profileBaseUrl}/references/{file}` for thumbnail rendering

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 10-profile-curation-ux*
*Context gathered: 2026-05-13*
