// Анализатор скетчей MicroPIDE — «умный помощник», которого нет в Arduino IDE.
//
// Что делает:
//   • линтер под возможности конкретной платы (пинов, PWM, ADC, прерываний, флеш-пинов);
//   • карта пинов: кто что занимает, конфликты, свободные ноги;
//   • оценка скетча по категориям (порты, тайминги, память, безопасность, стиль);
//   • генерация документации: README.md, схема подключения (Mermaid), BOM;
//   • генерация pins.h — именованные пины вместо «магических» чисел;
//   • профилирование: обёртка вокруг loop() печатает реальные времена итераций;
//   • телеметрия MicroTelem: свой формат кадров + генератор заголовка и парсер.
//
// Всё офлайн: никаких серверов, никакого arduino-cli — только наша база плат и C++.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { boardCaps, findBoard, DATA_DIR, LIBRARY_CATALOG } from './boarddb.mjs';
import { sketchbookDir } from './sketches.mjs';
import {
  maskCode, lineOf, columnOf, findFunctions, findIncludes, braceBalance, extractCalls,
  functionBody, findVarDecls, isAssignment, splitArgs, matchBracket,
  constTable,
  crc16,
} from './cpp.mjs';

// ------------------------------------------------------------------ вспомогательное

const sv = { error: 3, warn: 2, info: 1 };
const sortFindings = (a, b) => sv[b.severity] - sv[a.severity] || a.line - b.line || a.id.localeCompare(b.id);

const num = (x) => (Number.isFinite(x) ? x : null);

// Аналоговые пины в базе плат названы «A0»…«An» (как в Arduino). Чтобы сравнивать
// их с номерами, которые выводит компилятор, нужна база нумерации для AVR-ядер:
// у ATmega328 это 14, у ATmega32U4 — 18, у ATmega2560 — 54 (стандарт Arduino).
const AVR_ANALOG_BASE = { ATmega2560: 54, ATmega32U4: 18, ATmega328P: 14, ATmega168: 14, ATmega1280: 54, ATmega4809: 14 };

/** Номера аналоговых входов платы (A0 → 14 и т. п.). */
export function analogPinNumbers(caps) {
  if (!caps) return [];
  const list = caps.analog || [];
  if (list.every((a) => typeof a === 'number')) return list.map(Number);
  const base = AVR_ANALOG_BASE[caps.mcu] ?? (list.every((a) => /^A\d+$/.test(String(a))) ? 14 : null);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (typeof a === 'number') { out.push(a); continue; }
    const m = /^A(\d+)$/.exec(String(a));
    if (m && base != null) out.push(base + Number(m[1]));
    else if (m) out.push(Number(m[1]));
    else if (Number.isFinite(Number(a))) out.push(Number(a));
    else out.push(NaN);
  }
  return out;
}

/**
 * Плата называет аналоговые входы как A0… (AVR-стиль) или обычными номерами
 * (ESP32/SAMD/RP2040: там GPIO-номер и есть номер канала).
 */
export function usesAnalogLabels(caps) {
  if (!caps) return false;
  if (AVR_ANALOG_BASE[caps.mcu]) return true;
  return (caps.analog || []).length > 0 && (caps.analog || []).every((a) => /^A\d+$/i.test(String(a)));
}

/** Имя пина как его видит пользователь: 13 → D13, 14 → A0 (только AVR-платы). */
export function pinLabel(caps, pin) {
  if (pin == null) return '?';
  if (usesAnalogLabels(caps)) {
    const idx = analogPinNumbers(caps).findIndex((n) => n === pin);
    if (idx >= 0) return `A${idx}`;
  }
  return `D${pin}`;
}

const PIN_MACROS = {
  LED_BUILTIN: 'led', SS: 'spi.ss', MOSI: 'spi.mosi', MISO: 'spi.miso', SCK: 'spi.sck',
  SDA: 'i2c.sda', SCL: 'i2c.scl', A0: 14, A1: 15, A2: 16, A3: 17, A4: 18, A5: 19,
};

/**
 * Превратить аргумент-выражение в номер пина с учётом платы.
 * Понимает 13, A0, LED_BUILTIN, SDA, SCL, SS…
 */
let ACTIVE_CONSTS = null;

/**
 * Выполнить функцию с активной таблицей имён (#define LED 13 и т. п.), чтобы
 * resolvePin понимал «человеческие» имена пинов. Состояние локальное:
 * Node однопоточный, а вложенные вызовы восстановят предыдущее значение.
 */
export function withConsts(consts, fn) {
  const prev = ACTIVE_CONSTS;
  ACTIVE_CONSTS = consts || null;
  try { return fn(); } finally { ACTIVE_CONSTS = prev; }
}

export function activeConsts() { return ACTIVE_CONSTS; }

export function resolvePin(expr, caps, depth = 0) {
  const raw = String(expr ?? '').trim();
  if (!raw) return null;
  if (depth < 6 && ACTIVE_CONSTS && /^[A-Za-z_]\w*$/.test(raw) && ACTIVE_CONSTS.has(raw)) {
    const sym = ACTIVE_CONSTS.get(raw);
    const inner = resolvePin(String(sym.raw).trim(), caps, depth + 1);
    if (inner && inner.pin != null) return { pin: inner.pin, how: raw, sym, viaConst: sym.name };
  }
  if (/^LED_BUILTIN$/i.test(raw)) return { pin: num(caps?.led), how: 'LED_BUILTIN' };
  const macro = PIN_MACROS[raw.toUpperCase()];
  if (typeof macro === 'number') return { pin: macro, how: raw };
  if (typeof macro === 'string' && caps) {
    const [bus, key] = macro.split('.');
    const v = caps[bus]?.[key];
    if (v != null) return { pin: num(v), how: raw };
  }
  const m = /^(\d+)$/.exec(raw);
  if (m) return { pin: Number(m[1]), how: raw };
  const named = /^A(\d+)$/i.exec(raw);
  if (named && caps) {
    const a = caps.analog[Number(named[1])];
    if (a != null) return { pin: num(a), how: raw };
  }
  if (/^PIN_([AD])(\d+)$/i.test(raw)) return resolvePin(raw.replace(/^PIN_/i, ''), caps);
  return null;
}

function isPinAvailable(caps, pin) {
  if (!caps || pin == null) return true;
  return (caps.digital || []).includes(pin) || analogPinNumbers(caps).includes(pin);
}

function analogChannelPin(caps, pin) {
  if (!caps) return true;
  return analogPinNumbers(caps).includes(pin);
}

function libNameForInclude(inc) {
  const base = String(inc).replace(/\.h$/i, '').toLowerCase();
  const hit = LIBRARY_CATALOG.find((l) => (l.contains || []).some((c) => String(c).replace(/\.h$/i, '').toLowerCase() === base));
  return hit ? hit.name : '';
}

/** Библиотеки, установленные в скетчбуке (по каталогам libraries/<Name>). */
export function installedLibraries() {
  const dir = join(sketchbookDir(), 'libraries');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch { return []; }
}

// ------------------------------------------------------------------ сбор данных о пинах

const PIN_FUNCS = new Set([
  'pinMode', 'digitalWrite', 'digitalRead', 'analogWrite', 'analogRead', 'analogReference',
  'attachInterrupt', 'digitalPinToInterrupt', 'tone', 'noTone', 'pulseIn', 'shiftOut', 'shiftIn', 'attach',
]);
/** Пины АЦП2 у ESP32: с работающим Wi-Fi не читаются. */
const ESP32_ADC2 = new Set([0, 2, 4, 12, 13, 14, 15, 25, 26, 27]);

const ROLE_BY_FUNC = {
  pinMode: 'режим', digitalWrite: 'выход', digitalRead: 'вход',
  analogWrite: 'ШИМ', analogRead: 'аналоговый вход', attachInterrupt: 'прерывание',
  digitalPinToInterrupt: 'прерывание', tone: 'тон', noTone: 'тон', pulseIn: 'импульс',
  shiftOut: 'сдвиг', shiftIn: 'сдвиг', attach: 'серво',
};

/**
 * Кто какие пины использует: роли, строки, особенности платы.
 * Возвращает Map<номер пина, запись>.
 */
