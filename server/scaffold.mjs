// Генераторы MicroPIDE: заготовки скетчей, которых нет в Arduino IDE,
// скелет своей библиотеки и модуль-класс внутри скетча.
//
// Почему своё: серверы Arduino недоступны, а «Примеры → Blink» давно не
// отвечает на вопрос «а как правильно». Здесь шаблоны сразу показывают
// неблокирующий код, сон, телеметрию и самопроверку — то, чего в классических
// примерах нет.
import { boardCaps, findBoard } from './boarddb.mjs';
import { analogPinNumbers, pinLabel, usesAnalogLabels } from './analysis.mjs';

const esc = (s) => String(s || '');
const ident = (s) => String(s || '').replace(/[^\p{L}\d_]/gu, '');
const pascal = (s) => ident(s).replace(/^./, (c) => c.toUpperCase()) || 'MyLib';

/** Шаблоны скетчей: id → генератор. */
export const TEMPLATES = {
  blink_noblock: {
    title: 'Мигание без delay()',
    desc: 'Неблокирующий скетч: millis(), состояние кнопки, защита от дребезга — так пишут в реальных устройствах.',
    gen: ({ led, btn }) => `// Мигание без delay(): loop() всегда свободен для других задач.
// MicroPIDE: основа для любого «одновременного» кода.
const int LED_PIN = ${led};
const int BTN_PIN = ${btn};
const unsigned long BLINK_MS = 500;

bool ledOn = false;
unsigned long tLed = 0;
bool btnWas = false;
unsigned long tBtn = 0;

void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP);
  Serial.begin(115200);
}

void loop() {
  const unsigned long now = millis();

  if (now - tLed >= BLINK_MS) {   // сравнение без переполнения
    tLed = now;
    ledOn = !ledOn;
    digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
  }

  const bool btn = digitalRead(BTN_PIN) == LOW;
  if (btn && !btnWas && now - tBtn > 30) {  // фронт + антидребезг
    tBtn = now;
    Serial.print(F("tick "));
    Serial.println(now);
  }
  btnWas = btn;
}
`,
  },
  state_machine: {
    title: 'Конечный автомат (неблокирующий)',
    desc: 'switch по состояниям и таймеры: перезапуск, кнопка, светодиод, телеметрия. Заменяет «полотно» из delay.',
    gen: ({ led, btn }) => `// Конечный автомат: ни одного delay(), состояния видны в Serial и MicroTelem.
enum State { IDLE, WORK, PAUSE, DONE };
State state = IDLE;

const int LED_PIN = ${led};
const int BTN_PIN = ${btn};
const unsigned long WORK_MS = 2000;
const unsigned long PAUSE_MS = 1000;

unsigned long tState = 0;
unsigned char cycles = 0;

void enter(State s) {
  state = s;
  tState = millis();
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  enter(IDLE);
}

void loop() {
  const unsigned long now = millis();
  if (digitalRead(BTN_PIN) == LOW) enter(IDLE);   // кнопка сбрасывает сценарий

  switch (state) {
    case IDLE:
      digitalWrite(LED_PIN, LOW);
      enter(WORK);
      break;
    case WORK:
      digitalWrite(LED_PIN, HIGH);
      if (now - tState >= WORK_MS) { cycles++; enter(PAUSE); }
      break;
    case PAUSE:
      digitalWrite(LED_PIN, LOW);
      if (now - tState >= PAUSE_MS) enter(cycles >= 5 ? DONE : WORK);
      break;
    case DONE:
      digitalWrite(LED_PIN, LOW);
      Serial.print(F("готово, циклов: "));
      Serial.println(cycles);
      cycles = 0;
      enter(IDLE);
      break;
  }
}
`,
  },
  deep_sleep: {
    title: 'Батарейная поделка (сон + пробуждение)',
    desc: 'Глубокий сон с пробуждением по таймеру: устройство живёт месяцами. Для ESP32/ESP8266 и плат с LowPower.',
    gen: ({ board }) => {
      const isEsp = /esp/i.test(board?.arch || '');
      return isEsp ? `// Просыпается раз в минуту, измеряет и снова спит (ESP32/ESP8266).
// MicroPIDE: профиль питания (Инструменты → Оценка питания) покажет срок жизни батареи.
#include <WiFi.h>
#include <esp_sleep.h>

const int SENSOR_PIN = ${sensorPinFor(board)};
RTC_DATA_ATTR unsigned long boots = 0;

void setup() {
  Serial.begin(115200);
  boots++;
  const int raw = analogRead(SENSOR_PIN);
  Serial.printf("boot #%lu, raw=%d\\n", boots, raw);
}

void loop() {
  esp_sleep_enable_timer_wakeup(60ULL * 1000000ULL);  // 60 с
  esp_deep_sleep_start();                             // код дальше не выполняется
}
`
        : `// Просыпается раз в минуту через watchdog/LowPower (AVR, SAMD).
#include <LowPower.h>

const int SENSOR_PIN = ${sensorPinFor(board)};
volatile bool tick = false;

void wake() { tick = true; }

void setup() {
  Serial.begin(115200);
  pinMode(SENSOR_PIN, INPUT);
}

void loop() {
  // 8 циклов по 8 с = 64 с сна; прерывание по watchdog
  for (int i = 0; i < 8; i++) LowPower.powerDown(SLEEP_8S, ADC_OFF, BOD_OFF);
  const int raw = analogRead(SENSOR_PIN);
  Serial.print("raw=");
  Serial.println(raw);
}
`;
    },
  },
  i2c_scanner: {
    title: 'Сканер шины I2C',
    desc: 'Находит все устройства на шине и печатает таблицу адресов — первое, что нужно при подключении модуля.',
    gen: ({ sda, scl }) => `// Сканер I2C: печатает адреса найденных устройств.
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin(${sda}, ${scl});
  Serial.println(F("Сканирую шину I2C…"));
  byte found = 0;
  for (byte a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.print(F("найден 0x"));
      if (a < 16) Serial.print('0');
      Serial.println(a, HEX);
      found++;
    }
  }
  Serial.print(F("всего устройств: "));
  Serial.println(found);
}

void loop() {}
`,
  },
  pins_report: {
    title: 'Карта пинов платы (по нашей базе)',
    desc: 'Печатает реальные возможности платы: ШИМ, АЦП, прерывания, занятые пины. Данные берутся из базы плат MicroPIDE.',
    gen: ({ board }) => {
      const b = board || {};
      const pwm = b.pwm || [];
      const adc = analogPinNumbers(b);
      return `// Что вообще умеет эта плата — из встроенной базы MicroPIDE.
// Плата: ${b.name || '—'} (${b.mcu || '—'}), ${b.voltage || '?'} В

void setup() {
  Serial.begin(115200);
  Serial.println(F("${esc(b.name).replace(/"/g, '')} — карта пинов"));
  Serial.print(F("ШИМ: "));
  ${pwm.length ? `const byte pwm[] = {${pwm.slice(0, 20).join(', ')}}; for (byte i = 0; i < sizeof(pwm); i++) { Serial.print(pwm[i]); Serial.print(' '); }` : 'Serial.print(F("нет"));'}
  Serial.println();
  Serial.print(F("АЦП: "));
  ${adc.length ? `const byte adc[] = {${adc.slice(0, 20).join(', ')}}; for (byte i = 0; i < sizeof(adc); i++) { Serial.print(adc[i]); Serial.print(' '); }` : 'Serial.print(F("нет"));'}
  Serial.println();
  Serial.print(F("Прерывания: "));
  const byte irq[] = {${(b.interrupt || []).slice(0, 16).join(', ')}};
  for (byte i = 0; i < sizeof(irq); i++) { Serial.print(irq[i]); Serial.print(' '); }
  Serial.println();
  Serial.print(F("Светодиод: "));
  Serial.println(${Number.isFinite(Number(b.led)) ? Number(b.led) : 'LED_BUILTIN'});
}

void loop() {}
`;
    },
  },
  telemetry: {
    title: 'Телеметрия MicroTelem',
    desc: 'Кадры с CRC16: видно в панели «Телеметрия» — графики, экспорт CSV и PNG. Работает и по проводу, и в симуляторе.',
    gen: ({ board }) => `// MicroTelem: текстовые строки #MT и бинарные кадры с CRC.
// Откройте «Инструменты → Телеметрия MicroTelem» — каналы появятся сами.
#include "MicroTelem.h"

const int SENSOR_PIN = ${sensorPinFor(board)};

void setup() {
  Serial.begin(115200);
  MICROTELEM_BEGIN(115200, 100);   // порт и период кадра, мс
}

void loop() {
  const float voltage = analogRead(SENSOR_PIN) * ${(Number(board?.voltage) || 5).toFixed(1)}f / 1023.0f;
  const float uptime = millis() / 1000.0;
  MICROTELEM(voltage, uptime);
}
`,
  },
  watchdog_safe: {
    title: 'Сторожевой таймер и безопасный режим',
    desc: 'Если loop() завис — плата перезагрузится, а в EEPROM/Preferences сохранится причина. Так делают промышленные устройства.',
    gen: ({ board }) => {
      const isEsp = /esp/i.test(board?.arch || '');
      return isEsp
        ? `// Сторожевой таймер ESP32: перезагрузка при зависании.
#include <esp_task_wdt.h>

hw_timer_t *timer = nullptr;
volatile bool hung = false;

void IRAM_ATTR tick() { hung = true; }

void setup() {
  Serial.begin(115200);
  esp_task_wdt_init(5, true);        // 5 с на итерацию
  esp_task_wdt_add(NULL);
}

void loop() {
  esp_task_wdt_reset();              // «я жив»
  // ...работа...
  delay(100);
}
`
        : `// Сторожевой таймер AVR: 2 с, перезагрузка при зависании.
#include <avr/wdt.h>
#include <EEPROM.h>

void setup() {
  Serial.begin(115200);
  wdt_enable(WDTO_2S);              // кормим собаку в конце loop()
  if (EEPROM.read(0) == 0xA5) {     // была перезагрузка по watchdog?
    Serial.println(F("watchdog срабатывал ранее"));
    EEPROM.write(0, 0);
  }
  Serial.println(F("старт"));
}

void loop() {
  // ...работа...
  EEPROM.update(0, 0xA5);
  wdt_reset();                       // всё хорошо
}
`;
    },
  },
  scenario_test: {
    title: 'Тест сценария (.mps)',
    desc: 'Свой язык проверок: ожидания по Serial, пинам, ШИМ и АЦП. Запускается в симуляторе без железа.',
    gen: ({ led }) => `# Тест сценария MicroPIDE: проверяем логику без платы.
name ${'Проверка мигания'}
baud 115200
duration 4000
fast on

# стартовая инициализация
wait 100
expect_pin D${led} = 0

# ждём первое включение и проверяем текст
wait 600
expect_pin D${led} = 1
expect_no "ошибка"

# в конце скетч должен что-то рассказать о себе
expect_re /(готово|tick)/ 3000
note Проверяем, что светодиод мигает и скетч печатает статус
`,
  },
};

