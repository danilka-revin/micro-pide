// «Обновить с main»: кнопка в шапке, диалог проверки/установки обновлений
// с интерактивной полосой прогресса — перенос из PSBees (linux_pcb_app).
//
// Кнопка дёргает HTTP-эндпоинты сервера (server/server.mjs):
//   GET  /update/check          — сверить установленную версию с веткой main;
//   POST /update/run            — запустить обновление;
//   GET  /update/status?since=N — ход выполнения (long-poll);
//   POST /update/cancel         — отменить.
// После установки сервер сам перезапускается, а страница дожидается новой
// версии и перезагружается автоматически.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './widgets';
import { Ic } from './icons';

export type UpdatePhase = 'idle' | 'checking' | 'ready' | 'running' | 'done' | 'error' | 'cancelled';

export interface UpdateStage {
  id: string;
  label: string;
  weight: number;
  state: 'wait' | 'run' | 'done' | 'skip' | 'error';
  frac: number;
  msg: string;
}

export interface UpdateProgress {
  stages: UpdateStage[];
  stage: string;
  /** процент 0..100 */
  pct: number;
  bytes: number;
  total: number;
  exact: boolean;
  speed: number;
  eta: number | null;
  elapsed: number;
  count: number;
  countTotal: number;
  cancelable: boolean;
  restart: boolean;
  mode: string;
}

export interface UpdaterState {
  phase: UpdatePhase;
  msg: string;
  detail: string[];
  from: string;
  to: string;
  repo: string;
  branch: string;
  latestMsg: string;
  /** полный SHA последнего коммита в ветке — по нему понимаем, что версия новая */
  latestSha: string;
  behind: number;
  updateAvailable: boolean;
  tooling: { git: boolean; npm: boolean };
  progress: UpdateProgress | null;
  /** после установки: ждём перезапуска сервера и перезагружаем страницу */
  reload: 'none' | 'waiting' | 'manual';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Фоновая проверка обновлений: интерфейс сам узнаёт, что на GitHub вышла новая
// версия, и подсвечивает кнопку «Обновить».
const CHECK_START_MS = 4_000;             // первая проверка: не мешаем запуску
const CHECK_EVERY_MS = 30 * 60_000;       // дальше — раз в полчаса
const CHECK_STALE_MS = 5 * 60_000;        // вернулись к окну: проверить, если давно
const CHECK_FRESH_MS = 60_000;            // пока ответ свежий, диалог не переспрашивает
/** ключ localStorage: версия, про которую уже показали подсветку */
const SEEN_KEY = 'micropide.update.seen';

async function getJson(url: string, init?: RequestInit, timeout = 30000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const resp = await fetch(url, { cache: 'no-store', ...init, signal: ctl.signal });
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return null; }
  } finally { clearTimeout(t); }
}

