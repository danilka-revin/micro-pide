#!/usr/bin/env node
// Тесты ядра MicroPIDE: препроцессор скетча, свойства платформы, размеры,
// планирование сборки, свой тулчейн-поиск, карта символов и анализатор кода.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MICRO_PIDE_DATA = mkdtempSync(join(tmpdir(), 'micropide-core-'));
process.env.HOME = mkdtempSync(join(tmpdir(), 'micropide-home-'));

const {
  preprocessSketch, parseProps, propsMap, expandVars, expandPattern, splitCommandLine,
  parseSizes, sizeReport, genPlan, loadCoreProps, buildWithOwnEngine, symbolMap,
} = await import('../server/buildcore.mjs');
const { ensureNativeCore, SIM_FQBN } = await import('../server/native.mjs');
const { findFunctions, generatePrototypes, maskCode, crc16 } = await import('../server/cpp.mjs');
const { analyze, pinMap, generateDocs, generatePinsHeader, telemetryHeader, instrumentSketch } = await import('../server/analysis.mjs');
const { snapshotIfChanged, listSnapshots, diffSnapshots, restore, recordBuild, buildStats, historyOverview } = await import('../server/history.mjs');
const { findBoard, boardCaps, guessBoard, searchBoards, allBoards, packageIndex, libraryIndex, saveUserBoards } = await import('../server/boarddb.mjs');

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('✓', name); }
  catch (e) { failed++; console.error('✗', name, '\n ', e.message); if (process.env.VERBOSE) console.error(e.stack); }
};

// ------------------------------------------------------------------ препроцессор
await check('препроцессор: главный .ino первым, остальные по алфавиту, прототипы и #line', () => {
  const files = [
    { path: 'Zeta.ino', content: 'void zetaHelper() { helper(); }\n' },
    { path: 'Demo.ino', content: '#include <Wire.h>\nvoid setup() { helper(); }\nvoid loop() { zetaHelper(); }\nfloat compute(int a, float b) { return a * b; }\nvoid helper() { }\n' },
    { path: 'helper.cpp', content: 'int shared = 0;\n' },
  ];
  const r = preprocessSketch(files, { name: 'Demo' });
  assert.ok(r.cpp.includes('#line 1 "Demo.ino"'), '#line главного файла');
  assert.ok(r.cpp.indexOf('#line 1 "Demo.ino"') < r.cpp.indexOf('#line 1 "Zeta.ino"'), 'порядок вкладок');
  assert.ok(r.cpp.includes('void helper();'), 'прототип helper');
  assert.ok(r.cpp.includes('float compute(int a, float b);'), 'прототип compute');
  assert.ok(!r.cpp.includes('void setup();'), 'setup в прототипы не попадает');
  assert.ok(r.cpp.trim().split('\n')[0].startsWith('//'), 'шапка с пояснением');
  assert.ok(r.includes.some((l) => l.includes('Wire.h')), 'include вынесен');
  assert.equal(r.extraSources.length, 1, 'cpp-файл — отдельная единица трансляции');
  assert.equal(r.diagnostics.filter((d) => d.level === 'error').length, 0);
});

await check('препроцессор: незакрытая скобка — ошибка, а не молчание', () => {
  const r = preprocessSketch([{ path: 'Broken.ino', content: 'void setup() {\n  int x = 1;\n' }], { name: 'Broken' });
  assert.ok(r.diagnostics.some((d) => d.level === 'error'), 'ошибка найдена');
});

await check('разбор функций: сигнатуры в несколько строк, методы класса внутри — мимо', () => {
  const code = 'float readTemp(int pin,\n float scale) {\n return 0;\n}\nclass Foo { void inside() { } };\n';
  const fns = findFunctions(code);
  assert.ok(fns.some((f) => f.name === 'readTemp' && f.ret === 'float' && f.hasBody), 'readTemp найдена');
  assert.ok(!fns.some((f) => f.name === 'inside'), 'метод класса не на верхнем уровне');
  assert.equal(maskCode('char c = \'"\'; // тут void fake() {}\n').includes('fake'), false, 'комментарии и строки замаскированы');
});

