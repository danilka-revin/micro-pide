// Энергопрофиль скетча — статическая оценка потребления и времени работы от
// батареи. Ни Arduino IDE, ни PlatformIO такого не умеют: там придётся смотреть
// в даташиты и считать руками. MicroPIDE считает сам: ток микроконтроллера в
// активном режиме/сне, вклад периферии по коду (датчики, экраны, реле, радио,
// сервоприводы), скважность ШИМ, потери преобразователя — и сколько часов
// протянет батарея.
import { boardCaps, findBoard } from './boarddb.mjs';
import { extractCalls, maskCode } from './cpp.mjs';
import { sketchProfile } from './analysis.mjs';

/** Токи микроконтроллеров, мА: активный, сон с пробуждением по таймеру, глубина. */
const MCU_POWER = {
  avr: { active: 15, idle: 6, deep: 0.01, name: 'AVR (16 МГц)' },
  esp32: { active: 90, idle: 30, deep: 0.02, name: 'ESP32' },
  esp8266: { active: 80, idle: 25, deep: 0.03, name: 'ESP8266' },
  samd: { active: 9, idle: 4, deep: 0.01, name: 'SAMD (ARM M0+)' },
  sam: { active: 30, idle: 12, deep: 0.05, name: 'SAM (ARM M3)' },
  rp2040: { active: 26, idle: 12, deep: 0.2, name: 'RP2040' },
  stm32: { active: 22, idle: 8, deep: 0.01, name: 'STM32' },
  mbed: { active: 25, idle: 10, deep: 0.05, name: 'mbed/ARM' },
  mbed_nano: { active: 9, idle: 4, deep: 0.01, name: 'Nano 33 (mbed)' },
};
const DEFAULT_MCU = { active: 20, idle: 8, deep: 0.05, name: 'микроконтроллер' };

/** Радио и модули, мА (средний ток в рабочем режиме). */
const RADIO = {
  wifi: { ma: 120, what: 'Wi-Fi (передача)', note: 'с modem-sleep средний ток падает до ~20 мА' },
  ble: { ma: 25, what: 'Bluetooth LE', note: 'реклама дешевле соединения' },
  espnow: { ma: 90, what: 'ESP-NOW', note: '' },
  lora: { ma: 45, what: 'LoRa', note: 'на передаче до 120 мА, приём ~12 мА' },
  nrf24: { ma: 14, what: 'nRF24L01', note: '' },
  gsm: { ma: 250, what: 'GSM/LTE-модем', note: 'пики до 2 А — нужен конденсатор' },
};

