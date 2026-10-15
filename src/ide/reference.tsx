// Панель «Справка» — свой офлайн-справочник по Arduino API и приёмам MicroPIDE.
//
// Никаких интернетов и вики: справочник лежит внутри MicroPIDE (server/reference.mjs),
// знает про наши уникальные вещи (MicroTelem, .mps-тесты, карта пинов, склад) и
// умеет вставлять готовый фрагмент кода прямо в редактор.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ReferenceEntry, type ReferenceResult } from './api';
import { Ic } from '../ui/icons';

const KIND_LABEL: Record<string, string> = {
  function: 'функция', method: 'метод', constant: 'константа', type: 'тип',
  library: 'библиотека', macro: 'макрос', micropide: 'MicroPIDE',
};

export function ReferencePanel({
  active, onInsert, onToast,
}: {
  active: boolean;
  onInsert: (code: string) => void;
  onToast: (s: string) => void;
}) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [data, setData] = useState<ReferenceResult | null>(null);
  const [sel, setSel] = useState<ReferenceEntry | null>(null);
  const [snippet, setSnippet] = useState<any>(null);

  const search = useCallback(async (query: string, k: string) => {
    try {
      const r = await api.reference(query, k || undefined);
      setData(r);
      if (sel && !r.entries.some((e) => e.name === sel.name)) setSel(null);
    } catch (e) {
      onToast('Сервер недоступен: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [onToast, sel]);

  useEffect(() => { if (active) void search('', ''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active]);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => void search(q, kind), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kind]);

  const open = async (e: ReferenceEntry) => {
    setSel(e);
    setSnippet(null);
    try { setSnippet(await api.referenceSnippet(e.name)); } catch { /* ignore */ }
  };

  const kinds = useMemo(() => {
    const set = new Set((data?.entries || []).map((e) => e.kind));
    return [...set];
  }, [data]);

  const insert = (code: string) => {
    if (!code) return;
    onInsert(code);
    onToast('Вставлено в редактор');
  };

  return (
    <div className="refp">
      <div className="search-row">
        <input
          className="txt"
          placeholder="pinMode, Serial, analogWrite…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>
      <div className="chips">
        <button className={'chip xs' + (kind === '' ? ' active' : '')} onClick={() => setKind('')}>всё</button>
        {kinds.map((k) => (
          <button key={k} className={'chip xs' + (kind === k ? ' active' : '')} onClick={() => setKind(k)}>{KIND_LABEL[k] || k}</button>
        ))}
      </div>
      <div className="side-note">
        Справочник встроен в MicroPIDE ({(data?.total ?? 0)} совпадений) и работает без интернета.
      </div>

      {sel && (
        <div className="ref-card">
          <div className="ref-head">
            <b className="mono">{sel.name}</b>
            <span className="badge sm">{KIND_LABEL[sel.kind] || sel.kind}</span>
            <div className="lab-sp" />
            <button className="tb-btn" title="Закрыть" onClick={() => { setSel(null); setSnippet(null); }}><Ic n="close" size={14} /></button>
          </div>
          {sel.sig && <div className="mono small dim">{sel.sig}</div>}
          {sel.desc && <p className="ref-desc">{sel.desc}</p>}
          {(snippet?.code || sel.example) && (
            <>
              <pre className="ref-code">{snippet?.code || sel.example}</pre>
              <div className="row">
                <button className="btn tiny primary" onClick={() => insert(snippet?.code || sel.example || '')}>
                  <Ic n="copy" size={12} /> Вставить в редактор
                </button>
                <button className="btn tiny" onClick={() => { void navigator.clipboard.writeText(snippet?.code || sel.example || ''); onToast('Скопировано'); }}>
                  <Ic n="save" size={12} /> Копировать
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="ref-list">
        {(data?.entries || []).map((e) => (
          <button key={e.name + e.kind} className={'ref-item' + (sel?.name === e.name ? ' sel' : '')} onClick={() => void open(e)}>
            <span className="ref-name mono">{e.name}</span>
            <span className="dim small">{e.group || KIND_LABEL[e.kind] || ''}</span>
          </button>
        ))}
        {data && !data.entries.length && <div className="lab-note">Ничего не нашлось — попробуйте другое слово.</div>}
      </div>
    </div>
  );
}
