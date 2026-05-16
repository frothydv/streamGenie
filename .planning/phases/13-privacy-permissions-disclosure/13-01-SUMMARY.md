---
plan: 13-01
phase: 13-privacy-permissions-disclosure
status: complete
completed: 2026-05-16
---

# Plan 13-01 Summary: Privacy & Permissions Disclosure

## What was built

Three documentation-only changes satisfying PRIV-01 and PRIV-02:

1. **popup.html** — Added a "Privacy →" anchor link inside the first-run banner's flex:1 text container. Styled in `#c9b3ff` at `opacity:0.85` (subdued, matching existing palette). Opens `https://frothydv.github.io/streamGenie/privacy` in a new tab with `rel="noopener noreferrer"` per T-13-01 mitigation.

2. **README.md** — Inserted a `## Permissions` section between `## How it works` (line 27) and `## Contributing triggers` (line 49). Six-row two-column table covering all manifest `permissions` and `host_permissions` entries with plain-English justifications.

3. **STORE-LISTING.md** (new) — Chrome Web Store submission copy at repo root. Contains:
   - Short description: 128 chars (labeled)
   - Full description with explicit privacy statement ("locally" / "nothing is transmitted")
   - Permissions Justification section matching the README table
   - Version: v0.9.2

## Commits

- `feat(13-01)`: popup.html privacy link
- `docs(13-01)`: README permissions table
- `docs(13-01)`: STORE-LISTING.md creation

## Key files

### key-files.created
- STORE-LISTING.md

### key-files.modified
- extension/popup.html
- README.md

## Self-Check: PASSED

All acceptance criteria verified:
- `grep -c "frothydv.github.io/streamGenie/privacy" extension/popup.html` → 1
- `target="_blank"` present → 1; `rel="noopener noreferrer"` present → 1
- `grep -c "## Permissions" README.md` → 1; positioned after How it works, before Contributing triggers
- All six permission strings present in README
- STORE-LISTING.md: all four sections present, char count labels present, "locally" → 1, "nothing" → 1, file size 2865 bytes

## Deviations

None. Tasks executed exactly as specified in the plan.
