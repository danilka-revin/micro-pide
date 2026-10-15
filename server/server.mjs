#!/usr/bin/env node
// Сервер MicroPIDE — перенос схемы PSBees (linux_pcb_app, scripts/server.mjs):
// раздаёт собранный фронтенд (dist/) и отвечает API:
//
//   версия и обновление (движок в server/updater.mjs):
//     GET  /version                  — {ok, short, sha}
//     GET  /update/check             — сверить версию с веткой main на GitHub
//     POST /update/run               — запустить обновление
//     GET  /update/status?since=N    — long-poll хода обновления
//     POST /update/cancel            — отменить обновление
//
//   ардуино (обёртка в server/arduino.mjs):
//     GET  /api/cli                  — статус arduino-cli
//     POST /api/cli/install         — установить arduino-cli в .data/bin
//     GET  /api/ports                — список портов/плат
//     GET  /api/cores                — установленные платформы
//     GET  /api/cores/search?q=      — поиск в индексе плат
//     POST /api/cores/install       — {id} установить платформу
//     POST /api/cores/remove        — {id} удалить
//     GET  /api/boards               — все платы установленных ядер
//     GET  /api/libs                 — установленные библиотеки
//     GET  /api/libs/search?q=       — поиск в индексе библиотек
//     POST /api/libs/install        — {name} установить
//     POST /api/libs/remove         — {name} удалить
//     GET  /api/examples             — примеры из ядер и библиотек
//     POST /api/build               — компиляция, стриминг вывода
//     POST /api/upload              — компиляция+прошивка, стриминг вывода
//
//   серийный мост (server/serialbridge.mjs):
//     POST /api/serial/open         — {port, baud} открыть порт
//     POST /api/serial/send         — {text} отправить строку
//     POST /api/serial/close        — закрыть порт
//     GET  /api/serial/stream        — SSE-поток данных порта
//
//   скетчбук (server/sketches.mjs):
//     GET  /api/sketches             — список скетчей
//     GET  /api/sketches/get?name=   — прочитать скетч
//     POST /api/sketches/save       — {name, files} сохранить
//     POST /api/sketches/delete     — {name}
//     POST /api/sketches/rename     — {from, to}
import http from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findCli, installCli, listPorts, listCores, listAllBoards, searchCores,
  installCore, uninstallCore, listLibs, searchLibs, installLib, uninstallLib,
  listExamples, streamCli, DATA_DIR, resolveDirs, getConfig, setConfig,
} from './arduino.mjs';
import { existsSync as dirExists, statSync as dirStat } from 'node:fs';
import {
  ensureSketchbook, listSketches, readSketch, writeSketch, deleteSketch,
  renameSketch, sketchPath, normalizeFiles, readSketchDir,
} from './sketches.mjs';
import { Updater } from './updater.mjs';
import { SerialBridge } from './serialbridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const ROOT = resolve(process.env.WWW_ROOT || join(APP_DIR, 'dist'));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const IS_WIN = process.platform === 'win32';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

ensureSketchbook();
const updater = new Updater(APP_DIR, ROOT);
const serial = new SerialBridge();

// ---------------------------------------------------------------- мелочи http

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Тело запроса слишком большое');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('Некорректный JSON'); }
}

/** Стриминг строк вывода в ответ: text/plain построчно (для build/upload). */
function makeStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'Transfer-Encoding': 'chunked',
  });
  let closed = false;
  res.on('close', () => { closed = true; });
  return {
    write(line) { if (!closed) res.write(line + '\n'); },
    get closed() { return closed; },
    end() { if (!closed) { closed = true; res.end(); } },
  };
}

function pickRoot() {
  if (existsSync(ROOT)) return ROOT;
  return HERE; // без сборки — хотя бы сервер отвечает
}

