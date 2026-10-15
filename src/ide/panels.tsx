// Боковая панель MicroPIDE: Скетчбук, Примеры, Библиотеки, Платы.
// Каждый раздел работает напрямую с API сервера (server/*.mjs).
import { useCallback, useEffect, useState } from 'react';
import {
  api, type CliInfo, type Core, type LibInfo, type SketchInfo, type SketchFile,
} from './api';
import { EXAMPLE_GROUPS } from './examples';
import { Ic } from '../ui/icons';
import { ConfirmDialog, fmt } from '../ui/widgets';

export type SideTab = 'sketchbook' | 'examples' | 'libs' | 'boards';

export const SIDE_TABS: { id: SideTab; icon: string; label: string }[] = [
  { id: 'sketchbook', icon: 'sketchbook', label: 'Скетчи' },
  { id: 'examples', icon: 'examples', label: 'Примеры' },
  { id: 'libs', icon: 'lib', label: 'Библиотеки' },
  { id: 'boards', icon: 'board', label: 'Платы' },
];

// ---------------------------------------------------------------- скетчбук

export function SketchbookPanel({
  active, currentName, onOpen, onNew, onDelete,
}: {
  active: boolean;
  currentName: string;
  onOpen: (name: string) => void;
  onNew: () => void;
  onDelete: (name: string) => void;
}) {
  const [list, setList] = useState<SketchInfo[]>([]);
  const [err, setErr] = useState('');

  const reload = useCallback(async () => {
    try {
      const r = await api.sketches();
      setList(r.sketches || []);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { if (active) void reload(); }, [active, reload]);

  return (
    <>
      <button className="btn primary" style={{ margin: '2px 2px 6px', justifyContent: 'center' }} onClick={onNew}>
        <Ic n="new" size={14} />Новый скетч
      </button>
      {err && <div className="side-note" style={{ color: 'var(--danger-ink)' }}>{err}</div>}
      {list.length === 0 && !err && <div className="side-note">Скетчбук пуст. Сохраните скетч — он появится здесь (кнопка «Сохранить»).</div>}
      {list.map((s) => (
        <div key={s.name} className={'item' + (s.name === currentName ? ' active' : '')} onClick={() => onOpen(s.name)} title={`Открыть «${s.name}»`}>
          <span className="ic"><Ic n="filecode" size={15} /></span>
          <span className="nm">
            {s.name}
            <span className="sub">{s.files.length} файл(ов) · {new Date(s.mtime).toLocaleString()}</span>
          </span>
          <span className="act" onClick={(e) => { e.stopPropagation(); onDelete(s.name); }} title="Удалить скетч">
            <Ic n="trash" size={14} />
          </span>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- примеры

export function ExamplesPanel({
  cli, onOpen, onToast,
}: {
  cli: CliInfo | null;
  onOpen: (name: string, files: SketchFile[]) => void;
  onToast: (s: string) => void;
}) {
  const [cliGroups, setCliGroups] = useState<{ name: string; examples: { name: string; path: string; sketches: { name: string; path: string }[] }[] }[]>([]);
  const [cliErr, setCliErr] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!cli?.ok) return;
    api.examples().then((r) => {
      if (r.ok) setCliGroups(r.groups.slice(0, 40));
      else setCliErr(r.err || 'не удалось получить примеры');
    }).catch(() => setCliErr('не удалось получить примеры'));
  }, [cli?.ok]);

  const openBuiltin = (name: string, code: string) => {
    onOpen(name, [{ path: name + '.ino', content: code }]);
  };

  const openCli = async (path: string, name: string) => {
    try {
      const r = await api.exampleGet(path);
      if (r.ok !== false && r.files?.length) onOpen(r.name || name, r.files);
      else onToast('Не удалось открыть пример: ' + (r.error || name));
    } catch {
      onToast('Не удалось открыть пример: ' + name);
    }
  };

  const q = filter.trim().toLowerCase();
  return (
    <>
      <div className="search-row">
        <input className="txt" placeholder="Поиск примера…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="side-h">Встроенные</div>
      {EXAMPLE_GROUPS.map((g) => (
        <div key={g.name}>
          <div className="side-h" style={{ opacity: .8 }}>{g.name}</div>
          {g.examples
            .filter((ex) => !q || ex.name.toLowerCase().includes(q) || ex.hint.toLowerCase().includes(q))
            .map((ex) => (
              <button key={ex.name} className="item" onClick={() => openBuiltin(ex.name.replace(/[^\w]/g, ''), ex.code)} title={ex.hint}>
                <span className="ic"><Ic n="filecode" size={15} /></span>
                <span className="nm">{ex.name}<span className="sub">{ex.hint}</span></span>
              </button>
            ))}
        </div>
      ))}
      {cli?.ok && (
        <>
          <div className="side-h">Из плат и библиотек</div>
          {cliErr && <div className="side-note">{cliErr}</div>}
          {!cliErr && cliGroups.length === 0 && <div className="side-note">Загрузка… (или примеров нет)</div>}
          {cliGroups.filter((g) => !q || g.name.toLowerCase().includes(q)).map((g) => (
            <div key={g.name}>
              <div className="side-h" style={{ opacity: .8 }}>{g.name}</div>
              {g.examples.slice(0, 12).map((ex) => (
                <button key={ex.path} className="item" onClick={() => void openCli(ex.path, ex.name)} title={ex.path}>
                  <span className="ic"><Ic n="file" size={15} /></span>
                  <span className="nm">{ex.name}</span>
                </button>
              ))}
            </div>
          ))}
        </>
      )}
      {!cli?.ok && <div className="side-note">Примеры плат и библиотек появятся, когда будет установлен arduino-cli.</div>}
    </>
  );
}

// ---------------------------------------------------------------- библиотеки

export function LibsPanel({
  cli, onToast, refreshKey,
}: {
  cli: CliInfo | null;
  onToast: (s: string) => void;
  refreshKey: number;
}) {
  const [tab, setTab] = useState<'installed' | 'search'>('installed');
  const [libs, setLibs] = useState<LibInfo[]>([]);
  const [found, setFound] = useState<LibInfo[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<string>('');

  const reloadInstalled = useCallback(async () => {
    if (!cli?.ok) return;
    const r = await api.libs();
    if (r.ok) setLibs(r.libs); else setErr(r.err || 'ошибка');
  }, [cli?.ok]);

  useEffect(() => { void reloadInstalled(); }, [reloadInstalled, refreshKey]);

  const doSearch = useCallback(async (s: string) => {
    if (!cli?.ok) return;
    setErr('');
    const r = await api.libsSearch(s);
    if (r.ok) setFound(r.libs); else setErr(r.err || 'ошибка поиска');
  }, [cli?.ok]);

  useEffect(() => {
    if (tab !== 'search' || !cli?.ok) return;
    const t = setTimeout(() => void doSearch(q), 400);
    return () => clearTimeout(t);
  }, [q, tab, doSearch, cli?.ok]);

  const install = async (name: string) => {
    setBusy(name);
    onToast(`Устанавливаю библиотеку ${name}…`);
    await api.libInstall(name, (line) => onToast(line)).catch(() => {});
    setBusy('');
    void reloadInstalled();
  };

  const remove = async (name: string) => {
    setBusy(name);
    try { await api.libRemove(name); onToast(`Библиотека ${name} удалена`); } catch { onToast('Не удалось удалить'); }
    setBusy('');
    setConfirm('');
    void reloadInstalled();
  };

  if (!cli?.ok) {
    return (
      <div>
        <div className="side-note">Для менеджера библиотек нужен arduino-cli. Установите его в разделе «Платы».</div>
      </div>
    );
  }

  return (
    <>
      <div className="row" style={{ margin: '0 0 6px' }}>
        <button className={'btn tiny' + (tab === 'installed' ? ' on' : '')} onClick={() => setTab('installed')}>Установленные</button>
        <button className={'btn tiny' + (tab === 'search' ? ' on' : '')} onClick={() => setTab('search')}>Поиск в индексе</button>
      </div>
      {tab === 'search' && (
        <div className="search-row">
          <input className="txt" placeholder="Например: Servo, IRremote…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {err && <div className="side-note" style={{ color: 'var(--danger-ink)' }}>{err}</div>}
      {tab === 'installed' && libs.length === 0 && <div className="side-note">Библиотек пока нет. Поищите в индексе и установите.</div>}
      {(tab === 'installed' ? libs : found).map((l) => (
        <div key={l.name} className="card">
          <b>{l.name} {l.version && <span className="badge gray">{l.version}</span>}</b>
          {l.sentence && <span className="meta">{l.sentence}</span>}
          <div className="foot">
            <span className="meta">{l.author}</span>
            <span style={{ flex: 1 }} />
            {tab === 'installed' ? (
              <button className="btn tiny danger" disabled={busy === l.name} onClick={() => setConfirm(l.name)}>Удалить</button>
            ) : (
              <button className="btn tiny primary" disabled={busy === l.name} onClick={() => void install(l.name)}>
                {busy === l.name ? 'Ставлю…' : 'Установить'}
              </button>
            )}
          </div>
        </div>
      ))}
      {confirm && (
        <ConfirmDialog
          title="Удалить библиотеку?"
          text={`Библиотека «${confirm}» будет удалена со скетчбука.`}
          ok="Удалить" danger
          onOk={() => void remove(confirm)}
          onClose={() => setConfirm('')}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- платы

export function BoardsPanel({
  cli, onInstallCli, onPickBoard, fqbn, onToast, refreshKey,
}: {
  cli: CliInfo | null;
  onInstallCli: () => void;
  onPickBoard: (label: string, fqbn: string) => void;
  fqbn: string;
  onToast: (s: string) => void;
  refreshKey: number;
}) {
  const [tab, setTab] = useState<'installed' | 'search'>('installed');
  const [cores, setCores] = useState<Core[]>([]);
  const [found, setFound] = useState<Core[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<string>('');

  const reloadInstalled = useCallback(async () => {
    if (!cli?.ok) return;
    const r = await api.cores();
    if (r.ok) setCores(r.cores); else setErr(r.err || 'ошибка');
  }, [cli?.ok]);

  useEffect(() => { void reloadInstalled(); }, [reloadInstalled, refreshKey]);

  useEffect(() => {
    if (tab !== 'search' || !cli?.ok) return;
    const t = setTimeout(async () => {
      setErr('');
      const r = await api.coresSearch(q);
      if (r.ok) setFound(r.cores); else setErr(r.err || 'ошибка поиска');
    }, 500);
    return () => clearTimeout(t);
  }, [q, tab, cli?.ok]);

  const install = async (id: string) => {
    setBusy(id);
    onToast(`Устанавливаю платформу ${id}…`);
    await api.coreInstall(id, (line) => onToast(line)).catch(() => {});
    setBusy('');
    void reloadInstalled();
  };

  const remove = async (id: string) => {
    setBusy(id);
    try { await api.coreRemove(id); onToast(`Платформа ${id} удалена`); } catch { onToast('Не удалось удалить'); }
    setBusy('');
    setConfirm('');
    void reloadInstalled();
  };

  if (!cli?.ok) {
    return (
      <div>
        <div className="side-note">
          arduino-cli не найден — без него нельзя ни выбрать плату, ни прошить.
          Нажмите «Установить» — среда скачает утилиту с GitHub в свой каталог данных.
        </div>
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onInstallCli}>
          <Ic n="down" size={14} />Установить arduino-cli
        </button>
        <div className="side-note" style={{ marginTop: 8 }}>
          Версия из каталога: {cli ? '' : '…'}<span className="mono">{cli?.dataDir}</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="side-note" style={{ paddingTop: 0 }}>
        cli <b>{cli.version}</b>{cli.path ? ` · ${cli.path}` : ''}
      </div>
      <div className="row" style={{ margin: '0 0 6px' }}>
        <button className={'btn tiny' + (tab === 'installed' ? ' on' : '')} onClick={() => setTab('installed')}>Установленные</button>
        <button className={'btn tiny' + (tab === 'search' ? ' on' : '')} onClick={() => setTab('search')}>Менеджер плат</button>
      </div>
      {tab === 'search' && (
        <div className="search-row">
          <input className="txt" placeholder="Например: avr, esp32, samd…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {err && <div className="side-note" style={{ color: 'var(--danger-ink)' }}>{err}</div>}
      {tab === 'installed' && cores.length === 0 && <div className="side-note">Платформы не установлены. Откройте «Менеджер плат» и поставьте, например, «Arduino AVR».</div>}
      {(tab === 'installed' ? cores : found).map((c) => (
        <div key={c.id} className="card">
          <b>{c.name || c.id} <span className="badge gray">{c.id}</span></b>
          <span className="meta">
            {tab === 'installed'
              ? `версия ${c.version}${c.latest && c.latest !== c.version ? ` (доступна ${c.latest})` : ''}`
              : `в индексе: ${c.latest || '?'}`}
            {c.boards?.length ? ` · платы: ${c.boards.slice(0, 4).map((b) => (typeof b === 'string' ? b : b.name)).join(', ')}` : ''}
          </span>
          <div className="foot">
            {tab === 'installed' && c.boards?.length > 0 && (
              <span className="meta">{c.boards.length} плат(ы) для выбора</span>
            )}
            <span style={{ flex: 1 }} />
            {tab === 'installed' ? (
              <button className="btn tiny danger" disabled={busy === c.id} onClick={() => setConfirm(c.id)}>Удалить</button>
            ) : (
              <button className="btn tiny primary" disabled={busy === c.id} onClick={() => void install(c.id)}>
                {busy === c.id ? 'Ставлю…' : 'Установить'}
              </button>
            )}
          </div>
          {tab === 'installed' && c.boards?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
              {c.boards.map((b) => (
                <button
                  key={b.fqbn || b.name}
                  className={'item' + (b.fqbn === fqbn ? ' active' : '')}
                  style={{ padding: '4px 6px' }}
                  onClick={() => onPickBoard(b.name, b.fqbn)}
                  title={b.fqbn}
                >
                  <span className="ic"><Ic n="board" size={14} /></span>
                  <span className="nm">{b.name || b.fqbn}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {confirm && (
        <ConfirmDialog
          title="Удалить платформу?"
          text={`Платформа «${confirm}» и её платы будут удалены. Скетчи останутся.`}
          ok="Удалить" danger
          onOk={() => void remove(confirm)}
          onClose={() => setConfirm('')}
        />
      )}
    </>
  );
}
