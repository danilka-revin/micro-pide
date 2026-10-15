// Автодополнение в духе PyCharm: список подсказок при наборе, навигация
// стрелками, выбор Tab или Enter, панель с описанием. Знание Arduino API
// встроено (функции, константы, Serial/SPI/Wire/EEPROM, #include), плюс
// идентификаторы из самого скетча.
import { type CompletionContext, type CompletionResult, snippet } from '@codemirror/autocomplete';

export interface Item {
  label: string;
  detail?: string;
  info?: string;
  /** builtin-типы иконок: function, method, class, type, constant, keyword, variable, text */
  type: string;
  boost?: number;
  apply?: any;
}

const F = (label: string, detail: string, info: string): Item => ({ label, detail, info, type: 'function' });
const M = (label: string, detail: string, info: string): Item => ({ label, detail, info, type: 'method' });
const C = (label: string, info: string): Item => ({ label, info, type: 'constant' });
const T = (label: string, info: string): Item => ({ label, info, type: 'type' });
const K = (label: string): Item => ({ label, type: 'keyword' });

// ---------------------------------------------------------------- ядро Arduino

const CORE: Item[] = [
  F('pinMode', '(pin, mode)', 'Настроить пин: INPUT (вход), OUTPUT (выход) или INPUT_PULLUP (вход с подтяжкой).'),
  F('digitalWrite', '(pin, value)', 'Подать на пин HIGH или LOW (работает после pinMode OUTPUT).'),
  F('digitalRead', '(pin)', 'Прочитать уровень на пине: HIGH или LOW.'),
  F('analogRead', '(pin)', 'Аналого-цифровое преобразование: 0..1023 (пины A0…A7).'),
  F('analogWrite', '(pin, value)', 'ШИМ-сигнал: value 0..255 (пины ~3, ~5, ~6, ~9, ~10, ~11 на Uno).'),
  F('analogReference', '(type)', 'Опорное напряжение АЦП: DEFAULT, INTERNAL, EXTERNAL.'),
  F('delay', '(ms)', 'Пауза в миллисекундах (блокирующая).'),
  F('delayMicroseconds', '(us)', 'Пауза в микросекундах.'),
  F('millis', '()', 'Миллисекунды с запуска платы (unsigned long). Для мигания без delay().'),
  F('micros', '()', 'Микросекунды с запуска платы.'),
  F('pulseIn', '(pin, value)', 'Измерить длительность импульса в микросекундах.'),
  F('shiftOut', '(dataPin, clockPin, order, value)', 'Выдать байт побитово: MSBFIRST или LSBFIRST.'),
  F('shiftIn', '(dataPin, clockPin, order)', 'Принять байт побитово.'),
  F('tone', '(pin, freq)', 'Звук заданной частоты (Гц) на пин; третий аргумент — длительность, мс.'),
  F('noTone', '(pin)', 'Остановить генерацию звука.'),
  F('random', '(min, max)', 'Случайное число в диапазоне [min, max).'),
  F('randomSeed', '(seed)', 'Зерно генератора случайных чисел.'),
  F('attachInterrupt', '(irq, isr, mode)', 'Прерывание: mode CHANGE, RISING или FALLING; пин через digitalPinToInterrupt().'),
  F('detachInterrupt', '(irq)', 'Отключить прерывание.'),
  F('interrupts', '()', 'Разрешить прерывания.'),
  F('noInterrupts', '()', 'Запретить прерывания (критическая секция).'),
  F('digitalPinToInterrupt', '(pin)', 'Номер прерывания для пина — передавать в attachInterrupt.'),
];

