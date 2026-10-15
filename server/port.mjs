// Перенос скетча на другую плату («Board Port») — то, чего нет ни в Arduino
// IDE, ни в PlatformIO: смена платы с пересчётом пинов, шин и разрядности АЦП.
//
// Что делает:
//   • читает, какие пины и как используются — включая заданные через #define и
//     const-переменные (LED_PIN, BTN и прочие «человеческие» имена);
//   • подбирает на новой плате пины с теми же возможностями и переписывает либо
//     сами объявления (одна правка вместо десяти), либо вызовы;
//   • доводит поведение до прежнего: analogReadResolution / analogWriteResolution,
//     предупреждения про 3.3 В, input-only, strapping и занятые пины;
//   • ругается на AVR-специфику (регистры DDRB/PORTB/TCCR, avr/pgmspace, sleep.h)
//     и на несовместимые библиотеки;
//   • оценивает, влезет ли скетч в флеш и ОЗУ новой платы (по своему анализатору);
//   • отдаёт готовые файлы + унифицированный диф, ничего не записывая на диск —
//     запись делает UI после подтверждения (или CLI по флагу --write).
import { boardCaps, findBoard } from './boarddb.mjs';
import { analogPinNumbers, pinLabel, resolvePin, sketchProfile, usesAnalogLabels } from './analysis.mjs';
import { extractCalls, maskCode, functionBody, constTable } from './cpp.mjs';
import { unifiedDiff } from './history.mjs';

/** Функции, у которых первый аргумент — пин. */
const PIN_FUNCS = new Set([
  'pinMode', 'digitalWrite', 'digitalRead', 'analogWrite', 'analogRead', 'tone', 'noTone',
  'pulseIn', 'attachInterrupt', 'digitalPinToInterrupt', 'shiftOut', 'shiftIn',
]);
const ADC_FUNCS = new Set(['analogRead']);
const IRQ_FUNCS = new Set(['attachInterrupt', 'digitalPinToInterrupt']);

/** Архитектуры, у которых можно задать разрядность АЦП/ШИМ из скетча. */
const ADC_RES_ARCHS = new Set(['esp32', 'samd', 'sam', 'mbed', 'rp2040', 'stm32', 'mbed_nano']);
const PWM_RES_ARCHS = new Set(['samd', 'sam', 'mbed', 'rp2040']);