// ---------------------------------------------------------------- статика

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent((urlPath || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  let file = resolve(join(pickRoot(), p));
  if (!file.startsWith(pickRoot())) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: любые маршруты — на index.html
    file = join(pickRoot(), 'index.html');
    if (!existsSync(file)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('MicroPIDE: фронтенд не собран. Выполните npm run build');
      return;
    }
  }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const stat = statSync(file);
  const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- build/upload

async function handleBuild(req, res, body) {
  const out = makeStream(res);
  try {
    const name = String(body.name || '').trim();
    if (!name) throw new Error('Не указан скетч');
    const fqbn = String(body.fqbn || '').trim();
    if (!fqbn) throw new Error('Не выбрана плата (FQBN)');
    // сохраняем файлы перед сборкой (как «Сохранить» в Arduino IDE)
    const files = normalizeFiles(body.files || []);
    writeSketch(name, files);
    const dir = sketchPath(name);
    out.write(`Компиляция ${name} для ${fqbn}…`);
    const args = ['compile', '--fqbn', fqbn, '--format', 'text'];
    if (body.verbose) args.push('--verbose');
    args.push(dir);
    const r = await streamCli(args, (line) => out.write(line), req);
    if (r.code === 0) out.write('✓ Компиляция успешно завершена');
    else out.write('✗ Ошибка компиляции: ' + (r.err?.message || 'см. вывод выше'));
  } catch (e) {
    out.write('✗ ' + (e?.message || String(e)));
  }
  out.end();
}

async function handleUpload(req, res, body) {
  const out = makeStream(res);
  try {
    const name = String(body.name || '').trim();
    if (!name) throw new Error('Не указан скетч');
    const fqbn = String(body.fqbn || '').trim();
    const port = String(body.port || '').trim();
    if (!fqbn) throw new Error('Не выбрана плата (FQBN)');
    if (!port) throw new Error('Не выбран порт');
    const files = normalizeFiles(body.files || []);
    writeSketch(name, files);
    const dir = sketchPath(name);
    out.write(`Сборка и прошивка ${name} → ${port} (${fqbn})…`);
    const cargs = ['compile', '--fqbn', fqbn, '--format', 'text'];
    if (body.verbose) cargs.push('--verbose');
    cargs.push(dir);
    const c = await streamCli(cargs, (line) => out.write(line), req);
    if (c.code !== 0) {
      out.write('✗ Ошибка компиляции: ' + (c.err?.message || 'см. вывод выше'));
      out.end();
      return;
    }
    // перед прошивкой закрываем монитор порта — порт занят
    if (serial.isOpen && serial.port === port) {
      serial.close();
      out.write('(монитор порта закрыт на время прошивки)');
    }
    const uargs = ['upload', '-p', port, '--fqbn', fqbn, '--format', 'text'];
    if (body.verbose) uargs.push('--verbose');
    uargs.push(dir);
    const u = await streamCli(uargs, (line) => out.write(line), req);
    if (u.code === 0) out.write('✓ Прошивка завершена');
    else out.write('✗ Ошибка прошивки: ' + (u.err?.message || 'см. вывод выше'));
  } catch (e) {
    out.write('✗ ' + (e?.message || String(e)));
  }
  out.end();
}

// ---------------------------------------------------------------- маршруты API

async function api(req, res, url) {
  const path = url.pathname;
  const q = url.searchParams;

  // ---------- cli ----------
  if (req.method === 'GET' && path === '/api/cli') {
    return sendJson(res, 200, await findCli());
  }
  if (req.method === 'POST' && path === '/api/cli/install') {
    const out = makeStream(res);
    try {
      await installCli((line) => out.write(line));
    } catch (e) {
      out.write('✗ ' + (e?.message || String(e)));
    }
    out.end();
    return;
  }

  // ---------- платы и порты ----------
  if (req.method === 'GET' && path === '/api/ports') {
    const r = await listPorts();
    return sendJson(res, 200, { ok: !r.err, err: r.err, ports: r.ports });
  }
  if (req.method === 'GET' && path === '/api/cores') {
    const r = await listCores();
    return sendJson(res, 200, { ok: !r.err, err: r.err, cores: r.cores });
  }
  if (req.method === 'GET' && path === '/api/cores/search') {
    const r = await searchCores(q.get('q') || '');
    return sendJson(res, 200, { ok: !r.err, err: r.err, cores: r.cores });
  }
  if (req.method === 'POST' && path === '/api/cores/install') {
    const body = await readBody(req, 4096);
    const out = makeStream(res);
    try {
      await installCore(body.id, (line) => out.write(line));
      out.write('✓ Платформа установлена');
    } catch (e) { out.write('✗ ' + (e?.message || String(e))); }
    out.end();
    return;
  }
  if (req.method === 'POST' && path === '/api/cores/remove') {
    const body = await readBody(req, 4096);
    try { await uninstallCore(body.id); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e?.message || String(e) }); }
  }
  if (req.method === 'GET' && path === '/api/boards') {
    const r = await listAllBoards();
    return sendJson(res, 200, { ok: !r.err, err: r.err, boards: r.boards });
  }

  // ---------- библиотеки ----------
  if (req.method === 'GET' && path === '/api/libs') {
    const r = await listLibs();
    return sendJson(res, 200, { ok: !r.err, err: r.err, libs: r.libs });
  }
  if (req.method === 'GET' && path === '/api/libs/search') {
    const r = await searchLibs(q.get('q') || '');
    return sendJson(res, 200, { ok: !r.err, err: r.err, libs: r.libs });
  }
  if (req.method === 'POST' && path === '/api/libs/install') {
    const body = await readBody(req, 4096);
    const out = makeStream(res);
    try {
      await installLib(body.name, (line) => out.write(line));
      out.write('✓ Библиотека установлена');
    } catch (e) { out.write('✗ ' + (e?.message || String(e))); }
    out.end();
    return;
  }
  if (req.method === 'POST' && path === '/api/libs/remove') {
    const body = await readBody(req, 4096);
    try { await uninstallLib(body.name); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e?.message || String(e) }); }
  }
  if (req.method === 'GET' && path === '/api/examples') {
    const r = await listExamples();
    return sendJson(res, 200, { ok: !r.err, err: r.err, groups: r.groups });
  }

  // ---------- сборка и прошивка ----------
  if (req.method === 'POST' && path === '/api/build') {
    const body = await readBody(req);
    return handleBuild(req, res, body);
  }
  if (req.method === 'POST' && path === '/api/upload') {
    const body = await readBody(req);
    return handleUpload(req, res, body);
  }

  // ---------- монитор порта ----------
  if (req.method === 'POST' && path === '/api/serial/open') {
    const body = await readBody(req, 4096);
    const r = await serial.open(String(body.port || ''), Number(body.baud) || 9600);
    return sendJson(res, r.ok ? 200 : 500, r);
  }
  if (req.method === 'POST' && path === '/api/serial/close') {
    serial.close();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/serial/send') {
    const body = await readBody(req, 65536);
    const r = await serial.send(String(body.text ?? ''));
    return sendJson(res, r.ok ? 200 : 500, r);
  }
  if (req.method === 'GET' && path === '/api/serial/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let last = 0;
    const since = Number(q.get('since') || 0);
    let cursor = since;
    if (serial.buffer.length && !since) {
      // отдаём хвост истории (последние 100 строк), чтобы лог не был пустым
      cursor = Math.max(0, serial.seq - 100);
    }
    const timer = setInterval(() => {
      const items = serial.since(cursor);
      for (const it of items) {
        cursor = it.n;
        last = Date.now();
        res.write(`id: ${it.n}\ndata: ${JSON.stringify(it)}\n\n`);
      }
      if (Date.now() - last > 1500) res.write(': ping\n\n');
      if (!serial.isOpen && serial.buffer.length && cursor >= serial.seq) {
        res.write('event: closed\ndata: {}\n\n');
      }
    }, 120);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // ---------- конфиг и системные каталоги ----------
  if (req.method === 'GET' && path === '/api/system') {
    const d = resolveDirs();
    const sbExists = (() => { try { return dirExists(d.user) && dirStat(d.user).isDirectory(); } catch { return false; } })();
    return sendJson(res, 200, {
      ok: true,
      dataDir: DATA_DIR,
      sketchbook: d.user,
      sketchbookExists: sbExists,
      useSystem: d.useSystem,
      systemFound: d.systemFound,
      systemSketchbook: d.system.sketchbook,
      systemData: d.system.data,
      config: getConfig(),
    });
  }
  if (req.method === 'GET' && path === '/api/config') {
    return sendJson(res, 200, { ok: true, config: getConfig() });
  }
  if (req.method === 'POST' && path === '/api/config') {
    const body = await readBody(req, 16 * 1024);
    const patch = {};
    if ('sketchbook' in body) {
      if (body.sketchbook === null || body.sketchbook === '') patch.sketchbook = null;
      else {
        const p = String(body.sketchbook).trim();
        // путь должен быть абсолютным (диск/корень), чтобы не поймать относительную ерунду
        if (!p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)) {
          return sendJson(res, 400, { ok: false, error: 'Укажите абсолютный путь каталога' });
        }
        patch.sketchbook = p;
      }
    }
    if ('useSystemArduino' in body) patch.useSystemArduino = body.useSystemArduino === null ? null : !!body.useSystemArduino;
    const cfg = setConfig(patch);
    const d = resolveDirs();
    return sendJson(res, 200, { ok: true, config: cfg, dirs: { sketchbook: d.user, useSystem: d.useSystem } });
  }

  // ---------- скетчбук ----------
  if (req.method === 'GET' && path === '/api/sketches') {
    const d = resolveDirs();
    return sendJson(res, 200, {
      ok: true,
      sketchbook: d.user,
      useSystem: d.useSystem,
      systemFound: d.systemFound,
      sketches: listSketches(),
    });
  }
  if (req.method === 'GET' && path === '/api/example/get') {
    try { return sendJson(res, 200, { ok: true, ...readSketchDir(q.get('path') || '') }); }
    catch (e) { return sendJson(res, 404, { ok: false, error: e?.message || String(e) }); }
  }
  if (req.method === 'GET' && path === '/api/sketches/get') {
    try { return sendJson(res, 200, { ok: true, ...readSketch(q.get('name') || '') }); }
    catch (e) { return sendJson(res, 404, { ok: false, error: e?.message || String(e) }); }
  }
  if (req.method === 'POST' && path === '/api/sketches/save') {
    const body = await readBody(req);
    try {
      const saved = writeSketch(String(body.name || ''), normalizeFiles(body.files || []));
      return sendJson(res, 200, { ok: true, ...saved });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
  }
  if (req.method === 'POST' && path === '/api/sketches/delete') {
    const body = await readBody(req, 4096);
    try { deleteSketch(String(body.name || '')); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
  }
  if (req.method === 'POST' && path === '/api/sketches/rename') {
    const body = await readBody(req, 4096);
    try {
      const r = renameSketch(String(body.from || ''), String(body.to || ''));
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
  }

  return sendJson(res, 404, { ok: false, error: 'Нет такого API: ' + path });
}

// ---------------------------------------------------------------- сервер

export async function startServer(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? PORT);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    try {
      // версия
      if (url.pathname === '/version') {
        let sha = '', shortSha = '';
        try {
          const v = JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8'));
          sha = String(v.sha || ''); shortSha = String(v.short || '');
        } catch { /* нет сборки */ }
        if (!sha) {
          try {
            const s = readFileSync(join(APP_DIR, 'version.txt'), 'utf8').trim();
            if (s) { sha = s; shortSha = shortSha || s.slice(0, 7); }
          } catch { /* нет */ }
        }
        return sendJson(res, 200, { ok: true, sha, short: shortSha });
      }
      // обновление
      if (url.pathname === '/update/check' && req.method === 'GET') {
        try { return sendJson(res, 200, await updater.check()); }
        catch (e) { return sendJson(res, 500, { ok: false, error: e?.message || String(e) }); }
      }
      if (url.pathname === '/update/run' && req.method === 'POST') {
        return sendJson(res, 200, updater.run());
      }
      if (url.pathname === '/update/cancel' && req.method === 'POST') {
        return sendJson(res, 200, updater.cancel());
      }
      if (url.pathname === '/update/status' && req.method === 'GET') {
        const since = Number(new URL(req.url, 'http://x').searchParams.get('since') || -1);
        const snap = updater.snapshot();
        if (Number(snap.rev) !== since || updater.waiters.size > 8) return sendJson(res, 200, snap);
        // long-poll: ответим, когда состояние изменится
        await new Promise((w) => {
          updater.waiters.add(w);
          const to = setTimeout(() => { updater.waiters.delete(w); w(); }, 25_000);
          if (updater.job?.status !== 'run') { clearTimeout(to); updater.waiters.delete(w); w(); }
        });
        return sendJson(res, 200, updater.snapshot());
      }
      // api
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      // статика
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
      res.writeHead(405); res.end();
    } catch (e) {
      try { sendJson(res, 500, { ok: false, error: e?.message || String(e) }); } catch { /* ignore */ }
    }
  });

  await new Promise((r) => server.listen(port, HOST, r));
  const realPort = typeof server.address() === 'object' && server.address() ? server.address().port : port;
  return { port: realPort, host: HOST, root: ROOT, server };
}

