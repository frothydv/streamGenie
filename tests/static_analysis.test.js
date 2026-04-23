const fs = require('fs');
const path = require('path');
const assert = require('assert');

/**
 * This test uses static analysis (regex) to catch common variable naming pitfalls
 * and regressions that are hard to catch with traditional unit tests without a 
 * full browser DOM environment.
 */

const contentJsPath = path.join(__dirname, '../extension/content.js');
const popupJsPath = path.join(__dirname, '../extension/popup.js');

const contentJs = fs.readFileSync(contentJsPath, 'utf8');
const popupJs = fs.readFileSync(popupJsPath, 'utf8');

console.log('Running Static Analysis Regression Checks...');

// 1. Regression: currentVideo vs video in content.js
// We use 'currentVideo' as the global state, but 'video' is often a local parameter.
// The message listener must use the global state.
console.log('\nCheck 1: currentVideo vs video in content.js onMessage');
const onMessageMatch = contentJs.match(/chrome\.runtime\.onMessage\.addListener\(([\s\S]+?)\);/);
if (onMessageMatch) {
    const handlerBody = onMessageMatch[1];
    // Check capture-trigger block
    const captureBlock = handlerBody.match(/if\s*\(msg\s*&&\s*msg\.type\s*===\s*"capture-trigger"\)\s*\{([\s\S]+?)\}/);
    if (captureBlock) {
        assert(captureBlock[1].includes('currentVideo'), 'capture-trigger handler must use "currentVideo" global');
        assert(!captureBlock[1].match(/\bvideo\b/), 'capture-trigger handler must NOT use "video" (likely undefined/parameter mismatch)');
    }
}
console.log('✓ currentVideo used correctly in message handler');

// 2. Regression: uKey vs key in popup.js
// In renderTriggers, we renamed 'key' to 'uKey' and 'mKey'. 
// Inline handlers must use these specific names.
console.log('\nCheck 2: uKey vs key in popup.js renderTriggers');
const renderTriggersStart = popupJs.indexOf('async function renderTriggers()');
const renderTriggersEnd = popupJs.indexOf('renderTriggers();', renderTriggersStart);
const renderTriggersSection = popupJs.substring(renderTriggersStart, renderTriggersEnd);

// Look for delete button onclick
const delBtnMatch = renderTriggersSection.match(/delBtn\.onclick\s*=\s*\(\)\s*=>\s*showDeleteConfirm\(([\s\S]+?)\);/);
if (delBtnMatch) {
    const args = delBtnMatch[1];
    assert(args.includes('uKey'), 'delete button onclick must use "uKey"');
    assert(!args.includes(', key'), 'delete button onclick must NOT use "key" (renamed to uKey)');
}
console.log('✓ uKey used correctly in delete button handler');

// 3. Regression: deleteLocally robustness
// deleteLocally should take an ID, not an index, for robustness.
console.log('\nCheck 3: deleteLocally uses trigger ID');
const deleteLocallyMatch = popupJs.match(/async function deleteLocally\(([^)]+)\)/);
if (deleteLocallyMatch) {
    const params = deleteLocallyMatch[1];
    assert(params.includes('triggerId'), 'deleteLocally should accept "triggerId"');
}
const deleteLocallyBodyMatch = popupJs.match(/async function deleteLocally[\s\S]+?\{([\s\S]+?)\}/);
if (deleteLocallyBodyMatch) {
    const body = deleteLocallyBodyMatch[1];
    assert(body.includes('filter'), 'deleteLocally should use .filter() on ID');
    assert(!body.includes('splice'), 'deleteLocally should NOT use .splice() on index');
}
console.log('✓ deleteLocally refactored to use IDs');

// 4. Global State hygiene: currentVideo vs video check in content.js
// Ensure we don't have a global 'video' variable that might mask errors
console.log('\nCheck 4: Variable hygiene in content.js');
assert(!contentJs.match(/^let video\b/m), 'content.js should NOT have a global "video" variable (use currentVideo)');
assert(contentJs.match(/^let currentVideo\b/m), 'content.js should have a global "currentVideo" variable');
console.log('✓ Variable naming consistent');

console.log('\n🎉 ALL STATIC ANALYSIS CHECKS PASSED!');
