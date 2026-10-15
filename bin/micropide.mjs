#!/usr/bin/env node
// MicroPIDE из командной строки: всё то же, что в окне, но скриптуемо.
//
// Зачем: серверы Arduino недоступны и arduino-cli может отсутствовать — а сборка,
// проверка логики, тесты, анализ, перенос на другую плату и энергопрофиль нужны
// в CI, в make и просто из терминала. Здесь они вызываются напрямую, без сервера.
//
// Примеры:
//   micropide build Blink --fqbn arduino:avr:uno
//   micropide sim Blink --mps tests/blink.mps
//   micropide analyze Blink --json
//   micropide test Blink --mps tests/blink.mps --junit out.xml
//   micropide port Blink --to esp32:esp32:esp32 --write
//   micropide power Blink --battery 2000
//   micropide new Blink --template state_machine --fqbn arduino:avr:uno
//   micropide lib SensorKit --author "вы" --write
//   micropide devices | boards | pins | docs | serve
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, extname } from 'node:path';

const args = process.argv.slice(2);
const cmd = (args.shift() || 'help').toLowerCase();
const opts = { json: false, write: false, verbose: false, port: '', fqbn: '', mps: '', to: '', from: '', template: '', battery: 2000, junit: '', tap: '', save: '' };
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') opts.json = true;
  else if (a === '--write' || a === '-w') opts.write = true;
  else if (a === '--verbose' || a === '-v') opts.verbose = true;
  else if (a.startsWith('--')) {
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
    if (key === 'battery') opts.battery = Number(val) || 2000;
    else opts[key] = val;
  } else rest.push(a);
}

const say = (...a) => console.log(...a);
const die = (msg, code = 1) => { console.error('✗ ' + msg); process.exit(code); };
const line = (l) => { if (!opts.json) console.log(l); };
const dirOf = () => process.cwd();
const SKETCHBOOK = () => process.env.MICRO_PIDE_SKETCHBOOK || join(dirOf(), 'sketchbook');

/** Прочитать скетч: путь к каталогу, к .ino или имя в скетчбуке. */
function readSketch(name) {
  if (!name) die('Укажите скетч: micropide <команда> <путь|имя>');
  const cands = [name, join(dirOf(), name), join(SKETCHBOOK(), name), join(dirOf(), name + '.ino'), join(SKETCHBOOK(), name + '.ino')];
  for (const c of cands) {
    if (!existsSync(c)) continue;
    const st = statSync(c);
    const dir = st.isDirectory() ? c : dirname(c);
    const files = [];
    const walk = (d, depth = 0) => {
      if (depth > 2) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'sketchbook' && !e.name.startsWith('.')) walk(full, depth + 1); continue; }
        if (!/\.(ino|cpp|h|hpp|c|S)$/i.test(e.name)) continue;
        files.push({ path: e.name, content: readFileSync(full, 'utf8') });
      }
    };
    walk(dir);
    if (!files.length) continue;
    const ino = files.find((f) => /\.ino$/i.test(f.path));
    return { name: basename(dir), dir, files, ino };
  }
  die('Скетч не найден: ' + name);
}

