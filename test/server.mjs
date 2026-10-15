#!/usr/bin/env node
// Смоук-тест сервера MicroPIDE: поднимает сервер на свободном порту и
// проверяет ключевые эндпоинты: версия, статика, скетчбук, обновление, cli.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// изолированные данные и «домашний каталог» с папками Arduino IDE
process.env.MICRO_PIDE_DATA = mkdtempSync(join(tmpdir(), 'micropide-test-'));
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'micropide-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
// «Arduino IDE»: скетчбук с проектом в подпапке, библиотека, платформа AVR
const sb = join(FAKE_HOME, 'Arduino');
const mk = (p, content = '') => {
  const full = join(sb, p);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};
mk('MyProject/MyProject.ino', 'void setup(){}\nvoid loop(){}');
mk('School/Nested/Blink/Blink.ino', 'void setup(){}');
mk('libraries/CoolLib/library.properties', 'name=CoolLib\nversion=1.2.3\nsentence=Test lib\nauthor=Tester');
const bd = join(FAKE_HOME, '.arduino15', 'packages', 'arduino', 'hardware', 'avr', '1.8.6');
mkdirSync(bd, { recursive: true });
writeFileSync(join(bd, 'boards.txt'), 'uno.name=Arduino Uno\nnano.name=Arduino Nano\n');
writeFileSync(join(bd, 'platform.txt'), 'name=Arduino AVR Boards');

const { startServer } = await import('../server/server.mjs');
const { port } = await startServer({ port: 0 });
const base = `http://127.0.0.1:${port}`;

const j = async (p, opts) => {
  const r = await fetch(base + p, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
};

let failed = 0;
const check = (name, fn) => fn().then(() => console.log('✓', name)).catch((e) => { failed++; console.error('✗', name, '\n ', e.message); });

await check('GET /version → ok', async () => {
  const { status, body } = await j('/version');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

await check('GET / → index.html (или заглушка без сборки)', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
});

await check('скетчбук: save → list → get → delete', async () => {
  const save = await j('/api/sketches/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'TestSketch', files: [{ path: 'TestSketch.ino', content: 'void setup(){}' }] }),
  });
  assert.equal(save.body.ok, true, 'save: ' + JSON.stringify(save.body));
  const list = await j('/api/sketches');
  assert.ok(list.body.sketches.some((s) => s.name === 'TestSketch'));
  const get = await j('/api/sketches/get?name=TestSketch');
  assert.equal(get.body.files[0].path, 'TestSketch.ino');
  const del = await j('/api/sketches/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'TestSketch' }),
  });
  assert.equal(del.body.ok, true);
});

await check('скетчбук: защита имени (.. и пусто)', async () => {
  const bad = await j('/api/sketches/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '../etc', files: [{ path: 'x.ino', content: '' }] }),
  });
  assert.equal(bad.body.ok, false);
  assert.ok(String(bad.body.error).includes('имя'));
});

await check('GET /api/cli → ответ с полем ok', async () => {
  const { status, body } = await j('/api/cli');
  assert.equal(status, 200);
  assert.equal(typeof body.ok, 'boolean');
  assert.ok(body.sketchbook);
});

await check('GET /api/ports → {ok, ports[]}', async () => {
  const { body } = await j('/api/ports');
  assert.equal(body.ok, false); // без cli список пуст, но форма правильная
  assert.ok(Array.isArray(body.ports));
});

await check('GET /update/check → форма ответа PSBees', async () => {
  const { body } = await j('/update/check');
  assert.equal(body.ok, true, 'check: ' + JSON.stringify(body));
  assert.ok(Array.isArray([]) && 'branch' in body && 'local' in body && 'latest' in body);
  assert.equal(typeof body.updateAvailable, 'boolean');
  assert.ok(body.tooling && typeof body.tooling.npm === 'boolean');
});

await check('POST /update/run → {ok} и статус не 404', async () => {
  const { body } = await j('/update/run', { method: 'POST' });
  assert.equal(body.ok, true);
  // подождём завершения: у нас последняя версия либо ошибка сети
  for (let i = 0; i < 30; i++) {
    const s = await j('/update/status');
    if (s.body.status !== 'run') {
      assert.ok(['done', 'error', 'cancelled'].includes(s.body.status));
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await j('/update/cancel', { method: 'POST' });
});

await check('монитор порта: открытие без устройств даёт ошибку, не падение', async () => {
  const { body } = await j('/api/serial/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: '/dev/definitely-not-here', baud: 9600 }),
  });
  assert.equal(body.ok, false);
  assert.ok(body.error);
});

await check('каталоги Arduino IDE: скетчбук подхвачен, проекты найдены рекурсивно', async () => {
  const { body } = await j('/api/system');
  assert.equal(body.ok, true);
  assert.equal(body.sketchbook, join(FAKE_HOME, 'Arduino'), 'sketchbook: ' + body.sketchbook);
  assert.equal(body.useSystem, true);
  const list = await j('/api/sketches');
  const names = list.body.sketches.map((s) => s.name);
  assert.ok(names.includes('MyProject'), 'names: ' + names.join(','));
  assert.ok(names.includes('School/Nested/Blink'), 'вложенный проект: ' + names.join(','));
  const get = await j('/api/sketches/get?name=' + encodeURIComponent('School/Nested/Blink'));
  assert.ok(get.body.files.some((f) => f.path === 'Blink.ino'));
});

await check('библиотеки Arduino IDE видны без cli', async () => {
  const { body } = await j('/api/libs');
  assert.equal(body.ok, true, JSON.stringify(body).slice(0, 200));
  const lib = body.libs.find((l) => l.name === 'CoolLib');
  assert.ok(lib, 'libs: ' + body.libs.map((l) => l.name).join(','));
  assert.equal(lib.source, 'ide');
  assert.equal(lib.version, '1.2.3');
});

await check('платы из Arduino15 видны без cli (scan)', async () => {
  const { body } = await j('/api/cores');
  assert.equal(body.ok, true);
  const avr = body.cores.find((c) => c.id === 'arduino:avr');
  assert.ok(avr, 'cores: ' + body.cores.map((c) => c.id).join(','));
  assert.equal(avr.source, 'system');
  assert.ok(avr.boards.some((b) => b.name === 'Arduino Uno' && b.fqbn === 'arduino:avr:uno'));
  const boards = await j('/api/boards');
  assert.ok(boards.body.boards.some((b) => b.fqbn === 'arduino:avr:nano'));
});

await check('config: смена скетчбука и сброс', async () => {
  const alt = join(FAKE_HOME, 'AltBook');
  mkdirSync(alt, { recursive: true });
  const set = await j('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sketchbook: alt }),
  });
  assert.equal(set.body.ok, true);
  assert.equal(set.body.dirs.sketchbook, alt);
  const reset = await j('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sketchbook: null }),
  });
  assert.equal(reset.body.ok, true);
  assert.equal(reset.body.dirs.sketchbook, join(FAKE_HOME, 'Arduino'));
  const bad = await j('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sketchbook: 'relative/path' }),
  });
  assert.equal(bad.body.ok, false);
});

rmSync(process.env.MICRO_PIDE_DATA, { recursive: true, force: true });
rmSync(FAKE_HOME, { recursive: true, force: true });
console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе проверки прошли.');
process.exit(failed ? 1 : 0);
