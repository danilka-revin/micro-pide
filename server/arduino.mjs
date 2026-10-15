// Обёртка arduino-cli для MicroPIDE: обнаружение, установка, списки плат
// и библиотек, компиляция и прошивка. Всё через spawn — без зависимостей.
// Если arduino-cli не найден, attemptingInstall описывает, как его поставить.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { chmodSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve as resolvePath, sep as pathSep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// каталог данных: env, иначе <repo>/.data (рядом с server/)
export const DATA_DIR = process.env.MICRO_PIDE_DATA || join(HERE, '..', '.data');
const CLI_DIR = join(DATA_DIR, 'bin');
export const CLI_PATH = join(CLI_DIR, process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');

// ---------------------------------------------------------------- каталоги Arduino IDE
//
// Если на машине стоит Arduino IDE, у неё есть свои каталоги:
//   скетчбук:  ~/Arduino (Linux), ~/Documents/Arduino (macOS/Windows)
//   данные:    ~/.arduino15, ~/Library/Arduino15, %LOCALAPPDATA%\Arduino15
// MicroPIDE подхватывает их автоматически: открывает проекты пользователя,
// видит его библиотеки и установленные платформы — ничего не скачивая заново.

/** Типовые каталоги Arduino IDE на этой ОС. */
export function systemArduinoDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const docs = process.platform === 'win32'
    ? join(process.env.USERPROFILE || home, 'Documents')
    : join(home, 'Documents');
  const data = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Arduino15')
    : process.platform === 'darwin'
      ? join(home, 'Library', 'Arduino15')
      : join(home, '.arduino15');
  // на Linux Arduino IDE держит скетчбук прямо в ~/Arduino
  const sketchbook = process.platform === 'linux' ? join(home, 'Arduino') : join(docs, 'Arduino');
  return { data, sketchbook };
}

// ---------------- конфиг (persist .data/config.json) ----------------

function configPath() { return join(DATA_DIR, 'config.json'); }

export function getConfig() {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

export function setConfig(patch) {
  const cur = getConfig();
  const next = { ...cur };
  if ('sketchbook' in patch) next.sketchbook = typeof patch.sketchbook === 'string' && patch.sketchbook.trim() ? patch.sketchbook.trim() : null;
  if ('useSystemArduino' in patch) next.useSystemArduino = patch.useSystemArduino === null ? null : !!patch.useSystemArduino;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}

/**
 * Куда смотреть: скетчбук и данные платформ.
 * Приоритет: config.json → env MICRO_PIDE_SKETCHBOOK (внутренний режим) →
 * папки Arduino IDE (если есть) → внутренние .data.
 */
export function resolveDirs() {
  const cfg = getConfig();
  const sys = systemArduinoDirs();
  const systemFound = existsSync(sys.data) || existsSync(sys.sketchbook);
  let useSystem;
  if (cfg.useSystemArduino === true || cfg.useSystemArduino === false) useSystem = cfg.useSystemArduino;
  else if (process.env.MICRO_PIDE_SYSTEM_ARDUINO !== undefined) useSystem = process.env.MICRO_PIDE_SYSTEM_ARDUINO !== '0';
  else if (process.env.MICRO_PIDE_SKETCHBOOK) useSystem = false;
  else useSystem = systemFound;

  const internal = {
    data: join(DATA_DIR, 'arduino15'),
    downloads: join(DATA_DIR, 'staging'),
    user: process.env.MICRO_PIDE_SKETCHBOOK || join(DATA_DIR, 'sketchbook'),
  };
  const user = cfg.sketchbook || (useSystem ? sys.sketchbook : internal.user);
  return {
    useSystem: useSystem && !cfg.sketchbook,
    systemFound,
    user,               // активный скетчбук (проекты Arduino IDE, если найдены)
    data: useSystem ? sys.data : internal.data,
    downloads: useSystem ? join(sys.data, 'staging') : internal.downloads,
    internal, system: sys,
  };
}

/** Окружение для вызовов arduino-cli: каталоги выбранных директорий. */
export function envForCli(extra = {}) {
  const d = resolveDirs();
  return {
    ...process.env,
    ARDUINO_DIRECTORIES_DATA: d.data,
    ARDUINO_DIRECTORIES_DOWNLOADS: d.downloads,
    ARDUINO_DIRECTORIES_USER: d.user,
    ...extra,
  };
}

let cachedInfo = null;

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (e) {
      resolve({ err: e, stdout: '', stderr: '' });
      return;
    }
    let stdout = '', stderr = '';
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, opts.timeout ?? 60_000);
    p.stdout?.on('data', (d) => { stdout += d; if (stdout.length > 4e6) stdout = stdout.slice(-2e6); });
    p.stderr?.on('data', (d) => { stderr += d; if (stderr.length > 1e6) stderr = stderr.slice(-5e5); });
    p.on('error', (err) => { clearTimeout(to); resolve({ err, stdout, stderr }); });
    p.on('close', (code) => { clearTimeout(to); resolve({ err: code ? new Error('exit ' + code) : null, stdout, stderr, code }); });
  });
}

