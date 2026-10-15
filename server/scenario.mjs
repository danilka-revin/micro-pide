// Язык сценариев MicroPIDE (.mps) — общий и для симулятора на ПК, и для
// реальной платы (аппаратные тесты). Один файл описывает и воздействия на
// устройство, и ожидания от него; прогон даёт отчёт.
//
// Пример:
//   baud 9600
//   duration 3000
//   fast on
//   serial "START\n"
//   pin D2 = 1
//   adc A0 = 512
//   expect "OK" 500
//   expect_re /temp=\d+/ 1000
//   expect_pin D13 = 1 1000
//   expect_no "ERROR" 2000
//
// Строки выше — это шаги, которые исполняются по порядку. Воздействия меняют
// состояние пинов/АЦП/входа порта; ожидания ждут события в предстоящем окне
// времени. Ничего лишнего: файл читается и нашим C++-рантаймом (симулятор), и
// сервером (реальная плата) — поэтому он и является «тестом железа».

/** Разбор сценария в список шагов. */
export function parseScenario(text) {
  const steps = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  const sec = (name) => {
    const d = { duration: 30_000, fast: false, baud: 9600, loopLimit: 2_000_000, eol: '\n' };
    return d;
  };
  let cfg = sec();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const ln = i + 1;
    const m = /^([a-zA-Z_]+)(?:\s+(.*))?$/.exec(line);
    if (!m) { errors.push({ line: ln, text: 'Не понял строку: ' + raw.trim() }); continue; }
    const cmd = m[1].toLowerCase();
    const rest = (m[2] || '').trim();
    switch (cmd) {
      case 'baud': cfg.baud = Number(rest) || 9600; break;
      case 'duration': cfg.duration = Number(rest) || 30_000; break;
      case 'fast': cfg.fast = !/^(off|0|no|false|выкл)/i.test(rest); break;
      case 'eol': cfg.eol = rest === 'crlf' ? '\r\n' : rest === 'none' ? '' : rest === 'cr' ? '\r' : '\n'; break;
      case 'loop_limit': cfg.loopLimit = Number(rest) || 2_000_000; break;
      case 'name': case 'title': cfg.name = rest; break;
      case 'note': steps.push({ kind: 'note', text: rest, line: ln }); break;
      case 'serial': case 'send': steps.push({ kind: 'send', text: unquote(rest), line: ln }); break;
      case 'wait': steps.push({ kind: 'wait', ms: Number(rest) || 0, line: ln }); break;
      case 'pin': {
        const pm = /^([A-Za-z0-9_]+)\s*=\s*([01])$/.exec(rest);
        if (!pm) { errors.push({ line: ln, text: 'Формат: pin D2 = 1' }); break; }
        steps.push({ kind: 'pin', pin: pm[1], value: Number(pm[2]), line: ln });
        break;
      }
      case 'adc': case 'analog': {
        const am = /^([A-Za-z0-9_]+)\s*=\s*(-?\d+)$/.exec(rest);
        if (!am) { errors.push({ line: ln, text: 'Формат: adc A0 = 512' }); break; }
        steps.push({ kind: 'adc', pin: am[1], value: Number(am[2]), line: ln });
        break;
      }
      case 'pulse': {
        // pulse D3 = 0,200,1  — на 200 мс пин D3 переходит в 0, затем в 1
        const pm = /^([A-Za-z0-9_]+)\s*=\s*([01])\s*,\s*(\d+)\s*,\s*([01])$/.exec(rest);
        if (!pm) { errors.push({ line: ln, text: 'Формат: pulse D3 = 0,200,1' }); break; }
        steps.push({ kind: 'pin', pin: pm[1], value: Number(pm[2]), line: ln });
        steps.push({ kind: 'wait', ms: Number(pm[3]), line: ln });
        steps.push({ kind: 'pin', pin: pm[1], value: Number(pm[4]), line: ln });
        break;
      }
      case 'interrupt': {
        const im = /^([A-Za-z0-9_]+)\s*=\s*([A-Za-z_]+)$/.exec(rest);
        if (!im) { errors.push({ line: ln, text: 'Формат: interrupt D2 = RISING' }); break; }
        steps.push({ kind: 'interrupt', pin: im[1], mode: im[2].toUpperCase(), line: ln });
        break;
      }
      case 'expect': {
        const em = /^(?:"([^"]*)"|'([^']*)')(?:\s+(\d+))?$/.exec(rest);
        if (!em) { errors.push({ line: ln, text: 'Формат: expect "текст" [мс]' }); break; }
        steps.push({ kind: 'expect', text: em[1] ?? em[2] ?? '', within: Number(em[3] || 0) || cfg.defaultWithin || 2000, line: ln });
        break;
      }
      case 'expect_re': case 'expect_regex': {
        const em = /^(?:\/(.+)\/|"([^"]*)")(?:\s+(\d+))?$/.exec(rest);
        if (!em) { errors.push({ line: ln, text: 'Формат: expect_re /шаблон/ [мс]' }); break; }
        let re = em[1] ?? em[2] ?? '';
        try { new RegExp(re); } catch (e) { errors.push({ line: ln, text: 'Плохая регулярка: ' + re }); break; }
        steps.push({ kind: 'expectRe', pattern: re, within: Number(em[3] || 0) || 2000, line: ln });
        break;
      }
      case 'expect_no': {
        const em = /^(?:"([^"]*)"|'([^']*)'|\/(.+)\/)(?:\s+(\d+))?$/.exec(rest);
        if (!em) { errors.push({ line: ln, text: 'Формат: expect_no "текст" [мс]' }); break; }
        const isRe = em[3] !== undefined;
        steps.push({ kind: 'expectNo', text: isRe ? '' : (em[1] ?? em[2] ?? ''), pattern: isRe ? em[3] : null, within: Number(em[4] || 0) || 2000, line: ln });
        break;
      }
      case 'expect_pin': {
        const pm = /^([A-Za-z0-9_]+)\s*=\s*([01])(?:\s+(\d+))?$/.exec(rest);
        if (!pm) { errors.push({ line: ln, text: 'Формат: expect_pin D13 = 1 [мс]' }); break; }
        steps.push({ kind: 'expectPin', pin: pm[1], value: Number(pm[2]), within: Number(pm[3] || 0) || 2000, line: ln });
        break;
      }
      case 'expect_pwm': {
        const pm = /^([A-Za-z0-9_]+)\s*([<>=!]+)\s*(\d+)(?:\s+(\d+))?$/.exec(rest);
        if (!pm) { errors.push({ line: ln, text: 'Формат: expect_pwm D9 > 100 [мс]' }); break; }
        steps.push({ kind: 'expectPwm', pin: pm[1], op: pm[2], value: Number(pm[3]), within: Number(pm[4] || 0) || 2000, line: ln });
        break;
      }
      default:
        errors.push({ line: ln, text: 'Неизвестная команда: ' + cmd });
    }
  }
  return { ok: errors.length === 0, steps, errors, config: cfg };
}

