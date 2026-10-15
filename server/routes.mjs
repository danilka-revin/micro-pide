// Дополнительные маршруты MicroPIDE: автономность, анализ, история, симулятор,
// аппаратные тесты и справочник. Держим их в отдельном файле, чтобы основной
// server.mjs оставался читаемым, а API — собранным в одном месте.
//
// Все обработчики принимают (req, res, url, ctx) и возвращают true, если
// запрос обслужен. ctx даёт доступ к общим функциям сервера: sendJson,
// readBody, makeStream, serial (мост порта), buildInfo (реестр сборок).
import { existsSync, readFileSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import {
  allBoards, catalogForUi, searchBoards, findBoard, guessBoard, saveUserBoards, libraryIndex, packageIndex, DATA_DIR,
} from './boarddb.mjs';
import {
  autonomyReport, toolsStatus, platformsStatus, scanVault, inspectItem, importItem, mirrors,
  setMirrors, writeIndexes, indexPaths, prepare, downloadToVault, vaultDirs, fmtSize,
  platformUrls, libraryUrls, VAULT_DIR,
} from './offline.mjs';
import {
  analyze, pinMap, generateDocs, generatePinsHeader, telemetryHeader, telemetryExample,
  instrumentSketch, sketchProfile, applyFix as applyAnalysisFix, installedLibraries,
} from './analysis.mjs';
import { buildWithOwnEngine, uploadWithOwnEngine, symbolMap, findToolchain, loadCoreProps, resolveCore } from './buildcore.mjs';
import { simulate, simulatorStatus, SIM_FQBN } from './native.mjs';
import { snapshot, listSnapshots, getSnapshot, deleteSnapshot, diffSnapshots, restore, recordBuild, buildLog, buildStats, historyOverview, historySize, prune } from './history.mjs';
import { listTests, getTest, saveTest, deleteTest, draftScenario, runTest, saveReport, listReports, readReport } from './hiltest.mjs';
import { searchReference, snippetFor } from './reference.mjs';
import { parseSizes } from './buildcore.mjs';
import { portPlan, portChecklist } from './port.mjs';
import { powerProfile } from './power.mjs';
import { templatesForUi, sketchTemplate, librarySkeleton, moduleSkeleton } from './scaffold.mjs';
import { sketchbookDir } from './sketches.mjs';
import { resolve as resolvePath, sep as pathSep, dirname } from 'node:path';

// ---------------------------------------------------------------- помощники

const asFiles = (arr) => (Array.isArray(arr) ? arr.map((f) => ({ path: String(f?.path || ''), content: String(f?.content ?? '') })) : []);

/** Сборки в памяти + на диске: где лежит .elf/.hex и карта символов. */
export function buildRegistry() {
  const file = () => join(DATA_DIR, 'build', 'registry.json');
  return {
    save(info) {
      try {
        mkdirSync(join(file(), '..'), { recursive: true });
        const list = this.list();
        list.push({ ...info, at: Date.now() });
        writeFileSync(file(), JSON.stringify(list.slice(-100), null, 2));
      } catch { /* ignore */ }
    },
    list() { try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return []; } },
    last(name) {
      const list = this.list().filter((b) => !name || b.name === name);
      return list[list.length - 1] || null;
    },
  };
}

