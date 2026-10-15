// Монитор порта и построитель графиков MicroPIDE.
// Данные приходят SSE-потоком /api/serial/stream, отправка — POST /api/serial/send.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SerialPortInfo } from './api';
import type { Prefs } from '../ui/prefs';
import { Ic } from '../ui/icons';

export interface SerialLine { kind: 'rx' | 'tx' | 'sys' | 'err'; text: string; t: number }

export const BAUD_RATES = [300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38800, 57600, 115200];
const MAX_LINES = 2500;

const EOL: Record<Prefs['serialEol'], string> = { none: '', nl: '\n', cr: '\r', crlf: '\r\n' };

/** Монитор порта: подключение, лог, отправка. */
export function SerialMonitor({
  ports, prefs, set, port, setPort, onLog,
}: {
  ports: SerialPortInfo[];
  prefs: Prefs;
  set: (patch: Partial<Prefs>) => void;
  port: string;
  setPort: (p: string) => void;
  onLog?: (kind: SerialLine['kind'], text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [lines, setLines] = useState<SerialLine[]>([]);
  const [sendText, setSendText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const sinceRef = useRef(0);
  const autoscroll = prefs.serialAutoscroll;

  const close = useCallback(async () => {
    esRef.current?.close();
    esRef.current = null;
    try { await api.serialClose(); } catch { /* ignore */ }
    setOpen(false);
    setLines((ls) => [...ls, { kind: 'sys' as const, text: 'Порт закрыт.', t: Date.now() }].slice(-MAX_LINES));
  }, []);

  const openPort = useCallback(async () => {
    if (!port) { setErr('Выберите порт'); return; }
    setBusy(true);
    setErr('');
    setLines([]);
    sinceRef.current = 0;
    try {
      const r = await api.serialOpen(port, prefs.serialBaud);
      if (!r.ok) {
        setErr(r.error || 'Не удалось открыть порт');
        setLines([{ kind: 'err' as const, text: r.error || 'Не удалось открыть порт', t: Date.now() }]);
        setBusy(false);
        return;
      }
      setOpen(true);
      // подписка на поток данных
      const es = new EventSource(`/api/serial/stream`);
      es.onmessage = (ev) => {
        try {
          const it = JSON.parse(ev.data) as SerialLine & { n: number };
          sinceRef.current = Math.max(sinceRef.current, it.n || 0);
          const kind: SerialLine['kind'] = it.kind === 'tx' ? 'tx' : it.kind === 'err' ? 'err' : it.kind === 'sys' ? 'sys' : 'rx';
          setLines((ls) => [...ls, { kind, text: it.text, t: it.t }].slice(-MAX_LINES));
          if (it.kind === 'err') onLog?.('err', '[монитор] ' + it.text);
        } catch { /* ignore */ }
      };
      es.addEventListener('closed', () => {
        setOpen(false);
        es.close();
      });
      es.onerror = () => { /* соединение оборвётся при закрытии порта — не страшно */ };
      esRef.current = es;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }, [port, prefs.serialBaud, onLog]);

  // закрыть порт при размонтировании
  useEffect(() => () => {
    esRef.current?.close();
    void api.serialClose().catch(() => {});
  }, []);

  // автопрокрутка
  useEffect(() => {
    if (autoscroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, autoscroll]);

  const doSend = useCallback(async () => {
    const text = sendText + EOL[prefs.serialEol];
    if (!text) return;
    setSendText('');
    try {
      const r = await api.serialSend(text);
      if (!r.ok) setLines((ls) => [...ls, { kind: 'err' as const, text: r.error || 'ошибка отправки', t: Date.now() }].slice(-MAX_LINES));
    } catch { /* ignore */ }
  }, [sendText, prefs.serialEol]);

  const stamp = (t: number) => {
    const d = new Date(t);
    const p = (n: number, l = 2) => String(n).padStart(l, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };

  return (
    <div className="serial">
      <div className="serial-bar">
        <span className={'pulse' + (busy ? ' busy' : open ? '' : ' off')} title={open ? 'Порт открыт' : 'Порт закрыт'} />
        <select className="tb-sel" value={port} onChange={(e) => setPort(e.target.value)} disabled={open} title="Порт">
          {ports.length === 0 && <option value="">Порты не найдены</option>}
          {ports.map((p) => (
            <option key={p.address} value={p.address}>
              {p.address}{p.boardName ? ` — ${p.boardName}` : ''}
            </option>
          ))}
        </select>
        <select className="tb-sel" value={prefs.serialBaud} disabled={open}
          onChange={(e) => set({ serialBaud: Number(e.target.value) })} title="Скорость порта">
          {BAUD_RATES.map((b) => <option key={b} value={b}>{b} бод</option>)}
        </select>
        {open
          ? <button className="btn" onClick={close}><Ic n="plug" size={14} />Закрыть порт</button>
          : <button className="btn primary" onClick={openPort} disabled={busy || !port}><Ic n="plug" size={14} />Открыть порт</button>}
        {err && <span style={{ color: 'var(--danger-ink)', fontSize: 11.5 }}>{err}</span>}
        <span style={{ flex: 1 }} />
        <label className="chk" style={{ margin: 0 }} title="Автопрокрутка лога">
          <input type="checkbox" checked={prefs.serialAutoscroll} onChange={(e) => set({ serialAutoscroll: e.target.checked })} />
          Автопрокрутка
        </label>
        <label className="chk" style={{ margin: 0 }} title="Штампы времени у строк">
          <input type="checkbox" checked={prefs.serialTimestamps} onChange={(e) => set({ serialTimestamps: e.target.checked })} />
          Время
        </label>
        <button className="btn tiny" onClick={() => setLines([])} title="Очистить лог"><Ic n="clear" size={13} />Очистить</button>
      </div>
      <div className="serial-log" ref={logRef}>
        {lines.length === 0 && (
          <div><span className="sys">Монитор порта: откройте порт, чтобы видеть данные устройства.</span></div>
        )}
        {lines.map((l, i) => {
          const cls = l.kind === 'err' ? 'err' : l.kind === 'tx' ? 'tx' : l.kind === 'sys' ? 'sys' : 'rx';
          return (
            <div key={i} className={cls}>
              {prefs.serialTimestamps && <span className="t">{stamp(l.t)}</span>}
              {l.text.endsWith('\n') || l.kind === 'rx' ? l.text.replace(/\n$/, '') : l.text}
            </div>
          );
        })}
      </div>
      <div className="serial-send">
        <input
          value={sendText}
          placeholder="Что отправить в порт…"
          disabled={!open}
          onChange={(e) => setSendText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doSend(); }}
        />
        <select className="tb-sel" value={prefs.serialEol} onChange={(e) => set({ serialEol: e.target.value as Prefs['serialEol'] })} title="Конец строки">
          <option value="nl">\\n (LF)</option>
          <option value="cr">\\r (CR)</option>
          <option value="crlf">\\r\\n (CRLF)</option>
          <option value="none">без перевода строки</option>
        </select>
        <button className="btn primary" onClick={() => void doSend()} disabled={!open}><Ic n="send" size={14} />Отправить</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- построитель

const PLOT_COLORS = ['#ffc233', '#3fa9ff', '#7ddc52', '#ff6b57', '#a78bfa', '#2fd4d4', '#ff7ab6', '#b6e33a'];
const MAX_POINTS = 700;

/** Построитель графиков: рисует числа из строк монитора (через пробел/таб). */
export function SerialPlotter({
  ports, prefs, set, port, setPort, active,
}: {
  ports: SerialPortInfo[];
  prefs: Prefs;
  set: (patch: Partial<Prefs>) => void;
  port: string;
  setPort: (p: string) => void;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [series, setSeries] = useState<number[]>([]);
  const [nch, setNch] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const dataRef = useRef<number[][]>([]);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    try { void api.serialClose(); } catch { /* ignore */ }
    setOpen(false);
  }, []);

  const start = useCallback(async () => {
    if (!port) return;
    stop();
    dataRef.current = [];
    setSeries([]);
    setNch(0);
    const r = await api.serialOpen(port, prefs.serialBaud);
    if (!r.ok) return;
    setOpen(true);
    const es = new EventSource('/api/serial/stream');
    es.onmessage = (ev) => {
      try {
        const it = JSON.parse(ev.data) as { kind: string; text: string };
        if (it.kind !== 'rx') return;
        const nums = it.text.split(/[\s,\t;]+/).map(parseFloat).filter((v) => isFinite(v));
        if (!nums.length) return;
        const data = dataRef.current;
        nums.forEach((v, i) => {
          if (!data[i]) data[i] = [];
          data[i].push(v);
          if (data[i].length > MAX_POINTS) data[i].shift();
        });
        setNch(nums.length);
      } catch { /* ignore */ }
    };
    es.addEventListener('closed', () => { setOpen(false); es.close(); });
    esRef.current = es;
  }, [port, prefs.serialBaud, stop]);

  useEffect(() => () => { esRef.current?.close(); void api.serialClose().catch(() => {}); }, []);

  // активность панели: запуск/остановка потока
  useEffect(() => {
    if (!active && esRef.current) { esRef.current.close(); esRef.current = null; try { void api.serialClose(); } catch {} setOpen(false); }
  }, [active]);

  // отрисовка
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let stop = false;
    const draw = () => {
      if (stop) return;
      const cv = canvasRef.current;
      if (cv) {
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
        const ctx = cv.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const css = getComputedStyle(document.documentElement);
          const line = css.getPropertyValue('--line') || '#333';
          const muted = css.getPropertyValue('--muted') || '#888';
          ctx.clearRect(0, 0, w, h);
          // сетка
          ctx.strokeStyle = line;
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let gy = 0; gy <= 4; gy++) {
            const y = (h - 20) * gy / 4 + 10;
            ctx.moveTo(0, y); ctx.lineTo(w, y);
          }
          ctx.stroke();
          const data = dataRef.current;
          let min = Infinity, max = -Infinity;
          for (const s of data) for (const v of s) { if (v < min) min = v; if (v > max) max = v; }
          if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
          if (max - min < 1e-9) { max = min + 1; }
          const pad = (max - min) * 0.1;
          min -= pad; max += pad;
          // подписи
          ctx.fillStyle = muted;
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillText(String(Math.round(max * 10) / 10), 4, 12);
          ctx.fillText(String(Math.round(min * 10) / 10), 4, h - 4);
          // линии
          data.forEach((s, i) => {
            if (!s || s.length < 2) return;
            ctx.strokeStyle = PLOT_COLORS[i % PLOT_COLORS.length];
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            const n = s.length;
            for (let k = 0; k < n; k++) {
              const x = (w - 8) * k / (MAX_POINTS - 1) + 4;
              const y = 10 + (h - 20) * (1 - (s[k] - min) / (max - min));
              if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
          });
        }
      }
      setSeries(dataRef.current.map((s) => s.length));
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, [active]);

  return (
    <div className="plot">
      <div className="serial-bar">
        <span className={'pulse' + (open ? '' : ' off')} />
        <select className="tb-sel" value={port} onChange={(e) => setPort(e.target.value)} disabled={open}>
          {ports.length === 0 && <option value="">Порты не найдены</option>}
          {ports.map((p) => <option key={p.address} value={p.address}>{p.address}{p.boardName ? ` — ${p.boardName}` : ''}</option>)}
        </select>
        <select className="tb-sel" value={prefs.serialBaud} disabled={open} onChange={(e) => set({ serialBaud: Number(e.target.value) })}>
          {BAUD_RATES.map((b) => <option key={b} value={b}>{b} бод</option>)}
        </select>
        {open
          ? <button className="btn" onClick={stop}>Стоп</button>
          : <button className="btn primary" onClick={() => void start()} disabled={!port}>Старт</button>}
        <span className="empty" style={{ padding: 0 }}>
          Устройство должно печатать числа через пробел или таб: «12,4 87 -3»
        </span>
      </div>
      <canvas ref={canvasRef} />
      <div className="plot-leg">
        {Array.from({ length: nch }).map((_, i) => (
          <span key={i}><i style={{ background: PLOT_COLORS[i % PLOT_COLORS.length] }} />канал {i + 1} ({series[i] ?? 0} точек)</span>
        ))}
      </div>
    </div>
  );
}
