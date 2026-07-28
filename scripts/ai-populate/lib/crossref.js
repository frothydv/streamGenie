#!/usr/bin/env node
// crossref.js — Match wiki entries to game sprite names by ID.
// Usage: node crossref.js --wiki <wiki-listing.html> --sprites <tex-names.txt> --out <matched.json> [--prefix Relic_]
'use strict';
const fs = require('fs');

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const wikiFile = get('--wiki');
  const spritesFile = get('--sprites');
  const outFile = get('--out');
  const prefix = get('--prefix') || 'Relic_';

  if (!wikiFile || !spritesFile || !outFile) {
    console.error('Usage: --wiki <html> --sprites <txt> --out <json> [--prefix Relic_]');
    process.exit(1);
  }

  const html = fs.readFileSync(wikiFile, 'utf8');
  const entries = [...html.matchAll(/<a href="([\w-]+-(\d+))\/"><span class="nm">([^<]+)/g)]
    .map(m => ({ slug: m[1], num: m[2], name: m[3].replace(/&#39;/g, "'").replace(/&amp;/g, "&") }));

  const sprites = new Set(
    fs.readFileSync(spritesFile, 'utf8').split(/\r?\n/)
      .map(l => (l.split('\t')[2] || '').trim())
      .filter(n => new RegExp(`^${prefix}\\d+$`).test(n))
  );

  const matched = entries.filter(e => sprites.has(prefix + e.num));
  console.log(`Wiki entries: ${entries.length}, sprites: ${sprites.size}, matched: ${matched.length}`);
  fs.writeFileSync(outFile, JSON.stringify(matched, null, 2));
}

main();
