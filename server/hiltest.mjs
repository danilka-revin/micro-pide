// Тесты на железе и в симуляторе (HIL) — одним и тем же файлом сценария.
//
// «Аппаратура в контуре» — редкая возможность для среды Arduino: описываете,
// что послать устройству и что ждать в ответ (и на каких пинах что должно
// переключиться), затем запускаете:
//   • на плате — сценарий исполняется по-настоящему, ответы читаются из порта;
//   • в симуляторе на ПК — тот же сценарий, но без железа и мгновенно.
// Отчёт — текст, JUnit XML, TAP или Markdown; файлы кладутся в .data/tests/reports.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './arduino.mjs';
import { parseScenario, checkExpectations, reportText, reportJUnit, reportTAP, parseTrace } from './scenario.mjs';
import { simulate } from './native.mjs';

const TESTS_DIR = () => join(DATA_DIR, 'tests');
const REPORTS_DIR = () => join(TESTS_DIR(), 'reports');
const safeName = (n) => String(n || 'sketch').replace(/[^\w.\-А-Яа-яЁё ]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'sketch';
const scenarioFile = (name) => join(TESTS_DIR(), safeName(name) + '.mps');
const metaFile = (name) => join(TESTS_DIR(), safeName(name) + '.json');

function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }

/** Список тестов. */
export function listTests() {
  mkdirSync(TESTS_DIR(), { recursive: true });
  const out = [];
  for (const f of readdirSync(TESTS_DIR())) {
    if (!f.endsWith('.mps')) continue;
    const name = f.replace(/\.mps$/, '');
    const file = join(TESTS_DIR(), f);
    const meta = readJson(metaFile(name), {});
    const text = readFileSync(file, 'utf8');
    const parsed = parseScenario(text);
    out.push({
      name, file, bytes: statSync(file).size, steps: parsed.steps.length,
      errors: parsed.errors.length, errorList: parsed.errors,
      checks: parsed.steps.filter((s) => /^expect/.test(s.kind)).length,
      actions: parsed.steps.filter((s) => ['send', 'pin', 'adc', 'interrupt'].includes(s.kind)).length,
      baud: parsed.config.baud, duration: parsed.config.duration, fast: parsed.config.fast,
      lastRun: meta.lastRun || null, lastOk: meta.lastOk ?? null, sketch: meta.sketch || name,
    });
  }
  return { ok: true, dir: TESTS_DIR(), tests: out.sort((a, b) => String(b.lastRun || '').localeCompare(String(a.lastRun || ''))) };
}

/** Прочитать сценарий теста. */
export function getTest(name) {
  const file = scenarioFile(name);
  if (!existsSync(file)) return { ok: false, error: 'Тест не найден: ' + name };
  return { ok: true, name, scenario: readFileSync(file, 'utf8'), meta: readJson(metaFile(name), {}) };
}

/** Сохранить/создать тест. */
export function saveTest(name, scenario, meta = {}) {
  const parsed = parseScenario(scenario);
  mkdirSync(TESTS_DIR(), { recursive: true });
  writeFileSync(scenarioFile(name), String(scenario || ''));
  const cur = readJson(metaFile(name), {});
  writeFileSync(metaFile(name), JSON.stringify({ ...cur, ...meta, name, updated: Date.now() }, null, 2));
  return { ok: true, name, errors: parsed.errors, steps: parsed.steps.length, file: scenarioFile(name) };
}

export function deleteTest(name) {
  rmSync(scenarioFile(name), { force: true });
  rmSync(metaFile(name), { force: true });
  return { ok: true };
}

/**
 * Сгенерировать черновик теста по самому скетчу: берём строки, которые он
 * печатает в порт, и делаем из них ожидания. Дальше остаётся дописать
 * воздействия (что послать) — или запустить как есть.
 */