/**
 * Первый аналоговый вход платы так, как его понимает компилятор: A0 у AVR-плат,
 * обычный номер GPIO у ESP32/SAMD (там имена A0… не определены).
 */
function sensorPinFor(board) {
  const caps = board || {};
  const adc = analogPinNumbers(caps);
  if (!adc.length) return 'A0';
  return usesAnalogLabels(caps) ? pinLabel(caps, adc[0]) : String(adc[0]);
}

/** Список шаблонов для UI. */
export function templatesForUi() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({ id, title: t.title, desc: t.desc }));
}

/**
 * Сгенерировать скетч по шаблону.
 * @returns {{ok:boolean, files?:any[], error?:string}}
 */
export function sketchTemplate({ id = '', name = 'Sketch', fqbn = '' } = {}) {
  const t = TEMPLATES[id];
  if (!t) return { ok: false, error: 'Нет такого шаблона: ' + id };
  const caps = boardCaps(fqbn);
  if (!caps) return { ok: false, error: 'Неизвестная плата: ' + (fqbn || '(пусто)') };
  const board = findBoard(fqbn);
  const led = caps.led != null ? caps.led : (caps.digital || [])[0] ?? 13;
  const busy = new Set([led, caps.uart?.rx, caps.uart?.tx, caps.i2c?.sda, caps.i2c?.scl]);
  const free = (caps.digital || []).filter((n) => !busy.has(n) && !caps.flashPins?.has(n) && !caps.inputOnly?.has(n) && !caps.strapping?.has(n));
  const btn = free.find((n) => n >= 2 && n <= 12) ?? free[0] ?? 2;
  const skName = name || 'Sketch';
  const code = t.gen({
    led, btn, sda: caps.i2c?.sda ?? '', scl: caps.i2c?.scl ?? '',
    board: {
      fqbn: caps.fqbn, name: board?.name, mcu: board?.mcu, arch: board?.arch, voltage: board?.voltage,
      led: board?.led, pwm: board?.pwm, interrupt: board?.interrupt, analog: caps.analog, digital: caps.digital,
    },
  });
  const files = [{ path: `${skName}.ino`, content: code }];
  if (/MicroTelem\.h/.test(code)) files.push({ path: 'MicroTelem.h', content: telemetryShim() });
  if (id === 'scenario_test') files.push({ path: `${skName}.mps`, content: code });
  return { ok: true, id, name: skName, files, title: t.title };
}

