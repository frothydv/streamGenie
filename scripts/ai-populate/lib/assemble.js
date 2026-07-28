#!/usr/bin/env node
// assemble.js — Build profile.json + reference PNGs from wiki details + extracted icons.
// Usage: node assemble.js --details <details.json> --icons <dir> --out <outdir>
//        [--game-id guildrun] [--game-name Guildrun] [--profile-id community]
//        [--dilate 4] [--prefix Relic_]
'use strict';
const fs = require('fs');
const { PNG } = require('pngjs');
const path = require('path');

function dilate(a, w, h, R) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (a[y * w + x] >= 128) { out[y * w + x] = 255; continue; }
    let hit = false;
    for (let dy = -R; dy <= R && !hit; dy++) for (let dx = -R; dx <= R && !hit; dx++) {
      const ny = y + dy, nx = x + dx;
      if (ny >= 0 && ny < h && nx >= 0 && nx < w && a[ny * w + nx] >= 128) hit = true;
    }
    out[y * w + x] = hit ? 255 : 0;
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
  const detailsFile = get('--details');
  const iconsDir = get('--icons');
  const outDir = get('--out');
  const gameId = get('--game-id', 'guildrun');
  const gameName = get('--game-name', 'Guildrun');
  const profileId = get('--profile-id', 'community');
  const dilateR = parseInt(get('--dilate', '4'), 10);
  const prefix = get('--prefix', 'Relic_');

  if (!detailsFile || !iconsDir || !outDir) {
    console.error('Usage: --details <json> --icons <dir> --out <dir> [--game-id ...] [--dilate 4]');
    process.exit(1);
  }

  const refDir = path.join(outDir, 'references');
  fs.mkdirSync(refDir, { recursive: true });

  const details = JSON.parse(fs.readFileSync(detailsFile, 'utf8'));
  const triggers = [];
  let skipped = 0;

  for (const r of details) {
    const iconPath = path.join(iconsDir, prefix + r.num + '.png');
    if (!fs.existsSync(iconPath)) { skipped++; continue; }

    const icon = PNG.sync.read(fs.readFileSync(iconPath));
    const iconBuf = fs.readFileSync(iconPath);

    // Build dilated mask
    const a = new Uint8Array(icon.width * icon.height);
    for (let i = 0; i < icon.width * icon.height; i++) a[i] = icon.data[i * 4 + 3];
    const dilated = dilate(a, icon.width, icon.height, dilateR);
    const maskPng = new PNG({ width: icon.width, height: icon.height });
    for (let i = 0; i < icon.width * icon.height; i++) {
      maskPng.data[i * 4] = 255; maskPng.data[i * 4 + 1] = 255;
      maskPng.data[i * 4 + 2] = 255; maskPng.data[i * 4 + 3] = dilated[i];
    }
    const maskDataUrl = 'data:image/png;base64,' + PNG.sync.write(maskPng).toString('base64');

    const triggerId = prefix.toLowerCase().replace(/_$/, '-') + r.num;
    const refFilename = triggerId + '-0.png';
    fs.copyFileSync(iconPath, path.join(refDir, refFilename));

    triggers.push({
      id: triggerId,
      payloads: [{ title: r.name, text: r.description || '', popupOffset: { x: 0, y: 0 }, image: null }],
      references: [{ file: refFilename, w: 96, h: 96, srcW: 3840, srcH: 2160, maskDataUrl }],
      scale: { min: 0.3, max: 2.5, step: 1.1 },
      rotation: { mode: 'none' },
    });
  }

  const profile = {
    schemaVersion: '1',
    game: { id: gameId, name: gameName },
    id: profileId,
    name: `${gameName} Community`,
    description: `AI-generated annotations from wiki + extracted game icons. ${triggers.length} triggers.`,
    version: '0.1.0',
    triggers,
  };

  fs.writeFileSync(path.join(outDir, 'profile.json'), JSON.stringify(profile, null, 2));
  const sz = fs.statSync(path.join(outDir, 'profile.json')).size;
  console.log(`Profile: ${triggers.length} triggers (${(sz / 1024 / 1024).toFixed(1)}MB), skipped ${skipped}`);
}

main();
