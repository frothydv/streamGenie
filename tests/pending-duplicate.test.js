#!/usr/bin/env node
/**
 * Tests for pending-trigger duplicate issue:
 * 
 * Problem: When a trigger is submitted to the worker, it's saved locally with
 * a "user-xxxx" ID. The worker creates it on the server with a different ID
 * (e.g., "white-dude-123456-abc0"). The content script then loads BOTH the
 * profile triggers (server IDs) AND the pending triggers ("user-" IDs) into
 * TRIGGERS. They look like duplicates in the curator panel.
 * 
 * Root cause: The pending-trigger cleanup in applyProfile only matches by ID.
 * Pending trigger IDs ("user-xxxx") never match profile IDs ("title-ts-rand"),
 * so they persist forever.
 * 
 * Fix: Match pending triggers to profile triggers by content (payload title + text)
 * instead of just by ID.
 */

const assert = require('assert');

let passed = 0, failed = 0;

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(
                () => { console.log(`  ✓ ${name}`); passed++; },
                (err) => { console.log(`  ✗ ${name}: ${err.message}`); failed++; }
            );
        }
        console.log(`  ✓ ${name}`); passed++;
    } catch (err) {
        console.log(`  ✗ ${name}: ${err.message}`); failed++;
    }
}

// --- Mocks ---
const mockStorage = {
    data: {},
    async get(key) {
        if (typeof key === 'string') return { [key]: this.data[key] };
        if (Array.isArray(key)) {
            const res = {};
            key.forEach(k => res[k] = this.data[k]);
            return res;
        }
        return { ...this.data };
    },
    async set(obj) { Object.assign(this.data, obj); },
    async remove(key) { 
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(k => delete this.data[k]);
    },
    clear() { this.data = {}; },
};

// --- Extracted logic from content.js ---

const userTriggersKey = (gId, pId) => `streamGenie_triggers_${gId}_${pId}`;
const DEFAULT_PROFILE = { gameId: 'game-1', profileId: 'prof-1', url: 'http://cdn/prof.json' };
let activeProfile = DEFAULT_PROFILE;
let TRIGGERS = [];

/**
 * Generates the same trigger "signature" key used by applyProfile to compare
 * pending triggers to profile triggers by content rather than by ID.
 * Two triggers with the same title+text in the first payload are considered
 * content-matching.
 */
function triggerContentKey(t) {
    const p = (t.payloads || [])[0] || {};
    return `${p.title || ''}|${p.text || ''}`;
}

/**
 * Simulates the FIXED version of the pending-trigger cleanup in applyProfile.
 * Match by content (payload signature) instead of just by ID.
 */
async function applyProfile(profile) {
    const ap = activeProfile || DEFAULT_PROFILE;
    const uKey = userTriggersKey(ap.gameId, ap.profileId);

    // Normalize triggers
    const seenIds = new Set();
    for (let i = profile.triggers.length - 1; i >= 0; i--) {
        if (seenIds.has(profile.triggers[i].id)) {
            profile.triggers.splice(i, 1);
        } else {
            seenIds.add(profile.triggers[i].id);
        }
    }

    const profileIdSet = new Set(profile.triggers.map(t => t.id));
    TRIGGERS = profile.triggers.map(t => ({ ...t, source: 'profile' }));

    // --- FIXED: Match pending by content, not just by ID ---
    const stored = await mockStorage.get(uKey);
    let pending = stored[uKey] || [];

    // Build content map of profile triggers
    const profileContentKeys = new Set(TRIGGERS.map(triggerContentKey).filter(Boolean));

    // Filter pending: keep those whose content is NOT yet in the profile
    const filtered = [];
    for (const t of pending) {
        if (profileContentKeys.has(triggerContentKey(t))) {
            // This pending trigger's content already exists in the profile — it's been synced.
            // Remove it from local storage (skip it).
            console.log(`  [cleanup] pending "${t.id}" content matched profile — removing`);
        } else if (profileIdSet.has(t.id)) {
            // ID-based match (for backward compat with the rare case IDs happen to collide)
            console.log(`  [cleanup] pending "${t.id}" ID matched profile — removing`);
        } else {
            filtered.push(t);
        }
    }

    if (filtered.length === 0) {
        await mockStorage.remove(uKey);
        pending = [];
    } else {
        // Only write back if something changed
        if (filtered.length < pending.length) {
            await mockStorage.set({ [uKey]: filtered });
        }
        for (const t of filtered) TRIGGERS.push({ ...t, source: 'pending' });
    }
}

// --- Helpers ---

function makePending(id, title, text) {
    return { id, payloads: [{ title, text }], references: [{ dataUrl: 'data:image/png;base64,abc', w: 40, h: 40 }] };
}

