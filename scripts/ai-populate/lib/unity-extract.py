#!/usr/bin/env python3
"""unity-extract.py — Export icon sprites from a Unity game install via UnityPy.

Usage:
  py unity-extract.py --install <game-data-dir> --ids <json-file> --outdir <dir>

The --ids file is a JSON array of objects with a "num" field (e.g. [{"num":"504"},...]).
Sprites are matched by name "Relic_{num}" (or the prefix from --prefix, default "Relic_").
"""
import argparse, json, os, sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--install', required=True, help='Path to game _Data directory')
    parser.add_argument('--ids', required=True, help='JSON file with [{num, ...}, ...]')
    parser.add_argument('--outdir', required=True, help='Output directory for PNGs')
    parser.add_argument('--prefix', default='Relic_', help='Sprite name prefix (default: Relic_)')
    parser.add_argument('--assets-file', default='sharedassets1.assets',
                        help='Assets file containing sprites (default: sharedassets1.assets)')
    args = parser.parse_args()

    try:
        import UnityPy
    except ImportError:
        print("ERROR: UnityPy not installed. Run: pip install UnityPy", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)
    batch = json.load(open(args.ids))
    want = set(f"{args.prefix}{e['num']}" for e in batch)
    print(f"Want {len(want)} sprites from {args.assets_file}")

    assets_path = os.path.join(args.install, args.assets_file)
    if not os.path.exists(assets_path):
        print(f"ERROR: {assets_path} not found", file=sys.stderr)
        sys.exit(1)

    got = {}
    env = UnityPy.load(assets_path)
    for obj in env.objects:
        if obj.type.name != 'Sprite':
            continue
        try:
            d = obj.read()
        except Exception:
            continue
        name = getattr(d, 'm_Name', '') or ''
        if name in want and name not in got:
            try:
                img = d.image
                img.save(os.path.join(args.outdir, name + '.png'))
                got[name] = img.size
            except Exception as e:
                print(f"  FAIL {name}: {e}", file=sys.stderr)

    missing = want - set(got.keys())
    print(f"Exported {len(got)}/{len(want)}")
    if missing:
        print(f"Missing {len(missing)}: {sorted(missing)[:10]}...")

if __name__ == '__main__':
    main()
