// Скетчбук MicroPIDE: проекты на диске, как в Arduino IDE.
// Активный каталог — из resolveDirs(): либо папка Arduino IDE пользователя
// (~/Arduino, ~/Documents/Arduino), либо внутренний .data/sketchbook.
// Проекты ищутся рекурсивно (каталог = скетч, если в нём есть .ino).
import { join, basename, extname, resolve, sep } from 'node:path';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync,
  statSync, renameSync,
} from 'node:fs';
import { resolveDirs, DATA_DIR } from './arduino.mjs';

const ALLOWED_EXT = new Set(['.ino', '.cpp', '.h', '.hpp', '.c', '.S', '.json', '.md', '.txt']);

/** Активный каталог скетчбука. */
export function sketchbookDir() {
  return resolveDirs().user;
}

/** Имя скетча: «Blink», «Учебные/Blink» или «Учебные/Основы/Blink». */
function safeRel(name) {
  const parts = String(name || '').split('/').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) throw new Error('Недопустимый путь скетча (до трёх уровней папок)');
  for (const p of parts) {
    if (!/^[\p{L}\d_][\p{L}\d _-]{0,60}$/u.test(p)) throw new Error('Недопустимое имя: ' + p);
  }
  return parts.join('/');
}

/** Каталог скетча внутри скетчбука, с защитой от выхода наружу. */
function sketchDir(name) {
  const rel = safeRel(name);
  const base = resolve(sketchbookDir());
  const dir = resolve(base, rel);
  if (dir !== base && !dir.startsWith(base + sep)) throw new Error('Путь вне скетчбука');
  return dir;
}

export function ensureSketchbook() {
  mkdirSync(sketchbookDir(), { recursive: true });
}

/**
 * Список скетчей: рекурсивный обход скетчбука (как дерево «Скетчбук» в
 * Arduino IDE 2). Каталог считается скетчем, если в нём лежит .ino.
 * name — путь от корня скетчбука: «Blink» или «Учебные/Blink».
 */
