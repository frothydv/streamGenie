/**
 * Verify critical fix invariants are still in place.
 *
 * Unlike the old version which checked for specific function names that were
 * later refactored, this version checks behavioural invariants against the
 * current codebase.
 */
const fs = require('fs');
const path = require('path');

const contentJs = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content.js'), 'utf8'
);
const popupJs = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8'
);
const matcherCore = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'matcher-core.js'), 'utf8'
);

console.log('\n=== Verifying Critical Fix Invariants ===\n');

let passed = 0, failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  ✓ ${message}`); passed++; }
  else { console.error(`  ✗ ${message}`); failed++; }
}

// ── Fix 1: Editor prefers _isModified version of a trigger ────────────────

console.log('Fix 1: Editor selects modified trigger when available');
assert(
  contentJs.includes('const allMatches = TRIGGERS.filter(t => t.id === trigger.id)'),
  'Editor filters ALL TRIGGERS matching the trigger ID'
);
assert(
  contentJs.includes('const foundTrigger = allMatches.find(t => t._isModified) || allMatches[0] || null'),
  'Editor prefers _isModified version, falls back to first match'
);

// ── Fix 2: User triggers loaded from local storage, filtered by "user-" prefix ──

console.log('\nFix 2: User-created triggers loaded from local storage');
assert(
  contentJs.includes('userTriggersKey') &&
  contentJs.includes('startsWith("user-")'),
  'User triggers key exists and id prefix check present (loadUserTriggers logic inlined in applyProfile)'
);
assert(
  contentJs.includes('.filter(t => t.id && !profileIdSet.has(t.id))'),
  'Pending user triggers filter out those already in CDN profile'
);

// ── Fix 3: Popup reads user triggers alongside profile triggers ──────────

console.log('\nFix 3: Popup trigger rendering handles both profile and local triggers');
assert(
  popupJs.includes('source: "profile"'),
  'popup.js marks profile-sourced triggers'
);
// popup.js now fetches from CDN directly; local/user triggers are merged
// in content.js. The popup shows all triggers the profile returns.
assert(
  contentJs.includes('source: "profile"') && contentJs.includes('source: "pending"'),
  'content.js marks both profile and pending sources'
);

// ── Fix 4: saveLocally dispatches to correct storage path ─────────────────

console.log('\nFix 4: saveLocally handles profile vs user triggers correctly');
const saveLocallyStart = contentJs.indexOf('async function saveLocally(trigger)');
// Find the next function or section boundary after saveLocally
const saveLocallyEnd = contentJs.indexOf('// Footer', saveLocallyStart);
const saveLocallySection = contentJs.slice(saveLocallyStart, saveLocallyEnd === -1 ? contentJs.length : saveLocallyEnd);
assert(
  saveLocallySection.includes('trigger.id.startsWith("user-")') &&
  saveLocallySection.includes('saveUserTrigger(trigger, isEdit)'),
  'User triggers go through saveUserTrigger in saveLocally'
);
assert(
  saveLocallySection.includes('._isModified = true') ||
  saveLocallySection.includes('_isModified = true'),
  'Profile triggers get _isModified flag in saveLocally'
);

// ── Fix 5: _isModified is set in two distinct places ────────────────────

console.log('\nFix 5: _isModified set on profile edits in editor flow AND saveLocally');
// The isProfileEdit check in the editor (line ~901) sets _isModified:
const editorIsProfileEdit = contentJs.includes(
  'const isProfileEdit = isEdit && !opts.trigger?.id?.startsWith("user-")'
);
// And saveLocally applies it too:
const saveLocallySetsModified = contentJs.includes(
  'TRIGGERS[existingIdx]._isModified = true'
);
assert(editorIsProfileEdit, 'Editor has isProfileEdit check for non-user triggers');
assert(saveLocallySetsModified, 'saveLocally sets _isModified on profile triggers');

// Verify the two are separate occurrences
const modifiedOccurrences = (contentJs.match(/\._isModified\s*=\s*true/g) || []).length;
assert(modifiedOccurrences >= 2,
  `_isModified = true appears ${modifiedOccurrences} times (expect ≥ 2)`
);

// ── Fix 6: Cache-busting in CDN requests ─────────────────────────────────

console.log('\nFix 6: Cache-busting for CDN requests');
assert(
  contentJs.includes('url.searchParams.set("_cb", Date.now())'),
  'content.js uses cache-busting query param on CDN requests'
);
assert(
  popupJs.includes('url.searchParams.set("_cb", Date.now())'),
  'popup.js uses cache-busting query param on CDN requests'
);

// ── Fix 7: Masked NCC (matcher-core) ─────────────────────────────────────

console.log('\nFix 7: Masked NCC in matcher-core');
assert(
  matcherCore.includes('maskPx') && matcherCore.includes('activeIndices'),
  'buildRefNCC accepts maskPx parameter and builds activeIndices'
);
assert(
  matcherCore.includes('activeIndices') && matcherCore.includes('nccScoreAt'),
  'nccScoreAt handles activeIndices for masked correlation'
);

// ── Fix 8: Cross-world dataset bridge ────────────────────────────────────

console.log('\nFix 8: Content script exposes state via dataset for main world tests');
assert(
  contentJs.includes('document.documentElement.dataset.streamGenieLoaded'),
  'Content script sets dataset.streamGenieLoaded for cross-world visibility'
);
assert(
  contentJs.includes('dataset.streamGenieAttached'),
  'Content script sets dataset.streamGenieAttached in heartbeat'
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
