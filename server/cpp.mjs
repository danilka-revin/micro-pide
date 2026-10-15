// Свой разбор C++: комментарии, строки, функции, прототипы, вызовы.
//
// Нужен дважды: сборщику (свой препроцессор скетча: .ino → .cpp с прототипами)
// и анализатору (линтер, карта пинов, документация). Внешних парсеров нет —
// всё написано здесь, чтобы работать офлайн и без зависимостей.

const ID = '[A-Za-z_][A-Za-z0-9_]*';
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'sizeof', 'case', 'default', 'And', 'or', 'not']);

/* ------------------------------------------------------------------ маскирование */

/**
 * Затирает содержимое комментариев/строк/символов пробелами, сохраняя длину и переводы строк.
 * После этого можно спокойно искать скобки и вызовы регулярками.
 */
export function maskCode(code, { keepStrings = false } = {}) {
  const src = String(code ?? '');
  const out = new Array(src.length);
  let i = 0;
  const same = (n) => { out[i] = src[i]; i++; };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      same();
      while (i < src.length) {
        if (src[i] === '\\') { same(); same(); continue; }
        if (src[i] === quote) { same(); break; }
        if (src[i] === '\n') break; // незакрытая строка — не съедаем весь файл
        same();
      }
      if (keepStrings) for (let k = start; k < i; k++) out[k] = src[k];
      continue;
    }
    same();
  }
  return out.join('');
}

/** Позиция индекса в строке/столбце (1-основанные). */
export function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

export function columnOf(code, index) {
  const lineStart = code.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  return index - lineStart + 1;
}

export function lines(code) { return String(code ?? '').split('\n'); }

/** Строка по номеру (1-основанный). */
export function lineText(code, n) { return lines(code)[n - 1] ?? ''; }

/* ------------------------------------------------------------------ структура кода */

/** Карта глубины фигурных скобок: массив длины кода, [i] = глубина до символа i. */
export function depthMap(masked) {
  const map = new Int32Array(masked.length);
  let d = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') { map[i] = d; d++; }
    else if (c === '}') { d = Math.max(0, d - 1); map[i] = d; }
    else map[i] = d;
  }
  return map;
}

/** Баланс скобок и первая строка, где он ломается (для понятных ошибок). */
export function braceBalance(code) {
  const m = maskCode(code);
  let depth = 0;
  let firstBad = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] === '{') depth++;
    else if (m[i] === '}') {
      depth--;
      if (depth < 0 && !firstBad) { firstBad = lineOf(m, i); depth = 0; }
    }
  }
  return { balance: depth, badLine: firstBad };
}

export function parenBalance(code) {
  const m = maskCode(code);
  let d = 0;
  let min = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] === '(') d++;
    else if (m[i] === ')') { d--; if (d < min) min = d; }
  }
  return { balance: d, min };
}

/** Индекс закрывающей скобки для открывающей на позиции open (учитывает вложенность). */
export function matchBracket(masked, open) {
  const left = masked[open];
  const right = { '(': ')', '{': '}', '[': ']' }[left];
  if (!right) return -1;
  let d = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === left) d++;
    else if (masked[i] === right) { d--; if (d === 0) return i; }
  }
  return -1;
}

export function findIncludes(code) {
  const out = [];
  const rx = /^[ \t]*#[ \t]*include[ \t]*([<"])([^>"\n]+)[>"]/gm;
  let m;
  while ((m = rx.exec(String(code ?? '')))) {
    out.push({
      name: m[2].trim(), file: m[2].trim(), system: m[1] === '<',
      text: m[0].trim(), line: lineOf(code, m.index), index: m.index,
    });
  }
  return out;
}

const BAD_WORDS = new Set(['return', 'else', 'do', 'try', 'new', 'delete', 'case', 'throw', 'goto', 'sizeof', 'and', 'or', 'not', 'constexpr', 'static_assert', 'using', 'typedef', 'namespace', 'template']);

/**
 * Функции верхнего уровня: имя, возвращаемый тип, аргументы, строка, есть ли тело.
 * Комментарии и строки предварительно маскируются, поэтому "функция в комментарии" не помешает.
 */