/** Где лежит arduino-cli: наш bin → PATH → типовые места установки. */
function candidates() {
  const list = [CLI_PATH];
  const extra = process.platform === 'win32'
    ? [join(process.env.LOCALAPPDATA || '', 'Programs', 'arduino-cli', 'arduino-cli.exe'),
       join(process.env.USERPROFILE || '', 'bin', 'arduino-cli.exe')]
    : ['/usr/local/bin/arduino-cli', '/usr/bin/arduino-cli',
       join(process.env.HOME || '', 'bin', 'arduino-cli'),
       join(process.env.HOME || '', '.local', 'bin', 'arduino-cli'),
       '/snap/bin/arduino-cli'];
  for (const e of extra) if (e) list.push(e);
  return list;
}

let resolvedPath = null;
let resolvedVersion = '';

/** Найти работающий arduino-cli и запомнить путь/версию. */
export async function findCli(force = false) {
  if (!force && cachedInfo && Date.now() - cachedInfo.at < 15_000) return cachedInfo.info;
  const dirs = resolveDirs();
  let info = { ok: false, path: null, version: '', error: null, dataDir: dirs.data, sketchbook: dirs.user };
  const paths = resolvedPath ? [resolvedPath, ...candidates()] : candidates();
  for (const p of paths) {
    if (!p || p === 'arduino-cli') continue;
    if (!existsSync(p)) continue;
    const r = await execFileP(p, ['version'], { timeout: 15_000 });
    if (!r.err) {
      const m = /Version:\s*([0-9a-zA-Z.\-]+)/.exec(r.stdout);
      resolvedPath = p;
      resolvedVersion = m ? m[1] : (r.stdout.trim().split('\n')[0] || '');
      info = { ok: true, path: p, version: resolvedVersion, error: null, dataDir: dirs.data, sketchbook: dirs.user };
      cachedInfo = { at: Date.now(), info };
      return info;
    }
  }
  // последний шанс: «arduino-cli» из PATH без полного пути
  const r = await execFileP('arduino-cli', ['version'], { timeout: 15_000 });
  if (!r.err) {
    const m = /Version:\s*([0-9a-zA-Z.\-]+)/.exec(r.stdout);
    resolvedPath = 'arduino-cli';
    resolvedVersion = m ? m[1] : '';
    info = { ok: true, path: 'arduino-cli', version: resolvedVersion, error: null, dataDir: dirs.data, sketchbook: dirs.user };
  } else {
    info.error = 'arduino-cli не найден. Установите его кнопкой «Установить» или сами: arduino.cc/en/software';
  }
  cachedInfo = { at: Date.now(), info };
  return info;
}

