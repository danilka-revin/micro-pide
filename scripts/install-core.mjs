#!/usr/bin/env node
// Установить платформу (ядро) плат, например arduino:avr.
//   node scripts/install-core.mjs [id]   (по умолчанию arduino:avr)
import { installCore } from '../server/arduino.mjs';

const id = process.argv[2] || 'arduino:avr';
console.log(`Устанавливаю платформу ${id}…`);
try {
  await installCore(id, (line) => console.log(line));
  console.log(`✓ Платформа ${id} установлена.`);
  process.exit(0);
} catch (e) {
  console.error('✗ ' + (e?.message || String(e)));
  process.exit(1);
}
