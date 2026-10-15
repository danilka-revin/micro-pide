// Собственный сборщик MicroPIDE — «всё своё», без arduino-cli и без серверов.
//
// Что делает:
//   1. Препроцессит скетч как Arduino IDE: главный .ino, остальные вкладки по
//      алфавиту, склейка в один .cpp, вынос #include наверх, генерация
//      прототипов функций, директивы #line, чтобы ошибки компилятора
//      указывали на исходные файлы и строки.
//   2. Читает platform.txt / boards.txt ядра и собирает по его же рецептам
//      (recipe.cpp.o.pattern и т.д.) — то есть компилирует любую платформу,
//      у которой есть тулчейн, даже если arduino-cli недоступен.
//   3. Ищет тулчейн в своих каталогах: .data/packages, склад vault, системный
//      ~/.arduino15, PATH.
//   4. Собирает (compile → ar → link → objcopy), считает размеры флеша и ОЗУ.
//   5. Прошивает по рецепту платформы (avrdude/esptool/…), а без тулчейна
//      ядра — своей командой из встроенной базы плат (boarddb.mjs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative, extname, sep } from 'node:path';
import { findBoard, BOARDS } from './boarddb.mjs';
import { resolveDirs, DATA_DIR } from './arduino.mjs';
import { maskCode, generatePrototypes, findIncludes, braceBalance, findFunctions } from './cpp.mjs';

// ---------------------------------------------------------------- утилиты

/** Разбор properties-файла (platform.txt / boards.txt) в массив пар. */
export function parseProps(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return out;
}

/** Пары → Map (последнее значение важнее, как в Arduino). */
export function propsMap(pairs) {
  const m = new Map();
  for (const [k, v] of pairs) m.set(k, v);
  return m;
}

/**
 * Раскрытие {переменных} как в Arduino: много проходов, вложенные ссылки,
 * неизвестные плейсхолдеры остаются на месте (их потом видно в логе).
 */
export function expandVars(str, vars, depth = 0) {
  if (depth > 12 || typeof str !== 'string' || !str.includes('{')) return str;
  let changed = false;
  const out = str.replace(/\{([^{}]+)\}/g, (all, key) => {
    const k = key.trim();
    if (vars.has(k)) { changed = true; return String(vars.get(k)); }
    return all;
  });
  return changed ? expandVars(out, vars, depth + 1) : out;
}

/**
 * Раскрыть рецепт и выбросить нераскрытые {плейсхолдеры}: у чужого ядра их
 * всегда хватает (build.usb_flags, runtime.tools.* и т.п.), а компилятору
 * такое «слово» отдавать нельзя.
 */
export function expandPattern(str, vars) {
  const out = expandVars(str, vars).replace(/\{[^{}\s]*\}/g, ' ');
  // выброшенные плейсхолдеры оставляют лишние пробелы — сжимаем их вне кавычек
  let res = '';
  let inQuotes = false;
  for (const c of out) {
    if (c === '"') { inQuotes = !inQuotes; res += c; continue; }
    if (!inQuotes && c === ' ' && res.endsWith(' ')) continue;
    res += c;
  }
  return res;
}

/** Добавить в vars значения по умолчанию, не перетирая уже заданные. */
function setDefault(vars, k, v) {
  if (!vars.has(k) || vars.get(k) === '') vars.set(k, v);
}

const relPosix = (base, p) => relative(base, p).split(sep).join('/');

