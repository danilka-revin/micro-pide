// Справочник MicroPIDE — полностью встроенный, работает без интернета.
//
// У Arduino IDE справка открывается в браузере (и без сети бесполезна). Здесь
// всё лежит внутри: описание функций ядра, констант, типов, методов Serial,
// популярных библиотек, а также — что важно — описание наших собственных
// подсистем: языка сценариев .mps, протокола MicroTelem, клавиш интерфейса.
//
// Поля записи:
//   name, kind: function|constant|type|method|keyword|topic, sig, desc,
//   returns, example, see (массив имён), group.

export const REFERENCE = [
  // ------------------------------------------------------------ вход/выход
  { name: 'pinMode', kind: 'function', sig: 'void pinMode(uint8_t pin, uint8_t mode)', group: 'Цифровой ввод-вывод',
    desc: 'Задаёт режим пина: выход (OUTPUT), вход (INPUT) или вход с внутренней подтяжкой (INPUT_PULLUP). Вызывают в setup().',
    example: 'pinMode(LED_BUILTIN, OUTPUT);\npinMode(2, INPUT_PULLUP);', see: ['digitalWrite', 'INPUT_PULLUP'] },
  { name: 'digitalWrite', kind: 'function', sig: 'void digitalWrite(uint8_t pin, uint8_t value)', group: 'Цифровой ввод-вывод',
    desc: 'Выставляет на пине HIGH (5 В или 3.3 В) либо LOW (0 В). Пин должен быть настроен как OUTPUT.',
    example: 'digitalWrite(13, HIGH);\ndelay(500);\ndigitalWrite(13, LOW);', see: ['pinMode', 'HIGH'] },
  { name: 'digitalRead', kind: 'function', sig: 'int digitalRead(uint8_t pin)', group: 'Цифровой ввод-вывод',
    desc: 'Читает уровень на пине: HIGH или LOW. Возвращает 1 или 0.',
    returns: 'HIGH или LOW', example: 'if (digitalRead(2) == HIGH) { /* кнопка нажата */ }', see: ['INPUT_PULLUP'] },
  { name: 'analogWrite', kind: 'function', sig: 'void analogWrite(uint8_t pin, int value)', group: 'Аналоговый ввод-вывод',
    desc: 'ШИМ: «аналоговый выход» 0…255 (на ESP32 можно 0…4095 и другую частоту). Работает только на пинах, поддерживающих PWM.',
    example: 'analogWrite(9, 128); // половина мощности', see: ['pinMode'] },
  { name: 'analogRead', kind: 'function', sig: 'int analogRead(uint8_t pin)', group: 'Аналоговый ввод-вывод',
    desc: 'Читает напряжение на аналоговом входе: 0…1023 на AVR (10 бит), 0…4095 на ESP32 (12 бит).',
    returns: '0…1023 (AVR) или 0…4095 (ESP32)', example: 'int v = analogRead(A0);\nfloat volts = v * 5.0 / 1023.0;', see: ['analogReference', 'map'] },
  { name: 'analogReference', kind: 'function', sig: 'void analogReference(uint8_t type)', group: 'Аналоговый ввод-вывод',
    desc: 'Выбирает опорное напряжение АЦП: DEFAULT, INTERNAL (1.1 В на AVR) или EXTERNAL (подаётся на AREF).',
    example: 'analogReference(INTERNAL); // точнее измерять малые напряжения' },
  { name: 'analogReadResolution', kind: 'function', sig: 'void analogReadResolution(int bits)', group: 'Аналоговый ввод-вывод',
    desc: 'Разрядность АЦП на ARM/ESP (обычно 12 бит). На AVR недоступно — там всегда 10 бит.',
    example: 'analogReadResolution(12);' },
  { name: 'tone', kind: 'function', sig: 'void tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0)', group: 'Звук',
    desc: 'Генерирует прямоугольный сигнал заданной частоты (Гц) на пине — для пьезоизлучателя. Без duration играет до noTone().',
    example: 'tone(8, 440, 500); // ля первой октавы, полсекунды', see: ['noTone'] },
  { name: 'noTone', kind: 'function', sig: 'void noTone(uint8_t pin)', group: 'Звук', desc: 'Останавливает звук на пине.', example: 'noTone(8);' },

  // ------------------------------------------------------------ время
  { name: 'delay', kind: 'function', sig: 'void delay(unsigned long ms)', group: 'Время',
    desc: 'Пауза в миллисекундах. Полностью останавливает программу: прерывания работают, но loop не выполняется. Для параллельной работы используйте millis().',
    example: 'delay(1000); // одна секунда', see: ['millis', 'delayMicroseconds'] },
  { name: 'delayMicroseconds', kind: 'function', sig: 'void delayMicroseconds(unsigned int us)', group: 'Время',
    desc: 'Точная пауза в микросекундах (до 16383 на AVR). Для протоколов строгого тайминга (DHT, 1-Wire).',
    example: 'delayMicroseconds(10);' },
  { name: 'millis', kind: 'function', sig: 'unsigned long millis()', group: 'Время',
    desc: 'Миллисекунды с момента запуска (переполнение через ~49 дней). Правильный способ делать «параллельные» задачи: сравнивать разницу, а не сами значения.',
    returns: 'unsigned long', example: 'unsigned long last = 0;\nif (millis() - last >= 1000) { last = millis(); /* раз в секунду */ }', see: ['micros', 'delay'] },
  { name: 'micros', kind: 'function', sig: 'unsigned long micros()', group: 'Время',
    desc: 'Микросекунды с момента запуска. Переполняется каждые ~70 минут — сравнивать только разницей.',
    returns: 'unsigned long', example: 'unsigned long t0 = micros();\n// ...\nunsigned long dt = micros() - t0;' },
  { name: 'yield', kind: 'function', sig: 'void yield()', group: 'Время',
    desc: 'Отдаёт управление системе (важно на ESP: обслуживание Wi-Fi и сторожевого таймера в долгих циклах).',
    example: 'while (waiting) { yield(); }' },

  // ------------------------------------------------------------ прерывания
  { name: 'attachInterrupt', kind: 'function', sig: 'void attachInterrupt(uint8_t interrupt, void (*handler)(void), int mode)', group: 'Прерывания',
    desc: 'Вешает обработчик на изменение пина. mode: RISING, FALLING, CHANGE, LOW. На AVR пины прерываний — 2 и 3 (digitalPinToInterrupt(2)).',
    example: 'volatile unsigned long pulses = 0;\nvoid count() { pulses++; }\nvoid setup() { attachInterrupt(digitalPinToInterrupt(2), count, RISING); }',
    see: ['detachInterrupt', 'digitalPinToInterrupt', 'volatile'] },
  { name: 'detachInterrupt', kind: 'function', sig: 'void detachInterrupt(uint8_t interrupt)', group: 'Прерывания', desc: 'Снимает обработчик прерывания.', example: 'detachInterrupt(digitalPinToInterrupt(2));' },
  { name: 'digitalPinToInterrupt', kind: 'function', sig: 'int digitalPinToInterrupt(uint8_t pin)', group: 'Прерывания', desc: 'Преобразует номер пина в номер прерывания (переносимо между платами).', example: 'attachInterrupt(digitalPinToInterrupt(3), onPulse, FALLING);' },
  { name: 'interrupts', kind: 'function', sig: 'void interrupts()', group: 'Прерывания', desc: 'Включает обработку прерываний (после noInterrupts).', example: 'noInterrupts();\n// критическая секция\ninterrupts();' },
  { name: 'noInterrupts', kind: 'function', sig: 'void noInterrupts()', group: 'Прерывания', desc: 'Запрещает прерывания на время критической секции.', example: 'noInterrupts(); long copy = shared; interrupts();' },
  { name: 'volatile', kind: 'keyword', sig: 'volatile int x;', group: 'Прерывания',
    desc: 'Переменная, которую меняет прерывание, ОБЯЗАНА быть volatile, иначе компилятор закеширует значение в регистре и вы не увидите изменений.',
    example: 'volatile bool buttonPressed = false;\nvoid isr() { buttonPressed = true; }' },

  // ------------------------------------------------------------ Serial
  { name: 'Serial.begin', kind: 'method', sig: 'void Serial.begin(unsigned long baud)', group: 'Serial',
    desc: 'Открывает последовательный порт. Скорость должна совпадать с монитором порта (типично 9600, 57600, 115200). На Leonardo/Micro порт открывается только когда монитор подключён.',
    example: 'Serial.begin(115200);', see: ['Serial.print', 'Serial.available'] },
  { name: 'Serial.print', kind: 'method', sig: 'size_t Serial.print(value[, format])', group: 'Serial',
    desc: 'Печатает текст или число без перевода строки. Форматы: DEC, HEX, BIN, а для чисел с плавающей точкой — количество знаков.',
    example: 'Serial.print("t=");\nSerial.print(21.5, 1);\nSerial.println(" C");', see: ['Serial.println', 'Serial.write'] },
  { name: 'Serial.println', kind: 'method', sig: 'size_t Serial.println(value)', group: 'Serial',
    desc: 'Печатает значение и переводит строку. Наш монитор порта разбирает такие строки в таблицу значений и графики.',
    example: 'Serial.println(analogRead(A0));' },
  { name: 'Serial.write', kind: 'method', sig: 'size_t Serial.write(uint8_t b) / Serial.write(const uint8_t *buf, size_t len)', group: 'Serial',
    desc: 'Пишет байты как есть — без текстового представления. Так MicroTelem отправляет кадры телеметрии.',
    example: 'Serial.write(0xAA);\nSerial.write(buf, len);', see: ['MicroTelem'] },
  { name: 'Serial.available', kind: 'method', sig: 'int Serial.available()', group: 'Serial',
    desc: 'Сколько байт пришло в порт и ещё не прочитано.', returns: 'int', example: 'if (Serial.available()) { char c = Serial.read(); }' },
  { name: 'Serial.read', kind: 'method', sig: 'int Serial.read()', group: 'Serial', desc: 'Читает один байт или -1, если данных нет.', returns: 'int', example: 'int c = Serial.read();' },
  { name: 'Serial.readStringUntil', kind: 'method', sig: 'String Serial.readStringUntil(char terminator)', group: 'Serial',
    desc: 'Читает строку до указанного символа (часто \'\\n\'). Работает с таймаутом (Serial.setTimeout).',
    example: 'String cmd = Serial.readStringUntil(\'\\n\');', see: ['Serial.setTimeout'] },
  { name: 'Serial.parseInt', kind: 'method', sig: 'long Serial.parseInt()', group: 'Serial', desc: 'Читает число из потока. Таймаут по умолчанию 1000 мс — при отсутствии цифр вернёт 0.', returns: 'long', example: 'long speed = Serial.parseInt();' },
  { name: 'Serial.availableForWrite', kind: 'method', sig: 'int Serial.availableForWrite()', group: 'Serial', desc: 'Сколько байт можно записать без ожидания (размер буфера). Полезно перед отправкой больших массивов.' },

  // ------------------------------------------------------------ математика
  { name: 'map', kind: 'function', sig: 'long map(long x, long in_min, long in_max, long out_min, long out_max)', group: 'Математика',
    desc: 'Переводит значение из одного диапазона в другой (линейно). Не ограничивает результат — при выходе за диапазон значение уйдёт дальше.',
    example: 'int brightness = map(analogRead(A0), 0, 1023, 0, 255);', see: ['constrain'] },
  { name: 'constrain', kind: 'function', sig: 'T constrain(T x, T a, T b)', group: 'Математика', desc: 'Ограничивает значение диапазоном [a, b].', example: 'int v = constrain(x, 0, 255);' },
  { name: 'min', kind: 'function', sig: 'T min(T a, T b)', group: 'Математика', desc: 'Меньшее из двух значений.', example: 'int lo = min(a, b);' },
  { name: 'max', kind: 'function', sig: 'T max(T a, T b)', group: 'Математика', desc: 'Большее из двух значений.', example: 'int hi = max(a, b);' },
  { name: 'abs', kind: 'function', sig: 'T abs(T x)', group: 'Математика', desc: 'Модуль числа.', example: 'int d = abs(a - b);' },
  { name: 'random', kind: 'function', sig: 'long random(long min_or_max[, long max])', group: 'Математика', desc: 'Псевдослучайное число. Одна форма — от 0 до max-1, вторая — в диапазоне [min, max).', example: 'long r = random(10, 100);', see: ['randomSeed'] },
  { name: 'randomSeed', kind: 'function', sig: 'void randomSeed(unsigned long seed)', group: 'Математика', desc: 'Инициализирует генератор. Чтобы числа были разными при каждом включении, подайте шум с незадействованного аналогового входа.', example: 'randomSeed(analogRead(A1));' },
  { name: 'sq', kind: 'function', sig: 'T sq(T x)', group: 'Математика', desc: 'Квадрат числа.', example: 'int s = sq(5); // 25' },
  { name: 'sqrt', kind: 'function', sig: 'double sqrt(double x)', group: 'Математика', desc: 'Квадратный корень (медленно на AVR — около 1 мс на вызов).', example: 'double r = sqrt(2.0);' },

  // ------------------------------------------------------------ биты и байты
  { name: 'bitRead', kind: 'function', sig: 'bitRead(value, bit)', group: 'Биты', desc: 'Читает бит номер bit из числа.', example: 'if (bitRead(flags, 3)) { /* бит установлен */ }' },
  { name: 'bitSet', kind: 'function', sig: 'bitSet(value, bit)', group: 'Биты', desc: 'Устанавливает бит в 1.', example: 'bitSet(flags, 2);' },
  { name: 'bitClear', kind: 'function', sig: 'bitClear(value, bit)', group: 'Биты', desc: 'Сбрасывает бит в 0.', example: 'bitClear(flags, 2);' },
  { name: 'bitWrite', kind: 'function', sig: 'bitWrite(value, bit, bitvalue)', group: 'Биты', desc: 'Пишет бит заданным значением.', example: 'bitWrite(flags, 0, on);' },
  { name: 'highByte', kind: 'function', sig: 'uint8_t highByte(value)', group: 'Биты', desc: 'Старший байт 16-битного числа.', example: 'uint8_t hi = highByte(sensor);' },
  { name: 'lowByte', kind: 'function', sig: 'uint8_t lowByte(value)', group: 'Биты', desc: 'Младший байт 16-битного числа.', example: 'uint8_t lo = lowByte(sensor);' },
  { name: 'shiftOut', kind: 'function', sig: 'void shiftOut(dataPin, clockPin, bitOrder, value)', group: 'Биты', desc: 'Выдаёт байт последовательно в сдвиговый регистр (74HC595).', example: 'shiftOut(11, 12, MSBFIRST, 0b10101010);' },
  { name: 'shiftIn', kind: 'function', sig: 'uint8_t shiftIn(dataPin, clockPin, bitOrder)', group: 'Биты', desc: 'Читает байт из сдвигового регистра (74HC165).', example: 'uint8_t v = shiftIn(2, 3, LSBFIRST);' },
  { name: 'pulseIn', kind: 'function', sig: 'unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout = 1000000)', group: 'Биты',
    desc: 'Измеряет длительность импульса в микросекундах. Основа для HC-SR04, IR-приёмников и энкодеров.',
    example: 'digitalWrite(trig, LOW); delayMicroseconds(2);\ndigitalWrite(trig, HIGH); delayMicroseconds(10); digitalWrite(trig, LOW);\nlong us = pulseIn(echo, HIGH);', see: ['micros'] },

  // ------------------------------------------------------------ константы и типы
  { name: 'HIGH', kind: 'constant', sig: '#define HIGH 1', group: 'Константы', desc: 'Высокий уровень (5 В / 3.3 В).', example: 'digitalWrite(13, HIGH);' },
  { name: 'LOW', kind: 'constant', sig: '#define LOW 0', group: 'Константы', desc: 'Низкий уровень (0 В).', example: 'digitalWrite(13, LOW);' },
  { name: 'OUTPUT', kind: 'constant', sig: '#define OUTPUT 1', group: 'Константы', desc: 'Пин работает на выход.', example: 'pinMode(9, OUTPUT);' },
  { name: 'INPUT', kind: 'constant', sig: '#define INPUT 0', group: 'Константы', desc: 'Пин работает на вход (высокоимпедансный).' },
  { name: 'INPUT_PULLUP', kind: 'constant', sig: '#define INPUT_PULLUP 2', group: 'Константы',
    desc: 'Вход с внутренним подтягивающим резистором (~20–50 кОм). Кнопку подключают между пином и землёй, нажатие читается как LOW.',
    example: 'pinMode(2, INPUT_PULLUP);\nif (digitalRead(2) == LOW) { /* нажато */ }' },
  { name: 'LED_BUILTIN', kind: 'constant', sig: '#define LED_BUILTIN 13', group: 'Константы', desc: 'Пин встроенного светодиода (на Uno/Nano — 13, на ESP32 — 2, на Pico — 25).', example: 'pinMode(LED_BUILTIN, OUTPUT);' },
  { name: 'RISING', kind: 'constant', sig: '#define RISING 3', group: 'Константы', desc: 'Прерывание по фронту (LOW → HIGH).' },
  { name: 'FALLING', kind: 'constant', sig: '#define FALLING 2', group: 'Константы', desc: 'Прерывание по спаду (HIGH → LOW).' },
  { name: 'CHANGE', kind: 'constant', sig: '#define CHANGE 1', group: 'Константы', desc: 'Прерывание по любому изменению уровня.' },
  { name: 'DEC', kind: 'constant', sig: '#define DEC 10', group: 'Константы', desc: 'Вывод числа в десятичном виде (по умолчанию).' },
  { name: 'HEX', kind: 'constant', sig: '#define HEX 16', group: 'Константы', desc: 'Вывод числа в шестнадцатеричном виде.', example: 'Serial.println(value, HEX);' },
  { name: 'BIN', kind: 'constant', sig: '#define BIN 2', group: 'Константы', desc: 'Вывод числа в двоичном виде.', example: 'Serial.println(value, BIN);' },
  { name: 'A0..A15', kind: 'constant', sig: '#define A0 14', group: 'Константы', desc: 'Аналоговые входы. На Uno доступны A0…A5, на Nano — до A7, на Mega — до A15.', example: 'int v = analogRead(A0);' },
  { name: 'boolean', kind: 'type', sig: 'typedef bool boolean', group: 'Типы', desc: 'Логическое значение true/false. В новых скетчах лучше писать bool.' },
  { name: 'byte', kind: 'type', sig: 'typedef uint8_t byte', group: 'Типы', desc: 'Целое 0…255 (8 бит).' },
  { name: 'word', kind: 'type', sig: 'typedef unsigned int word', group: 'Типы', desc: 'Целое 0…65535 (16 бит) на AVR.' },
  { name: 'unsigned long', kind: 'type', sig: 'unsigned long', group: 'Типы', desc: '32-битное беззнаковое — обязательный тип для millis()/micros().' },
  { name: 'int', kind: 'type', sig: 'int', group: 'Типы', desc: '16 бит на AVR (−32768…32767), 32 бита на ARM/ESP. Помните: millis() в int не влезает.' },
  { name: 'float', kind: 'type', sig: 'float', group: 'Типы', desc: 'Число с плавающей точкой. Вычисления с float на AVR медленные — избегайте в быстрых циклах.' },
  { name: 'String', kind: 'type', sig: 'String s = "текст";', group: 'Типы',
    desc: 'Строковый объект с методами length(), substring(), indexOf(), toInt(), trim(). На AVR фрагментирует память: для стабильных проектов лучше char[] и snprintf.',
    example: 'String s = "temp=" + String(21.5, 1);\nSerial.println(s);' },
  { name: 'char', kind: 'type', sig: 'char c = \'A\';', group: 'Типы', desc: 'Один символ (байт). Строки — массивы char с нулём в конце.' },
  { name: 'PROGMEM', kind: 'keyword', sig: 'const char data[] PROGMEM = "…";', group: 'Память',
    desc: 'Кладёт данные во флеш-память, а не в ОЗУ. На AVR критично для больших таблиц и строк. Макрос F("текст") делает то же для строк.',
    example: 'Serial.println(F("Длинный текст, который не тратит ОЗУ"));' },
  { name: 'F()', kind: 'function', sig: 'F("строка")', group: 'Память', desc: 'Держит строку во флеше и печатает без копии в ОЗУ — экономит десятки байт.', example: 'Serial.println(F("Ready"));' },

  // ------------------------------------------------------------ библиотеки
  { name: 'Servo', kind: 'topic', sig: 'Servo myServo; myServo.attach(9); myServo.write(90);', group: 'Библиотеки',
    desc: 'Управление сервоприводами (угол 0…180). На AVR выключение ШИМ на 9/10 при использовании библиотеки. Для точного управления — writeMicroseconds(1000…2000).',
    example: '#include <Servo.h>\nServo s;\nvoid setup() { s.attach(9); }\nvoid loop() { s.write(90); delay(1000); s.write(0); delay(1000); }' },
  { name: 'Wire', kind: 'topic', sig: 'Wire.begin(); Wire.beginTransmission(addr); Wire.write(cmd); Wire.endTransmission();', group: 'Библиотеки',
    desc: 'Шина I2C. Типичные адреса: LCD 0x27/0x3F, SSD1306 0x3C, MPU6050 0x68, DS3231 0x68, BME280 0x76/0x77. Нужны подтягивающие резисторы 4.7 кОм (часто стоят на модулях).',
    example: '#include <Wire.h>\nvoid setup() { Wire.begin(); }\nvoid loop() {\n  Wire.beginTransmission(0x3C);\n  Wire.write(0x00);\n  Wire.endTransmission();\n  delay(100);\n}' },
  { name: 'SPI', kind: 'topic', sig: 'SPI.begin(); SPI.transfer(x);', group: 'Библиотеки', desc: 'Быстрая шина SPI (SD-карты, дисплеи, радиомодули). Нужен отдельный пин CS.' },
  { name: 'EEPROM', kind: 'topic', sig: 'EEPROM.read(addr) / EEPROM.write(addr, value) / EEPROM.update(addr, value)', group: 'Библиотеки',
    desc: 'Энергонезависимая память. Ресурс ~100 000 записей на ячейку — используйте update(), он пишет только при изменении. На AVR 1024 байта.',
    example: '#include <EEPROM.h>\nint counter = EEPROM.read(0);\ncounter++;\nEEPROM.update(0, counter);' },
  { name: 'attachInterrupt (пины)', kind: 'topic', sig: '', group: 'Библиотеки', desc: 'Прерывания есть не на всех пинах: Uno/Nano — 2, 3; Mega — 2, 3, 18, 19, 20, 21; ESP32 — почти все; ESP8266 — все, кроме GPIO16; Pico — все.' },

  // ------------------------------------------------------------ MicroPIDE
  { name: 'MicroTelem', kind: 'topic', sig: 'MICROTELEM_BEGIN(); MICROTELEM(a, b, c);', group: 'MicroPIDE',
    desc: 'Наш бинарный протокол телеметрии: кадр 0xAA55 + длина + номер + float32 каналы + CRC16. Вместо текста «t=21.5» уходит 4 байта на канал — на 115200 бод можно обновлять графики 100 раз в секунду. Заголовок MicroTelem.h генерируется в панели «Анализ».',
    example: '#include "MicroTelem.h"\nvoid setup() { MICROTELEM_BEGIN(); }\nvoid loop() {\n  MICROTELEM(analogRead(A0) * 5.0 / 1023.0, millis() / 1000.0);\n}' },
  { name: 'Симулятор на ПК', kind: 'topic', sig: 'Ctrl+Shift+S', group: 'MicroPIDE',
    desc: 'MicroPIDE умеет собрать скетч как обычную программу под ваш компьютер и запустить его с виртуальными часами: delay() прокручивается мгновенно, вывод Serial, состояния пинов и ШИМ видно в мониторе. Работает без платы — свои Arduino.h и Serial, написанные для MicroPIDE.',
    example: '// любые вычисления и логику можно проверить без железа:\n// панель «Тесты» → цель «Симулятор» → Запустить' },
  { name: 'Сценарий .mps', kind: 'topic', sig: 'baud 9600 | duration 3000 | fast on | serial "…" | expect "…" 500', group: 'MicroPIDE',
    desc: 'Один и тот же файл описывает воздействия на устройство и ожидания от него. Запускается на плате (аппаратный тест) и в симуляторе — результат сравним.',
    example: 'baud 9600\nduration 3000\nfast on\nserial "START\\n"\nexpect "OK" 500\nexpect_pin D13 = 1 1500\nexpect_no "ERROR" 3000' },
  { name: 'Склад (Автономно)', kind: 'topic', sig: '.data/vault', group: 'MicroPIDE',
    desc: 'Каталог, куда можно положить архивы ядер (*.tar.bz2, *.zip), библиотек и тулчейнов: MicroPIDE распакует их своим кодом и поставит так, что их увидят и свой сборщик, и arduino-cli. Работает без серверов Arduino.',
    example: '# скопируйте архив и нажмите «Импорт» в панели «Автономно»\nscp ArduinoCore-avr-1.8.6.tar.bz2 ~/.micro-pide/vault/archives/' },
  { name: 'История и карта памяти', kind: 'topic', sig: 'панель «История»', group: 'MicroPIDE',
    desc: 'Снимок скетча делается сам перед каждой сборкой: можно сравнить версии построчно и откатиться. Там же — график размера прошивки и ОЗУ по сборкам и разбор символов из .elf: видно, какая библиотека съела память.',
    example: '// панель «История» → выбрать две версии → «Сравнить»' },
  { name: 'Автопрофилирование', kind: 'topic', sig: 'панель «Анализ» → «Профилировать»', group: 'MicroPIDE',
    desc: 'MicroPIDE переименовывает ваш loop() и добавляет обёртку: замер времени цикла (минимум/среднее/максимум) и свободной памяти. Результат идёт текстом или кадрами MicroTelem — в графиках видно пики.',
    example: '// до: void loop() { … }\n// после: void micropide_loop() { … } + измерительная обёртка loop()' },
  { name: 'Карта подключений', kind: 'topic', sig: 'pins.h', group: 'MicroPIDE',
    desc: 'Панель «Анализ» → «Документация»: MicroPIDE разбирает скетч, строит таблицу пинов, список модулей (BOM), схему в Mermaid и таблицу функций, а также генерирует pins.h с именами пинов.',
    example: '#include "pins.h"\ndigitalWrite(PIN_OUT_D13, HIGH);' },
];

