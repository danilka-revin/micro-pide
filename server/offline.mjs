// «Автономно» — режим работы MicroPIDE без серверов Arduino.
//
// Что здесь есть:
//   • склад (vault) — каталог .data/vault, куда кладут архивы ядер, библиотек
//     и тулчейнов. Всё распаковывается нашим кодом (archive.mjs) и ставится на
//     место так, что его видят и наш сборщик, и arduino-cli;
//   • зеркала — список URL (по умолчанию GitHub-архивы ядер и тулчейнов),
//     которые используются вместо downloads.arduino.cc;
//   • свои индексы package_index.json / library_index.json со локальными
//     путями file:// и честными SHA-256 — их подхватывает arduino-cli через
//     --additional-urls, поэтому установка идёт с диска, а не из интернета;
//   • статус инструментов — что уже есть на машине, чего не хватает.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, chmodSync, copyFileSync } from 'node:fs';
import { join, basename, dirname, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, resolveDirs, getConfig, setConfig, findCli } from './arduino.mjs';
import { BOARDS, PLATFORMS, LIBRARY_CATALOG, packageIndex, libraryIndex, allBoards, findBoard } from './boarddb.mjs';
import { listArchive, extractArchive, findFile, archiveKind, safeJoin } from './archive.mjs';
import { findToolDir, findToolchain, loadCoreProps, runCmd, resolveCore } from './buildcore.mjs';

export const VAULT_DIR = () => join(DATA_DIR, 'vault');
export const OFFLINE_DIR = () => join(DATA_DIR, 'offline');
const MIRRORS_FILE = () => join(DATA_DIR, 'mirrors.json');
const NO_NET = () => process.env.MICRO_PIDE_NO_NET === '1';

/** Каталоги склада. */
export function vaultDirs() {
  const v = VAULT_DIR();
  return {
    root: v,
    archives: join(v, 'archives'),
    cores: join(v, 'cores'),
    libs: join(v, 'libs'),
    toolchains: join(v, 'toolchains'),
    staging: join(OFFLINE_DIR(), 'staging'),
  };
}

function ensureVault() {
  const d = vaultDirs();
  for (const p of Object.values(d)) mkdirSync(p, { recursive: true });
  return d;
}

// ------------------------------------------------------------------ зеркала

/** Зеркала по умолчанию: наши платформы + GitHub-архивы библиотек. */
export function defaultMirrors() {
  const platforms = {};
  for (const p of PLATFORMS) platforms[p.id] = { version: p.version, urls: [p.url, p.mirror].filter(Boolean) };
  const libraries = {};
  for (const l of LIBRARY_CATALOG) if (l.repo && l.tag) libraries[l.name] = { version: l.version, urls: [`https://github.com/${l.repo}/archive/refs/tags/${l.tag}.zip`, `https://codeload.github.com/${l.repo}/zip/refs/tags/${l.tag}`] };
  return {
    note: 'MicroPIDE не зависит от downloads.arduino.cc: ядра и библиотеки берутся из этих зеркал, а свои файлы можно положить в склад',
    platforms, libraries,
    extraIndexUrls: [],
  };
}

/** Текущие зеркала: файл пользователя поверх значений по умолчанию. */
export function mirrors() {
  const base = defaultMirrors();
  try {
    const raw = readFileSync(MIRRORS_FILE(), 'utf8');
    const user = JSON.parse(raw);
    return {
      ...base,
      ...user,
      platforms: { ...base.platforms, ...(user.platforms || {}) },
      libraries: { ...base.libraries, ...(user.libraries || {}) },
      extraIndexUrls: user.extraIndexUrls || base.extraIndexUrls,
    };
  } catch { return base; }
}

