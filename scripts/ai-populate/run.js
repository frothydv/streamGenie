#!/usr/bin/env node
// run.js — Orchestrator for the ai-populate pipeline.
// Runs: wiki-scrape → crossref → unity-extract → assemble → validate
// Usage: node run.js --config <game-config.json>
//
// Config format:
// {
//   "gameId": "guildrun",
//   "gameName": "Guildrun",
//   "wikiListingUrl": "https://guildrunwiki.com/relics/",
//   "prefix": "Relic_",
//   "install": "C:/Program Files (x86)/Steam/steamapps/common/Guildrun Demo/Guildrun_Data",
//   "assetsFile": "sharedassets1.assets",
//   "outDir": "./out/guildrun",
//   "dilate": 4,
//   "skipValidate": false
// }
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const LIB = path.join(__dirname, 'lib');

function run(cmd, label) {
  console.log(`\n=== ${label} ===`);
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: path.join(__dirname, '..', '..') });
}

function main() {
  const args = process.argv.slice(2);
  const configIdx = args.indexOf('--config');
  if (configIdx < 0) { console.error('Usage: node run.js --config <game-config.json>'); process.exit(1); }
  const config = JSON.parse(fs.readFileSync(args[configIdx + 1], 'utf8'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-populate-'));
  const wikiHtml = path.join(tmpDir, 'wiki.html');
  const matchedJson = path.join(tmpDir, 'matched.json');
  const detailsJson = path.join(tmpDir, 'details.json');
  const iconsDir = path.join(tmpDir, 'icons');
  const outDir = config.outDir || path.join(tmpDir, 'profile');

  const prefix = config.prefix || 'Relic_';
  const dilate = config.dilate ?? 4;

  console.log(`Pipeline for ${config.gameId} (${config.gameName})`);
  console.log(`Wiki: ${config.wikiListingUrl}`);
  console.log(`Install: ${config.install}`);
  console.log(`Temp: ${tmpDir}`);

  // Step 1: Fetch wiki listing HTML (for crossref)
  console.log('\n=== Step 1: Fetch wiki listing ===');
  execSync(`node -e "fetch('${config.wikiListingUrl}').then(r=>r.text()).then(t=>require('fs').writeFileSync('${wikiHtml.replace(/\\/g, '\\\\')}',t))"`, { stdio: 'inherit' });

  // Step 2: Enumerate sprite names from game install
  console.log('\n=== Step 2: Enumerate sprites ===');
  const texNamesFile = path.join(tmpDir, 'tex_names.txt');
  const enumScript = `
import UnityPy, glob, os
base = r"${config.install.replace(/\\/g, '\\\\')}"
files = sorted(glob.glob(base + "/sharedassets*.assets")) + sorted(glob.glob(base + "/level*")) + [base + "/resources.assets"]
seen = {}
for f in files:
    try: env = UnityPy.load(f)
    except: continue
    for obj in env.objects:
        if obj.type.name in ("Texture2D","Sprite"):
            try:
                d = obj.read(); name = getattr(d,"m_Name","") or ""
                w = getattr(d,"m_Width",None); h = getattr(d,"m_Height",None)
            except: name,w,h = "",None,None
            if name and name not in seen: seen[name] = (w,h,obj.type.name)
with open(r"${texNamesFile.replace(/\\/g, '\\\\')}", "w") as out:
    for n,(w,h,t) in sorted(seen.items()): out.write(f"{t}\\t{w}x{h}\\t{n}\\n")
print(f"Enumerated {len(seen)} unique texture/sprite names")
`;
  const enumPy = path.join(tmpDir, 'enum.py');
  fs.writeFileSync(enumPy, enumScript);
  execSync(`py "${enumPy}"`, { stdio: 'inherit' });

  // Step 3: Cross-reference
  run(`node "${path.join(LIB, 'crossref.js')}" --wiki "${wikiHtml}" --sprites "${texNamesFile}" --out "${matchedJson}" --prefix "${prefix}"`,
    'Step 3: Cross-reference');

  // Step 4: Fetch wiki details
  // Reuse wiki-scrape with the listing URL
  run(`node "${path.join(LIB, 'wiki-scrape.js')}" --url "${config.wikiListingUrl}" --out "${detailsJson}"`,
    'Step 4: Fetch wiki details');

  // Filter details to only matched entries
  const matched = JSON.parse(fs.readFileSync(matchedJson, 'utf8'));
  const matchedNums = new Set(matched.map(m => m.num));
  const allDetails = JSON.parse(fs.readFileSync(detailsJson, 'utf8'));
  const filteredDetails = allDetails.filter(d => matchedNums.has(d.num));
  fs.writeFileSync(detailsJson, JSON.stringify(filteredDetails, null, 2));
  console.log(`Filtered details to ${filteredDetails.length} matched entries`);

  // Step 5: Extract icons
  run(`py "${path.join(LIB, 'unity-extract.py')}" --install "${config.install}" --ids "${matchedJson}" --outdir "${iconsDir}" --prefix "${prefix}" --assets-file "${config.assetsFile || 'sharedassets1.assets'}"`,
    'Step 5: Extract icons');

  // Step 6: Assemble profile
  run(`node "${path.join(LIB, 'assemble.js')}" --details "${detailsJson}" --icons "${iconsDir}" --out "${outDir}" --game-id "${config.gameId}" --game-name "${config.gameName}" --dilate ${dilate} --prefix "${prefix}"`,
    'Step 6: Assemble profile');

  // Step 7: Validate
  if (!config.skipValidate) {
    run(`node "${path.join(LIB, 'validate.js')}" --profile "${path.join(outDir, 'profile.json')}" --refs "${path.join(outDir, 'references')}"`,
      'Step 7: Validate');
  }

  console.log(`\n=== Done ===`);
  console.log(`Profile: ${path.join(outDir, 'profile.json')}`);
  console.log(`References: ${path.join(outDir, 'references')}`);
  console.log(`Temp dir: ${tmpDir} (not cleaned — inspect if needed)`);
}

main();