/** Аппаратная специфика, которая не переезжает на другую архитектуру. */
const HW_SPECIFIC = [
  { re: /\b(DDR[A-K]|PORT[A-K]|PIN[A-K])\b/, what: 'прямая работа с регистрами AVR (порт)', how: 'замените на digitalWrite/pinMode' },
  { re: /\b(TCCR\d[ABC]?|TIMSK\d|OCR\d[ABC]?|ICR\d)\b/, what: 'регистры таймеров AVR', how: 'используйте tone()/analogWrite() или millis()' },
  { re: /\b(cli|sei|sleep_cpu|sleep_mode|wdt_)\s*\(/, what: 'AVR-макросы прерываний/сна', how: 'noInterrupts()/interrupts() или библиотека LowPower' },
  { re: /#\s*include\s*<\s*util\/[^>]+>/, what: 'заголовки util/* (AVR)', how: 'замените на функции Arduino' },
  { re: /\b_PROGMEM\b|\bPROGMEM\b|\bpgm_read_\w+/, what: 'флеш-память через PROGMEM', how: 'на новой плате просто держите строки в обычной памяти' },
  { re: /\bSoftwareSerial\b/, what: 'SoftwareSerial', how: 'у ESP32/SAMD есть аппаратные Serial1/Serial2 — переведите на них' },
  { re: /\bEEPROM\s*\./, what: 'EEPROM', how: 'есть почти везде, но у ESP32 адресация другая (Preferences)' },
];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const ROLE_RU = { adc: 'АЦП', pwm: 'ШИМ', irq: 'прерывание', servo: 'серво', tone: 'тон', shift: 'сдвиг', digital: 'цифровой' };

// --------------------------------------------------------------- символы

/** Пины, названные словами: строим таблицу имён и считаем их значения. */
export function symbolTable(files, caps) {
  const map = constTable(files);
  const valueOf = (sym, depth = 0) => {
    if (sym.pin !== undefined) return sym.pin;
    if (depth > 6) return null;
    const raw = String(sym.raw).trim();
    let pin = null;
    const ref = /^([A-Za-z_]\w*)$/.exec(raw);
    if (ref) {
      const other = map.get(ref[1]);
      if (other) pin = valueOf(other, depth + 1);
      if (pin == null) pin = macroValue(ref[1], caps);
    } else {
      pin = evalExpr(raw, caps);
      if (pin == null) {
        const op = /^([A-Za-z_]\w*)\s*([+\-*/])\s*(\d+)$/.exec(raw);
        if (op) {
          const base = map.has(op[1]) ? valueOf(map.get(op[1]), depth + 1) : macroValue(op[1], caps);
          if (base != null) pin = evalExpr(`${base}${op[2]}${op[3]}`, caps);
        }
      }
    }
    sym.pin = pin == null ? null : pin;
    return sym.pin;
  };
  for (const sym of map.values()) valueOf(sym);
  return map;
}

function macroValue(name, caps) {
  const r = resolvePin(name, caps);
  return r && r.pin != null ? num(r.pin) : null;
}

/** Простое числовое выражение или метка пина (A0, LED_BUILTIN…). */
function evalExpr(expr, caps) {
  const raw = String(expr ?? '').trim();
  if (!raw) return null;
  const direct = macroValue(raw, caps);
  if (direct != null) return direct;
  if (/^[\d\s+\-*/()xX<>.]+$/.test(raw) && /^[\d\s+\-*/()xX.]+$/.test(raw)) {
    try {
      const v = Function(`"use strict"; return (${raw.replace(/\b0[xX][0-9a-fA-F]+\b/g, (h) => Number(h))});`)();
      if (Number.isFinite(v)) return num(v);
    } catch { /* не выражение */ }
  }
  return null;
}

/** Разобрать выражение в пине с учётом платы и таблицы имён. */
export function pinOf(text, caps, symbols = null) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (symbols) {
    const sym = symbols.get(raw);
    if (sym && sym.pin != null) return { pin: sym.pin, analog: /^A\d+$/i.test(sym.raw), label: raw, sym };
  }
  const m = /^A(\d+)$/i.exec(raw);
  if (m && caps) {
    const n = num(analogPinNumbers(caps)[Number(m[1])]);
    if (n != null) return { pin: n, analog: true, label: raw.toUpperCase() };
  }
  const r = resolvePin(raw, caps);
  if (!r) return null;
  return { pin: num(r.pin), analog: /^A\d+$/i.test(raw), label: raw };
}

/** Границы первого аргумента-пина внутри вызова (для точечной замены). */
function argSpan(code, masked, c) {
  const open = masked.indexOf('(', c.index);
  if (open < 0) return null;
  let raw = c.args[0] ?? '';
  let off = c.argText.indexOf(raw);
  if (c.name === 'attachInterrupt') {
    const m = /digitalPinToInterrupt\s*\(\s*([^)\s]+)\s*\)/.exec(c.argText);
    if (m) { raw = m[1]; off = c.argText.indexOf(m[1], m.index); }
  }
  if (!raw || off < 0) return null;
  const start = open + 1 + off;
  return { raw, start, end: start + raw.length, line: c.line };
}

