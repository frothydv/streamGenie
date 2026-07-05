#!/usr/bin/env node
// Build script: packages extension/ into dist/stream-genie-v<version>.zip
// for Chrome Web Store upload.
//
// Uses an explicit allowlist of files/dirs to stage into a clean temp
// directory before zipping — nothing outside PACKAGE_ENTRIES ever reaches
// the zip, no matter what else ends up sitting in extension/ (a stray
// .env, a debug dump, notes with a real credential, etc.). Add to the
// allowlist deliberately when the extension gains a new shipped file.
//
// Usage: node scripts/build-alpha.js

const { execFileSync } = require("child_process");
const path = require("path");
const fs   = require("fs");
const os   = require("os");

const root   = path.join(__dirname, "..");
const extDir = path.join(root, "extension");

// Every file/dir that ships to the Chrome Web Store.
const PACKAGE_ENTRIES = [
  "manifest.json",
  "background.js",
  "content.js",
  "matcher-core.js",
  "config.js",
  "popup.html",
  "popup.js",
  "icons",
  "references",
];

// Present in extension/ but intentionally not shipped — no warning for these.
const KNOWN_NON_PACKAGE = new Set(["config.example.js"]);

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function checkSyntax(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    fail(`Syntax error in ${path.relative(root, file)}:\n${err.stderr}`);
  }
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

function main() {
  // --- config.js must exist and must not be the placeholder ---------------
  const configPath = path.join(extDir, "config.js");
  if (!fs.existsSync(configPath)) {
    fail("extension/config.js is missing. Copy config.example.js to config.js and set the real SUBMIT_SECRET.");
  }
  if (fs.readFileSync(configPath, "utf8").includes("your-secret-here")) {
    fail("extension/config.js still has the placeholder secret. Set the real SUBMIT_SECRET before packaging.");
  }

  // --- manifest.json must parse and carry a version ------------------------
  const manifestPath = path.join(extDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail(`extension/manifest.json is not valid JSON: ${err.message}`);
  }
  const version = manifest.version;
  if (!version) fail("manifest.json has no version field.");

  // --- every allowlisted entry must actually exist --------------------------
  for (const entry of PACKAGE_ENTRIES) {
    if (!fs.existsSync(path.join(extDir, entry))) {
      fail(`Expected file/dir missing from extension/: ${entry}`);
    }
  }

  // --- flag anything in extension/ that isn't allowlisted or known ----------
  const actual = fs.readdirSync(extDir);
  const unexpected = actual.filter(e => !PACKAGE_ENTRIES.includes(e) && !KNOWN_NON_PACKAGE.has(e));
  if (unexpected.length) {
    console.warn(`\n⚠ Found extra files in extension/ NOT included in the package (left out — verify this is intentional):`);
    for (const e of unexpected) console.warn(`    ${e}`);
    console.warn("");
  }

  // --- syntax-check every shipped JS file before packaging -------------------
  console.log("Checking JS syntax...");
  for (const entry of PACKAGE_ENTRIES) {
    const full = path.join(extDir, entry);
    if (entry.endsWith(".js") && fs.statSync(full).isFile()) checkSyntax(full);
  }
  console.log("  ok");

  // --- stage allowlisted files in a clean temp dir ---------------------------
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-package-"));
  for (const entry of PACKAGE_ENTRIES) {
    copyRecursive(path.join(extDir, entry), path.join(stageDir, entry));
  }

  // --- zip the staged dir (only what was staged can be in the zip) -----------
  const distDir = path.join(root, "dist");
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  const zipName = `stream-genie-v${version}.zip`;
  const zipPath = path.join(distDir, zipName);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  console.log(`Building ${zipName}...`);
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Compress-Archive -Path "${stageDir}\\*" -DestinationPath "${zipPath}"`],
    { stdio: "inherit" }
  );

  fs.rmSync(stageDir, { recursive: true, force: true });

  // --- verify + print final contents -----------------------------------------
  const listCmd = `
    Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $zip = [System.IO.Compression.ZipFile]::OpenRead("${zipPath}");
    $zip.Entries | ForEach-Object { $_.FullName };
    $zip.Dispose();
  `;
  const listing = execFileSync("powershell.exe", ["-NoProfile", "-Command", listCmd], { encoding: "utf8" })
    .trim().split(/\r?\n/).filter(Boolean);
  console.log(`\n${zipName} contents:`);
  for (const line of listing) console.log(`  ${line.trim()}`);

  const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log(`\n✓ Built: dist/${zipName} (${size} KB)`);
}

main();