// ------------------------------------------------------------------ свойства и рецепты
await check('properties: разбор, раскрытие {переменных}, выброс неизвестных плейсхолдеров', () => {
  const pairs = parseProps('# коммент\nname=Test\ncompiler.path=/usr/bin/\nrecipe.c.o.pattern="{compiler.path}gcc" {build.flags} -o "{object_file}"');
  const vars = propsMap(pairs);
  assert.equal(vars.get('name'), 'Test');
  assert.equal(expandVars('{name}-{build.arch}', new Map([['name', 'A'], ['build.arch', 'AVR']])), 'A-AVR');
  assert.equal(expandVars('{unknown}', vars), '{unknown}');
  assert.equal(expandPattern('gcc {unknown} -o out', vars).trim(), 'gcc -o out');
});

await check('boards.txt: параметры платы и варианты меню по умолчанию', () => {
  const dir = mkdtempSync(join(tmpdir(), 'micropide-core-'));
  writeFileSync(join(dir, 'platform.txt'), 'name=TestCore\nrecipe.cpp.o.pattern="g++" -c "{source_file}" -o "{object_file}"\n');
  writeFileSync(join(dir, 'boards.txt'), [
    'uno.name=Uno Test', 'uno.build.mcu=atmega328p', 'uno.build.f_cpu=16000000L',
    'uno.menu.cpu.atmega328=ATmega328P', 'uno.menu.cpu.atmega328.build.mcu=atmega328p',
    'uno.menu.cpu.atmega168.build.mcu=atmega168', 'uno.build.variant=standard',
  ].join('\n'));
  const { vars } = loadCoreProps(dir, 'uno');
  assert.equal(vars.get('build.mcu'), 'atmega328p', 'первый вариант меню');
  assert.equal(vars.get('build.f_cpu'), '16000000L');
  assert.equal(vars.get('name'), 'TestCore', 'свойства платформы на месте');
  rmSync(dir, { recursive: true, force: true });
});

await check('командная строка: кавычки и экранирование', () => {
  const argv = splitCommandLine('"/usr/bin/g++" -I"/path with space" -DF="x" -o out.o');
  assert.deepEqual(argv, ['/usr/bin/g++', '-I/path with space', '-DF=x', '-o', 'out.o']);
});

// ------------------------------------------------------------------ размеры
await check('размеры: три формата вывода (arduino-cli, avr-size -A, Berkeley)', () => {
  const a = parseSizes('Sketch uses 924 bytes (2%) of program storage space. Maximum is 32256 bytes.\nGlobal variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.');
  assert.equal(a.flash, 924); assert.equal(a.ram, 9); assert.equal(a.maxFlash, 32256);
  const b = parseSizes('.text     1100\n.data       20\n.bss        30\n.rodata     40\n');
  assert.equal(b.flash, 1160); assert.equal(b.ram, 50);
  const c = parseSizes('Program:    1106 bytes (3.4% Full)\nData:         16 bytes (0.8% Full)');
  assert.equal(c.flash, 1106); assert.equal(c.ram, 16);
});

await check('размеры: предупреждения о переполнении и близости к пределу', () => {
  const r = sizeReport({ flash: 32000, ram: 1900, board: 'arduino:avr:uno' });
  assert.equal(r.maxFlash, 32256);
  assert.ok(r.warns.some((w) => w.includes('флеш')), 'предупреждение о флеше: ' + r.warns.join('|'));
  const over = sizeReport({ flash: 40000, ram: 4000, board: 'arduino:avr:uno' });
  assert.ok(over.warns.some((w) => w.includes('не влезает')));
  assert.ok(over.warns.some((w) => w.includes('ОЗУ переполнено')));
});

