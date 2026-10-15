// Панель «Склад» — автономный режим MicroPIDE: всё своё, без серверов Arduino.
//
// Показывает, что среда умеет без интернета и без arduino-cli, чего не хватает
// для сборки под выбранную плату, позволяет положить архивы ядер/тулчейнов прямо
// в браузере, посмотреть свои индексы и зеркала, а также дополнить базу плат.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BoardCatalogItem } from './api';
import { Ic } from '../ui/icons';
import { fmt } from '../ui/widgets';

const kb = (n: number) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' МБ' : n > 1024 ? (n / 1024).toFixed(0) + ' КБ' : n + ' Б');

export function VaultPanel({
  active, fqbn, onPickBoard, onToast, onLog,
}: {
  active: boolean;
  fqbn: string;
  onPickBoard: (label: string, fqbn: string) => void;
  onToast: (s: string) => void;
  onLog: (s: string) => void;
}) {
  const [status, setStatus] = useState<any>(null);
  const [tools, setTools] = useState<any[]>([]);
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [vault, setVault] = useState<any>(null);
  const [boards, setBoards] = useState<BoardCatalogItem[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [view, setView] = useState<'state' | 'boards' | 'vault'>('state');
  const [newBoard, setNewBoard] = useState({ fqbn: '', name: '', mcu: '', flash: '', ram: '' });
  const [detect, setDetect] = useState({ vid: '', pid: '', name: '' });
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setBusy('load');
    try {
      const [s, t, p, v, b] = await Promise.all([
        api.offlineStatus(), api.offlineTools(), api.offlinePlatforms(), api.offlineVault(), api.boardsCatalog(''),
      ]);
      setStatus(s); setTools(t.tools || []); setPlatforms(p.platforms || []); setVault(v); setBoards(b.boards || []);
    } catch (e) {
      onToast('Сервер недоступен: ' + (e instanceof Error ? e.message : String(e)));
    }
    setBusy('');
  }, [onToast]);

  useEffect(() => { if (active) void reload(); }, [active, reload]);

  const uploadFile = async (fl: File | null) => {
    if (!fl) return;
    setBusy('upload');
    onLog(`— Загрузка на склад: ${fl.name} (${kb(fl.size)}) —`);
    try {
      const r = await api.offlineUpload(fl, { autoImport: true }, (l) => onLog(l));
      onToast(r?.ok ? `На складе: ${fl.name}${r.imported ? ' · установлено' : ''}` : 'Не получилось: ' + (r?.error || ''));
      await reload();
    } catch (e) {
      onToast('Ошибка загрузки: ' + (e instanceof Error ? e.message : String(e)));
    }
    setBusy('');
  };

  const installItem = async (file: string, type: string) => {
    setBusy(file);
    try {
      const r = await api.offlineImport({ file, type }, (l) => onLog(l));
      onToast(r?.ok ? `${file}: установлено` : 'Ошибка: ' + (r?.error || ''));
      await reload();
    } catch (e) { onToast(String(e)); }
    setBusy('');
  };

  const downloadPlatform = async (id: string) => {
    setBusy(id);
    onLog(`— Скачиваю платформу ${id} —`);
    try {
      const r = await api.offlineDownload({ kind: 'platform', id, import: true }, (l) => onLog(l));
      onToast(r?.ok ? `${id}: скачано и установлено` : 'Не скачалось: ' + (r?.error || ''));
      await reload();
    } catch (e) { onToast(String(e)); }
    setBusy('');
  };

  const writeIndexes = async () => {
    try {
      const r = await api.offlineIndexes();
      onToast(`Свои индексы: ${r.platforms} платформ, ${r.libraries} библиотек`);
    } catch (e) { onToast(String(e)); }
  };

  const defineBoard = async () => {
    if (!newBoard.fqbn || !newBoard.name) { onToast('Нужны FQBN и имя платы'); return; }
    try {
      const r = await api.boardDefine({
        fqbn: newBoard.fqbn, name: newBoard.name, mcu: newBoard.mcu || 'unknown',
        flash: Number(newBoard.flash) || undefined, ram: Number(newBoard.ram) || undefined,
      });
      onToast(r.ok ? 'Плата добавлена в базу: ' + newBoard.fqbn : 'Ошибка: ' + r.error);
      setNewBoard({ fqbn: '', name: '', mcu: '', flash: '', ram: '' });
      await reload();
    } catch (e) { onToast(String(e)); }
  };

  const doDetect = async () => {
    try {
      const r = await api.boardDetect(detect.vid, detect.pid, detect.name);
      if (r.ok && r.board) { onPickBoard(r.board.name, r.board.fqbn); onToast(`Определил: ${r.board.name} (${r.note})`); }
      else onToast('Не узнал плату — добавьте её в базу вручную');
    } catch (e) { onToast(String(e)); }
  };

  const filtered = boards.filter((b) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return b.fqbn.toLowerCase().includes(s) || b.name.toLowerCase().includes(s) || String(b.mcu).toLowerCase().includes(s);
  });

  const caps = status?.can || {};
  const score = status?.score ?? null;

  return (
    <div className="vault">
      <div className="lab-bar">
        <button className={'chip sm' + (view === 'state' ? ' active' : '')} onClick={() => setView('state')}>Состояние</button>
        <button className={'chip sm' + (view === 'boards' ? ' active' : '')} onClick={() => setView('boards')}>База плат</button>
        <button className={'chip sm' + (view === 'vault' ? ' active' : '')} onClick={() => setView('vault')}>Склад</button>
        <div className="lab-sp" />
        <button className="tb-btn" title="Обновить" onClick={() => void reload()} disabled={busy === 'load'}><Ic n="refresh" size={15} /></button>
      </div>

      {view === 'state' && (
        <>
          {score != null && (
            <div className="gen-card">
              <b>Автономность {score}%</b>
              <div className="bar"><span style={{ width: score + '%' }} className={score > 70 ? '' : score > 40 ? 'mid' : 'bad'} /></div>
              <p className="dim small">{status?.level ? `уровень: ${status.level}` : ''}</p>
            </div>
          )}
          <div className="chips">
            <span className={'chip xs' + (caps.buildAvr ? ' ok' : '')}>AVR сборка</span>
            <span className={'chip xs' + (caps.buildEsp ? ' ok' : '')}>ESP сборка</span>
            <span className={'chip xs' + (caps.buildArm ? ' ok' : '')}>ARM сборка</span>
            <span className={'chip xs' + (caps.uploadAvr ? ' ok' : '')}>avrdude</span>
            <span className={'chip xs' + (caps.simulate ? ' ok' : '')}>симулятор</span>
          </div>

          <div className="side-h">Что умеем офлайн</div>
          <div className="checks">
            {(status?.checks || []).map((c: any, i: number) => (
              <div key={i} className={'check' + (c.ok ? ' ok' : '')}>
                <Ic n={c.ok ? 'check' : 'info'} size={13} />
                <div>
                  <b>{c.what}</b>
                  <div className="dim small">{c.how}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="side-h">Инструменты</div>
          <div className="tool-list">
            {tools.map((t) => (
              <div key={t.name} className={'tool' + (t.ok ? ' ok' : '')} title={t.path || t.hint}>
                <span className="tool-name mono">{t.name}</span>
                <span className="dim small">{t.ok ? (t.version || t.from || 'есть') : 'нет'}</span>
              </div>
            ))}
          </div>

          <div className="side-h">Ядра из каталога</div>
          <div className="plat-list">
            {platforms.map((p) => (
              <div key={p.id} className="plat">
                <div className="plat-head">
                  <b>{p.name}</b>
                  <span className="dim">{p.version}</span>
                </div>
                <div className="plat-meta">
                  <span className={'badge sm' + (p.installed ? ' ok' : '')}>{p.installed ? 'ядро есть' : 'ядра нет'}</span>
                  {p.canBuild ? <span className="badge sm ok">сборка возможна</span> : <span className="badge sm">нужен тулчейн</span>}
                  <span className="dim">{p.sizeText}</span>
                </div>
                <div className="row">
                  <button className="btn tiny" disabled={busy === p.id} onClick={() => void downloadPlatform(p.id)}>
                    <Ic n="down" size={12} /> Скачать (если есть сеть)
                  </button>
                  <button className="btn tiny" onClick={() => void api.offlineUrls(p.id).then((r) => {
                    void navigator.clipboard.writeText((r.platform || []).join('\n'));
                    onToast('Ссылки скопированы — можно скачать вручную и положить на склад');
                  })}>
                    <Ic n="copy" size={12} /> Ссылки
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="row">
            <button className="btn tiny" onClick={() => void writeIndexes()}>
              <Ic n="inventory" size={12} /> Записать свои индексы
            </button>
          </div>
          {status?.indexes && (
            <div className="hint small">
              Индексы: <span className="mono">{status.indexes.packageIndex}</span><br />
              <span className="mono">{status.indexes.libraryIndex}</span>
            </div>
          )}
        </>
      )}

      {view === 'boards' && (
        <>
          <div className="search-row">
            <input className="txt" placeholder="поиск: uno, esp32, atmega…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="side-note">База плат встроена: {boards.length} плат. Анализ пинов, ШИМ и прерываний работает даже без установленных ядер.</div>
          <div className="board-list">
            {filtered.slice(0, 60).map((b) => (
              <div key={b.fqbn} className={'vboard' + (b.fqbn === fqbn ? ' sel' : '')}>
                <div className="vboard-head">
                  <b>{b.name}</b>
                  {b.simulator && <span className="badge sm ok" title="Можно собрать под компьютер и проверить логику">сим</span>}
                </div>
                <div className="dim small mono">{b.fqbn}</div>
                <div className="dim small">{b.mcu} · флеш {b.flash ? fmt(Math.round(b.flash / 1024)) + ' КБ' : '—'} · ОЗУ {b.ram ? fmt(Math.round(b.ram / 1024)) + ' КБ' : '—'} · ШИМ {b.pwm ?? 0} · АЦП {b.analog ?? 0}</div>
                <div className="row">
                  <button className="btn tiny primary" onClick={() => onPickBoard(b.name, b.fqbn)}>Выбрать</button>
                  {(b.hints || []).length > 0 && <span className="dim small" title={(b.hints || []).join('; ')}>i</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="side-h">Своя плата в базу</div>
          <div className="def-form">
            <input className="txt" placeholder="FQBN: my:core:board" value={newBoard.fqbn} onChange={(e) => setNewBoard({ ...newBoard, fqbn: e.target.value })} />
            <input className="txt" placeholder="Название" value={newBoard.name} onChange={(e) => setNewBoard({ ...newBoard, name: e.target.value })} />
            <input className="txt" placeholder="МК (например ATmega328P)" value={newBoard.mcu} onChange={(e) => setNewBoard({ ...newBoard, mcu: e.target.value })} />
            <div className="row">
              <input className="txt" placeholder="флеш, Б" value={newBoard.flash} onChange={(e) => setNewBoard({ ...newBoard, flash: e.target.value })} />
              <input className="txt" placeholder="ОЗУ, Б" value={newBoard.ram} onChange={(e) => setNewBoard({ ...newBoard, ram: e.target.value })} />
            </div>
            <button className="btn tiny" onClick={() => void defineBoard()}><Ic n="new" size={12} /> Добавить плату</button>
          </div>
          <div className="side-h">Определить плату по USB</div>
          <div className="def-form">
            <div className="row">
              <input className="txt" placeholder="VID (2341)" value={detect.vid} onChange={(e) => setDetect({ ...detect, vid: e.target.value })} />
              <input className="txt" placeholder="PID (0043)" value={detect.pid} onChange={(e) => setDetect({ ...detect, pid: e.target.value })} />
            </div>
            <input className="txt" placeholder="или имя устройства" value={detect.name} onChange={(e) => setDetect({ ...detect, name: e.target.value })} />
            <button className="btn tiny" onClick={() => void doDetect()}><Ic n="plug" size={12} /> Определить</button>
          </div>
        </>
      )}

      {view === 'vault' && (
        <>
          <div className="side-note">
            Положите сюда архивы: ядро платы (с <span className="mono">platform.txt</span>), тулчейн (avr-gcc, avrdude…)
            или библиотеку. MicroPIDE распознает вид и установит сам — интернет не нужен.
          </div>
          <input
            ref={fileRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => void uploadFile(e.target.files?.[0] || null)}
          />
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy === 'upload'}>
            <Ic n="down" size={14} /> {busy === 'upload' ? 'Загружаю…' : 'Загрузить архив в браузере'}
          </button>
          <div className="hint small">Либо скопируйте файл на диск и укажите имя ниже — путь: <span className="mono">{vault?.dirs?.archives || ''}</span></div>

          <div className="side-h">На складе ({(vault?.items || []).length})</div>
          <div className="vault-list">
            {!(vault?.items || []).length && <div className="lab-note">Пока пусто.</div>}
            {(vault?.items || []).map((it: any) => (
              <div key={it.file} className="vitem">
                <div className="vitem-head">
                  <b className="mono small" title={it.file}>{it.name || it.file}</b>
                  <span className="badge sm">{it.unpacked ? 'уже распаковано' : it.kind === 'meta' ? 'метаданные' : it.kind === 'core' ? 'ядро' : it.kind === 'lib' ? 'библиотека' : it.kind === 'tool' ? 'тулчейн' : 'архив'}</span>
                </div>
                <div className="dim small">
                  {it.where ? it.where + ' · ' : ''}{it.sizeText || (it.size ? kb(it.size) : '')}
                  {it.entries ? ` · файлов ${it.entries}` : ''}
                  {it.detected?.boards ? ` · плат ${it.detected.boards}` : ''}
                  {it.detected?.version ? ` · ${it.detected.version}` : ''}
                  {it.error ? ' · ⚠ ' + String(it.error).slice(0, 60) : ''}
                </div>
                <div className="row">
                  {!it.unpacked && it.kind !== 'meta' && (
                    <button className="btn tiny" disabled={busy === it.file} onClick={() => void installItem(it.name || it.file, it.kind === 'unknown' ? '' : it.kind)}>
                      <Ic n="inventory" size={12} /> Установить
                    </button>
                  )}
                  <button className="btn tiny" onClick={() => void api.offlineInspect(it.name || it.file).then((r) => {
                    onToast(r.ok ? `${r.info?.kind || 'архив'}: записей ${r.info?.count}, внутри — ${(r.info?.dirs || []).slice(0, 2).join(', ')}` : 'Не разобрать: ' + r.error);
                  })}>
                    <Ic n="info" size={12} /> Разобрать
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="side-h">Зеркала и автономность</div>
          <div className="row">
            <button className="btn tiny" onClick={() => void api.offlineMirrors().then((r) => {
              void navigator.clipboard.writeText(JSON.stringify(r.mirrors, null, 2));
              onToast('Зеркала скопированы в буфер');
            })}>
              <Ic n="copy" size={12} /> Показать зеркала
            </button>
            <button className="btn tiny" onClick={() => void api.offlineSetMirrors({}).then(() => onToast('Настройки склада обновлены'))}>
              <Ic n="refresh" size={12} /> Сбросить настройки
            </button>
          </div>
          {vault?.note && <div className="hint small">{vault.note}</div>}
        </>
      )}
    </div>
  );
}
