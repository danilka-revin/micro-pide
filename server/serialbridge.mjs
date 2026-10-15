// Серийный мост MicroPIDE: открывает COM-порт и отдаёт данные подписчикам.
//
// Два способа (первый доступный):
//   1. пакет serialport (optionalDependencies — нативный модуль);
//   2. `arduino-cli monitor` (без нативных зависимостей) — stdin/stdout мост.
// История хранится в кольцевом буфере, подписчики читают через /api/serial/stream.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { findCli } from './arduino.mjs';

const MAX_BUF = 1200; // строк истории

export class SerialBridge {
  constructor() {
    this.isOpen = false;
    this.port = '';
    this.baud = 9600;
    this.buffer = [];   // [{n, kind, text, t}]
    this.seq = 0;
    this.proc = null;   // arduino-cli monitor
    this.sp = null;     // serialport instance
    this.SerialPort = null;
    this.err = null;
    this.clients = 0;
    this.pendingRx = '';  // хвост строки: ждём \n или таймер, чтобы не рвать строки
    this.flushTimer = null;
  }

  /** RX-данные: копим до перевода строки; долгие бинарные потоки сбрасываем по таймеру. */
  pushRx(text) {
    this.pendingRx += text;
    clearTimeout(this.flushTimer);
    const flushAll = () => {
      if (this.pendingRx) { this.push('rx', this.pendingRx); this.pendingRx = ''; }
    };
    if (this.pendingRx.includes('\n')) {
      const idx = this.pendingRx.lastIndexOf('\n');
      const ready = this.pendingRx.slice(0, idx + 1);
      this.pendingRx = this.pendingRx.slice(idx + 1);
      this.push('rx', ready);
    }
    if (this.pendingRx.length > 4096) flushAll();
    else this.flushTimer = setTimeout(flushAll, 250);
  }

  push(kind, text) {
    this.seq++;
    this.buffer.push({ n: this.seq, kind, text, t: Date.now() });
    if (this.buffer.length > MAX_BUF) this.buffer.splice(0, this.buffer.length - MAX_BUF);
  }

  since(n) {
    if (!n) return this.buffer.slice(-200);
    return this.buffer.filter((x) => x.n > n);
  }

  async trySerialport(port, baud) {
    try {
      const mod = await import('serialport');
      const { SerialPort } = mod;
      await new Promise((res, rej) => {
        this.sp = new SerialPort({ path: port, baudRate: baud, autoOpen: true }, (e) => (e ? rej(e) : res()));
      });
      this.SerialPort = SerialPort;
      this.sp.on('data', (d) => this.pushRx(d.toString('utf8')));
      this.sp.on('error', (e) => this.push('err', 'Порт: ' + e.message));
      return true;
    } catch (e) {
      this.sp = null;
      this.spErr = e;
      return false;
    }
  }

  async tryCliMonitor(port, baud) {
    const info = await findCli();
    if (!info.ok) {
      this.err = 'Ни пакета serialport, ни arduino-cli нет на машине — монитор порта недоступен.';
      return false;
    }
    const env = { ...process.env };
    env.ARDUINO_DIRECTORIES_DATA = join(info.dataDir, 'arduino15');
    env.ARDUINO_DIRECTORIES_DOWNLOADS = join(info.dataDir, 'staging');
    env.ARDUINO_DIRECTORIES_USER = info.sketchbook;
    this.proc = spawn(info.path, ['monitor', '--config', `baudrate=${baud}`, '-p', port], {
      windowsHide: true, env,
    });
    let banner = '';
    let dropped = false;
    this.proc.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      if (!dropped) {
        // первый вывод pluggable monitor может быть баннером — отфильтруем
        banner += s;
        if (banner.length < 4096 && !/[\r\n]/.test(banner)) return;
        const clean = banner.replace(/^(Serial monitor|Monitor port|Перезапуск)?[^\n]*\n/, '');
        dropped = true;
        if (clean) this.pushRx(clean);
        return;
      }
      this.pushRx(s);
    });
    this.proc.stderr.on('data', (d) => this.push('sys', d.toString('utf8').trim()));
    this.proc.on('error', (e) => this.push('err', 'monitor: ' + e.message));
    this.proc.on('close', (code) => {
      if (this.isOpen) {
        this.push('sys', `Порт закрыт (${code ?? 0}).`);
        this.isOpen = false;
        this.proc = null;
      }
    });
    // дать процессу шанс упасть (нет такого порта)
    await new Promise((r) => setTimeout(r, 700));
    if (!this.proc || this.proc.exitCode !== null) {
      this.err = 'arduino-cli monitor не смог открыть порт ' + port;
      this.proc = null;
      return false;
    }
    return true;
  }

  async open(port, baud) {
    if (this.isOpen) this.close();
    if (!port) return { ok: false, error: 'Не указан порт' };
    this.port = port;
    this.baud = baud;
    this.err = null;
    this.push('sys', `Открываю ${port} @ ${baud}…`);
    if (await this.trySerialport(port, baud)) {
      this.isOpen = true;
      this.push('sys', 'Порт открыт (serialport).');
      return { ok: true, via: 'serialport' };
    }
    if (await this.tryCliMonitor(port, baud)) {
      this.isOpen = true;
      this.push('sys', 'Порт открыт (arduino-cli monitor).');
      return { ok: true, via: 'monitor' };
    }
    this.push('err', this.err || 'Не удалось открыть порт.');
    return { ok: false, error: this.err || 'Не удалось открыть порт' };
  }

  async send(text) {
    if (!this.isOpen) return { ok: false, error: 'Порт не открыт' };
    this.push('tx', text);
    if (this.sp) {
      await new Promise((r) => this.sp.write(text, () => r()));
      return { ok: true };
    }
    if (this.proc?.stdin) {
      this.proc.stdin.write(text + '\n');
      return { ok: true };
    }
    return { ok: false, error: 'Порт не открыт' };
  }

  close() {
    clearTimeout(this.flushTimer);
    if (this.pendingRx) { this.push('rx', this.pendingRx); this.pendingRx = ''; }
    if (this.sp) {
      try { this.sp.close(); } catch { /* ignore */ }
      this.sp = null;
    }
    if (this.proc) {
      try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
      this.proc = null;
    }
    if (this.isOpen) {
      this.isOpen = false;
      this.push('sys', 'Порт закрыт.');
    }
  }
}