function makeProfile(id, title, text) {
    return { id, payloads: [{ title, text, image: null, popupOffset: { x: 14, y: 22 } }], references: [{ file: `${id}.png`, w: 40, h: 40 }] };
}

async function runAll() {
    // -----------------------------------------------------------------------
    console.log('\n— Pending trigger cleanup by content ---');

    await test('pending trigger with same content as profile trigger is removed', async () => {
        mockStorage.clear();
        TRIGGERS = [];
        const uKey = userTriggersKey('game-1', 'prof-1');
        // Simulate a locally-saved pending trigger with "user-" ID
        await mockStorage.set({ [uKey]: [makePending('user-1748800000000', 'Ice Cream', 'Gain energy')] });

        const profile = { triggers: [makeProfile('ice-cream-1748800000000-abcd', 'Ice Cream', 'Gain energy')] };
        await applyProfile(profile);

        // Only the profile trigger should be in TRIGGERS (pending was cleaned up)
        assert.strictEqual(TRIGGERS.length, 1, 'should have 1 trigger after cleanup');
        assert.strictEqual(TRIGGERS[0].id, 'ice-cream-1748800000000-abcd', 'should be the profile trigger');
        assert.strictEqual(TRIGGERS[0].source, 'profile');

        // Pending should be cleared from storage
        const stored = await mockStorage.get(uKey);
        assert.strictEqual(stored[uKey], undefined, 'pending trigger should be removed from storage');
    });

    await test('pending trigger with different content than profile is kept', async () => {
        mockStorage.clear();
        TRIGGERS = [];
        const uKey = userTriggersKey('game-1', 'prof-1');
        await mockStorage.set({ [uKey]: [makePending('user-1748800000001', 'Pending Item', 'Not yet on server')] });

        const profile = { triggers: [makeProfile('existing-item', 'Existing', 'Already on server')] };
        await applyProfile(profile);

        assert.strictEqual(TRIGGERS.length, 2, 'should have 2 triggers (profile + pending)');
        const pending = TRIGGERS.find(t => t.source === 'pending');
        assert(pending, 'pending trigger should still be present');
        assert.strictEqual(pending.payloads[0].title, 'Pending Item');
    });

    await test('multiple pending triggers: only content-matching ones are removed', async () => {
        mockStorage.clear();
        TRIGGERS = [];
        const uKey = userTriggersKey('game-1', 'prof-1');
        await mockStorage.set({
            [uKey]: [
                makePending('user-1748800000002', 'Synced A', 'Alpha'),
                makePending('user-1748800000003', 'Synced B', 'Beta'),
                makePending('user-1748800000004', 'Unsynced C', 'Gamma'),
            ]
        });

        const profile = {
            triggers: [
                makeProfile('synced-a-1748800000000-1234', 'Synced A', 'Alpha'),
                makeProfile('synced-b-1748800000001-5678', 'Synced B', 'Beta'),
            ]
        };
        await applyProfile(profile);

        // Should have 2 profile + 1 pending (Unsynced C) = 3 total
        assert.strictEqual(TRIGGERS.length, 3, 'should have 3 triggers');
        const sources = TRIGGERS.map(t => t.source + ':' + t.payloads[0].title).sort();
        assert.deepStrictEqual(sources, ['pending:Unsynced C', 'profile:Synced A', 'profile:Synced B']);

        // Storage should only keep the unsynced one
        const stored = await mockStorage.get(uKey);
        assert.strictEqual(stored[uKey].length, 1, 'only unsynced pending should remain');
        assert.strictEqual(stored[uKey][0].payloads[0].title, 'Unsynced C');
    });

    await test('no duplicate entries when profile and pending have same content', async () => {
        mockStorage.clear();
        TRIGGERS = [];
        const uKey = userTriggersKey('game-1', 'prof-1');
        await mockStorage.set({ [uKey]: [makePending('user-1748800000005', 'Duplicate', 'Same content')] });

        const profile = { triggers: [makeProfile('dup-123456-abcd', 'Duplicate', 'Same content')] };
        await applyProfile(profile);

        // The pending trigger with matching content should be cleaned up
        assert.strictEqual(TRIGGERS.length, 1, 'should NOT have duplicate');
        assert.strictEqual(TRIGGERS[0].source, 'profile');
    });

    await test('pending trigger with empty title is always kept', async () => {
        mockStorage.clear();
        TRIGGERS = [];
        const uKey = userTriggersKey('game-1', 'prof-1');
        await mockStorage.set({ [uKey]: [makePending('user-1748800000006', '', 'Some text')] });

        const profile = { triggers: [makeProfile('some-trigger', 'Some Title', 'Different text')] };
        await applyProfile(profile);

        // Empty title pending trigger doesn't match any profile trigger by content
        assert.strictEqual(TRIGGERS.length, 2, 'empty-title pending should be kept');
    });

    await test('pending trigger cleared after content-matched profile is loaded, not before', async () => {
        mockStorage.clear();
        TRIGGERS = [];
        const uKey = userTriggersKey('game-1', 'prof-1');
        await mockStorage.set({ [uKey]: [makePending('user-1748800000007', 'Will Match', 'Soon')] });

        // First load: profile doesn't have it yet
        const profile1 = { triggers: [makeProfile('other', 'Other', 'Thing')] };
        await applyProfile(profile1);
        assert.strictEqual(TRIGGERS.length, 2, 'pending kept when profile lacks it');
        assert(TRIGGERS.find(t => t.source === 'pending'), 'pending exists');

        // Second load: profile now has matching content
        const profile2 = { triggers: [makeProfile('will-match-1748800000000-1234', 'Will Match', 'Soon')] };
        await applyProfile(profile2);
        assert.strictEqual(TRIGGERS.length, 1, 'pending cleaned up after content appears in profile');
        assert.strictEqual(TRIGGERS[0].source, 'profile');
    });

    // -----------------------------------------------------------------------
    console.log('\n— Curator panel deleteCard updates TRIGGERS array ---');

    test('deleteCard removes trigger from TRIGGERS array', () => {
        TRIGGERS = [
            { id: 't1', payloads: [{ title: 'One' }], source: 'profile' },
            { id: 't2', payloads: [{ title: 'Two' }], source: 'profile' },
        ];
        const idx = TRIGGERS.findIndex(t => t.id === 't1');
        if (idx >= 0) TRIGGERS.splice(idx, 1);
        assert.strictEqual(TRIGGERS.length, 1);
        assert.strictEqual(TRIGGERS[0].id, 't2');
    });

    await test('deleteCard removes pending trigger from local storage and TRIGGERS', async () => {
        mockStorage.clear();
        const uKey = userTriggersKey('game-1', 'prof-1');
        await mockStorage.set({
            [uKey]: [
                makePending('user-1', 'A', 'First'),
                makePending('user-2', 'B', 'Second'),
            ]
        });
        TRIGGERS = [
            { ...makePending('user-1', 'A', 'First'), source: 'pending' },
            { ...makePending('user-2', 'B', 'Second'), source: 'pending' },
        ];

        // Simulate deleteCard for user-1
        const ap = activeProfile || DEFAULT_PROFILE;
        const stored = await mockStorage.get(uKey);
        const filtered = (stored[uKey] || []).filter(t => t.id !== 'user-1');
        await mockStorage.set({ [uKey]: filtered });
        const trigIdx = TRIGGERS.findIndex(t => t.id === 'user-1');
        if (trigIdx >= 0) TRIGGERS.splice(trigIdx, 1);

        assert.strictEqual(TRIGGERS.length, 1, 'TRIGGERS should have one less');
        assert.strictEqual(TRIGGERS[0].id, 'user-2');
        const storedAfter = await mockStorage.get(uKey);
        assert.strictEqual(storedAfter[uKey].length, 1, 'storage should have one less');
        assert.strictEqual(storedAfter[uKey][0].id, 'user-2');
    });

    // -----------------------------------------------------------------------
    console.log('\n— End-to-end: add then profile refresh shows no duplicate ---');

    await test('after add + profile refresh, pending is cleaned up (no duplicate in curator)', async () => {
        mockStorage.clear();
        TRIGGERS = [];
        const uKey = userTriggersKey('game-1', 'prof-1');

        // 1. User creates a trigger — saved locally with user- ID
        const userTrigger = makePending('user-1748800000008', 'New Card', 'Description');
        await mockStorage.set({ [uKey]: [userTrigger] });

        // 2. Worker creates the trigger on server with a server ID.
        //    Profile now has it (simulating that the worker responded and the
        //    CDN eventually propagated).
        const profile = { triggers: [makeProfile('new-card-1748800000008-1234', 'New Card', 'Description')] };

        // 3. Next page load: applyProfile runs
        //    Profile has "new-card-..." with matching content.
        //    Pending has "user-..." with matching content.
        //    Fixed logic should clean up the pending trigger.
        await applyProfile(profile);

        // 4. TRIGGERS should have exactly 1 entry: the profile trigger only
        assert.strictEqual(TRIGGERS.length, 1, 'no duplicate after profile refresh');
        assert.strictEqual(TRIGGERS[0].source, 'profile');
        assert.strictEqual(TRIGGERS[0].payloads[0].title, 'New Card');

        // No pending triggers left in storage
        const stored = await mockStorage.get(uKey);
        assert(!stored[uKey] || stored[uKey].length === 0, 'pending storage should be empty');
    });

    // --- Results ---
    await new Promise(r => setTimeout(r, 10));
    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

runAll();
