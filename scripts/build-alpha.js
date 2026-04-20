#!/usr/bin/env node
// Build script: packages extension/ into dist/stream-genie-<version>.zip
// Usage: node scripts/build-alpha.js

const { execSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

const root     = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
const version  = manifest.version;
const distDir  = path.join(root, "dist");
const zipName  = `stream-genie-v${version}.zip`;
const zipPath  = path.join(distDir, zipName);
const extDir   = path.join(root, "extension");

if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(zipPath))  fs.unlinkSync(zipPath);

execSync(
  `powershell -Command "Compress-Archive -Path '${extDir}\\\\*' -DestinationPath '${zipPath}'"`,
  { stdio: "inherit" }
);

const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`Built: dist/${zipName} (${size} KB)`);
