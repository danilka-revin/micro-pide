// Скетчбук MicroPIDE: папки со скетчами на диске (как в Arduino IDE).
// Каждый скетч — каталог <sketchbook>/<Имя>/<Имя>.ino + вспомогательные файлы.
// Каталог скетчбука: env MICRO_PIDE_SKETCHBOOK, иначе <repo>/.data/sketchbook.
import { join, basename, extname, resolve, sep } from 'node:path';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync,
  statSync, renameSync,
} from 'node:fs';
import { SKETCHBOOK_DIR, DATA_DIR } from './arduino.mjs';

const ALLOWED_EXT = new Set(['.ino', '.cpp', '.h', '.hpp', '.c', '.S', '.json', '.md', '.txt']);
const SKETCH_EXT = new Set(['.ino', '.cpp', '.h', '.hpp', '.c', '.S']);

function safeName(name) {
  const n = String(name || '').trim();
  if (!/^[\p{L}\d_][\p{L}\d _-]{0,60}$/u.test(n)) {
    throw new Error('Недопустимое имя скетча: буквы, цифры, пробел, _ и - (до 60 символов)');
  }
  return n;
}

/** Путь внутри скетчбука с защитой от выхода наружу. */
function sketchDir(name) {
  const n = safeName(name);
  const dir = resolve(SKETCHBOOK_DIR, n);
  if (!dir.startsWith(resolve(SKETCHBOOK_DIR) + sep)) throw new Error('Путь вне скетчбука');
  return dir;
}

export function ensureSketchbook() {
  mkdirSync(SKETCHBOOK_DIR, { recursive: true });
}

/** Список скетчей: { name, mtime, files } — файлы считаются лениво? нет, их немного. */
export function listSketches() {
  ensureSketchbook();
  const out = [];
  for (const name of readdirSync(SKETCHBOOK_DIR)) {
    const dir = join(SKETCHBOOK_DIR, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const files = [];
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f);
      try {
        if (!statSync(fp).isFile()) continue;
        if (!ALLOWED_EXT.has(extname(f).toLowerCase())) continue;
        files.push({ path: f, size: statSync(fp).size });
      } catch { /* ignore */ }
    }
    out.push({ name, mtime: st.mtimeMs, files });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Прочитать скетч: все текстовые файлы. */
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
  return { name: basename(dir), files };
}

/** Сохранить скетч (создать/перезаписать). files: [{path, content}]. */
export function writeSketch(name, files) {
  const dir = sketchDir(name);
  mkdirSync(dir, { recursive: true });
  if (!Array.isArray(files) || !files.length) throw new Error('Пустой список файлов');
  // главный .ino обязан называться как папка — как этого требует arduino-cli
  const ino = files.find((f) => /\.ino$/i.test(f.path || ''));
  if (ino && !/^[\p{L}\d_-]+\.ino$/iu.test(ino.path)) {
    ino.path = safeName(name) + '.ino';
  }
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
  rmSync(dir, { recursive: true, force: true });
}

export function renameSketch(from, to) {
  const src = sketchDir(from);
  if (!existsSync(src)) throw new Error('Скетч не найден: ' + from);
  const dst = sketchDir(to);
  if (existsSync(dst)) throw new Error('Скетч с таким именем уже есть');
  renameSync(src, dst);
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
  const allowedRoots = [resolve(DATA_DIR), resolve(SKETCHBOOK_DIR)];
  if (!allowedRoots.some((root) => dir.startsWith(root + sep) || dir === root)) {
    throw new Error('Путь вне данных приложения');
  }
  if (!existsSync(dir)) throw new Error('Каталог не найден');
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error('Это не каталог');
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
  const name = basename(dir).replace(/[^\w\x20-]/g, '') || 'Example';
  return { name, files };
}