/** Периферия по имени библиотеки/класса: [мА, что, режим]. */
const PERIPH = [
  { re: /\b(DHT|dht)\b/, ma: 1.5, what: 'датчик DHT', group: 'sensors' },
  { re: /\b(DallasTemperature|OneWire|DS18B20)\b/, ma: 1.5, what: 'термометр 1-Wire', group: 'sensors' },
  { re: /\b(Adafruit_BME280|BME280|BMP280)\b/, ma: 0.7, what: 'BME280/BMP280', group: 'sensors' },
  { re: /\bpulseIn\s*\(/, ma: 15, what: 'ультразвуковой дальномер (HC-SR04)', group: 'sensors' },
  { re: /\b(MQ\d|MQ135|SGP30|CCS811)\b/, ma: 150, what: 'газовый датчик (MQ-серия)', group: 'sensors' },
  { re: /\b(gps|GPS|TinyGPS|NEO-?6M)\b/, ma: 45, what: 'GPS-модуль', group: 'sensors' },
  { re: /\b(Adafruit_SSD1306|U8g2|SSD1306|SH1106)\b/, ma: 15, what: 'OLED-экран', group: 'displays' },
  { re: /\b(LiquidCrystal|LiquidCrystal_I2C|HD44780)\b/, ma: 25, what: 'символьный LCD (с подсветкой)', group: 'displays' },
  { re: /\b(TFT|ILI9341|ST7735|Adafruit_ST77)\w*/, ma: 45, what: 'TFT-экран', group: 'displays' },
  { re: /\b(SD|SdFat)\s*\.|#\s*include\s*<\s*SD\.h/, ma: 30, what: 'SD-карта', group: 'storage' },
  { re: /\b(Stepper|AccelStepper)\b/, ma: 200, what: 'шаговый двигатель', group: 'actuators' },
  { re: /\b(AFMotor|Motor|L298|L293)\w*\./, ma: 300, what: 'двигатель через драйвер', group: 'actuators' },
  { re: /\btone\s*\(/, ma: 30, what: 'пьезоизлучатель/динамик', group: 'actuators' },
  { re: /\b(Adafruit_NeoPixel|FastLED|WS2812)\b/, ma: 20, what: 'адресные светодиоды (на 20 шт.)', group: 'leds' },
  { re: /\bRFID|MFRC522\b/, ma: 26, what: 'RFID-считыватель', group: 'sensors' },
  { re: /\b(Servo)\b/, ma: 100, what: 'сервопривод (удержание)', group: 'actuators', note: 'в покое под нагрузкой под 100–250 мА, лучше detach()' },
];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Разобрать скетч и посчитать токи.
 * @param {{files?:any[], fqbn?:string, batteryMmah?:number, efficiency?:number, hoursOfSun?:number}} opts
 */
export function powerProfile({ files = [], fqbn = '', batteryMmah = 2000, efficiency = 0.85 } = {}) {
  const caps = boardCaps(fqbn);
  const board = findBoard(fqbn);
  if (!caps) return { ok: false, error: 'Неизвестная плата: ' + (fqbn || '(пусто)') };
  if (!files.length) return { ok: false, error: 'Нет файлов скетча' };

  const text = files.map((f) => String(f.content ?? '')).join('\n');
  const masked = maskCode(text);
  const arch = board.arch || 'avr';
  const mcu = MCU_POWER[arch] || DEFAULT_MCU;

  const loads = [];
  const push = (what, ma, group, source, note = '') => {
    if (ma > 0) loads.push({ what, ma: round(ma), group, source, note });
  };

  // ---- сон и скважность ----
  const sleepCalls = {
    delay: extractCalls(masked, { names: new Set(['delay']) }),
    delayUs: extractCalls(masked, { names: new Set(['delayMicroseconds']) }),
    deep: extractCalls(masked, { names: new Set(['esp_deep_sleep_start', 'deepSleep', 'powerDown', 'powerDownSd', 'sleep', 'standby']) }),
    wake: extractCalls(masked, { names: new Set(['esp_sleep_enable_timer_wakeup']) }),
    lowPower: /LowPower|esp_deep_sleep|set_sleep_mode|sleep_mode|SLEEP_MODE_PWR_DOWN/.test(masked),
  };
  const delayMs = sleepCalls.delay.reduce((s, c) => s + (num(c.args[0]) || 0), 0);
  const deepUs = sleepCalls.wake.reduce((s, c) => s + (num(c.args[0]) || 0), 0);
  const deepMs = deepUs / 1000;
  const hasDeepSleep = sleepCalls.deep.length > 0 || sleepCalls.lowPower;

  // Активный участок: работа без delay (очень грубо — 2 мс на итерацию).
  const activeMs = 2;
  const totalMs = activeMs + delayMs + deepMs;
  const dutyActive = deepMs > 0 ? activeMs / (totalMs + 1e-9) : delayMs > 0 ? activeMs / totalMs : 1;
  const dutyIdle = deepMs > 0 ? 0 : delayMs > 0 ? delayMs / totalMs : 0;
  const dutyDeep = deepMs > 0 ? deepMs / totalMs : 0;

  const mcuActive = mcu.active * dutyActive;
  let mcuIdleMa = 0;
  if (dutyIdle > 0) {
    // на AVR delay() уходит в idle-сон, на ESP32 — остаётся активным
    mcuIdleMa = (arch === 'avr' || arch === 'samd' || arch === 'mbed_nano' ? mcu.idle : mcu.active * 0.8) * dutyIdle;
  }
  const mcuDeep = mcu.deep * dutyDeep;
  push(`${mcu.name}: работа`, mcuActive, 'mcu', 'скетч выполняется',
    `активная доля ${Math.round(dutyActive * 100)}% (${round(activeMs)} мс из ${round(totalMs)} мс)`);
  if (mcuIdleMa > 0) {
    push(`${mcu.name}: ожидание`, mcuIdleMa, 'mcu',
      arch === 'avr' || arch === 'samd' || arch === 'mbed_nano' ? 'delay() → idle-сон' : 'delay() (МК не спит)',
      `доля ${Math.round(dutyIdle * 100)}%`);
  }
  if (mcuDeep > 0) {
    push(`${mcu.name}: глубокий сон`, mcuDeep, 'mcu', 'deep sleep',
      `доля ${Math.round(dutyDeep * 100)}%, просыпается каждые ${round(deepMs)} мс`);
  }

  // ---- радио ----
  const radio = [];
  if (/\bWiFi\s*\.|#\s*include\s*<\s*(WiFi|ESP8266WiFi|WiFiNINA)\b/.test(masked)) radio.push('wifi');
  if (/\bBLE\w*|#\s*include\s*<\s*(BLEDevice|ArduinoBLE|NimBLE)/.test(masked)) radio.push('ble');
  if (/esp_now|ESP_NOW/.test(masked)) radio.push('espnow');
  if (/\bLoRa\w*\b/.test(masked)) radio.push('lora');
  if (/\bRF24\b|nRF24/.test(masked)) radio.push('nrf24');
  if (/SIM800|SIM7600|TinyGsm/.test(masked)) radio.push('gsm');
  const wifiSleep = /WiFi\s*\.\s*setSleep|modem-?sleep|WIFI_PS_MIN_MODEM/.test(masked);
  for (const r of radio) {
    const info = RADIO[r];
    let ma = info.ma;
    if (r === 'wifi' && (wifiSleep || hasDeepSleep)) ma = 22;
    if (dutyDeep > 0.5) ma = ma * 0.15;
    push(info.what, ma, 'radio', hasDeepSleep ? 'включается на время работы' : 'включено постоянно', info.note);
  }

  // ---- периферия ----
  for (const p of PERIPH) {
    if (!p.re.test(masked)) continue;
    let ma = p.ma;
    // ШИМ-нагрузка: усредняем по значению analogWrite
    if (p.group === 'leds') {
      const writes = extractCalls(masked, { names: new Set(['analogWrite', 'setBrightness']) });
      if (writes.length) {
        const duty = writes.map((c) => (num(c.args[1]) ?? 255) / 255).reduce((a, b) => a + b, 0) / writes.length;
        ma = Math.max(0.2, ma * duty);
      }
    }
    if (dutyDeep > 0.5) ma *= 0.2;
    push(p.what, ma, p.group, 'по библиотеке/классу в коде', p.note || '');
  }

  // ---- светодиоды, реле, кнопки ----
  const writes = extractCalls(masked, { names: new Set(['digitalWrite']) });
  const highPins = [];
  for (const c of writes) {
    const val = String(c.args[1] ?? '').trim().toUpperCase();
    const pin = String(c.args[0] ?? '').trim();
    if (val === 'HIGH') highPins.push(pin);
  }
  if (highPins.length) {
    const context = (pin) => {
      const rx = new RegExp(`\\b(\\w{0,24})\\b[^\\n]{0,40}${pin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      const m = rx.exec(masked);
      return m ? m[1].toLowerCase() : '';
    };
    for (const pin of highPins) {
      const ctx = context(pin);
      if (/relay|rele|motor|pump|fan|valve|light|lamp/.test(ctx)) {
        push(`реле/нагрузка на пине ${pin}`, 70, 'actuators', 'digitalWrite(' + pin + ', HIGH)', 'катушка реле ~70 мА; лучше держать включённым только по делу');
      } else if (/led|light|bright|indicator/.test(ctx) || pin === 'LED_BUILTIN') {
        push(`светодиод на пине ${pin}`, 8, 'leds', 'digitalWrite(' + pin + ', HIGH)', 'постоянное свечение — держите его для индикации или приглушите');
      } else {
        push(`выход на пине ${pin} (HIGH)`, 5, 'other', 'digitalWrite(' + pin + ', HIGH)', 'оценка на глаз: неизвестная нагрузка');
      }
    }
  }
  const pwmWrites = extractCalls(masked, { names: new Set(['analogWrite']) });
  if (pwmWrites.length) {
    const avg = pwmWrites.map((c) => (num(c.args[1]) ?? 0) / 255).reduce((a, b) => a + b, 0) / pwmWrites.length;
    push('ШИМ-нагрузка', Math.max(0.5, 12 * avg), 'leds', `analogWrite, средняя скважность ${Math.round(avg * 100)}%`, 'светодиод/мотор через транзистор');
  }

  // ---- стабилизатор и батарея ----
  push('Стабилизатор/преобразователь (покой)', 0.06, 'other', 'LDO/DC-DC', 'плюс потери преобразования учитываются при расчёте ёмкости');
  const avgMa = loads.reduce((s, l) => s + l.ma, 0);
  const effBattery = batteryMmah * efficiency;
  const hours = avgMa > 0 ? effBattery / avgMa : 0;

  // ---- советы ----
  const advice = [];
  if (delayMs > 0 && !hasDeepSleep) {
    advice.push(`В loop() есть delay() на ${round(delayMs)} мс — это ${Math.round((delayMs / (totalMs || 1)) * 100)}% времени. Замените на сон (LowPower.powerDown / esp_deep_sleep) — потребление упадёт с ${round(avgMa)} до ${round(avgMa - mcuIdleMa + mcu.deep)} мА.`);
  }
  if (radio.length && !wifiSleep && !hasDeepSleep) advice.push('Радио включено постоянно: включите WiFi.setSleep(true) или выходите из Wi-Fi между отправками — экономия десятки мА.');
  if (hasDeepSleep) advice.push('Глубокий сон уже используется — это лучший режим для батарейных поделок. Проверьте, что периферия обесточивается (питание датчиков через MOSFET).');
  if (/Servo/.test(masked) && !/\.detach\s*\(/.test(masked)) advice.push('Сервопривод держит позицию и ест ток: вызывайте detach() после движения, если усилие не нужно постоянно.');
  if (/\b(Adafruit_SSD1306|U8g2|SSD1306|LiquidCrystal)\b/.test(masked) && !/display\s*\.\s*(ssd1306_command|displayOff|noDisplay)/.test(masked)) advice.push('Экран включён всегда: гасите его между обновлениями (displayOff/noDisplay) или питайте через MOSFET.');
  if (!radio.length && !hasDeepSleep && avgMa < 20) advice.push('Можно снизить тактовую частоту МК (деление clock / low-power mode) — на таких токах это даёт единицы мА.');
  if (efficiency < 0.9) advice.push(`Потери преобразователя питания учтены как ${Math.round(efficiency * 100)}% — импульсный DC-DC даст больше времени жизни, чем LDO.`);
  advice.push(`Батарея ${batteryMmah} мА·ч: полезная ёмкость ${round(effBattery)} мА·ч. Хватит примерно на ${round(hours, 1)} ч (${round(hours / 24, 1)} сут).`);

  const groups = {};
  for (const l of loads) groups[l.group] = round((groups[l.group] || 0) + l.ma);
  const verdict = hours > 24 * 30 ? 'живёт месяцами' : hours > 24 * 7 ? 'живёт неделями' : hours > 24 ? 'живёт днями' : hours > 8 ? 'живёт меньше суток' : avgMa > 150 ? 'нужен мощный источник' : 'живёт часами';

  let prof = null;
  try { prof = sketchProfile({ files, fqbn }); } catch { /* необязательно */ }

  return {
    ok: true,
    board: { fqbn: caps.fqbn, name: caps.name, mcu: caps.mcu, arch, voltage: caps.voltage },
    mcu: { ...mcu, arch, dutyActive: round(dutyActive, 3), dutyIdle: round(dutyIdle, 3), dutyDeep: round(dutyDeep, 3) },
    sleep: { delayMs: round(delayMs), deepMs: round(deepMs), hasDeepSleep, radio: radio.map((r) => RADIO[r].what) },
    loads: loads.sort((a, b) => b.ma - a.ma),
    groups,
    avgMa: round(avgMa),
    battery: { mAh: batteryMmah, efficiency, usefulMah: round(effBattery), hours: round(hours, 1), days: round(hours / 24, 1), verdict },
    flashEstimate: prof?.flashEstimate ?? null,
    advice,
    note: 'Оценка по коду и типовым токам — для точности измерьте мультиметром. Токи датчиков/экранов берутся из типового потребления.',
  };
}

/** Сравнить два режима питания (например «как есть» и «со сном»). */
export function powerCompare({ files = [], fqbn = '', batteryMmah = 2000, scenarios = [] } = {}) {
  const rows = [{ name: 'как в скетче', ...pick(powerProfile({ files, fqbn, batteryMmah })) }];
  for (const s of scenarios) {
    const p = powerProfile({ files: s.files || files, fqbn, batteryMmah });
    rows.push({ name: s.name || 'вариант', ...pick(p) });
  }
  return { ok: true, rows };
}
const pick = (p) => ({ ok: p.ok, avgMa: p.avgMa, hours: p.battery?.hours, days: p.battery?.days, verdict: p.battery?.verdict, error: p.error });