export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 Б';
  if (n < 1024) return `${Math.round(n)} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} МБ`;
}

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${String(s % 60).padStart(2, '0')} с`;
}

export function useUpdater(version: string | null, enabled = true) {
  const [st, setSt] = useState<UpdaterState>({
    phase: 'idle', msg: '', detail: [], from: version ?? '', to: '',
    repo: '', branch: 'main', latestMsg: '', latestSha: '', behind: 0,
    updateAvailable: false, tooling: { git: true, npm: true },
    progress: null, reload: 'none',
  });
  const [open, setOpen] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  const lastCheckAt = useRef(0);
  const unsupported = useRef(false);
  const [seen, setSeen] = useState<string>(() => {
    try { return globalThis.localStorage?.getItem(SEEN_KEY) || ''; } catch { return ''; }
  });
  useEffect(() => () => { alive.current = false; }, []);

  const markSeen = useCallback((sha: string) => {
    if (!sha) return;
    setSeen(sha);
    try { globalThis.localStorage?.setItem(SEEN_KEY, sha); } catch { /* приватный режим */ }
  }, []);

  /** Применить ответ /update/status к состоянию интерфейса. */
  const applyStatus = useCallback((s: any) => {
    const progress: UpdateProgress = {
      stages: Array.isArray(s.stages) ? s.stages : [],
      stage: s.stage || '', pct: Number(s.pct) || 0,
      bytes: Number(s.bytes) || 0, total: Number(s.total) || 0, exact: !!s.exact,
      speed: Number(s.speed) || 0, eta: s.eta ?? null, elapsed: Number(s.elapsed) || 0,
      count: Number(s.count) || 0, countTotal: Number(s.countTotal) || 0,
      cancelable: !!s.cancelable, restart: !!s.restart, mode: s.mode || '',
    };
    setSt((x) => ({
      ...x,
      progress,
      detail: (s.output || '').split('\n').filter(Boolean),
      to: s.to || x.to, from: s.from || x.from,
      msg: s.phase || x.msg,
    }));
  }, []);

  /** После установки: дождаться, когда сервер поднимется с новой версией. */
  const awaitRestart = useCallback(async (expect: string) => {
    setSt((x) => ({ ...x, reload: 'waiting' }));
    const until = Date.now() + 90_000;
    let sawDown = false;
    await sleep(800);
    while (alive.current && Date.now() < until) {
      try {
        const v = await getJson('/version', undefined, 2500);
        const cur = String(v?.short || v?.sha || '');
        if (v?.ok && ((expect && cur.startsWith(expect.slice(0, 7))) || (sawDown && !expect))) {
          window.location.reload();
          return;
        }
        if (v?.ok && sawDown) { window.location.reload(); return; }
      } catch {
        sawDown = true;
      }
      await sleep(600);
    }
    if (alive.current) setSt((x) => ({ ...x, reload: 'manual' }));
  }, []);

  /** Следить за ходом обновления (long-poll). */
  const follow = useCallback(async () => {
    let rev = -1;
    let fails = 0;
    while (alive.current) {
      let s: any = null;
      try {
        s = await getJson('/update/status' + (rev >= 0 ? `?since=${rev}` : ''), undefined, 35000);
        fails = 0;
      } catch {
        if (++fails > 40) {
          setSt((x) => ({ ...x, phase: 'error', msg: 'Сервер не отвечает. Проверьте, что программа запущена, и повторите.' }));
          return;
        }
        await sleep(750);
        continue;
      }
      if (!s) { await sleep(750); continue; }
      rev = Number(s.rev) || 0;
      applyStatus(s);
      if (s.status === 'done') {
        const changed = (s.changes ?? 0) > 0;
        setSt((x) => ({
          ...x, phase: 'done', msg: s.phase || 'Обновление установлено.',
          updateAvailable: changed ? false : x.updateAvailable,
        }));
        if (changed) {
          if (s.restart) void awaitRestart(s.to || '');
          else setSt((x) => ({ ...x, reload: 'manual' }));
        }
        return;
      }
      if (s.status === 'cancelled') {
        setSt((x) => ({ ...x, phase: 'cancelled', msg: s.phase || 'Обновление отменено.' }));
        return;
      }
      if (s.status === 'error') {
        setSt((x) => ({ ...x, phase: 'error', msg: s.phase || 'Обновление не удалось' }));
        return;
      }
      if (s.status === 'idle') {
        setSt((x) => ({ ...x, phase: 'error', msg: 'Сервер перезапустился — нажмите «Проверить ещё раз».' }));
        return;
      }
    }
  }, [applyStatus, awaitRestart]);

  /** Сверить версию с GitHub. silent — фоновая проверка без спиннера. */
  const check = useCallback(async (opts: { silent?: boolean } = {}) => {
    const silent = !!opts.silent;
    if (running.current) return;
    if (!silent) setSt((s) => ({ ...s, phase: 'checking', msg: 'Проверяем обновления на GitHub…' }));
    try {
      const r = await getJson('/update/check', undefined, 40000);
      lastCheckAt.current = Date.now();
      if (r && r.ok) {
        setSt((s) => ({
          ...s,
          phase: silent && s.phase !== 'idle' ? s.phase : 'ready',
          repo: r.repo || s.repo, branch: r.branch || 'main',
          from: r.local || s.from, to: r.latest || s.to,
          latestSha: r.latestSha || s.latestSha,
          latestMsg: r.latestMsg || '', behind: r.behind ?? 0,
          updateAvailable: !!r.updateAvailable,
          tooling: r.tooling || s.tooling,
        }));
        return;
      }
      if (!r) {
        unsupported.current = true;
        if (silent) return;
        setSt((s) => ({
          ...s, phase: 'error',
          msg: 'В этом режиме запуска нет встроенного обновления.\nЗапустите программу через run.sh — там кнопка работает.',
        }));
        return;
      }
      if (silent) return;
      setSt((s) => ({ ...s, phase: 'error', msg: r.error || 'Не удалось проверить обновления' }));
    } catch {
      lastCheckAt.current = Date.now();
      if (silent) return;
      setSt((s) => ({ ...s, phase: 'error', msg: 'GitHub или сервер не ответили вовремя. Проверьте интернет и повторите.' }));
    }
  }, []);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSt((s) => ({ ...s, phase: 'running', msg: 'Запуск обновления…', detail: [], progress: null, reload: 'none' }));
    try {
      const j = await getJson('/update/run', { method: 'POST' }, 30000);
      if (!j || (!j.ok && !j.status)) throw new Error((j && j.error) || 'Не удалось начать обновление');
      await follow();
    } catch (e) {
      setSt((x) => ({ ...x, phase: 'error', msg: e instanceof Error ? e.message : 'Ошибка обновления' }));
    } finally {
      running.current = false;
    }
  }, [follow]);

  const cancel = useCallback(async () => {
    try {
      const j = await getJson('/update/cancel', { method: 'POST' }, 10000);
      if (j && !j.ok && j.error) setSt((x) => ({ ...x, msg: j.error }));
    } catch { /* статус придёт через long-poll */ }
  }, []);

  // обновление уже идёт (перезагрузили страницу посреди процесса) — подхватываем
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    (async () => {
      try {
        const s = await getJson('/update/status', undefined, 5000);
        if (stop || !s || s.status !== 'run' || running.current) return;
        running.current = true;
        setSt((x) => ({ ...x, phase: 'running' }));
        setOpen(true);
        try { await follow(); } finally { running.current = false; }
      } catch { /* нет сервера с обновлением */ }
    })();
    return () => { stop = true; };
  }, [follow, enabled]);

  // фоновая проверка: кнопка загорается сама, когда в main выходит новый коммит
  useEffect(() => {
    if (!enabled) return;
    let start: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (start) clearTimeout(start);
      if (timer) clearInterval(timer);
      start = timer = undefined;
    };
    const tick = async () => {
      if (running.current) return;
      await check({ silent: true });
      if (unsupported.current) stop();
    };
    start = setTimeout(() => void tick(), CHECK_START_MS);
    timer = setInterval(() => void tick(), CHECK_EVERY_MS);
    const wake = () => {
      if (unsupported.current) { stop(); return; }
      if (Date.now() - lastCheckAt.current >= CHECK_STALE_MS) void tick();
    };
    const onVisible = () => { if (!document.hidden) wake(); };
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop();
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check, enabled]);

  // процент в заголовке вкладки, пока диалог свёрнут
  const pct = st.phase === 'running' && st.progress ? Math.round(st.progress.pct) : null;
  useEffect(() => {
    if (pct == null) return;
    const base = document.title.replace(/^\[\d+%\]\s*/, '');
    document.title = `[${pct}%] ${base}`;
    return () => { document.title = document.title.replace(/^\[\d+%\]\s*/, ''); };
  }, [pct]);

  const openDialog = useCallback(() => {
    setOpen(true);
    markSeen(st.latestSha);
    if (running.current || st.phase === 'running' || st.reload === 'waiting') return;
    if (st.phase === 'ready' && Date.now() - lastCheckAt.current < CHECK_FRESH_MS) return;
    setSt((s) => ({ ...s, phase: 'idle', msg: '' }));
    void check({});
  }, [check, markSeen, st.latestSha, st.phase, st.reload]);

  const busy = st.phase === 'running';
  const avail = !busy && st.updateAvailable;
  const fresh = avail && !!st.latestSha && st.latestSha !== seen;

  const Button = useMemo(() => (
    <button
      className={'tb-btn upd-btn' + (busy ? ' upd-busy' : '') + (avail ? ' upd-avail' : '') + (fresh ? ' upd-fresh' : '')}
      title={busy
        ? `Идёт обновление: ${pct ?? 0}% — нажмите, чтобы развернуть`
        : avail
          ? `Доступна новая версия ${st.to}${st.behind > 1 ? ` — новых коммитов: ${st.behind}` : ''}. Нажмите, чтобы обновить${st.latestMsg ? `\n${st.latestMsg}` : ''}`
          : 'Обновить программу из ветки main (GitHub)'}
      onClick={openDialog}
    >
      <Ic n="refresh" size={15} />
      {busy ? `${pct ?? 0}%` : 'Обновить'}
      {avail && <span className={'upd-dot' + (fresh ? ' is-new' : '')} title="Доступна новая версия" />}
      {avail && st.behind > 1 && <span className="upd-n">+{st.behind}</span>}
      {busy && <span className="upd-btn-bar" style={{ transform: `scaleX(${(pct ?? 0) / 100})` }} />}
    </button>
  ), [busy, pct, avail, fresh, st.to, st.behind, st.latestMsg, openDialog]);

  const Dialog = (
    <>
      <UpdaterDialog
        open={open}
        onClose={() => setOpen(false)}
        st={st} onCheck={() => check({})} onRun={run} onCancel={cancel}
        onReload={() => window.location.reload()}
      />
      <UpdateToast st={st} show={fresh && !open} onUpdate={openDialog} onLater={() => markSeen(st.latestSha)} />
    </>
  );

  return { Button, Dialog, state: st, open: openDialog };
}

const STAGE_ICON: Record<UpdateStage['state'], string> = {
  wait: '○', run: '', done: '✓', skip: '↷', error: '✕',
};

/** Полоса прогресса + этапы + скорость/ETA. */
export function UpdateProgressView({ p, phase, msg }: { p: UpdateProgress | null; phase: UpdatePhase; msg: string }) {
  const pct = p ? Math.round(p.pct * 10) / 10 : 0;
  const active = phase === 'running';
  const cur = p?.stages.find((s) => s.id === p.stage);
  const indeterminate = active && (!p || !p.stages.length || pct < 0.5);

  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);

  let sub = '';
  if (p && active) {
    if (p.stage === 'download' && p.bytes > 0) {
      sub = fmtBytes(p.bytes) + (p.total ? ` из ${p.exact ? '' : '~'}${fmtBytes(Math.max(p.total, p.bytes))}` : '')
        + (p.speed ? ` · ${fmtBytes(p.speed)}/с` : '');
    } else if (p.stage === 'deps' && p.countTotal) {
      sub = `${p.count} из ${p.countTotal} пакетов`;
    }
  }

  return (
    <div className={'updp' + (phase === 'error' ? ' is-err' : phase === 'done' ? ' is-ok' : phase === 'cancelled' ? ' is-cancel' : '')}>
      <div className="updp-head">
        <span className="updp-title" aria-live="polite">{active ? (cur?.msg || msg || 'Обновление…') : msg}</span>
        <span className="updp-pct">{indeterminate ? '' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}</span>
      </div>
      <div
        className={'updp-track' + (indeterminate ? ' indet' : '') + (active ? ' live' : '')}
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      >
        {p && p.stages.length > 0 && (() => {
          const sum = p.stages.reduce((a, s) => a + s.weight, 0) || 1;
          let acc = 0;
          return p.stages.slice(0, -1).map((s) => {
            acc += s.weight;
            return <span key={s.id} className="updp-tick" style={{ left: `${(acc / sum) * 100}%` }} />;
          });
        })()}
        <div className="updp-fill" style={{ width: indeterminate ? undefined : `${pct}%` }} />
      </div>
      <div className="updp-meta">
        <span>{sub}</span>
        {p && (active || phase === 'done') && (
          <span className="updp-time">
            прошло {fmtDur(p.elapsed)}{active && p.eta != null && pct > 3 ? ` · осталось ≈ ${fmtDur(p.eta)}` : ''}
          </span>
        )}
      </div>
      {p && p.stages.length > 0 && (
        <ol className="updp-steps">
          {p.stages.map((s) => (
            <li key={s.id} className={'updp-step s-' + s.state}>
              <span className="updp-ico">{s.state === 'run' ? <Ic n="refresh" size={13} /> : STAGE_ICON[s.state]}</span>
              <span className="updp-lab">{s.label}</span>
              <span className="updp-mini">
                {s.state === 'run' && <span className="updp-mini-fill" style={{ width: `${Math.round(s.frac * 100)}%` }} />}
              </span>
              <span className="updp-st">
                {s.state === 'run' ? `${Math.round(s.frac * 100)}%` : s.state === 'skip' ? 'кэш' : s.state === 'done' ? 'готово' : s.state === 'error' ? 'ошибка' : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function UpdateToast({ st, show, onUpdate, onLater }: {
  st: UpdaterState; show: boolean; onUpdate: () => void; onLater: () => void;
}) {
  if (!show) return null;
  return (
    <div className="upd-toast">
      <span className="upd-toast-ico"><Ic n="bolt" size={20} /></span>
      <span className="upd-toast-body">
        <b>Доступна новая версия {st.to}</b>
        <span>{st.latestMsg || 'Новые исправления и возможности — обновите программу.'}</span>
      </span>
      <button className="btn tiny" onClick={onUpdate}>Обновить</button>
      <button className="btn tiny" onClick={onLater}>Позже</button>
    </div>
  );
}

function UpdaterDialog({
  open, onClose, st, onCheck, onRun, onCancel, onReload,
}: {
  open: boolean;
  onClose: () => void;
  st: UpdaterState;
  onCheck: () => void;
  onRun: () => void;
  onCancel: () => void;
  onReload: () => void;
}) {
  const [showLog, setShowLog] = useState(false);
  if (!open) return null;
  const running = st.phase === 'running';
  const checking = st.phase === 'checking';
  const showProgress = running || ((st.phase === 'done' || st.phase === 'error' || st.phase === 'cancelled') && !!st.progress);
  return (
    <Modal
      title={running ? 'Обновление программы' : 'Обновить с main'}
      className="update-modal"
      onClose={onClose}
      foot={
        <>
          {running ? (
            <>
              <button className="btn" onClick={onClose} title="Обновление продолжится в фоне — прогресс виден на кнопке «Обновить»">Свернуть</button>
              <button className="btn danger" onClick={onCancel} disabled={!st.progress?.cancelable}>Отменить</button>
            </>
          ) : (
            <button className="btn" onClick={onClose} disabled={checking}>Закрыть</button>
          )}
          {(st.phase === 'ready' && st.updateAvailable) && (
            <button className="btn primary" onClick={onRun} disabled={!st.tooling.npm}>Обновить сейчас</button>
          )}
          {st.phase === 'done' && st.reload !== 'none' && (
            <button className="btn primary" onClick={onReload}>Перезагрузить сейчас</button>
          )}
          {(st.phase === 'error' || st.phase === 'cancelled') && <button className="btn primary" onClick={onCheck}>Проверить ещё раз</button>}
        </>
      }
    >
      <div className="upd">
        <div className="upd-vers">
          <div className="upd-ver">
            <span className="upd-lab">Установлено</span>
            <b className="upd-mono">{st.from || '—'}</b>
          </div>
          <span className="upd-arrow">→</span>
          <div className="upd-ver">
            <span className="upd-lab">В {st.branch || 'main'}</span>
            <b className="upd-mono">{st.to || '…'}</b>
          </div>
          <div className="upd-ver upd-repo">
            <span className="upd-lab">Репозиторий</span>
            <b className="upd-mono">{st.repo ? st.repo.replace(/^https?:\/\/[^/]+\//, '') : '…'}</b>
          </div>
        </div>

        {checking && (
          <UpdateProgressView p={null} phase="running" msg="Проверяем обновления на GitHub…" />
        )}
        {st.phase === 'ready' && (
          st.updateAvailable ? (
            <div className="upd-msg ok">
              Доступна новая версия <b>{st.to}</b>{st.behind > 1 ? `: новых коммитов — ${st.behind}` : ''}.
              {st.latestMsg && <div className="upd-commit">«{st.latestMsg}»</div>}
            </div>
          ) : (
            <p className="upd-msg">Установлена актуальная версия — новых коммитов в {st.branch || 'main'} нет.</p>
          )
        )}

        {showProgress && <UpdateProgressView p={st.progress} phase={st.phase} msg={st.msg} />}

        {st.phase === 'done' && (
          <p className="upd-msg ok">
            {st.msg}
            {st.reload === 'waiting' && <><br />Ждём запуска новой версии — страница перезагрузится сама…</>}
            {st.reload === 'manual' && <><br />Нажмите «Перезагрузить сейчас», чтобы открыть новую версию.</>}
          </p>
        )}
        {st.phase === 'cancelled' && <p className="upd-msg">{st.msg}</p>}
        {st.phase === 'error' && <p className="upd-msg bad">{st.msg}</p>}

        {st.detail.length > 0 && (showProgress || st.phase === 'error') && (
          <>
            <button className="upd-logtoggle" onClick={() => setShowLog((v) => !v)}>
              {showLog ? '▾' : '▸'} Подробности ({st.detail.length})
            </button>
            {showLog && (
              <div className="upd-log" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
                {st.detail.map((l, i) => <div key={i} className="upd-line">{l}</div>)}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