// самостоятельный запуск: node server/server.mjs [порт]
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argPort = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  const port = Number(argPort || process.env.PORT || 8080);
  startServer({ port }).then(({ port: p }) => {
    console.log(`MicroPIDE: http://localhost:${p}  (dist: ${ROOT})`);
    findCli().then((c) => {
      console.log(c.ok ? `arduino-cli ${c.version}: ${c.path}` : `arduino-cli: ${c.error}`);
    });
    // само-перезапуск после обновления (как в PSBees)
    if (process.env.MICRO_PIDE_RESTART && !process.env.MICRO_PIDE_SKIP_RESTART) {
      updater.job = null;
      // если обновление попросило перезапуск — уже сделано в watcher ниже
    }
    // watchdog: когда обновление завершилось и просит перезапуск — перезапуститься
    setInterval(async () => {
      const s = updater.snapshot();
      if (s.status === 'done' && s.restart && !s.restarting) {
        updater.job = { ...updater.job, restart: false };
        console.log('Обновление установлено — перезапускаю сервер…');
        setTimeout(() => {
          const child = (async () => {
            const { spawn } = await import('node:child_process');
            const args = process.argv.slice(2);
            const env = { ...process.env, MICRO_PIDE_RESTART: '' };
            const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
              detached: true, stdio: 'ignore', env,
            });
            c.unref();
            process.exit(0);
          })();
        }, 700);
      }
    }, 500);
  }).catch((e) => {
    console.error('Не удалось запустить сервер:', e);
    process.exit(1);
  });
}