/** Заголовок MicroTelem для шаблона (урезанная версия серверного). */
function telemetryShim() {
  return `// MicroTelem — телеметрия MicroPIDE (текст + бинарные кадры с CRC16).
#pragma once
#include <Arduino.h>

#ifndef MICROTELEM_MAX
#define MICROTELEM_MAX 8
#endif

static uint16_t mt_crc16(const uint8_t *p, uint8_t n) {
  uint16_t crc = 0xFFFF;
  for (uint8_t i = 0; i < n; i++) {
    crc ^= (uint16_t)p[i] << 8;
    for (uint8_t b = 0; b < 8; b++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

static void mt_frame(float *vals, uint8_t n) {
  // Кадр: AA 55 | версия | каналов | CRC16(LE) | float32(LE) × n
  uint8_t buf[6 + MICROTELEM_MAX * 4];
  buf[0] = 0xAA; buf[1] = 0x55; buf[2] = 1; buf[3] = n;
  for (uint8_t i = 0; i < n; i++) {
    union { float f; uint8_t b[4]; } u; u.f = vals[i];
    for (uint8_t j = 0; j < 4; j++) buf[6 + i * 4 + j] = u.b[j];
  }
  const uint16_t crc = mt_crc16(buf + 6, n * 4);
  buf[4] = crc & 0xFF; buf[5] = crc >> 8;
  Serial.write(buf, sizeof(buf));
  Serial.println();
}

#define MICROTELEM_BEGIN(baud, periodMs) do { Serial.begin(baud); } while (0)
#define MICROTELEM(...) do { \\
  static float mt_v[] = { __VA_ARGS__ }; \\
  mt_frame(mt_v, sizeof(mt_v) / sizeof(mt_v[0])); \\
} while (0)
`;
}

