const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// Load the STS2 test profile
const profile = {
    triggers: [
        {
            id: "block-potion",
            payloads: [{ title: "Block Potion", text: "Gain 12 Block", popupOffset: { x: -27, y: 19 } }],
            references: [
                { file: "block-potion-1776685464686.png", w: 38, h: 39, srcW: 1280, srcH: 720 }
            ]
        },
        {
            id: "floor",
            payloads: [{ title: "Floor", text: "The # of the floor...", popupOffset: { x: -28, y: 17 } }],
            references: [
                { file: "floor-1776685557484.png", w: 30, h: 35, srcW: 1280, srcH: 720 }
            ]
        },
        {
            id: "run-timer",
            payloads: [{ title: "Run Timer", text: "Amount of time since the run began", popupOffset: { x: -28, y: 25 } }],
            references: [
                { file: "run-timer-1776685705005.png", w: 45, h: 45, srcW: 1920, srcH: 1080 }
            ]
        },
        {
            id: "players-gold",
            payloads: [{ title: "Players Gold! $$$", text: "", popupOffset: { x: 58, y: -20 } }],
            references: [
                { file: "players-gold-1776694471215.png", w: 51, h: 55, srcW: 1920, srcH: 1080 }
            ]
        }
    ]
};

// Constants from the extension
const CAPTURE_SIZE = 160;
const MATCH_THRESHOLD_RATIO = 10 / 64;
const MASKED_MATCH_THRESHOLD_RATIO = 6 / 64;

// dHash implementation from the extension
function dHashFromPixels(pixels, srcW, sx, sy, sw, sh) {
    // Ensure we have valid dimensions
    if (sw < 1 || sh < 1) return 0n;

    // Resize to 9x8 grid
    const gridW = 9, gridH = 8;
    const grid = [];

    const blockW = sw / gridW;
    const blockH = sh / gridH;

    for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
            let sum = 0;
            let count = 0;

            for (let dy = 0; dy < blockH; dy++) {
                for (let dx = 0; dx < blockW; dx++) {
                    const px = Math.floor(sx + x * blockW + dx);
                    const py = Math.floor(sy + y * blockH + dy);

                    if (px >= 0 && px < srcW && py >= 0 && py < srcW / CAPTURE_SIZE * sh) {
                        const i = (py * CAPTURE_SIZE + px) * 4;
                        const gray = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
                        sum += gray;
                        count++;
                    }
                }
            }

            grid.push(sum / count);
        }
    }

    // Generate 64-bit hash
    let hash = 0n;
    for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW - 1; x++) {
            const idx = y * gridW + x;
            const bit = grid[idx] > grid[idx + 1] ? 1n : 0n;
            hash = (hash << 1n) | bit;
        }
    }

    return hash;
}

function dHashDistFromPixels(pixels, srcW, sx, sy, sw, sh, refHash, refBitMask, refValidBits) {
    const hash = dHashFromPixels(pixels, srcW, sx, sy, sw, sh);
    return hashDistance(hash, refHash, refBitMask, refValidBits);
}

function hashDistance(hash1, hash2, bitMask = 0xffffffffffffffffn, validBits = 64) {
    const xor = (hash1 ^ hash2) & bitMask;
    let dist = 0;
    let temp = xor;

    for (let i = 0; i < validBits; i++) {
        dist += temp & 1n;
        temp >>= 1n;
        if (temp === 0n) break;
    }

    return dist;
}

// Load reference images
async function loadReferenceImages() {
    const references = {};

    for (const trigger of profile.triggers) {
        const refFile = trigger.references[0];
        const filePath = path.join(__dirname, '../streamGenieProfiles/games/slay-the-spire-2/profiles/sts2-test/references', refFile.file);

        try {
            const pngData = fs.readFileSync(filePath);
            const png = PNG.sync.read(pngData);

            // Convert to flat array like in extension
            const pixels = [];
            for (let i = 0; i < png.data.length; i += 4) {
                pixels.push(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]);
            }

            // Compute reference hash
            const refHash = dHashFromPixels(pixels, refFile.w, 0, 0, refFile.w, refFile.h);

            references[trigger.id] = {
                ...refFile,
                hash: refHash,
                pixels: pixels,
                hashMask: 0xffffffffffffffffn,
                validBits: 64
            };

            console.log(`Loaded ${trigger.id}: ${refFile.w}x${refFile.h}, hash: ${refHash.toString(16)}`);
        } catch (error) {
            console.error(`Failed to load ${trigger.id}:`, error.message);
        }
    }

    return references;
}

// Create test canvas with triggers at known positions
function createTestCanvas(references) {
    const width = 1920;
    const height = 1080;
    const canvas = new PNG({ width, height });

    // Fill with black background
    for (let i = 0; i < canvas.data.length; i += 4) {
        canvas.data[i] = 0;     // R
        canvas.data[i + 1] = 0; // G
        canvas.data[i + 2] = 0; // B
        canvas.data[i + 3] = 255; // A
    }

    // Place triggers at known positions
    const testPositions = {
        "block-potion": { x: 100, y: 100 },
        "floor": { x: 500, y: 200 },
        "run-timer": { x: 900, y: 300 },
        "players-gold": { x: 1500, y: 400 }
    };

    // Draw each trigger
    for (const [triggerId, pos] of Object.entries(testPositions)) {
        const ref = references[triggerId];
        if (ref) {
            // Copy pixels from reference to test canvas
            for (let y = 0; y < ref.h; y++) {
                for (let x = 0; x < ref.w; x++) {
                    const srcIdx = (y * ref.w + x) * 4;
                    const dstIdx = ((pos.y + y) * width + (pos.x + x)) * 4;

                    canvas.data[dstIdx] = ref.pixels[srcIdx];
                    canvas.data[dstIdx + 1] = ref.pixels[srcIdx + 1];
                    canvas.data[dstIdx + 2] = ref.pixels[srcIdx + 2];
                    canvas.data[dstIdx + 3] = ref.pixels[srcIdx + 3];
                }
            }

            // Store expected position
            canvas[`expected_${triggerId}`] = pos;
        }
    }

    return canvas;
}

