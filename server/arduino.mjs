// Обёртка arduino-cli для MicroPIDE: обнаружение, установка, списки плат
// и библиотек, компиляция и прошивка. Всё через spawn — без зависимостей.
// Если arduino-cli не найден, attemptingInstall описывает, как его поставить.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { chmodSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// каталог данных: env, иначе <repo>/.data (рядом с server/)
export const DATA_DIR = process.env.MICRO_PIDE_DATA || join(HERE, '..', '.data');
export const SKETCHBOOK_DIR = process.env.MICRO_PIDE_SKETCHBOOK || join(DATA_DIR, 'sketchbook');
const CLI_DIR = join(DATA_DIR, 'bin');
export const CLI_PATH = join(CLI_DIR, process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');

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
  let info = { ok: false, path: null, version: '', error: null, dataDir: DATA_DIR, sketchbook: SKETCHBOOK_DIR };
  const paths = resolvedPath ? [resolvedPath, ...candidates()] : candidates();
  for (const p of paths) {
    if (!p || p === 'arduino-cli') continue;
    if (!existsSync(p)) continue;
    const r = await execFileP(p, ['version'], { timeout: 15_000 });
    if (!r.err) {
      const m = /Version:\s*([0-9a-zA-Z.\-]+)/.exec(r.stdout);
      resolvedPath = p;
      resolvedVersion = m ? m[1] : (r.stdout.trim().split('\n')[0] || '');
      info = { ok: true, path: p, version: resolvedVersion, error: null, dataDir: DATA_DIR, sketchbook: SKETCHBOOK_DIR };
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
    info = { ok: true, path: 'arduino-cli', version: resolvedVersion, error: null, dataDir: DATA_DIR, sketchbook: SKETCHBOOK_DIR };
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
  const env = { ...process.env };
  // каталоги данных cli: платы/библиотеки ставим внутрь .data, чтобы не трогать систему
  env.ARDUINO_DIRECTORIES_DATA = join(DATA_DIR, 'arduino15');
  env.ARDUINO_DIRECTORIES_DOWNLOADS = join(DATA_DIR, 'staging');
  env.ARDUINO_DIRECTORIES_USER = SKETCHBOOK_DIR;
  return execFileP(info.path, args, { ...opts, env });
}

/** Потоковый запуск (для компиляции/прошивки): строки вывода уходят в onLine. */
export function streamCli(args, onLine, signal) {
  return new Promise((resolve) => {
    findCli().then((info) => {
      if (!info.ok) { resolve({ code: -1, err: new Error(info.error || 'arduino-cli не найден') }); return; }
      const env = { ...process.env };
      env.ARDUINO_DIRECTORIES_DATA = join(DATA_DIR, 'arduino15');
      env.ARDUINO_DIRECTORIES_DOWNLOADS = join(DATA_DIR, 'staging');
      env.ARDUINO_DIRECTORIES_USER = SKETCHBOOK_DIR;
      let p;
      try {
        p = spawn(info.path, args, { windowsHide: true, env });
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

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Список портов и подключённых плат. */
export async function listPorts() {
  const r = await runCli(['board', 'list', '--format', 'json'], { timeout: 30_000 });
  if (r.err) return { err: String(r.stderr || r.err.message || 'ошибка'), ports: [] };
  const j = parseJson(r.stdout);
  const ports = (j || []).map((p) => ({
    address: p.address || p.port?.address || '',
    protocol: p.protocol || p.port?.protocol || 'serial',
    boardName: p.board_name || p.board?.name || '',
    fqbn: p.fqbn || p.board?.fqbn || '',
  }));
  return { ports, err: null };
}

/** Установленные платформы (ядра). */
export async function listCores() {
  const r = await runCli(['core', 'list', '--format', 'json'], { timeout: 30_000 });
  if (r.err) return { err: String(r.stderr || r.err.message || 'ошибка'), cores: [] };
  const j = parseJson(r.stdout) || [];
  const cores = j.map((c) => ({
    id: c.ID || c.id || '',
    name: c.Name || c.name || '',
    version: c.Installed ? String(c.Installed) : (c.installed || ''),
    latest: c.Latest ? String(c.Latest) : (c.latest || ''),
    boards: (c.Boards || c.boards || []).map((b) => ({ name: b.Name || b.name || '', fqbn: b.FQBN || b.fqbn || '' })),
  }));
  return { cores, err: null };
}

/** Все платы, доступные для выбора (из установленных ядер). */
export async function listAllBoards() {
  const r = await runCli(['board', 'listall', '--format', 'json'], { timeout: 60_000 });
  if (r.err) return { err: String(r.stderr || r.err.message || 'ошибка'), boards: [] };
  const j = parseJson(r.stdout) || [];
  const boards = (j.boards || j || []).map((b) => ({
    name: b.Name || b.name || '',
    fqbn: b.FQBN || b.fqbn || '',
  }));
  return { boards, err: null };
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

export async function listLibs() {
  const r = await runCli(['lib', 'list', '--format', 'json'], { timeout: 30_000 });
  if (r.err) return { err: String(r.stderr || r.err.message || 'ошибка'), libs: [] };
  const j = parseJson(r.stdout) || [];
  const libs = j.map((l) => ({
    name: l.library?.name || l.name || '',
    version: l.library?.version || l.version || '',
    author: l.library?.author || '',
    sentence: l.library?.sentence || '',
    category: l.library?.category || '',
  }));
  return { libs, err: null };
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
