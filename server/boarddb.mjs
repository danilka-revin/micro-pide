// Встроенная база плат MicroPIDE («своё вместо серверов Arduino»).
//
// Зачем: индексы downloads.arduino.cc недоступны, а жить как-то надо. Поэтому
// MicroPIDE больше не спрашивает у чужого сервера «что это за плата» — у него
// есть собственная база: характеристики МК, карта пинов, аппаратные особенности
// (PWM/ADC/прерывания/I2C/SPI), VID:PID для автоопределения, параметры загрузки
// (avrdude/esptool/bossac/picotool) и описание платформы.
//
// База используется:
//   • анализатором кода — проверка пинов, предупреждения «нет PWM на этом пине»;
//   • автоопределением платы по USB (VID:PID) без arduino-cli;
//   • генератором собственных индексов (package_index.json / library_index.json),
//     чтобы arduino-cli работал от локальных файлов и GitHub-зеркал;
//   • сборщиком buildcore.mjs — флаги, карта памяти, режим симулятора.
//
// Данные можно расширять/переопределять своим файлом `<data>/offline/boards.json`
// (массив в том же формате) — он подмешивается поверх встроенной базы.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.MICRO_PIDE_DATA || join(HERE, '..', '.data');

/** Диапазон чисел включительно: rng(2, 13) → [2..13]. */
const rng = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/** A-пины: A0..An → ['A0','A1',…]. */
const ax = (n) => Array.from({ length: n }, (_, i) => 'A' + i);

// ---------------------------------------------------------------------------
// Платы. Обязательные поля: fqbn, name, mcu, flash, ram. Остальное — по мере
// знания железа; анализатор и сборщик деградируют аккуратно, если поля нет.
// flash/ram — доступно скетчу (уже за вычетом загрузчика/служебной области).
// ---------------------------------------------------------------------------

