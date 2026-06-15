#!/usr/bin/env node
// One-command version bump that keeps *every* place in sync:
//   package.json · src-tauri/tauri.conf.json · src-tauri/Cargo.toml · src-tauri/Cargo.lock
//
// Usage:
//   pnpm bump <patch|minor|major|X.Y.Z>
//
// Deliberately does NOT touch git — commit + tag stay with the
// branch → PR → merge → `git tag vX.Y.Z` release flow. Pure Node, no deps.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];

if (!arg || arg === '-h' || arg === '--help') {
  console.error('usage: pnpm bump <patch|minor|major|X.Y.Z>');
  process.exit(arg ? 0 : 1);
}

const cur = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur);
if (!m) {
  console.error(`current package.json version "${cur}" is not X.Y.Z`);
  process.exit(1);
}
const [maj, min, pat] = m.slice(1).map(Number);

const next =
  arg === 'patch' ? `${maj}.${min}.${pat + 1}` :
  arg === 'minor' ? `${maj}.${min + 1}.0` :
  arg === 'major' ? `${maj + 1}.0.0` :
  /^\d+\.\d+\.\d+$/.test(arg) ? arg :
  null;

if (!next) {
  console.error(`bad bump arg "${arg}" — want patch | minor | major | X.Y.Z`);
  process.exit(1);
}

// Each target: [relative path, regex with two capture groups around the X.Y.Z].
// The JSON regexes hit the first "version" key (top-level in both files); the
// Cargo regexes anchor on the speech-studio package block so only the app's own
// version moves, never a dependency's.
const targets = [
  ['package.json',              /("version"\s*:\s*")\d+\.\d+\.\d+(")/],
  ['src-tauri/tauri.conf.json', /("version"\s*:\s*")\d+\.\d+\.\d+(")/],
  ['src-tauri/Cargo.toml',      /(name\s*=\s*"speech-studio"\r?\nversion\s*=\s*")\d+\.\d+\.\d+(")/],
  ['src-tauri/Cargo.lock',      /(name\s*=\s*"speech-studio"\r?\nversion\s*=\s*")\d+\.\d+\.\d+(")/],
];

for (const [rel, re] of targets) {
  const p = join(root, rel);
  const txt = readFileSync(p, 'utf8');
  if (!re.test(txt)) {
    console.error(`✗ version field not found in ${rel} — aborting (nothing written)`);
    process.exit(1);
  }
  writeFileSync(p, txt.replace(re, (_, pre, post) => pre + next + post));
  console.log(`  ✓ ${rel}`);
}

console.log(`bumped ${cur} → ${next} in 4 files — now commit and \`git tag v${next}\``);