/** Запуск команды arduino-cli, накопление вывода, код выхода. */
export async function runCli(args, opts = {}) {
  const info = await findCli();
  if (!info.ok) return { err: new Error(info.error || 'arduino-cli не найден'), stdout: '', stderr: '', code: -1 };
  // каталоги cli указывают на активные директории (в т.ч. папки Arduino IDE):
  // компиляция видит библиотеки и платы пользователя
  return execFileP(info.path, args, { ...opts, env: envForCli() });
}

/** Потоковый запуск (для компиляции/прошивки): строки вывода уходят в onLine. */
export function streamCli(args, onLine, signal) {
  return new Promise((resolve) => {
    findCli().then((info) => {
      if (!info.ok) { resolve({ code: -1, err: new Error(info.error || 'arduino-cli не найден') }); return; }
      let p;
      try {
        p = spawn(info.path, args, { windowsHide: true, env: envForCli() });
      } catch (e) { resolve({ code: -1, err: e }); return; }
      let buf = '';
      const pump = (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line) onLine(line);
        }
      };
      p.stdout.on('data', pump);
      p.stderr.on('data', pump);
      let killed = false;
      const onAbort = () => { killed = true; try { p.kill('SIGKILL'); } catch {} };
      signal?.addEventListener('abort', onAbort, { once: true });
      p.on('error', (e) => { signal?.removeEventListener('abort', onAbort); resolve({ code: -1, err: e }); });
      p.on('close', (code) => {
        if (buf.trim()) onLine(buf.trim());
        signal?.removeEventListener('abort', onAbort);
        resolve({ code: code ?? -1, err: killed ? new Error('Отменено') : (code ? new Error('код ' + code) : null) });
      });
    });
  });
}

// ---------------------------------------------------------------- установка cli

const ASSET_BY_PLATFORM = {
  'linux-x64': 'Linux_64bit.tar.gz',
  'linux-arm64': 'Linux_ARM64.tar.gz',
  'linux-arm': 'Linux_ARMv7.tar.gz',
  'darwin-x64': 'macOS_64bit.tar.gz',
  'darwin-arm64': 'macOS_ARM64.tar.gz',
  'win32-x64': 'Windows_64bit.zip',
};

/** Установить arduino-cli в .data/bin: последний релиз с GitHub API + tar/узел. */
export async function installCli(onLine) {
  const key = `${process.platform}-${process.arch}`;
  const suffix = ASSET_BY_PLATFORM[key];
  if (!suffix) throw new Error(`Автоустановка не умеет платформу ${key}: поставьте arduino-cli вручную (arduino.cc)`);
  onLine?.(`Ищу последний релиз arduino-cli для ${key}…`);
  const resp = await fetch('https://api.github.com/repos/arduino/arduino-cli/releases/latest', {
    headers: { 'User-Agent': 'micro-pide' },
  });
  if (!resp.ok) throw new Error(`GitHub API: ${resp.status}`);
  const rel = await resp.json();
  const asset = (rel.assets || []).find((a) => a.name?.includes(suffix));
  if (!asset) throw new Error(`В релизе ${rel.tag_name} нет файла *${suffix}`);
  onLine?.(`Скачиваю ${asset.name} (${Math.round(asset.size / 1024)} КБ)…`);
  mkdirSync(CLI_DIR, { recursive: true });
  const tmp = join(CLI_DIR, 'dl');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const dl = await fetch(asset.browser_download_url);
  if (!dl.ok || !dl.body) throw new Error(`Скачивание не удалось: ${dl.status}`);
  const archive = join(tmp, asset.name);
  await pipeline(dl.body, createWriteStream(archive));
  onLine?.('Распаковываю…');
  if (archive.endsWith('.zip')) {
    // без внешнего unzip: узловой detar не нужен, но для zip пригодится powershell/unzip
    if (process.platform === 'win32') {
      const r = await execFileP('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${tmp}" -Force`], { timeout: 120_000 });
      if (r.err) throw new Error('Распаковка zip не удалась: ' + (r.stderr || r.err.message));
    } else {
      const r = await execFileP('unzip', ['-o', archive, '-d', tmp], { timeout: 120_000 });
      if (r.err) throw new Error('Распаковка zip не удалась (нет unzip?): ' + (r.stderr || r.err.message));
    }
  } else {
    const r = await execFileP('tar', ['-xzf', archive, '-C', tmp], { timeout: 120_000 });
    if (r.err) throw new Error('Распаковка tar не удалась: ' + (r.stderr || r.err.message));
  }
  // ищем бинарник в распакованном
  let binPath = '';
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === 'arduino-cli' || name === 'arduino-cli.exe') { binPath = p; return; }
      try { if (readdirSync(p)) walk(p); if (binPath) return; } catch { /* файл */ }
    }
  };
  walk(tmp);
  if (!binPath) throw new Error('В архиве не нашёлся arduino-cli');
  const { renameSync } = await import('node:fs');
  rmSync(CLI_PATH, { force: true });
  renameSync(binPath, CLI_PATH);
  try { chmodSync(CLI_PATH, 0o755); } catch { /* windows */ }
  rmSync(tmp, { recursive: true, force: true });
  cachedInfo = null;
  const info = await findCli(true);
  onLine?.(info.ok ? `arduino-cli ${info.version} установлен.` : 'Установка завершилась, но cli не запускается.');
  if (!info.ok) throw new Error(info.error || 'не запускается');
  return info;
}