async function main() {
  // ------------------------------------------------------------------ справка
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    say(`MicroPIDE CLI — своя среда вместо серверов Arduino.

  build <скетч>      сборка своим движком (--fqbn, --verbose)
  upload <скетч>     сборка и прошивка (--port, --fqbn)
  sim <скетч>        прогон логики в симуляторе без платы (--ms, --mps)
  test <скетч>       тесты .mps (--mps, --junit файл, --tap файл)
  analyze <скетч>    линтер под плату (--fqbn, --json)
  pins <скетч>       карта пинов: занятые, свободные, конфликты
  docs <скетч>       документация, BOM и mermaid-схема (--save файл)
  port <скетч>       перенос на другую плату (--to FQBN, --write, --json)
  power <скетч>      энергопрофиль и время работы (--battery 2000)
  new <имя>          скетч из шаблона (--template, --fqbn, --write)
  templates          список шаблонов
  lib <Имя>          скелет библиотеки (--author, --write)
  module <Имя>       класс-модуль для скетча (--kind sensor|actuator|protocol)
  boards [фильтр]    база плат MicroPIDE (--json)
  vault              состояние автономности и склада
  serve              поднять локальный сервер MicroPIDE (--port 8080)
`);
    return 0;
  }
  if (cmd === 'templates') {
    const { templatesForUi } = await import('../server/scaffold.mjs');
    for (const t of templatesForUi()) say(`${t.id.padEnd(16)} ${t.title} — ${t.desc}`);
    return 0;
  }
  if (cmd === 'boards') {
    const { allBoards } = await import('../server/boarddb.mjs');
    const q = (rest[0] || '').toLowerCase();
    const list = allBoards().filter((b) => !q || b.name.toLowerCase().includes(q) || b.fqbn.includes(q));
    if (opts.json) say(JSON.stringify(list, null, 2));
    else for (const b of list) say(`${b.fqbn.padEnd(34)} ${b.name} — ${b.mcu}, ${b.voltage ?? '?'} В, флеш ${b.flash}, ОЗУ ${b.ram}${b.simulator ? ' [сим]' : ''}`);
    return 0;
  }
  if (cmd === 'vault') {
    const { autonomyReport, scanVault } = await import('../server/offline.mjs');
    const r = await autonomyReport();
    const v = scanVault();
    say(`Автономность: ${r.score}% (${r.level})`);
    for (const [k, ok] of Object.entries(r.can || {})) say(`  ${ok ? '✓' : '·'} ${k}`);
    say(`Склад: ${v.items.length} объект(ов) в ${v.dirs.archives}`);
    for (const it of v.items) say(`  ${it.name} — ${it.kind}${it.sizeText ? ', ' + it.sizeText : ''}`);
    return 0;
  }
  if (cmd === 'serve') {
    const { startServer } = await import('../server/server.mjs');
    const port = Number(opts.port) || 8080;
    const s = await startServer({ port });
    say(`MicroPIDE: http://127.0.0.1:${s.port}  (скетчбук: ${s.root})`);
    return 0;
  }
  if (cmd === 'lib') {
    const { librarySkeleton } = await import('../server/scaffold.mjs');
    const r = librarySkeleton({ name: rest[0] || opts.name || '', author: opts.author || '', version: opts.version || '0.1.0', sentence: opts.sentence || '', fqbn: opts.fqbn || 'arduino:avr:uno' });
    if (!r.ok) die(r.error);
    const base = opts.write ? join(SKETCHBOOK(), 'libraries', r.name) : null;
    for (const f of r.files) {
      if (base) { mkdirSync(dirname(join(base, f.path)), { recursive: true }); writeFileSync(join(base, f.path), f.content, 'utf8'); }
      say((base ? '+ ' : '· ') + f.path);
    }
    say(base ? `Библиотека записана: ${base}` : 'Добавьте --write, чтобы записать в скетчбук');
    return 0;
  }
  if (cmd === 'module') {
    const { moduleSkeleton } = await import('../server/scaffold.mjs');
    const r = moduleSkeleton({ name: rest[0] || '', kind: opts.kind || 'sensor', fqbn: opts.fqbn || 'arduino:avr:uno' });
    if (!r.ok) die(r.error);
    for (const f of r.files) say(`--- ${f.path} ---\n${f.content}`);
    return 0;
  }
  if (cmd === 'new') {
    const { sketchTemplate } = await import('../server/scaffold.mjs');
    const name = rest[0] || opts.name || 'Sketch';
    const r = sketchTemplate({ id: opts.template || 'blink_noblock', name, fqbn: opts.fqbn || 'arduino:avr:uno' });
    if (!r.ok) die(r.error);
    const dir = join(dirOf(), name);
    if (opts.write) mkdirSync(dir, { recursive: true });
    for (const f of r.files) {
      if (opts.write) writeFileSync(join(dir, f.path), f.content, 'utf8');
      say((opts.write ? '+ ' : '· ') + join(dir, f.path));
    }
    say(`${r.title}${opts.write ? ' — создано' : ' — добавьте --write, чтобы создать файлы'}`);
    return 0;
  }

  // ------------------------------------------------------ команды над скетчем
  const sk = readSketch(rest[0]);
  const fqbn = opts.fqbn || 'arduino:avr:uno';

  if (cmd === 'build' || cmd === 'upload') {
    const { buildWithOwnEngine, uploadWithOwnEngine } = await import('../server/buildcore.mjs');
    // для своей sim-платы ядро разворачивается на месте (его умеет native.mjs)
    await import('../server/native.mjs');
    const t0 = Date.now();
    const r = await buildWithOwnEngine({ name: sk.name, fqbn, files: sk.files, onLine: line, verbose: opts.verbose });
    if (!r.ok) { if (opts.json) say(JSON.stringify({ ok: false, error: r.error })); die(r.error); }
    say(`✓ Сборка: ${r.elf || r.hex} за ${Date.now() - t0} мс${r.sizes?.flash ? `, флеш ${r.sizes.flash} Б, ОЗУ ${r.sizes.ram} Б` : ''}`);
    if (cmd === 'upload') {
      if (!opts.port) die('Укажите --port /dev/ttyUSB0');
      const up = await uploadWithOwnEngine({ fqbn, port: opts.port, hex: r.hex, elf: r.elf, bin: r.bin, name: sk.name, onLine: line });
      if (!up.ok) die(up.error);
      say('✓ Прошито');
    }
    return 0;
  }

  if (cmd === 'sim') {
    const { simulate } = await import('../server/native.mjs');
    const scenario = opts.mps ? readFileSync(opts.mps, 'utf8') : '';
    const ms = Number(opts.ms) || 0;
    const r = await simulate({ name: sk.name, files: sk.files, scenario, timeoutMs: ms || 60_000, onLine: line, fqbn });
    if (!r.ok) die(r.error || 'симулятор не смог');
    const it = r.summary?.iterations;
    say(`✓ Симуляция: ${it != null ? `итераций ${it}, ` : ''}виртуально ${r.summary?.ms ?? 0} мс${r.checks ? `, проверок ${r.checks.passed}/${r.checks.passed + r.checks.failed}` : ''}`);
    if (opts.json) say(JSON.stringify({ ok: true, exitCode: r.exitCode, summary: r.summary, checks: r.checks }));
    return 0;
  }

  if (cmd === 'test') {
    const { runTest, saveReport } = await import('../server/hiltest.mjs');
    const scenario = opts.mps ? { name: basename(opts.mps), text: readFileSync(opts.mps, 'utf8') } : null;
    if (!scenario) die('Укажите --mps файл с тестом');
    const r = await runTest({ name: sk.name, files: sk.files, scenario: scenario.text, target: opts.port ? 'board' : 'sim', port: opts.port || '', onLine: line });
    say(r.ok ? '✓ Тест пройден' : '✗ Тест провален');
    if (opts.junit) { writeFileSync(opts.junit, r.junit || r.report?.junit || ''); say('JUnit: ' + opts.junit); }
    if (opts.tap) { writeFileSync(opts.tap, r.tap || r.report?.tap || ''); say('TAP: ' + opts.tap); }
    if (opts.json) say(JSON.stringify({ ok: r.ok, checks: r.checks, summary: r.summary }));
    void saveReport;
    return r.ok ? 0 : 2;
  }

  if (cmd === 'analyze') {
    const { analyze } = await import('../server/analysis.mjs');
    const a = analyze({ files: sk.files, fqbn, name: sk.name });
    if (opts.json) { say(JSON.stringify(a, null, 2)); return a.score?.overall >= 50 ? 0 : 2; }
    say(`${sk.name} → ${fqbn}: оценка ${a.score?.overall ?? '?'}/100, замечаний ${a.findings?.length ?? 0}`);
    for (const f of a.findings || []) say(`  [${f.level}] ${f.file}:${f.line} ${f.message}`);
    return (a.findings || []).some((f) => f.level === 'error') ? 2 : 0;
  }

  if (cmd === 'pins') {
    const { pinMap } = await import('../server/analysis.mjs');
    const m = pinMap({ files: sk.files, fqbn });
    say(`Плата ${m.board?.name} — занято ${m.stats.used} из ${m.stats.total}, ШИМ ${m.stats.pwmUsed}, АЦП ${m.stats.adcUsed}`);
    for (const p of m.pins) say(`  ${p.label.padEnd(5)} ${[...p.roles].join(', ')}${p.conflicts.length ? ' ⚠ ' + p.conflicts.join('; ') : ''}`);
    if (m.stats.conflicts) say(`Конфликтов: ${m.stats.conflicts}`);
    return 0;
  }

  if (cmd === 'docs') {
    const { generateDocs } = await import('../server/analysis.mjs');
    const d = generateDocs({ name: sk.name, files: sk.files, fqbn });
    if (opts.save) { writeFileSync(opts.save, d.markdown); say('Записано: ' + opts.save); }
    else say(d.markdown);
    return 0;
  }

  if (cmd === 'port') {
    const { portPlan } = await import('../server/port.mjs');
    if (!opts.to) die('Укажите --to FQBN, например --to esp32:esp32:esp32');
    const p = portPlan({ from: opts.from || fqbn, to: opts.to, files: sk.files, name: sk.name });
    if (!p.ok) die(p.error);
    say(`${p.from.name} → ${p.to.name}: перенесено пинов ${p.stats.pins}, правок ${p.stats.edits}, предупреждений ${p.stats.warnings}`);
    for (const m of p.mapping) say(`  ${m.from} → ${m.to || '—'}${m.roles.length ? ' (' + m.roles.join(', ') + ')' : ''}${m.why ? ' — ' + m.why : ''}`);
    for (const w of p.warnings) say(`  [${w.level}] ${w.text}`);
    if (p.adapter.length) for (const a of p.adapter) say(`  адаптер: ${a}`);
    if (opts.json) say(JSON.stringify(p, null, 2));
    else if (p.diff && !opts.write) say('\n--- что изменится ---\n' + p.diff);
    if (opts.write) {
      for (const f of p.files) {
        const dst = join(sk.dir, f.path);
        if (f.content !== (sk.files.find((x) => x.path === f.path)?.content || '')) { writeFileSync(dst, f.content, 'utf8'); say('! перезаписан ' + dst); }
      }
      say('Файлы обновлены (--write)');
    }
    return p.stats.errors ? 2 : 0;
  }

  if (cmd === 'power') {
    const { powerProfile } = await import('../server/power.mjs');
    const p = powerProfile({ files: sk.files, fqbn, batteryMmah: opts.battery });
    if (!p.ok) die(p.error);
    if (opts.json) { say(JSON.stringify(p, null, 2)); return 0; }
    say(`${p.board.name}: в среднем ${p.avgMa} мА — батарея ${p.battery.mAh} мА·ч даст ~${p.battery.hours} ч (${p.battery.days} сут), ${p.battery.verdict}`);
    for (const l of p.loads) say(`  ${String(l.ma).padStart(7)} мА  ${l.what} — ${l.source}`);
    say('Советы:');
    for (const a of p.advice) say('  • ' + a);
    return 0;
  }

  die('Неизвестная команда: ' + cmd + ' (micropide help)');
}

main().then((code) => process.exit(code || 0)).catch((e) => { console.error('✗ ' + (e?.stack || e)); process.exit(1); });
void extname;
void resolve;
