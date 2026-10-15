// Панель «История» — своя система версий скетча и журнал сборок.
//
// Arduino IDE не хранит историю: сохранил — и всё. MicroPIDE делает снимок при
// каждом сохранении/сборке, показывает построчный дифф, позволяет откатиться и
// ведёт график расхода флеш/ОЗУ по сборкам (с предупреждениями о росте).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type SketchFile } from './api';
import { Ic } from '../ui/icons';
import { fmt } from '../ui/widgets';

interface Snap { id: string; at: number; reason: string; note: string; files: number; bytes: number; hash?: string }
interface DiffFile { path: string; changed: boolean; added?: number; removed?: number; diff: { text: string; lines?: unknown[] } }

const when = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const REASON: Record<string, string> = { manual: 'сохранение', save: 'сохранение', build: 'сборка', upload: 'прошивка', auto: 'автоснимок', draft: 'черновик' };

export function HistoryPanel({
  active, sketchName, files, onRestore, onToast,
}: {
  active: boolean;
  sketchName: string;
  files: SketchFile[];
  onRestore: (files: SketchFile[]) => void;
  onToast: (s: string) => void;
}) {
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('current');
  const [diff, setDiff] = useState<{ files?: DiffFile[]; summary?: Record<string, number>; error?: string } | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [tab, setTab] = useState<'snapshots' | 'builds'>('snapshots');

  const reload = useCallback(async () => {
    try {
      const r = await api.historySnapshots(sketchName, 60);
      setSnaps(r.snapshots || []);
      setErr('');
      const st = await api.historyStats(sketchName);
      setStats(st);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [sketchName]);

  useEffect(() => { if (active) void reload(); }, [active, reload]);

  const makeSnapshot = async (reason = 'manual') => {
    setBusy(true);
    try {
      const r = await api.historySnapshot(sketchName, files, reason);
      onToast(r.ok ? 'Снимок создан: ' + when(r.at) : 'Ошибка: ' + r.error);
      setSnaps((cur) => [{ id: r.id, at: r.at, reason, note: '', files: files.length, bytes: 0 }, ...cur]);
    } catch (e) { onToast('Ошибка: ' + (e instanceof Error ? e.message : String(e))); }
    setBusy(false);
  };

  const showDiff = async () => {
    if (!a) { onToast('Выберите снимок слева'); return; }
    setBusy(true);
    try {
      const r = await api.historyDiff(sketchName, a, b, b === 'current' ? files : undefined);
      setDiff(r);
      if (!r.ok) onToast(r.error || 'Дифф не получился');
    } catch (e) { onToast('Ошибка: ' + (e instanceof Error ? e.message : String(e))); }
    setBusy(false);
  };

  const restore = async (id: string) => {
    setBusy(true);
    try {
      const r = await api.historyRestore(sketchName, id);
      if (r.ok && r.files) { onRestore(r.files); onToast(`Вернул версию от ${when(r.at || Date.now())}`); }
      else onToast('Не удалось: ' + (r.error || ''));
    } catch (e) { onToast('Ошибка: ' + (e instanceof Error ? e.message : String(e))); }
    setBusy(false);
  };

  const remove = async (id: string) => {
    try { await api.historyDelete(sketchName, id); setSnaps((cur) => cur.filter((s) => s.id !== id)); } catch { /* ignore */ }
  };

  return (
    <div className="hist">
      <div className="lab-bar">
        <button className={'chip' + (tab === 'snapshots' ? ' active' : '')} onClick={() => setTab('snapshots')}>Версии ({snaps.length})</button>
        <button className={'chip' + (tab === 'builds' ? ' active' : '')} onClick={() => setTab('builds')}>Сборки ({stats?.builds ?? 0})</button>
        <div className="lab-sp" />
        <button className="btn tiny" onClick={() => void makeSnapshot('manual')} disabled={busy}>
          <Ic n="save" size={13} /> Снимок сейчас
        </button>
        <button className="tb-btn" title="Обновить" onClick={() => void reload()}><Ic n="refresh" size={15} /></button>
      </div>

      {err && <div className="lab-note err">Сервер недоступен: {err}</div>}

      {tab === 'snapshots' && (
        <div className="hist-cols">
          <div className="hist-list">
            {!snaps.length && <div className="lab-note">Снимков ещё нет. Они создаются сами при сохранении и сборке.</div>}
            {snaps.map((s, i) => (
              <div key={s.id} className={'snap' + (a === s.id ? ' sel' : '')} onClick={() => setA(s.id)}>
                <div className="snap-time">{when(s.at)}</div>
                <div className="snap-meta">
                  <span className="badge sm">{REASON[s.reason] || s.reason}</span>
                  <span className="dim">{s.files} файл(а) · {fmt(Math.round(s.bytes / 1024))} КБ</span>
                  {i === 0 && <span className="badge sm ok">последний</span>}
                </div>
                <div className="snap-actions">
                  <button className="btn tiny" title="Сравнить с текущим" onClick={(e) => { e.stopPropagation(); setA(s.id); setB('current'); void showDiff(); }}>
                    <Ic n="find" size={12} /> Дифф
                  </button>
                  <button className="btn tiny" title="Вернуть эту версию" onClick={(e) => { e.stopPropagation(); void restore(s.id); }}>
                    <Ic n="undo" size={12} /> Вернуть
                  </button>
                  <button className="btn tiny danger" title="Удалить снимок" onClick={(e) => { e.stopPropagation(); void remove(s.id); }}>
                    <Ic n="trash" size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="hist-diff">
            <div className="lab-filters">
              <span className="lab-hint">
                {a ? `Сравниваю ${when(snaps.find((s) => s.id === a)?.at || 0)}` : 'Выберите снимок'} →
              </span>
              <select className="tb-sel" value={b} onChange={(e) => setB(e.target.value)}>
                <option value="current">текущий скетч</option>
                {snaps.map((s) => <option key={s.id} value={s.id}>{when(s.at)} · {REASON[s.reason] || s.reason}</option>)}
              </select>
              <button className="btn tiny" onClick={() => void showDiff()} disabled={busy || !a}>Показать</button>
            </div>
            {diff?.error && <div className="lab-note err">{diff.error}</div>}
            {diff?.summary && (
              <div className="lab-hint">
                Изменено файлов: {diff.summary.changed ?? diff.files?.filter((f) => f.changed).length ?? 0}
                {' '}+{diff.summary.added ?? 0} / −{diff.summary.removed ?? 0} строк
              </div>
            )}
            <div className="diff">
              {(diff?.files || []).filter((f) => f.changed).map((f) => (
                <div key={f.path} className="diff-file">
                  <div className="diff-head">{f.path} <span className="dim">+{f.added} / −{f.removed}</span></div>
                  <pre className="diff-body">
                    {f.diff.text.split('\n').map((l, i) => (
                      <div key={i} className={'dl' + (l.startsWith('+') ? ' add' : l.startsWith('-') ? ' del' : l.startsWith('@@') ? ' hunk' : '')}>{l || ' '}</div>
                    ))}
                  </pre>
                </div>
              ))}
              {diff && !(diff.files || []).some((f) => f.changed) && <div className="lab-ok">Различий нет — версии совпадают.</div>}
              {!diff && <div className="lab-note">Выберите снимок и нажмите «Показать»: увидите построчный дифф и сможете откатиться.</div>}
            </div>
          </div>
        </div>
      )}

      {tab === 'builds' && <BuildStats stats={stats} />}
    </div>
  );
}

/** График размеров по сборкам: свой canvas, без библиотек. */
export function BuildStats({ stats }: { stats: any }) {
  const series = useMemo(() => (stats?.series || []) as { at: number; flash: number | null; ram: number | null; ok: boolean; name?: string }[], [stats]);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 600;
    const h = c.clientHeight || 180;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue('--line').trim() || '#333';
    const muted = css.getPropertyValue('--muted').trim() || '#888';
    const accent = css.getPropertyValue('--accent').trim() || '#ffc233';
    const ok = css.getPropertyValue('--ok').trim() || '#4caf50';
    const vals = series.map((s) => s.flash || 0).filter((v) => v > 0);
    const ramVals = series.map((s) => s.ram || 0).filter((v) => v > 0);
    if (!vals.length) { ctx.fillStyle = muted; ctx.font = '12px system-ui'; ctx.fillText('Пока нет сборок с известным размером флеш', 12, 24); return; }
    const max = Math.max(...vals) * 1.15;
    const maxRam = Math.max(...ramVals, 1) * 1.6;
    const x = (i: number) => 8 + (i * (w - 16)) / Math.max(1, series.length - 1);
    const y = (v: number) => h - 20 - (v / max) * (h - 34);
    ctx.strokeStyle = line;
    ctx.beginPath(); ctx.moveTo(8, h - 20); ctx.lineTo(w - 8, h - 20); ctx.stroke();
    // флеш
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
    series.forEach((s, i) => { const v = s.flash || 0; const px = x(i), py = y(v); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.stroke();
    // ОЗУ (своя шкала, пунктиром)
    ctx.strokeStyle = ok; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.beginPath();
    series.forEach((s, i) => {
      const v = s.ram || 0;
      const px = x(i); const py = h - 20 - (v / maxRam) * (h - 34);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = muted; ctx.font = '11px system-ui';
    ctx.fillText('флеш, Б', 10, 14);
    ctx.fillStyle = ok; ctx.fillText('ОЗУ', 68, 14);
    ctx.fillStyle = muted;
    ctx.fillText(String(max), w - 60, 14);
    series.forEach((s, i) => {
      if (!s.ok) { ctx.fillStyle = '#e5484d'; ctx.beginPath(); ctx.arc(x(i), h - 20, 3, 0, Math.PI * 2); ctx.fill(); }
    });
  }, [series]);

  if (!stats) return <div className="lab-note">Статистика появится после первой сборки.</div>;
  return (
    <div className="bstats">
      <div className="prof-cards">
        <div className="gen-card"><b>Сборок</b><p className="big">{stats.builds}</p></div>
        <div className="gen-card"><b>Флеш сейчас</b><p className="big">{stats.flash?.last != null ? fmt(stats.flash.last) + ' Б' : '—'}{stats.flash?.delta ? <span className="dim"> ({stats.flash.delta > 0 ? '+' : ''}{fmt(stats.flash.delta)})</span> : null}</p></div>
        <div className="gen-card"><b>ОЗУ сейчас</b><p className="big">{stats.ram?.last != null ? fmt(stats.ram.last) + ' Б' : '—'}{stats.ram?.delta ? <span className="dim"> ({stats.ram.delta > 0 ? '+' : ''}{fmt(stats.ram.delta)})</span> : null}</p></div>
        <div className="gen-card"><b>Успешных</b><p className="big">{stats.ok}/{stats.builds}</p></div>
      </div>
      <canvas className="bstats-chart" ref={canvas} />
      {!!(stats.warnings || []).length && (
        <ul className="advice">
          {stats.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
        </ul>
      )}
      <table className="tbl">
        <thead><tr><th>Когда</th><th>Плата</th><th>Флеш</th><th>ОЗУ</th><th>Время</th><th>Чем</th><th></th></tr></thead>
        <tbody>
          {(stats.series || []).slice(-25).reverse().map((s: any, i: number) => (
            <tr key={i}>
              <td className="dim">{when(s.at)}</td>
              <td className="mono">{s.fqbn || '—'}</td>
              <td>{s.flash != null ? fmt(s.flash) : '—'}{s.dFlash ? <span className="dim"> ({s.dFlash > 0 ? '+' : ''}{s.dFlash})</span> : null}</td>
              <td>{s.ram != null ? fmt(s.ram) : '—'}{s.dRam ? <span className="dim"> ({s.dRam > 0 ? '+' : ''}{s.dRam})</span> : null}</td>
              <td className="dim">{s.ms ? fmt(Math.round(s.ms / 100) / 10) + ' с' : '—'}</td>
              <td className="dim">{s.via || s.kind || ''}</td>
              <td>{s.ok ? <span className="badge sm ok">ок</span> : <span className="badge sm bad">ошибка</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!stats.series?.length && <div className="lab-note">Ещё не было сборок — соберите скетч (Ctrl+R), и здесь появится график расхода памяти.</div>}
    </div>
  );
}
