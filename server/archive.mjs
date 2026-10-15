// Работа с архивами без внешних утилит: zip и tar распаковываются своим кодом
// (только zlib из Node.js), поэтому склад MicroPIDE работает и там, где нет
// unzip/bsdtar. Для .tar.bz2 внешний tar всё же нужен — bzip2 в Node нет.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

/** Безопасный путь внутри каталога: без «..» и без абсолютных корней. */
export function safeJoin(dest, entryName, strip = 0) {
  let name = String(entryName).replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = name.split('/').filter((p) => p && p !== '.' && p !== '..');
  const stripped = parts.slice(strip);
  if (!stripped.length) return null;
  const out = resolve(join(dest, ...stripped));
  const root = resolve(dest);
  if (out !== root && !out.startsWith(root + sep)) return null;
  return { path: out, isDir: String(entryName).endsWith('/'), rel: stripped.join('/') };
}

// ------------------------------------------------------------------ ZIP

/** Оглавление zip-файла (центральный каталог). */
export function listZip(file) {
  const buf = readFileSync(file);
  return listZipBuf(buf);
}

export function listZipBuf(buf) {
  // ищем EOCD с конца
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Это не zip-файл (нет записи EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 пока не поддерживается — распакуйте файл вручную');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, size, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Распаковать zip в каталог. Возвращает список записанных файлов. */
export function extractZip(file, dest, { strip = 0, filter } = {}) {
  const buf = readFileSync(file);
  const entries = listZipBuf(buf);
  const written = [];
  mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    const target = safeJoin(dest, e.name, strip);
    if (!target) continue;
    if (filter && !filter(target.rel, e)) continue;
    if (target.isDir) { mkdirSync(target.path, { recursive: true }); continue; }
    // локальный заголовок: своя длина extra
    const lo = e.localOffset;
    if (buf.readUInt32LE(lo) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const dataStart = lo + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + e.compressedSize);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = zlib.inflateRawSync(raw);
    else continue; // прочие методы (bzip2/lzma) в zip почти не встречаются
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, data, { mode: isExecutable(e.name) ? 0o755 : 0o644 });
    written.push(target.rel);
  }
  return written;
}

const isExecutable = (name) => /(^|\/)(bin\/|.*\.(sh|py|exe))$/i.test(name);

// ------------------------------------------------------------------ TAR

/** Разбор tar (ustar + GNU longname + pax) из буфера. */
export function listTarBuf(buf) {
  const entries = [];
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const name = cstr(block, 0, 100);
    const sizeStr = cstr(block, 124, 12).trim();
    const size = sizeStr ? parseInt(sizeStr, 8) || 0 : 0;
    const type = String.fromCharCode(block[156] || 48);
    const prefix = cstr(block, 345, 155);
    const magic = cstr(block, 257, 6);
    const dataStart = off + 512;
    const fullName = longName || (prefix ? prefix.replace(/\/$/, '') + '/' + name : name);
    if (type === 'L' || type === 'K') {
      longName = buf.toString('utf8', dataStart, dataStart + size).replace(/\0.*$/, '');
      off = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === 'x' || type === 'X') {
      const pax = buf.toString('utf8', dataStart, dataStart + size);
      const m = /path=([^\n]+)/.exec(pax);
      if (m) paxPath = m[1];
      off = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === 'g') { off = dataStart + Math.ceil(size / 512) * 512; continue; }
    const finalName = paxPath || fullName;
    entries.push({ name: finalName, size, type, dataStart, magic });
    longName = null; paxPath = null;
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Распаковать tar / tar.gz / tgz своим кодом. */
export function extractTar(file, dest, { strip = 0, filter, gzip = false } = {}) {
  const rawBuf = readFileSync(file);
  const buf = gzip ? zlib.gunzipSync(rawBuf) : rawBuf;
  const entries = listTarBuf(buf);
  const written = [];
  mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    if (e.type !== '0' && e.type !== '\0' && e.type !== ' ' && e.type !== '5' && e.type !== '7') continue;
    const target = safeJoin(dest, e.name, strip);
    if (!target) continue;
    if (filter && !filter(target.rel, e)) continue;
    if (e.type === '5' || e.name.endsWith('/')) { mkdirSync(target.path, { recursive: true }); continue; }
    const data = buf.subarray(e.dataStart, e.dataStart + e.size);
    mkdirSync(dirname(target.path), { recursive: true });
    const mode = (e.name.includes('/bin/') || /\.(sh|py)$/.test(e.name)) ? 0o755 : 0o644;
    writeFileSync(target.path, data, { mode });
    written.push(target.rel);
  }
  return written;
}