/**
 * Скелет своей библиотеки: library.properties, keywords.txt, src/*.h/.cpp,
 * пример и README. Кладётся в скетчбук (libraries/<Name>) или в указанный путь.
 */
export function librarySkeleton({ name = '', author = '', version = '0.1.0', sentence = '', fqbn = '' } = {}) {
  const Name = pascal(name);
  if (!Name) return { ok: false, error: 'Нужно имя библиотеки (латиницей)' };
  const guard = `MICROPIDE_${Name.toUpperCase()}_H`;
  const caps = boardCaps(fqbn);
  const led = caps?.led ?? 13;
  const files = [
    {
      path: 'library.properties',
      content: `name=${Name}\nversion=${version}\nauthor=${author || 'неизвестен'}\nmaintainer=${author || 'неизвестен'}\nsentence=${sentence || Name + ' — библиотека MicroPIDE'}\nparagraph=Создано в MicroPIDE: автономная среда, которая не зависит от серверов Arduino.\ncategory=Device Control\nurl=\narchitectures=*\n`,
    },
    {
      path: 'keywords.txt',
      content: `${'#'} Синтаксис: имя\\tKEYWORD1|KEYWORD2|LITERAL1\n${Name}\\tKEYWORD1\n${Name}Begin\\tKEYWORD2\nbegin\\tKEYWORD2\nupdate\\tKEYWORD2\nread\\tKEYWORD2\n`,
    },
    {
      path: `src/${Name}.h`,
      content: `// ${Name} — библиотека MicroPIDE (${version}).
#pragma once
#include <Arduino.h>

class ${Name} {
 public:
  ${Name}();

  /** Инициализация: пин, бауд и подобное. Возвращает true при успехе. */
  bool begin(uint8_t pin = ${led});

  /** Опрос: вызывайте из loop() или по таймеру. */
  bool update();

  /** Последнее измеренное значение. */
  float read() const { return value_; }

  /** Настройки. */
  void setPeriod(uint16_t ms) { periodMs_ = ms; }

 private:
  uint8_t pin_ = 0;
  uint16_t periodMs_ = 100;
  float value_ = 0;
  unsigned long last_ = 0;
};
`,
    },
    {
      path: `src/${Name}.cpp`,
      content: `#include "${Name}.h"

${Name}::${Name}() {}

bool ${Name}::begin(uint8_t pin) {
  pin_ = pin;
  pinMode(pin_, INPUT);
  last_ = 0;
  return true;
}

bool ${Name}::update() {
  const unsigned long now = millis();
  if (now - last_ < periodMs_) return false;
  last_ = now;
  value_ = analogRead(pin_);            // ← своя логика здесь
  return true;
}
`,
    },
    {
      path: `examples/${Name}Demo/${Name}Demo.ino`,
      content: `// Пример библиотеки ${Name} (MicroPIDE).
#include <${Name}.h>

${Name} device;

void setup() {
  Serial.begin(115200);
  Serial.println(F("${Name}: старт"));
  if (!device.begin(${led})) Serial.println(F("не удалось начать"));
  device.setPeriod(200);
}

void loop() {
  if (device.update()) {
    Serial.print(F("value = "));
    Serial.println(device.read());
  }
}
`,
    },
    {
      path: 'README.md',
      content: `# ${Name}\n\n${sentence || 'Библиотека, созданная в MicroPIDE.'}\n\n## Установка\n\nСкопируйте папку \`${Name}\` в \`<скетчбук>/libraries/\` — MicroPIDE подхватит её\nбез интернета (серверы Arduino для этого не нужны).\n\n## Использование\n\n\`\`\`cpp\n#include <${Name}.h>\n\n${Name} device;\n\nvoid setup() {\n  device.begin(${led});\n}\n\nvoid loop() {\n  if (device.update()) { /* device.read() */ }\n}\n\`\`\`\n\n## Тесты\n\nОпишите ожидания в файле \`.mps\` и запустите «Инструменты → Тесты» — логика\nпроверится в симуляторе, без платы.\n`,
    },
  ];
  return { ok: true, name: Name, files, version };
}

