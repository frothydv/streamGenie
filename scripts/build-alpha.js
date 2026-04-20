#!/usr/bin/env node
// Build script: packages extension/ into dist/stream-genie-pre-alpha.zip
// Usage: node scripts/build-alpha.js

const { execSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

const root    = path.join(__dirname, "..");
const distDir = path.join(root, "dist");
const zipPath = path.join(distDir, "stream-genie-pre-alpha.zip");
const extDir  = path.join(root, "extension");

if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(zipPath))  fs.unlinkSync(zipPath);

// Compress-Archive on Windows (PowerShell built-in)
execSync(
  `powershell -Command "Compress-Archive -Path '${extDir}\\\\*' -DestinationPath '${zipPath}'"`,
  { stdio: "inherit" }
);

const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`Built: dist/stream-genie-pre-alpha.zip (${size} KB)`);
