#!/usr/bin/env node
// validate.js — Batch-validate profile triggers against H.264-encoded 1080p frames.
// Composites icons in a 5x5 grid, encodes via ffmpeg, runs the real matcher-core.
// Usage: node validate.js --profile <profile.json> --refs <references-dir> [--ffmpeg <path>]
'use strict';
const fs = require('fs');
const { PNG } = require('pngjs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const MC = require('../../../extension/matcher-core.js');
const matcher = MC.createMatcher();
const CAP = matcher.config.captureSize;

const COLS = 5, ROWS = 5, ICON_SIZE = 96, CELL_W = 384, CELL_H = 216, BATCH = 25;
const FW = 1920, FH = 1080;

function nnResize(src, sw, sh, dw, dh) {
  const o = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) { const sy = Math.min(sh - 1, Math.floor(y * sh / dh));
    for (let x = 0; x < dw; x++) { const sx = Math.min(sw - 1, Math.floor(x * sw / dw));
      const s = (sy * sw + sx) * 4, d = (y * dw + x) * 4;
      o[d] = src[s]; o[d+1] = src[s+1]; o[d+2] = src[s+2]; o[d+3] = src[s+3]; } }
  return o;
}
function rgbaFromAlpha(a, w, h) { const o = new Uint8Array(w*h*4); for (let i=0;i<w*h;i++){o[i*4]=255;o[i*4+1]=255;o[i*4+2]=255;o[i*4+3]=a[i];} return o; }
function bbox(a, w, h) { let x0=w,y0=h,x1=-1,y1=-1; for (let y=0;y<h;y++) for (let x=0;x<w;x++) if (a[y*w+x]>=128){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;} return x1<0?null:{x:x0,y:y0,w:x1-x0+1,h:y1-y0+1}; }
function cropRGBA(rgba, w, r) { const o=new Uint8Array(r.w*r.h*4); for (let y=0;y<r.h;y++) for (let x=0;x<r.w;x++){const s=((r.y+y)*w+(r.x+x))*4,d=(y*r.w+x)*4;o[d]=rgba[s];o[d+1]=rgba[s+1];o[d+2]=rgba[s+2];o[d+3]=rgba[s+3];} return o; }
function cropAlpha(a, w, r) { const o=new Uint8Array(r.w*r.h); for (let y=0;y<r.h;y++) for (let x=0;x<r.w;x++) o[y*r.w+x]=a[(r.y+y)*w+(r.x+x)]; return o; }

function buildRef(icon, onW, onH) {
  const a = new Uint8Array(icon.width * icon.height);
  for (let i = 0; i < icon.width * icon.height; i++) a[i] = icon.data[i * 4 + 3];
  const fullMask = rgbaFromAlpha(a, icon.width, icon.height);
  const fullMask32 = matcher.scalePixels(fullMask, icon.width, icon.height, 32, 32);
  const vbFull = matcher.maskBitsFromPixels(fullMask32, 32, 0, 0, 32, 32).validBits;
  const bb = bbox(a, icon.width, icon.height);
  const useCrop = vbFull < 16 && bb && bb.w >= 8 && bb.h >= 8;
  const r = useCrop ? bb : { x: 0, y: 0, w: icon.width, h: icon.height };
  const cropC = cropRGBA(icon.data, icon.width, r);
  const cropA = cropAlpha(a, icon.width, r);
  const cropM = rgbaFromAlpha(cropA, r.w, r.h);
  const canon = nnResize(cropC, r.w, r.h, 32, 32);
  const ref = { w: onW, h: onH, scale: { min: 0.4, max: 2.0, step: 1.1 } };
  ref.refHash = matcher.dHashFromPixels(canon, 32, 0, 0, 32, 32);
  const canonMask = matcher.scalePixels(cropM, r.w, r.h, 32, 32);
  const mb = matcher.maskBitsFromPixels(canonMask, 32, 0, 0, 32, 32);
  ref.refBitMask = mb.bits; ref.refValidBits = mb.validBits;
  if (ref.refValidBits < 16) { ref.refHash = null; return ref; }
  const vr = matcher.buildVerifyRefFromPixels(canon, canonMask);
  ref.refVerifyValues = vr.values; ref.refVerifyMask = vr.mask; ref.refVerifyActive = vr.active;
  const nativeC = nnResize(cropC, r.w, r.h, onW, onH);
  const nativeM = matcher.scalePixels(cropM, r.w, r.h, onW, onH);
  ref.refNCC = matcher.buildRefNCC(nativeC, onW, onH, nativeM);
  const factors = matcher.scalesForSchema(ref.scale);
  const variants = [];
  if (factors) for (const s of factors) {
    const sw = Math.round(onW * s), sh = Math.round(onH * s);
    if (sw < 8 || sh < 8 || sw > CAP * 4 || sh > CAP * 4) continue;
    const spx = matcher.scalePixels(nativeC, onW, onH, sw, sh);
    const smk = matcher.scalePixels(nativeM, onW, onH, sw, sh);
    variants.push({ scale: s, w: sw, h: sh, refHash: ref.refHash, refBitMask: ref.refBitMask,
                    refValidBits: ref.refValidBits, refNCC: matcher.buildRefNCC(spx, sw, sh, smk) });
  }
  ref.scaledRefs = variants.length ? variants : null;
  return ref;
}