function walk(dir, extList, out = [], depth = 0) {
  if (depth > 12 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'examples' || e.name.startsWith('.')) continue;
      walk(full, extList, out, depth + 1);
    } else if (extList.includes(extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** Запуск процесса с потоковым выводом; поддержка отмены. */
export function runCmd(cmd, args, { cwd, env, onLine, signal, input, timeoutMs } = {}) {
  return new Promise((res_) => {
    let p;
    const resolveEnd = (r) => res_(r);
    try {
      p = spawn(cmd, args, { cwd, env: env || process.env, windowsHide: true });
    } catch (e) {
      resolveEnd({ code: -1, err: e, out: '' });
      return;
    }
    let out = '';
    let done = false;
    const kill = () => { if (!done) { try { p.kill('SIGKILL'); } catch { /* ignore */ } } };
    const to = timeoutMs ? setTimeout(kill, timeoutMs) : null;
    signal?.addEventListener('abort', kill, { once: true });
    const pump = (d) => {
      const s = d.toString('utf8');
      out += s;
      if (out.length > 8e6) out = out.slice(-4e6);
      if (onLine) for (const line of s.split(/\r?\n/)) if (line.trim()) onLine(line);
    };
    p.stdout?.on('data', pump);
    p.stderr?.on('data', pump);
    if (input !== undefined) { try { p.stdin.write(input); p.stdin.end(); } catch { /* ignore */ } }
    p.on('error', (e) => { done = true; if (to) clearTimeout(to); resolveEnd({ code: -1, err: e, out }); });
    p.on('close', (code) => {
      done = true;
      if (to) clearTimeout(to);
      signal?.removeEventListener('abort', kill);
      resolveEnd({ code: code ?? -1, err: code ? new Error('код выхода ' + code) : null, out });
    });
  });
}

async function which(cmd) {
  const r = await runCmd(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeoutMs: 5_000 });
  return r.code === 0 ? r.out.trim().split(/\r?\n/)[0] : null;
}

// ---------------------------------------------------------------- препроцессор скетча

/**
 * Скетч (набор файлов) → единый C++-файл, как это делает Arduino IDE.
 * Возвращает {cpp, name, includes, prototypes, diagnostics, skipped}.
 */
export function preprocessSketch(filesIn, { name = '', addArduinoHeader = true } = {}) {
  const files = (filesIn || [])
    .map((f) => ({ path: String(f.path || '').replace(/\\/g, '/'), content: String(f.content ?? '') }))
    .filter((f) => f.path && !/^\./.test(f.path));
  const diagnostics = [];
  if (!files.length) return { cpp: '', name, includes: [], prototypes: [], diagnostics: [{ level: 'error', text: 'В скетче нет файлов' }], skipped: [] };

  const ino = files.filter((f) => /\.ino$/i.test(f.path));
  const other = files.filter((f) => !/\.ino$/i.test(f.path));
  if (!ino.length) diagnostics.push({ level: 'warn', text: 'Нет ни одного .ino — собираю только .cpp/.c файлы' });

  // Порядок Arduino: главный .ino (совпадает с именем скетча), затем остальные
  // .ino по алфавиту; прочие единицы трансляции компилируются отдельно.
  const wanted = (name || '').replace(/^.*\//, '');
  const main = ino.find((f) => f.path.replace(/^.*\//, '').replace(/\.ino$/i, '').toLowerCase() === wanted.toLowerCase()) || ino[0];
  const rest = ino.filter((f) => f !== main).sort((a, b) => a.path.localeCompare(b.path));
  const ordered = main ? [main, ...rest] : rest;

  // 1) вынимаем #include из всех файлов, ставим их в начало
  const includeLines = [];
  const seenInc = new Set();
  const bodies = [];
  for (const f of ordered) {
    const incs = findIncludes(f.content);
    for (const inc of incs) {
      const key = (inc.system ? '<' : '"') + inc.file + (inc.system ? '>' : '"');
      if (seenInc.has(key)) continue;
      seenInc.add(key);
      includeLines.push(inc.text.trim());
    }
    const body = f.content.split('\n').filter((l) => !/^\s*#\s*include/.test(l)).join('\n');
    bodies.push({ path: f.path, body });
  }

  // 2) склейка тела с #line — ошибки компилятора будут ссылаться на исходники.
  // Заодно помним, где начинается тело каждого файла: туда мы вставим прототипы.
  const cap = (s) => String(s).replace(/"/g, '\\"');
  let united = '';
  for (const b of bodies) {
    const marker = `#line 1 "${cap(b.path)}"\n`;
    united += marker;
    b.start = united.length;            // начало тела файла внутри united
    united += b.body.replace(/\s*$/, '') + '\n';
  }

  /** Файл и строка оригинала для смещения внутри united (для #line после вставки). */
  const originAt = (offset) => {
    let pick = bodies[0];
    for (const b of bodies) if (b.start <= offset) pick = b;
    if (!pick) return { file: '', line: 1 };
    const line = united.slice(pick.start, offset).split('\n').length;
    return { file: pick.path, line };
  };

  // 3) проверки целостности
  const bal = braceBalance(united);
  if (bal.balance !== 0) {
    const at = bal.badLine ? ` (строка ${bal.badLine})` : '';
    diagnostics.push({
      level: bal.balance > 0 ? 'error' : 'warn',
      text: bal.balance > 0 ? `Не закрыто фигурных скобок: ${bal.balance}${at}` : `Лишних закрывающих скобок: ${-bal.balance}${at}`,
    });
  }

  // 4) прототипы функций верхнего уровня (Arduino IDE делает то же самое — только мы сами).
  // Важное отличие от Arduino IDE: прототипы вставляем не в самое начало, а перед
  // первой функцией, уже после enum/struct/class/typedef и глобальных переменных.
  // Иначе прототип вида `void enter(State s);` ломается: тип State ещё не объявлен.
  const allFns = findFunctions(united);
  const protoList = generatePrototypes(allFns).map((p) => ({ ...p, text: String(p.text).replace(/#line\s+\d+\s+"[^"]*"\s*/g, '') }));
  const prototypes = protoList.map((p) => p.text);
  const firstDef = allFns.filter((f) => f.hasBody).sort((a, b) => a.index - b.index)[0];
  // вставляем с начала строки первой функции, иначе разорвём объявление
  const rawAt = firstDef ? firstDef.index : 0;
  const insertAt = rawAt > 0 ? united.lastIndexOf('\n', rawAt - 1) + 1 : 0;
  const at = originAt(insertAt);
  const protoBlock = prototypes.length
    ? `\n// --- прототипы функций (сгенерировано MicroPIDE) ---\n${prototypes.join('\n')}\n#line ${at.line} "${cap(at.file)}"\n`
    : '';

  const header = [];
  if (addArduinoHeader && !includeLines.some((l) => /Arduino\.h/i.test(l))) header.push('#include <Arduino.h>');
  header.push(...includeLines);

  const cpp = [
    '// Сгенерировано MicroPIDE (свой сборщик). Не редактируйте: файл пересобирается каждый раз.',
    `// Скетч: ${name || main?.path || 'Sketch'} · вкладок: ${ordered.length}`,
    header.join('\n'),
    protoBlock ? united.slice(0, insertAt) + protoBlock + united.slice(insertAt) : united,
  ].filter((s) => s !== undefined).join('\n');

  // Прочие файлы (.cpp/.c) в скетче — отдельные единицы трансляции
  const extraSources = other.filter((f) => /\.(cpp|cc|cxx|c|S|s)$/i.test(f.path));

  return { cpp, name, includes: includeLines, prototypes, prototypeList: protoList, diagnostics, order: ordered.map((f) => f.path), extraSources };
}

// ---------------------------------------------------------------- ядро и платформа

/** Где искать установленные ядра: свои каталоги, системный Arduino15, скетчбук. */
export function coreSearchRoots() {
  const d = resolveDirs();
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const roots = [
    join(DATA_DIR, 'packages'),
    join(DATA_DIR, 'arduino15', 'packages'),
    join(d.data || '', 'packages'),
    join(home, '.arduino15', 'packages'),
    join(home, 'Library', 'Arduino15', 'packages'),
    join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Arduino15', 'packages'),
    join(d.user || '', 'hardware'),
    join(DATA_DIR, 'vault', 'cores'),
    join(DATA_DIR, 'hardware'),
  ];
  return [...new Set(roots.filter(Boolean))].filter((p) => existsSync(p));
}

/**
 * Поставщики ядер: модуль может уметь «развернуть» ядро на месте (так делает
 * встроенный симулятор native.mjs). Регистрируемся функцией, чтобы не было
 * циклических импортов: buildcore ничего не знает о native.
 */
const CORE_PROVIDERS = [];
export function registerCoreProvider(fn) {
  if (typeof fn === 'function' && !CORE_PROVIDERS.includes(fn)) CORE_PROVIDERS.push(fn);
}

/**
 * Найти каталог ядра для FQBN. Возвращает
 * {ok, dir, version, vendor, arch, source, roots} либо {ok:false, error, tried}.
 */
export function resolveCore(fqbn) {
  const board = findBoard(fqbn);
  const [vendor, arch] = String(fqbn || '').split(':');
  if (!vendor || !arch) return { ok: false, error: 'Некорректный FQBN: ' + fqbn, tried: [] };
  const roots = coreSearchRoots();
  const tried = [];
  const found = [];
  for (const root of roots) {
    const base = join(root, vendor, 'hardware', arch);
    tried.push(base);
    if (!existsSync(base)) continue;
    // версии: подкаталог с platform.txt
    const entries = readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      const dir = join(base, e.name);
      if (!e.isDirectory()) continue;
      if (existsSync(join(dir, 'platform.txt'))) found.push({ dir, version: e.name, root });
    }
    // dev-режим: platform.txt прямо в каталоге arch
    if (existsSync(join(base, 'platform.txt'))) found.push({ dir: base, version: 'dev', root });
  }
  if (!found.length) {
    // ядро можно «развернуть» на месте — например, своё ядро симулятора
    let deployed = false;
    for (const provide of CORE_PROVIDERS) {
      try { if (provide(fqbn)) deployed = true; } catch { /* провайдер не обязан уметь */ }
    }
    if (deployed) return resolveCore(fqbn);
    return {
      ok: false, tried,
      error: `Ядро ${vendor}:${arch} не найдено. Поставьте его из склада (панель «Автономно») или укажите папку ядра вручную`,
      board: board ? { name: board.name, fqbn: board.fqbn } : null,
    };
  }
  found.sort((a, b) => String(a.version).localeCompare(String(b.version), undefined, { numeric: true }));
  const pick = found[found.length - 1];
  return { ok: true, dir: pick.dir, version: pick.version, vendor, arch, root: pick.root, source: SOURCE_LABEL(pick.root), board };
}

function SOURCE_LABEL(root) {
  if (!root) return 'неизвестно';
  if (root.includes(join(DATA_DIR, 'vault'))) return 'склад';
  if (root.includes(join(DATA_DIR, 'packages')) || root.includes(join(DATA_DIR, 'arduino15'))) return 'MicroPIDE';
  if (root.includes('.arduino15') || root.includes('Arduino15')) return 'Arduino IDE';
  return 'скетчбук/hardware';
}

/** Загрузить platform.txt + boards.txt ядра и выбрать параметры платы. */
export function loadCoreProps(coreDir, boardId) {
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const platformPairs = [
    ...parseProps(read(join(coreDir, 'platform.txt'))),
    ...parseProps(read(join(coreDir, 'platform.local.txt'))),
  ];
  const boardsPairs = [
    ...parseProps(read(join(coreDir, 'boards.txt'))),
    ...parseProps(read(join(coreDir, 'boards.local.txt'))),
  ];
  const platform = propsMap(platformPairs);
  const boards = propsMap(boardsPairs);
  const vars = new Map();

  // Значения платформы кладём как есть (compiler.*, recipe.*, tools.*, name, version)
  for (const [k, v] of platform) vars.set(k, v);

  // Параметры конкретной платы: board.<id>.* → без префикса
  const prefix = boardId + '.';
  const menuChoices = new Map(); // menuId → {opt, props}
  for (const [k, v] of boardsPairs) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const menu = /^menu\.([^.]+)\.([^.]+)\.(.+)$/.exec(rest);
    if (menu) {
      const [, menuId, optId, prop] = menu;
      if (!menuChoices.has(menuId)) menuChoices.set(menuId, { opt: optId, props: new Map() });
      const ch = menuChoices.get(menuId);
      if (ch.opt === optId) ch.props.set(prop, v); // первый вариант = вариант по умолчанию
      continue;
    }
    // «uno.name=Uno Test» — это имя платы, а «name» из platform.txt — имя платформы;
    // плату отдаём как board.name, чтобы не путать их в рецептах и подписях
    if (rest === 'name') { vars.set('board.name', v); continue; }
    vars.set(rest, v);
  }
  for (const [, ch] of menuChoices) for (const [p, v] of ch.props) setDefault(vars, p, v);

  return { vars, platform, boards, menuChoices };
}

// ---------------------------------------------------------------- тулчейн

/**
 * Найти компилятор платформы. Приоритет: compiler.path из platform.txt →
 * свои каталоги tools → склад → PATH.
 */
export async function findToolchain({ coreDir, vars, arch }) {
  const candidates = [];
  const cmds = ['g++', 'gcc', 'ar', 'objcopy', 'size'];
  const compilerPathRaw = vars?.get('compiler.path') || '';
  const compilerPath = expandVars(compilerPathRaw, vars || new Map());
  const wanted = [vars?.get('compiler.cpp.cmd') || 'cpp', vars?.get('compiler.c.cmd') || 'gcc'].filter(Boolean);

  if (compilerPath) {
    for (const w of wanted) candidates.push({ bin: resolve(join(compilerPath, w)), kind: 'platform.txt', prefix: compilerPath });
  }
  // каталоги тулчейнов внутри ядра и рядом с ним
  const toolRoots = [
    join(DATA_DIR, 'packages'), join(DATA_DIR, 'arduino15', 'packages'),
    join(process.env.HOME || '', '.arduino15', 'packages'),
    join(DATA_DIR, 'vault', 'toolchains'), join(DATA_DIR, 'tools'),
  ].filter((p) => p && existsSync(p));
  for (const root of toolRoots) {
    for (const cand of findBinDirs(root, wanted, 4)) candidates.push(cand);
  }
  // PATH
  for (const w of wanted) {
    const p = await which(w);
    if (p) candidates.push({ bin: p, kind: 'PATH', prefix: dirname(p) + '/' });
  }

  for (const c of candidates) {
    if (!c.bin || !existsSync(c.bin)) continue;
    const v = await runCmd(c.bin, ['--version'], { timeoutMs: 8_000 });
    if (v.code !== 0) continue;
    const version = (v.out.split('\n')[0] || '').trim();
    const prefix = c.prefix || (dirname(c.bin) + '/');
    const resolved = { ok: true, prefix, cpp: c.bin, version, source: c.kind, cmds: {} };
    // какие команды реально доступны рядом
    for (const [key, prop] of [['cpp', 'compiler.cpp.cmd'], ['cc', 'compiler.c.cmd'], ['ar', 'compiler.ar.cmd'], ['objcopy', 'compiler.objcopy.cmd'], ['size', 'compiler.size.cmd'], ['ld', 'compiler.c.elf.cmd']]) {
      const cmdName = vars?.get(prop) || defaultCmd(key, c.bin);
      const full = join(dirname(c.bin), cmdName);
      resolved.cmds[key] = existsSync(full) ? full : (await which(cmdName)) || null;
    }
    // версия тулчейна для UI
    resolved.arch = targetArch(resolved.cmds.cpp);
    return resolved;
  }
  return {
    ok: false,
    error: wanted.length ? `Компилятор ${wanted[0]} не найден. Положите тулчейн в склад (.data/vault/toolchains) или в PATH` : 'Компилятор не найден',
    tried: candidates.map((c) => c.bin).filter(Boolean),
  };
}

function defaultCmd(key, cppBin) {
  const base = cppBin.replace(/g\+\+$/, '');
  return { cpp: base + 'g++', cc: base + 'gcc', ar: base + 'ar', objcopy: base + 'objcopy', size: base + 'size', ld: base + 'g++' }[key] || key;
}

function targetArch(cpp) {
  if (!cpp) return '';
  const b = cpp.split(/[\\/]/).pop() || '';
  if (/^avr-/.test(b)) return 'avr';
  if (/^arm-none-eabi-/.test(b)) return 'arm';
  if (/^xtensa/.test(b)) return 'xtensa';
  if (/^riscv/.test(b)) return 'riscv';
  if (b === 'g++' || b === 'c++' || b === 'clang++') return 'native';
  return 'unknown';
}

/** Рекурсивно найти каталоги bin, где лежат нужные команды. */
function findBinDirs(root, wanted, maxDepth = 3) {
  const out = [];
  const want = new Set(wanted.map((w) => w.replace(/^.*[\\/]/, '')));
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.name === 'bin') {
        try {
          const files = readdirSync(full);
          if (files.some((f) => want.has(f) || want.has(f.replace(/\.exe$/, '')))) out.push({ bin: join(full, [...want].find((w) => files.includes(w)) || wanted[0]), kind: 'tools', prefix: full + sep });
        } catch { /* ignore */ }
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

// ---------------------------------------------------------------- планирование сборки

/**
 * План сборки по рецептам платформы. Возвращает {steps, outputs, vars, error}.
 * Каждый шаг: {kind, cmd, args, desc}.
 */
export function genPlan({ core, boardId, vars: varsIn, projectName, sketchCppPath, extraSources = [], buildPath, sketchDir, verbose }) {
  const vars = new Map(varsIn);
  const coreDir = core.dir;
  const coreName = vars.get('build.core') || 'arduino';
  const variantName = vars.get('build.variant') || '';
  const coresRoot = join(coreDir, 'cores', coreName);
  const variantRoot = variantName ? join(coreDir, 'variants', variantName) : '';
  if (!existsSync(coresRoot)) return { error: `Не найден каталог ядра ${coresRoot} (build.core=${coreName})` };

  setDefault(vars, 'build.arch', core.arch.toUpperCase());
  setDefault(vars, 'build.path', buildPath);
  setDefault(vars, 'build.project_name', projectName);
  setDefault(vars, 'build.core.path', coresRoot);
  setDefault(vars, 'build.system.path', join(coreDir, 'system'));
  setDefault(vars, 'build.variant.path', variantRoot);
  setDefault(vars, 'build.source.path', sketchDir);
  setDefault(vars, 'runtime.ide.version', '10819');
  setDefault(vars, 'ide_version', '10819');
  setDefault(vars, 'software', 'ARDUINO');
  setDefault(vars, 'runtime.os', process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macosx' : 'linux');
  setDefault(vars, 'build.fqbn', `${core.vendor}:${core.arch}:${boardId}`);
  setDefault(vars, 'upload.verbose', verbose ? '-v' : '');

  // Пространство tools.<name>.path — из наших каталогов
  for (const [k, v] of [...vars]) {
    const m = /^runtime\.tools\.([^.]+)\.path$/.exec(k);
    if (!m) continue;
    if (!v || !existsSync(v)) {
      const found = findToolDir(m[1]);
      if (found) vars.set(k, found);
    }
  }
  for (const [k, v] of [...vars]) {
    const m = /^runtime\.tools\.([^.]+)\.path$/.exec(k);
    if (m && !vars.has(k)) vars.set(k, findToolDir(m[1]) || '');
  }

  const includeDirs = [coresRoot, variantRoot, sketchDir].filter(Boolean);
  // каталоги из build.extra_flags/compiler.* самого ядра тоже могут содержать -I
  const includes = includeDirs.map((d) => `-I"${d}"`).join(' ');
  vars.set('includes', includes);

  const objs = [];
  const steps = [];
  const push = (kind, cmd, args, desc) => steps.push({ kind, cmd, args, desc });

  const toolCmd = (key, fallback) => vars.get('compiler.' + key + '.cmd') || fallback;
  const compilerPath = expandVars(vars.get('compiler.path') || '', vars) || '';
  const cppCmd = compilerPath + (toolCmd('cpp', 'cpp') || 'cpp');
  const ccCmd = compilerPath + (toolCmd('c', 'gcc') || 'gcc');
  const arCmd = compilerPath + (toolCmd('ar', 'ar') || 'ar');
  const ldCmd = compilerPath + (toolCmd('c.elf', '') || toolCmd('cpp', 'cpp'));
  const objcopyCmd = compilerPath + (toolCmd('objcopy', 'objcopy') || 'objcopy');

  const compileOne = (src, kind) => {
    const ext = extname(src).toLowerCase();
    // kind задаёт владельца исходника: файлы скетча (включая сгенерированный .ino.cpp)
    // и файлы ядра лежат в разных каталогах сборки. Раньше здесь была проверка по
    // префиксу sketch-src, из-за которой .ino.cpp считался файлом ядра.
    const isCore = kind === 'core';
    const base = isCore
      ? join(buildPath, 'core', relPosix(coreDir, src))
      : join(buildPath, 'sketch', relPosix(sketchDir, src));
    const obj = base + '.o';
    mkdirSync(dirname(obj), { recursive: true });
    const p = new Map(vars);
    p.set('source_file', src);
    p.set('object_file', obj);
    const patternKey = ext === '.c' ? 'recipe.c.o.pattern' : ext === '.s' ? 'recipe.S.o.pattern' : 'recipe.cpp.o.pattern';
    const pattern = vars.get(patternKey) || vars.get('recipe.cpp.o.pattern');
    if (pattern) {
      const cmdline = expandPattern(pattern, p);
      const argv = splitCommandLine(cmdline);
      if (argv.length) push('compile', argv[0], argv.slice(1), `компиляция ${relPosix(coreDir, src)}`);
    } else {
      // ядро без рецептов компиляции: собираем командой «как принято»
      const flags = vars.get(ext === '.c' ? 'compiler.c.flags' : 'compiler.cpp.flags') || '-c -w -Os -std=gnu++11';
      const cmdline = `${ext === '.c' ? ccCmd : cppCmd} ${expandPattern(flags, p)} ${includes} ${expandPattern(vars.get('build.extra_flags') || '', p)} -o "${obj}" -c "${src}"`;
      const argv = splitCommandLine(cmdline);
      push('compile', argv[0], argv.slice(1), `компиляция ${relPosix(coreDir, src)}`);
    }
    objs.push({ src, obj, core: isCore });
    return obj;
  };

  // исходники ядра и варианта
  const coreSrcs = [
    ...walk(coresRoot, ['.c', '.cpp', '.cc', '.s']),
    ...(variantRoot ? walk(variantRoot, ['.c', '.cpp', '.cc', '.s']) : []),
  ];
  for (const s of coreSrcs) compileOne(s, 'core');

  // скетч и его вспомогательные файлы
  const sketchObjs = [];
  sketchObjs.push(compileOne(sketchCppPath, 'sketch'));
  for (const ex of extraSources) if (existsSync(ex)) sketchObjs.push(compileOne(ex, 'sketch'));

  // архив ядра
  const coreObjs = objs.filter((o) => o.core).map((o) => o.obj);
  const archivePath = join(buildPath, 'core', 'core.a');
  if (coreObjs.length) {
    const arPattern = vars.get('recipe.ar.pattern');
    if (arPattern) {
      const first = splitCommandLine(expandPattern(arPattern, new Map(vars).set('archive_file_path', archivePath).set('object_file', coreObjs[0]).set('object_file_posix', coreObjs[0])));
      // Arduino делает один ar-вызов на объект: rcs для первого, rcs для остальных
      push('archive', first[0], first.slice(1), 'архивация ядра (core.a)');
      for (const o of coreObjs.slice(1)) {
        const argv = splitCommandLine(expandPattern(arPattern, new Map(vars).set('archive_file_path', archivePath).set('object_file', o)));
        push('archive', argv[0], argv.slice(1));
      }
    } else {
      push('archive', arCmd, ['rcs', archivePath, ...coreObjs], 'архивация ядра (core.a)');
    }
  }

  const allSketchObjs = sketchObjs.filter(Boolean);
  const elfPath = join(buildPath, `${projectName}.elf`);
  const linkPattern = vars.get('recipe.c.combine.pattern');
  const linkVars = new Map(vars);
  linkVars.set('object_files', allSketchObjs.map((o) => `"${o}"`).join(' '));
  linkVars.set('archive_file', 'core.a');
  linkVars.set('archive_file_path', archivePath);
  linkVars.set('build.path', buildPath);
  if (linkPattern) {
    const argv = splitCommandLine(expandPattern(linkPattern, linkVars));
    push('link', argv[0], argv.slice(1), 'компоновка (elf)');
  } else {
    const linkFlags = expandPattern(vars.get('compiler.c.elf.flags') || '', linkVars);
    push('link', ldCmd, [...splitCommandLine(linkFlags), '-Wl,--gc-sections', '-o', elfPath, ...allSketchObjs, ...(coreObjs.length ? [archivePath] : []), '-lm'], 'компоновка (elf)');
  }

  // Наш собственный «симулятор на ПК» не конвертирует elf в hex: это готовая программа
  const native = vars.get('micropide.native') === '1';

  // objcopy: hex/bin/eep — все рецепты, которые есть у платформы
  const outputs = { elf: elfPath, hex: null, bin: null, eep: null, map: elfPath + '.map' };
  if (native) return { steps, outputs, vars, core, includes, native };
  const copyVars = new Map(vars);
  copyVars.set('build.path', buildPath);
  copyVars.set('build.project_name', projectName);
  for (const key of ['recipe.objcopy.hex.pattern', 'recipe.objcopy.bin.pattern', 'recipe.objcopy.eep.pattern']) {
    const pattern = vars.get(key);
    if (pattern) {
      const argv = splitCommandLine(expandPattern(pattern, copyVars));
      if (argv.length) push('objcopy', argv[0], argv.slice(1), 'конвертация прошивки');
      if (key.includes('hex')) outputs.hex = join(buildPath, `${projectName}.hex`);
      if (key.includes('bin')) outputs.bin = join(buildPath, `${projectName}.bin`);
      if (key.includes('eep')) outputs.eep = join(buildPath, `${projectName}.eep`);
    }
  }
  if (!outputs.hex && !outputs.bin) {
    const ext = core.arch === 'avr' ? 'hex' : 'bin';
    const args = core.arch === 'avr'
      ? ['-O', 'ihex', '-R', '.eeprom', elfPath, join(buildPath, `${projectName}.hex`)]
      : ['-O', 'binary', elfPath, join(buildPath, `${projectName}.bin`)];
    push('objcopy', objcopyCmd, args, 'конвертация прошивки');
    outputs[ext] = join(buildPath, `${projectName}.${ext}`);
  }

  // размеры: рецепт платформы либо наш вызов size
  const sizePattern = vars.get('recipe.size.pattern');
  if (sizePattern) {
    const argv = splitCommandLine(expandPattern(sizePattern, copyVars));
    if (argv.length) push('size', argv[0], argv.slice(1), 'размер прошивки');
  } else if (existsSync(join(dirname(cppCmd), 'size')) || vars.get('compiler.size.cmd')) {
    push('size', compilerPath + (toolCmd('size', 'size') || 'size'), ['-A', elfPath], 'размер прошивки');
  }
  if (vars.get('recipe.size.regex')) steps[steps.length - 1].parseSize = vars.get('recipe.size.regex');

  return { steps, outputs, vars, core, includes };
}

/** Разбор командной строки с кавычками (свой парсер: shell не нужен). */
export function splitCommandLine(s) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && (s[i + 1] === '"' || s[i + 1] === '\\')) { cur += s[i + 1]; i++; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ' ' || c === '\t' || c === '\n') { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Каталог инструмента по имени (avr-gcc, esptool_py, bosac…) в наших каталогах. */
export function findToolDir(name) {
  const roots = [
    join(DATA_DIR, 'packages'), join(DATA_DIR, 'arduino15', 'packages'),
    join(process.env.HOME || '', '.arduino15', 'packages'),
    join(DATA_DIR, 'vault', 'toolchains'),
  ].filter((p) => p && existsSync(p));
  const matches = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.name === name || e.name.startsWith(name)) { matches.push(full); }
      walk(full, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  if (!matches.length) return null;
  // выбираем версию с bin внутри
  matches.sort((a, b) => a.localeCompare(b));
  for (let i = matches.length - 1; i >= 0; i--) if (existsSync(join(matches[i], 'bin'))) return matches[i];
  return matches[matches.length - 1];
}

// ---------------------------------------------------------------- сборка

/** Разобрать вывод size/компилятора в размеры флеша и ОЗУ. */
export function parseSizes(text) {
  const t = String(text || '');
  let flash = null, ram = null, maxFlash = null, maxRam = null;
  // «Sketch uses 924 bytes (2%) of program storage space. Maximum is 32256 bytes.»
  const sketch = /Sketch uses (\d+) bytes \((\d+)%\) of program storage space\. Maximum is (\d+) bytes/.exec(t);
  if (sketch) { flash = Number(sketch[1]); maxFlash = Number(sketch[3]); }
  const glob = /Global variables use (\d+) bytes \((\d+)%\) of dynamic memory(?:, leaving (\d+) bytes for local variables)?\. Maximum is (\d+) bytes/.exec(t);
  if (glob) { ram = Number(glob[1]); maxRam = Number(glob[4]); }
  // avr-size -A: таблица секций
  if (flash === null) {
    const sec = new Map();
    const re = /^\.(\S+)\s+(\d+)/gm;
    let m;
    while ((m = re.exec(t))) sec.set(m[1], Number(m[2]));
    if (sec.size) {
      const f = (sec.get('text') || 0) + (sec.get('data') || 0) + (sec.get('rodata') || 0) + (sec.get('bootloader') || 0) + (sec.get('vectors') || 0) + (sec.get('progmem') || 0);
      const r = (sec.get('data') || 0) + (sec.get('bss') || 0) + (sec.get('noinit') || 0);
      flash = f || null; ram = r;
    }
  }
  // Program: 1106 bytes / Data: 16 bytes (Berkeley-формат avr-size)
  if (flash === null) {
    const p = /Program:\s+(\d+) bytes/.exec(t);
    const d = /Data:\s+(\d+) bytes/.exec(t);
    if (p) flash = Number(p[1]);
    if (d) ram = Number(d[1]);
  }
  return { flash, ram, maxFlash, maxRam };
}

/** Сколько места займёт: проценты и предупреждения о переполнении. */
export function sizeReport({ flash, ram, board }) {
  const b = findBoard(board) || {};
  const maxFlash = b.flash || null;
  const maxRam = b.ram || null;
  const pctF = flash != null && maxFlash ? Math.round((flash / maxFlash) * 1000) / 10 : null;
  const pctR = ram != null && maxRam ? Math.round((ram / maxRam) * 1000) / 10 : null;
  const warns = [];
  if (pctF != null && pctF > 100) warns.push(`Прошивка не влезает во флеш: ${flash} из ${maxFlash} байт (${pctF}%)`);
  else if (pctF != null && pctF > 90) warns.push(`Прошивка занимает ${pctF}% флеша — почти предел`);
  if (pctR != null && pctR > 100) warns.push(`ОЗУ переполнено: ${ram} из ${maxRam} байт (${pctR}%)`);
  else if (pctR != null && pctR > 75) warns.push(`Глобальные переменные занимают ${pctR}% ОЗУ — риск для стека`);
  return { flash, ram, maxFlash, maxRam, pctFlash: pctF, pctRam: pctR, warns };
}

/**
 * Полный цикл сборки своим движком.
 * opts: {name, fqbn, files, onLine, verbose, signal, buildRoot, skipSave}
 * Возвращает {ok, sizes, elf, hex, bin, log, error, core, toolchain}.
 */
export async function buildWithOwnEngine(opts) {
  const { name, fqbn, files, onLine = () => {}, verbose = false, signal, skipSave = true } = opts;
  const say = (s) => onLine(s);
  const log = [];
  const sayLog = (s) => { log.push(s); say(s); };
  const t0 = Date.now();

  const core = resolveCore(fqbn);
  if (!core.ok) return { ok: false, error: core.error, tried: core.tried, log };
  const [vendor, arch, boardId] = String(fqbn).split(':');
  const { vars } = loadCoreProps(core.dir, boardId);

  const pre = preprocessSketch(files, { name });
  if (pre.diagnostics.some((d) => d.level === 'error')) {
    for (const d of pre.diagnostics) sayLog('✗ ' + d.text);
    return { ok: false, error: pre.diagnostics.find((d) => d.level === 'error').text, log };
  }
  for (const d of pre.diagnostics) sayLog(d.level === 'warn' ? '⚠ ' + d.text : d.text);
  sayLog(`Ядро: ${core.dir} (${core.source}, версия ${core.version})`);
  if (pre.prototypes.length) sayLog(`Прототипов сгенерировано: ${pre.prototypes.length}`);

  const toolchain = await findToolchain({ coreDir: core.dir, vars, arch });
  if (!toolchain.ok) return { ok: false, error: toolchain.error, toolchain, log };
  sayLog(`Тулчейн: ${toolchain.cpp} (${toolchain.version || 'версия неизвестна'}, ${toolchain.source})`);

  const buildPath = opts.buildRoot || join(DATA_DIR, 'build', `${name}-${boardId}`);
  rmSync(buildPath, { recursive: true, force: true });
  mkdirSync(join(buildPath, 'sketch'), { recursive: true });
  const sketchCppPath = join(buildPath, 'sketch', `${name || 'sketch'}.ino.cpp`);
  writeFileSync(sketchCppPath, pre.cpp);
  const sketchDir = join(buildPath, 'sketch-src');
  mkdirSync(sketchDir, { recursive: true });
  for (const f of files || []) {
    const target = join(sketchDir, String(f.path).replace(/\\/g, '/'));
    if (!target.startsWith(sketchDir)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(f.content ?? ''));
  }
  const extraSources = (pre.extraSources || []).map((f) => join(sketchDir, f.path));

  const plan = genPlan({
    core, boardId, vars, projectName: name || 'sketch',
    sketchCppPath, extraSources, buildPath, sketchDir, verbose,
  });
  if (plan.error) return { ok: false, error: plan.error, log };

  sayLog(`Шагов сборки: ${plan.steps.length}`);
  let failed = null;
  const toolSizes = { flash: null, ram: null };
  const allOut = [];
  for (const step of plan.steps) {
    const cmdLine = `${step.cmd} ${step.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
    if (verbose) sayLog('$ ' + cmdLine);
    const r = await runCmd(step.cmd, step.args, { onLine: (l) => sayLog(l), signal, env: process.env, timeoutMs: 300_000 });
    allOut.push(r.out);
    if (r.code !== 0 && step.kind !== 'size') {
      sayLog(`✗ Ошибка на шаге «${step.desc || step.kind}»`);
      failed = { step, r };
      break;
    }
    if (step.kind === 'size') {
      const s = parseSizes(r.out);
      if (s.flash != null) toolSizes.flash = s.flash;
      if (s.ram != null) toolSizes.ram = s.ram;
    }
  }

  // размеры из рецепта платформы (recipe.size.regex) — если size не дал чисел
  if (toolSizes.flash == null) {
    const rx = plan.vars.get('recipe.size.regex');
    if (rx) {
      try {
        const m = new RegExp(rx, 'm').exec(allOut.join('\n'));
        if (m && m[1]) toolSizes.flash = Number(m[1]);
      } catch { /* рецепт бывает с pcre-синтаксисом */ }
    }
  }
  if (toolSizes.ram == null) {
    const rxData = plan.vars.get('recipe.size.regex.data');
    if (rxData) {
      try {
        const m = new RegExp(rxData, 'm').exec(allOut.join('\n'));
        if (m && m[1]) toolSizes.ram = Number(m[1]);
      } catch { /* ignore */ }
    }
  }
  if (toolSizes.flash == null || toolSizes.ram == null) {
    const s = parseSizes(allOut.join('\n'));
    if (toolSizes.flash == null) toolSizes.flash = s.flash;
    if (toolSizes.ram == null) toolSizes.ram = s.ram;
  }

  const elf = plan.outputs.elf;
  const hex = plan.outputs.hex;
  const bin = plan.outputs.bin;
  const sizes = sizeReport({ ...toolSizes, board: fqbn });
  if (failed) {
    return { ok: false, error: `Сборка не удалась на шаге: ${failed.step.desc || failed.step.kind}`, log, core: core.dir, toolchain: toolchain.cpp, plan: plan.steps.map((s) => s.desc || s.kind) };
  }
  if (!existsSync(elf)) return { ok: false, error: 'Единый файл прошивки (.elf) не создан', log };
  sayLog(formatSizes(sizes, fqbn));
  return {
    ok: true, sizes, elf: existsSync(elf) ? elf : null,
    hex: hex && existsSync(hex) ? hex : null, bin: bin && existsSync(bin) ? bin : null,
    log, core: core.dir, toolchain: toolchain.cpp, arch,
    ms: Date.now() - t0, prototypes: pre.prototypes.length,
  };
}

function formatSizes(s, fqbn) {
  const b = findBoard(fqbn) || {};
  const parts = [];
  if (s.flash != null) parts.push(`Флеш: ${s.flash}${s.maxFlash ? ' / ' + s.maxFlash : ''} байт${s.pctFlash != null ? ` (${s.pctFlash}%)` : ''}`);
  if (s.ram != null) parts.push(`ОЗУ: ${s.ram}${s.maxRam ? ' / ' + s.maxRam : ''} байт${s.pctRam != null ? ` (${s.pctRam}%)` : ''}`);
  const head = parts.length ? '✓ Готово. ' + parts.join(' · ') : '✓ Сборка завершена';
  return head + (b.name ? ` · ${b.name}` : '');
}

// ---------------------------------------------------------------- прошивка

/**
 * Прошивка своим движком: сперва рецепт платформы (tools.<id>.upload.pattern),
 * затем наша собственная команда из базы плат (avrdude/esptool/…).
 */
export async function uploadWithOwnEngine({ fqbn, port, hex, elf, bin, name, onLine = () => {}, verbose = false, signal }) {
  const say = (s) => onLine(s);
  const [vendor, arch, boardId] = String(fqbn).split(':');
  const core = resolveCore(fqbn);
  const board = findBoard(fqbn);
  const upload = board?.upload || {};
  let vars = new Map();
  if (core.ok) vars = loadCoreProps(core.dir, boardId).vars;
  vars.set('serial.port', port);
  vars.set('serial.port.file', String(port).replace(/^.*[\\/]/, ''));
  vars.set('upload.verbose', verbose ? '-v' : '');
  vars.set('build.path', dirname(elf || hex || 'x'));
  vars.set('build.project_name', name || 'sketch');
  if (board?.upload?.baud) vars.set('upload.speed', String(board.upload.baud));
  if (board?.upload?.part) vars.set('build.mcu', board.upload.part);

  // 1) рецепт платформы
  const toolId = vars.get('upload.tool') || (core.ok ? null : upload.kind);
  if (toolId) {
    const pattern = vars.get(`tools.${toolId}.upload.pattern`);
    if (pattern) {
      const argv = splitCommandLine(expandPattern(pattern, vars));
      if (argv.length) {
        say('Прошивка по рецепту платформы: ' + toolId);
        if (verbose) say('$ ' + argv.join(' '));
        const r = await runCmd(argv[0], argv.slice(1), { onLine: say, signal, timeoutMs: 180_000 });
        return r.code === 0 ? { ok: true, via: 'recipe:' + toolId, cmd: argv.join(' ') } : { ok: false, via: 'recipe:' + toolId, error: 'avrdude/рецепт вернул код ' + r.code, out: r.out };
      }
    }
  }

  // 2) своя команда из базы плат
  if (upload.kind === 'avrdude') {
    const conf = findToolDir('avrdude');
    const confFile = conf && existsSync(join(conf, 'etc', 'avrdude.conf')) ? join(conf, 'etc', 'avrdude.conf') : null;
    const avrdude = (conf && existsSync(join(conf, 'bin', process.platform === 'win32' ? 'avrdude.exe' : 'avrdude')))
      ? join(conf, 'bin', process.platform === 'win32' ? 'avrdude.exe' : 'avrdude')
      : await which('avrdude');
    if (!avrdude) return { ok: false, error: 'avrdude не найден — положите тулчейн avrdude в склад или установите пакет' };
    const f = hex || (elf || '').replace(/\.elf$/, '.hex');
    if (!f || !existsSync(f)) return { ok: false, error: 'Нет .hex для прошивки — сначала соберите скетч' };
    const args = [];
    if (confFile) args.push('-C', confFile);
    args.push(verbose ? '-v' : '-q', '-p', upload.part || 'atmega328p', '-c', upload.programmer || 'arduino', '-P', port, '-b', String(upload.baud || 115200), '-D', '-U', `flash:w:${f}:i`);
    say('avrdude: ' + args.join(' '));
    const r = await runCmd(avrdude, args, { onLine: say, signal, timeoutMs: 180_000 });
    return r.code === 0 ? { ok: true, via: 'avrdude', cmd: avrdude + ' ' + args.join(' ') } : { ok: false, via: 'avrdude', error: 'avrdude вернул код ' + r.code, out: r.out };
  }
  if (upload.kind === 'esptool') {
    const esptooldir = findToolDir('esptool');
    const py = esptooldir && existsSync(join(esptooldir, 'esptool.py')) ? join(esptooldir, 'esptool.py') : (await which('esptool.py')) || (await which('esptool'));
    if (!py) return { ok: false, error: 'esptool не найден. ESP-платформе нужны отдельные .bin (bootloader/partitions) — прошейте через arduino-cli или положите esptool в склад' };
    const b = bin || (elf || '').replace(/\.elf$/, '.bin');
    if (!b || !existsSync(b)) return { ok: false, error: 'Нет .bin для прошивки (для ESP нужны bootloader/partitions — их готовит ядро при полной сборке)' };
    const args = py.endsWith('.py') ? [py, '--chip', upload.chip || 'esp32', '--port', port, '--baud', String(upload.baud || 921600), 'write_flash', '0x0', b] : ['--chip', upload.chip || 'esp32', '--port', port, '--baud', String(upload.baud || 921600), 'write_flash', '0x0', b];
    const cmd = args[0].endsWith('.py') ? 'python3' : args[0];
    const useArgs = args[0].endsWith('.py') ? args : args.slice(1);
    say('esptool: ' + useArgs.join(' '));
    const r = await runCmd(cmd, useArgs, { onLine: say, signal, timeoutMs: 300_000 });
    return r.code === 0 ? { ok: true, via: 'esptool' } : { ok: false, via: 'esptool', error: 'esptool вернул код ' + r.code, out: r.out };
  }
  return {
    ok: false,
    error: `Для прошивки ${upload.kind ? 'способа «' + upload.kind + '»' : 'этой платы'} нужен arduino-cli (или добавьте ядро в склад с рецептом tools.*.upload.pattern)`,
    board: board?.name || fqbn,
  };
}

// ---------------------------------------------------------------- карта памяти

/**
 * Разбор символов из .elf (nm/size/objdump) — «карта памяти»: что именно
 * занимает место в прошивке. Работает с любым тулчейном.
 */
export async function symbolMap(elf, toolchain, { limit = 40 } = {}) {
  if (!elf || !existsSync(elf)) return { ok: false, error: 'Нет .elf' };
  const prefix = toolchain?.cmds?.nm ? toolchain.cmds.nm : (toolchain?.cmds?.cpp ? join(dirname(toolchain.cmds.cpp), (toolchain.cmds.cpp.split(/[\\/]/).pop() || 'nm').replace(/g\+\+$/, 'nm')) : 'nm');
  const nm = existsSync(prefix) ? prefix : 'nm';
  const r = await runCmd(nm, ['-S', '--size-sort', '--demangle', elf], { timeoutMs: 30_000 });
  if (r.code !== 0) return { ok: false, error: 'nm недоступен: ' + (r.out || '').slice(0, 200) };
  const rows = [];
  for (const line of r.out.split('\n')) {
    // «0000010c 0000002a T setup» или с сортировкой по адресу
    const m = /^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([A-Za-z?])\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const size = parseInt(m[2], 16);
    const type = m[3];
    if (!size) continue;
    const section = /[tTwW]/.test(type) ? 'flash' : /[bBdD]/.test(type) ? 'ram' : /[rR]/.test(type) ? 'rodata' : 'other';
    rows.push({ addr: parseInt(m[1], 16), size, type, section, name: m[4] });
  }
  rows.sort((a, b) => b.size - a.size);
  const bySection = rows.reduce((acc, r2) => { acc[r2.section] = (acc[r2.section] || 0) + r2.size; return acc; }, {});
  return { ok: true, total: rows.length, bySection, top: rows.slice(0, limit), all: rows.length <= 4000 ? rows : rows.slice(0, 4000) };
}

export const __test = { which, findBinDirs, walk, setDefault };