export function listSketches() {
  ensureSketchbook();
  const base = sketchbookDir();
  const out = [];
  const SKIP = new Set(['libraries', 'hardware', 'tools', 'node_modules']);
  const walk = (dir, rel, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const hasIno = entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.ino'));
    if (hasIno) {
      const files = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!ALLOWED_EXT.has(extname(e.name).toLowerCase())) continue;
        try { files.push({ path: e.name, size: statSync(join(dir, e.name)).size }); } catch { /* ignore */ }
      }
      let mtime = 0;
      try {
        mtime = statSync(dir).mtimeMs;
        for (const f of files) mtime = Math.max(mtime, statSync(join(dir, f.path)).mtimeMs);
      } catch { /* ignore */ }
      out.push({ name: rel, mtime, files });
      return; // внутри каталога-скетча глубже не ищем
    }
    if (depth >= 3) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || SKIP.has(e.name.toLowerCase())) continue;
      walk(join(dir, e.name), rel ? rel + '/' + e.name : e.name, depth + 1);
    }
  };
  walk(base, '', 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Прочитать скетч: все текстовые файлы каталога. */
export function readSketch(name) {
  const dir = sketchDir(name);
  if (!existsSync(dir)) throw new Error('Скетч не найден: ' + name);
  const files = [];
  for (const f of readdirSync(dir)) {
    const fp = join(dir, f);
    try {
      if (!statSync(fp).isFile()) continue;
      if (!ALLOWED_EXT.has(extname(f).toLowerCase())) continue;
      files.push({ path: f, content: readFileSync(fp, 'utf8') });
    } catch { /* ignore */ }
  }
  if (!files.length) throw new Error('В скетче нет читаемых файлов');
  return { name: safeRel(name), files };
}

/** Сохранить скетч (создать/перезаписать). files: [{path, content}]. */
export function writeSketch(name, files) {
  const dir = sketchDir(name);
  mkdirSync(dir, { recursive: true });
  if (!Array.isArray(files) || !files.length) throw new Error('Пустой список файлов');
  // главный .ino обязан называться как папка — как этого требует arduino-cli
  const folder = basename(dir);
  const ino = files.find((f) => /\.ino$/i.test(f.path || ''));
  if (ino && !/^[\p{L}\d_-]+\.ino$/iu.test(ino.path)) ino.path = folder + '.ino';
  // удалить старые файлы, которых больше нет
  const keep = new Set(files.map((f) => basename(f.path)));
  for (const f of readdirSync(dir)) {
    if (!keep.has(f)) { try { rmSync(join(dir, f)); } catch { /* ignore */ } }
  }
  for (const f of files) {
    const fn = basename(String(f.path || ''));
    if (!fn || !ALLOWED_EXT.has(extname(fn).toLowerCase())) continue;
    writeFileSync(join(dir, fn), String(f.content ?? ''), 'utf8');
  }
  return readSketch(name);
}

export function deleteSketch(name) {
  const dir = sketchDir(name);
  if (!existsSync(dir)) throw new Error('Скетч не найден: ' + name);
  // защита: удаляем только каталог-скетч (с .ino), не корень скетчбука
  if (!existsSync(join(dir, basename(dir) + '.ino'))) {
    throw new Error('В каталоге нет главного .ino — отказ удалять');
  }
  rmSync(dir, { recursive: true, force: true });
}

export function renameSketch(from, to) {
  const src = sketchDir(from);
  if (!existsSync(src)) throw new Error('Скетч не найден: ' + from);
  const dst = sketchDir(to);
  if (existsSync(dst)) throw new Error('Скетч с таким именем уже есть');
  mkdirSync(resolve(dst, '..'), { recursive: true });
  renameSync(src, dst);
  // .ino должен называться как новая папка
  const folder = basename(dst);
  const oldIno = join(dst, basename(src) + '.ino');
  const newIno = join(dst, folder + '.ino');
  if (existsSync(oldIno) && oldIno !== newIno) renameSync(oldIno, newIno);
  return readSketch(to);
}

/** Каталог скетча на диске — для вызовов arduino-cli compile/upload. */
export function sketchPath(name) {
  const dir = sketchDir(name);
  if (!existsSync(dir)) throw new Error('Скетч не найден: ' + name);
  return dir;
}

/** Валидация файлов, пришедших с клиента. */
export function normalizeFiles(files) {
  if (!Array.isArray(files)) throw new Error('files должен быть массивом');
  const out = [];
  for (const f of files) {
    const fn = basename(String(f?.path || ''));
    if (!fn || !ALLOWED_EXT.has(extname(fn).toLowerCase())) continue;
    out.push({ path: fn, content: String(f?.content ?? '').slice(0, 4_000_000) });
  }
  if (!out.length) throw new Error('Нет файлов для сохранения');
  return out;
}

/** Прочитать каталог примера по абсолютному пути (только внутри данных приложения). */
export function readSketchDir(absPath) {
  const dir = resolve(String(absPath || ''));
  const d = resolveDirs();
  const allowedRoots = [resolve(DATA_DIR), resolve(d.user), resolve(d.data), resolve(d.internal.user), resolve(d.internal.data)];
  const okRoot = allowedRoots.some((root) => dir === root || dir.startsWith(root + sep));
  if (!okRoot) throw new Error('Путь вне данных приложения');
  if (!existsSync(dir)) throw new Error('Каталог не найден');
  if (!statSync(dir).isDirectory()) throw new Error('Это не каталог');
  const files = [];
  for (const f of readdirSync(dir)) {
    const fp = join(dir, f);
    try {
      if (!statSync(fp).isFile()) continue;
      if (!ALLOWED_EXT.has(extname(f).toLowerCase())) continue;
      files.push({ path: f, content: readFileSync(fp, 'utf8') });
    } catch { /* ignore */ }
  }
  if (!files.length) throw new Error('В каталоге нет читаемых файлов скетча');
  const name = basename(dir).replace(/[^\p{L}\d _-]/gu, '') || 'Example';
  return { name, files };
}