const MATH: Item[] = [
  F('map', '(x, inMin, inMax, outMin, outMax)', 'Пересчёт значения из одного диапазона в другой, например map(x, 0, 1023, 0, 255).'),
  F('constrain', '(x, a, b)', 'Ограничить значение диапазоном [a, b].'),
  F('abs', '(x)', 'Модуль числа.'),
  F('min', '(a, b)', 'Меньшее из двух.'),
  F('max', '(a, b)', 'Большее из двух.'),
  F('pow', '(base, exp)', 'Степень.'),
  F('sqrt', '(x)', 'Квадратный корень.'),
  F('sin', '(rad)', 'Синус (радианы).'),
  F('cos', '(rad)', 'Косинус (радианы).'),
  F('tan', '(rad)', 'Тангенс (радианы).'),
  F('lowByte', '(x)', 'Младший байт числа.'),
  F('highByte', '(x)', 'Старший байт числа.'),
  F('bitRead', '(x, n)', 'Прочитать бит n.'),
  F('bitWrite', '(x, n, b)', 'Записать бит n.'),
  F('bitSet', '(x, n)', 'Установить бит n в 1.'),
  F('bitClear', '(x, n)', 'Сбросить бит n в 0.'),
  F('bit', '(n)', 'Маска бита n: bit(3) == 8.'),
  F('isinf', '(x)', 'Проверка на бесконечность.'),
  F('isnan', '(x)', 'Проверка на NaN.'),
];

const CONSTANTS: Item[] = [
  C('HIGH', 'Высокий уровень (логическая 1).'),
  C('LOW', 'Низкий уровень (логический 0).'),
  C('INPUT', 'Пин как вход.'),
  C('OUTPUT', 'Пин как выход.'),
  C('INPUT_PULLUP', 'Вход со встроенной подтяжкой к питанию.'),
  C('LED_BUILTIN', 'Пин встроенного светодиода (13 на Uno/Nano).'),
  C('CHANGE', 'Прерывание по любому изменению уровня.'),
  C('RISING', 'Прерывание по фронту (0 → 1).'),
  C('FALLING', 'Прерывание по спаду (1 → 0).'),
  C('A0', 'Аналоговый пин 0.'),
  C('A1', 'Аналоговый пин 1.'),
  C('A2', 'Аналоговый пин 2.'),
  C('A3', 'Аналоговый пин 3.'),
  C('A4', 'Аналоговый пин 4 (также SDA на Uno).'),
  C('A5', 'Аналоговый пин 5 (также SCL на Uno).'),
  C('PI', 'Число π.'),
  C('DEC', 'Система счисления: десятичная (для Serial.print).'),
  C('HEX', 'Система счисления: шестнадцатеричная.'),
  C('BIN', 'Система счисления: двоичная.'),
  C('MSBFIRST', 'Сначала старший бит (для shiftOut/shiftIn).'),
  C('LSBFIRST', 'Сначала младший бит.'),
  C('true', 'Истина.'),
  C('false', 'Ложь.'),
];

const TYPES: Item[] = [
  T('void', 'Отсутствие значения (возврат функции).'),
  T('bool', 'Логический тип: true/false.'),
  T('char', 'Символ, 1 байт.'),
  T('byte', 'Беззнаковое, 0..255.'),
  T('short', 'Короткое целое, 2 байта.'),
  T('int', 'Целое, 2 байта на AVR (-32768..32767).'),
  T('long', 'Длинное целое, 4 байта.'),
  T('unsigned', 'Беззнаковый модификатор.'),
  T('float', 'Дробное, 4 байта.'),
  T('double', 'На AVR совпадает с float.'),
  T('word', 'Беззнаковое, 2 байта.'),
  T('String', 'Класс строк Arduino: конкатенация, length(), toInt() и т.д.'),
  T('uint8_t', 'Беззнаковое ровно 8 бит.'),
  T('uint16_t', 'Беззнаковое ровно 16 бит.'),
  T('uint32_t', 'Беззнаковое ровно 32 бита.'),
  T('int8_t', 'Знаковое ровно 8 бит.'),
  T('int32_t', 'Знаковое ровно 32 бита.'),
  T('size_t', 'Тип для размеров (результат sizeof).'),
];