// ---------------------------------------------------------------- списки

/**
 * Платформы из каталога данных Arduino IDE (Arduino15/packages) — читаем
 * boards.txt/platform.txt. Работает БЕЗ arduino-cli: видно платы, установленные
 * через Arduino IDE, и их FQBN.
 */
export function scanCoresFromData() {
  const d = resolveDirs();
  const out = [];
  const pkgRoot = join(d.data, 'packages');
  let pkgs = [];
  try { pkgs = readdirSync(pkgRoot, { withFileTypes: true }); } catch { return out; }
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue;
    const hw = join(pkgRoot, pkg.name, 'hardware');
    let archs = [];
    try { archs = readdirSync(hw, { withFileTypes: true }); } catch { continue; }
    for (const arch of archs) {
      if (!arch.isDirectory()) continue;
      let vers = [];
      try { vers = readdirSync(join(hw, arch.name), { withFileTypes: true }); } catch { continue; }
      for (const ver of vers) {
        if (!ver.isDirectory()) continue;
        const vdir = join(hw, arch.name, ver.name);
        let boardsTxt = '';
        try { boardsTxt = readFileSync(join(vdir, 'boards.txt'), 'utf8'); } catch { continue; }
        let platName = `${pkg.name} ${arch.name}`;
        try {
          const pt = readFileSync(join(vdir, 'platform.txt'), 'utf8');
          const m = /^name=(.+)$/m.exec(pt);
          if (m) platName = m[1].trim();
        } catch { /* без platform.txt — синтетическое имя */ }
        const seen = new Map();
        for (const line of boardsTxt.split('\n')) {
          const m = /^([\w.+-]+)\.name=(.+)$/.exec(line.trim());
          if (m && !seen.has(m[1])) seen.set(m[1], m[2].trim());
        }
        const boards = [...seen.entries()].map(([key, name]) => ({ name, fqbn: `${pkg.name}:${arch.name}:${key}` }));
        if (boards.length) {
          out.push({ id: `${pkg.name}:${arch.name}`, name: platName, version: ver.name, boards, source: 'system' });
        }
        break; // достаточно последней установленной версии платформы
      }
    }
  }
  return out;
}

