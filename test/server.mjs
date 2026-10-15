#!/usr/bin/env node
// Смоук-тест сервера MicroPIDE: поднимает сервер на свободном порту и
// проверяет ключевые эндпоинты: версия, статика, скетчбук, обновление, cli.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// изолированные данные, чтобы не трогать .data разработчика
process.env.MICRO_PIDE_DATA = mkdtempSync(join(tmpdir(), 'micropide-test-'));

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

rmSync(process.env.MICRO_PIDE_DATA, { recursive: true, force: true });
console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе проверки прошли.');
process.exit(failed ? 1 : 0);