/** Все обращения к пинам: пин → роли, вызовы, символы, места в коде. */
export function collectPinUse(files, caps, symbols = symbolTable(files, caps)) {
  const byPin = new Map();
  const promises = [];
  for (const f of files || []) {
    const code = String(f.content ?? '');
    const masked = maskCode(code);
    for (const c of extractCalls(code, { names: PIN_FUNCS })) {
      const span = argSpan(code, masked, c);
      if (!span) continue;
      const p = pinOf(span.raw, caps, symbols);
      if (!p || p.pin == null) continue;
      promises.push({
        file: f.path, name: c.name, line: c.line, start: span.start, end: span.end, raw: span.raw,
        pin: p.pin, analog: p.analog || ADC_FUNCS.has(c.name), sym: p.sym || null,
      });
    }
    for (const c of extractCalls(code, { names: new Set(['attach']) })) {
      const before = code.slice(Math.max(0, c.index - 40), c.index);
      if (!/servo/i.test(before)) continue;
      const span = argSpan(code, masked, c);
      if (!span) continue;
      const p = pinOf(span.raw, caps, symbols);
      if (!p || p.pin == null) continue;
      promises.push({ file: f.path, name: 'servo.attach', line: c.line, start: span.start, end: span.end, raw: span.raw, pin: p.pin, analog: false, sym: p.sym || null });
    }
  }
  for (const rec of promises) {
    if (!byPin.has(rec.pin)) byPin.set(rec.pin, { pin: rec.pin, label: pinLabel(caps, rec.pin), funcs: new Set(), roles: new Set(), calls: [], symbols: new Set() });
    const u = byPin.get(rec.pin);
    u.funcs.add(rec.name);
    if (rec.sym) u.symbols.add(rec.sym.name);
    u.calls.push(rec);
    if (ADC_FUNCS.has(rec.name)) u.roles.add('adc');
    else if (rec.name === 'analogWrite') u.roles.add('pwm');
    else if (IRQ_FUNCS.has(rec.name)) u.roles.add('irq');
    else if (rec.name === 'tone' || rec.name === 'noTone') u.roles.add('tone');
    else if (rec.name === 'shiftOut' || rec.name === 'shiftIn') u.roles.add('shift');
    else if (rec.name === 'servo.attach') u.roles.add('servo');
    else u.roles.add('digital');
  }
  return { byPin, calls: promises, symbols };
}

/** Главная роль пина: чем «жаднее» ресурс, тем выше приоритет. */
function mainRole(roles) {
  for (const r of ['adc', 'pwm', 'irq', 'servo', 'tone', 'shift', 'digital']) if (roles.has(r)) return r;
  return 'digital';
}

/** Подобрать пины на новой плате. */
function allocate(byPin, capsTo, capsFrom) {
  const taken = new Set();
  const toDigital = (capsTo.digital || []).filter((n) => !capsTo.flashPins?.has(n));
  const toAnalog = analogPinNumbers(capsTo).filter((n) => Number.isFinite(n));
  const fromAnalog = analogPinNumbers(capsFrom).filter((n) => Number.isFinite(n));
  const toPwm = [...(capsTo.pwm || [])].sort((a, b) => a - b);
  const toIrq = [...(capsTo.interrupt || [])].sort((a, b) => a - b);
  const pools = { adc: toAnalog, pwm: toPwm, irq: toIrq, servo: toDigital, tone: toDigital, shift: toDigital, digital: toDigital };
  const out = new Map();
  const sources = [...byPin.values()].sort((a, b) => a.pin - b.pin);
  // аналоговые входы переносим «по номеру канала»: A0 → A0 новой платы
  for (const u of sources) {
    if (mainRole(u.roles) !== 'adc') continue;
    const idx = fromAnalog.indexOf(u.pin);
    if (idx < 0) continue;
    const pick = toAnalog[idx];
    if (pick == null || taken.has(pick)) continue;
    taken.add(pick);
    out.set(u.pin, { target: pick, role: 'adc', why: `тот же номер канала АЦП (${pinLabel(capsFrom, u.pin)} → ${pinLabel(capsTo, pick)})` });
  }
  for (const u of sources) {
    if (out.has(u.pin)) continue; // уже переведён по номеру канала АЦП
    const role = mainRole(u.roles);
    const pool = pools[role] || toDigital;
    if (pool.includes(u.pin) && !taken.has(u.pin) && !capsTo.inputOnly?.has(u.pin)) {
      taken.add(u.pin);
      out.set(u.pin, { target: u.pin, role, why: 'тот же номер есть и на новой плате' });
    }
  }
  for (const u of sources) {
    if (out.has(u.pin)) continue;
    const role = mainRole(u.roles);
    const pool = pools[role] || toDigital;
    const free = (n) => !taken.has(n) && !(role !== 'adc' && capsTo.inputOnly?.has(n));
    let pick = pool.find(free);
    if (pick == null) pick = toDigital.find(free);
    if (pick == null) pick = toAnalog.find((n) => !taken.has(n));
    if (pick == null) { out.set(u.pin, { target: null, role, why: 'на новой плате не нашлось подходящего пина' }); continue; }
    taken.add(pick);
    out.set(u.pin, {
      target: pick, role,
      why: `подобран по возможностям (${ROLE_RU[role] || role})${capsTo.reserved?.[pick] ? ' — внимание: ' + capsTo.reserved[pick] : ''}`,
    });
  }
  return out;
}