/** Поиск по справочнику: имя, описание, группа. */
export function searchReference(q, { kind, group, limit = 60 } = {}) {
  const s = String(q || '').trim().toLowerCase();
  let list = REFERENCE;
  if (kind) list = list.filter((e) => e.kind === kind);
  if (group) list = list.filter((e) => e.group === group);
  if (s) {
    list = list.filter((e) =>
      e.name.toLowerCase().includes(s)
      || (e.desc || '').toLowerCase().includes(s)
      || (e.example || '').toLowerCase().includes(s)
      || (e.group || '').toLowerCase().includes(s));
    // точное совпадение имени — вверх
    list = [...list].sort((a, b) => {
      const ae = a.name.toLowerCase().startsWith(s) ? 0 : 1;
      const be = b.name.toLowerCase().startsWith(s) ? 0 : 1;
      return ae - be || a.name.localeCompare(b.name);
    });
  }
  return { ok: true, total: list.length, entries: list.slice(0, limit), groups: [...new Set(REFERENCE.map((e) => e.group))] };
}

/** Что вставить в редактор для записи справочника. */
export function snippetFor(name, { wrapInSetup = true } = {}) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return { ok: false, error: 'Пустой запрос' };
  // 1) точное имя, 2) имя с точкой (Serial.println → Serial.println), 3) вхождение
  const all = REFERENCE;
  const e = all.find((x) => x.name.toLowerCase() === q)
    || all.find((x) => x.name.toLowerCase() === q.replace(/[()]/g, ''))
    || all.find((x) => x.name.toLowerCase().startsWith(q + '.'))
    || all.find((x) => x.name.toLowerCase().includes(q));
  if (!e) {
    const near = searchReference(q, { limit: 8 }).entries.map((x) => x.name);
    return { ok: false, error: 'Нет такой записи: ' + name, near };
  }
  const code = e.example || e.sig || '';
  return { ok: true, name: e.name, sig: e.sig || '', desc: e.desc || '', group: e.group || '', code, wrapInSetup, isCall: e.kind === 'function' || e.kind === 'method' };
}
