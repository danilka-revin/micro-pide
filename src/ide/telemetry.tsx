// Панель «Телеметрия» — графики каналов MicroTelem в реальном времени.
//
// Arduino IDE умеет только «плоттер» по строкам. Здесь своя телеметрия:
//   • текстовый формат:  #MT 12 voltage=4.982 uptime=12.340
//   • бинарный кадр:     A5 5A ver seq count  float32×N  CRC16
// Кадры декодируются в браузере (свой парсер, без библиотек), значения
// раскладываются по каналам и рисуются на canvas с автомасштабом.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type SerialPortInfo } from './api';
import type { Prefs } from '../ui/prefs';
import { Ic } from '../ui/icons';

const COLORS = ['#ffc233', '#4cc38a', '#5aa9ff', '#ff7a7a', '#c792ea', '#f78c6c', '#89ddff', '#a9e34b'];
const MAX_POINTS = 1200;

interface Channels { [name: string]: number[] }

/** Разбор строки #MT: «#MT 12 voltage=4.982 uptime=12.340». */
export function parseMtLine(line: string): { seq: number; values: number[]; names: string[] } | null {
  const m = /#MT\s+(\d+)\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  const names: string[] = [];
  const values: number[] = [];
  for (const part of m[2].split(/\s+/)) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    names.push(k);
    values.push(n);
  }
  if (!names.length) return null;
  return { seq: Number(m[1]), names, values };
}

function crc16(bytes: number[]): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= (b & 0xff) << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

/** Разбор бинарных кадров из строки в hex (монитор может печатать байты). */
export function parseHexFrames(line: string, names: string[]): { seq: number; values: number[]; names: string[] }[] {
  const hex = /(?:[0-9a-f]{2}[ ,:]*|$)/gi.exec(line)?.[0] ?? '';
  const bytes: number[] = [];
  for (const tok of line.split(/[^0-9a-fA-F]+/)) {
    if (/^[0-9a-fA-F]{2}$/.test(tok)) bytes.push(parseInt(tok, 16));
    else if (tok.length > 2) {
      for (let i = 0; i + 1 < tok.length; i += 2) {
        const b = parseInt(tok.slice(i, i + 2), 16);
        if (Number.isFinite(b)) bytes.push(b);
      }
    }
  }
  void hex;
  const out: { seq: number; values: number[]; names: string[] }[] = [];
  let i = 0;
  let seq = 0;
  while (i + 6 <= bytes.length) {
    if (bytes[i] !== 0xaa || bytes[i + 1] !== 0x55) { i++; continue; }
    const count = bytes[i + 3];
    const len = 6 + count * 4;                     // заголовок 6 Б + 4 Б на канал
    if (count < 1 || count > 16 || i + len > bytes.length) { i++; continue; }
    const payload = bytes.slice(i + 6, i + len);
    const crc = bytes[i + 4] | (bytes[i + 5] << 8);
    if (crc16(payload) !== crc) { i++; continue; }
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    const values: number[] = [];
    for (let k = 0; k < count; k++) {
      const off = i + 6 + k * 4;
      dv.setUint8(0, bytes[off]); dv.setUint8(1, bytes[off + 1]); dv.setUint8(2, bytes[off + 2]); dv.setUint8(3, bytes[off + 3]);
      values.push(dv.getFloat32(0, true));
    }
    out.push({ seq: seq++, values, names: names.slice(0, count) });
    i += len;
  }
  return out;
}

