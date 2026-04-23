/**
 * Verify ALL fixes are correctly in place
 */
const fs = require('fs');
const path = require('path');

const contentJs = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content.js'), 'utf8'
);
const popupJs = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8'
);

console.log('\n=== Verifying ALL Fixes ===\n');

let passed = 0, failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  ✓ ${message}`); passed++; }
  else { console.error(`  ✗ ${message}`); failed++; }
}

// Fix 1: openEditTriggerEditor prefers _isModified version
console.log('Fix 1: openEditTriggerEditor prefers modified trigger');
assert(
  contentJs.includes('const allMatches = TRIGGERS.filter(t => t.id === trigger.id)'),
  'Filters ALL matches for the trigger ID'
);
assert(
  contentJs.includes('const foundTrigger = allMatches.find(t => t._isModified) || allMatches[0] || null'),
  'Prefers _isModified version'
);

// Fix 2: loadUserTriggers only loads "user-" triggers
console.log('\nFix 2: loadUserTriggers filters by "user-"');
assert(
  contentJs.includes('filter(t => t.id && t.id.startsWith("user-"))'),
  'Filters to only user-created triggers'
);

// Fix 3: popup.js also filters localTriggers
console.log('\nFix 3: popup.js filters localTriggers by "user-"');
assert(
  popupJs.includes('filter(t => t.id && t.id.startsWith("user-"))'),
  'Popup only shows user-created triggers as [Local]'
);

// Fix 4: saveLocally uses saveModifiedProfileTrigger for profile triggers
console.log('\nFix 4: saveLocally uses correct storage');
const saveLocallyStart = contentJs.indexOf('async function saveLocally(trigger)');
const saveLocallyEnd = contentJs.indexOf('// Footer', saveLocallyStart);
const saveLocallySection = contentJs.substring(saveLocallyStart, saveLocallyEnd === -1 ? contentJs.length : saveLocallyEnd);
assert(
  saveLocallySection.includes('await saveModifiedProfileTrigger(trigger)'),
  'Profile triggers call saveModifiedProfileTrigger'
);
assert(
  saveLocallySection.includes('await saveUserTrigger(trigger'),
  'User triggers call saveUserTrigger'
);

// Fix 5: isProfileEdit branch saves modified trigger
console.log('\nFix 5: isProfileEdit saves modified trigger locally');
assert(
  contentJs.includes('await saveModifiedProfileTrigger(trigger)') &&
  contentJs.indexOf('await saveModifiedProfileTrigger(trigger)') !==
  contentJs.lastIndexOf('await saveModifiedProfileTrigger(trigger)'),
  'saveModifiedProfileTrigger is called in TWO places (saveLocally + isProfileEdit)'
);

// Fix 6: Cache-busting in fetchAndCacheProfile
console.log('\nFix 6: Cache-busting for CDN requests');
assert(
  contentJs.includes('url.searchParams.set("_cb", Date.now())'),
  'URL has cache-busting parameter'
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