/** Библиотеки из скетчбука (папка libraries/, куда ставит их Arduino IDE). */
export function scanSketchbookLibs() {
  const d = resolveDirs();
  const base = join(d.user, 'libraries');
  const out = [];
  let entries = [];
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(base, e.name);
    let props = '';
    try { props = readFileSync(join(dir, 'library.properties'), 'utf8'); } catch { /* без свойств — только имя */ }
    const kv = {};
    for (const line of props.split('\n')) {
      const m = /^([\w.]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m) kv[m[1].toLowerCase()] = m[2].trim();
    }
    out.push({
      name: kv.name || e.name,
      version: kv.version || '',
      author: kv.author || '',
      sentence: kv.sentence || '',
      category: kv.category || '',
      source: 'ide',
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Список портов и подключённых плат. */
export async function listPorts() {
  const r = await runCli(['board', 'list', '--format', 'json'], { timeout: 30_000 });
  if (r.err) return { err: String(r.stderr || r.err.message || 'ошибка'), ports: [] };
  const j = parseJson(r.stdout);
  const ports = (j || []).map((p) => {
    // matching_boards — что cli распознал на этом порту (для автовыбора)
    const mb = p.matching_boards || p.matchingBoards || [];
    const first = Array.isArray(mb) ? mb[0] : null;
    return {
      address: p.address || p.port?.address || '',
      protocol: p.protocol || p.port?.protocol || 'serial',
      boardName: p.board_name || p.board?.name || first?.name || '',
      fqbn: p.fqbn || p.board?.fqbn || first?.fqbn || '',
    };
  });
  return { ports, err: null };
}

/** Установленные платформы (ядра): cli, а без него — скан каталогов Arduino IDE. */
export async function listCores() {
  const r = await runCli(['core', 'list', '--format', 'json'], { timeout: 30_000 });
  if (!r.err) {
    const j = parseJson(r.stdout) || [];
    const cores = j.map((c) => ({
      id: c.ID || c.id || '',
      name: c.Name || c.name || '',
      version: c.Installed ? String(c.Installed) : (c.installed || ''),
      latest: c.Latest ? String(c.Latest) : (c.latest || ''),
      boards: (c.Boards || c.boards || []).map((b) => ({ name: b.Name || b.name || '', fqbn: b.FQBN || b.fqbn || '' })),
      source: 'cli',
    }));
    if (cores.length) return { cores, err: null, via: 'cli' };
  }
  const scanned = scanCoresFromData();
  return { cores: scanned, err: null, via: scanned.length ? 'scan' : 'none' };
}

/** Все платы для выбора: cli (listall) + платы из каталогов Arduino IDE. */
export async function listAllBoards() {
  const boards = [];
  const seen = new Set();
  const r = await runCli(['board', 'listall', '--format', 'json'], { timeout: 60_000 });
  if (!r.err) {
    const j = parseJson(r.stdout) || [];
    for (const b of (j.boards || j || [])) {
      const fqbn = b.FQBN || b.fqbn || '';
      if (!fqbn || seen.has(fqbn)) continue;
      seen.add(fqbn);
      boards.push({ name: b.Name || b.name || '', fqbn });
    }
  }
  for (const core of scanCoresFromData()) {
    for (const b of core.boards) {
      if (seen.has(b.fqbn)) continue;
      seen.add(b.fqbn);
      boards.push(b);
    }
  }
  return { boards, err: boards.length ? null : 'Платы не найдены: установите платформу' };
}

/** Поиск платформ в индексе (менеджер плат). */
export async function searchCores(q) {
  const args = ['core', 'search', '--format', 'json'];
  if (q) args.push(String(q));
  const r = await runCli(args, { timeout: 90_000 });
  if (r.err) return { err: String(r.stderr || r.err.message || 'ошибка'), cores: [] };
  const j = parseJson(r.stdout) || [];
  const cores = j.map((c) => ({
    id: c.ID || c.id || '',
    name: c.Name || c.name || '',
    latest: c.Latest ? String(c.Latest) : (c.latest || ''),
    installed: c.Installed ? String(c.Installed) : (c.installed || ''),
    boards: (c.Boards || c.boards || []).map((b) => b.Name || b.name || '').slice(0, 6),
  }));
  return { cores, err: null };
}

export async function installCore(id, onLine) {
  if (!id) throw new Error('Не указана платформа');
  const r = await streamCli(['core', 'install', '--format', 'text', String(id)], onLine);
  if (r.code !== 0 && !/already installed/i.test('')) {
    throw new Error(r.err?.message || 'установка не удалась');
  }
}

export async function uninstallCore(id) {
  const r = await runCli(['core', 'uninstall', String(id)], { timeout: 120_000 });
  if (r.err) throw new Error(String(r.stderr || r.err.message || 'ошибка удаления'));
}

// ---------------------------------------------------------------- библиотеки

/**
 * Установленные библиотеки: от cli и из папки libraries/ скетчбука (куда их
 * ставит Arduino IDE). Объединяем без дублей; библиотеки из скетчбука
 * помечены source: 'ide' — их не удаляет cli-удаление.
 */
export async function listLibs() {
  const ideLibs = scanSketchbookLibs();
  const byName = new Map();
  for (const l of ideLibs) byName.set(l.name.toLowerCase(), { ...l });
  const r = await runCli(['lib', 'list', '--format', 'json'], { timeout: 30_000 });
  let cliErr = null;
  if (r.err) {
    cliErr = String(r.stderr || r.err.message || 'ошибка');
  } else {
    const j = parseJson(r.stdout) || [];
    for (const l of j) {
      const item = {
        name: l.library?.name || l.name || '',
        version: l.library?.version || l.version || '',
        author: l.library?.author || '',
        sentence: l.library?.sentence || '',
        category: l.library?.category || '',
        source: 'cli',
      };
      const prev = byName.get(item.name.toLowerCase());
      if (!prev) byName.set(item.name.toLowerCase(), item);
      else {
        // библиотека есть и в скетчбуке, и в реестре cli — объединяем, метка 'ide'
        byName.set(item.name.toLowerCase(), {
          ...prev,
          version: prev.version || item.version,
          author: prev.author || item.author,
          sentence: prev.sentence || item.sentence,
          category: prev.category || item.category,
        });
      }
    }
  }
  const libs = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { libs, err: libs.length ? null : cliErr };
}

export async function searchLibs(q) {
  const r = await runCli(['lib', 'search', '--format', 'json', ...(q ? [String(q)] : [])], { timeout: 90_000 });
  if (r.err) return { err: String(r.stderr || r.err.message || 'ошибка'), libs: [] };
  const j = parseJson(r.stdout) || [];
  const libs = (j.libraries || j || []).slice(0, 40).map((l) => ({
    name: l.name || '',
    version: l.latest?.version || l.version || '',
    author: l.latest?.author || '',
    sentence: l.latest?.sentence || '',
    releases: Object.keys(l.releases || {}).length || 0,
  }));
  return { libs, err: null };
}

export async function installLib(name, onLine) {
  if (!name) throw new Error('Не указана библиотека');
  const r = await streamCli(['lib', 'install', '--format', 'text', String(name)], onLine);
  if (r.code !== 0) throw new Error(r.err?.message || 'установка не удалась');
}

export async function uninstallLib(name) {
  const r = await runCli(['lib', 'uninstall', String(name)], { timeout: 60_000 });
  if (r.err) throw new Error(String(r.stderr || r.err.message || 'ошибка удаления'));
}

/** Список примеров из установленных ядер и библиотек. */
export async function listExamples() {
  const r = await runCli(['lib', 'examples', '--format', 'json'], { timeout: 60_000 });
  if (r.err) return { err: String(r.stderr || r.err.message || 'ошибка'), groups: [] };
  const j = parseJson(r.stdout) || [];
  const pick = (n) => ({
    name: n.name || '',
    path: n.path || '',
    sketches: (n.sketches || []).map((s) => ({ name: s.name || s.sketch || '', path: s.path || '' })),
  });
  const groups = (j.libraries || j || []).map((l) => ({
    name: l.name || l.library || '',
    examples: (l.examples || []).map(pick),
  })).filter((g) => g.examples.length);
  return { groups, err: null };
}
