#!/usr/bin/env node
// Записать dist/version.json — SHA коммита, из которого собран фронтенд.
// По нему страница после обновления понимает, что сервер уже с новой версией.
import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

execFile('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 10_000 }, (err, stdout) => {
  const sha = err ? '' : String(stdout).trim();
  writeFileSync(join(dist, 'version.json'), JSON.stringify({ sha, short: sha.slice(0, 7), built: new Date().toISOString() }, null, 2));
  console.log('version:', sha ? sha.slice(0, 7) : '(нет git)');
});