const KEYWORDS: Item[] = [
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'goto', 'struct', 'enum', 'class', 'const', 'static', 'volatile', 'inline',
  'sizeof', 'typedef', 'new', 'delete', 'public', 'private', 'protected', 'virtual',
  'namespace', 'using', 'template', 'try', 'catch', 'extern', 'register',
].map(K);

const SNIPPETS: Item[] = [
  {
    label: 'setup+loop', detail: 'шаблон скетча', type: 'text', boost: 20,
    apply: snippet('void setup() {\n  ${}\n}\n\nvoid loop() {\n  ${}\n}'),
    info: 'Каркас скетча: setup() выполняется один раз при подаче питания, loop() крутится бесконечно.',
  },
  {
    label: 'serial-begin', detail: 'инициализация монитора', type: 'text', boost: 10,
    apply: snippet('Serial.begin(${9600});\n${}'),
    info: 'Открыть Serial-порт; скорость должна совпадать с выбранной в мониторе порта.',
  },
];

// ---------------------------------------------------------------- объекты

const SERIAL_MEMBERS: Item[] = [
  M('begin', '(baud)', 'Открыть порт с заданной скоростью: Serial.begin(9600).'),
  M('end', '()', 'Закрыть порт.'),
  M('available', '()', 'Сколько байт пришло и ждёт чтения.'),
  M('read', '()', 'Прочитать один байт (-1, если пусто).'),
  M('peek', '()', 'Посмотреть байт, не забирая его.'),
  M('flush', '()', 'Дождаться отправки всех данных.'),
  M('print', '(x)', 'Печатать значение/строку без перевода строки.'),
  M('println', '(x)', 'Печатать с переводом строки.'),
  M('write', '(val)', 'Отправить байт/массив как есть.'),
  M('readString', '()', 'Прочитать всё пришедшее как строку.'),
  M('readStringUntil', '(term)', 'Читать строку до символа-терминатора.'),
  M('readBytes', '(buf, len)', 'Прочитать массив байтов.'),
  M('parseInt', '()', 'Прочитать очередное целое число из потока.'),
  M('parseFloat', '()', 'Прочитать дробное число из потока.'),
  M('find', '(target)', 'Ждать в потоке указанную строку.'),
  M('setTimeout', '(ms)', 'Таймаут для readString/parseInt и т.п.'),
];

const SPI_MEMBERS: Item[] = [
  M('begin', '()', 'Инициализировать шину SPI.'),
  M('end', '()', 'Закрыть SPI.'),
  M('transfer', '(val)', 'Обменяться байтом с устройством: отправить val, вернуть ответ.'),
  M('beginTransaction', '(settings)', 'Открыть транзакцию SPI (SPISettings).'),
  M('endTransaction', '()', 'Закрыть транзакцию.'),
  M('setDataMode', '(mode)', 'Режим SPI_MODE0..3.'),
  M('setClockDivider', '(div)', 'Делитель частоты: SPI_CLOCK_DIV2…DIV128.'),
  M('setBitOrder', '(order)', 'MSBFIRST или LSBFIRST.'),
];

const WIRE_MEMBERS: Item[] = [
  M('begin', '()', 'Включить I2C в роли мастера; begin(addr) — в роли слейва.'),
  M('end', '()', 'Выключить I2C.'),
  M('beginTransmission', '(addr)', 'Начать передачу устройству с адресом addr.'),
  M('write', '(val)', 'Байт(ы) в передачу.'),
  M('endTransmission', '()', 'Завершить передачу; вернёт 0 при успехе.'),
  M('requestFrom', '(addr, n)', 'Запросить n байтов у устройства.'),
  M('available', '()', 'Сколько ботов доступно после requestFrom.'),
  M('read', '()', 'Прочитать байт.'),
  M('onReceive', '(cb)', 'Колбэк: мастер прислал данные (для слейва).'),
  M('onRequest', '(cb)', 'Колбэк: мастер запросил данные (для слейва).'),
];

