const https = require('https');

const CATALOG_URL = "https://raw.githubusercontent.com/frothydv/streamGenieProfiles/main/catalog.json";

function fetchUrl(url) {
    const finalUrl = `${url}?_cb=${Date.now()}`;
    console.log(`Fetching: ${finalUrl}`);
    return new Promise((resolve, reject) => {
        https.get(finalUrl, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`Status: ${res.statusCode}`));
                }
            });
        }).on('error', reject);
    });
}

async function runCheck() {
    try {
        console.log('--- Step 1: Fetching Catalog ---');
        const catalog = await fetchUrl(CATALOG_URL);
        const sts2 = catalog.games.find(g => g.id === 'slay-the-spire-2');
        if (!sts2) throw new Error('STS2 not found in catalog');
        
        const community = sts2.profiles.find(p => p.id === 'community');
        if (!community) throw new Error('Community profile not found in catalog');
        
        let profileUrl = community.url;
        if (profileUrl.includes('cdn.jsdelivr.net')) {
            console.log('🔄 Converting jsDelivr URL to GitHub Raw for better sync...');
            profileUrl = profileUrl.replace('cdn.jsdelivr.net/gh/frothydv/streamGenieProfiles@main', 'raw.githubusercontent.com/frothydv/streamGenieProfiles/main');
        }
        console.log(`Profile URL: ${profileUrl}`);

        console.log('\n--- Step 2: Fetching Profile ---');
        const profile = await fetchUrl(profileUrl);
        
        console.log(`\nProfile Name: ${profile.name}`);
        console.log(`Total Triggers: ${profile.triggers.length}`);

        const membershipCard = profile.triggers.find(t => t.id === 'membership-card');
        if (membershipCard) {
            console.log('✅ Found "membership-card" trigger!');
        } else {
            console.log('❌ "membership-card" trigger MISSING in live data!');
        }

        const dups = {};
        profile.triggers.forEach(t => {
            dups[t.id] = (dups[t.id] || 0) + 1;
        });
        const dupList = Object.entries(dups).filter(([id, count]) => count > 1);
        if (dupList.length > 0) {
            console.log('\n⚠️ Found Duplicate IDs in profile:');
            dupList.forEach(([id, count]) => console.log(`  - ${id}: ${count} times`));
        } else {
            console.log('\n✅ No duplicate IDs found.');
        }

        console.log('\n--- Trigger List (Sorted) ---');
        profile.triggers
            .map(t => (t.payloads?.[0]?.title || t.id))
            .sort()
            .forEach(label => console.log(`  - ${label}`));

    } catch (err) {
        console.error('FAILED:', err.message);
        process.exit(1);
    }
}

runCheck();
