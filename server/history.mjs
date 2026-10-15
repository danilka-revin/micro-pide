// История MicroPIDE: снимки скетча, сравнение версий и «машина времени» сборок.
//
// Ни в Arduino IDE, ни в других средах нет встроенной истории изменений и
// графиков размера прошивки. Здесь есть:
//   • автоматический снимок перед каждой сборкой/прошивкой и при сохранении;
//   • ручные снимки с комментарием («перед переделкой»);
//   • сравнение двух версий — свой построчный diff (unified);
//   • восстановление любой версии в редактор;
//   • журнал сборок: флеш, ОЗУ, время, удача/ошибка — с дельтами и трендом.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './arduino.mjs';

const HISTORY_DIR = () => join(DATA_DIR, 'history');
const INDEX = () => join(HISTORY_DIR(), 'index.json');

const safeName = (name) => String(name || 'sketch').replace(/[^\w.\-А-Яа-яЁё ]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'sketch';
const sketchDir = (name) => join(HISTORY_DIR(), safeName(name));

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Идентификатор снимка: время + случайный хвост (не пересекается при пакетной записи). */
function newId() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Сделать снимок скетча.
 * meta: {reason: 'save'|'build'|'upload'|'manual'|'before-fix', note, fqbn, author}
 */
export function snapshot(name, files, meta = {}) {
  const id = newId();
  const entry = {
    id,
    name: String(name || 'Sketch'),
    at: Date.now(),
    reason: meta.reason || 'manual',
    note: meta.note || '',
    fqbn: meta.fqbn || '',
    hash: meta.hash || createHash('sha1').update(files.map((f) => f.path + '\0' + String(f.content ?? '')).join('\0\0')).digest('hex').slice(0, 16),
    stats: { files: files.length, bytes: files.reduce((a, f) => a + Buffer.byteLength(String(f.content || '')), 0) },
    files: files.map((f) => ({ path: String(f.path), content: String(f.content ?? '') })),
  };
  const dir = sketchDir(name);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, `${id}.json`), entry);

  const idx = readJson(INDEX(), { sketches: {} });
  const key = safeName(name);
  const list = idx.sketches[key]?.snapshots || [];
  list.push({ id, at: entry.at, reason: entry.reason, note: entry.note, files: entry.stats.files, bytes: entry.stats.bytes, hash: entry.hash });
  idx.sketches[key] = { name: String(name || 'Sketch'), dir, snapshots: list.slice(-200), updated: Date.now() };
  writeJson(INDEX(), idx);
  return { ok: true, id, at: entry.at, stats: entry.stats, keep: 200 };
}

/**
 * Снимок только если содержимое изменилось (сравниваем SHA-1 файлов).
 * Так автосохранение и сборки не засоряют историю одинаковыми версиями.
 */
export function snapshotIfChanged(name, files, meta = {}) {
  const normalized = (files || []).map((f) => ({ path: String(f.path), content: String(f.content ?? '') }));
  const hash = createHash('sha1').update(normalized.map((f) => f.path + '\0' + f.content).join('\0\0')).digest('hex').slice(0, 16);
  const last = listSnapshots(name, 1).snapshots[0];
  if (last && last.hash === hash) return { ok: true, skipped: true, id: last.id, hash };
  const r = snapshot(name, normalized, { ...meta, hash });
  return r;
}

/** Список снимков скетча (свежие первыми). */
export function listSnapshots(name, limit = 50) {
  const idx = readJson(INDEX(), { sketches: {} });
  const list = idx.sketches[safeName(name)]?.snapshots || [];
  return { ok: true, name, snapshots: [...list].reverse().slice(0, limit), total: list.length };
}

/** Все скетчи, у которых есть история. */
export function historyOverview() {
  const idx = readJson(INDEX(), { sketches: {} });
  const sketches = Object.entries(idx.sketches).map(([key, v]) => {
    const builds = readJson(join(HISTORY_DIR(), key, 'builds.json'), []);
    return {
      key, name: v.name, snapshots: (v.snapshots || []).length, updated: v.updated || 0,
      bytes: (v.snapshots || []).slice(-1)[0]?.bytes || 0,
      builds: builds.length,
      lastBuild: builds.slice(-1)[0] || null,
    };
  }).sort((a, b) => b.updated - a.updated);
  return { ok: true, dir: HISTORY_DIR(), sketches };
}

/** Прочитать снимок. */
export function getSnapshot(name, id) {
  const file = join(sketchDir(name), `${id}.json`);
  if (!existsSync(file)) return { ok: false, error: 'Снимок не найден: ' + id };
  return { ok: true, ...readJson(file, {}) };
}