function unquote(s) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s) || /^'((?:[^'\\]|\\.)*)'$/.exec(s);
  const body = m ? m[1] : s;
  return body.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * Прогон ожиданий по временной шкале устройства.
 * timeline: [{t, bytes, text}] — что устройство отправило (t в мс от старта),
 * pins:     [{t, pin, value|pwm}] — события пинов (если доступны),
 * opts:     {startAt} — с какого момента считать «сейчас» для шагов.
 *
 * Воздействия (send/pin/adc) в матчере не исполняются: их делает исполнитель
 * (симулятор или сервер с платой). Матчер ждёт окна времени, начиная с
 * виртуального времени шага.
 */
export function checkExpectations(steps, timeline, pins = [], opts = {}) {
  const results = [];
  let now = Number(opts.startAt || 0);
  const textOf = (from, to) => timeline.filter((e) => e.t >= from && e.t <= to).map((e) => e.text || '').join('');
  for (const st of steps) {
    switch (st.kind) {
      case 'note': results.push({ step: st, status: 'note', text: st.text }); break;
      case 'wait': now += st.ms; results.push({ step: st, status: 'ok', text: `пауза ${st.ms} мс` }); break;
      case 'send': case 'pin': case 'adc': case 'interrupt':
        results.push({ step: st, status: 'ok', text: 'воздействие: ' + describeAction(st) });
        break;
      case 'expect': {
        const until = now + st.within;
        const hay = textOf(now, until);
        const idx = hay.indexOf(st.text);
        if (idx >= 0) {
          const t = timeline.find((e) => e.t >= now && (e.text || '').includes(st.text));
          results.push({ step: st, status: 'ok', matched: st.text, at: t?.t ?? now, text: `«${st.text}» найдено`, elapsedMs: st.within });
          now = Math.max(now, t?.t ?? now);
        } else {
          results.push({ step: st, status: 'fail', text: `не дождались «${st.text}» за ${st.within} мс`, got: hay.slice(-400) });
        }
        break;
      }
      case 'expectRe': {
        const until = now + st.within;
        let re;
        try { re = new RegExp(st.pattern); } catch { re = null; }
        const hay = textOf(now, until);
        const m = re ? re.exec(hay) : null;
        if (m) {
          const t = timeline.find((e) => e.t >= now && re && re.test(e.text || ''))?.t ?? now;
          results.push({ step: st, status: 'ok', matched: m[0], at: t, text: `совпало: «${m[0]}»` });
        } else {
          results.push({ step: st, status: 'fail', text: `нет совпадений с /${st.pattern}/ за ${st.within} мс`, got: hay.slice(-400) });
        }
        break;
      }
      case 'expectNo': {
        const until = now + st.within;
        let re = null;
        if (st.pattern) { try { re = new RegExp(st.pattern); } catch { re = null; } }
        const hay = textOf(now, until);
        const bad = re ? re.test(hay) : hay.includes(st.text);
        if (!bad) results.push({ step: st, status: 'ok', text: `не появилось «${st.pattern || st.text}» — хорошо` });
        else results.push({ step: st, status: 'fail', text: `появилось запрещённое «${st.pattern || st.text}»`, got: hay.slice(-300) });
        break;
      }
      case 'expectPin': case 'expectPwm': {
        const until = now + st.within;
        const ev = pins.filter((e) => e.t >= now && e.t <= until && samePin(e.pin, st.pin));
        let hit = null;
        for (const e of ev) {
          if (st.kind === 'expectPin' && Number(e.value) === st.value) { hit = e; break; }
          if (st.kind === 'expectPwm') {
            const ok = st.op === '>' ? e.pwm > st.value : st.op === '<' ? e.pwm < st.value
              : st.op === '>=' ? e.pwm >= st.value : st.op === '<=' ? e.pwm <= st.value
                : st.op === '!=' ? e.pwm !== st.value : e.pwm === st.value;
            if (ok) { hit = e; break; }
          }
        }
        if (hit) {
          results.push({ step: st, status: 'ok', at: hit.t, text: st.kind === 'expectPin' ? `пин ${st.pin} = ${st.value}` : `PWM ${st.pin} ${st.op} ${st.value} (было ${hit.pwm})` });
          now = Math.max(now, hit.t);
        } else {
          results.push({ step: st, status: 'fail', text: `пин ${st.pin} не принял нужное значение за ${st.within} мс`, got: ev.map((e) => `t=${e.t} ${e.pwm ?? e.value}`).join(', ') || 'событий нет' });
        }
        break;
      }
      default:
        results.push({ step: st, status: 'skip', text: 'шаг не поддержан' });
    }
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  return { ok: failed === 0, failed, passed: results.filter((r) => r.status === 'ok').length, results };
}

function samePin(a, b) {
  const norm = (x) => String(x).replace(/^D/i, '').replace(/^A/i, 'A').toUpperCase();
  return norm(a) === norm(b);
}

function describeAction(st) {
  if (st.kind === 'send') return `послать ${JSON.stringify(st.text)}`;
  if (st.kind === 'pin') return `пин ${st.pin} → ${st.value}`;
  if (st.kind === 'adc') return `АЦП ${st.pin} → ${st.value}`;
  if (st.kind === 'interrupt') return `прерывание на ${st.pin} (${st.mode})`;
  return st.kind;
}

/** Текстовый отчёт (для консоли и для Markdown-файла). */
export function reportText(name, res) {
  const head = res.ok ? `✓ Тест «${name}» пройден` : `✗ Тест «${name}» провален`;
  const body = res.results.map((r) => {
    const mark = r.status === 'ok' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'note' ? '•' : '·';
    const where = r.at != null ? ` (t=${r.at} мс)` : '';
    let s = `${mark} [строка ${r.step.line}] ${r.text || ''}${where}`;
    if (r.status === 'fail' && r.got) s += `\n      получили: ${JSON.stringify(String(r.got).slice(-200))}`;
    return s;
  }).join('\n');
  return `${head}\n${body}\nИтог: пройдено ${res.passed}, провалено ${res.failed}`;
}

/** Отчёт в формате JUnit XML — его понимают CI, GitLab и GitHub Actions. */
export function reportJUnit(name, res, extra = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cases = res.results.filter((r) => r.status !== 'note').map((r) => {
    const cls = r.status === 'fail' ? 'failure' : null;
    return `    <testcase name="${esc(`строка ${r.step.line}: ${r.text || r.step.kind}`)}" classname="${esc(name)}" time="${((r.at ?? 0) / 1000).toFixed(3)}">` +
      (cls ? `\n      <failure message="${esc(r.text || '')}">${esc(r.got || '')}</failure>\n    ` : '') + `</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="MicroPIDE" tests="${res.results.length}" failures="${res.failed}" time="${((extra.ms || 0) / 1000).toFixed(3)}">\n  <testsuite name="${esc(name)}" tests="${res.results.length}" failures="${res.failed}">\n${cases}\n  </testsuite>\n</testsuites>\n`;
}

/** Отчёт TAP (для тех, кто любит простое). */
export function reportTAP(name, res) {
  const lines = ['TAP version 13', `1..${res.results.filter((r) => r.status !== 'note').length}`];
  let n = 0;
  for (const r of res.results) {
    if (r.status === 'note') continue;
    n++;
    lines.push(r.status === 'fail' ? `not ok ${n} - ${r.text}` : `ok ${n} - ${r.text}`);
  }
  lines.push(`# ${name}: пройдено ${res.passed}, провалено ${res.failed}`);
  return lines.join('\n') + '\n';
}

/** Разбор трассы симулятора: строки "<мс>\t<вид>\t<данные>". */
export function parseTrace(text) {
  const timeline = [];
  const pins = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const [t, kind, data] = line.split('\t');
    const ms = Number(t);
    if (!Number.isFinite(ms)) continue;
    if (kind === 'out') {
      let bytes = [];
      try { bytes = [...Buffer.from(String(data || ''), 'base64')]; } catch { bytes = []; }
      timeline.push({ t: ms, bytes, text: Buffer.from(bytes).toString('utf8') });
    } else if (kind === 'pin') {
      const m = /^(\d+)=([01])$/.exec(String(data || ''));
      if (m) pins.push({ t: ms, pin: Number(m[1]), value: Number(m[2]) });
    } else if (kind === 'pwm') {
      const m = /^(\d+)=(\d+)$/.exec(String(data || ''));
      if (m) pins.push({ t: ms, pin: Number(m[1]), pwm: Number(m[2]) });
    }
  }
  timeline.sort((a, b) => a.t - b.t);
  pins.sort((a, b) => a.t - b.t);
  return { timeline, pins, text: timeline.map((e) => e.text).join('') };
}