/** Обновить зеркала: {platforms:{id:{urls:[...]}}, libraries:{name:{urls:[]}}, extraIndexUrls:[]}. */
export function setMirrors(patch) {
  const cur = mirrors();
  const next = {
    ...cur,
    platforms: { ...cur.platforms, ...(patch.platforms || {}) },
    libraries: { ...cur.libraries, ...(patch.libraries || {}) },
    extraIndexUrls: patch.extraIndexUrls ?? cur.extraIndexUrls,
  };
  // раскрываем значения-строки в {urls:[...]}
  for (const [k, v] of Object.entries(next.platforms)) next.platforms[k] = typeof v === 'string' ? { urls: [v] } : v;
  for (const [k, v] of Object.entries(next.libraries)) next.libraries[k] = typeof v === 'string' ? { urls: [v] } : v;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MIRRORS_FILE(), JSON.stringify(next, null, 2));
  return next;
}

/** URL-ы для платформы: свои зеркала → каталог → GitHub. */
export function platformUrls(id) {
  const m = mirrors();
  const entry = m.platforms[id];
  const urls = [];
  if (entry?.urls?.length) urls.push(...entry.urls);
  const p = PLATFORMS.find((x) => x.id === id);
  if (p) urls.push(p.url, p.mirror);
  const [vendor, arch] = String(id).split(':');
  urls.push(`https://github.com/${guessRepo(vendor, arch)}/archive/refs/heads/master.tar.gz`);
  return [...new Set(urls.filter(Boolean))];
}

function guessRepo(vendor, arch) {
  const map = {
    'arduino:avr': 'arduino/ArduinoCore-avr',
    'arduino:samd': 'arduino/ArduinoCore-samd',
    'arduino:sam': 'arduino/ArduinoCore-sam',
    'arduino:megaavr': 'arduino/ArduinoCore-megaavr',
    'arduino:renesas_uno': 'arduino/ArduinoCore-renesas',
    'esp32:esp32': 'espressif/arduino-esp32',
    'esp8266:esp8266': 'esp8266/Arduino',
    'rp2040:rp2040': 'earlephilhower/arduino-pico',
    'STMicroelectronics:stm32': 'stm32duino/Arduino_Core_STM32',
    'teensy:avr': 'PaulStoffregen/cores',
  };
  return map[`${vendor}:${arch}`] || `${vendor}/${arch}`;
}

/** URL-ы для библиотеки. */
export function libraryUrls(name) {
  const m = mirrors();
  const entry = m.libraries[name];
  const cat = LIBRARY_CATALOG.find((l) => l.name === name);
  const urls = [];
  if (entry?.urls?.length) urls.push(...entry.urls);
  if (cat?.repo && cat?.tag) {
    urls.push(`https://github.com/${cat.repo}/archive/refs/tags/${cat.tag}.zip`);
    urls.push(`https://codeload.github.com/${cat.repo}/zip/refs/tags/${cat.tag}`);
  }
  if (cat?.repo) urls.push(`https://github.com/${cat.repo}/archive/refs/heads/master.zip`);
  return [...new Set(urls.filter(Boolean))];
}

// ------------------------------------------------------------------ склад

/** Что лежит в складе: архивы + уже распакованные наборы. */
export function scanVault() {
  const d = ensureVault();
  const items = [];
  const push = (file, where) => {
    let size = 0;
    try { size = statSync(file).size; } catch { /* ignore */ }
    let info = { kind: 'unknown', entries: 0, detected: null, error: null };
    try {
      const { entries } = listArchive(file);
      info.entries = entries.length;
      info.detected = classifyEntries(entries.map((e) => e.name));
      info.kind = info.detected.type;
    } catch (e) { info.error = e?.message || String(e); }
    items.push({
      file, name: basename(file), where, size, sizeText: fmtSize(size),
      ...info,
    });
  };
  const scanDir = (dir, where, depth = 0) => {
    if (!existsSync(dir) || depth > 2) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) scanDir(full, where, depth + 1);
      else if (archiveKind(full) !== 'unknown') push(full, where);
      else if (/\.(json|txt|properties)$/i.test(e.name)) {
        items.push({ file: full, name: e.name, where, kind: 'meta', size: statSync(full).size, info: e.name });
      }
    }
  };
  scanDir(d.archives, 'архивы');
  scanDir(d.root, 'vault');
  scanDir(d.toolchains, 'тулчейны');
  scanDir(d.libs, 'библиотеки');
  scanDir(d.cores, 'ядра');

  // уже распакованные каталоги
  if (existsSync(d.cores)) for (const name of readdirSync(d.cores)) {
    const p = join(d.cores, name);
    if (statSync(p).isDirectory()) items.push({ name, where: 'ядра', kind: 'core', unpacked: true, file: p, size: dirSize(p), sizeText: fmtSize(dirSize(p)), detected: { type: 'core', name } });
  }
  return { dirs: d, items };
}