export function collectPinUsage(files, caps) {
  const usage = new Map();
  const touch = (pin, patch) => {
    if (pin == null || !Number.isFinite(pin)) return null;
    if (!usage.has(pin)) {
      usage.set(pin, {
        pin, label: pinLabel(caps, pin), roles: new Set(), funcs: new Set(), lines: [], modes: new Set(), values: [],
        exists: isPinAvailable(caps, pin), pwm: caps?.pwm?.has(pin) || false,
        adc: analogChannelPin(caps, pin), interrupt: caps?.interrupt?.has(pin) || false,
        inputOnly: caps?.inputOnly?.has(pin) || false, flash: caps?.flashPins?.has(pin) || false,
        reserved: (caps?.reserved || {})[pin] || '', led: caps?.led === pin,
      });
    }
    const rec = usage.get(pin);
    if (patch.role) rec.roles.add(patch.func === 'analogWrite' && !rec.pwm ? 'analogWrite (нет ШИМ)' : patch.role);
    if (patch.func) rec.funcs.add(patch.func);
    if (patch.line) rec.lines.push(patch.line);
    if (patch.mode) rec.modes.add(patch.mode);
    if (patch.value != null) rec.values.push(patch.value);
    return rec;
  };

  for (const f of files || []) {
    const code = String(f.content ?? '');
    const calls = extractCalls(code, { names: PIN_FUNCS });
    for (const c of calls) {
      switch (c.name) {
        case 'pinMode': {
          const p = resolvePin(c.args[0], caps);
          const mode = String(c.args[1] || '').trim().toUpperCase();
          touch(p?.pin, { func: c.name, role: mode === 'OUTPUT' ? 'выход' : mode === 'INPUT_PULLUP' ? 'вход с подтяжкой' : 'настройка режима', line: f.path + ':' + c.line, mode });
          break;
        }
        case 'digitalWrite': case 'digitalRead': case 'analogWrite': case 'analogRead': case 'tone': case 'noTone': case 'pulseIn': {
          const p = resolvePin(c.args[0], caps);
          touch(p?.pin, { func: c.name, role: ROLE_BY_FUNC[c.name], line: f.path + ':' + c.line, value: c.name === 'analogWrite' ? Number(c.args[1]) : null });
          break;
        }
        case 'attachInterrupt': case 'digitalPinToInterrupt': {
          const inner = /digitalPinToInterrupt\s*\(([^)]+)\)/.exec(c.argText || '');
          const p = resolvePin(inner ? inner[1] : c.args[0], caps);
          touch(p?.pin, { func: c.name, role: ROLE_BY_FUNC[c.name], line: f.path + ':' + c.line });
          break;
        }
        case 'shiftOut': case 'shiftIn': {
          const dataPin = resolvePin(c.args[0], caps);
          const clkPin = resolvePin(c.args[1], caps);
          touch(dataPin?.pin, { func: c.name, role: 'сдвиг (данные)', line: f.path + ':' + c.line });
          touch(clkPin?.pin, { func: c.name, role: 'сдвиг (такт)', line: f.path + ':' + c.line });
          break;
        }
        case 'attach': {
          if (/\.attach\s*$/.test(String(code.slice(Math.max(0, c.index - 40), c.index)).trimEnd()) || /servo/i.test(code.slice(Math.max(0, c.index - 40), c.index))) {
            const p = resolvePin(c.args[0], caps);
            touch(p?.pin, { func: 'Servo.attach', role: 'сервопривод', line: f.path + ':' + c.line });
          }
          break;
        }
        default: break;
      }
    }
    // Serial/шины помечаем отдельно
    if (/\bSerial\s*\./.test(maskCode(code)) && caps?.uart) {
      touch(caps.uart.rx, { func: 'Serial', role: 'UART RX (занят)' });
      touch(caps.uart.tx, { func: 'Serial', role: 'UART TX (занят)' });
    }
    if (/\bWire\s*\./.test(maskCode(code))) {
      touch(caps?.i2c?.sda, { func: 'Wire', role: 'I2C SDA' });
      touch(caps?.i2c?.scl, { func: 'Wire', role: 'I2C SCL' });
    }
    if (/\bSPI\s*\./.test(maskCode(code))) {
      touch(caps?.spi?.mosi, { func: 'SPI', role: 'SPI MOSI' });
      touch(caps?.spi?.miso, { func: 'SPI', role: 'SPI MISO' });
      touch(caps?.spi?.sck, { func: 'SPI', role: 'SPI SCK' });
      touch(caps?.spi?.ss, { func: 'SPI', role: 'SPI SS' });
    }
  }
  return usage;
}

/**
 * Карта пинов для UI: занятые, свободные, конфликты.
 * Понимает пины, названные через #define и const-переменные.
 */
export function pinMap(opts = {}) {
  return withConsts(constTable(opts.files || []), () => pinMapInner(opts));
}

function pinMapInner({ files = [], fqbn = '' } = {}) {
  const caps = boardCaps(fqbn);
  const usage = collectPinUsage(files, caps);
  const pins = [...usage.values()].map((r) => ({
    pin: r.pin, label: r.label, roles: [...r.roles], funcs: [...r.funcs].sort(), lines: r.lines,
    exists: r.exists !== false,
    outputs: [...r.roles].some((x) => /выход|ШИМ|серво|тон/.test(x)),
    inputs: [...r.roles].some((x) => /вход/.test(x)),
    pwm: r.pwm, adc: r.adc, interrupt: r.interrupt, inputOnly: r.inputOnly, flash: r.flash,
    reserved: r.reserved, led: r.led, conflicts: [], notes: [],
  })).sort((a, b) => a.pin - b.pin);

  for (const p of pins) {
    if (p.outputs && p.inputs) p.conflicts.push('пин используется и как вход, и как выход');
    if (p.inputOnly && p.outputs) p.conflicts.push('этот пин только вход — выход невозможен');
    if (p.flash) p.conflicts.push('пин флеш-памяти — трогать нельзя');
    if (!p.exists) p.conflicts.push('такого пина нет на выбранной плате');
    if (p.reserved) p.notes.push('на плате занят: ' + p.reserved);
    if (p.adc && /аналоговый вход/.test(p.roles.join())) p.notes.push(p.pwm ? 'можно и как ШИМ' : 'только вход');
    if (p.led) p.notes.push('встроенный светодиод');
  }

  const used = new Set(pins.map((p) => p.pin));
  const free = (caps?.digital || []).filter((n) => !used.has(n));
  const byRole = {};
  for (const p of pins) for (const r of p.roles) byRole[r] = (byRole[r] || 0) + 1;
  return {
    ok: true, fqbn, board: caps ? { name: caps.name, mcu: caps.mcu, fqbn: caps.fqbn, flash: caps.flash, ram: caps.ram, adcBits: caps.adcBits } : null,
    pins, free, unused: free, byRole,
    stats: {
      used: pins.length, free: free.length, total: (caps?.digital || []).length,
      pwmUsed: pins.filter((p) => p.pwm).length, adcUsed: pins.filter((p) => p.adc).length,
      pwmFree: [...(caps?.pwm || [])].filter((n) => !used.has(n)),
      adcFree: analogPinNumbers(caps).filter((n) => Number.isFinite(n) && !used.has(n)),
      adcPins: analogPinNumbers(caps).filter(Number.isFinite),
      conflicts: pins.reduce((a, p) => a + p.conflicts.length, 0),
    },
    mermaid: mermaidFromPins(pins),
  };
}