export function findFunctions(code) {
  const src = String(code ?? '');
  const masked = maskCode(src);
  const out = [];
  const rx = new RegExp(`(${ID}(?:\\s*::\\s*${ID})?)\\s*\\(`, 'g');
  let m;
  while ((m = rx.exec(masked))) {
    const name = m[1].replace(/\s*::\s*/g, '::');
    const short = name.includes('::') ? name.split('::').pop() : name;
    if (CONTROL.has(short) || BAD_WORDS.has(short)) continue;
    // перед '(' должно быть имя функции: буква/цифра/подчёркивание, а не оператор
    const prev = masked[m.index - 1];
    if (prev && /[\w:]/.test(prev)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    // что идёт сразу после ')' — тело, инициализация или объявление
    let k = close + 1;
    while (k < masked.length && /\s/.test(masked[k])) k++;
    let hasBody = false;
    let isDecl = false;
    const rest = masked.slice(k, k + 20);
    if (masked[k] === '{') hasBody = true;
    else if (rest.startsWith(';') || rest.startsWith('=') && rest.includes(';') && !rest.includes('{')) isDecl = true;
    else if (/^(const|noexcept|override|final)\b/.test(rest)) {
      let j = k;
      while (j < masked.length && /[A-Za-z_ ]/.test(masked[j])) j++;
      while (j < masked.length && /\s/.test(masked[j])) j++;
      if (masked[j] === '{') hasBody = true;
      else if (masked[j] === ':') {
        // список инициализации конструктора
        const semi = masked.indexOf(';', j);
        const brace = masked.indexOf('{', j);
        if (brace > -1 && (semi === -1 || brace < semi)) hasBody = true;
        else isDecl = true;
      } else isDecl = true;
    } else if (masked[k] === ':') {
      const semi = masked.indexOf(';', k);
      const brace = masked.indexOf('{', k);
      if (brace > -1 && (semi === -1 || brace < semi)) hasBody = true;
      else isDecl = true;
    } else continue;

    // тело должно быть на верхнем уровне вложенности: методы класса отбрасываем,
    // иначе прототипы получили бы методы и сборка ломалась
    const depth = depthAt(masked, m.index);
    if (depth > 0) continue;
    if (depth === 1) {
      // внутри чего-то — может быть метод класса; проверим, что это class/struct, а не функция
      const owner = ownerKeyword(masked, m.index);
      if (owner !== 'class' && owner !== 'struct') continue;
    }

    // смотрим назад: тип возврата и квалификаторы
    const { ret, kw } = scanReturn(masked, m.index);
    if (!ret && !name.includes('::')) {
      // конструктор класса или вызов макроса — не функция верхнего уровня
      const owner = ownerKeyword(masked, m.index);
      if (owner === 'class' || owner === 'struct') {
        out.push(decl(src, masked, { name, short, ret: '', kw: '', args: masked.slice(open + 1, close), line: lineOf(masked, m.index), index: m.index, hasBody, isDecl, isCtor: true, isMethod: true, cls: ownerName(masked, m.index) }));
      }
      continue;
    }
    out.push(decl(src, masked, { name, short, ret, kw, args: masked.slice(open + 1, close), line: lineOf(masked, m.index), index: m.index, hasBody, isDecl, isCtor: false, isMethod: name.includes('::'), cls: name.includes('::') ? name.split('::')[0] : '' }));
  }
  return out;
}

function decl(src, masked, base) {
  const args = base.args.trim();
  return {
    ...base,
    argsText: args,
    args: splitArgs(args).map((a) => a.trim()).filter((a) => a && a !== 'void'),
    bodyStart: base.hasBody ? masked.indexOf('{', base.index + 1) : -1,
    signature: `${base.ret ? base.ret + ' ' : ''}${base.name}(${args})`,
  };
}

function depthAt(masked, index) {
  let d = 0;
  for (let i = 0; i < index; i++) if (masked[i] === '{') d++; else if (masked[i] === '}') d = Math.max(0, d - 1);
  return d;
}

/** Найти ближайшее ключевое слово-владелец (class/struct) перед позицией. */
function ownerKeyword(masked, index) {
  const before = masked.slice(Math.max(0, index - 4000), index);
  const m = /(?:^|[^\w])(class|struct|namespace)\s*$/.exec(before)
    || /(?:^|[^\w])(class|struct|namespace)\s+[\w:<>, ]*\s*\{[^{}]*$/.exec(before);
  return m ? m[1] : '';
}

function ownerName(masked, index) {
  const before = masked.slice(0, index);
  const m = /(?:class|struct)\s+([A-Za-z_]\w*)\s*(?::[^{]*)?\{[^{}]*$/.exec(before);
  return m ? m[1] : '';
}

/** Тип возврата перед именем функции: поднимаемся до ; { } ) или ключевого слова. */
function scanReturn(masked, nameIndex) {
  let i = nameIndex - 1;
  const stop = new Set([';', '{', '}', ')', ',', '=', '+', '-', '*', '/', '&', '|', '!', '?', ':', '<', '>', '%', '^', '~']);
  while (i >= 0 && /\s/.test(masked[i])) i--;
  let end = i + 1;
  while (i >= 0 && !stop.has(masked[i])) i--;
  let text = masked.slice(i + 1, end).trim();
  // отделяем квалификаторы (static, inline, constexpr…)
  const kws = [];
  let ret = text;
  for (;;) {
    const m = /^(static|inline|constexpr|extern|virtual|explicit|friend|template|unsigned|signed|const|volatile|struct)\s+/.exec(ret);
    if (!m) break;
    if (m[1] === 'unsigned' || m[1] === 'signed' || m[1] === 'const' || m[1] === 'volatile' || m[1] === 'struct') break;
    kws.push(m[1]);
    ret = ret.slice(m[0].length);
  }
  if (ret === 'unsigned' || ret === 'signed') ret = ret + ' ' + (masked.slice(end).match(/^\s*(\w+)/) ? '' : '');
  return { ret: ret.trim(), kw: kws.join(' ') };
}

/* ------------------------------------------------------------------ аргументы и вызовы */

/** Разбить список аргументов по запятым верхнего уровня. */
export function splitArgs(text) {
  const s = String(text ?? '');
  const masked = maskCode(s, { keepStrings: true });
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Все вызовы функций вида name(args) — с позициями и готовыми аргументами. */
export function extractCalls(code, { names = null } = {}) {
  const src = String(code ?? '');
  const masked = maskCode(src);
  const out = [];
  // захватываем цепочку вида Serial1.print(, Wire.begin(, servo.attach( — чтобы знать приёмник
  const rx = new RegExp(`((?:${ID}\\s*(?:\\.|->)\\s*)*${ID}(?:\\s*::\\s*${ID})?)\\s*\\(`, 'g');
  let m;
  while ((m = rx.exec(masked))) {
    const full = m[1].replace(/\s*::\s*/g, '::').replace(/\s*(?:\.|->)\s*/g, '.');
    const parts = full.split('.');
    const name = parts.pop();
    const receiver = parts.join('.');
    const short = name.includes('::') ? name.split('::').pop() : name;
    const prev = masked[m.index - 1];
    if (prev && /[\w:]/.test(prev)) continue;
    if (names && !names.has(short)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const argText = src.slice(open + 1, close);
    out.push({
      name: short, full, receiver, index: m.index, line: lineOf(masked, m.index),
      argText, args: splitArgs(argText).map((a) => a.trim()),
      isControl: CONTROL.has(short),
    });
  }
  return out;
}

/** Проверка: встречается ли вызов (ищем по маске). */
export function hasCall(masked, names) {
  const set = names instanceof Set ? names : new Set(Array.isArray(names) ? names : [names]);
  const rx = new RegExp(`(?:^|[^\\w:])((?:${[...set].join('|')}))\\s*\\(`, 'm');
  return rx.test(masked);
}

/** Тело функции по имени (для loop/setup/ISR). Возвращает {start,end,body,line} или null. */
export function functionBody(code, name, { last = false } = {}) {
  const fns = findFunctions(code).filter((f) => f.short === name && f.hasBody);
  const fn = last ? fns[fns.length - 1] : fns[0];
  if (!fn) return null;
  const masked = maskCode(code);
  const start = masked.indexOf('{', fn.index);
  const end = matchBracket(masked, start);
  return { fn, start, end, body: code.slice(start + 1, end), line: fn.line };
}

/* ------------------------------------------------------------------ сгенерированные прототипы */

/**
 * Прототипы для вставки в начало .cpp (Arduino IDE делает то же самое, но мы — сами).
 * Пропускаем: setup/loop (они и так первыми), конструкторы, дубликаты, методы с ::.
 */
export function generatePrototypes(functions, { skip = ['setup', 'loop', 'main'] } = {}) {
  const skipSet = new Set(skip);
  const seen = new Set();
  const list = [];
  for (const f of functions) {
    if (!f.hasBody && !f.isDecl) continue;
    if (f.isCtor || f.name.includes('::') || !f.ret) continue;
    if (f.kw.includes('template')) continue;
    if (skipSet.has(f.short)) continue;
    if (seen.has(f.short)) continue;
    seen.add(f.short);
    const args = f.args.length ? f.args.join(', ') : '';
    const kw = f.kw ? f.kw + ' ' : '';
    list.push({ name: f.short, text: `${kw}${f.ret} ${f.short}(${args});`, line: f.line });
  }
  return list;
}

/* ------------------------------------------------------------------ полезные мелочи */

/** Все числовые константы в строке (для проверок диапазонов). */
export function numbersIn(text) {
  const out = [];
  const rx = /(?:^|[^\w.])(\d+)(?![\w.])/g;
  let m;
  while ((m = rx.exec(String(text ?? '')))) out.push({ value: Number(m[1]), index: m.index + m[0].indexOf(m[1]) });
  return out;
}

/** Проверка: похоже ли выражение на присваивание (один '=', не '==', '<=', '>='). */
export function isAssignment(expr) {
  const masked = maskCode(expr);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '=') continue;
    const prev = masked[i - 1];
    const next = masked[i + 1];
    if (prev === '=' || prev === '!' || prev === '<' || prev === '>' || prev === '+' || prev === '-' || prev === '*' || prev === '/' || prev === '%' || prev === '&' || prev === '|' || prev === '^') continue;
    if (next === '=') continue;
    return true;
  }
  return false;
}

/** Имена переменных, объявленных в области (грубо, но для линтера достаточно). */
export function findVarDecls(code) {
  const masked = maskCode(code);
  const types = '(?:unsigned\\s+long|unsigned\\s+int|unsigned\\s+char|signed\\s+long|const\\s+unsigned\\s+long|const\\s+int|unsigned|long|int|short|float|double|char|bool|boolean|byte|word|String|std::string|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|size_t|volatile\\s+int|volatile\\s+unsigned\\s+long|unsigned\\s+long\\s+int)';
  const rx = new RegExp(`(?:^|[;{}\\s])(${types})\\s+(\\*{0,2})(${ID})\\s*(=|;)`, 'gm');
  const out = [];
  let m;
  while ((m = rx.exec(masked))) {
    out.push({ type: m[1].replace(/\s+/g, ' '), ptr: m[2] || '', name: m[3], line: lineOf(masked, m.index), index: m.index, assigned: m[4] === '=' });
  }
  return out;
}

/** Есть ли в тексте токен (по границам слова). */
export function hasWord(masked, word) {
  return new RegExp(`(?:^|[^\\w:])${word}(?:[^\\w:]|$)`).test(masked);
}

export function countWord(masked, word) {
  return (masked.match(new RegExp(`(?:^|[^\\w:])${word}(?:[^\\w:]|$)`, 'g')) || []).length;
}

export const __internal = { ID, depthAt, scanReturn, ownerKeyword };

/**
 * Таблица имён файлов: «#define LED_PIN 13», «const int BTN = 2;», «static byte CS = 10;».
 * Зачем: в настоящих скетчах пины почти всегда названы, а не написаны числами.
 * Возвращает Map(name → { name, file, start, end, raw }) — без знания, что это пин.
 */
export function constTable(files) {
  const map = new Map();
  const types = 'int|long|short|byte|word|char|unsigned|signed|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|size_t|auto|const';
  const defRe = /#\s*define\s+([A-Za-z_]\w*)[ \t]+([^\n]+)/g;
  const varRe = new RegExp(`^[ \\t]*(?:(?:static|const|constexpr)[ \\t]+)*(?:(?:${types})[ \\t]+)+([A-Za-z_]\\w*)[ \\t]*=[ \\t]*([^;\\n]+);`, 'gm');
  for (const f of files || []) {
    const code = String(f?.content ?? '');
    let m;
    defRe.lastIndex = 0;
    while ((m = defRe.exec(code))) {
      const value = String(m[2]).replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (!value || /^\(/.test(value) || map.has(m[1])) continue;
      const start = m.index + m[0].indexOf(value);
      map.set(m[1], { name: m[1], file: f.path, start, end: start + value.length, raw: value });
    }
    varRe.lastIndex = 0;
    while ((m = varRe.exec(code))) {
      if (map.has(m[1])) continue;
      const value = String(m[2]).trim();
      const start = m.index + m[0].indexOf(m[2]);
      map.set(m[1], { name: m[1], file: f.path, start, end: start + value.length, raw: value });
    }
  }
  return map;
}

/** CRC16 (CCITT-FALSE, полином 0x1021) — для кадров телеметрии и проверок. */
export function crc16(bytes) {
  let crc = 0xFFFF;
  for (const b of bytes || []) {
    crc ^= (b & 0xFF) << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc & 0xFFFF;
}
