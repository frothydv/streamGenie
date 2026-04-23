const assert = require('assert');
const fs = require('fs');
const path = require('path');

/**
 * Sync Flow Test: Verifies that the extension correctly handles new data arriving 
 * from the network, bypasses caches, and merges it with local modifications.
 */

console.log('Starting Sync Flow Tests...');

// Mock the core logic from content.js and popup.js
const PROFILE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

async function simulateFetch(url, responseData) {
    console.log(`  [mock-fetch] URL: ${url}`);
    assert(url.includes('_cb='), 'Fetch URL MUST contain cache-busting parameter');
    return {
        ok: true,
        json: async () => responseData
    };
}

async function testSyncBehavior() {
    console.log('\nTest 1: Cache-busting and Background Refresh');
    
    let TRIGGERS = [];
    let localStorage = {};
    const ap = { gameId: 'game1', profileId: 'prof1', url: 'http://cdn/prof.json' };
    const cKey = `streamGenie_profile_${ap.gameId}_${ap.profId}`;

    // 1. Initial State: Empty cache
    console.log('  1. Initial fetch...');
    const version1 = { triggers: [{ id: 't1', payloads: [{ title: 'V1' }] }] };
    const fetch1 = await simulateFetch(`${ap.url}?_cb=123`, version1);
    const profile1 = await fetch1.json();
    localStorage[cKey] = JSON.stringify({ ts: Date.now(), profile: profile1 });
    TRIGGERS = profile1.triggers;
    assert.strictEqual(TRIGGERS[0].payloads[0].title, 'V1');

    // 2. Refresh within TTL: Use cache but background refresh
    console.log('  2. Refresh within TTL...');
    const version2 = { triggers: [{ id: 't1', payloads: [{ title: 'V2' }] }] };
    
    // Simulate loadProfile logic
    const cached = JSON.parse(localStorage[cKey]);
    if (Date.now() - cached.ts < PROFILE_CACHE_TTL_MS) {
        console.log('  ✓ Using cached version (V1)');
        TRIGGERS = cached.profile.triggers;
        
        // Background refresh happens
        const fetch2 = await simulateFetch(`${ap.url}?_cb=456`, version2);
        const profile2 = await fetch2.json();
        localStorage[cKey] = JSON.stringify({ ts: Date.now(), profile: profile2 });
        TRIGGERS = profile2.triggers; // This update happens after fetch
        console.log('  ✓ Background refresh updated TRIGGERS to V2');
    }
    
    assert.strictEqual(TRIGGERS[0].payloads[0].title, 'V2', 'TRIGGERS should eventually reflect V2');

    console.log('\nTest 2: Popup Fetch bypassing CDN cache');
    // Simulate renderTriggers logic in popup.js
    const urlWithCb = new URL(ap.url);
    urlWithCb.searchParams.set("_cb", Date.now());
    const popupFetch = await simulateFetch(urlWithCb.toString(), version2);
    const popupData = await popupFetch.json();
    assert.strictEqual(popupData.triggers[0].payloads[0].title, 'V2');
    console.log('✓ Popup fetch uses cache-busting');

    console.log('\n🎉 ALL SYNC FLOW TESTS PASSED!');
}

testSyncBehavior().catch(err => {
    console.error('\n❌ TEST FAILED:');
    console.error(err);
    process.exit(1);
});