/** Удалить снимок. */
export function deleteSnapshot(name, id) {
  const file = join(sketchDir(name), `${id}.json`);
  rmSync(file, { force: true });
  const idx = readJson(INDEX(), { sketches: {} });
  const key = safeName(name);
  if (idx.sketches[key]) {
    idx.sketches[key].snapshots = (idx.sketches[key].snapshots || []).filter((s) => s.id !== id);
    writeJson(INDEX(), idx);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Свой построчный diff
// ---------------------------------------------------------------------------

function lcsDiff(a, b) {
  // классический LCS; при больших файлах деградируем до грубого сравнения
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return null;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

/** Unified-diff двух текстов (свой, без внешних зависимостей). */
export function unifiedDiff(textA, textB, { labelA = 'a', labelB = 'b', context = 3 } = {}) {
  const a = String(textA ?? '').split('\n');
  const b = String(textB ?? '').split('\n');
  if (textA === textB) return { text: '', added: 0, removed: 0, hunks: 0, same: true };
  const ops = lcsDiff(a, b);
  if (!ops) {
    // грубый вариант для очень больших файлов: показываем строки, которых нет в другой версии
    const setB = new Set(b), setA = new Set(a);
    const ops2 = [];
    for (const l of a) ops2.push(setB.has(l) ? [' ', l] : ['-', l]);
    for (const l of b) if (!setA.has(l)) ops2.push(['+', l]);
    return finalizeDiff(ops2, labelA, labelB, context);
  }
  return finalizeDiff(ops, labelA, labelB, context);
}

function finalizeDiff(ops, labelA, labelB, context) {
  const out = [];
  let hunks = 0, added = 0, removed = 0;
  for (const [op] of ops) { if (op === '+') added++; else if (op === '-') removed++; }
  // группируем изменения с контекстом
  let i = 0;
  let oldLine = 1, newLine = 1;
  while (i < ops.length) {
    if (ops[i][0] === ' ') { oldLine++; newLine++; i++; continue; }
    // начало ханка: отступим контекст назад
    let start = i;
    let ctxBefore = 0;
    while (start > 0 && ops[start - 1][0] === ' ' && ctxBefore < context) { start--; ctxBefore++; }
    let end = i;
    let lastChange = i;
    while (end < ops.length && (ops[end][0] !== ' ' || end - lastChange <= context * 2)) {
      if (ops[end][0] !== ' ') lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + 1 + context);
    const slice = ops.slice(start, end);
    const oldCount = slice.filter(([o]) => o !== '+').length;
    const newCount = slice.filter(([o]) => o !== '-').length;
    let headerOld = 1, headerNew = 1;
    for (let k = 0; k < start; k++) { if (ops[k][0] !== '+') headerOld++; if (ops[k][0] !== '-') headerNew++; }
    hunks++;
    out.push(`@@ -${headerOld},${oldCount} +${headerNew},${newCount} @@`);
    for (const [op, line] of slice) out.push(op + line);
    i = end;
  }
  return {
    text: out.join('\n'),
    added, removed, hunks, same: false,
    header: `--- ${labelA}\n+++ ${labelB}`,
  };
}

/** Сравнить два снимка (или снимок с текущими файлами). */
export function diffSnapshots(name, idA, idB, currentFiles = null) {
  const A = idA === 'current' && currentFiles ? { files: currentFiles, name } : getSnapshot(name, idA);
  const B = idB === 'current' && currentFiles ? { files: currentFiles, name } : getSnapshot(name, idB);
  if (A.ok === false) return A;
  if (B.ok === false) return B;
  const filesA = new Map((A.files || []).map((f) => [f.path, f.content]));
  const filesB = new Map((B.files || []).map((f) => [f.path, f.content]));
  const paths = [...new Set([...filesA.keys(), ...filesB.keys()])].sort();
  const files = [];
  let added = 0, removed = 0, changed = 0;
  for (const p of paths) {
    const a = filesA.get(p), b = filesB.get(p);
    if (a === undefined && b !== undefined) { files.push({ path: p, status: 'added', diff: unifiedDiff('', b, { labelA: '/dev/null', labelB: p }), added: (b.match(/\n/g) || []).length }); changed++; continue; }
    if (b === undefined && a !== undefined) { files.push({ path: p, status: 'removed', diff: unifiedDiff(a, '', { labelA: p, labelB: '/dev/null' }), removed: (a.match(/\n/g) || []).length }); changed++; continue; }
    if (a === b) { files.push({ path: p, status: 'same' }); continue; }
    const d = unifiedDiff(a, b, { labelA: p + (idA === 'current' ? ' (сейчас)' : ' @' + idA), labelB: p + (idB === 'current' ? ' (сейчас)' : ' @' + idB) });
    files.push({ path: p, status: 'changed', diff: d, added: d.added, removed: d.removed });
    added += d.added; removed += d.removed; changed++;
  }
  return {
    ok: true, a: { id: idA, at: A.at, reason: A.reason, files: A.files?.length }, b: { id: idB, at: B.at, reason: B.reason, files: B.files?.length },
    files, added, removed, changed,
    summary: changed === 0 ? 'Версии совпадают' : `Изменено файлов: ${changed}, добавлено строк: ${added}, удалено: ${removed}`,
  };
}

/** Восстановить файлы из снимка. */
export function restore(name, id) {
  const s = getSnapshot(name, id);
  if (s.ok === false) return s;
  return { ok: true, name: s.name, files: s.files, at: s.at, note: s.note, reason: s.reason };
}

// ---------------------------------------------------------------------------
// Журнал сборок: флеш, ОЗУ, время
// ---------------------------------------------------------------------------

/** Записать результат сборки/прошивки. */
export function recordBuild({ name, fqbn, ok, flash, ram, ms, kind = 'build', error = '', via = '', hex = '' }) {
  const dir = sketchDir(name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'builds.json');
  const list = readJson(file, []);
  const prev = list.slice(-1)[0];
  const entry = {
    at: Date.now(), kind, fqbn, ok: !!ok,
    flash: flash ?? null, ram: ram ?? null, ms: ms ?? null, via, hex: hex ? hex.split('/').pop() : '', error: String(error || '').slice(0, 400),
    dFlash: flash != null && prev?.flash != null ? flash - prev.flash : null,
    dRam: ram != null && prev?.ram != null ? ram - prev.ram : null,
  };
  list.push(entry);
  writeJson(file, list.slice(-300));
  return { ok: true, entry };
}

/** Журнал сборок скетча. */
export function buildLog(name, limit = 100) {
  const list = readJson(join(sketchDir(name), 'builds.json'), []);
  return { ok: true, name, builds: list.slice(-limit), total: list.length };
}

/** Статистика размеров: тренд, пики, предупреждения о росте. */
export function buildStats(name) {
  const list = readJson(join(sketchDir(name), 'builds.json'), []).filter((b) => b.ok);
  if (!list.length) return { ok: true, name, builds: 0, series: [], warnings: [] };
  const flash = list.map((b) => b.flash).filter((v) => v != null);
  const ram = list.map((b) => b.ram).filter((v) => v != null);
  const first = list[0], last = list[list.length - 1];
  const warnings = [];
  const pct = (now, base) => (base > 0 ? Math.round(((now - base) / base) * 100) : 0);
  if (flash.length > 1) {
    const d = flash[flash.length - 1] - flash[0];
    // тренд замечаем и по байтам, и по процентам: рост на 20% важен даже при малых числах
    if (d > 2048 || (d > 256 && pct(flash[flash.length - 1], flash[0]) >= 20)) {
      warnings.push(`Прошивка выросла на ${d} байт (${pct(flash[flash.length - 1], flash[0])}%) с первой сборки — проверьте библиотеки`);
    }
    const prev = flash[flash.length - 2];
    const step = flash[flash.length - 1] - prev;
    if (step > 1024 || (step > 256 && pct(flash[flash.length - 1], prev) >= 15)) warnings.push(`Последняя сборка добавила ${step} байт (${pct(flash[flash.length - 1], prev)}%)`);
  }
  if (ram.length > 1) {
    const dr = ram[ram.length - 1] - ram[0];
    if (dr > 256 || (dr > 64 && pct(ram[ram.length - 1], ram[0]) >= 25)) warnings.push(`Глобальные переменные выросли на ${dr} байт — следите за стеком`);
  }
  const maxFlash = Math.max(...flash, 0);
  return {
    ok: true, name, builds: list.length,
    first: { at: first.at, fqbn: first.fqbn, flash: first.flash, ram: first.ram },
    last: { at: last.at, fqbn: last.fqbn, flash: last.flash, ram: last.ram, ms: last.ms },
    flash: { min: flash.length ? Math.min(...flash) : null, max: maxFlash, last: flash.slice(-1)[0] ?? null },
    ram: { min: ram.length ? Math.min(...ram) : null, max: ram.length ? Math.max(...ram) : null, last: ram.slice(-1)[0] ?? null },
    series: list.slice(-60).map((b) => ({ at: b.at, flash: b.flash, ram: b.ram, ms: b.ms, fqbn: b.fqbn, ok: b.ok })),
    warnings,
  };
}

/** Убрать старые снимки (оставить последние keep штук). */
export function prune(name, keep = 40) {
  const key = safeName(name);
  const dir = sketchDir(name);
  if (!existsSync(dir)) return { ok: true, removed: 0 };
  const idx = readJson(INDEX(), { sketches: {} });
  const list = idx.sketches[key]?.snapshots || [];
  if (list.length <= keep) return { ok: true, removed: 0 };
  const drop = list.slice(0, list.length - keep);
  for (const s of drop) rmSync(join(dir, `${s.id}.json`), { force: true });
  idx.sketches[key].snapshots = list.slice(list.length - keep);
  writeJson(INDEX(), idx);
  return { ok: true, removed: drop.length };
}

/** Сколько всего занимает история (для настроек). */
export function historySize() {
  const dir = HISTORY_DIR();
  let bytes = 0, files = 0;
  const walk = (d, depth = 0) => {
    if (depth > 3 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else { files++; try { bytes += statSync(full).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return { ok: true, dir, files, bytes, text: `${files} файлов, ${(bytes / 1024).toFixed(0)} КБ` };
}
