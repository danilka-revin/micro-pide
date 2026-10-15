#!/usr/bin/env node
// Установить arduino-cli в каталог данных MicroPIDE (.data/bin).
// Используется единым установщиком (install.sh / install.cmd) и кнопкой в UI.
import { installCli } from '../server/arduino.mjs';

try {
  await installCli((line) => console.log(line));
  process.exit(0);
} catch (e) {
  console.error('✗ ' + (e?.message || String(e)));
  process.exit(1);
}