/** По оглавлению архива понять, что это: ядро, библиотека или тулчейн. */
export function classifyEntries(names) {
  const has = (re) => names.some((n) => re.test(n));
  if (has(/library\.properties$/i)) return { type: 'library', name: names.find((n) => /library\.properties$/i.test(n))?.split('/').slice(-2, -1)[0] || 'library' };
  if (has(/(^|\/)platform\.txt$/i) && has(/(^|\/)boards\.txt$/i)) return { type: 'core', name: names.find((n) => /platform\.txt$/i.test(n))?.split('/').slice(0, -1).pop() || 'core' };
  if (has(/(^|\/)bin\/[a-z0-9_-]*(g\+\+|gcc|avrdude|esptool|bossac|objcopy)(\.exe)?$/i)) return { type: 'toolchain', name: names.find((n) => /bin\//i.test(n))?.split('/').slice(0, -1).join('/') || 'toolchain' };
  if (has(/(^|\/)package_index\.json$/i)) return { type: 'index', name: 'package_index.json' };
  if (has(/(^|\/)library_index\.json$/i)) return { type: 'index', name: 'library_index.json' };
  return { type: 'unknown', name: 'неизвестный' };
}

function dirSize(dir) {
  let total = 0;
  const walk = (d, depth = 0) => {
    if (depth > 6) return;
    let items = [];
    try { items = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else { try { total += statSync(full).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return total;
}

export const fmtSize = (n) => n > 1024 * 1024 * 1024 ? (n / 1024 / 1024 / 1024).toFixed(1) + ' ГБ'
  : n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' МБ'
    : n > 1024 ? (n / 1024).toFixed(1) + ' КБ' : n + ' Б';

/** Разобрать метаданные архива: имя/версия/архитектура ядра или библиотеки. */
export function inspectItem(file) {
  const tmp = join(ensureVault().staging, 'inspect-' + Date.now().toString(36));
  mkdirSync(tmp, { recursive: true });
  try {
    const { entries } = listArchive(file);
    const det = classifyEntries(entries.map((e) => e.name));
    const out = { type: det.type, entries: entries.length, top: entries.slice(0, 12).map((e) => e.name), size: entries.reduce((a, b) => a + (b.size || 0), 0) };
    if (det.type === 'library' || det.type === 'core') {
      // распаковываем ровно тот кусок, что нужен для чтения свойств
      const need = det.type === 'library' ? /library\.properties$/i : /(platform\.txt|boards\.txt|library\.properties)$/i;
      extractArchive(file, tmp, { stripAuto: true, filter: (rel) => need.test(rel) });
      const props = findFile(tmp, det.type === 'library' ? 'library.properties' : 'platform.txt', 4);
      if (props.length) {
        const txt = readFileSync(props[0], 'utf8');
        for (const line of txt.split(/\r?\n/)) {
          const eq = line.indexOf('=');
          if (eq <= 0) continue;
          const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
          if (['name', 'version', 'author', 'sentence', 'maintainer', 'architectures'].includes(k)) out[k] = v;
        }
      }
      const bp = findFile(tmp, 'boards.txt', 4);
      if (bp.length) {
        const boards = new Set();
        for (const line of readFileSync(bp[0], 'utf8').split(/\r?\n/)) {
          const m = /^([A-Za-z0-9_]+)\.name=(.+)$/.exec(line.trim());
          if (m) boards.add(m[2].trim());
        }
        out.boards = [...boards].slice(0, 40);
        out.arch = guessArchFromDir(dirname(bp[0]));
      }
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function guessArchFromDir(dir) {
  const name = basename(dir);
  if (name === 'avr' || name.includes('avr')) return 'avr';
  return name;
}

// ------------------------------------------------------------------ установка из склада

/**
 * Поставить элемент склада: ядро → .data/packages/<vendor>/hardware/<arch>/<версия>,
 * библиотека → <скетчбук>/libraries/<имя>, тулчейн → .data/vault/toolchains/<имя>.
 * opts: {id: 'arduino:avr', version, type, vendor, arch}
 */
export function importItem(file, opts = {}) {
  if (!existsSync(file)) return { ok: false, error: 'Файл не найден: ' + file };
  const dirs = ensureVault();
  const info = inspectItem(file);
  const type = opts.type || info.type;
  const log = [];
  const tmp = join(dirs.staging, 'unpack-' + Date.now().toString(36));
  mkdirSync(tmp, { recursive: true });
  try {
    if (type === 'core') {
      const id = opts.id || guessPlatformId(info, file);
      const [vendor, arch] = String(id).split(':');
      if (!vendor || !arch) return { ok: false, error: 'Не понять, чья это платформа. Укажите id вида arduino:avr' };
      const version = opts.version || info.version || guessVersion(file) || '0.0.0';
      extractArchive(file, tmp, { stripAuto: true });
      const platformFiles = findFile(tmp, 'platform.txt', 5);
      if (!platformFiles.length) return { ok: false, error: 'В архиве нет platform.txt — это не ядро платформы' };
      const srcDir = dirname(platformFiles[0]);
      const dest = join(DATA_DIR, 'packages', vendor, 'hardware', arch, String(version));
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      copyDir(srcDir, dest);
      registerInstalled({ vendor, arch, version, name: info.name || PLATFORMS.find((p) => p.id === id)?.name || id });
      const boardsN = countBoards(join(dest, 'boards.txt'));
      log.push(`Ядро ${id}@${version} установлено в ${dest} (плат в boards.txt: ${boardsN})`);
      return { ok: true, type, dest, id, version, boards: boardsN, log, info };
    }
    if (type === 'library') {
      extractArchive(file, tmp, { stripAuto: true });
      const props = findFile(tmp, 'library.properties', 5);
      if (!props.length) return { ok: false, error: 'В архиве нет library.properties — это не библиотека Arduino' };
      const libDir = dirname(props[0]);
      const name = opts.name || info.name || basename(libDir);
      const target = join(resolveDirs().user, 'libraries', name);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      copyDir(libDir, target);
      log.push(`Библиотека «${name}» ${info.version || ''} установлена в ${target}`);
      return { ok: true, type, dest: target, name, version: info.version || '', log, info };
    }
    if (type === 'toolchain') {
      const name = opts.name || info.name?.split('/')[0] || basename(file).replace(/\.(tar\.bz2|tar\.gz|zip|tgz)$/i, '');
      const target = join(dirs.toolchains, name);
      extractArchive(file, target, { stripAuto: true });
      chmodBins(target);
      log.push(`Тулчейн «${name}» распакован в ${target}`);
      return { ok: true, type, dest: target, name, log, info };
    }
    return { ok: false, error: 'Не понимаю, что это за архив: ' + JSON.stringify(info.type), info };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function guessPlatformId(info, file) {
  const hay = `${basename(file)} ${info.name || ''} ${info.arch || ''}`.toLowerCase();
  for (const p of PLATFORMS) {
    const [vendor, arch] = p.id.split(':');
    if (hay.includes(arch) && (hay.includes(vendor) || vendor === 'arduino')) return p.id;
  }
  // ищем по названию платы внутри ядра
  if (info.boards?.length) {
    for (const b of info.boards) {
      const found = allBoards().find((x) => x.name.toLowerCase() === String(b).toLowerCase());
      if (found) return found.fqbn.split(':').slice(0, 2).join(':');
    }
  }
  return null;
}

function guessVersion(file) {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(basename(file));
  return m ? m[1] : null;
}

function countBoards(boardsTxt) {
  try {
    const seen = new Set();
    for (const line of readFileSync(boardsTxt, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_]+)\.name=/.exec(line.trim());
      if (m) seen.add(m[1]);
    }
    return seen.size;
  } catch { return 0; }
}

function chmodBins(root) {
  const walk = (d, depth = 0) => {
    if (depth > 4) return;
    let items = [];
    try { items = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === 'bin' || full.includes('/bin/')) { try { chmodSync(full, 0o755); } catch { /* ignore */ } }
    }
  };
  walk(root);
  try { for (const b of readdirSync(join(root, 'bin'))) chmodSync(join(root, 'bin', b), 0o755); } catch { /* ignore */ }
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name), d = join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else {
      copyFileSync(s, d);
      try { const st = statSync(s); if (st.mode & 0o111) chmodSync(d, 0o755); } catch { /* ignore */ }
    }
  }
}

/** Отметить ядро установленным в installed.json (чтобы его видел arduino-cli). */
export function registerInstalled({ vendor, arch, version, name }) {
  const file = join(DATA_DIR, 'packages', 'installed.json');
  let list = [];
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  const entry = {
    name: arch,
    architecture: arch,
    version,
    installed: new Date().toISOString(),
    platforms: [{ name, architecture: arch, version, category: 'Contributed', url: '', archiveFileName: '', checksum: '', size: '0', boards: [], toolsDependencies: [] }],
    tools: [],
    micropide: { vendor, note: 'поставлено из склада MicroPIDE' },
  };
  const i = list.findIndex((x) => x?.architecture === arch && x?.name === arch);
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.push(entry);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(list, null, 2));
  return file;
}

// ------------------------------------------------------------------ свои индексы

/** Пути наших индексов. */
export function indexPaths() {
  const dir = OFFLINE_DIR();
  return { dir, package: join(dir, 'package_index.json'), library: join(dir, 'library_index.json') };
}

/**
 * Записать свои индексы. Локальные архивы, уже лежащие в складе, попадают в
 * индекс с URL file:// и настоящим SHA-256 — arduino-cli поставит их с диска.
 */
export function writeIndexes() {
  const p = indexPaths();
  mkdirSync(p.dir, { recursive: true });
  const overrides = {};
  const localLibraries = [];
  const { items } = scanVault();
  for (const it of items) {
    if (it.kind !== 'core' || !it.file || it.unpacked) continue;
    const id = guessPlatformId({ name: it.name, boards: [] }, it.file);
    if (!id) continue;
    overrides[id] = {
      url: 'file://' + resolve(it.file),
      checksum: sha256File(it.file),
      size: String(it.size || 0),
    };
  }
  for (const it of items) {
    if (it.kind !== 'library' || !it.file || it.unpacked) continue;
    localLibraries.push({
      name: (it.detected?.name || basename(it.file)).replace(/[-_]\d.*$/, ''),
      version: guessVersion(it.file) || '0.0.0',
      sentence: 'Библиотека из склада MicroPIDE',
      repo: '',
      checksum: sha256File(it.file),
      size: String(it.size || 0),
      url: 'file://' + resolve(it.file),
      archs: ['*'],
    });
  }
  const pkg = packageIndex(overrides);
  // локальные пути тоже поправляем на file://
  for (const pack of pkg.packages) for (const pl of pack.platforms) {
    const ov = overrides[`${pack.name === 'MicroPIDE local' ? '' : ''}${pl.architecture}`];
    if (ov) { pl.url = ov.url; pl.checksum = ov.checksum; pl.size = ov.size; }
  }
  writeFileSync(p.package, JSON.stringify(pkg, null, 2));
  const lib = libraryIndex(localLibraries);
  writeFileSync(p.library, JSON.stringify(lib, null, 2));
  return { ...p, platforms: pkg.packages[0].platforms.length, libraries: lib.libraries.length, local: Object.keys(overrides).length };
}

export function sha256File(file) {
  try { return 'SHA-256:' + createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return ''; }
}

/** Дополнительные URL для arduino-cli, чтобы он видел наши индексы. */
export function additionalUrls() {
  const p = indexPaths();
  const extra = mirrors().extraIndexUrls || [];
  const urls = [p.package, ...extra].filter((u) => u && (u.startsWith('file://') || u.startsWith('http')));
  return urls.map((u) => (u.startsWith('file://') ? u : u));
}

// ------------------------------------------------------------------ скачивание

/**
 * Скачать файл в склад с прогрессом и проверкой SHA-256.
 * opts: {name, urls:[...], sha256, onProgress(percent, got, total, url), signal}
 */
export async function downloadToVault({ name, urls = [], sha256 = '', onProgress = () => {}, signal }) {
  const dirs = ensureVault();
  if (NO_NET()) return { ok: false, error: 'Сеть отключена (MICRO_PIDE_NO_NET=1) — работаем только со складом' };
  const target = join(dirs.archives, name || basename(urls[0] || 'download.bin'));
  const errors = [];
  for (const url of urls) {
    if (!url) continue;
    try {
      const r = await fetch(url, { redirect: 'follow', signal });
      if (!r.ok) { errors.push(`${url} → HTTP ${r.status}`); continue; }
      const total = Number(r.headers.get('content-length') || 0);
      const chunks = [];
      let got = 0;
      // потоковое чтение, чтобы показывать прогресс и не держать всё в памяти дважды
      if (r.body?.getReader) {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
          got += value.length;
          onProgress(total ? Math.round((got / total) * 100) : null, got, total, url);
        }
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        chunks.push(buf);
        got = buf.length;
      }
      const buf = Buffer.concat(chunks);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf);
      const hash = 'SHA-256:' + createHash('sha256').update(buf).digest('hex');
      if (sha256 && sha256.replace(/^sha256:/i, 'SHA-256:').toLowerCase() !== hash.toLowerCase()) {
        errors.push(`Контрольная сумма не совпала для ${url}`);
        continue;
      }
      return { ok: true, file: target, size: buf.length, sha256: hash, url };
    } catch (e) {
      errors.push(`${url} → ${e?.message || e}`);
    }
  }
  return { ok: false, error: 'Не удалось скачать ' + (name || '') + ': ' + errors.join('; '), tried: urls };
}

/**
 * «Подготовить автономно»: скачать ядро платформы (и его тулчейны, если
 * известны) и библиотеки в склад, затем пересобрать свои индексы.
 * opts: {platforms:[id], libraries:[name], import:boolean, onLine}
 */
export async function prepare({ platforms = [], libraries = [], import: doImport = false, onLine = () => {}, signal } = {}) {
  const results = [];
  for (const id of platforms) {
    const p = PLATFORMS.find((x) => x.id === id);
    const urls = platformUrls(id);
    const fileName = (p?.url || urls[0] || id).split('/').pop() || `${id.replace(':', '-')}.tar.gz`;
    onLine(`Скачиваю ядро ${id} …`);
    const dl = await downloadToVault({
      name: fileName, urls, signal,
      onProgress: (pct, got, total) => onLine(pct == null ? `  … ${fmtSize(got)}` : `  ${pct}% (${fmtSize(got)} из ${fmtSize(total)})`),
    });
    results.push({ id, kind: 'platform', ...dl });
    if (dl.ok && doImport) {
      const imp = importItem(dl.file, { id, type: 'core' });
      onLine(imp.ok ? `✓ Ядро ${id} установлено` : `✗ ${imp.error}`);
      results[results.length - 1].imported = imp.ok;
    }
    if (dl.ok) {
      // тулчейны платформы (если у нас есть их зеркала)
      for (const t of p?.tools || []) {
        const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
        const asset = t.assets?.[os];
        if (!asset || !t.repo) continue;
        const url = `https://github.com/${t.repo}/releases/download/${t.version}/${asset}`;
        onLine(`Скачиваю инструмент ${t.name} …`);
        const d2 = await downloadToVault({ name: asset, urls: [url], signal, onProgress: (pct, got) => { if (pct != null && pct % 20 === 0) onLine(`  ${pct}%`); } });
        results.push({ id: t.name, kind: 'tool', ...d2 });
        if (d2.ok && doImport) {
          const imp = importItem(d2.file, { type: 'toolchain', name: t.name });
          if (!imp.ok) onLine('⚠ ' + imp.error);
        }
      }
    }
  }
  for (const name of libraries) {
    const urls = libraryUrls(name);
    if (!urls.length) { results.push({ id: name, kind: 'library', ok: false, error: 'Не знаю, откуда качать; добавьте зеркало в настройках склада' }); continue; }
    onLine(`Скачиваю библиотеку ${name} …`);
    const dl = await downloadToVault({ name: `${name.replace(/\s+/g, '_')}.zip`, urls, signal, onProgress: (pct, got) => { if (pct != null && pct % 25 === 0) onLine(`  ${pct}%`); } });
    results.push({ id: name, kind: 'library', ...dl });
    if (dl.ok && doImport) {
      const imp = importItem(dl.file, { type: 'library', name });
      onLine(imp.ok ? `✓ Библиотека ${name} установлена` : `✗ ${imp.error}`);
      results[results.length - 1].imported = imp.ok;
    }
  }
  const idx = writeIndexes();
  onLine(`Индексы обновлены: ${idx.platforms} платформ, ${idx.libraries} библиотек, локальных архивов: ${idx.local}`);
  return { ok: results.every((r) => r.ok), results, indexes: idx };
}

// ------------------------------------------------------------------ инструменты

const BIN_HINTS = {
  'arduino-cli': 'утилита Arduino: компиляция/прошивка чужих платформ',
  'avr-gcc': 'компилятор AVR (Uno, Nano, Mega) — нужен нашему сборщику',
  'avr-g++': 'компилятор AVR (Uno, Nano, Mega) — нужен нашему сборщику',
  avrdude: 'прошивка AVR-плат',
  'arm-none-eabi-gcc': 'компилятор ARM (SAMD, STM32, RP2040, Teensy)',
  'xtensa-esp32-elf-gcc': 'компилятор ESP32',
  'xtensa-lx106-elf-gcc': 'компилятор ESP8266',
  'riscv32-esp-elf-gcc': 'компилятор ESP32-C3/C6',
  esptool: 'прошивка ESP32/ESP8266',
  'esptool.py': 'прошивка ESP32/ESP8266',
  bossac: 'прошивка SAMD (MKR, Zero, Nano 33 IoT)',
  picotool: 'прошивка Raspberry Pi Pico',
  'g++': 'наш симулятор на ПК (своё ядро MicroPIDE)',
  python3: 'нужен для esptool',
  tar: 'распаковка .tar.bz2',
};

function whichSync(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim().split(/\r?\n/)[0] : null;
}

/** Найти бинарь: PATH → склад → каталоги тулчейнов. */
export function findBinary(cmd) {
  const p = whichSync(cmd);
  if (p) return p;
  const roots = [vaultDirs().toolchains, join(DATA_DIR, 'packages'), join(DATA_DIR, 'arduino15', 'packages')].filter((d) => existsSync(d));
  for (const root of roots) {
    const found = searchBin(root, cmd, 5);
    if (found) return found;
  }
  return null;
}

function searchBin(dir, cmd, depth) {
  if (depth < 0) return null;
  let items = [];
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of items) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'bin') {
        const cand = join(full, process.platform === 'win32' ? cmd + '.exe' : cmd);
        if (existsSync(cand)) return cand;
        const cand2 = join(full, cmd);
        if (existsSync(cand2)) return cand2;
      }
      const r = searchBin(full, cmd, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

/** Версия инструмента (если он умеет рассказывать). */
async function versionOf(path, args = ['--version']) {
  if (!path) return null;
  const r = await runCmd(path, args, { timeoutMs: 8_000 });
  const line = (r.out || '').split('\n').map((l) => l.trim()).filter(Boolean)[0];
  return r.code === 0 || line ? (line || '').slice(0, 120) : null;
}

/** Что есть на машине: платформы, компиляторы, прошивальщики, наш симулятор. */
export async function toolsStatus() {
  const out = [];
  const add = (name2, ok, path, version, kind, hint) => out.push({ name: name2, ok, path, version, kind, hint: hint || BIN_HINTS[name2] || '' });
  const cli = await findCli(true);
  add('arduino-cli', cli.ok, cli.path, cli.version, 'cli', BIN_HINTS['arduino-cli']);
  for (const cmd of ['avr-g++', 'avr-gcc', 'arm-none-eabi-g++', 'xtensa-esp32-elf-g++', 'xtensa-lx106-elf-g++', 'riscv32-esp-elf-g++', 'g++', 'avrdude', 'esptool.py', 'esptool', 'bossac', 'picotool', 'python3', 'tar']) {
    const p = findBinary(cmd);
    add(cmd, !!p, p, null, cmd.includes('g++') || cmd.includes('gcc') ? 'compiler' : 'tool');
  }
  // версии компиляторов — параллельно и только для найденных
  await Promise.all(out.filter((t) => t.ok && t.kind === 'compiler').map(async (t) => {
    t.version = await versionOf(t.path, ['--version']);
  }));
  for (const t of out.filter((x) => x.ok && (x.name === 'avrdude' || x.name === 'esptool.py' || x.name === 'python3' || x.name === 'tar'))) {
    t.version = await versionOf(t.path, t.name === 'python3' ? ['--version'] : ['--help']);
  }
  const avr = out.find((t) => t.name === 'avr-g++');
  const sim = out.find((t) => t.name === 'g++');
  return {
    tools: out,
    can: {
      buildAvr: !!(avr?.ok),
      buildArm: !!out.find((t) => t.name === 'arm-none-eabi-g++')?.ok,
      buildEsp: !!(out.find((t) => t.name === 'xtensa-esp32-elf-g++')?.ok || out.find((t) => t.name === 'riscv32-esp-elf-g++')?.ok),
      uploadAvr: !!(out.find((t) => t.name === 'avrdude')?.ok),
      simulate: !!(sim?.ok),
      viaCli: cli.ok,
      unpackBz2: !!(out.find((t) => t.name === 'tar')?.ok),
    },
  };
}

/** Ядро: установлено ли, откуда, есть ли рецепты — для панели «Автономно». */
export function platformsStatus() {
  return PLATFORMS.map((p) => {
    const core = resolveCore(`${p.id}:${allBoards().find((b) => b.fqbn.startsWith(p.id + ':'))?.fqbn.split(':')[2] || ''}`);
    const boards = allBoards().filter((b) => b.fqbn.startsWith(p.id + ':'));
    return {
      id: p.id, name: p.name, version: p.version, arch: p.arch,
      boards: boards.length,
      installed: core.ok ? core.version : null,
      installedAt: core.ok ? core.dir : null,
      source: core.ok ? core.source : null,
      urls: platformUrls(p.id),
      hint: core.ok ? 'Ядро на месте — наш сборщик может собирать эти платы' : 'Ядро не установлено: скачайте в склад (кнопка «Скачать») или положите архив в .data/vault/archives',
    };
  });
}

/** Итог «насколько мы автономны» — для верхней плашки панели. */
export async function autonomyReport() {
  const st = await toolsStatus();
  const plat = platformsStatus();
  const { items } = scanVault();
  const installed = plat.filter((p) => p.installed);
  const vaultByType = items.reduce((acc, i) => { acc[i.kind] = (acc[i.kind] || 0) + 1; return acc; }, {});
  const score = Math.min(100, Math.round(
    (st.can.simulate ? 25 : 0) + (st.can.buildAvr ? 25 : 0) + (installed.length ? 25 : 0) + (items.length ? 15 : 0) + (st.can.uploadAvr ? 10 : 0),
  ));
  return {
    ok: true,
    score,
    level: score >= 80 ? 'полная автономность' : score >= 50 ? 'почти автономно' : score >= 25 ? 'частично' : 'нужен склад',
    can: st.can,
    tools: st.tools,
    platforms: plat,
    installed: installed.map((p) => `${p.id}@${p.installed}`),
    vault: { dir: VAULT_DIR(), items: items.length, byType: vaultByType },
    indexes: indexPaths(),
    config: getConfig(),
    noNet: NO_NET(),
  };
}

export const __test = { sha256File, classifyEntries, searchBin, copyDir, chmodBins };