function cstr(buf, from, len) {
  const slice = buf.subarray(from, from + len);
  const end = slice.indexOf(0);
  return slice.toString('utf8', 0, end === -1 ? slice.length : end);
}

// ------------------------------------------------------------------ общий интерфейс

/** Тип архива по расширению. */
export function archiveKind(file) {
  const n = String(file).toLowerCase();
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'targz';
  if (n.endsWith('.tar.bz2') || n.endsWith('.tbz2') || n.endsWith('.tbz')) return 'tarbz2';
  if (n.endsWith('.tar')) return 'tar';
  if (n.endsWith('.gz')) return 'gzip';
  if (n.endsWith('.bz2')) return 'bzip2';
  return 'unknown';
}

/** Оглавление архива (без распаковки). */
export function listArchive(file) {
  const kind = archiveKind(file);
  if (kind === 'zip') return { kind, entries: listZip(file).map((e) => ({ name: e.name, size: e.size, dir: e.name.endsWith('/') })) };
  if (kind === 'tar' || kind === 'targz') {
    const buf = readFileSync(file);
    const raw = kind === 'targz' ? zlib.gunzipSync(buf) : buf;
    return { kind, entries: listTarBuf(raw).map((e) => ({ name: e.name, size: e.size, dir: e.type === '5' || e.name.endsWith('/') })) };
  }
  if (kind === 'tarbz2' || kind === 'bzip2') {
    // своим кодом bzip2 не распаковать — спрашиваем системный tar (есть в Linux, macOS, Windows 10+)
    const r = spawnSync('tar', ['-tjf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('Не удалось прочитать .tar.bz2 (нужен системный tar): ' + (r.stderr || '').slice(0, 200));
    return { kind, entries: String(r.stdout).split('\n').filter(Boolean).map((n) => ({ name: n, size: 0, dir: n.endsWith('/') })) };
  }
  throw new Error('Неизвестный формат архива: ' + file);
}

/**
 * Распаковать архив в каталог; strip — сколько верхних уровней отбросить
 * (у архивов GitHub всегда корневая папка репозитория).
 */
export function extractArchive(file, dest, { strip = 0, filter, stripAuto = false } = {}) {
  const kind = archiveKind(file);
  if (stripAuto && !strip) {
    // автоматически убираем единственную корневую папку
    try {
      const { entries } = listArchive(file);
      const roots = new Set(entries.map((e) => e.name.split('/')[0]));
      if (roots.size === 1) strip = 1;
    } catch { /* ignore */ }
  }
  if (kind === 'zip') return extractZip(file, dest, { strip, filter });
  if (kind === 'tar' || kind === 'targz') return extractTar(file, dest, { strip, filter, gzip: kind === 'targz' });
  if (kind === 'tarbz2') {
    mkdirSync(dest, { recursive: true });
    const args = ['-xjf', file, '-C', dest];
    if (strip) args.push('--strip-components=' + strip);
    const r = spawnSync('tar', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('tar не смог распаковать ' + file + ': ' + (r.stderr || '').slice(0, 300));
    return ['<tar.bz2>'];
  }
  throw new Error('Неизвестный формат архива: ' + file);
}

/**
 * Найти в распакованном дереве файл с заданным именем (до depth уровней).
 * Нужно, чтобы понять, что за архив: library.properties → библиотека,
 * platform.txt → ядро платформы.
 */
export function findFile(dir, name, maxDepth = 3) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > maxDepth || !existsSync(d)) return;
    let items = [];
    try { items = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.name === name) found.push(full);
    }
  };
  walk(dir, 0);
  return found;
}

export const __internal = { cstr, isExecutable };