export function TelemetryPanel({
  active, ports, port, setPort, prefs, onLog,
}: {
  active: boolean;
  ports: SerialPortInfo[];
  port: string;
  setPort: (p: string) => void;
  prefs: Prefs;
  onLog: (line: string, kind?: 'err' | 'hl') => void;
}) {
  const [open, setOpen] = useState(false);
  const [pause, setPause] = useState(false);
  const [channels, setChannels] = useState<Channels>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState('');
  const [frames, setFrames] = useState(0);
  const [names, setNames] = useState<string[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const sinceRef = useRef(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pauseRef = useRef(false);
  pauseRef.current = pause;

  const push = useCallback((seq: number, vals: number[], nm: string[]) => {
    if (!vals.length) return;
    setChannels((cur) => {
      const next: Channels = { ...cur };
      for (let i = 0; i < vals.length; i++) {
        const key = nm[i] || `ch${i + 1}`;
        const arr = next[key] ? next[key].slice() : [];
        arr.push(vals[i]);
        if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
        next[key] = arr;
      }
      return next;
    });
    if (nm.length) setNames((cur) => (cur.length === nm.length && cur.every((x, i) => x === nm[i]) ? cur : nm));
    setFrames((f) => f + 1);
    void seq;
  }, []);

  const close = useCallback(async () => {
    esRef.current?.close();
    esRef.current = null;
    try { await api.serialClose(); } catch { /* ignore */ }
    setOpen(false);
    onLog('Порт закрыт (телеметрия).');
  }, [onLog]);

  const openPort = useCallback(async () => {
    setErr('');
    if (!port) { setErr('Выберите порт'); return; }
    try {
      const r = await api.serialOpen(port, prefs.serialBaud || 115200);
      if (!r?.ok) { setErr(r?.error || 'Не удалось открыть порт'); return; }
      setOpen(true);
      setChannels({});
      setFrames(0);
      const es = new EventSource('/api/serial/stream?since=' + sinceRef.current);
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (typeof d.seq === 'number') sinceRef.current = d.seq;
          const text: string = d.text ?? d.line ?? '';
          if (pauseRef.current) return;
          for (const line of String(text).split('\n')) {
            const mt = parseMtLine(line);
            if (mt) { push(mt.seq, mt.values, mt.names); continue; }
            if (/[0-9a-fA-F]{2}[ ,]/.test(line) && /\bAA\b|\baa\b/.test(line)) {
              for (const fr of parseHexFrames(line, names)) push(fr.seq, fr.values, fr.names);
            }
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => { /* переподключение делает браузер сам */ };
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [port, prefs.serialBaud, push, names]);

  useEffect(() => () => { esRef.current?.close(); }, []);
  useEffect(() => { if (!active && open) void close(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active]);

  const exportCsv = () => {
    const ks = Object.keys(channels);
    if (!ks.length) return;
    const rows = ['n,' + ks.join(',')];
    const max = Math.max(...ks.map((k) => channels[k].length));
    for (let i = 0; i < max; i++) rows.push([i, ...ks.map((k) => channels[k][i] ?? '')].join(','));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'micropide-telemetry.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportPng = () => {
    const c = canvas.current;
    if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = 'micropide-telemetry.png';
    a.click();
  };

  const latest = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, arr] of Object.entries(channels)) if (arr.length) out[k] = arr[arr.length - 1];
    return out;
  }, [channels]);

  // рисование
  useEffect(() => {
    const c = canvas.current;
    if (!c || !active) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 600;
    const h = c.clientHeight || 200;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue('--line').trim() || '#333';
    const muted = css.getPropertyValue('--muted').trim() || '#888';
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = line;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.globalAlpha = 0.4; ctx.stroke(); ctx.globalAlpha = 1;
    }
    const shown = Object.keys(channels).filter((k) => !hidden[k]);
    const all = shown.flatMap((k) => channels[k]);
    if (!all.length) {
      ctx.fillStyle = muted;
      ctx.font = '12px system-ui';
      ctx.fillText(open ? 'Ждём кадры #MT или бинарные A5 5A…' : 'Откройте порт, чтобы увидеть телеметрию', 12, 22);
      return;
    }
    const min = Math.min(...all);
    const max = Math.max(...all);
    const span = max - min || 1;
    const pad = 10;
    shown.forEach((k, idx) => {
      const arr = channels[k];
      if (arr.length < 2) return;
      ctx.strokeStyle = COLORS[idx % COLORS.length];
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      arr.forEach((v, i) => {
        const x = (i / (arr.length - 1)) * (w - pad * 2) + pad;
        const y = h - pad - ((v - min) / span) * (h - pad * 2);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    ctx.fillStyle = muted;
    ctx.font = '10px system-ui';
    ctx.fillText(max.toFixed(2), 6, 12);
    ctx.fillText(min.toFixed(2), 6, h - 4);
  }, [channels, hidden, active, open]);

  const chNames = Object.keys(channels);

  return (
    <div className="tn">
      <div className="tn-bar">
        <select className="tb-sel" value={port} onChange={(e) => setPort(e.target.value)} style={{ width: 130 }}>
          <option value="">{ports.length ? '— порт —' : 'портов нет'}</option>
          {ports.map((p) => <option key={p.address} value={p.address}>{p.address}</option>)}
        </select>
        {!open ? (
          <button className="btn tiny primary" onClick={() => void openPort()}><Ic n="plug" size={13} /> Открыть</button>
        ) : (
          <button className="btn tiny" onClick={() => void close()}><Ic n="close" size={13} /> Закрыть</button>
        )}
        <button className={'btn tiny' + (pause ? ' active' : '')} onClick={() => setPause((v) => !v)} title="Остановить обновление">
          <Ic n="clock" size={13} /> {pause ? 'Продолжить' : 'Пауза'}
        </button>
        <span className="badge sm">{frames} кадр(ов)</span>
        <span className="dim small">{prefs.serialBaud} бод</span>
        <div className="lab-sp" />
        <button className="btn tiny" onClick={exportCsv} disabled={!chNames.length}><Ic n="saveas" size={13} /> CSV</button>
        <button className="btn tiny" onClick={exportPng} disabled={!chNames.length}><Ic n="copy" size={13} /> PNG</button>
        <button className="btn tiny" onClick={() => { setChannels({}); setFrames(0); }} title="Очистить"><Ic n="trash" size={13} /></button>
      </div>
      {err && <div className="lab-note err">{err}</div>}
      <div className="tn-legend">
        {!chNames.length && <span className="dim small">Каналов пока нет. Микроконтроллер должен печатать строки вида <span className="mono">#MT 1 voltage=4.98 uptime=12.3</span> или бинарные кадры A5 5A.</span>}
        {chNames.map((k, i) => (
          <button key={k} className={'ch' + (hidden[k] ? ' off' : '')} onClick={() => setHidden((h) => ({ ...h, [k]: !h[k] }))}>
            <i style={{ background: COLORS[i % COLORS.length] }} />
            <span className="mono">{k}</span>
            <b>{latest[k] !== undefined ? latest[k].toFixed(2) : '—'}</b>
          </button>
        ))}
      </div>
      <canvas className="tn-chart" ref={canvas} />
    </div>
  );
}
