#!/usr/bin/env node
// wiki-scrape.js — Fetch listing + detail pages from a custom wiki.
// Usage: node wiki-scrape.js --url <listing-url> --out <output.json> [--concurrency 20]
// Output: [{slug, num, name, description, rarity}, ...]
'use strict';
const fs = require('fs');

function htmlDecode(s) {
  return s.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

async function fetchListing(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'StreamGenie-ai-populate/1.0' } });
  const html = await res.text();
  // Match: <a href="relic-NNN/"><span class="nm">Name
  const entries = [...html.matchAll(/<a href="([\w-]+-(\d+))\/"><span class="nm">([^<]+)/g)]
    .map(m => ({ slug: m[1], num: m[2], name: htmlDecode(m[3]) }));
  return entries;
}

async function fetchDetail(baseUrl, entry) {
  const url = `${baseUrl}${entry.slug}/`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'StreamGenie-ai-populate/1.0' } });
    const html = await res.text();
    const m = html.match(/data-lang-block="en"[^>]*>(.*?)<\/div>/s);
    let description = '';
    if (m) { description = htmlDecode(m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()); }
    const rm = html.match(/class="rarity[^"]*">([^<]+)/);
    return { ...entry, description, rarity: rm ? rm[1].trim() : '' };
  } catch (e) {
    return { ...entry, description: '', rarity: '' };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  const outIdx = args.indexOf('--out');
  const concIdx = args.indexOf('--concurrency');
  if (urlIdx < 0 || outIdx < 0) { console.error('Usage: --url <listing-url> --out <file> [--concurrency N]'); process.exit(1); }
  const url = args[urlIdx + 1];
  const outFile = args[outIdx + 1];
  const concurrency = concIdx >= 0 ? parseInt(args[concIdx + 1], 10) : 20;

  console.log(`Fetching listing: ${url}`);
  const entries = await fetchListing(url);
  console.log(`Found ${entries.length} entries`);

  const baseUrl = url.replace(/\/$/, '') + '/';
  const results = [];
  for (let i = 0; i < entries.length; i += concurrency) {
    const chunk = entries.slice(i, i + concurrency);
    const fetched = await Promise.all(chunk.map(e => fetchDetail(baseUrl.replace(/\/[^/]+\/$/, '/'), e)));
    results.push(...fetched);
    if ((i + concurrency) % 100 === 0 || i + concurrency >= entries.length)
      process.stdout.write(`  ${Math.min(i + concurrency, entries.length)}/${entries.length}\n`);
  }

  const withDesc = results.filter(r => r.description).length;
  console.log(`Done: ${withDesc}/${results.length} have descriptions`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`Written to ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
