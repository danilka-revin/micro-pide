// Панель «Анализ» — своя проверка скетча, которой нет в Arduino IDE.
//
// Здесь собрано то, что делает MicroPIDE: линтер под конкретную плату, карта
// пинов, оценка расхода памяти, генерация документации и вспомогательных файлов
// (pins.h, MicroTelem.h, профилировщик loop). Всё считается на сервере офлайн.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AnalyzeFinding, type AnalyzeResult, type PinMapResult, type SketchFile } from './api';
import { Ic } from '../ui/icons';
import { fmt } from '../ui/widgets';

type View = 'issues' | 'pins' | 'profile' | 'docs' | 'gen';

const SEV_LABEL: Record<string, string> = { error: 'ошибка', warn: 'предупреждение', info: 'совет' };
const SEV_ICON: Record<string, string> = { error: 'warn', warn: 'warn', info: 'info' };

export function AnalysisPanel({
  active, files, fqbn, boardLabel, baud, sketchName, onToast, onGoto, onApplyFiles, onAddFile,
}: {
  active: boolean;
  files: SketchFile[];
  fqbn: string;
  boardLabel: string;
  baud: number;
  sketchName: string;
  onToast: (s: string) => void;
  onGoto?: (file: string, line: number) => void;
  onApplyFiles?: (files: SketchFile[]) => void;
  onAddFile?: (path: string, content: string) => void;
}) {
  const [view, setView] = useState<View>('issues');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResult | null>(null);
  const [err, setErr] = useState('');
  const [only, setOnly] = useState<'all' | 'error' | 'warn' | 'info'>('all');
  const [docs, setDocs] = useState('');
  const [genBusy, setGenBusy] = useState('');

  const run = useCallback(async () => {
    if (!files.length) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.analyze({ files, fqbn, baud, name: sketchName });
      setRes(r as AnalyzeResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }, [files, fqbn, baud, sketchName]);

  // при открытии панели и смене платы — считаем сразу; при правках кода — по кнопке
  useEffect(() => { if (active) void run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active, fqbn]);

  const findings = useMemo(() => {
    const list = (res?.findings || res?.issues || []);
    return only === 'all' ? list : list.filter((f) => f.severity === only);
  }, [res, only]);

  const pins = res?.pinMap || res?.pins || null;

  const applyFix = async (f: AnalyzeFinding) => {
    if (!f.fix) return;
    try {
      const r = await api.analyzeFix(files, f.fix, f.file);
      if (r.ok && r.files) {
        onApplyFiles?.(r.files);
        onToast('Правка применена: ' + (r.applied || ''));
        void run();
      } else onToast('Не удалось применить: ' + (r.error || ''));
    } catch (e) {
      onToast('Не удалось применить: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const generateDocs = async () => {
    setGenBusy('docs');
    try {
      const r = await api.analyzeDocs({ files, fqbn, name: sketchName || 'Sketch' });
      setDocs(r.markdown || '');
      setView('docs');
    } catch (e) { onToast('Ошибка: ' + (e instanceof Error ? e.message : String(e))); }
    setGenBusy('');
  };

  const makePinsHeader = async () => {
    setGenBusy('pins');
    try {
      const r = await api.analyzePins({ files, fqbn, name: sketchName || 'Sketch' });
      if (r.ok) { onAddFile?.(r.fileName || 'pins.h', r.content); onToast(`Файл ${r.fileName} добавлен в скетч (пинов: ${r.count})`); }
      else onToast('Ошибка: ' + (r.error || ''));
    } catch (e) { onToast('Ошибка: ' + (e instanceof Error ? e.message : String(e))); }
    setGenBusy('');
  };

  const makeTelemetry = async () => {
    setGenBusy('telem');
    try {
      const r = await api.analyzeTelemetry({ channels: ['value', 'time'], baud: 115200, periodMs: 100 });
      const ex = await api.analyzeTelemetryExample(['value', 'time']);
      if (r.ok) {
        onAddFile?.(r.fileName || 'MicroTelem.h', r.content);
        onToast('MicroTelem.h добавлен: кадр ' + r.frameBytes + ' Б, используйте ' + r.usage.send);
      }
      if (ex?.content) onAddFile?.('TelemDemo.ino', ex.content);
    } catch (e) { onToast('Ошибка: ' + (e instanceof Error ? e.message : String(e))); }
    setGenBusy('');
  };

  const instrument = async () => {
    setGenBusy('prof');
    try {
      const r = await api.analyzeInstrument(files, 1000);
      if (r.ok) { onApplyFiles?.(r.files); onToast(r.note || 'Готово'); setView('gen'); }
      else onToast(r.error || 'Не получилось');
    } catch (e) { onToast('Ошибка: ' + (e instanceof Error ? e.message : String(e))); }
    setGenBusy('');
  };

  const s = res?.summary;

  return (
    <div className="lab">
      <div className="lab-bar">
        <button className={'chip' + (view === 'issues' ? ' active' : '')} onClick={() => setView('issues')}>
          Замечания{s ? ` (${s.errors + s.warnings + s.infos})` : ''}
        </button>
        <button className={'chip' + (view === 'pins' ? ' active' : '')} onClick={() => setView('pins')}>Карта пинов</button>
        <button className={'chip' + (view === 'profile' ? ' active' : '')} onClick={() => setView('profile')}>Профиль</button>
        <button className={'chip' + (view === 'docs' ? ' active' : '')} onClick={() => setView('docs')}>Документация</button>
        <button className={'chip' + (view === 'gen' ? ' active' : '')} onClick={() => setView('gen')}>Генератор</button>
        <div className="lab-sp" />
        {res && (
          <span className={`lab-score ${res.score.overall >= 90 ? 'ok' : res.score.overall >= 70 ? 'mid' : 'bad'}`}
            title={res.score.parts.map((p) => `${p.name}: ${p.score}`).join(' · ')}>
            Оценка {res.score.overall}/100 · {res.score.grade}
          </span>
        )}
        {boardLabel && <span className="badge">{boardLabel}</span>}
        <button className="tb-btn" title="Пересчитать" onClick={() => void run()} disabled={busy}>
          <Ic n="refresh" size={15} />
        </button>
      </div>

      {busy && <div className="lab-note">Считаю…</div>}
      {err && <div className="lab-note err">Сервер недоступен: {err}</div>}
      {!res && !busy && !err && <div className="lab-note">Анализ появится после открытия панели.</div>}

      {view === 'issues' && res && (
        <>
          <div className="lab-filters">
            {(['all', 'error', 'warn', 'info'] as const).map((k) => (
              <button key={k} className={'chip sm' + (only === k ? ' active' : '')} onClick={() => setOnly(k)}>
                {k === 'all' ? 'все' : SEV_LABEL[k]}{k === 'all' ? '' : ` (${k === 'error' ? s?.errors : k === 'warn' ? s?.warnings : s?.infos})`}
              </button>
            ))}
            <span className="lab-hint">
              {s ? `${s.lines} строк · ${s.functions} функций · ${s.includes} include${s.libs.length ? ' · библиотеки: ' + s.libs.join(', ') : ''}` : ''}
            </span>
          </div>
          <div className="lab-list">
            {!findings.length && <div className="lab-ok">Замечаний нет — код чистый.</div>}
            {findings.map((f) => (
              <div key={`${f.id}-${f.file}-${f.line}`} className={'finding ' + f.severity}>
                <span className="finding-ico" title={SEV_LABEL[f.severity]}><Ic n={SEV_ICON[f.severity]} size={15} /></span>
                <div className="finding-body">
                  <div className="finding-head">
                    <b>{f.message}</b>
                  </div>
                  <div className="finding-meta">
                    <button className="link" onClick={() => onGoto?.(f.file, f.line)} title="Перейти к строке">
                      {f.file.split('/').pop()}:{f.line}
                    </button>
                    <span className="mono dim">{f.id}</span>
                  </div>
                  {f.hint && <div className="finding-hint">{f.hint}</div>}
                </div>
                {f.fix && (
                  <button className="btn tiny" onClick={() => void applyFix(f)} title="Применить автоправку">
                    <Ic n="check" size={13} /> Исправить
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {view === 'pins' && pins && <PinMapView pins={pins} />}
      {view === 'pins' && !pins && <div className="lab-note">Нет данных о пинах.</div>}

      {view === 'profile' && res?.profile && <ProfileView profile={res.profile} />}

      {view === 'docs' && (
        <>
          <div className="lab-filters">
            <button className="btn tiny" onClick={() => void generateDocs()} disabled={genBusy === 'docs'}>
              <Ic n="book" size={13} /> Сгенерировать документацию
            </button>
            {docs && (
              <>
                <button className="btn tiny" onClick={() => { void navigator.clipboard.writeText(docs); onToast('Документация скопирована'); }}>
                  <Ic n="copy" size={13} /> Копировать
                </button>
                <button className="btn tiny" onClick={() => { onAddFile?.('README.md', docs); onToast('README.md добавлен в скетч'); }}>
                  <Ic n="saveas" size={13} /> В скетч как README.md
                </button>
              </>
            )}
            <span className="lab-hint">Схема подключения, BOM и таблица пинов — из вашего же кода</span>
          </div>
          {docs ? <pre className="lab-doc">{docs}</pre> : <div className="lab-note">Нажмите «Сгенерировать документацию» — MicroPIDE разберёт скетч и соберёт README со схемой и списком модулей.</div>}
        </>
      )}

      {view === 'gen' && (
        <div className="lab-gen">
          <div className="gen-card">
            <b>pins.h — имена вместо чисел</b>
            <p>Соберёт константы вида <span className="mono">PIN_D13 = 13</span> с пометками ролей (ШИМ/АЦП/прерывание) и проверкой диапазона платы.</p>
            <button className="btn" onClick={() => void makePinsHeader()} disabled={genBusy === 'pins'}>
              <Ic n="filecode" size={14} /> Создать pins.h
            </button>
          </div>
          <div className="gen-card">
            <b>MicroTelem.h — своя телеметрия</b>
            <p>Бинарный кадр <span className="mono">A5 5A … CRC16</span> плюс человекочитаемая строка <span className="mono">#MT</span>. Графики рисуются в панели «Телеметрия».</p>
            <button className="btn" onClick={() => void makeTelemetry()} disabled={genBusy === 'telem'}>
              <Ic n="plot" size={14} /> MicroTelem.h + пример
            </button>
          </div>
          <div className="gen-card">
            <b>Профилировщик loop()</b>
            <p>Оборачивает <span className="mono">loop()</span> и печатает строки <span className="mono">#PROF</span>: сколько микросекунд занимает итерация, сколько осталось ОЗУ.</p>
            <button className="btn" onClick={() => void instrument()} disabled={genBusy === 'prof'}>
              <Ic n="bolt" size={14} /> Инструментировать скетч
            </button>
          </div>
          <div className="gen-card">
            <b>Карта памяти после сборки</b>
            <p>Соберите скетч — затем «Инструменты → Карта памяти»: разбор символов .elf по секциям (флеш/ОЗУ/rodata).</p>
            <button className="btn" onClick={() => { void generateDocs(); }} disabled={genBusy === 'docs'}>
              <Ic n="info" size={14} /> Собрать документ о скетче
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- карта пинов

export function PinMapView({ pins }: { pins: PinMapResult }) {
  const [sel, setSel] = useState<number | null>(null);
  const rec = pins.pins.find((p) => p.pin === sel) || null;
  return (
    <div className="pins">
      <div className="pins-board">
        <div className="pins-head">
          <b>{pins.board?.name || pins.fqbn}</b>
          <span className="dim">{pins.board?.mcu}</span>
          <span className="sp" />
          <span className="badge">занято {pins.stats.used}</span>
          <span className="badge">свободно {pins.stats.free}</span>
          {pins.stats.conflicts > 0 && <span className="badge bad">конфликтов {pins.stats.conflicts}</span>}
        </div>
        <div className="pins-grid">
          {Array.from({ length: Math.max(...pins.pins.map((p) => p.pin), 0) + 1 }, (_, i) => i)
            .filter((i) => (pins.board && i <= 79) || pins.pins.some((p) => p.pin === i))
            .map((i) => {
              const p = pins.pins.find((x) => x.pin === i);
              const used = !!p;
              const bad = !!p?.conflicts.length;
              return (
                <button
                  key={i}
                  className={'pin' + (used ? ' used' : '') + (bad ? ' bad' : '') + (sel === i ? ' sel' : '') + (p?.pwm ? ' pwm' : '')}
                  title={p ? `${p.label}: ${p.roles.join(', ')}${p.conflicts.length ? ' · ' + p.conflicts.join('; ') : ''}` : `D${i} свободен`}
                  onClick={() => setSel(i)}
                >
                  {i}
                </button>
              );
            })}
        </div>
        <div className="pins-legend">
          <span><i className="sw used" /> занят</span>
          <span><i className="sw pwm" /> ШИМ</span>
          <span><i className="sw bad" /> конфликт</span>
          <span className="dim">свободные ШИМ: {pins.stats.pwmFree.join(', ') || '—'} · свободные АЦП: {pins.stats.adcFree.join(', ') || '—'}</span>
        </div>
      </div>
      <div className="pins-list">
        {rec ? (
          <div className="pin-card">
            <div className="pin-card-head"><b>{rec.label}</b><span className="dim">пин {rec.pin}</span></div>
            <table className="tbl">
              <tbody>
                <tr><td>Роли</td><td>{rec.roles.join(', ') || '—'}</td></tr>
                <tr><td>Функции</td><td className="mono">{rec.funcs.join(', ') || '—'}</td></tr>
                <tr><td>Возможности</td><td>{[rec.pwm && 'ШИМ', rec.adc && 'АЦП', rec.interrupt && 'прерывание', rec.inputOnly && 'только вход', rec.flash && 'флеш-память', rec.led && 'светодиод'].filter(Boolean).join(', ') || 'обычный цифровой'}</td></tr>
                {rec.reserved && <tr><td>На плате</td><td>{rec.reserved}</td></tr>}
                {rec.notes.length > 0 && <tr><td>Заметки</td><td>{rec.notes.join('; ')}</td></tr>}
                {rec.conflicts.length > 0 && <tr><td className="bad">Конфликты</td><td className="bad">{rec.conflicts.join('; ')}</td></tr>}
                <tr><td>Где в коде</td><td className="mono">{rec.lines.slice(0, 6).join(', ') || '—'}</td></tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="lab-note">Выберите пин слева — покажу роли, возможности и где он используется.</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- профиль

export function ProfileView({ profile }: { profile: any }) {
  const ram = profile.board?.ram || 0;
  const used = profile.globalsBytes || 0;
  const pct = ram ? Math.min(100, Math.round((used / ram) * 100)) : 0;
  return (
    <div className="prof">
      <div className="prof-cards">
        <div className="gen-card">
          <b>Глобальные данные</b>
          <p className="big">{fmt(used)} Б {ram ? <span className="dim">из {fmt(ram)} Б ОЗУ ({pct}%)</span> : null}</p>
          <div className="bar"><span style={{ width: pct + '%' }} className={pct > 70 ? 'bad' : pct > 45 ? 'mid' : ''} /></div>
        </div>
        <div className="gen-card">
          <b>Оценка флеш</b>
          <p className="big">{fmt(profile.flashEstimate)} Б <span className="dim">(грубо, до сборки)</span></p>
        </div>
        <div className="gen-card">
          <b>Размер кода</b>
          <p className="big">{fmt(profile.lines)} строк <span className="dim">· функций {profile.functions}</span></p>
        </div>
      </div>
      <div className="prof-cols">
        <div>
          <div className="side-h">Самые большие функции</div>
          <table className="tbl">
            <thead><tr><th>Функция</th><th>Строк</th><th>Стек</th><th>Тяжёлое</th></tr></thead>
            <tbody>
              {(profile.heaviest || []).map((f: any, i: number) => (
                <tr key={i}>
                  <td className="mono">{f.name}</td>
                  <td>{f.lines}</td>
                  <td>{f.stackBytes ? fmt(f.stackBytes) + ' Б' : '—'}</td>
                  <td className="dim">{(f.heavy || []).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="side-h">Глобальные буферы</div>
          <table className="tbl">
            <thead><tr><th>Имя</th><th>Тип</th><th>Байт</th></tr></thead>
            <tbody>
              {(profile.globals || []).slice(0, 20).map((g: any, i: number) => (
                <tr key={i}><td className="mono">{g.name}</td><td>{g.type}{g.count > 1 ? `[${g.count}]` : ''}</td><td>{fmt(g.bytes)}</td></tr>
              ))}
              {!(profile.globals || []).length && <tr><td colSpan={3} className="dim">глобальных буферов нет</td></tr>}
            </tbody>
          </table>
          <div className="side-h">Советы</div>
          <ul className="advice">{(profile.advice || []).map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}