function mermaidFromPins(pins) {
  const lines = ['graph LR', '  MCU["плата"]'];
  let i = 1;
  for (const p of pins) {
    if (!p.outputs && !p.inputs) continue;
    const id = 'P' + i++;
    const what = p.roles.filter((r) => !/занят|режим|настройка режима/.test(r)).join(', ') || 'пин';
    lines.push(`  MCU -- "${p.label}" --> ${id}["${what}"]`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ линтер

function codeOf(files, path) {
  const f = (files || []).find((x) => x.path === path);
  return f ? String(f.content ?? '') : '';
}

function finding(id, severity, file, line, message, extra = {}) {
  return { id, severity, file, line, col: extra.col || 1, message, hint: extra.hint || '', fix: extra.fix || null, ...extra, hint: extra.hint || '', ...(extra.text ? {} : {}) };
}

/**
 * Анализ скетча целиком: находки линтера, карта пинов, сводка и оценка.
 * opts: {files, fqbn, baud, installedLibs, name}
 */
export function analyze(opts = {}) {
  return withConsts(constTable(opts.files || []), () => analyzeInner(opts));
}

function analyzeInner({ files = [], fqbn = '', baud = 0, installedLibs = null, name = '' } = {}) {
  const board = findBoard(fqbn);
  const caps = boardCaps(fqbn);
  const out = [];
  const libs = installedLibs || installedLibraries();
  const mainFile = files.find((f) => /\.ino$/i.test(f.path)) || files[0] || { path: '', content: '' };

  const wholeMasked = files.map((f) => maskCode(String(f.content ?? ''))).join('\n');
  const mainFns = findFunctions(String(mainFile.content ?? ''));
  const allFns = files.flatMap((f) => findFunctions(String(f.content ?? '')).map((x) => ({ ...x, file: f.path })));
  const setup = functionBody(String(mainFile.content ?? ''), 'setup');
  const loop = functionBody(String(mainFile.content ?? ''), 'loop');
  const includes = files.flatMap((f) => findIncludes(String(f.content ?? '')).map((x) => ({ ...x, file: f.path })));
  const allCalls = files.flatMap((f) => extractCalls(String(f.content ?? '')).map((c) => ({ ...c, file: f.path })));
  // Обработчики прерываний: по имени (onP, ISR_…) собираем тела через functionBody —
  // иначе проверять внутри прерывания нечего.
  const isrs = allFns
    .filter((f) => f.hasBody && (f.args || []).length === 0 && /^(on[A-Z_]|isr)/i.test(f.short))
    .map((f) => ({ ...f, body: functionBody(codeOf(files, f.file), f.short, { last: true })?.body || '' }))
    .filter((f) => f.body);

  const add = (id, severity, file, line, message, extra) => out.push(finding(id, severity, file, line, message, extra));

  // ---------- структура скетча
  if (!fqbn) add('no-fqbn', 'warn', mainFile.path, 1, 'Плата не выбрана: проверка пинов и сборка невозможны.', { hint: 'Выберите плату в панели «Платы» или включите плату micropide:sim:sim для проверки логики без железа.' });
  if (!allFns.some((f) => f.short === 'setup' && f.hasBody)) add('no-setup', 'error', mainFile.path, 1, 'Нет функции setup() — скетч не запустится.', { hint: 'Добавьте void setup() { … } — она выполняется один раз при старте.' });
  if (!allFns.some((f) => f.short === 'loop' && f.hasBody)) add('no-loop', 'error', mainFile.path, 1, 'Нет функции loop() — после setup() нечего выполнять.', { hint: 'Добавьте void loop() { … } — она повторяется бесконечно.' });
  for (const f of files) {
    const src = String(f.content ?? '');
    const bal = braceBalance(src);
    if (bal.balance !== 0) {
      add('unbalanced-braces', 'error', f.path, bal.badLine || src.split('\n').length, `Не сходятся фигурные скобки: лишних «}» или не закрыто «{» (${bal.balance > 0 ? 'не закрыто ' + bal.balance : 'лишних ' + -bal.balance}).`, { hint: 'Проверьте блоки функций и условий.', fix: null });
    }
    if (/^\s*#\s*include\s*</m.test(src)) { /* ок */ }
  }
  if (loop && !maskCode(loop.body).trim()) add('empty-loop', 'warn', mainFile.path, loop.line, 'loop() пустой — плата будет крутиться вхолостую.', { hint: 'Добавьте логику или delay(…) если так и задумано.', severityOverride: 'info' });

  // ---------- Serial
  const serialUsed = /(?:^|[^\w.])Serial\s*\./.test(wholeMasked);
  const baudArgs = allCalls
    .filter((c) => c.name === 'begin' && /^Serial\d?$/.test(c.receiver || ''))
    .map((c) => Number(c.args[0]));
  if (serialUsed && !baudArgs.length) add('serial-no-begin', 'warn', mainFile.path, 1, 'Serial используется, но Serial.begin() не вызывается — вывод будет потерян.', { hint: 'Добавьте Serial.begin(9600) в setup().', fix: { kind: 'insert', where: 'setup-start', text: '  Serial.begin(9600);\n' } });
  if (baud && baudArgs.some((b) => Number.isFinite(b) && b !== baud)) add('baud-mismatch', 'info', mainFile.path, 1, `Скорость Serial (${baudArgs.filter((b) => b !== baud).join(', ')}) не совпадает с монитором порта (${baud}).`, { hint: 'Иначе в мониторе будут «кракозябры». Синхронизировать можно одной кнопкой в панели монитора.' });
  if (loop && /(?:^|[^\w.])Serial\s*\.\s*print(ln)?\s*\(/.test(maskCode(loop.body)) && !/\bprintln\b/.test(maskCode(loop.body))) add('serial-no-newline', 'info', mainFile.path, loop.line, 'В loop() используется Serial.print без println — строки будут склеиваться.', { hint: 'Используйте Serial.println() или добавьте Serial.print("\\n").' });

  // ---------- прерывания
  for (const fn of isrs) {
    const body = maskCode(fn.body);
    if (/\bdelay\s*\(|\bdelayMicroseconds\s*\(/.test(body)) add('delay-in-isr', 'error', fn.file, fn.line, `delay() внутри обработчика прерывания ${fn.short}() — плата зависнет.`, { hint: 'В прерывании только флажки: volatile-переменная и выход.' });
    if (/\bmillis\s*\(|\bmicros\s*\(/.test(body)) add('time-in-isr', 'warn', fn.file, fn.line, `millis()/micros() внутри ${fn.short}() не меняются — время в прерывании «замирает».`, { hint: 'Оставьте замер в loop(), а в прерывании — только флаг.' });
    if (/(?:^|[^\w.])Serial\s*\./.test(body)) add('serial-in-isr', 'warn', fn.file, fn.line, `Serial в прерывании ${fn.short}() теряет данные (прерывание UART заблокировано).`, { hint: 'Выставляйте флаг, печатайте в loop().' });
    if (/\bString\b|\bnew\s+/.test(body)) add('alloc-in-isr', 'warn', fn.file, fn.line, `Выделение памяти (String/new) в прерывании ${fn.short}() — можно получить зависание.`, {});
  }
  if (isrs.length) {
    const isrMasked = isrs.map((f) => maskCode(f.body || '')).join('\n');
    const globals = findVarDecls(files.map((f) => String(f.content ?? '')).join('\n'));
    for (const g of globals) {
      const assigned = new RegExp(`(?:^|[^\\w.])${g.name}\\s*(=[^=]|\\+\\+|--|\\+=|-=)`, 'm').test(isrMasked);
      if (assigned && !/volatile/.test(g.type)) add('isr-not-volatile', 'warn', mainFile.path, g.line, `Переменная «${g.name}» меняется в прерывании, но объявлена без volatile — компилятор может выбросить чтение.`, { hint: `Сделайте: volatile ${g.type} ${g.name};` });
    }
  }

  // ---------- пины
  const usage = collectPinUsage(files, caps);
  const pinModeCalls = allCalls.filter((c) => c.name === 'pinMode').map((c) => resolvePin(c.args[0], caps)?.pin).filter((p) => Number.isFinite(p));
  for (const c of allCalls) {
    if (!['pinMode', 'digitalWrite', 'digitalRead', 'analogWrite', 'analogRead', 'tone'].includes(c.name)) continue;
    const p = resolvePin(c.args[0], caps);
    if (!p || p.pin == null) continue;
    const src = String(codeOf(files, c.file) ?? '');
    const text = src.split('\n')[c.line - 1] || '';
    if (caps && !isPinAvailable(caps, p.pin)) {
      add('pin-not-exist', 'error', c.file, c.line, `Пина ${p.how} нет на плате ${caps.name}.`, { hint: `Доступные цифровые пины: 0…${Math.max(...caps.digital)}.`, text });
      continue;
    }
    if (c.name === 'analogWrite') {
      if (!caps?.pwm?.has(p.pin) && !caps?.dac?.has(p.pin)) add('no-pwm', 'warn', c.file, c.line, `На пине ${pinLabel(caps, p.pin)} нет аппаратного ШИМ: analogWrite не даст плавного значения.`, { hint: `ШИМ доступен на пинах: ${[...(caps?.pwm || [])].join(', ')}.`, text });
      const v = Number(c.args[1]);
      if (Number.isFinite(v) && (v < 0 || v > 255)) add('pwm-range', 'warn', c.file, c.line, `Значение analogWrite(${v}) вне диапазона 0…255 для 8-битного ШИМ.`, { hint: 'Если нужна яркость 0…100 — пересчитайте: value * 255 / 100.', text });
    }
    if (c.name === 'analogRead' && caps && !analogChannelPin(caps, p.pin)) {
      add('analog-wrong-pin', 'warn', c.file, c.line, `analogRead(${p.how}) — это не аналоговый вход платы ${caps.name}.`, { hint: `Аналоговые входы: ${(caps.analog || []).join(', ')}.`, text });
    }
    if (c.name === 'analogRead' && board?.arch === 'esp32' && /\bWiFi\s*\./.test(wholeMasked) && ESP32_ADC2.has(p.pin)) {
      add('esp-adc2', 'warn', c.file, c.line, `Пин ${pinLabel(caps, p.pin)} — это АЦП2: с включённым Wi-Fi он не читается.`, { hint: 'Используйте пины АЦП1 (32…39) или выключайте Wi-Fi перед измерением.', text });
    }
    if (caps?.inputOnly?.has(p.pin) && ['digitalWrite', 'analogWrite'].includes(c.name)) add('input-only', 'error', c.file, c.line, `Пин ${pinLabel(caps, p.pin)} только вход — выход не сработает.`, { hint: 'Выберите другой пин.', text });
    if (caps?.flashPins?.has(p.pin)) add('flash-pin', 'warn', c.file, c.line, `Пин ${p.pin} подключён к флеш-памяти на ${caps?.name || 'плате'} — обращение к нему может повесить плату.`, { hint: 'Не используйте пины 6–11 на ESP32.', text });
    if (caps?.strapping?.has(p.pin)) add('strapping-pin', 'info', c.file, c.line, `Пин ${p.pin} — «strapping» на этой плате: он влияет на режим загрузки.`, { hint: 'Лучше избегать его для кнопок и реле.', text });
    if (['digitalWrite', 'digitalRead'].includes(c.name) && pinModeCalls.length && !pinModeCalls.includes(p.pin) && !usage.get(p.pin)?.modes?.size) {
      const rec = usage.get(p.pin);
      const asOutput = [...(rec?.funcs || [])].includes('digitalWrite');
      const mode = asOutput ? 'OUTPUT' : 'INPUT';
      add('no-pinmode', 'info', c.file, c.line, `Пин ${pinLabel(caps, p.pin)} используется без pinMode() — режим останется тем, что был по умолчанию (вход).`, { hint: `Добавьте pinMode(${p.how}, ${mode}); в setup().`, fix: { kind: 'insert', where: 'setup-start', text: `  pinMode(${p.how}, ${mode});\n` }, text });
    }
  }
  // «no-int»: attachInterrupt на пине, который аппаратных прерываний не умеет
  for (const c of allCalls) {
    if (c.name !== 'attachInterrupt') continue;
    const inner = /digitalPinToInterrupt\s*\(\s*([^)\s]+)\s*\)/.exec(c.argText || '');
    const p = resolvePin(inner ? inner[1] : c.args[0], caps);
    if (!p || p.pin == null || !caps) continue;
    const text = String(codeOf(files, c.file) ?? '').split('\n')[c.line - 1] || '';
    if (!caps.interrupt.has(p.pin)) {
      add('no-int', 'warn', c.file, c.line, `На пине ${pinLabel(caps, p.pin)} нет аппаратного прерывания — обработчик не вызовется.`, { hint: `Прерывания доступны на пинах: ${[...caps.interrupt].join(', ') || 'нет'}.`, text });
    }
  }

  // ---------- тайминги
  if (loop) {
    const bodyMasked = maskCode(loop.body);
    const delays = [...bodyMasked.matchAll(/\bdelay\s*\(\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
    const usesMillis = /\bmillis\s*\(/.test(bodyMasked);
    for (const d of delays) {
      if (d >= 200) {
        add('delay-in-loop', 'info', mainFile.path, loop.line, `delay(${d}) в loop() блокирует плату на ${d} мс — кнопки и Serial не будут отвечать.`, {
          hint: usesMillis
            ? 'В loop() уже есть millis() — перенесите и этот участок в тот же неблокирующий стиль.'
            : 'Схема без блокировки: if (millis() - last >= ' + d + ') { last = millis(); … }',
        });
        break;
      }
    }
    if (/\bpinMode\s*\(|\bSerial\s*\.\s*begin\s*\(/.test(bodyMasked)) add('init-in-loop', 'warn', mainFile.path, loop.line, 'Настройка (pinMode/Serial.begin) выполняется в loop() — это лишняя работа тысячи раз в секунду.', { hint: 'Перенесите инициализацию в setup().' });
    if (/\bString\b/.test(bodyMasked) && /\+/.test(bodyMasked)) add('string-concat-loop', 'warn', mainFile.path, loop.line, 'Склейка String в loop() фрагментирует память и однажды приведёт к зависанию.', { hint: 'Используйте char[] + snprintf или печатайте частями через Serial.print().' });
  }
  const globals = findVarDecls(files.map((f) => String(f.content ?? '')).join('\n')).filter((g) => /String/.test(g.type));
  for (const g of globals) add('global-string', 'info', mainFile.path, g.line, `Глобальный String «${g.name}» — в AVR-платах это лишний расход ОЗУ и риск фрагментации.`, { hint: 'Лучше char ' + g.name + '[n] или const char*.' });

  // ---------- типы и арифметика
  for (const f of files) {
    const src = String(f.content ?? '');
    const lines = src.split('\n');
    lines.forEach((raw, i) => {
      const line = i + 1;
      const masked = maskCode(raw);
      const m = /\b(int|short|signed)\s+([A-Za-z_]\w*)\s*=\s*(millis|micros)\s*\(/.exec(masked);
      if (m) add('signed-millis', 'warn', f.path, line, `«${m[1]} ${m[2]} = ${m[3]}()» переполнится через ~${m[3] === 'millis' ? '32' : '35'} секунды работы.`, { hint: `Замените тип на unsigned long: unsigned long ${m[2]} = ${m[3]}();`, fix: { kind: 'replace-line', line, text: raw.replace(/\b(int|short|signed)\s+/, 'unsigned long ') } });
      const ifm = /\bif\s*\(([^)]*)\)/.exec(masked);
      if (ifm && isAssignment(ifm[1]) && !/==|!=|<=|>=/.test(ifm[1])) add('assign-in-if', 'warn', f.path, line, 'В условии if стоит «=» (присваивание) вместо «==» (сравнение).', { hint: 'Похоже на опечатку: условие почти всегда истинно.', fix: { kind: 'replace-line', line, text: raw.replace(/(?<![=!<>+\-*/%&|^])=(?!=)/, '==') } });
      const um = /\b(unsigned\s+long)\s+([A-Za-z_]\w*)\s*=\s*millis\s*\(\s*\)\s*-\s*([A-Za-z_]\w*)/.exec(masked);
      if (um) { /* нормальная схема — не ругаемся */ }
      if (/\bstrcpy\s*\(|\bstrcat\s*\(|\bsprintf\s*\(/.test(masked)) add('unsafe-copy', 'warn', f.path, line, 'Функции без контроля длины (strcpy/strcat/sprintf) — классический источник переполнения буфера на микроконтроллере.', { hint: 'Используйте strlcpy/snprintf с указанием размера.' });
      if (/\bmalloc\s*\(|\bcalloc\s*\(/.test(masked) && !/\bfree\s*\(/.test(maskCode(src))) add('malloc-no-free', 'info', f.path, line, 'Есть выделение памяти без освобождения — на плате с 2 КБ ОЗУ это быстро закончится.', { hint: 'Выделяйте буферы статически (глобальный массив).' });
      if (/\bdelay\s*\(\s*(\d{6,})\s*\)/.test(masked)) add('long-delay', 'info', f.path, line, 'Очень длинный delay() (больше 10 минут): плата будет полностью недоступна.', {});
    });
  }

  // ---------- библиотеки и шины
  for (const inc of includes) {
    const name = String(inc.name);
    if (name.startsWith('.') || /^(std|string|math|stdio|stdlib|cstd|vector|map)$/i.test(name)) continue;
    const knownLocal = files.some((f) => f.path.endsWith('/' + name) || f.path === name);
    const lib = libNameForInclude(name);
    if (knownLocal || CORE_HEADERS.has(name)) continue;
    if (!lib) {
      add('include-unknown', 'info', inc.file, inc.line, `Заголовок <${name}> не входит в ядро Arduino и не найден в скетче.`, { hint: 'Если это ваша библиотека — добавьте файл рядом со скетчем; если внешняя — установите её из каталога библиотек.' });
      continue;
    }
    const installed = libs.some((l) => l.toLowerCase() === lib.toLowerCase());
    if (!installed) add('lib-missing', 'info', inc.file, inc.line, `Библиотека ${lib} не установлена — сборка не пройдёт.`, { hint: `Откройте каталог библиотек и установите «${lib}» (можно из склада, офлайн).` });
  }
  if (/\bWire\s*\./.test(wholeMasked) && !/\bWire\s*\.\s*begin\s*\(/.test(wholeMasked)) add('wire-no-begin', 'warn', mainFile.path, 1, 'Wire используется без Wire.begin() — шина I2C не инициализирована.', { hint: 'Добавьте Wire.begin(); в setup().', fix: { kind: 'insert', where: 'setup-start', text: '  Wire.begin();\n' } });
  if (/\bSPI\s*\./.test(wholeMasked) && !/\bSPI\s*\.\s*begin\s*\(/.test(wholeMasked)) add('spi-no-begin', 'info', mainFile.path, 1, 'SPI используется без SPI.begin() — обычно срабатывает, но явная инициализация надёжнее.', { hint: 'Добавьте SPI.begin(); в setup().' });

  // ---------- особенности платы
  if (caps && caps.adcBits && caps.adcBits !== 10) {
    const has1023 = /1023|1024/.test(wholeMasked);
    if (has1023 && caps.adcBits > 10) add('adc-resolution', 'warn', mainFile.path, 1, `Скетч считает максимум АЦП равным 1023, а на ${caps.name} разрядность ${caps.adcBits} бит (максимум ${Math.pow(2, caps.adcBits) - 1}).`, { hint: 'Считайте диапазон через ADC_MAX = (1 << ' + caps.adcBits + ') - 1.' });
  }
  if (caps?.voltage && caps.voltage < 5 && /\b5\s*V\b/i.test(files.map((f) => String(f.content ?? '')).join('\n'))) add('voltage-note', 'info', mainFile.path, 1, `Плата работает от ${caps.voltage} В: подача 5 В на вход может её повредить.`, { hint: 'Используйте делитель напряжения или логический преобразователь уровня.' });

  // ---------- порядок и сводка
  const uniq = new Map();
  for (const o of out) {
    const key = `${o.id}:${o.file}:${o.line}`;
    if (!uniq.has(key)) uniq.set(key, o);
  }
  const findings = [...uniq.values()].map((o, i) => ({ ...o, n: i + 1 })).sort(sortFindings);
  const byFile = {};
  for (const f of findings) byFile[f.file] = (byFile[f.file] || 0) + 1;
  const summary = {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    infos: findings.filter((f) => f.severity === 'info').length,
    lines: files.reduce((a, f) => a + String(f.content ?? '').split('\n').length, 0),
    files: files.length,
    functions: allFns.filter((f) => f.hasBody).length,
    globals: globals.length,
    includes: includes.length,
    isrs: isrs.length,
    libs: [...new Set(includes.map((i) => libNameForInclude(i.name)).filter(Boolean))],
  };
  const score = scoreSketch(summary, findings);
  return {
    issues: findings, // исторически так называется в API и панели «Анализ»
    ok: true, fqbn, name,
    board: caps ? { fqbn: caps.fqbn, name: caps.name, mcu: caps.mcu, flash: caps.flash, ram: caps.ram, adcBits: caps.adcBits, pwmBits: caps.pwmBits, voltage: caps.voltage } : null,
    findings, summary, score, byFile,
    includes: includes.map((i) => ({ name: i.name, file: i.file, line: i.line, lib: libNameForInclude(i.name) })),
    functions: allFns.filter((f) => f.hasBody).map((f) => ({ name: f.name, ret: f.ret, args: f.args, file: f.file, line: f.line, isIsr: isrs.includes(f) })),
    installedLibs: libs,
  };
}

/** Оценка скетча: 100 — идеально, ниже — есть что поправить. Своя методика MicroPIDE. */
export function scoreSketch(summary, findings) {
  const cats = {
    Плата: ['pin-not-exist', 'no-fqbn', 'input-only', 'flash-pin', 'analog-wrong-pin', 'no-pwm'],
    Структура: ['no-setup', 'no-loop', 'unbalanced-braces', 'empty-loop', 'init-in-loop'],
    Тайминги: ['delay-in-loop', 'signed-millis', 'time-in-isr', 'delay-in-isr', 'long-delay'],
    Память: ['global-string', 'string-concat-loop', 'malloc-no-free', 'alloc-in-isr'],
    Надёжность: ['serial-no-begin', 'wire-no-begin', 'assign-in-if', 'isr-not-volatile', 'unsafe-copy', 'serial-in-isr'],
    Библиотеки: ['lib-missing', 'include-unknown', 'spi-no-begin', 'adc-resolution'],
  };
  const weight = { error: 12, warn: 5, info: 2 };
  const parts = [];
  let total = 0;
  let count = 0;
  for (const [cat, ids] of Object.entries(cats)) {
    const hits = findings.filter((f) => ids.includes(f.id));
    const loss = hits.reduce((a, f) => a + (weight[f.severity] || 2), 0);
    const max = 100;
    const val = Math.max(0, max - loss);
    parts.push({ name: cat, score: val, issues: hits.length });
    total += loss;
    count++;
  }
  const overall = Math.max(0, Math.round(100 - total / count));
  return { overall, parts, grade: overall >= 90 ? 'отлично' : overall >= 75 ? 'хорошо' : overall >= 55 ? 'есть замечания' : 'нужно поправить' };
}

/** Применить автоправку из находки к файлам. Возвращает новые files. */
export function applyFix(files, fix, filePath = '') {
  const list = (files || []).map((f) => ({ path: f.path, content: String(f.content ?? '') }));
  const target = list.find((f) => f.path === filePath) || list.find((f) => /\.ino$/i.test(f.path)) || list[0];
  if (!target || !fix) return { ok: false, error: 'Некуда применять правку', files: list };
  const lines = target.content.split('\n');
  if (fix.kind === 'replace-line') {
    if (fix.line < 1 || fix.line > lines.length) return { ok: false, error: 'Строка вне файла', files: list };
    lines[fix.line - 1] = fix.text;
  } else if (fix.kind === 'insert') {
    const m = /void\s+setup\s*\([^)]*\)\s*\{/.exec(target.content);
    if (!m) return { ok: false, error: 'Нет setup() — правку вставить некуда', files: list };
    const at = m.index + m[0].length;
    const head = target.content.slice(0, at);
    const tail = target.content.slice(at);
    target.content = head + '\n' + fix.text.replace(/\n$/, '') + tail;
    return { ok: true, files: list, applied: fix.kind };
  } else if (fix.kind === 'replace') {
    if (!fix.find) return { ok: false, error: 'Нет шаблона замены', files: list };
    target.content = target.content.replace(fix.find, fix.replace ?? '');
  } else {
    return { ok: false, error: 'Неизвестный тип правки: ' + fix.kind, files: list };
  }
  target.content = lines.join('\n');
  return { ok: true, files: list, applied: fix.kind };
}

// ------------------------------------------------------------------ документация

// Заголовки, которые идут с платой/ядром Arduino: их не нужно «устанавливать».
const CORE_HEADERS = new Set([
  'Arduino.h', 'Wire.h', 'SPI.h', 'EEPROM.h', 'SoftwareSerial.h', 'HID.h', 'USBAPI.h', 'Keyboard.h',
  'Mouse.h', 'SD.h', 'Ethernet.h', 'Firmata.h', 'Servo.h', 'Stepper.h', 'Print.h', 'Stream.h', 'WString.h',
  'pins_arduino.h', 'avr/pgmspace.h', 'avr/interrupt.h', 'avr/sleep.h', 'avr/wdt.h', 'util/delay.h',
  'WiFi.h', 'WiFiClient.h', 'Wire1.h', 'HardwareSerial.h', 'esp_system.h', 'Ticker.h',
]);

const MODULE_HINTS = {
  DHT: { what: 'Датчик температуры и влажности DHT11/DHT22', wiring: ['VCC → 5 В (или 3.3 В для DHT22)', 'DATA → цифровой пин + резистор 10 кОм к VCC', 'GND → GND'], pin: 'DATA — тот пин, что передан в DHT(pin, …)' },
  Servo: { what: 'Сервопривод (SG90/MG996R)', wiring: ['VCC(красный) → 5 В (мощный источник!)', 'GND(чёрный) → GND', 'Сигнал(оранжевый) → пин ШИМ'], pin: 'Сигнальный пин — аргумент Servo.attach()' },
  Wire: { what: 'Устройство на шине I2C (дисплей, датчик, EEPROM)', wiring: ['VCC → 3.3/5 В по паспорту модуля', 'GND → GND', 'Не забыть подтяжку SDA/SCL (часто есть на модуле)'], pin: 'SDA/SCL платы' },
  SPI: { what: 'Устройство на шине SPI (SD, RF-модуль, дисплей)', wiring: ['VCC → 3.3 В', 'GND → GND', 'MOSI/MISO/SCK/CS — по распиновке платы'], pin: 'MOSI/MISO/SCK + отдельный CS' },
  LiquidCrystal_I2C: { what: 'Символьный LCD 16×02 (I2C-модуль)', wiring: ['VCC → 5 В', 'GND → GND', 'SDA/SCL → пины I2C'], pin: 'I2C' },
  Adafruit_NeoPixel: { what: 'Адресная лента WS2812/NeoPixel', wiring: ['+5 В → отдельное питание при длинной ленте', 'GND → общий', 'DIN → пин через резистор 330 Ом'], pin: 'DATA IN' },
  OneWire: { what: 'Шина 1-Wire (DS18B20)', wiring: ['VCC → 5 В', 'GND → GND', 'DQ → цифровой пин + подтяжка 4.7 кОм'], pin: 'DQ' },
  SoftwareSerial: { what: 'Программный UART (GPS, BT-модуль)', wiring: ['RX ← TX модуля', 'TX → RX модуля (или через делитель)', 'GND → GND'], pin: 'RX/TX из SoftwareSerial(rx, tx)' },
  Stepper: { what: 'Шаговый двигатель + драйвер (ULN2003/A4988)', wiring: ['Питание двигателя — отдельно', 'IN1..IN4 → цифровые пины', 'GND → общий'], pin: 'пины драйвера' },
};

/** Подсказка по модулю: сначала точное имя, потом по вхождению (DHT → «DHT sensor library»). */
function hintForModule(lib) {
  if (!lib) return null;
  if (MODULE_HINTS[lib]) return MODULE_HINTS[lib];
  const key = String(lib).toLowerCase();
  for (const [k, v] of Object.entries(MODULE_HINTS)) if (key.includes(k.toLowerCase())) return v;
  return null;
}

/** Документация скетча: README.md + схема + BOM. */
export function generateDocs({ name = 'sketch', files = [], fqbn = '', analysis = null, pinmap = null } = {}) {
  const a = analysis || analyze({ files, fqbn, name });
  const pm = pinmap || pinMap({ files, fqbn });
  const libs = a.summary.libs || [];
  const bom = [];
  for (const lib of libs) {
    const h = hintForModule(lib);
    if (h) bom.push({ lib, what: h.what, wiring: h.wiring, pin: h.pin });
    else bom.push({ lib, what: `Модуль/библиотека ${lib}`, wiring: ['Питание по паспорту модуля', 'GND → GND'], pin: 'по вашей схеме' });
  }
  const used = pm.pins.filter((p) => p.outputs || p.inputs);
  const pinRows = used.map((p) => `| ${p.label} | ${p.roles.join(', ')} | ${p.pwm ? 'да' : '—'} | ${p.adc ? 'да' : '—'} | ${p.conflicts.length ? '⚠ ' + p.conflicts.join('; ') : 'ок'} |`).join('\n');
  const mermaid = [
    '```mermaid',
    'graph LR',
    `  MCU["${a.board?.name || fqbn || 'плата'}<br/>${a.board?.mcu || ''}"]`,
    ...used.map((p, i) => `  MCU -- "${p.label}: ${p.roles.join(', ')}" --> M${i}["${p.roles.includes('ШИМ') ? 'исполнитель' : p.roles.some((r) => /аналоговый/.test(r)) ? 'датчик (аналог)' : 'модуль'}"]`),
    ...bom.map((b, i) => `  M${used.length + i}["${b.lib}: ${b.what}"]`),
    '```',
  ].join('\n');
  const fl = (a.board?.flash || 0), ram = (a.board?.ram || 0);
  const md = `# ${name}

Скетч MicroPIDE. Документация сгенерирована автоматически — без интернета и без внешних сервисов.

## Плата

| Параметр | Значение |
|---|---|
| Плата | ${a.board?.name || 'не выбрана'} |
| FQBN | \`${fqbn || '—'}\` |
| Микроконтроллер | ${a.board?.mcu || '—'} |
| Флеш для скетча | ${fl ? fl.toLocaleString('ru-RU') + ' Б' : '—'} |
| ОЗУ | ${ram ? ram.toLocaleString('ru-RU') + ' Б' : '—'} |
| АЦП / ШИМ | ${a.board?.adcBits || '—'} бит / ${a.board?.pwmBits || '—'} бит |
| Логика | ${a.board?.voltage ? a.board.voltage + ' В' : '—'} |

## Что скетч делает

- Файлов: ${a.summary.files}, строк: ${a.summary.lines}, функций: ${a.summary.functions}
- Библиотеки: ${libs.length ? libs.join(', ') : 'только ядро'}
- Прерываний: ${a.summary.isrs}
- Оценка MicroPIDE: **${a.score.overall}/100** (${a.score.grade})

## Схема подключения

${mermaid}

## Пины

| Пин | Роли | ШИМ | АЦП | Проверка |
|---|---|---|---|---|
${pinRows || '| — | пины не используются | — | — | — |'}

Свободных пинов: ${pm.free.length} (${pm.free.join(', ') || 'нет'}).

## Что нужно подключить

${bom.length ? bom.map((b, i) => `### ${i + 1}. ${b.what}
- Библиотека: \`${b.lib}\`
- Куда: ${b.pin}
- Монтаж:
${b.wiring.map((w) => '  - ' + w).join('\n')}
`).join('\n') : '_Внешних модулей не обнаружено: скетч использует только саму плату._'}

## Найденные замечания

${a.findings.length ? a.findings.map((f) => `- **${f.severity === 'error' ? 'Ошибка' : f.severity === 'warn' ? 'Предупреждение' : 'Совет'}** (${f.file}:${f.line}) ${f.message}${f.hint ? ' — ' + f.hint : ''}`).join('\n') : '- Замечаний нет — код выглядит аккуратно.'}

## Как собрать и проверить

1. \`Инструменты → Проверить логику без платы\` — скетч соберётся под плату-симулятор и выполнится на компьютере.
2. \`Инструменты → Тесты на железе\` — сценарий сам отправит команды на плату и проверит ответ.
3. Если под рукой нет сети — \`Инструменты → Склад\`: положите архив ядра и тулчейна, сборка под реальную плату заработает офлайн.

---
_Файл создан MicroPIDE. Правьте смело: при следующей генерации он будет перезаписан._
`;
  return { ok: true, markdown: md, bom, mermaid, pins: used, modules: bom.length, functions: a.summary.functions };
}

// ------------------------------------------------------------------ pins.h

/** Именованные пины вместо магических чисел. */
export function generatePinsHeader({ name = 'sketch', files = [], fqbn = '', pinmap = null } = {}) {
  const pm = pinmap || pinMap({ files, fqbn });
  const board = findBoard(fqbn);
  const used = pm.pins.filter((p) => p.outputs || p.inputs);
  const maxPin = Math.max(...pm.pins.map((p) => p.pin), ...pm.free, 0);
  const defs = [];
  for (const p of used) {
    const roles = p.roles.filter((r) => !/занят/.test(r)).join(', ');
    const tail = `// ${roles}${p.pwm ? ', ШИМ' : ''}${p.adc ? ', АЦП' : ''}${p.conflicts.length ? ' ⚠ ' + p.conflicts.join('; ') : ''}`;
    const tag = p.label.toUpperCase();
    if (p.outputs || !p.inputs) defs.push(`constexpr uint8_t PIN_OUT_${tag} = ${p.pin}; ${tail}`);
    if (p.inputs) defs.push(`constexpr uint8_t PIN_IN_${tag} = ${p.pin}; ${tail}`);
  }
  const asserts = defs.map((d) => {
    const m = /constexpr uint8_t (PIN_\w+) = (\d+);/.exec(d);
    return m ? `static_assert(${m[1]} <= ${maxPin}, "пин вне диапазона платы");` : '';
  }).filter(Boolean);
  const hints = board?.hints || [];
  const features = [
    `// Особенности платы ${pm.board?.name || fqbn || '—'}:`,
    `//   • логика ${board?.voltage ?? '?'} В, АЦП ${board?.adcBits ?? '?'} бит, ШИМ ${board?.pwmBits ?? '?'} бит`,
    `//   • ШИМ: ${(board?.pwm || []).slice(0, 12).join(', ')}${(board?.pwm || []).length > 12 ? '…' : ''}`,
    ...hints.map((h) => `//   • ${h}`),
  ].join('\n');
  const guard = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_PINS_H';
  const content = `// pins.h — карта пинов скетча «${name}» (сгенерировано MicroPIDE).
// Плата: ${pm.board?.name || 'не выбрана'} (${fqbn || '—'})
// Подключите файл в скетч: #include "pins.h" — и используйте имена вместо чисел.
#pragma once
#ifndef ${guard}
#define ${guard}

#include <stdint.h>

${features}

${defs.join('\n') || '// пины не используются'}

// Свободные пины платы: ${pm.free.join(', ') || 'нет'}
${asserts.join('\n')}
#endif // ${guard}
`;
  return { ok: true, fileName: 'pins.h', content, count: used.length, pins: used.length, free: pm.free, defs: defs.length };
}

// ------------------------------------------------------------------ профилирование

/**
 * Инструментация скетча: loop() переименовывается, а вокруг появляется замер
 * времени итерации. Скетч сам печатает статистику — видно, что именно тормозит.
 */
export function instrumentSketch({ files = [], channel = 'serial', periodMs = 1000 } = {}) {
  const list = (files || []).map((f) => ({ path: f.path, content: String(f.content ?? '') }));
  const mainFile = list.find((f) => /\.ino$/i.test(f.path)) || list[0];
  if (!mainFile) return { ok: false, error: 'Нет файлов скетча' };
  if (mainFile.content.includes('#PROF')) return { ok: false, error: 'Скетч уже инструментирован (есть блок #PROF). Отмените изменения или пересоздайте файл.' };
  const body = functionBody(mainFile.content, 'loop');
  if (!body) return { ok: false, error: 'В скетче нет loop() — профилировать нечего' };
  // 1) переименовать определение loop → micropide_loop
  const masked = maskCode(mainFile.content);
  const idx = masked.lastIndexOf('loop', body.start);
  const before = mainFile.content.slice(0, idx);
  const after = mainFile.content.slice(idx + 4);
  mainFile.content = before + 'micropide_loop' + after;
  // 2) добавить обёртку в конец файла
  const report = channel === 'serial'
    ? `#ifndef MICROPIDE_PROFILE
#define MICROPIDE_PROFILE
// --- MicroPIDE: профилирование loop() (сгенерировано автоматически) ---
static unsigned long __mp_iters = 0, __mp_min = 0xFFFFFFFFUL, __mp_max = 0, __mp_sum = 0, __mp_last = 0;
void loop() {
  unsigned long __mp_t0 = micros();
  micropide_loop();
  unsigned long __mp_dt = micros() - __mp_t0;
  __mp_iters++;
  __mp_sum += __mp_dt;
  if (__mp_dt < __mp_min) __mp_min = __mp_dt;
  if (__mp_dt > __mp_max) __mp_max = __mp_dt;
  if (millis() - __mp_last >= ${Math.max(50, Number(periodMs) || 1000)}) {
    __mp_last = millis();
    unsigned long __mp_avg = __mp_iters ? __mp_sum / __mp_iters : 0;
    Serial.print(F("#PROF iters="));
    Serial.print(__mp_iters);
    Serial.print(F(" avg_us=")); Serial.print(__mp_avg);
    Serial.print(F(" min_us=")); Serial.print(__mp_min == 0xFFFFFFFFUL ? 0 : __mp_min);
    Serial.print(F(" max_us=")); Serial.print(__mp_max);
    Serial.print(F(" free_ram=")); Serial.println(micropideFreeRam());
    __mp_iters = 0; __mp_sum = 0; __mp_min = 0xFFFFFFFFUL; __mp_max = 0;
  }
}
#endif
`
    : `// профилирование включено: см. вывод профиля в панели «Тесты»
#define MICROPIDE_PROFILE 0
`;
  mainFile.content = mainFile.content.trimEnd() + '\n\n' + report;
  return {
    ok: true, files: list, instrumented: mainFile.path,
    note: 'loop() переименован в micropide_loop(), вокруг него добавлен замер. Статистика печатается строкой #PROF — её видно в мониторе и в панели профиля.',
  };
}

/** Разобрать строки #PROF из вывода: что со временем итераций. */
export function parseProfileOutput(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /#PROF\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const kv = {};
    for (const part of m[1].split(/\s+/)) {
      const [k, v] = part.split('=');
      if (k && v != null) kv[k] = Number(v);
    }
    rows.push(kv);
  }
  if (!rows.length) return { ok: false, error: 'Строк #PROF не найдено', rows: [] };
  const last = rows[rows.length - 1];
  return {
    ok: true, samples: rows.length, rows,
    summary: {
      iters: last.iters, avgUs: last.avg_us, minUs: last.min_us, maxUs: last.max_us,
      freeRam: Number.isFinite(last.free_ram) ? last.free_ram : null,
      loopHz: last.avg_us ? Math.round(1e6 / last.avg_us) : null,
    },
  };
}

// ------------------------------------------------------------------ телеметрия MicroTelem

export const TELEM_MAGIC = [0xAA, 0x55];
export const TELEM_VERSION = 1;
export const TELEM_MAX_CHANNELS = 16;
/** Заголовок кадра: AA 55 | версия | каналов | CRC16(LE) — ровно 6 байт. */
export const TELEM_HEADER = 6;
export const TELEM_NAME_MAX = 12;

/**
 * Кадр телеметрии: [AA 55][ver][count][crc16LE][float32LE × count].
 * Заголовок ровно 6 байт, поэтому длина кадра = 6 + 4 × каналов: панель
 * телеметрии и скетч считают её одинаково, без догадок.
 */
export function telemetryFrame({ channels = {} } = {}) {
  const names = Object.keys(channels);
  const payload = [];
  for (const n of names) payload.push(...float32le(Number(channels[n]) || 0));
  const crc = crc16(payload);
  return Buffer.from([TELEM_MAGIC[0], TELEM_MAGIC[1], TELEM_VERSION, names.length & 0xFF, crc & 0xFF, (crc >> 8) & 0xFF, ...payload]);
}

function float32le(v) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v, 0);
  return [...b];
}

/** Разбор потока: возвращает кадры и остаток буфера (устойчив к мусору в порту). */
export function parseTelemetry(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const frames = [];
  let i = 0;
  let seq = 0;
  while (i + 6 <= b.length) {
    if (b[i] !== TELEM_MAGIC[0] || b[i + 1] !== TELEM_MAGIC[1]) { i++; continue; }
    const count = b[i + 3];
    if (count < 1 || count > TELEM_MAX_CHANNELS) { i++; continue; }
    const len = TELEM_HEADER + count * 4;
    if (i + len > b.length) break;
    const payload = b.slice(i + TELEM_HEADER, i + len);
    const crc = b[i + 4] | (b[i + 5] << 8);
    if (crc16(payload) !== crc) { i++; continue; }
    const values = [];
    for (let k = 0; k < count; k++) values.push(b.readFloatLE(i + TELEM_HEADER + k * 4));
    frames.push({ seq: seq++, version: b[i + 2], count, bytes: len, values, names: [] });
    i += len;
  }
  return { frames, rest: b.slice(i) };
}

/** Текстовая телеметрия (её удобно смотреть в мониторе порта). */
export function telemetryTextLine(seq, channels) {
  const parts = Object.entries(channels).map(([k, v]) => `${k}=${Number(v).toFixed(3)}`);
  return `#MT ${seq} ${parts.join(' ')}`;
}

/** Разбор текстовых строк #MT (её печатает MICROTELEM_TEXT). */
export function parseTelemetryText(line, names = []) {
  const m = /#MT\s+(\d+)\s+(.*)$/.exec(String(line ?? '').trim());
  if (!m) return null;
  const seq = Number(m[1]);
  const values = [];
  const seen = [];
  for (const part of m[2].split(/\s+/)) {
    const [k, v] = part.split('=');
    if (k == null) continue;
    seen.push(k);
    values.push(Number(v));
  }
  return { seq, values, names: names.length ? names : seen };
}

/**
 * Готовый скетч-пример телеметрии: вставляется одним нажатием, графики сразу видны.
 */
export function telemetryExample({ channels = ['value'], baud = 115200, periodMs = 100 } = {}) {
  const ch = (channels || ['value']).map(String).filter(Boolean);
  const args = ch.map((_, i) => (i === 0 ? 'v' : i === 1 ? 'millis() / 1000.0' : '0.0')).join(', ');
  return `// Пример телеметрии MicroPIDE: графики строятся прямо в панели телеметрии.
#include "MicroTelem.h"

void setup() {
  MICROTELEM_BEGIN();   // Serial.begin(${Number(baud) || 115200})
}

void loop() {
  float v = analogRead(A0) * 5.0 / 1023.0;   // вольты на A0
  MICROTELEM(${args});
  MICROTELEM_TEXT_PRINT(${args});
  delay(${Math.max(1, Number(periodMs) || 100)});
}
`;
}

/**
 * Предварительная оценка профиля скетча: где тратится место и время.
 * Считаем статически (до сборки): видно «тяжёлые» функции и глобальные буферы.
 */
/**
 * Оценка «до сборки»: сколько занимают функции и глобальные переменные, сколько
 * останется ОЗУ и флеш. Работает без компилятора — по разбору кода.
 */
export function sketchProfile(opts = {}) {
  return withConsts(constTable(opts.files || []), () => sketchProfileInner(opts));
}

function sketchProfileInner({ files = [], fqbn = '' } = {}) {
  const fns = [];
  let globalsBytes = 0;
  const globals = [];
  for (const f of files) {
    const src = String(f.content ?? '');
    const masked = maskCode(src);
    for (const fn of findFunctions(src)) {
      if (!fn.hasBody) continue;
      const openBrace = masked.indexOf('{', fn.index);
      const closeBrace = openBrace >= 0 ? matchBracket(masked, openBrace) : -1;
      const body = closeBrace > openBrace ? src.slice(openBrace, closeBrace + 1) : '';
      const bodyMasked = maskCode(body);
      const calls = extractCalls(body).filter((c) => !c.isControl);
      fns.push({
        name: fn.short, file: f.path, line: fn.line, ret: fn.ret, args: fn.args.length,
        lines: body.split('\n').length, calls: calls.length,
        heavy: [...new Set(calls.map((c) => c.name).filter((n) => ['delay', 'delayMicroseconds', 'String', 'analogRead', 'readTemperature', 'readHumidity', 'print', 'println'].includes(n)))],
        stackBytes: estimateStack(bodyMasked),
      });
    }
    const rx = /(?:^|\n)\s*(?:static\s+|const\s+|volatile\s+)*([A-Za-z_][\w:]*)\s+([A-Za-z_]\w*)\s*\[\s*(\d+)\s*\]/g;
    let m;
    while ((m = rx.exec(masked))) {
      const n = Number(m[3]);
      const size = sizeOfType(m[1]) * n;
      globalsBytes += size;
      globals.push({ name: m[2], type: m[1], count: n, bytes: size, line: lineOf(masked, m.index) });
    }
    for (const d of findVarDecls(src)) {
      if (/String/.test(d.type)) { globalsBytes += 12; globals.push({ name: d.name, type: 'String', count: 1, bytes: 12, line: d.line }); }
    }
  }
  fns.sort((a, b) => b.lines - a.lines);
  const caps = boardCaps(fqbn);
  const est = {
    functions: fns.length,
    lines: files.reduce((a, f) => a + String(f.content ?? '').split('\n').length, 0),
    globalsBytes, ramFree: caps?.ram ? caps.ram - globalsBytes : null,
    flashEstimate: Math.round(fns.reduce((a, f) => a + f.lines * 22, 400)),
    heaviest: fns.slice(0, 8), globals, advice: [],
  };
  if (caps?.ram && est.globalsBytes > caps.ram * 0.6) est.advice.push(`Глобальные данные занимают ${est.globalsBytes} Б из ${caps.ram} Б ОЗУ — больше половины. Уменьшите буферы или вынесите строки в PROGMEM.`);
  if (fns.some((f) => f.lines > 120)) est.advice.push('Есть функции длиннее 120 строк — их стоит разбить на части.');
  if (fns.some((f) => f.stackBytes > 200)) est.advice.push('Есть функции с большими локальными массивами: на AVR стек всего ~1.5 КБ. Перенесите буферы в глобальную память.');
  if (!est.advice.length) est.advice.push('По статической оценке всё в порядке: расход выглядит умеренным.');
  return { ok: true, fqbn, board: caps ? { name: caps.name, flash: caps.flash, ram: caps.ram } : null, ...est, functions: fns };
}

function sizeOfType(t) {
  const s = String(t);
  if (/bool|char|uint8|int8|byte/.test(s)) return 1;
  if (/int|word|uint16|int16/.test(s) && !/uint32|int32/.test(s)) return 2;
  return 4;
}

function estimateStack(bodyMasked) {
  let bytes = 0;
  const rx = /([A-Za-z_][\w:]*)\s+([A-Za-z_]\w*)\s*\[\s*(\d+)\s*\]/g;
  let m;
  while ((m = rx.exec(bodyMasked))) bytes += sizeOfType(m[1]) * Number(m[3]);
  return bytes;
}

/**
 * Заголовок MicroTelem.h: свой бинарный протокол телеметрии.
 * Плюс: печатает и человекочитаемую строку, если включить MICROTELEM_TEXT.
 */
export function telemetryHeader({ channels = [], baud = 115200, periodMs = 100, binary = true, text = true } = {}) {
  const list = (channels || []).map((c) => String(c).trim()).filter(Boolean);
  if (!list.length) list.push('value');
  if (list.length > TELEM_MAX_CHANNELS) list.length = TELEM_MAX_CHANNELS;
  const frameBytes = TELEM_HEADER + list.length * 4; // AA 55 | ver | count | CRC16 | N×float32
  const content = `// MicroTelem.h — телеметрия MicroPIDE (свой формат, без внешних библиотек).
// Кадр: AA 55 | ver=1 | count | crc16(LE, CCITT-FALSE) | count × float32(LE)
// Каналы: ${list.join(', ')}   (кадр ${frameBytes} Б, период ${periodMs} мс)
//
// Использование:
//   #include "MicroTelem.h"
//   void setup() { MICROTELEM_BEGIN(); }
//   void loop()  { MICROTELEM(${list.join(', ')}); }
//
// Байты кадра: 0xAA, 0x55, версия, каналов, CRC16(lo,hi), дальше float32(LE).
// Панель телеметрии MicroPIDE сама декодирует кадры и рисует графики.
#pragma once
#include <Arduino.h>

#define MICROTELEM_MAGIC_0 0xAA
#define MICROTELEM_MAGIC_1 0x55
#define MICROTELEM_VERSION 1
#define MICROTELEM_CHANNELS ${list.length}
#define MICROTELEM_PERIOD_MS ${Math.max(1, Number(periodMs) || 100)}
#define MICROTELEM_BAUD ${Number(baud) || 115200}
#define MICROTELEM_HEADER 6
#define MICROTELEM_BINARY ${binary ? 1 : 0}
#define MICROTELEM_TEXT ${text ? 1 : 0}

static uint8_t __mt_seq = 0;
static uint32_t __mt_last = 0;

static inline uint16_t __mt_crc16(const uint8_t *data, uint8_t len) {
  uint16_t crc = 0xFFFF;
  for (uint8_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (uint8_t b = 0; b < 8; b++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

#define MICROTELEM_BEGIN() do { Serial.begin(MICROTELEM_BAUD); } while (0)

#if MICROTELEM_BINARY
#define MICROTELEM(...) do { \\
    float __mt_v[MICROTELEM_CHANNELS] = { __VA_ARGS__ }; \\
    uint8_t __mt_frame[MICROTELEM_HEADER + MICROTELEM_CHANNELS * 4]; \\
    __mt_frame[0] = MICROTELEM_MAGIC_0; __mt_frame[1] = MICROTELEM_MAGIC_1; \\
    __mt_frame[2] = MICROTELEM_VERSION; __mt_frame[3] = MICROTELEM_CHANNELS; \\
    for (uint8_t i = 0; i < MICROTELEM_CHANNELS; i++) { \\
      union { float f; uint8_t b[4]; } __mt_u; __mt_u.f = __mt_v[i]; \\
      for (uint8_t k = 0; k < 4; k++) __mt_frame[MICROTELEM_HEADER + i * 4 + k] = __mt_u.b[k]; \\
    } \\
    uint16_t __mt_c = __mt_crc16(__mt_frame + MICROTELEM_HEADER, MICROTELEM_CHANNELS * 4); \\
    __mt_frame[4] = (uint8_t)(__mt_c & 0xFF); \\
    __mt_frame[5] = (uint8_t)(__mt_c >> 8); \\
    Serial.write(__mt_frame, sizeof(__mt_frame)); \\
    __mt_seq++; \\
  } while (0)
#else
#define MICROTELEM(...) do { } while (0)
#endif

#if MICROTELEM_TEXT
#define MICROTELEM_TEXT_PRINT(...) do { \\
    if (millis() - __mt_last >= MICROTELEM_PERIOD_MS) { \\
      __mt_last = millis(); \\
      Serial.print(F("#MT ")); Serial.print(__mt_seq); \\
      float __mt_tv[MICROTELEM_CHANNELS] = { __VA_ARGS__ }; \\
      const char *__mt_names[MICROTELEM_CHANNELS] = { ${list.map((c) => `"${c}"`).join(', ')} }; \\
      for (uint8_t i = 0; i < MICROTELEM_CHANNELS; i++) { \\
        Serial.print(' '); Serial.print(__mt_names[i]); Serial.print('='); Serial.print(__mt_tv[i], 3); \\
      } \\
      Serial.println(); \\
    } \\
  } while (0)
#else
#define MICROTELEM_TEXT_PRINT(...) do { } while (0)
#endif

// Свободная память: для AVR считаем по границе heap/stack, для остальных — 0.
static inline int micropideFreeRam() {
#if defined(__AVR__)
  extern int __heap_start, *__brkval;
  int v;
  return (int)&v - (__brkval == 0 ? (int)&__heap_start : (int)__brkval);
#else
  return 0;
#endif
}
`;
  const example = `#include "MicroTelem.h"

void setup() {
  MICROTELEM_BEGIN();
}

void loop() {
  float v = analogRead(A0) * 5.0 / 1023.0;
  MICROTELEM(v, millis() / 1000.0${list.length > 2 ? ', ' + list.slice(2).map(() => '0.0').join(', ') : ''});
  MICROTELEM_TEXT_PRINT(v, millis() / 1000.0${list.length > 2 ? ', ' + list.slice(2).map(() => '0.0').join(', ') : ''});
  delay(MICROTELEM_PERIOD_MS);
}
`;
  return {
    ok: true, fileName: 'MicroTelem.h', content, example, channels: list, frameBytes,
    crcExample: crc16([0x31, 0x32, 0x33]),
    usage: { begin: 'MICROTELEM_BEGIN()', send: `MICROTELEM(${list.join(', ')})`, text: `MICROTELEM_TEXT_PRINT(${list.join(', ')})` },
  };
}

export { crc16 };