/** Класс-модуль внутри скетча: .h + .cpp рядом с .ino. */
export function moduleSkeleton({ name = '', kind = 'sensor', fqbn = '' } = {}) {
  const Name = pascal(name);
  if (!Name) return { ok: false, error: 'Нужно имя класса' };
  const caps = boardCaps(fqbn);
  const pin = caps?.led ?? 13;
  const bodies = {
    sensor: {
      h: `#pragma once\n#include <Arduino.h>\n\n/** ${Name}: датчик — опрос по таймеру, без delay(). */\nclass ${Name} {\n public:\n  void begin(uint8_t pin);\n  bool poll();                 // true, когда есть новое значение\n  float value() const { return value_; }\n  void setPeriod(uint16_t ms) { periodMs_ = ms; }\n\n private:\n  uint8_t pin_ = ${pin};\n  uint16_t periodMs_ = 100;\n  float value_ = 0;\n  unsigned long last_ = 0;\n};\n`,
      cpp: `#include "${Name}.h"\n\nvoid ${Name}::begin(uint8_t pin) {\n  pin_ = pin;\n  pinMode(pin_, INPUT);\n}\n\nbool ${Name}::poll() {\n  const unsigned long now = millis();\n  if (now - last_ < periodMs_) return false;\n  last_ = now;\n  value_ = analogRead(pin_);\n  return true;\n}\n`,
    },
    actuator: {
      h: `#pragma once\n#include <Arduino.h>\n\n/** ${Name}: исполнительный механизм — плавно и неблокирующе. */\nclass ${Name} {\n public:\n  void begin(uint8_t pin);\n  void setTarget(float v);     // цель\n  void tick();                 // вызывайте в loop()\n  bool busy() const { return value_ != target_; }\n\n private:\n  uint8_t pin_ = ${pin};\n  float value_ = 0, target_ = 0;\n  unsigned long last_ = 0;\n  uint16_t stepMs_ = 20;\n};\n`,
      cpp: `#include "${Name}.h"\n\nvoid ${Name}::begin(uint8_t pin) {\n  pin_ = pin;\n  pinMode(pin_, OUTPUT);\n}\n\nvoid ${Name}::setTarget(float v) { target_ = v; }\n\nvoid ${Name}::tick() {\n  const unsigned long now = millis();\n  if (now - last_ < stepMs_ || value_ == target_) return;\n  last_ = now;\n  const float step = (target_ > value_ ? 1 : -1) * 5.0f;\n  value_ += step;\n  if ((step > 0 && value_ > target_) || (step < 0 && value_ < target_)) value_ = target_;\n  analogWrite(pin_, (int)value_ * 255 / 100);\n}\n`,
    },
    protocol: {
      h: `#pragma once\n#include <Arduino.h>\n\n/** ${Name}: разбор протокола — буфер, CRC, состояние. */\nclass ${Name} {\n public:\n  void begin(Stream &port);\n  bool poll();                  // true, когда собрался полный пакет\n  const char *lastText() const { return text_; }\n\n private:\n  Stream *port_ = nullptr;\n  char buf_[64] = {0};\n  uint8_t len_ = 0;\n  char text_[64] = {0};\n};\n`,
      cpp: `#include "${Name}.h"\n\nvoid ${Name}::begin(Stream &port) {\n  port_ = &port;\n}\n\nbool ${Name}::poll() {\n  if (!port_) return false;\n  while (port_->available()) {\n    const char c = (char)port_->read();\n    if (c == '\\n') {\n      buf_[len_] = 0;\n      strncpy(text_, buf_, sizeof(text_) - 1);\n      len_ = 0;\n      return true;\n    }\n    if (len_ < sizeof(buf_) - 1) buf_[len_++] = c;\n    else len_ = 0;\n  }\n  return false;\n}\n`,
    },
  };
  const b = bodies[kind] || bodies.sensor;
  return { ok: true, name: Name, kind: bodies[kind] ? kind : 'sensor', files: [{ path: `${Name}.h`, content: b.h }, { path: `${Name}.cpp`, content: b.cpp }] };
}