const EEPROM_MEMBERS: Item[] = [
  M('read', '(addr)', 'Прочитать байт EEPROM (0..1023 на Uno).'),
  M('write', '(addr, val)', 'Записать байт (ресурс ~100000 циклов).'),
  M('update', '(addr, val)', 'Записать, только если значение изменилось — бережёт ресурс.'),
  M('get', '(addr, obj)', 'Прочитать любой тип (float, struct…).'),
  M('put', '(addr, obj)', 'Записать любой тип.'),
  M('length', '()', 'Размер EEPROM в байтах.'),
];

export const MEMBERS: Record<string, Item[]> = {
  Serial: SERIAL_MEMBERS,
  Serial1: SERIAL_MEMBERS,
  Serial2: SERIAL_MEMBERS,
  Serial3: SERIAL_MEMBERS,
  SPI: SPI_MEMBERS,
  Wire: WIRE_MEMBERS,
  EEPROM: EEPROM_MEMBERS,
};

// ---------------------------------------------------------------- #include

const HEADERS: Item[] = [
  'Arduino.h', 'SPI.h', 'Wire.h', 'EEPROM.h', 'SoftwareSerial.h', 'Servo.h', 'Stepper.h',
  'LiquidCrystal.h', 'LiquidCrystal_I2C.h', 'Adafruit_GFX.h', 'Adafruit_SSD1306.h',
  'Adafruit_NeoPixel.h', 'FastLED.h', 'DHT.h', 'OneWire.h', 'DallasTemperature.h',
  'IRremote.h', 'RF24.h', 'Ethernet.h', 'WiFi.h', 'SD.h', 'Ticker.h', 'math.h', 'stdlib.h', 'string.h',
].map((h) => ({ label: h, type: 'text', info: `Заголовок ${h}.` }));

// ---------------------------------------------------------------- источник

/** Идентификаторы из самого скетча (переменные, свои функции). */
function docIdentifiers(ctx: CompletionContext, exclude: string): string[] {
  const text = ctx.state.doc.toString();
  const seen = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_]\w{2,}/g)) {
    if (m[0] !== exclude && !seen.has(m[0])) seen.add(m[0]);
    if (seen.size > 300) break;
  }
  return [...seen];
}

/**
 * Источник подсказок: после «объект.» — методы объекта; после #include —
 * заголовки; иначе — Arduino API, ключевые слова, типы и слова из скетча.
 */
export function arduinoCompletion(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);

  let m = /#include\s*[<"]([\w./+-]*)$/.exec(before);
  if (m) {
    return { from: ctx.pos - m[1].length, options: HEADERS, validFor: /^[\w./+-]*$/ };
  }

  m = /([A-Za-z_]\w*)\s*\.\s*(\w*)$/.exec(before);
  if (m) {
    const members = MEMBERS[m[1]];
    if (!members) return null;
    return { from: ctx.pos - m[2].length, options: members, validFor: /^\w*$/ };
  }

  m = /([A-Za-z_]\w*)$/.exec(before);
  if (!m) return null;
  const word = m[1];
  if (word.length < 1) return null;
  const from = ctx.pos - word.length;
  const lower = word.toLowerCase();

  const options: any[] = [];
  const seen = new Set<string>();
  const push = (items: Item[], boost: number) => {
    for (const it of items) {
      if (seen.has(it.label)) continue;
      if (!it.label.toLowerCase().startsWith(lower)) continue;
      seen.add(it.label);
      options.push({ ...it, boost: (it.boost ?? 0) + boost });
    }
  };
  push(SNIPPETS, 12);
  push(CORE, 6);
  push(MATH, 5);
  push(CONSTANTS, 4);
  push(TYPES, 3);
  push(KEYWORDS, 2);
  for (const id of docIdentifiers(ctx, word)) {
    if (!seen.has(id) && id.toLowerCase().startsWith(lower)) {
      seen.add(id);
      options.push({ label: id, type: 'variable', boost: -1 });
    }
  }
  if (!options.length) return null;
  options.sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0));
  return { from, options: options.slice(0, 60), validFor: /^[A-Za-z_]\w*$/ };
}