/** Применить автоправку линтера к файлам (возвращает новые файлы). */
export function applyFix(files, fix, filePath) {
  const out = asFiles(files);
  const target = out.find((f) => f.path === filePath) || out.find((f) => /\.ino$/i.test(f.path)) || out[0];
  if (!target) return { ok: false, error: 'Нет файла для правки' };
  const lines = target.content.split('\n');
  if (fix.kind === 'insertTop') {
    const head = fix.text.endsWith('\n') ? fix.text : fix.text + '\n';
    if (target.content.startsWith('#include')) target.content = head + target.content;
    else target.content = head + target.content;
    return { ok: true, files: out, note: 'Вставлено в начало файла' };
  }
  if (fix.kind === 'insertFunc') {
    target.content = (target.content.replace(/\s*$/, '\n\n') + fix.func).replace(/\n{3,}/g, '\n\n');
    return { ok: true, files: out, note: 'Добавлена функция' };
  }
  if (fix.kind === 'insertInSetup') {
    const m = /\bvoid\s+setup\s*\(\s*\)\s*\{/.exec(target.content);
    if (!m) return { ok: false, error: 'Не найден setup()' };
    const at = m.index + m[0].length;
    const insert = fix.text.endsWith('\n') ? fix.text : fix.text + '\n';
    target.content = target.content.slice(0, at) + '\n' + insert + target.content.slice(at);
    return { ok: true, files: out, note: 'Вставлено в setup()' };
  }
  if (fix.kind === 'replace') {
    const from = fix.line ? lines[fix.line - 1] : null;
    if (from && from.includes(fix.from)) {
      lines[fix.line - 1] = from.replace(fix.from, fix.to);
      target.content = lines.join('\n');
      return { ok: true, files: out, note: 'Заменено в строке ' + fix.line };
    }
    const idx = target.content.indexOf(fix.from);
    if (idx < 0) return { ok: false, error: 'Фрагмент не найден' };
    target.content = target.content.slice(0, idx) + fix.to + target.content.slice(idx + fix.from.length);
    return { ok: true, files: out, note: 'Заменено' };
  }
  return { ok: false, error: 'Неизвестный вид правки: ' + fix.kind };
}

/** Слить платы arduino-cli с нашим встроенным каталогом (каталог — всегда есть). */
export function mergeBoards(cliBoards = []) {
  const merged = new Map();
  for (const b of cliBoards) merged.set(b.fqbn, { ...b, source: 'cli', available: true });
  for (const b of allBoards()) {
    if (merged.has(b.fqbn)) continue;
    const core = resolveCore(b.fqbn);
    merged.set(b.fqbn, {
      name: b.name, fqbn: b.fqbn, source: b.source === 'user' ? 'user' : 'builtin',
      available: !!core.ok, core: core.ok ? core.version : null, arch: b.arch, mcu: b.mcu,
      flash: b.flash, ram: b.ram, voltage: b.voltage, simulator: b.simulator !== false,
    });
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------- маршруты

/**
 * Обработать «свои» маршруты. ctx: {sendJson, readBody, makeStream, serial, updater, registry}
 */
export async function extraRoutes(req, res, url, ctx) {
  const { sendJson, readBody, makeStream, serial, registry } = ctx;
  const path = url.pathname;
  const q = url.searchParams;
  const isGet = req.method === 'GET';
  const isPost = req.method === 'POST';

  // =============================================================== каталог плат
  if (isGet && path === '/api/boards/catalog') {
    return sendJson(res, 200, { ok: true, boards: catalogForUi(), query: q.get('q') || '' }), true;
  }
  if (isGet && path === '/api/boards/search') {
    const found = searchBoards(q.get('q') || '');
    return sendJson(res, 200, { ok: true, boards: found.map((b) => ({ fqbn: b.fqbn, name: b.name, mcu: b.mcu, source: b.source || 'builtin' })) }), true;
  }
  if (isGet && path === '/api/boards/info') {
    const fqbn = q.get('fqbn') || '';
    const board = findBoard(fqbn);
    if (!board) return sendJson(res, 404, { ok: false, error: 'Плата не найдена в базе: ' + fqbn }), true;
    const core = resolveCore(fqbn);
    const pm = pinMap({ files: [], fqbn });
    return sendJson(res, 200, {
      ok: true, board, pins: { pwm: board.pwm || [], analog: board.analog || [], interrupt: board.interrupt || [], dac: board.dac || [], inputOnly: board.inputOnly || [] },
      core: core.ok ? { dir: core.dir, version: core.version, source: core.source } : null,
      simulator: board.simulator !== false, caps: pm.board,
    }), true;
  }
  if (isPost && path === '/api/boards/define') {
    const body = await readBody(req, 64 * 1024);
    if (!body?.fqbn || !body?.name) return sendJson(res, 400, { ok: false, error: 'Нужны поля fqbn и name' }), true;
    const saved = saveUserBoards([{
      fqbn: String(body.fqbn), name: String(body.name), mcu: body.mcu ? String(body.mcu) : 'unknown',
      clock: Number(body.clock) || 16_000_000,
      flash: Number(body.flash) || 32_768, ram: Number(body.ram) || 2048, eeprom: Number(body.eeprom) || 0,
      arch: String(body.arch || String(body.fqbn).split(':')[1] || 'custom'),
      vendor: String(body.vendor || String(body.fqbn).split(':')[0] || 'custom'),
      voltage: Number(body.voltage) || 5, adcBits: Number(body.adcBits) || 10, pwmBits: Number(body.pwmBits) || 8,
      led: body.led !== undefined ? Number(body.led) : 13,
      digital: body.digital || [], analog: body.analog || [], pwm: body.pwm || [], interrupt: body.interrupt || [],
      hints: body.hints || ['плата описана пользователем MicroPIDE'],
      simulator: body.simulator !== false,
      upload: body.upload || { kind: 'avrdude', programmer: 'arduino', part: body.mcu || 'atmega328p', baud: 115200 },
    }]);
    return sendJson(res, 200, { ok: true, boards: saved.length, note: 'Плата сохранена в базу: её видит и анализ, и сборщик' }), true;
  }
  if (isGet && path === '/api/boards/detect') {
    const g = guessBoard({ vid: q.get('vid'), pid: q.get('pid'), name: q.get('name') || '' });
    return sendJson(res, 200, { ok: !!g, ...(g || {}), note: g?.confident ? 'совпадение по USB VID:PID' : 'догадка по имени' }), true;
  }

  // =============================================================== автономность
  if (isGet && path === '/api/offline/status') {
    return sendJson(res, 200, await autonomyReport()), true;
  }
  if (isGet && path === '/api/offline/tools') {
    return sendJson(res, 200, { ok: true, ...(await toolsStatus()) }), true;
  }
  if (isGet && path === '/api/offline/platforms') {
    return sendJson(res, 200, { ok: true, platforms: platformsStatus() }), true;
  }
  if (isGet && path === '/api/offline/vault') {
    const v = scanVault();
    return sendJson(res, 200, { ok: true, ...v, hint: 'Положите архивы ядер (*.tar.bz2/*.zip), библиотек и тулчейнов в ' + v.dirs.archives }), true;
  }
  if (isPost && path === '/api/offline/inspect') {
    const body = await readBody(req, 8 * 1024);
    try { return sendJson(res, 200, { ok: true, info: inspectItem(String(body.file || '')) }), true; }
    catch (e) { return sendJson(res, 400, { ok: false, error: e?.message || String(e) }), true; }
  }
  if (isPost && path === '/api/offline/import') {
    const body = await readBody(req, 8 * 1024);
    const out = makeStream(res);
    try {
      out.write('Разбираю ' + body.file + '…');
      const r = importItem(String(body.file || ''), { type: body.type, id: body.id, name: body.name, version: body.version });
      for (const l of r.log || []) out.write(l);
      if (!r.ok) out.write('✗ ' + r.error);
      else out.write('✓ Готово: ' + (r.dest || ''));
      const idx = writeIndexes();
      out.write(`Свои индексы обновлены: ${idx.platforms} платформ, ${idx.libraries} библиотек`);
      const info = r.ok ? inspectItem(String(body.file)) : null;
      out.write('#result ' + JSON.stringify({ ok: r.ok, type: r.type, dest: r.dest, error: r.error || null, info }));
    } catch (e) {
      out.write('✗ ' + (e?.message || String(e)));
      out.write('#result ' + JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    out.end();
    return true;
  }
  if (isPost && path === '/api/offline/download') {
    const body = await readBody(req, 8 * 1024);
    const out = makeStream(res);
    const kind = String(body.kind || 'platform');
    const id = String(body.id || '');
    try {
      if (kind === 'platform') {
        const r = await prepare({ platforms: [id], import: !!body.import, onLine: (l) => out.write(l) });
        const first = r.results[0] || {};
        out.write('#result ' + JSON.stringify({ ok: !!first.ok, file: first.file, sha256: first.sha256, size: first.size, error: first.error || null, imported: !!first.imported, indexes: r.indexes }));
      } else if (kind === 'library') {
        const r = await prepare({ libraries: [id], import: !!body.import, onLine: (l) => out.write(l) });
        const first = r.results[0] || {};
        out.write('#result ' + JSON.stringify({ ok: !!first.ok, file: first.file, error: first.error || null, imported: !!first.imported }));
      } else {
        const urls = Array.isArray(body.urls) ? body.urls : [];
        const dl = await downloadToVault({ name: body.name || 'download.bin', urls, sha256: body.sha256 || '', onProgress: (pct, got, total) => out.write(pct == null ? `… ${fmtSize(got)}` : `${pct}% (${fmtSize(got)}${total ? ' из ' + fmtSize(total) : ''})`) });
        out.write(dl.ok ? '✓ Скачано: ' + dl.file : '✗ ' + dl.error);
        out.write('#result ' + JSON.stringify(dl));
      }
    } catch (e) {
      out.write('✗ ' + (e?.message || String(e)));
      out.write('#result ' + JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    out.end();
    return true;
  }
  // Загрузка архива прямо из браузера на склад: тело запроса — сам файл.
  if (isPost && path === '/api/offline/upload') {
    const o = vaultDirs();
    const fileName = String(q.get('name') || 'upload.bin').replace(/[^\w.+-]/g, '_');
    const type = String(q.get('type') || '');
    const autoImport = q.get('import') === '1';
    const dest = join(o.archives, fileName);
    const out = makeStream(res);
    try {
      mkdirSync(o.archives, { recursive: true });
      const size = await new Promise((resolve, reject) => {
        const ws = createWriteStream(dest);
        let n = 0;
        let over = false;
        req.on('data', (chunk) => {
          n += chunk.length;
          if (n > 1_500_000_000) { over = true; req.destroy(); return; } // 1.5 ГБ — предохранитель
        });
        req.pipe(ws);
        ws.on('finish', () => resolve(n));
        ws.on('error', reject);
        req.on('close', () => { if (over) reject(new Error('Файл слишком большой (лимит 1.5 ГБ)')); });
      });
      out.write(`Файл принят: ${fileName} — ${fmtSize(size)}`);
      const insp = (() => { try { return inspectItem(dest); } catch (e) { return { error: String(e?.message || e) }; } })();
      if (insp?.error) out.write('⚠ ' + insp.error);
      else out.write(`Похоже на ${insp.type || 'архив'}${insp.name ? ' — ' + insp.name : ''}${insp.version ? ' ' + insp.version : ''}`);
      let imported = null;
      if (autoImport) {
        const r = importItem(dest, { type: type || undefined });
        for (const l of r.log || []) out.write(l);
        imported = r.ok ? { type: r.type, dest: r.dest, id: r.id, version: r.version } : null;
        if (!r.ok) out.write('✗ ' + r.error);
        else { const idx = writeIndexes(); out.write(`Свои индексы обновлены: ${idx.platforms} платформ, ${idx.libraries} библиотек`); }
      }
      out.write('#result ' + JSON.stringify({ ok: !insp?.error, file: dest, size, info: insp?.error ? null : insp, imported }));
    } catch (e) {
      out.write('✗ ' + (e?.message || String(e)));
      out.write('#result ' + JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    out.end();
    return true;
  }
  if (isGet && path === '/api/offline/mirrors') {
    return sendJson(res, 200, { ok: true, mirrors: mirrors() }), true;
  }
  if (isPost && path === '/api/offline/mirrors') {
    const body = await readBody(req, 256 * 1024);
    const m = setMirrors(body || {});
    return sendJson(res, 200, { ok: true, mirrors: m }), true;
  }
  if (path === '/api/offline/indexes' && isPost) {
    const idx = writeIndexes();
    return sendJson(res, 200, { ok: true, ...idx, packageIndex: '/api/offline/index/package_index.json', libraryIndex: '/api/offline/index/library_index.json' }), true;
  }
  if (isGet && (path === '/api/offline/index/package_index.json' || path === '/api/offline/index/library_index.json')) {
    const idx = indexPaths();
    const file = path.endsWith('package_index.json') ? idx.package : idx.library;
    if (!existsSync(file)) writeIndexes();
    const body = readFileSync(file, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return true;
  }
  if (isGet && path === '/api/offline/urls') {
    const body = { platform: q.get('id') ? platformUrls(q.get('id')) : [], library: q.get('lib') ? libraryUrls(q.get('lib')) : [] };
    return sendJson(res, 200, { ok: true, ...body }), true;
  }

  // =============================================================== анализ
  if (isPost && path === '/api/analyze') {
    const body = await readBody(req, 32 * 1024 * 1024);
    const files = asFiles(body.files);
    const libs = body.installedLibs || installedLibraries();
    const lint = analyze({ files, fqbn: body.fqbn, name: body.name || '', baud: Number(body.baud) || 0, installedLibs: libs });
    const pins = pinMap({ files, fqbn: body.fqbn });
    const profile = sketchProfile({ files, fqbn: body.fqbn });
    return sendJson(res, 200, {
      ...lint, issues: lint.findings, // «issues» — старое имя, оставляем для совместимости
      pinMap: pins, pins, profile,
    }), true;
  }
  if (isPost && path === '/api/analyze/docs') {
    const body = await readBody(req, 32 * 1024 * 1024);
    const files = asFiles(body.files);
    const lint = analyze({ files, fqbn: body.fqbn, name: body.name || 'Sketch' });
    const docs = generateDocs({ files, fqbn: body.fqbn, name: body.name || 'Sketch', analysis: lint, pinmap: pinMap({ files, fqbn: body.fqbn }) });
    return sendJson(res, 200, {
      ok: true, markdown: docs.markdown, bom: docs.bom, mermaid: docs.mermaid,
      files: [{ path: 'README.md', content: docs.markdown }], score: lint.score, summary: lint.summary,
    }), true;
  }
  if (isPost && path === '/api/analyze/pins') {
    const body = await readBody(req, 32 * 1024 * 1024);
    return sendJson(res, 200, generatePinsHeader({ files: asFiles(body.files), fqbn: body.fqbn, name: body.name || 'Sketch' })), true;
  }
  if (isPost && (path === '/api/analyze/telemetry' || path === '/api/analyze/telemetry/example')) {
    const body = await readBody(req, 32 * 1024 * 1024);
    if (path.endsWith('/example')) return sendJson(res, 200, { ok: true, content: telemetryExample({ channels: body.channels || ['value'] }), filename: 'TelemDemo.ino' }), true;
    return sendJson(res, 200, telemetryHeader({ channels: body.channels || ['value'], baud: Number(body.baud) || 115200, periodMs: Number(body.periodMs) || 50, name: body.name || 'MicroTelem' })), true;
  }
  if (isPost && path === '/api/analyze/instrument') {
    const body = await readBody(req, 32 * 1024 * 1024);
    return sendJson(res, 200, instrumentSketch({ files: asFiles(body.files), periodMs: Number(body.periodMs) || 1000 })), true;
  }
  if (isPost && path === '/api/analyze/apply-fix') {
    const body = await readBody(req, 32 * 1024 * 1024);
    const fix = body.fix || {};
    // сперва пробуем прямое применение правки анализатора (replace-line/insert),
    // затем — старые виды правок (insertTop/insertFunc/insertInSetup/replace)
    const direct = applyAnalysisFix(asFiles(body.files), fix, body.file);
    if (direct.ok) return sendJson(res, 200, { ...direct, issues: undefined }), true;
    return sendJson(res, 200, applyFix(asFiles(body.files), fix, body.file)), true;
  }

  // =============================================================== история
  if (isGet && path === '/api/history') {
    return sendJson(res, 200, { ok: true, ...historyOverview(), size: historySize() }), true;
  }
  if (isGet && path === '/api/history/snapshots') {
    return sendJson(res, 200, listSnapshots(q.get('name') || '', Number(q.get('limit')) || 50)), true;
  }
  if (isGet && path === '/api/history/snapshot') {
    return sendJson(res, 200, getSnapshot(q.get('name') || '', q.get('id') || '')), true;
  }
  if (isPost && path === '/api/history/snapshot') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const r = snapshot(body.name || 'Sketch', asFiles(body.files), { reason: body.reason || 'manual', note: body.note || '', fqbn: body.fqbn || '' });
    return sendJson(res, 200, r), true;
  }
  if (isPost && path === '/api/history/diff') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const r = diffSnapshots(body.name || 'Sketch', body.a || '', body.b || 'current', body.files ? asFiles(body.files) : null);
    return sendJson(res, 200, r), true;
  }
  if (isPost && path === '/api/history/restore') {
    const body = await readBody(req, 8 * 1024);
    return sendJson(res, 200, restore(body.name || '', body.id || '')), true;
  }
  if (isPost && path === '/api/history/delete') {
    const body = await readBody(req, 8 * 1024);
    return sendJson(res, 200, deleteSnapshot(body.name || '', body.id || '')), true;
  }
  if (isPost && path === '/api/history/prune') {
    const body = await readBody(req, 8 * 1024);
    return sendJson(res, 200, prune(body.name || '', Number(body.keep) || 40)), true;
  }
  if (isGet && path === '/api/history/builds') {
    return sendJson(res, 200, buildLog(q.get('name') || '', Number(q.get('limit')) || 100)), true;
  }
  if (isGet && path === '/api/history/stats') {
    return sendJson(res, 200, buildStats(q.get('name') || '')), true;
  }

  // =============================================================== симулятор
  if (isGet && path === '/api/sim/status') {
    return sendJson(res, 200, { ok: true, ...(await simulatorStatus()), fqbn: SIM_FQBN }), true;
  }
  if (isPost && path === '/api/sim/run') {
    const body = await readBody(req, 32 * 1024 * 1024);
    const out = makeStream(res);
    try {
      const r = await simulate({
        name: body.name || 'Sim', files: asFiles(body.files), scenario: String(body.scenario || ''),
        onLine: (l) => out.write(l), runChecks: body.runChecks !== false,
        timeoutMs: Number(body.timeoutMs) || 60_000,
      });
      for (const e of (r.timeline || []).slice(-500)) out.write(`[${e.t} мс] ${String(e.text || '').replace(/\n/g, '⏎')}`);
      for (const p of (r.pins || []).slice(-200)) out.write(`[${p.t} мс] пин ${p.pin} → ${p.pwm !== undefined ? 'ШИМ ' + p.pwm : p.value}`);
      if (r.checks) out.write(r.checks.ok ? '✓ Проверки пройдены' : `✗ Провалено проверок: ${r.checks.failed}`);
      out.write('#result ' + JSON.stringify({
        ok: r.ok, error: r.error || null, phase: r.phase || null, exitCode: r.exitCode,
        stdout: r.stdout, summary: r.summary, checks: r.checks || null, ms: r.ms,
        text: r.text, pins: r.pins, timeline: r.timeline, sizes: r.sizes || null,
      }));
    } catch (e) {
      out.write('✗ ' + (e?.message || String(e)));
      out.write('#result ' + JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    out.end();
    return true;
  }

  // =============================================================== тесты HIL
  if (isGet && path === '/api/tests') {
    return sendJson(res, 200, listTests()), true;
  }
  if (isGet && path === '/api/tests/get') {
    return sendJson(res, 200, getTest(q.get('name') || '')), true;
  }
  if (isPost && path === '/api/tests/save') {
    const body = await readBody(req, 8 * 1024 * 1024);
    return sendJson(res, 200, saveTest(body.name || 'test', body.scenario || '', { sketch: body.sketch || body.name, baud: body.baud, note: body.note || '' })), true;
  }
  if (isPost && path === '/api/tests/delete') {
    const body = await readBody(req, 8 * 1024);
    return sendJson(res, 200, deleteTest(body.name || '')), true;
  }
  if (isPost && path === '/api/tests/draft') {
    const body = await readBody(req, 32 * 1024 * 1024);
    return sendJson(res, 200, draftScenario({ files: asFiles(body.files), baud: Number(body.baud) || 9600, duration: Number(body.duration) || 5000, fast: body.fast !== false })), true;
  }
  if (isPost && path === '/api/tests/run') {
    const body = await readBody(req, 32 * 1024 * 1024);
    const out = makeStream(res);
    try {
      const report = await runTest({
        name: body.name || 'test', scenario: body.scenario, files: asFiles(body.files),
        target: body.target === 'board' ? 'board' : 'sim', port: body.port || '',
        serial, onLine: (l) => out.write(l), timeoutMs: Number(body.timeoutMs) || 120_000,
      });
      if (body.saveReport) {
        try { const s = saveReport(report, body.saveReport === true ? 'all' : String(body.saveReport)); out.write('Отчёты: ' + s.files.map((f) => f.split(/[\\/]/).pop()).join(', ')); } catch { /* ignore */ }
      }
      out.write('#result ' + JSON.stringify(report));
    } catch (e) {
      out.write('✗ ' + (e?.message || String(e)));
      out.write('#result ' + JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    out.end();
    return true;
  }
  if (isGet && path === '/api/tests/reports') {
    return sendJson(res, 200, listReports()), true;
  }
  if (isGet && path === '/api/tests/report') {
    return sendJson(res, 200, readReport(q.get('file') || '')), true;
  }

  // =============================================================== справочник
  if (isGet && path === '/api/reference') {
    return sendJson(res, 200, searchReference(q.get('q') || '', { kind: q.get('kind') || undefined, group: q.get('group') || undefined, limit: Number(q.get('limit')) || 60 })), true;
  }
  if (isGet && path === '/api/reference/snippet') {
    return sendJson(res, 200, snippetFor(q.get('name') || '')), true;
  }

  // =============================================================== своя сборка
  if (isPost && path === '/api/build/own') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const out = makeStream(res);
    const t0 = Date.now();
    try {
      const r = await buildWithOwnEngine({
        name: body.name || 'Sketch', fqbn: body.fqbn || '', files: asFiles(body.files),
        onLine: (l) => out.write(l), verbose: !!body.verbose, signal: ctx.signal,
      });
      if (registry) registry.save({ name: body.name, fqbn: body.fqbn, ok: r.ok, elf: r.elf, hex: r.hex, bin: r.bin, sizes: r.sizes, ms: Date.now() - t0, engine: 'own' });
      try { recordBuild({ name: body.name || 'Sketch', fqbn: body.fqbn, ok: r.ok, flash: r.sizes?.flash, ram: r.sizes?.ram, ms: Date.now() - t0, kind: 'build', via: 'своя сборка', error: r.error || '', hex: r.hex || '' }); } catch { /* ignore */ }
      out.write('#result ' + JSON.stringify({ ok: r.ok, error: r.error || null, sizes: r.sizes || null, elf: r.elf, hex: r.hex, bin: r.bin, ms: r.ms, prototypes: r.prototypes || 0, core: r.core || null, toolchain: r.toolchain || null }));
    } catch (e) {
      out.write('✗ ' + (e?.message || String(e)));
      out.write('#result ' + JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    out.end();
    return true;
  }
  if (isPost && path === '/api/build/matrix') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const out = makeStream(res);
    const list = Array.isArray(body.fqbns) ? body.fqbns.slice(0, 12) : [];
    const rows = [];
    for (const fqbn of list) {
      const board = findBoard(fqbn);
      out.write('');
      out.write(`=== ${board?.name || fqbn} (${fqbn}) ===`);
      const t0 = Date.now();
      const r = await buildWithOwnEngine({
        name: body.name || 'Sketch', fqbn, files: asFiles(body.files),
        onLine: (l) => out.write('  ' + l), verbose: false, signal: ctx.signal,
        buildRoot: join(DATA_DIR, 'build', `matrix-${String(fqbn).replace(/:/g, '-')}`),
      });
      rows.push({
        fqbn, name: board?.name || fqbn, ok: r.ok,
        flash: r.sizes?.flash ?? null, ram: r.sizes?.ram ?? null,
        pctFlash: r.sizes?.pctFlash ?? null, pctRam: r.sizes?.pctRam ?? null,
        warns: r.sizes?.warns || [], error: r.error || null, ms: Date.now() - t0,
      });
    }
    out.write('');
    out.write('— Итоги по платам —');
    for (const r of rows) {
      out.write(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.flash != null ? `флеш ${r.flash}${r.pctFlash != null ? ` (${r.pctFlash}%)` : ''}` : '—'}${r.ram != null ? `, ОЗУ ${r.ram}${r.pctRam != null ? ` (${r.pctRam}%)` : ''}` : ''}${r.error ? ' — ' + r.error : ''}`);
      for (const w of r.warns) out.write('   ⚠ ' + w);
    }
    out.write('#result ' + JSON.stringify({ ok: rows.every((r) => r.ok), rows }));
    out.end();
    return true;
  }
  if (isPost && path === '/api/upload/own') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const out = makeStream(res);
    const t0 = Date.now();
    try {
      let r = body.build === false ? { ok: true, hex: body.hex, elf: body.elf } : await buildWithOwnEngine({
        name: body.name || 'Sketch', fqbn: body.fqbn || '', files: asFiles(body.files),
        onLine: (l) => out.write(l), verbose: !!body.verbose, signal: ctx.signal,
      });
      if (!r.ok) {
        out.write('✗ Сборка не удалась: ' + r.error);
        out.write('#result ' + JSON.stringify({ ok: false, error: r.error }));
      } else {
        if (serial?.isOpen && serial.port === body.port) { serial.close(); out.write('(монитор порта закрыт на время прошивки)'); }
        const up = await uploadWithOwnEngine({
          fqbn: body.fqbn, port: body.port, hex: r.hex, elf: r.elf, bin: r.bin,
          name: body.name || 'Sketch', onLine: (l) => out.write(l), verbose: !!body.verbose, signal: ctx.signal,
        });
        out.write(up.ok ? '✓ Прошивка завершена' : '✗ ' + up.error);
        try { recordBuild({ name: body.name || 'Sketch', fqbn: body.fqbn, ok: up.ok, flash: r.sizes?.flash, ram: r.sizes?.ram, ms: Date.now() - t0, kind: 'upload', via: up.via || 'своя прошивка', error: up.error || '', hex: r.hex || '' }); } catch { /* ignore */ }
        out.write('#result ' + JSON.stringify({ ok: up.ok, error: up.error || null, via: up.via || null, sizes: r.sizes || null, cmd: up.cmd || null }));
      }
    } catch (e) {
      out.write('✗ ' + (e?.message || String(e)));
      out.write('#result ' + JSON.stringify({ ok: false, error: e?.message || String(e) }));
    }
    out.end();
    return true;
  }
  if (isGet && path === '/api/build/map') {
    const name = q.get('name') || '';
    const rec = registry?.last(name);
    if (!rec?.elf) return sendJson(res, 200, { ok: false, error: 'Сначала соберите скетч — карта строится по .elf' }), true;
    const core = resolveCore(rec.fqbn || '');
    const vars = core.ok ? loadCoreProps(core.dir, String(rec.fqbn).split(':')[2] || '').vars : new Map();
    const tc = core.ok ? await findToolchain({ coreDir: core.dir, vars, arch: 'avr' }) : { ok: false };
    const map = await symbolMap(rec.elf, tc.ok ? tc : null, { limit: Number(q.get('limit')) || 40 });
    return sendJson(res, 200, { ok: map.ok, ...map, elf: rec.elf, fqbn: rec.fqbn, sizes: rec.sizes || null, at: rec.at, error: map.error }), true;
  }
  if (isGet && path === '/api/build/last') {
    return sendJson(res, 200, { ok: true, builds: (registry?.list() || []).slice(-20).reverse() }), true;
  }

  // ====================================================== перенос на другую плату
  if (isGet && path === '/api/port/checklist') {
    return sendJson(res, 200, portChecklist(q.get('to') || '')), true;
  }
  if (isPost && path === '/api/port/plan') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const plan = portPlan({ from: body.from || '', to: body.to || '', files: asFiles(body.files), name: body.name || 'Sketch' });
    return sendJson(res, plan.ok ? 200 : 400, plan), true;
  }

  // =========================================================== энергопрофиль
  if (isPost && path === '/api/power/profile') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const p = powerProfile({
      files: asFiles(body.files), fqbn: body.fqbn || '',
      batteryMmah: Number(body.batteryMmah) || 2000, efficiency: Number(body.efficiency) || 0.85,
    });
    return sendJson(res, p.ok ? 200 : 400, p), true;
  }

  // ==================================================== генераторы шаблонов
  if (isGet && path === '/api/scaffold/templates') {
    return sendJson(res, 200, { ok: true, templates: templatesForUi() }), true;
  }
  if (isPost && path === '/api/scaffold/sketch') {
    const body = await readBody(req, 32 * 1024);
    const r = sketchTemplate({ id: body.id || '', name: body.name || 'Sketch', fqbn: body.fqbn || '' });
    return sendJson(res, r.ok ? 200 : 400, r), true;
  }
  if (isPost && path === '/api/scaffold/module') {
    const body = await readBody(req, 32 * 1024);
    const r = moduleSkeleton({ name: body.name || '', kind: body.kind || 'sensor', fqbn: body.fqbn || '' });
    return sendJson(res, r.ok ? 200 : 400, r), true;
  }
  if (isPost && path === '/api/scaffold/library') {
    const body = await readBody(req, 32 * 1024);
    const r = librarySkeleton({
      name: body.name || '', author: body.author || '', version: body.version || '0.1.0',
      sentence: body.sentence || '', fqbn: body.fqbn || '',
    });
    if (!r.ok) return sendJson(res, 400, r), true;
    if (!body.write) return sendJson(res, 200, { ...r, written: [] }), true;
    // записываем в скетчбук: libraries/<Name>/…
    const base = resolvePath(sketchbookDir(), 'libraries');
    const dir = resolvePath(base, r.name);
    if (dir !== base && !dir.startsWith(base + pathSep)) return sendJson(res, 400, { ok: false, error: 'Путь вне скетчбука' }), true;
    const written = [];
    for (const f of r.files) {
      const dst = resolvePath(dir, f.path);
      if (!dst.startsWith(dir + pathSep)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, f.content, 'utf8');
      written.push(dst);
    }
    return sendJson(res, 200, { ...r, ok: true, dir, written, note: 'Библиотека в скетчбуке: MicroPIDE видит её без интернета' }), true;
  }

  return false;
}