/** Текст пина для подстановки в конкретном вызове. */
function targetText(rec, call, capsTo) {
  if (call && ADC_FUNCS.has(call.name)) {
    const label = pinLabel(capsTo, rec.target);
    return label.startsWith('A') ? label : String(rec.target);
  }
  return String(rec.target);
}

/** План переноса. Ничего не пишет: правки, предупреждения, файлы, диф. */
export function portPlan({ from = '', to = '', files = [], name = 'sketch' } = {}) {
  const capsFrom = boardCaps(from);
  const capsTo = boardCaps(to);
  const boardTo = findBoard(to);
  if (!capsFrom) return { ok: false, error: `Не знаю исходную плату ${from || '(пусто)'}` };
  if (!capsTo) return { ok: false, error: `Не знаю плату-цель ${to || '(пусто)'}` };
  if (capsFrom.fqbn === capsTo.fqbn) return { ok: false, error: 'Платы совпадают — переносить нечего' };
  if (!files.length) return { ok: false, error: 'Нет файлов скетча' };

  const { byPin, symbols } = collectPinUse(files, capsFrom);
  const alloc = allocate(byPin, capsTo, capsFrom);
  const edits = [];
  const spans = new Map(); // file -> [{start,end,text}]
  const warnings = [];
  const seen = new Set();
  const warn = (level, text, extra = {}) => {
    const key = level + '|' + text;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push({ level, text, ...extra });
  };
  const addSpan = (file, start, end, text) => {
    if (!spans.has(file)) spans.set(file, []);
    const list = spans.get(file);
    if (list.some((s) => start < s.end && end > s.start)) return; // пересечение — пропускаем
    list.push({ start, end, text });
  };

  // ---- 1) пины ----
  for (const u of byPin.values()) {
    const a = alloc.get(u.pin);
    if (!a) continue;
    if (a.target == null) {
      warn('error', `Пин ${u.label} (${[...u.funcs].join('/')}) некуда перевести: у ${capsTo.name} нет подходящего пина`, { pin: u.pin });
      continue;
    }
    const roles = [...u.roles].join(', ');
    const same = a.target === u.pin;
    // 1a) пины, заданные своими именами: правим одно объявление
    for (const symName of u.symbols) {
      const sym = symbols.get(symName);
      if (!sym || sym.pin !== u.pin) continue;
      const after = same ? sym.raw : String(a.target);
      edits.push({
        file: sym.file, line: 1, kind: 'symbol', before: sym.raw, after,
        why: `#define/переменная ${symName} = ${sym.raw}: пин ${u.label} (${roles}) → ${pinLabel(capsTo, a.target)} — ${a.why}`,
      });
      if (!same) addSpan(sym.file, sym.start, sym.end, after);
    }
    // 1b) пины, написанные прямо в вызове
    for (const c of u.calls) {
      if (c.sym) continue;
      const after = same ? c.raw : targetText(a, c, capsTo);
      edits.push({
        file: c.file, line: c.line, kind: 'pin', call: c.name, before: c.raw, after,
        why: same ? `пин ${u.label} (${roles}) остаётся тем же: ${a.why}` : `пин ${u.label} (${roles}) → ${pinLabel(capsTo, a.target)}: ${a.why}`,
      });
      if (!same) addSpan(c.file, c.start, c.end, after);
    }
  }

  // ---- 2) разрядность АЦП/ШИМ: сохранить прежнее поведение ----
  const usesAdc = [...byPin.values()].some((u) => u.roles.has('adc'));
  const usesPwm = [...byPin.values()].some((u) => u.roles.has('pwm'));
  const insertions = [];
  const adapter = [];
  if (usesAdc && capsTo.adcBits && capsFrom.adcBits && capsTo.adcBits !== capsFrom.adcBits) {
    if (ADC_RES_ARCHS.has(boardTo?.arch || '')) {
      insertions.push(`analogReadResolution(${capsFrom.adcBits});  // MicroPIDE: сохранить ${capsFrom.adcBits}-битный диапазон АЦП`);
      adapter.push(`analogReadResolution(${capsFrom.adcBits}) — значения analogRead останутся 0…${(1 << capsFrom.adcBits) - 1}`);
    } else {
      warn('warn', `АЦП: у ${capsFrom.name} ${capsFrom.adcBits} бит, у ${capsTo.name} ${capsTo.adcBits} — константы вида ${(1 << capsFrom.adcBits) - 1} придётся пересчитать`, { kind: 'adc' });
    }
  }
  if (usesPwm && capsTo.pwmBits && capsFrom.pwmBits && capsTo.pwmBits !== capsFrom.pwmBits) {
    if (PWM_RES_ARCHS.has(boardTo?.arch || '')) {
      insertions.push(`analogWriteResolution(8);  // MicroPIDE: ШИМ как на ${capsFrom.name}`);
      adapter.push('analogWriteResolution(8) — значения analogWrite останутся 0…255');
    } else if (boardTo?.arch === 'esp32' || boardTo?.arch === 'esp8266') {
      adapter.push('analogWrite здесь — это LEDC/ШИМ-канал: значения 0…255 сохраняются, а частота другая (у LEDC по умолчанию ~1 кГц)');
    }
  }

  // ---- 3) питание, занятые и особые пины ----
  if (capsFrom.voltage !== capsTo.voltage) {
    warn('warn', `Питание: ${capsFrom.voltage} В → ${capsTo.voltage} В. Проверьте делители, подтяжки, реле и драйверы: ${capsTo.voltage} В логика не терпит 5 В на входе`, { kind: 'voltage' });
    if (capsFrom.voltage > capsTo.voltage) warn('info', 'Совет: питать внешние модули от отдельного 5 В, а сигналы согласовать делителем или уровнемером', { kind: 'voltage' });
  }
  for (const u of byPin.values()) {
    const a = alloc.get(u.pin);
    if (!a || a.target == null) continue;
    if (capsTo.inputOnly?.has(a.target) && !u.roles.has('adc')) warn('error', `Пин ${pinLabel(capsTo, a.target)} только вход — из него не сделать выход (${[...u.funcs].join('/')})`, { pin: a.target });
    if (capsTo.strapping?.has(a.target)) warn('warn', `Пин ${pinLabel(capsTo, a.target)} — загрузочный (strapping): состояние на нём влияет на старт платы`, { pin: a.target });
    if (capsTo.reserved?.[a.target]) warn('warn', `Пин ${pinLabel(capsTo, a.target)} на плате занят: ${capsTo.reserved[a.target]}`, { pin: a.target });
    if (capsTo.dac?.has(a.target)) warn('info', `Пин ${pinLabel(capsTo, a.target)} — настоящий ЦАП: analogWrite даст реальное аналоговое напряжение`, { pin: a.target });
  }

  // ---- 4) архитектурная специфика и библиотеки ----
  const allText = files.map((f) => String(f.content ?? '')).join('\n');
  const masked = maskCode(allText);
  for (const h of HW_SPECIFIC) {
    if (!(h.re.test(masked) || h.re.test(allText))) continue;
    warn('error', `${h.what} — не переезжает на ${capsTo.name}: ${h.how}`, { kind: 'arch' });
  }
  const includes = [...new Set([...allText.matchAll(/#\s*include\s*[<"]([^">]+)[">]/g)].map((m) => m[1]))];
  const avrOnly = includes.filter((i) => /^(avr|util|wdt|avr\/sleep)/i.test(i));
  if (avrOnly.length) warn('error', `AVR-заголовки: ${avrOnly.join(', ')} — на новой плате их нет`, { kind: 'arch' });
  if (/Wire\s*\./.test(masked) && !includes.some((i) => /Wire/.test(i))) warn('info', 'Wire используется без #include <Wire.h> — при переносе может не собраться', { kind: 'lib' });
  if (capsTo.uart && capsFrom.uart && capsTo.uart.rx !== capsFrom.uart.rx && /\bSerial\s*\./.test(masked)) {
    warn('info', `Serial теперь на пинах RX=${capsTo.uart.rx}, TX=${capsTo.uart.tx} — если вы использовали 0/1 напрямую, поправьте`, { kind: 'uart' });
  }
  if (/\btone\s*\(/.test(masked) && boardTo?.arch === 'esp32') warn('info', 'tone() на ESP32 — это ШИМ-тон на LEDC: каналы ограничены', { kind: 'tone' });
  const analogNames = [...new Set([...allText.matchAll(/\bA(\d+)\b/g)].map((m) => m[0]))];
  if (analogNames.length && !usesAnalogLabels(capsFrom)) {
    warn('warn', `Имена вида ${analogNames.slice(0, 4).join(', ')} — привычка AVR: у ${capsFrom.name} таких пинов нет, я пересчитал их по номеру канала АЦП. Проверьте, что канал тот самый`, { kind: 'adc' });
  }

  // ---- 5) влезет ли скетч ----
  try {
    const prof = sketchProfile({ files, fqbn: from });
    const flash = prof?.flashEstimate;
    const ram = prof?.globalsBytes;
    if (flash && capsTo.flash) {
      if (flash > capsTo.flash) warn('error', `Оценка размера кода ~${flash} Б не влезает во флеш ${capsTo.name} (${capsTo.flash} Б)`, { kind: 'size' });
      else warn('info', `Прикидка: код ~${flash} Б из ${capsTo.flash} Б флеш (${Math.round((flash / capsTo.flash) * 100)}%)`, { kind: 'size' });
    }
    if (ram && capsTo.ram && ram > capsTo.ram * 0.7) warn('warn', `Глобальные переменные ${ram} Б — при ОЗУ ${capsTo.ram} Б это уже много`, { kind: 'size' });
  } catch { /* оценка не обязательна */ }

  // ---- 6) применяем правки к копиям файлов ----
  const outFiles = files.map((f) => ({ path: f.path, content: String(f.content ?? '') }));
  const setupFile = (files.find((f) => /\.ino$/i.test(f.path)) || files[0]).path;
  if (insertions.length) {
    const target = outFiles.find((f) => f.path === setupFile);
    const body = target ? functionBody(target.content, 'setup') : null;
    if (target && body) {
      const pad = '  ';
      target.content = target.content.slice(0, body.start + 1) + '\n' + insertions.map((c) => pad + c).join('\n') + '\n' + target.content.slice(body.start + 1);
    } else {
      for (const c of insertions) warn('warn', `Не нашёл setup(), добавьте вручную: ${c}`, { kind: 'adapter' });
    }
  }
  for (const [file, list] of spans) {
    const target = outFiles.find((f) => f.path === file);
    if (!target) continue;
    let text = target.content;
    for (const s of [...list].sort((a, b) => b.start - a.start)) text = text.slice(0, s.start) + s.text + text.slice(s.end);
    target.content = text;
  }

  const realEdits = edits.filter((e) => e.before !== e.after);
  let diff = '';
  for (const f of outFiles) {
    const src = files.find((x) => x.path === f.path);
    if (!src || String(src.content) === f.content) continue;
    diff += (unifiedDiff(String(src.content), f.content, { labelA: f.path, labelB: f.path + ' (после переноса)' }).text || '') + '\n';
  }

  return {
    ok: true,
    name,
    from: { fqbn: capsFrom.fqbn, name: capsFrom.name, mcu: capsFrom.mcu, arch: findBoard(from)?.arch || '', voltage: capsFrom.voltage, adcBits: capsFrom.adcBits },
    to: { fqbn: capsTo.fqbn, name: capsTo.name, mcu: capsTo.mcu, arch: boardTo?.arch || '', voltage: capsTo.voltage, adcBits: capsTo.adcBits },
    mapping: [...byPin.values()].map((u) => {
      const a = alloc.get(u.pin) || {};
      return {
        from: u.label, to: a.target == null ? '' : pinLabel(capsTo, a.target), pin: u.pin, target: a.target ?? null,
        roles: [...u.roles], funcs: [...u.funcs], symbols: [...u.symbols], why: a.why || '',
      };
    }),
    edits: realEdits,
    adapter,
    warnings,
    files: outFiles,
    diff,
    stats: { pins: byPin.size, edits: realEdits.length, warnings: warnings.length, errors: warnings.filter((w) => w.level === 'error').length },
  };
}

/** Горячие точки переноса: что чаще всего ломается — подсказка в UI и CLI. */
export function portChecklist(to = '') {
  const caps = boardCaps(to);
  const b = findBoard(to);
  if (!caps || !b) return { ok: false, error: 'Неизвестная плата' };
  const items = [
    { what: `Питание ${caps.voltage} В`, how: caps.voltage < 5 ? 'согласуйте 5-вольтовые модули (делитель/уровнемер)' : 'проверьте, что модули выдержат 5 В логику' },
    { what: `АЦП ${caps.adcBits} бит`, how: `значения analogRead 0…${(1 << caps.adcBits) - 1}` },
    { what: `ШИМ ${caps.pwmBits} бит`, how: `пины: ${[...caps.pwm].slice(0, 10).join(', ')}${caps.pwm.size > 10 ? '…' : ''}` },
  ];
  if (caps.inputOnly.size) items.push({ what: `Только вход: ${[...caps.inputOnly].join(', ')}`, how: 'на выход их использовать нельзя' });
  if (caps.flashPins.size) items.push({ what: `Служебные пины: ${[...caps.flashPins].join(', ')}`, how: 'заняты флеш-памятью — не трогать' });
  if (caps.strapping.size) items.push({ what: `Загрузочные (strapping): ${[...caps.strapping].join(', ')}`, how: 'не вешайте кнопки и реле без учёта загрузки' });
  items.push({ what: `UART: RX ${caps.uart?.rx ?? '—'}, TX ${caps.uart?.tx ?? '—'}`, how: 'Serial.print идёт в USB-мост' });
  items.push(...(caps.hints || []).map((h) => ({ what: h, how: '' })));
  return { ok: true, board: { fqbn: caps.fqbn, name: caps.name, mcu: caps.mcu, arch: b.arch }, items };
}