// ------------------------------------------------------------------ база плат
await check('база плат: поиск, автоопределение по USB, возможности пинов', () => {
  assert.ok(allBoards().length > 25, 'плат в базе: ' + allBoards().length);
  const uno = findBoard('arduino:avr:uno');
  assert.equal(uno.mcu, 'ATmega328P');
  assert.ok(searchBoards('esp32').length >= 2);
  const g = guessBoard({ vid: 0x2341, pid: 0x0043 });
  assert.equal(g.board.fqbn, 'arduino:avr:uno');
  const caps = boardCaps('arduino:avr:uno');
  assert.ok(caps.pwm.has(9) && !caps.pwm.has(7), 'PWM-пины Uno');
  const mine = saveUserBoards([{ fqbn: 'my:core:custom', name: 'Своя плата', mcu: 'STM32F401', flash: 262144, ram: 65536, arch: 'core', vendor: 'my' }]);
  assert.ok(mine.some((b) => b.fqbn === 'my:core:custom'));
  assert.ok(findBoard('my:core:custom'), 'своя плата найдена');
});

await check('свои индексы: package_index и library_index валидны и с нашими данными', () => {
  const pkg = packageIndex();
  assert.ok(pkg.packages[0].platforms.some((p) => p.architecture === 'avr'));
  assert.ok(pkg.packages[0].platforms[0].boards.length > 0, 'платы привязаны к платформе');
  const lib = libraryIndex();
  assert.ok(lib.libraries.some((l) => l.name === 'Servo' && l.providesIncludes.includes('Servo.h')));
  JSON.stringify(pkg); JSON.stringify(lib);
});

// ------------------------------------------------------------------ анализатор
await check('анализатор: ловит ошибки пинов, Serial, памяти', () => {
  const files = [{
    path: 'Bad.ino', content: [
      'void setup() {',
      '  Serial.begin(115200);',
      '}',
      'void loop() {',
      '  analogWrite(7, 100);       // на Uno у пина 7 нет ШИМ',
      '  analogWrite(9, 100);',
      '  int t = millis();          // должен быть unsigned long',
      '  if (t = 5) { }             // присваивание вместо сравнения',
      '  attachInterrupt(digitalPinToInterrupt(7), onP, RISING);',
      '  digitalWrite(40, HIGH);    // пина нет на Uno',
      '  delay(500);',
      '}',
      'void onP() { Serial.println("в прерывании"); }',
    ].join('\n'),
  }];
  const r = analyze({ files, fqbn: 'arduino:avr:uno', baud: 9600, installedLibs: [] });
  const ids = r.issues.map((i) => i.id);
  for (const want of ['no-pwm', 'signed-millis', 'assign-in-if', 'no-int', 'pin-not-exist', 'delay-in-loop', 'serial-in-isr', 'baud-mismatch']) {
    assert.ok(ids.includes(want), 'нет находки ' + want + ' (есть: ' + ids.join(',') + ')');
  }
  assert.ok(r.issues.find((i) => i.id === 'assign-in-if').fix, 'у находки есть автоправка');
  assert.equal(r.summary.errors >= 1, true, 'есть ошибки: ' + JSON.stringify(r.summary));
});

await check('анализатор: ESP32 — флеш-пины, ADC2 с Wi-Fi, input-only', () => {
  const files = [{ path: 'Esp.ino', content: 'void setup() { WiFi.begin("a","b"); }\nvoid loop() {\n int a = analogRead(4);\n digitalWrite(6, HIGH);\n analogWrite(34, 100);\n}' }];
  const r = analyze({ files, fqbn: 'esp32:esp32:esp32' });
  const ids = r.issues.map((i) => i.id);
  assert.ok(ids.includes('esp-adc2'), 'ADC2 при Wi-Fi: ' + ids.join(','));
  assert.ok(ids.includes('flash-pin'), 'флеш-пин');
  assert.ok(ids.includes('input-only'), 'только вход');
});

await check('карта пинов: роли, конфликты, неиспользованные', () => {
  const files = [{ path: 'Pins.ino', content: 'void setup() { pinMode(13, OUTPUT); pinMode(2, INPUT_PULLUP); }\nvoid loop() {\n digitalWrite(13, HIGH);\n int v = analogRead(A0);\n int d = digitalRead(2);\n delay(1);\n}' }];
  const pm = pinMap({ files, fqbn: 'arduino:avr:uno' });
  const p13 = pm.pins.find((p) => p.pin === 13);
  const p2 = pm.pins.find((p) => p.pin === 2);
  assert.ok(p13.roles.includes('выход'));
  assert.ok(p2.roles.includes('вход с подтяжкой'));
  assert.ok(pm.pins.some((p) => p.label.includes('A0') || p.roles.includes('аналоговый вход')), 'A0 размечен');
  assert.ok(pm.unused.length > 0, 'неиспользованные пины перечислены');
  assert.ok(pm.stats.used >= 2);
});

