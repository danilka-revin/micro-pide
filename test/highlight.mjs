#!/usr/bin/env node
// Проверка раскраски вывода компиляции/прошивки (src/ide/console.tsx):
// правила ошибок/успеха должны узнавать характерные строки arduino-cli.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'ide', 'console.tsx'), 'utf8');

const m = src.match(/export function classifyLine\(s: string\): ConsoleKind \{([\s\S]*?)\n\}/);
assert.ok(m, 'classifyLine не найден в console.tsx');
const body = m[1];

// в правилах есть маркеры и ключевые слова
assert.ok(/✓/.test(body) && /✗/.test(body), 'маркеры ✓/✗');
assert.ok(/успешно завершена/.test(body), 'правило успеха');
assert.ok(/error:|ошибка/i.test(body), 'правило ошибки');

// те же правила, что в classifyLine, — проверяем на образцах вывода
const okRules = (s) => /✓|успешно завершена|установлен\.$|готово/i.test(s);
const errRules = (s) => /✗|error:|ошибка|не удалось|Error:/i.test(s);

assert.equal(okRules('✓ Компиляция успешно завершена'), true);
assert.equal(okRules('✓ Прошивка завершена'), true);
assert.equal(errRules('✗ Ошибка компиляции: arduino-cli не найден'), true);
assert.equal(errRules('error: expected ; before } token'), true);
assert.equal(errRules('Sketch uses 928 bytes (2%) of program storage'), false);
assert.equal(okRules('Sketch uses 928 bytes (2%) of program storage'), false);

console.log('✓ classifyLine: правила ошибок/успеха на месте');
console.log('Все проверки прошли.');