function extractCapture(fd, fw, fh, cx, cy) {
  const half = Math.floor(CAP / 2);
  const x0 = Math.max(0, Math.min(fw - CAP, cx - half));
  const y0 = Math.max(0, Math.min(fh - CAP, cy - half));
  const cap = new Uint8Array(CAP * CAP * 4);
  for (let y = 0; y < CAP; y++) for (let x = 0; x < CAP; x++) {
    const sx = Math.min(fw - 1, x0 + x), sy = Math.min(fh - 1, y0 + y);
    const s = (sy * fw + sx) * 4, d = (y * CAP + x) * 4;
    cap[d] = fd[s]; cap[d+1] = fd[s+1]; cap[d+2] = fd[s+2]; cap[d+3] = 255;
  }
  return { cap, offX: x0, offY: y0 };
}

function makeFlatFrame(seed) {
  const buf = new Uint8Array(FW * FH * 4);
  let s = seed; const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < FW * FH; i++) { const g = 80 + Math.floor(rng() * 40);
    buf[i*4] = g; buf[i*4+1] = g + Math.floor(rng() * 10 - 5); buf[i*4+2] = g + Math.floor(rng() * 10 - 5); buf[i*4+3] = 255; }
  return buf;
}

function findFfmpeg() {
  const candidates = [
    'ffmpeg',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'),
  ];
  try { execSync('ffmpeg -version', { stdio: 'pipe' }); return 'ffmpeg'; } catch {}
  // Search WinGet packages
  const wgBase = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wgBase)) {
    const dirs = fs.readdirSync(wgBase).filter(d => d.toLowerCase().includes('ffmpeg'));
    for (const d of dirs) {
      const bin = path.join(wgBase, d, 'bin', 'ffmpeg.exe');
      if (fs.existsSync(bin)) return bin;
      // versioned subdir
      const subs = fs.readdirSync(path.join(wgBase, d)).filter(s => s.startsWith('ffmpeg'));
      for (const s of subs) {
        const bin2 = path.join(wgBase, d, s, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(bin2)) return bin2;
      }
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const profileFile = get('--profile');
  const refsDir = get('--refs');
  let ffmpeg = get('--ffmpeg');

  if (!profileFile || !refsDir) {
    console.error('Usage: --profile <profile.json> --refs <dir> [--ffmpeg <path>]');
    process.exit(1);
  }

  if (!ffmpeg) ffmpeg = findFfmpeg();
  if (!ffmpeg) { console.error('ffmpeg not found. Install or pass --ffmpeg <path>'); process.exit(1); }
  console.log('ffmpeg:', ffmpeg);

  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const triggers = profile.triggers;
  console.log(`Validating ${triggers.length} triggers...`);

  // Build refs
  const allRefs = [], allIcons = [];
  for (const t of triggers) {
    const icon = PNG.sync.read(fs.readFileSync(path.join(refsDir, t.references[0].file)));
    allIcons.push(icon);
    allRefs.push(buildRef(icon, ICON_SIZE, ICON_SIZE));
  }
  const deadCount = allRefs.filter(r => !r.refHash).length;
  console.log(`Built refs: ${allRefs.length - deadCount} active, ${deadCount} dead`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-validate-'));
  let totalPass = 0, totalFail = 0, totalDead = 0;

  for (let batchStart = 0; batchStart < triggers.length; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH, triggers.length);
    const batchIdx = batchStart / BATCH + 1;
    const totalBatches = Math.ceil(triggers.length / BATCH);

    const out = new PNG({ width: FW, height: FH });
    out.data.set(makeFlatFrame(42 + batchIdx * 1000));
    const placements = [];

    for (let i = 0; i < batchEnd - batchStart; i++) {
      const gi = batchStart + i;
      const icon = allIcons[gi];
      const col = i % COLS, row = Math.floor(i / COLS);
      const cx = col * CELL_W + Math.floor(CELL_W / 2), cy = row * CELL_H + Math.floor(CELL_H / 2);
      const px = cx - Math.floor(ICON_SIZE / 2), py = cy - Math.floor(ICON_SIZE / 2);
      const resized = nnResize(icon.data, icon.width, icon.height, ICON_SIZE, ICON_SIZE);
      for (let y = 0; y < ICON_SIZE; y++) for (let x = 0; x < ICON_SIZE; x++) {
        const si = (y * ICON_SIZE + x) * 4;
        if (resized[si + 3] < 128) continue;
        const di = ((py + y) * FW + (px + x)) * 4;
        out.data[di] = resized[si]; out.data[di+1] = resized[si+1]; out.data[di+2] = resized[si+2]; out.data[di+3] = 255;
      }
      placements.push({ gi, cx, cy });
    }

    const compPath = path.join(tmpDir, `b${batchIdx}.png`);
    const encPath = path.join(tmpDir, `b${batchIdx}_enc.png`);
    fs.writeFileSync(compPath, PNG.sync.write(out));
    execSync(`"${ffmpeg}" -y -i "${compPath}" -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p "${compPath}.mp4"`, { stdio: 'pipe' });
    execSync(`"${ffmpeg}" -y -i "${compPath}.mp4" -frames:v 1 -update 1 "${encPath}"`, { stdio: 'pipe' });

    const enc = PNG.sync.read(fs.readFileSync(encPath));
    for (const p of placements) {
      const ref = allRefs[p.gi];
      if (!ref.refHash) { totalDead++; continue; }
      const { cap, offX, offY } = extractCapture(enc.data, enc.width, enc.height, p.cx, p.cy);
      const gray = matcher.fillGrayBuffer(cap);
      const { sat, sat2 } = matcher.buildSAT(gray, CAP, CAP);
      const res = matcher.evaluateReference(ref, cap, gray, false, sat, sat2, { x: p.cx - offX, y: p.cy - offY });
      if (res.matched) totalPass++; else totalFail++;
    }
    process.stdout.write(`  batch ${batchIdx}/${totalBatches}: pass=${totalPass} fail=${totalFail} dead=${totalDead}\n`);
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const active = totalPass + totalFail;
  console.log(`\n=== RESULTS: ${totalPass} passed, ${totalFail} failed, ${totalDead} dead / ${triggers.length} ===`);
  console.log(`Active pass rate: ${(100 * totalPass / active).toFixed(1)}%`);
  process.exit(totalFail > active * 0.5 ? 1 : 0); // exit 1 if >50% fail
}

main();