await check('документация: BOM, Mermaid, таблица функций', () => {
  const files = [{ path: 'D.ino', content: '#include <DHT.h>\n#include <Servo.h>\nServo s;\nvoid setup() { Serial.begin(9600); }\nvoid loop() { Serial.println(analogRead(A0)); delay(100); }\nfloat f(int x) { return x; }\n' }];
  const docs = generateDocs({ files, fqbn: 'arduino:avr:uno', name: 'D', issues: [] });
  assert.ok(docs.markdown.includes('```mermaid'), 'есть схема Mermaid');
  assert.ok(docs.markdown.includes('Что нужно подключить'), 'есть BOM');
  assert.ok(docs.markdown.includes('Датчик температуры'), 'DHT распознан');
  assert.ok(docs.markdown.includes('Сервопривод'), 'Servo распознан');
  assert.ok(docs.modules >= 2 && docs.functions >= 3, JSON.stringify({ m: docs.modules, f: docs.functions }));
});

await check('pins.h: имена пинов с пометками платы', () => {
  const files = [{ path: 'P.ino', content: 'void setup() { pinMode(9, OUTPUT); }\nvoid loop() { analogRead(A0); delay(1); }' }];
  const h = generatePinsHeader({ files, fqbn: 'arduino:avr:uno', name: 'P' });
  assert.ok(h.content.includes('#pragma once'));
  assert.ok(/PIN_OUT_D9 = 9/.test(h.content), 'имя для пина 9: ' + h.content.split('\n').slice(6, 12).join(' | '));
  assert.ok(h.content.includes('Особенности платы Arduino Uno'));
});

await check('телеметрия: кадр, CRC16 и заголовок MicroTelem.h', () => {
  const t = telemetryHeader({ channels: ['a', 'b', 'c'], baud: 115200, periodMs: 20 });
  assert.equal(t.frameBytes, 6 + 12);
  assert.ok(t.content.includes('0xAA, 0x55'));
  assert.ok(t.content.includes('MICROTELEM(a, b, c)') || t.content.includes('MICROTELEM(...)'));
  assert.equal(crc16([0x31, 0x32, 0x33]), 0x5bce - 0x5bce + 0x5bce); // значение зафиксировано
  assert.equal(crc16([0x31, 0x32, 0x33]).toString(16), '5bce');
  assert.equal(crc16([]), 0xffff);
});

await check('профилирование: loop переименован, добавлена обёртка с замером', () => {
  const files = [{ path: 'L.ino', content: 'void setup() {}\nvoid loop() { delay(10); }' }];
  const r = instrumentSketch({ files });
  assert.ok(r.ok, r.error);
  const out = r.files[0].content;
  assert.ok(out.includes('void micropide_loop()'), 'старый loop переименован');
  assert.ok(/void loop\(\)/.test(out), 'обёртка loop добавлена');
  assert.ok(out.includes('micropide_loop();'), 'вызов оригинала');
  assert.ok(out.includes('micros()'), 'замер времени');
  const again = instrumentSketch({ files: r.files });
  assert.equal(again.ok, false, 'повторная инструментация не делается');
});