export function draftScenario({ files = [], baud = 9600, duration = 5000, fast = true } = {}) {
  const lines = [];
  lines.push('# Тест MicroPIDE. Один файл работает и на плате, и в симуляторе.');
  lines.push('# Команды: serial "…" | wait мс | pin D2 = 1 | adc A0 = 512 | expect "…" мс | expect_pin D13 = 1 мс');
  lines.push(`baud ${baud}`);
  lines.push(`duration ${duration}`);
  lines.push(fast ? 'fast on' : 'fast off');
  lines.push('');
  const printed = [];
  const code = files.map((f) => String(f.content || '')).join('\n');
  for (const m of code.matchAll(/Serial\s*\.\s*println\s*\(\s*(?:F\()?\s*"([^"\\]{2,60})"/g)) printed.push(m[1]);
  for (const m of code.matchAll(/Serial\s*\.\s*print\s*\(\s*(?:F\()?\s*"([^"\\]{2,60})"/g)) printed.push(m[1]);
  const uniq = [...new Set(printed)].slice(0, 6);
  if (uniq.length) {
    lines.push('# Ожидаем то, что скетч печатает:');
    for (const t of uniq) lines.push(`expect ${JSON.stringify(t.replace(/\n/g, '\\n'))} ${Math.max(500, Math.round(duration / 2))}`);
  } else {
    lines.push('# Скетч ничего не печатает — добавим ожидание переключения пина 13 (как в Blink):');
    lines.push('expect_pin D13 = 1 1500');
    lines.push('expect_pin D13 = 0 3000');
  }
  if (/Serial\s*\.\s*available|readString|parseInt/.test(code)) {
    lines.push('');
    lines.push('# Скетч читает порт — посылаем команду:');
    lines.push('serial "Hello\\n"');
    lines.push('expect_re /.+/ 2000');
  }
  return { ok: true, scenario: lines.join('\n') + '\n', expects: uniq.length };
}

/**
 * Прогон теста.
 * opts: {name, scenario?, files?, target: 'sim'|'board', port?, serial?, onLine, signal, timeoutMs}
 * serial — экземпляр SerialBridge (для реальной платы).
 */
export async function runTest(opts) {
  const {
    name = 'test', scenario: scenarioIn, files = [], target = 'sim', port = '',
    serial = null, onLine = () => {}, signal, timeoutMs = 120_000,
  } = opts;
  const say = (s) => onLine(s);
  const t0 = Date.now();
  let scenario = scenarioIn;
  if (scenario === undefined) {
    const t = getTest(name);
    if (t.ok === false) return { ok: false, error: t.error };
    scenario = t.scenario;
  }
  const parsed = parseScenario(scenario);
  if (!parsed.ok) return { ok: false, error: 'Сценарий с ошибками: ' + parsed.errors.map((e) => `стр. ${e.line}: ${e.text}`).join('; '), scenarioErrors: parsed.errors };
  const checks = parsed.steps.filter((s) => /^expect/.test(s.kind)).length;
  say(`Тест «${name}»: шагов ${parsed.steps.length}, проверок ${checks}, цель — ${target === 'board' ? 'плата ' + port : 'симулятор на ПК'}`);

  let res;
  if (target === 'sim') {
    const sim = await simulate({ name, files, scenario, onLine: say, timeoutMs, runChecks: true });
    if (sim.phase === 'build') return { ok: false, error: sim.error, detail: sim.detail, target, log: sim.log, phase: 'build' };
    res = {
      ok: sim.ok, results: sim.checks?.results || [], passed: sim.checks?.passed || 0, failed: sim.checks?.failed || 0,
      timeline: sim.timeline, pins: sim.pins, trace: sim.trace, summary: sim.summary,
      sim,
    };
    say(sim.checks ? reportText(name, { ok: sim.checks.ok, results: sim.checks.results, passed: sim.checks.passed, failed: sim.checks.failed }) : 'Проверок нет — сценарий только воздействует на устройство');
  } else {
    // ---- реальная плата: воздействия исполняем по-настоящему, ответы пишем в ленту
    if (!serial) return { ok: false, error: 'Нет серийного моста (сервер не отдал SerialBridge)' };
    if (!port) return { ok: false, error: 'Не выбран порт платы' };
    const open = await serial.open(port, parsed.config.baud);
    if (!open.ok) return { ok: false, error: open.error || 'не удалось открыть порт' };
    say(`Порт ${port} открыт на ${parsed.config.baud} бод`);
    const start = Date.now();
    const timeline = [];
    const pins = [];
    let cursor = serial.seq;
    const poll = () => {
      for (const it of serial.since(cursor)) {
        cursor = it.n;
        const t = it.t - start;
        if (it.kind === 'rx') timeline.push({ t, bytes: [...Buffer.from(String(it.text), 'utf8')], text: String(it.text) });
        else if (it.kind === 'err' || it.kind === 'sys') timeline.push({ t, bytes: [], text: '', note: it.text });
      }
    };
    const unsupported = [];
    let elapsed = 0;
    const waitUntil = async (ms) => {
      const until = Date.now() + Math.max(0, ms);
      while (Date.now() < until) {
        poll();
        if (signal?.aborted) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      elapsed += ms;
    };
    try {
      for (const st of parsed.steps) {
        poll();
        if (st.kind === 'send') {
          const txt = applyEol(st.text, parsed.config.eol);
          say(`→ ${JSON.stringify(txt)}`);
          const r = await serial.send(txt);
          if (!r.ok) { say('✗ не удалось отправить'); break; }
        } else if (st.kind === 'wait') {
          await waitUntil(st.ms);
        } else if (st.kind === 'pin' || st.kind === 'adc' || st.kind === 'interrupt') {
          unsupported.push({ line: st.line, text: st.kind === 'pin' ? `pin ${st.pin} = ${st.value}` : st.kind === 'adc' ? `adc ${st.pin} = ${st.value}` : `interrupt ${st.pin}` });
        } else if (/^expect/.test(st.kind)) {
          // ждём окно ещё до конца (проверка ниже, по ленте, но не выходим раньше ответа)
          const until = Date.now() + Math.min(st.within, 60_000);
          while (Date.now() < until) {
            poll();
            if (signal?.aborted) break;
            await new Promise((r) => setTimeout(r, 20));
          }
        }
      }
      poll();
      await waitUntil(150);
      poll();
    } finally {
      try { serial.close(); } catch { /* ignore */ }
    }
    if (unsupported.length) {
      say(`⚠ Воздействия на пины/АЦП (${unsupported.length} шт.) на реальной плате недоступны — проверьте их в симуляторе (строки ${unsupported.map((u) => u.line).join(', ')})`);
    }
    const check = checkExpectations(parsed.steps.filter((s) => s.kind !== 'pin' && s.kind !== 'adc' && s.kind !== 'interrupt'), timeline, pins);
    res = { ...check, timeline, pins, trace: timeline.map((e) => `${e.t}\tout\t${Buffer.from(e.bytes || []).toString('base64')}`).join('\n'), unsupported };
    say(reportText(name, check));
  }

  const durationMs = Date.now() - t0;
  const report = {
    ok: res.ok, name, target, port: target === 'board' ? port : '',
    at: Date.now(), durationMs, passed: res.passed, failed: res.failed,
    results: res.results || [], timeline: (res.timeline || []).slice(0, 4000), pins: res.pins || [],
    summary: res.summary || null, unsupported: res.unsupported || [],
    scenario: scenario.slice(0, 20_000),
    text: reportText(name, { ok: res.ok, results: res.results || [], passed: res.passed || 0, failed: res.failed || 0 }),
    junit: reportJUnit(name, { ok: res.ok, results: res.results || [], passed: res.passed || 0, failed: res.failed || 0, failedCount: res.failed }, { ms: durationMs }),
    tap: reportTAP(name, { ok: res.ok, results: res.results || [], passed: res.passed || 0, failed: res.failed || 0 }),
  };
  // метаданные теста: когда и чем закончился
  try {
    const meta = readJson(metaFile(name), {});
    writeFileSync(metaFile(name), JSON.stringify({ ...meta, lastRun: new Date().toISOString(), lastOk: report.ok, lastTarget: target, lastPassed: report.passed, lastFailed: report.failed }, null, 2));
  } catch { /* ignore */ }
  return report;
}

function applyEol(text, eol) {
  if (eol === 'none') return text;
  if (eol === 'cr') return text.replace(/\n$/, '') + '\r';
  if (eol === 'crlf') return text.replace(/\n$/, '') + '\r\n';
  return text.endsWith('\n') ? text : text + '\n';
}

/** Сохранить отчёт на диск (junit/md/tap). */
export function saveReport(report, fmt = 'md') {
  const dir = REPORTS_DIR();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `${safeName(report.name)}-${stamp}`;
  const files = [];
  const write = (suffix, text) => { const f = join(dir, base + suffix); writeFileSync(f, text); files.push(f); return f; };
  if (fmt === 'junit' || fmt === 'xml') write('.junit.xml', report.junit || '');
  else if (fmt === 'tap') write('.tap', report.tap || '');
  else if (fmt === 'all' || fmt === 'md') {
    const md = [
      `# Тест «${report.name}» — ${report.ok ? '✅ пройден' : '❌ провален'}`,
      '',
      `- Цель: ${report.target === 'board' ? 'плата ' + report.port : 'симулятор на ПК'}`,
      `- Когда: ${new Date(report.at).toLocaleString()}`,
      `- Длительность: ${report.durationMs} мс`,
      `- Проверок: пройдено ${report.passed}, провалено ${report.failed}`,
      '',
      '```',
      report.text || '',
      '```',
      '',
      '## Сценарий',
      '',
      '```',
      (report.scenario || '').trim(),
      '```',
      '',
    ].join('\n');
    write('.md', md);
    if (fmt === 'all') { write('.junit.xml', report.junit || ''); write('.tap', report.tap || ''); }
  } else throw new Error('Неизвестный формат отчёта: ' + fmt);
  return { ok: true, files, dir };
}

/** Прошлые отчёты. */
export function listReports(limit = 30) {
  const dir = REPORTS_DIR();
  if (!existsSync(dir)) return { ok: true, dir, reports: [] };
  const reports = readdirSync(dir).map((f) => {
    const full = join(dir, f);
    return { file: f, path: full, size: statSync(full).size, at: statSync(full).mtimeMs };
  }).sort((a, b) => b.at - a.at).slice(0, limit);
  return { ok: true, dir, reports };
}

/** Прочитать отчёт (для показа в интерфейсе). */
export function readReport(file) {
  const full = join(REPORTS_DIR(), String(file).replace(/[\\/]/g, ''));
  if (!existsSync(full)) return { ok: false, error: 'Отчёт не найден' };
  return { ok: true, file, text: readFileSync(full, 'utf8') };
}

export { parseTrace };