export const BOARDS = [
  // ------------------------------------------------------------------ AVR
  {
    fqbn: 'arduino:avr:uno', name: 'Arduino Uno', vendor: 'arduino', arch: 'avr',
    mcu: 'ATmega328P', clock: 16_000_000, flash: 32_256, ram: 2_048, eeprom: 1_024,
    led: 13, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 19), analog: ax(6), pwm: [3, 5, 6, 9, 10, 11], interrupt: [2, 3],
    i2c: { sda: 18, scl: 19 }, spi: { ss: 10, mosi: 11, miso: 12, sck: 13 }, uart: { rx: 0, tx: 1 },
    reserved: { 0: 'Serial RX', 1: 'Serial TX', 13: 'светодиод + SPI SCK' },
    hints: ['пины 0/1 заняты USB-портом — не используйте их при загрузке', 'A4/A5 = SDA/SCL (подтяжка нужна)'],
    usbIds: [[0x2341, 0x0043], [0x2341, 0x0001], [0x1a86, 0x7523], [0x0403, 0x6001]],
    upload: { kind: 'avrdude', programmer: 'arduino', part: 'atmega328p', baud: 115200 }, simulator: true,
  },
  {
    fqbn: 'arduino:avr:nano', name: 'Arduino Nano (ATmega328)', vendor: 'arduino', arch: 'avr',
    mcu: 'ATmega328P', clock: 16_000_000, flash: 30_720, ram: 2_048, eeprom: 1_024,
    led: 13, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 19), analog: ax(8), pwm: [3, 5, 6, 9, 10, 11], interrupt: [2, 3],
    i2c: { sda: 18, scl: 19 }, spi: { ss: 10, mosi: 11, miso: 12, sck: 13 }, uart: { rx: 0, tx: 1 },
    hints: ['клоны часто требуют bootloader 57600 бод', 'A6/A7 — только вход, аналоговые'],
    usbIds: [[0x1a86, 0x7523], [0x0403, 0x6001], [0x2341, 0x0058]],
    upload: { kind: 'avrdude', programmer: 'arduino', part: 'atmega328p', baud: 57600 }, simulator: true,
  },
  {
    fqbn: 'arduino:avr:mini', name: 'Arduino Mini', vendor: 'arduino', arch: 'avr',
    mcu: 'ATmega328P', clock: 16_000_000, flash: 30_720, ram: 2_048, eeprom: 1_024,
    led: 13, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 19), analog: ax(8), pwm: [3, 5, 6, 9, 10, 11], interrupt: [2, 3],
    i2c: { sda: 18, scl: 19 }, spi: { ss: 10, mosi: 11, miso: 12, sck: 13 }, uart: { rx: 0, tx: 1 },
    upload: { kind: 'avrdude', programmer: 'arduino', part: 'atmega328p', baud: 57600 }, simulator: true,
  },
  {
    fqbn: 'arduino:avr:pro', name: 'Arduino Pro Mini (5V/16MHz)', vendor: 'arduino', arch: 'avr',
    mcu: 'ATmega328P', clock: 16_000_000, flash: 30_720, ram: 2_048, eeprom: 1_024,
    led: 13, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 19), analog: ax(8), pwm: [3, 5, 6, 9, 10, 11], interrupt: [2, 3],
    i2c: { sda: 18, scl: 19 }, spi: { ss: 10, mosi: 11, miso: 12, sck: 13 }, uart: { rx: 0, tx: 1 },
    upload: { kind: 'avrdude', programmer: 'arduino', part: 'atmega328p', baud: 57600 },
  },
  {
    fqbn: 'arduino:avr:mega', name: 'Arduino Mega 2560', vendor: 'arduino', arch: 'avr',
    mcu: 'ATmega2560', clock: 16_000_000, flash: 253_952, ram: 8_192, eeprom: 4_096,
    led: 13, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 53), analog: ax(16), pwm: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 44, 45, 46],
    interrupt: [2, 3, 18, 19, 20, 21], inputOnly: [],
    i2c: { sda: 20, scl: 21 }, spi: { ss: 53, mosi: 51, miso: 50, sck: 52 }, uart: { rx: 0, tx: 1 },
    hints: ['SPI вынесен на 50-53', 'Serial1..3 на 18/19, 16/17, 14/15'],
    usbIds: [[0x2341, 0x0010], [0x1a86, 0x7523]],
    upload: { kind: 'avrdude', programmer: 'wiring', part: 'atmega2560', baud: 115200 }, simulator: true,
  },
  {
    fqbn: 'arduino:avr:leonardo', name: 'Arduino Leonardo', vendor: 'arduino', arch: 'avr',
    mcu: 'ATmega32U4', clock: 16_000_000, flash: 28_672, ram: 2_560, eeprom: 1_024,
    led: 13, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 30), analog: ax(12), pwm: [3, 5, 6, 9, 10, 11, 13], interrupt: [0, 1, 2, 3, 7],
    i2c: { sda: 2, scl: 3 }, spi: { ss: 17, mosi: 16, miso: 14, sck: 15 }, uart: { rx: 0, tx: 1 },
    hints: ['Serial — это USB-CDC: Serial.begin(9600) ждёт открытия монитора', 'пины 0/1 — Serial1'],
    usbIds: [[0x2341, 0x8036]],
    upload: { kind: 'avrdude', programmer: 'avr109', part: 'atmega32u4', baud: 57600 }, simulator: true,
  },
  {
    fqbn: 'arduino:avr:micro', name: 'Arduino Micro', vendor: 'arduino', arch: 'avr',
    mcu: 'ATmega32U4', clock: 16_000_000, flash: 28_672, ram: 2_560, eeprom: 1_024,
    led: 13, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 30), analog: ax(12), pwm: [3, 5, 6, 9, 10, 11, 13], interrupt: [0, 1, 2, 3, 7],
    i2c: { sda: 2, scl: 3 }, spi: { ss: 17, mosi: 16, miso: 14, sck: 15 },
    usbIds: [[0x2341, 0x8035]],
    upload: { kind: 'avrdude', programmer: 'avr109', part: 'atmega32u4', baud: 57600 },
  },
  {
    fqbn: 'arduino:avr:yun', name: 'Arduino Yún', vendor: 'arduino', arch: 'avr',
    mcu: 'ATmega32U4', clock: 16_000_000, flash: 28_672, ram: 2_560, eeprom: 1_024,
    led: 13, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 30), analog: ax(12), pwm: [3, 5, 6, 9, 10, 11, 13], interrupt: [0, 1, 2, 3, 7],
    i2c: { sda: 2, scl: 3 }, spi: { ss: 17, mosi: 16, miso: 14, sck: 15 },
    upload: { kind: 'avrdude', programmer: 'avr109', part: 'atmega32u4', baud: 57600 },
  },
  {
    fqbn: 'attiny:avr:ATtiny85', name: 'ATtiny85 (Digispark, 16.5 МГц)', vendor: 'attiny', arch: 'avr',
    mcu: 'ATtiny85', clock: 16_500_000, flash: 6_586, ram: 512, eeprom: 512,
    led: 1, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 5), analog: [5, 4, 3, 2], pwm: [0, 1, 4], interrupt: [2],
    spi: { mosi: 0, miso: 1, sck: 2 }, hints: ['I2C — только софтверный (USI)'],
    upload: { kind: 'micronucleus' }, simulator: false,
  },

  // ------------------------------------------------------- ESP (Espressif)
  {
    fqbn: 'esp32:esp32:esp32', name: 'ESP32 Dev Module', vendor: 'esp32', arch: 'esp32',
    mcu: 'ESP32 (Xtensa dual-core)', clock: 240_000_000, flash: 1_310_720, ram: 327_680, eeprom: 0,
    led: 2, voltage: 3.3, adcBits: 12, pwmBits: 12,
    digital: [...rng(0, 39)], analog: ['34', '35', '32', '33', '25', '26', '27', '14', '12', '13', '4', '2', '15', '0'],
    pwm: [...rng(0, 39)], interrupt: [...rng(0, 39)],
    inputOnly: [34, 35, 36, 37, 38, 39], flashPins: [6, 7, 8, 9, 10, 11], touch: [0, 2, 4, 12, 13, 14, 15, 27, 32, 33],
    dac: [25, 26], strapping: [0, 2, 5, 12, 15],
    i2c: { sda: 21, scl: 22 }, spi: { ss: 5, mosi: 23, miso: 19, sck: 18 }, uart: { rx: 3, tx: 1 },
    hints: [
      'GPIO6-11 заняты флеш-памятью — обращение к ним вешает плату',
      'GPIO34-39 только вход (нет pull-up и выхода)',
      'ADC2 недоступен при включённом Wi-Fi — используйте 32-39 (ADC1)',
      'analogWrite = LEDC, аналоговый выход только на 25/26 (DAC)',
    ],
    usbIds: [[0x10c4, 0xea60], [0x1a86, 0x55d4], [0x303a, 0x1001]],
    upload: { kind: 'esptool', chip: 'esp32', baud: 921600, requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'esp32:esp32:esp32c3', name: 'ESP32-C3 Dev Module (RISC-V)', vendor: 'esp32', arch: 'esp32',
    mcu: 'ESP32-C3', clock: 160_000_000, flash: 4_194_304, ram: 400_000, eeprom: 0,
    led: 8, voltage: 3.3, adcBits: 12, pwmBits: 14,
    digital: rng(0, 21), analog: [0, 1, 2, 3, 4, 5], pwm: rng(0, 21), interrupt: rng(0, 21),
    inputOnly: [], flashPins: [11, 12, 13, 14, 15, 16, 17], touch: [], strapping: [2, 8, 9],
    i2c: { sda: 8, scl: 9 }, spi: { ss: 7, mosi: 6, miso: 5, sck: 4 },
    hints: ['GPIO11-17 — внутренняя флеш-память', 'GPIO18/19 — USB-JTAG/Serial'],
    usbIds: [[0x303a, 0x1001], [0x303a, 0x1000]],
    upload: { kind: 'esptool', chip: 'esp32c3', baud: 921600, requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'esp32:esp32:esp32s3', name: 'ESP32-S3 Dev Module', vendor: 'esp32', arch: 'esp32',
    mcu: 'ESP32-S3 (dual-core)', clock: 240_000_000, flash: 8_388_608, ram: 327_680, eeprom: 0,
    led: 48, voltage: 3.3, adcBits: 12, pwmBits: 14,
    digital: rng(0, 48), analog: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pwm: rng(0, 48), interrupt: rng(0, 48),
    inputOnly: [], flashPins: [26, 27, 28, 29, 30, 31, 32], touch: rng(1, 14), strapping: [0, 3, 45, 46],
    i2c: { sda: 8, scl: 9 }, spi: { ss: 10, mosi: 11, miso: 13, sck: 12 },
    usbIds: [[0x303a, 0x1001]],
    upload: { kind: 'esptool', chip: 'esp32s3', baud: 921600, requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'esp8266:esp8266:nodemcuv2', name: 'NodeMCU 1.0 (ESP-12E)', vendor: 'esp8266', arch: 'esp8266',
    mcu: 'ESP8266 (Xtensa L106)', clock: 80_000_000, flash: 4_194_304, ram: 81_920, eeprom: 4_096,
    led: 2, voltage: 3.3, adcBits: 10, pwmBits: 10,
    digital: [16, 14, 12, 13, 15, 3, 1, 0, 4, 5, 2],
    analog: ['A0'], pwm: [16, 14, 12, 13, 15, 3, 1, 0, 4, 5, 2], interrupt: [16, 14, 12, 13, 15, 3, 1, 0, 4, 5],
    reserved: { 16: 'D0 — нет прерываний и нет PWM', 0: 'D3 — при загрузке должен быть HIGH', 15: 'D8 — при загрузке должен быть LOW', 1: 'TX', 3: 'RX' },
    i2c: { sda: 4, scl: 5 },
    hints: ['всего один аналоговый вход A0 (0-3.3 В)', 'analogWrite работает на любом пине, но частота ~1 кГц'],
    usbIds: [[0x1a86, 0x7523], [0x10c4, 0xea60]],
    upload: { kind: 'esptool', chip: 'esp8266', baud: 921600, requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'esp8266:esp8266:d1_mini', name: 'Wemos D1 mini (ESP8266)', vendor: 'esp8266', arch: 'esp8266',
    mcu: 'ESP8266 (Xtensa L106)', clock: 80_000_000, flash: 4_194_304, ram: 81_920, eeprom: 4_096,
    led: 2, voltage: 3.3, adcBits: 10, pwmBits: 10,
    digital: [16, 14, 12, 13, 15, 3, 1, 0, 4, 5, 2], analog: ['A0'],
    pwm: [16, 14, 12, 13, 15, 3, 1, 0, 4, 5, 2], interrupt: [16, 14, 12, 13, 15, 3, 1, 0, 4, 5],
    i2c: { sda: 4, scl: 5 },
    usbIds: [[0x1a86, 0x7523]],
    upload: { kind: 'esptool', chip: 'esp8266', baud: 921600, requiresCli: true }, simulator: true,
  },

  // ---------------------------------------------------- RP2040 / RP2350
  {
    fqbn: 'rp2040:rp2040:rpipico', name: 'Raspberry Pi Pico', vendor: 'rp2040', arch: 'rp2040',
    mcu: 'RP2040 (dual Cortex-M0+)', clock: 133_000_000, flash: 2_031_616, ram: 264_192, eeprom: 0,
    led: 25, voltage: 3.3, adcBits: 12, pwmBits: 16,
    digital: rng(0, 29), analog: [26, 27, 28], pwm: rng(0, 29), interrupt: rng(0, 29),
    i2c: { sda: 4, scl: 5 }, spi: { ss: 17, mosi: 19, miso: 16, sck: 18 }, uart: { rx: 1, tx: 0 },
    hints: ['3 аналоговых входа (26-28), один внутренний датчик температуры', 'каждый пин — PWM (8 срезов по 2 канала)'],
    usbIds: [[0x2e8a, 0x0003], [0x2e8a, 0x000a]],
    upload: { kind: 'picotool', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'rp2040:rp2040:rpipicow', name: 'Raspberry Pi Pico W', vendor: 'rp2040', arch: 'rp2040',
    mcu: 'RP2040 + CYW43439', clock: 133_000_000, flash: 1_507_328, ram: 264_192, eeprom: 0,
    led: 25, ledNote: 'на Pico W светодиод — WL_GPIO0 (пин 25 занят радио)', voltage: 3.3, adcBits: 12, pwmBits: 16,
    digital: rng(0, 29), analog: [26, 27, 28], pwm: rng(0, 29), interrupt: rng(0, 29),
    i2c: { sda: 4, scl: 5 }, spi: { ss: 17, mosi: 19, miso: 16, sck: 18 },
    hints: ['LED_BUILTIN у Pico W не работает как обычный пин — нужен cyw43_arch_gpio_put'],
    usbIds: [[0x2e8a, 0xf00a]],
    upload: { kind: 'picotool', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'rp2040:rp2040:rpipico2', name: 'Raspberry Pi Pico 2 (RP2350)', vendor: 'rp2040', arch: 'rp2040',
    mcu: 'RP2350 (dual Cortex-M33/RISC-V)', clock: 150_000_000, flash: 4_063_232, ram: 520_192, eeprom: 0,
    led: 25, voltage: 3.3, adcBits: 12, pwmBits: 16,
    digital: rng(0, 29), analog: [26, 27, 28], pwm: rng(0, 29), interrupt: rng(0, 29),
    i2c: { sda: 4, scl: 5 }, spi: { ss: 17, mosi: 19, miso: 16, sck: 18 },
    upload: { kind: 'picotool', requiresCli: true }, simulator: true,
  },

  // ------------------------------------------------------------ SAMD / SAM
  {
    fqbn: 'arduino:samd:mkrzero', name: 'Arduino MKR Zero (SAMD21)', vendor: 'arduino', arch: 'samd',
    mcu: 'ATSAMD21G18 (Cortex-M0+)', clock: 48_000_000, flash: 262_144, ram: 32_768, eeprom: 0,
    led: 6, voltage: 3.3, adcBits: 12, pwmBits: 8,
    digital: rng(0, 14), analog: ax(7), pwm: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], interrupt: rng(0, 13),
    i2c: { sda: 11, scl: 12 }, spi: { ss: 10, mosi: 8, miso: 9, sck: 9 }, uart: { rx: 13, tx: 14 },
    usbIds: [[0x2341, 0x804f]],
    upload: { kind: 'bossac', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'arduino:samd:nano_33_iot', name: 'Arduino Nano 33 IoT (SAMD21)', vendor: 'arduino', arch: 'samd',
    mcu: 'ATSAMD21G18 + u-blox NINA-W10', clock: 48_000_000, flash: 262_144, ram: 32_768, eeprom: 0,
    led: 13, voltage: 3.3, adcBits: 12, pwmBits: 8,
    digital: rng(0, 13), analog: ax(8), pwm: rng(2, 12), interrupt: rng(0, 13),
    i2c: { sda: 11, scl: 12 }, spi: { ss: 10, mosi: 8, miso: 9, sck: 9 },
    hints: ['все пины 3.3 В — 5 В логика сожжёт плату'],
    usbIds: [[0x2341, 0x8057]],
    upload: { kind: 'bossac', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'arduino:samd:arduino_zero_edbg', name: 'Arduino Zero', vendor: 'arduino', arch: 'samd',
    mcu: 'ATSAMD21G18', clock: 48_000_000, flash: 262_144, ram: 32_768, eeprom: 0,
    led: 13, voltage: 3.3, adcBits: 12, pwmBits: 8,
    digital: rng(0, 13), analog: ax(6), pwm: rng(2, 13), interrupt: rng(0, 13),
    i2c: { sda: 20, scl: 21 }, spi: { ss: 10, mosi: 8, miso: 9, sck: 9 },
    usbIds: [[0x2341, 0x804d]],
    upload: { kind: 'bossac', requiresCli: true },
  },
  {
    fqbn: 'arduino:sam:arduino_due_x', name: 'Arduino Due (SAM3X8E)', vendor: 'arduino', arch: 'sam',
    mcu: 'AT91SAM3X8E (Cortex-M3)', clock: 84_000_000, flash: 524_288, ram: 96_000, eeprom: 0,
    led: 13, voltage: 3.3, adcBits: 12, pwmBits: 12,
    digital: rng(0, 53), analog: ax(12), pwm: rng(2, 13), interrupt: rng(0, 53), dac: [66, 67],
    i2c: { sda: 20, scl: 21 }, spi: { ss: 10, mosi: 75, miso: 74, sck: 76 },
    hints: ['два настоящих ЦАП (DAC0/DAC1) — analogWrite 0..4095', 'пины 3.3 В, ток одного пина до 3 мА'],
    usbIds: [[0x2341, 0x003e]],
    upload: { kind: 'bossac', requiresCli: true }, simulator: true,
  },

  // ------------------------------------------------------- megaAVR / RA4
  {
    fqbn: 'arduino:megaavr:nona4809', name: 'Arduino Nano Every (ATmega4809)', vendor: 'arduino', arch: 'megaavr',
    mcu: 'ATmega4809', clock: 20_000_000, flash: 49_152, ram: 6_144, eeprom: 256,
    led: 13, voltage: 5, adcBits: 10, pwmBits: 8,
    digital: rng(0, 20), analog: ax(8), pwm: [3, 5, 6, 9, 10],
    i2c: { sda: 18, scl: 19 }, spi: { ss: 10, mosi: 11, miso: 12, sck: 13 }, uart: { rx: 0, tx: 1 },
    usbIds: [[0x2341, 0x0058]],
    upload: { kind: 'avrdude', programmer: 'jtag2updi', part: 'atmega4809', baud: 115200, requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'arduino:renesas_uno:unor4wifi', name: 'Arduino Uno R4 WiFi', vendor: 'arduino', arch: 'renesas_uno',
    mcu: 'Renesas RA4M1 (Cortex-M4)', clock: 48_000_000, flash: 262_144, ram: 32_768, eeprom: 8_192,
    led: 13, ledMatrix: true, voltage: 5, adcBits: 14, pwmBits: 10, dac: [3],
    digital: rng(0, 19), analog: ax(6), pwm: rng(3, 13), interrupt: rng(2, 13),
    i2c: { sda: 18, scl: 19 }, spi: { ss: 10, mosi: 11, miso: 12, sck: 13 }, uart: { rx: 0, tx: 1 },
    hints: ['есть настоящий ЦАП на A0', 'A4/A5 — SDA/SCL как у Uno; RTC и LED-матрица 12×8 на борту'],
    usbIds: [[0x2341, 0x1002]],
    upload: { kind: 'dfu', requiresCli: true }, simulator: true,
  },

  // ------------------------------------------------------------- STM32
  {
    fqbn: 'STMicroelectronics:stm32:GenF1', name: 'STM32F103C8 «Blue Pill»', vendor: 'STMicroelectronics', arch: 'stm32',
    mcu: 'STM32F103C8T6 (Cortex-M3)', clock: 72_000_000, flash: 65_536, ram: 20_480, eeprom: 0,
    led: 13, voltage: 3.3, adcBits: 12, pwmBits: 12,
    digital: rng(0, 39), analog: ax(7), pwm: [0, 1, 2, 3, 6, 7, 8, 9, 10, 11],
    i2c: { sda: 7, scl: 6 }, spi: { ss: 4, mosi: 7, miso: 6, sck: 5 }, uart: { rx: 3, tx: 2 },
    hints: ['PC13 (13) — светодиод, ток ограничен парой мА', '5 В пины помечены на плате, остальные 3.3 В'],
    usbIds: [[0x1eaf, 0x0004]],
    upload: { kind: 'stm32flash', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'STMicroelectronics:stm32:GenF4', name: 'STM32F411 «Black Pill»', vendor: 'STMicroelectronics', arch: 'stm32',
    mcu: 'STM32F411CEU6 (Cortex-M4, 100 МГц)', clock: 100_000_000, flash: 524_288, ram: 131_072, eeprom: 0,
    led: 13, voltage: 3.3, adcBits: 12, pwmBits: 16,
    digital: rng(0, 39), analog: ax(8), pwm: rng(0, 30),
    i2c: { sda: 7, scl: 6 }, spi: { ss: 4, mosi: 7, miso: 6, sck: 5 }, uart: { rx: 3, tx: 2 },
    usbIds: [[0x0483, 0xdf11]],
    upload: { kind: 'dfu', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'esp32:esp32:esp32c6', name: 'ESP32-C6 Dev Module (Wi-Fi 6 / Thread)', vendor: 'esp32', arch: 'esp32',
    mcu: 'ESP32-C6 (RISC-V)', clock: 160_000_000, flash: 4_194_304, ram: 327_680, eeprom: 0,
    led: 8, voltage: 3.3, adcBits: 12, pwmBits: 14,
    digital: rng(0, 22), analog: rng(0, 6), pwm: rng(0, 22), interrupt: rng(0, 22),
    i2c: { sda: 6, scl: 7 }, spi: { ss: 4, mosi: 9, miso: 8, sck: 10 },
    usbIds: [[0x303a, 0x1001]],
    upload: { kind: 'esptool', chip: 'esp32c6', baud: 921600, requiresCli: true }, simulator: true,
  },

  // ------------------------------------------------------------- Teensy
  {
    fqbn: 'teensy:avr:teensy40', name: 'Teensy 4.0 (i.MX RT1062)', vendor: 'teensy', arch: 'avr',
    mcu: 'NXP i.MX RT1062 (Cortex-M7, 600 МГц)', clock: 600_000_000, flash: 2_031_616, ram: 1_048_576, eeprom: 4_288,
    led: 13, voltage: 3.3, adcBits: 12, pwmBits: 16,
    digital: rng(0, 23), analog: ax(10), pwm: rng(0, 23), interrupt: rng(0, 23),
    i2c: { sda: 18, scl: 19 }, spi: { ss: 10, mosi: 11, miso: 12, sck: 13 },
    hints: ['пины tolerant к 5 В (кроме 24-33)', '3 аппаратных Serial, 7 гибких Serial'],
    usbIds: [[0x16c0, 0x0483]],
    upload: { kind: 'teensy', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'teensy:avr:teensy32', name: 'Teensy 3.2 (MK20DX256)', vendor: 'teensy', arch: 'avr',
    mcu: 'MK20DX256 (Cortex-M4, 72 МГц)', clock: 72_000_000, flash: 262_144, ram: 65_536, eeprom: 2_048,
    led: 13, voltage: 3.3, adcBits: 16, pwmBits: 16,
    digital: rng(0, 33), analog: ax(14), pwm: rng(0, 33), interrupt: rng(0, 33),
    i2c: { sda: 18, scl: 19 }, spi: { ss: 10, mosi: 11, miso: 12, sck: 13 },
    usbIds: [[0x16c0, 0x0483]],
    upload: { kind: 'teensy', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'mbed:Seeed:nano33ble', name: 'Arduino Nano 33 BLE (nRF52840)', vendor: 'Seeed', arch: 'nrf52',
    mcu: 'Nordic nRF52840 (Cortex-M4F + BLE 5)', clock: 64_000_000, flash: 983_040, ram: 262_144, eeprom: 0,
    led: 13, voltage: 3.3, adcBits: 12, pwmBits: 16,
    digital: rng(0, 13), analog: ax(8), pwm: rng(0, 13), interrupt: rng(0, 13),
    i2c: { sda: 18, scl: 19 }, spi: { ss: 10, mosi: 11, miso: 12, sck: 13 },
    usbIds: [[0x2341, 0x805a]],
    upload: { kind: 'dfu', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'Seeeduino:samd:seeed_XIAO_m0', name: 'Seeed XIAO SAMD21', vendor: 'Seeeduino', arch: 'samd',
    mcu: 'ATSAMD21G18', clock: 48_000_000, flash: 262_144, ram: 32_768, eeprom: 0,
    led: 13, voltage: 3.3, adcBits: 12, pwmBits: 8,
    digital: rng(0, 10), analog: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pwm: rng(1, 10), interrupt: rng(1, 10),
    i2c: { sda: 4, scl: 5 }, spi: { ss: 3, mosi: 10, miso: 9, sck: 8 },
    usbIds: [[0x2886, 0x002f]],
    upload: { kind: 'bossac', requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'esp32:esp32:XIAO_ESP32C3', name: 'Seeed XIAO ESP32-C3', vendor: 'esp32', arch: 'esp32',
    mcu: 'ESP32-C3', clock: 160_000_000, flash: 4_194_304, ram: 400_000, eeprom: 0,
    led: 10, voltage: 3.3, adcBits: 12, pwmBits: 14,
    digital: rng(0, 21), analog: rng(0, 4), pwm: rng(0, 10), interrupt: rng(0, 21),
    i2c: { sda: 6, scl: 7 }, spi: { ss: 3, mosi: 10, miso: 9, sck: 8 },
    usbIds: [[0x303a, 0x1001]],
    upload: { kind: 'esptool', chip: 'esp32c3', baud: 921600, requiresCli: true }, simulator: true,
  },
  {
    fqbn: 'arduino:avr:gemma', name: 'Adafruit Gemma (ATtiny85)', vendor: 'arduino', arch: 'avr',
    mcu: 'ATtiny85', clock: 8_000_000, flash: 6_586, ram: 512, eeprom: 512,
    led: 1, voltage: 3.3, adcBits: 10, pwmBits: 8,
    digital: rng(0, 5), analog: [5, 4, 3, 2], pwm: [0, 1, 4],
    upload: { kind: 'micronucleus' },
  },
];

// Платформы (ядра) с зеркалами: наш ответ недоступным серверам Arduino.
// url — откуда MicroPIDE тянет ядро, если downloads.arduino.cc не отвечает.
export const PLATFORMS = [
  {
    id: 'arduino:avr', name: 'Arduino AVR Boards', version: '1.8.6', arch: 'avr', vendor: 'arduino',
    url: 'https://github.com/arduino/ArduinoCore-avr/archive/refs/tags/1.8.6.tar.gz',
    mirror: 'https://codeload.github.com/arduino/ArduinoCore-avr/tar.gz/refs/tags/1.8.6',
    tools: [{ name: 'avr-gcc', version: '7.3.0-atmel3.6.1-arduino7', repo: 'arduino/toolchain-avr', assets: { linux: 'avr-gcc-7.3.0-atmel3.6.1-arduino7-x64-linux.tar.bz2', macos: 'avr-gcc-7.3.0-atmel3.6.1-arduino7-x86_64-apple-darwin14.tar.bz2', windows: 'avr-gcc-7.3.0-atmel3.6.1-arduino7-i686-mingw32.zip' }, bin: 'avr-g++' },
      { name: 'avrdude', version: '6.3.0-arduino17', repo: 'arduino/avrdude-build-script', assets: { linux: 'avrdude-6.3.0-arduino17-any-linux-x86_64.tar.bz2' }, bin: 'avrdude' }],
    size: 5_000_000,
  },
  {
    id: 'esp32:esp32', name: 'ESP32 by Espressif', version: '3.0.7', arch: 'esp32', vendor: 'esp32',
    url: 'https://github.com/espressif/arduino-esp32/archive/refs/tags/3.0.7.tar.gz',
    mirror: 'https://codeload.github.com/espressif/arduino-esp32/tar.gz/refs/tags/3.0.7',
    tools: [{ name: 'xtensa-esp32-elf-gcc', version: 'esp-2021r2-patch5-8.4.0', repo: 'espressif/crosstool-NG', assets: { linux: 'xtensa-esp32-elf-gcc8_4_0-esp-2021r2-patch5-linux-amd64.tar.gz' }, bin: 'xtensa-esp32-elf-g++' },
      { name: 'esptool', version: '4.6', repo: 'espressif/esptool', assets: {}, bin: 'esptool.py' }],
    size: 300_000_000,
  },
  {
    id: 'esp8266:esp8266', name: 'ESP8266 Boards', version: '3.1.2', arch: 'esp8266', vendor: 'esp8266',
    url: 'https://github.com/esp8266/Arduino/archive/refs/tags/3.1.2.tar.gz',
    mirror: 'https://codeload.github.com/esp8266/Arduino/tar.gz/refs/tags/3.1.2',
    tools: [{ name: 'xtensa-lx106-elf-gcc', version: '3.1.0-gcc10.3-e5f9fec', repo: 'esp8266/arduino-toolchain', assets: { linux: 'x86_64-linux-gnu.xtensa-lx106-elf-e5f9fec.tar.gz' }, bin: 'xtensa-lx106-elf-g++' }],
    size: 250_000_000,
  },
  {
    id: 'rp2040:rp2040', name: 'Raspberry Pi Pico/RP2040', version: '3.9.5', arch: 'rp2040', vendor: 'rp2040',
    url: 'https://github.com/earlephilhower/arduino-pico/archive/refs/tags/3.9.5.tar.gz',
    mirror: 'https://codeload.github.com/earlephilhower/arduino-pico/tar.gz/refs/tags/3.9.5',
    tools: [{ name: 'pqt-gcc', version: '3.9.5', repo: 'earlephilhower/pico-quick-toolchain', assets: {}, bin: 'arm-none-eabi-g++' }],
    size: 150_000_000,
  },
  {
    id: 'arduino:samd', name: 'Arduino SAMD Boards (32-bit ARM)', version: '1.8.14', arch: 'samd', vendor: 'arduino',
    url: 'https://github.com/arduino/ArduinoCore-samd/archive/refs/tags/1.8.14.tar.gz',
    mirror: 'https://codeload.github.com/arduino/ArduinoCore-samd/tar.gz/refs/tags/1.8.14',
    tools: [{ name: 'arm-none-eabi-gcc', version: '7-2017q4', repo: 'arduino/arm-none-eabi-gcc', assets: { linux: 'gcc-arm-none-eabi-7-2017q4-linux_x86_64.tar.bz2' }, bin: 'arm-none-eabi-g++' },
      { name: 'bossac', version: '1.7.0-arduino3', repo: 'arduino/BOSSA', assets: { linux: 'bossac-1.7.0-arduino3-linux64.tar.bz2' }, bin: 'bossac' }],
    size: 20_000_000,
  },
  {
    id: 'arduino:renesas_uno', name: 'Arduino UNO R4 Boards', version: '1.2.0', arch: 'renesas_uno', vendor: 'arduino',
    url: 'https://github.com/arduino/ArduinoCore-renesas/archive/refs/tags/1.2.0.tar.gz',
    mirror: 'https://codeload.github.com/arduino/ArduinoCore-renesas/tar.gz/refs/tags/1.2.0',
    tools: [{ name: 'arm-none-eabi-gcc', version: '7-2017q4', repo: 'arduino/arm-none-eabi-gcc', assets: {}, bin: 'arm-none-eabi-g++' }],
    size: 25_000_000,
  },
];

// Библиотеки для нашего локального индекса: то, что чаще всего нужно и что
// реально ставится из GitHub без реестра Arduino.
export const LIBRARY_CATALOG = [
  { name: 'Servo', version: '1.2.2', author: 'Arduino', sentence: 'Управление сервоприводами на любом пине', repo: 'arduino-libraries/Servo', archs: ['avr', 'sam', 'samd', 'esp32', 'esp8266', 'rp2040'], tag: '1.2.2', contains: ['Servo.h', 'Servo.cpp'] },
  { name: 'LiquidCrystal I2C', version: '1.1.2', author: 'Frank de Brabander', sentence: 'Символьный LCD 1602/2004 через I2C-расширитель', repo: 'johnrickman/LiquidCrystal_I2C', archs: ['*'], tag: '1.1.2', contains: ['LiquidCrystal_I2C.h'] },
  { name: 'Adafruit GFX Library', version: '1.11.9', author: 'Adafruit', sentence: 'Графика: линии, текст, фигуры для дисплеев', repo: 'adafruit/Adafruit-GFX-Library', archs: ['*'], tag: '1.11.9', contains: ['Adafruit_GFX.h'] },
  { name: 'Adafruit SSD1306', version: '2.5.9', author: 'Adafruit', sentence: 'OLED-дисплеи на SSD1306/SSD1315 (I2C и SPI)', repo: 'adafruit/Adafruit_SSD1306', archs: ['*'], tag: '2.5.9', contains: ['Adafruit_SSD1306.h'] },
  { name: 'DHT sensor library', version: '1.4.6', author: 'Adafruit', sentence: 'Датчики влажности/температуры DHT11, DHT22, AM2302', repo: 'adafruit/DHT-sensor-library', archs: ['*'], tag: '1.4.6', contains: ['DHT.h'] },
  { name: 'Adafruit Unified Sensor', version: '1.1.14', author: 'Adafruit', sentence: 'Общий интерфейс датчиков для библиотек Adafruit', repo: 'adafruit/Adafruit_Sensor', archs: ['*'], tag: '1.1.14', contains: ['Adafruit_Sensor.h'] },
  { name: 'FastLED', version: '3.7.6', author: 'Daniel Garcia', sentence: 'Адресные светодиоды WS2812/WS2811/APA102', repo: 'FastLED/FastLED', archs: ['avr', 'esp32', 'esp8266', 'rp2040', 'arm'], tag: '3.7.6', contains: ['FastLED.h'] },
  { name: 'Adafruit NeoPixel', version: '1.12.3', author: 'Adafruit', sentence: 'Простая работа с WS2812/NeoPixel', repo: 'adafruit/Adafruit_NeoPixel', archs: ['*'], tag: '1.12.3', contains: ['Adafruit_NeoPixel.h'] },
  { name: 'OneWire', version: '2.3.8', author: 'Paul Stoffregen', sentence: 'Шина 1-Wire: DS18B20, DS18S20 и другие', repo: 'PaulStoffregen/OneWire', archs: ['*'], tag: 'v2.3.8', contains: ['OneWire.h'] },
  { name: 'DallasTemperature', version: '3.9.1', author: 'Miles Burton', sentence: 'Датчики Dallas DS18B20 поверх OneWire', repo: 'milesburton/Arduino-Temperature-Control-Library', archs: ['*'], tag: '3.9.1', contains: ['DallasTemperature.h'] },
  { name: 'RTClib', version: '2.1.4', author: 'Adafruit', sentence: 'Часы реального времени DS1307/DS3231/PCF8523', repo: 'adafruit/RTClib', archs: ['*'], tag: '2.1.4', contains: ['RTClib.h'] },
  { name: 'ArduinoJson', version: '7.2.1', author: 'Benoit Blanchon', sentence: 'Быстрый разбор и генерация JSON', repo: 'bblanchon/ArduinoJson', archs: ['*'], tag: 'v7.2.1', contains: ['ArduinoJson.h'] },
  { name: 'PubSubClient', version: '2.8.0', author: 'Nick O\'Leary', sentence: 'Клиент MQTT для Ethernet и Wi-Fi', repo: 'knolleary/pubsubclient', archs: ['*'], tag: 'v2.8.0', contains: ['PubSubClient.h'] },
  { name: 'IRremote', version: '4.4.1', author: 'Armin Joachimsmeyer', sentence: 'Приём и передача ИК-команд', repo: 'Arduino-IRremote/Arduino-IRremote', archs: ['*'], tag: 'v4.4.1', contains: ['IRremote.hpp'] },
  { name: 'AccelStepper', version: '1.64.0', author: 'Mike McCauley', sentence: 'Управление шаговыми двигателями с ускорением', repo: 'waspinator/AccelStepper', archs: ['*'], tag: '1.64', contains: ['AccelStepper.h'] },
  { name: 'U8g2', version: '2.35.30', author: 'olikraus', sentence: 'Монохромные дисплеи: SSD1306, SH1106, LCD и другие', repo: 'olikraus/U8g2_Arduino', archs: ['*'], tag: '2.35.30', contains: ['U8g2lib.h'] },
  { name: 'TinyGPSPlus', version: '1.1.0', author: 'Mikal Hart', sentence: 'Разбор NMEA от GPS-модулей', repo: 'mikalhart/TinyGPSPlus', archs: ['*'], tag: 'v1.1.0', contains: ['TinyGPSPlus.h'] },
  { name: 'painlessMesh', version: '1.5.3', author: 'Coopdis', sentence: 'Самоорганизующаяся mesh-сеть на ESP', repo: 'Alteras1/painlessMesh', archs: ['esp8266', 'esp32'], tag: 'v1.5.3', contains: ['painlessMesh.h'] },
  { name: 'ESPAsyncWebServer', version: '3.6.0', author: 'ESP32Async', sentence: 'Асинхронный веб-сервер для ESP32/ESP8266', repo: 'ESP32Async/ESPAsyncWebServer', archs: ['esp32', 'esp8266'], tag: 'v3.6.0', contains: ['ESPAsyncWebServer.h'] },
  { name: 'SoftWire', version: '1.0.0', author: 'Steven Blundy', sentence: 'Программный I2C (I2C на любых пинах)', repo: 'stevemarple/SoftWire', archs: ['*'], contains: ['SoftWire.h'] },
  { name: 'Joystick', version: '1.0.0', author: 'MicroPIDE', sentence: 'HID-джойстик/клавиатура: эмуляция USB-устройств (свой минимальный слой)', repo: '', archs: ['avr', 'samd', 'rp2040', 'esp32'], vendor: 'micropide', contains: ['Joystick.h'] },
];

// ---------------------------------------------------------------------------
// Работа с базой
// ---------------------------------------------------------------------------

/** Свои платы пользователя: <data>/offline/boards.json. */
export function userBoards() {
  const p = join(DATA_DIR, 'offline', 'boards.json');
  try {
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(j) ? j : (Array.isArray(j.boards) ? j.boards : []);
  } catch { return []; }
}

/** Сохранить свою плату (или несколько) в файл пользователя. */
export function saveUserBoards(boards) {
  const dir = join(DATA_DIR, 'offline');
  mkdirSync(dir, { recursive: true });
  const cur = userBoards();
  const map = new Map(cur.map((b) => [b.fqbn, b]));
  for (const b of boards) if (b && b.fqbn) map.set(b.fqbn, b);
  writeFileSync(join(dir, 'boards.json'), JSON.stringify([...map.values()], null, 2));
  return [...map.values()];
}

/** Вся база: встроенная + свои платы (свои перекрывают встроенные по fqbn/имени). */
export function allBoards() {
  const mine = userBoards();
  const out = [...BOARDS];
  for (const b of mine) {
    const i = out.findIndex((x) => x.fqbn === b.fqbn || x.name.toLowerCase() === String(b.name || '').toLowerCase());
    if (i >= 0) out[i] = { ...out[i], ...b, source: 'user' };
    else out.push({ ...b, source: 'user' });
  }
  return out;
}

/** Плата по FQBN: точное совпадение, потом по «хвосту» (avr:uno). */
export function findBoard(fqbn) {
  const q = String(fqbn || '').trim();
  if (!q) return null;
  const all = allBoards();
  return all.find((b) => b.fqbn === q)
    || all.find((b) => q.endsWith(b.fqbn.split(':').slice(-2).join(':')))
    || all.find((b) => b.arch && q.split(':')[1] === b.arch && b.name.toLowerCase().includes(q.split(':')[2] || '\u0000'))
    || null;
}

/** Поиск по названию/МК/пину/FQBN. */
export function searchBoards(q) {
  const s = String(q || '').trim().toLowerCase();
  const all = allBoards();
  if (!s) return all;
  return all.filter((b) =>
    b.fqbn.toLowerCase().includes(s)
    || b.name.toLowerCase().includes(s)
    || String(b.mcu || '').toLowerCase().includes(s)
    || (b.hints || []).some((h) => h.toLowerCase().includes(s)));
}

/** Определение платы по USB VID:PID (и подсказке по имени из порта). */
export function guessBoard({ vid, pid, name } = {}) {
  const v = typeof vid === 'string' ? parseInt(vid, 16) : vid;
  const p = typeof pid === 'string' ? parseInt(pid, 16) : pid;
  if (Number.isFinite(v) && Number.isFinite(p)) {
    for (const b of allBoards()) {
      if ((b.usbIds || []).some(([bv, bp]) => bv === v && bp === p)) return { board: b, how: `USB ${v.toString(16)}:${p.toString(16)}`, confident: true };
    }
  }
  const nm = String(name || '');
  if (nm) {
    const found = searchBoards(nm.replace(/\(.*?\)/g, ''));
    if (found.length) return { board: found[0], how: 'имя устройства: ' + nm, confident: false };
  }
  return null;
}

/** Возможности платы — то, что нужно анализатору и UI. */
export function boardCaps(fqbn) {
  const b = findBoard(fqbn);
  if (!b) return null;
  const pwm = b.pwm || [];
  const analog = (b.analog || []).map(String);
  const digital = (b.digital || []).map(Number);
  return {
    fqbn: b.fqbn, name: b.name, mcu: b.mcu, clock: b.clock,
    flash: b.flash, ram: b.ram, eeprom: b.eeprom,
    led: b.led, ledNote: b.ledNote, voltage: b.voltage, adcBits: b.adcBits, pwmBits: b.pwmBits,
    digital, analog, pwm: new Set(pwm.map(Number)),
    interrupt: new Set((b.interrupt || []).map(Number)),
    inputOnly: new Set((b.inputOnly || []).map(Number)),
    flashPins: new Set((b.flashPins || []).map(Number)),
    strapping: new Set((b.strapping || []).map(Number)),
    dac: new Set((b.dac || []).map(Number)),
    reserved: b.reserved || {}, hints: b.hints || [], simulator: b.simulator !== false,
    upload: b.upload || null,
  };
}

/** Нормализация имени пина: 'A0' → 14 (для AVR), '13' → 13. */
export function normalizePin(fqbn, pin) {
  const b = findBoard(fqbn);
  const s = String(pin).trim();
  if (/^A\d+$/i.test(s) && b) {
    const idx = Number(s.slice(1));
    const a = b.analog || [];
    if (a[idx] !== undefined) return Number(a[idx]);
  }
  return Number(s);
}

/** Каталог для UI: компактные карточки. */
export function catalogForUi() {
  return allBoards().map((b) => ({
    fqbn: b.fqbn, name: b.name, source: b.source || 'builtin',
    vendor: b.vendor || b.fqbn.split(':')[0], arch: b.arch || b.fqbn.split(':')[1],
    mcu: b.mcu, clock: b.clock, flash: b.flash, ram: b.ram, eeprom: b.eeprom,
    voltage: b.voltage, led: b.led, adcBits: b.adcBits, pwmBits: b.pwmBits,
    pwm: (b.pwm || []).length, analog: (b.analog || []).length, digital: (b.digital || []).length,
    dac: (b.dac || []).length, simulator: b.simulator !== false, uploadKind: b.upload?.kind || '',
    hints: b.hints || [], notes: b.notes || '',
  }));
}

// ---------------------------------------------------------------------------
// Свои индексы: package_index.json и library_index.json из наших данных.
// Всё, что нужно ардуино-инструментам, лежит у нас, а не на чужом сервере.
// ---------------------------------------------------------------------------

/** Наш package_index.json: платформы + инструменты из зеркала GitHub. */
export function packageIndex(overrides = {}) {
  const platforms = PLATFORMS.map((p) => {
    const ov = overrides[p.id] || {};
    return {
      name: p.name,
      architecture: p.arch,
      version: p.version,
      category: 'Arduino',
      url: ov.url || p.url,
      archiveFileName: (ov.url || p.url || '').split('/').pop(),
      checksum: ov.checksum || '',
      size: ov.size || String(p.size || ''),
      boards: allBoards().filter((b) => b.fqbn.startsWith(p.id + ':')).map((b) => ({ name: b.name })),
      toolsDependencies: (p.tools || []).map((t) => ({
        packager: p.vendor, name: t.name, version: t.version,
        systems: Object.entries(t.assets || {}).map(([os, file]) => ({
          host: os === 'linux' ? 'x86_64-pc-linux-gnu' : os === 'macos' ? 'x86_64-apple-darwin' : os === 'windows' ? 'i686-mingw32' : os,
          url: t.repo ? `https://github.com/${t.repo}/releases/download/${t.version}/${file}` : '',
          archiveFileName: file, checksum: '', size: '',
        })),
      })),
    };
  });
  const tools = PLATFORMS.flatMap((p) => (p.tools || []).map((t) => ({
    name: t.name, version: t.version, packager: p.vendor,
    systems: Object.entries(t.assets || {}).map(([os, file]) => ({
      host: os === 'linux' ? 'x86_64-pc-linux-gnu' : os === 'macos' ? 'x86_64-apple-darwin' : os === 'windows' ? 'i686-mingw32' : os,
      url: t.repo ? `https://github.com/${t.repo}/releases/download/${t.version}/${file}` : '',
      archiveFileName: file, checksum: '', size: '',
    })),
  })));
  return { packages: [{ name: 'MicroPIDE local', maintainer: 'MicroPIDE', websiteURL: 'https://github.com/danilka-revin/micro-pide', email: '', platforms, tools }] };
}

/**
 * Наш library_index.json: библиотеки из LIBRARY_CATALOG плюс всё, что лежит
 * в складе (vault). Установка идёт прямо из GitHub-архива тега — реестр
 * Arduino не нужен.
 */
export function libraryIndex(extra = []) {
  const libs = [...LIBRARY_CATALOG, ...extra];
  return {
    libraries: libs.map((l) => ({
      name: l.name,
      version: l.version || '0.0.0',
      author: l.author || 'MicroPIDE',
      maintainer: l.author || 'MicroPIDE',
      sentence: l.sentence || '',
      paragraph: l.sentence || '',
      website: l.repo ? `https://github.com/${l.repo}` : 'https://github.com/danilka-revin/micro-pide',
      category: l.category || 'Other',
      architectures: l.archs || ['*'],
      types: ['Contributed'],
      repository: l.repo ? `https://github.com/${l.repo}` : '',
      url: l.repo && l.tag ? `https://github.com/${l.repo}/archive/refs/tags/${l.tag}.zip` : (l.repo ? `https://github.com/${l.repo}/archive/refs/heads/master.zip` : ''),
      archiveFileName: l.repo ? `${l.name.replace(/\s+/g, '_')}-${l.version}.zip` : '',
      checksum: l.checksum || '',
      size: l.size || '',
      providesIncludes: l.contains || [],
    })),
  };
}