// Run matching test
async function runMatchingTest() {
    console.log('Loading reference images...');
    const references = await loadReferenceImages();

    if (Object.keys(references).length === 0) {
        console.error('No reference images loaded');
        return;
    }

    console.log('Creating test canvas...');
    const testCanvas = createTestCanvas(references);

    console.log('Running matching test...');
    const gridSize = 10;
    const results = [];
    const startTime = performance.now();

    // Test at grid points
    for (let y = 0; y < testCanvas.height; y += gridSize) {
        for (let x = 0; x < testCanvas.width; x += gridSize) {
            // Only test if we're within the capture area
            if (x < CAPTURE_SIZE / 2 || x >= testCanvas.width - CAPTURE_SIZE / 2 ||
                y < CAPTURE_SIZE / 2 || y >= testCanvas.height - CAPTURE_SIZE / 2) {
                continue;
            }

            // Extract capture region
            const capturePixels = [];
            for (let cy = 0; cy < CAPTURE_SIZE; cy++) {
                for (let cx = 0; cx < CAPTURE_SIZE; cx++) {
                    const srcX = x - CAPTURE_SIZE / 2 + cx;
                    const srcY = y - CAPTURE_SIZE / 2 + cy;
                    const idx = (srcY * testCanvas.width + srcX) * 4;

                    capturePixels.push(
                        testCanvas.data[idx],
                        testCanvas.data[idx + 1],
                        testCanvas.data[idx + 2],
                        testCanvas.data[idx + 3]
                    );
                }
            }

            // Test each trigger
            for (const [triggerId, ref] of Object.entries(references)) {
                const expected = testCanvas[`expected_${triggerId}`];
                const distToExpected = Math.abs(x - expected.x) + Math.abs(y - expected.y);

                if (distToExpected < 100) { // Within 100 pixels
                    // Compute hash distance
                    const distance = dHashDistFromPixels(
                        capturePixels,
                        CAPTURE_SIZE,
                        0, 0,
                        ref.w, ref.h,
                        ref.hash,
                        ref.hashMask,
                        ref.validBits
                    );

                    const threshold = ref.validBits < 64 ? MASKED_MATCH_THRESHOLD_RATIO : MATCH_THRESHOLD_RATIO;
                    const matches = distance <= threshold * ref.validBits;

                    results.push({
                        x, y,
                        trigger: triggerId,
                        expected: expected,
                        distance: distToExpected,
                        hashDistance: distance,
                        matches: matches,
                        threshold: threshold * ref.validBits
                    });
                }
            }
        }
    }

    const endTime = performance.now();
    const totalTime = endTime - startTime;

    // Analyze results
    console.log('\n=== Test Results ===');
    console.log(`Total test time: ${totalTime.toFixed(2)}ms`);
    console.log(`Grid points tested: ${results.length}`);
    console.log(`Performance: ${(results.length / totalTime * 1000).toFixed(0)} points/second\n`);

    // Group by trigger
    const grouped = {};
    results.forEach(r => {
        if (!grouped[r.trigger]) grouped[r.trigger] = [];
        grouped[r.trigger].push(r);
    });

    Object.entries(grouped).forEach(([trigger, matches]) => {
        const nearExpected = matches.filter(m => m.distance < 50).length;
        const total = matches.length;
        const successfulMatches = matches.filter(m => m.matches).length;

        console.log(`Trigger: ${trigger}`);
        console.log(`  Points near expected: ${nearExpected}/${total}`);
        if (nearExpected > 0) {
            const successRate = (successfulMatches / nearExpected * 100).toFixed(1);
            console.log(`  Match success rate: ${successRate}% (${successfulMatches}/${nearExpected})`);

            // Show false negatives (points that should match but don't)
            const falseNegatives = matches.filter(m => m.distance < 50 && !m.matches);
            if (falseNegatives.length > 0) {
                console.log(`  False negatives:`);
                falseNegatives.slice(0, 3).forEach(m => {
                    console.log(`    (${m.x}, ${m.y}) dist=${m.distance.toFixed(1)} hash_dist=${m.hashDistance} threshold=${m.threshold.toFixed(1)}`);
                });
            }

            // Show false positives (points that match but shouldn't)
            const falsePositives = matches.filter(m => m.distance >= 50 && m.matches);
            if (falsePositives.length > 0) {
                console.log(`  False positives:`);
                falsePositives.slice(0, 3).forEach(m => {
                    console.log(`    (${m.x}, ${m.y}) dist=${m.distance.toFixed(1)} hash_dist=${m.hashDistance}`);
                });
            }
        }
        console.log('');
    });

    // Save test image for inspection
    const testImageBuffer = PNG.sync.write(testCanvas);
    fs.writeFileSync('test-canvas.png', testImageBuffer);
    console.log('Test canvas saved as test-canvas.png');
}

// Run the test
runMatchingTest().catch(console.error);