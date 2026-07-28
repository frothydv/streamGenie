# ai-populate — Wiki-driven profile generation

Builds Stream Genie profiles from wiki data + extracted game icons.

## Pipeline

1. **Wiki scrape** — fetch listing page (IDs, names) + detail pages (descriptions)
2. **Unity extract** — export icon sprites from game install via UnityPy
3. **Cross-reference** — match wiki IDs to game sprite names
4. **Assemble** — build `profile.json` with dilated alpha masks + scale sweep
5. **Validate** — batch-validate all triggers against H.264-encoded 1080p frames

## Usage

```bash
# Full pipeline for Guildrun relics
node scripts/ai-populate/run.js --game guildrun --wiki-url https://guildrunwiki.com/ \
  --category relics --install "C:/Program Files (x86)/Steam/steamapps/common/Guildrun Demo"

# Or run steps individually:
node scripts/ai-populate/lib/wiki-scrape.js --url https://guildrunwiki.com/relics/ --out /tmp/wiki_relics.json
node scripts/ai-populate/lib/crossref.js --wiki /tmp/wiki_relics.json --sprites /tmp/all_tex_names.txt --out /tmp/matched.json
py scripts/ai-populate/lib/unity-extract.py --install "..." --ids /tmp/matched.json --outdir /tmp/icons/
node scripts/ai-populate/lib/assemble.js --details /tmp/details.json --icons /tmp/icons/ --out /tmp/profile/
node scripts/ai-populate/lib/validate.js --profile /tmp/profile/profile.json --refs /tmp/profile/references/
```

## Requirements

- Node.js 18+ (built-in fetch)
- Python 3.10+ with `UnityPy` (`pip install UnityPy`)
- ffmpeg on PATH (for H.264 validation encoding)

## How it works

The wiki provides structured text (name, description, rarity, internal ID).
The game install provides icon art (RGBA sprites with alpha = mask).
Matching is deterministic by ID (e.g. wiki `Relic_504` = game sprite `Relic_504`).

The assembler builds masked references with 4px-dilated alpha for better dHash
localization, and declares a scale sweep (0.4x-2.0x) for resolution independence.

Validation composites icons into 1080p frames, H.264-encodes at CRF 23 (Twitch
quality), and runs the real matcher-core. Results: ~69% auto-match, ~31%
review-tier, ~0.3% dead on Guildrun relics.

## Generalization

- **MediaWiki wikis** (Fandom, wiki.gg): use `--engine mediawiki` — the API
  provides infobox data (name, icon filename, description) deterministically.
- **Custom wikis** (like guildrunwiki.com): use `--engine custom` with a
  per-site scraper config.
- **Image sources**: `unity-extract` for Unity games; wiki images for MediaWiki;
  VOD crops as universal fallback.