// ------------------------------------------------------------------ история
await check('история: снимок, дедупликация, diff, восстановление', () => {
  const files = [{ path: 'S.ino', content: 'void setup() {}\nvoid loop() { delay(1000); }\n' }];
  const s1 = snapshotIfChanged('HistSketch', files, { reason: 'save' });
  assert.ok(s1.ok && s1.id, 'снимок создан');
  const s2 = snapshotIfChanged('HistSketch', files, { reason: 'save' });
  assert.ok(s2.skipped, 'одинаковое содержимое не дублируется');
  const files2 = [{ path: 'S.ino', content: 'void setup() {}\nvoid loop() { delay(250); }\n' }];
  const s3 = snapshotIfChanged('HistSketch', files2, { reason: 'build' });
  assert.ok(!s3.skipped, 'изменение создаёт снимок');
  const list = listSnapshots('HistSketch');
  assert.equal(list.snapshots.length, 2);
  const d = diffSnapshots('HistSketch', s1.id, s3.id);
  assert.ok(d.ok && d.changed === 1, 'изменён один файл: ' + JSON.stringify(d.summary));
  assert.ok(d.files[0].diff.text.includes('-void loop() { delay(1000); }'), 'удалённая строка видна');
  assert.ok(d.files[0].diff.text.includes('+void loop() { delay(250); }'), 'добавленная строка видна');
  const r = restore('HistSketch', s1.id);
  assert.ok(r.ok && r.files[0].content.includes('delay(1000)'), 'восстановление вернуло старую версию');
  const ov = historyOverview();
  assert.ok(ov.sketches.some((s) => s.name === 'HistSketch'));
});

await check('история сборок: размеры, дельты, тренд', () => {
  recordBuild({ name: 'HistSketch', fqbn: 'arduino:avr:uno', ok: true, flash: 900, ram: 20, ms: 1200, via: 'MicroPIDE' });
  recordBuild({ name: 'HistSketch', fqbn: 'arduino:avr:uno', ok: true, flash: 1500, ram: 30, ms: 900, via: 'MicroPIDE' });
  recordBuild({ name: 'HistSketch', fqbn: 'arduino:avr:uno', ok: true, flash: 2400, ram: 30, ms: 800, via: 'MicroPIDE' });
  const st = buildStats('HistSketch');
  assert.equal(st.builds, 3);
  assert.equal(st.flash.last, 2400);
  assert.equal(st.series.length, 3);
  assert.ok(st.warnings.length >= 1, 'тренд замечен: ' + st.warnings.join('|'));
});

await check('история: свои платы, восстановление после ошибки diff', () => {
  const bad = diffSnapshots('HistSketch', 'нет-такого', 'current', []);
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

// ------------------------------------------------------------------ своя сборка
await check('plan: сборка по platform.txt + запуск готового бинарника (нативный тулчейн)', async () => {
  ensureNativeCore();
  const files = [{ path: 'Proof.ino', content: 'int answer() { return 42; }\nvoid setup() { Serial.begin(9600); Serial.println(answer()); }\nvoid loop() { delay(1000); }' }];
  const r = await buildWithOwnEngine({ name: 'Proof', fqbn: SIM_FQBN, files });
  assert.ok(r.ok, 'сборка своим движком: ' + (r.error || '') + ' | ' + (r.log || []).slice(-6).join(' ~ '));
  assert.ok(existsSync(r.elf), 'исполняемый файл на месте');
  assert.equal(r.prototypes, 1, 'прототип для answer() сгенерирован');
  // запускаем и проверяем вывод
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(r.elf, [], { encoding: 'utf8', env: { ...process.env, MICROPIDE_SIM_DURATION: '10' } });
  assert.equal(run.stdout.trim(), '42', 'программа напечатала 42');

  // карта символов по этому же .elf
  const map = await symbolMap(r.elf, { ok: true, cmds: {} });
  assert.ok(map.ok, 'карта памяти: ' + map.error);
  assert.ok(map.all.some((s) => s.name.includes('answer')), 'символ answer в карте');
  assert.ok(Object.keys(map.bySection).length > 0);
});

await check('plan: понятная ошибка, если ядра нет', async () => {
  const r = await buildWithOwnEngine({ name: 'X', fqbn: 'нет:такого:платы', files: [{ path: 'X.ino', content: 'void setup(){} void loop(){}' }] });
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 10, 'ошибка объяснена: ' + r.error);
});

rmSync(process.env.MICRO_PIDE_DATA, { recursive: true, force: true });
rmSync(process.env.HOME, { recursive: true, force: true });
console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nЯдро MicroPIDE: все проверки прошли.');
process.exit(failed ? 1 : 0);
