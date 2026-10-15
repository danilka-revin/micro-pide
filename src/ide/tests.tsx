// Панель «Тесты» — один сценарий проверяет и симулятор, и реальную плату.
//
// Язык сценариев MicroPIDE (.mps), свой и простой: строка — команда.
//   duration 3000     — сколько виртуального времени крутить (симулятор)
//   fast on           — прокрутить задержки мгновенно
//   serial "PING"     — отправить строку в плату
//   wait 200          — пауза
//   expect "PONG" 500 — ждать подстроку в выводе до 500 мс
//   expect_re /OK=(\d+)/
//   expect_no "ERROR"
//   pin D13 = 1       — подать уровень на вход (симулятор)
//   adc A0 = 512      — задать напряжение на аналоговом входе
//   pulse D3 = 0,200,1 / interrupt D2 = RISING
//   expect_pin D13 = 1 / expect_pwm D9 >= 100
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SketchFile } from './api';
import { Ic } from '../ui/icons';

const DEFAULT_SCENARIO = `# Тест MicroPIDE. Один и тот же файл работает на плате и в симуляторе.
name Проверка связи
baud 9600
duration 4000
fast on

expect "OK" 500          # плата должна поздороваться
serial "PING"
expect "PONG" 1000       # и ответить на команду
expect_no "ERROR"

# только для симулятора:
adc A0 = 512
expect_pin D13 = 1 1500
`;

export function TestsPanel({
  active, files, sketchName, port, onToast, onLog,
}: {
  active: boolean;
  files: SketchFile[];
  sketchName: string;
  port: string;
  onToast: (s: string) => void;
  onLog: (line: string) => void;
}) {
  const [list, setList] = useState<{ name: string; at?: number; note?: string; sketch?: string }[]>([]);
  const [name, setName] = useState(sketchName + '-test');
  const [scenario, setScenario] = useState(DEFAULT_SCENARIO);
  const [target, setTarget] = useState<'sim' | 'board'>('sim');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [reports, setReports] = useState<{ file: string; at?: number; name?: string }[]>([]);
  const outRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api.tests();
      setList(r.tests || []);
      const rr = await api.testReports();
      setReports(rr.reports || []);
    } catch { /* сервер может быть недоступен */ }
  }, []);
  useEffect(() => { if (active) void reload(); }, [active, reload]);

  const loadTest = async (n: string) => {
    try {
      const r = await api.testGet(n);
      if (r.ok) { setName(n); setScenario(r.scenario || ''); }
      else onToast('Не найдено: ' + n);
    } catch (e) { onToast(String(e)); }
  };

  const saveTest = async () => {
    try {
      const r = await api.testSave({ name, scenario, sketch: sketchName, note: 'тест MicroPIDE' });
      onToast(r.ok ? `Тест «${name}» сохранён` : 'Ошибка: ' + r.error);
      void reload();
    } catch (e) { onToast(String(e)); }
  };

  const draft = async () => {
    try {
      const r = await api.testDraft({ files, baud: 9600, duration: 5000 });
      if (r.scenario) { setScenario(r.scenario); onToast('Сценарий собран из строк Serial.print в коде'); }
    } catch (e) { onToast(String(e)); }
  };

  const run = async () => {
    setBusy(true);
    setReport(null);
    onLog(`— Тест «${name}» (${target === 'sim' ? 'симулятор' : 'плата ' + (port || '—')}) —`);
    try {
      const r = await api.testRun(
        { name, scenario, files, target, port, saveReport: 'md' },
        (line) => onLog(line),
      );
      setReport(r);
      onToast(r.ok ? '✓ Тест пройден' : '✗ Тест не пройден');
      void reload();
    } catch (e) {
      onToast('Ошибка: ' + (e instanceof Error ? e.message : String(e)));
    }
    setBusy(false);
  };

  const remove = async (n: string) => {
    try { await api.testDelete(n); void reload(); } catch { /* ignore */ }
  };

  return (
    <div className="tests">
      <div className="tests-bar">
        <select className="tb-sel" value={name} onChange={(e) => void loadTest(e.target.value)} style={{ minWidth: 150 }}>
          <option value={name}>{name}</option>
          {list.filter((t) => t.name !== name).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
        <input className="txt" style={{ width: 170 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="имя теста" />
        <div className="seg">
          <button className={'chip sm' + (target === 'sim' ? ' active' : '')} onClick={() => setTarget('sim')} title="Собрать скетч под компьютер и проверить логику без железа">Симулятор</button>
          <button className={'chip sm' + (target === 'board' ? ' active' : '')} onClick={() => setTarget('board')} title="Проверить на подключённой плате через порт">Плата</button>
        </div>
        <div className="lab-sp" />
        <button className="btn tiny" onClick={() => void draft()} title="Собрать сценарий из строк Serial.print в скетче"><Ic n="bolt" size={13} /> Из кода</button>
        <button className="btn tiny" onClick={() => void saveTest()}><Ic n="save" size={13} /> Сохранить</button>
        <button className="btn tiny primary" onClick={() => void run()} disabled={busy}>
          <Ic n="check" size={13} /> {busy ? 'Идёт…' : 'Запустить'}
        </button>
        {list.some((t) => t.name === name) && (
          <button className="btn tiny danger" onClick={() => void remove(name)} title="Удалить тест"><Ic n="trash" size={13} /></button>
        )}
      </div>

      <div className="tests-body">
        <textarea
          className="mps"
          spellCheck={false}
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          placeholder="expect &quot;OK&quot; 500"
        />
        <div className="tests-right" ref={outRef}>
          {!report && (
            <div className="lab-note">
              Команды: <span className="mono">duration, fast, baud, serial, wait, expect, expect_re, expect_no, pin, adc, pulse, interrupt, expect_pin, expect_pwm</span>.
              «Симулятор» собирает скетч под компьютер — проверка логики без платы. «Плата» работает с подключённым устройством через монитор порта.
            </div>
          )}
          {report && (
            <>
              <div className={'test-verdict ' + (report.ok ? 'ok' : 'bad')}>
                {report.ok ? '✓ Тест пройден' : '✗ Тест не пройден'}
                {report.checks ? ` · шагов ${report.checks.passed}/${report.checks.passed + report.checks.failed}` : ''}
                {report.target ? ` · ${report.target === 'sim' ? 'симулятор' : 'плата'}` : ''}
                {report.ms ? ` · ${(report.ms / 1000).toFixed(1)} с` : ''}
              </div>
              {report.error && <div className="lab-note err">{report.error}</div>}
              <table className="tbl">
                <thead><tr><th>Шаг</th><th>Что проверяли</th><th>Результат</th></tr></thead>
                <tbody>
                  {(report.steps || report.checks?.results || []).map((s: any, i: number) => (
                    <tr key={i} className={s.status === 'fail' ? 'bad-row' : ''}>
                      <td className="dim">{s.step?.line ?? i + 1}</td>
                      <td className="mono">{describeStep(s.step)}</td>
                      <td>{s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : '·'} {s.text || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.output && <pre className="lab-doc small">{String(report.output).slice(0, 4000)}</pre>}
            </>
          )}
          {!!reports.length && (
            <>
              <div className="side-h">Отчёты</div>
              <div className="rep-list">
                {reports.slice(0, 12).map((r) => (
                  <button key={r.file} className="link" onClick={() => void api.testReport(r.file).then((x) => onToast(x.content ? 'Отчёт открыт в выводе' : 'Пусто')).then(() => api.testReport(r.file)).then((x) => { if (x.content) onLog(String(x.content)); })}>
                    {r.file.split(/[\\/]/).pop()}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function describeStep(st: any): string {
  if (!st) return '';
  switch (st.kind) {
    case 'send': return `послать ${JSON.stringify(st.text)}`;
    case 'wait': return `пауза ${st.ms} мс`;
    case 'expect': return `ждать «${st.text}» до ${st.within} мс`;
    case 'expectRe': return `ждать по шаблону /${st.re}/`;
    case 'expectNo': return `не должно быть «${st.text}»`;
    case 'pin': return `пин ${st.pin} → ${st.value}`;
    case 'adc': return `АЦП ${st.pin} → ${st.value}`;
    case 'interrupt': return `прерывание ${st.pin} = ${st.mode}`;
    case 'expectPin': return `ожидать пин ${st.pin} = ${st.value}`;
    case 'expectPwm': return `ожидать ШИМ ${st.pin} ${st.op} ${st.value}`;
    case 'note': return st.text;
    default: return st.kind || '';
  }
}

/**
 * Диалог «Проверить логику без платы»: быстрый прогон скетча под симулятором.
 * Ничего не нужно устанавливать — MicroPIDE собирает скетч нативным компилятором.
 */
export function SimDialog({
  open, files, sketchName, onClose, onLog, onToast,
}: {
  open: boolean;
  files: SketchFile[];
  sketchName: string;
  onClose: () => void;
  onLog: (line: string) => void;
  onToast: (s: string) => void;
}) {
  const [scenario, setScenario] = useState('duration 3000\nfast on\n');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [showAdv, setShowAdv] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try { setStatus(await api.simStatus()); } catch { setStatus({ ok: false, error: 'сервер недоступен' }); }
      try {
        const d = await api.testDraft({ files, baud: 9600, duration: 3000 });
        if (d?.scenario) setScenario(d.scenario);
      } catch { /* оставляем шаблон */ }
    })();
  }, [open, files]);

  if (!open) return null;

  const run = async () => {
    setBusy(true);
    setRes(null);
    onLog('— Проверка без платы (симулятор MicroPIDE) —');
    try {
      const r = await api.simRun({ name: sketchName, files, scenario }, (l) => onLog(l));
      setRes(r);
      onToast(r.ok ? '✓ Логика работает' : '✗ Проверка не пройдена');
    } catch (e) {
      onToast('Ошибка: ' + (e instanceof Error ? e.message : String(e)));
    }
    setBusy(false);
  };

  return (
    <div className="settings-bg" onClick={onClose}>
      <div className="sim-dlg" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <b>Проверить логику без платы</b>
          <span className="dim">{status?.ok ? `тулчейн: ${status.compiler || 'найден'}` : 'нет компилятора — проверьте панель «Склад»'}</span>
          <button className="tb-btn" onClick={onClose}><Ic n="close" size={15} /></button>
        </div>
        <div className="sim-body">
          <div className="sim-left">
            <div className="side-h">Сценарий (.mps)</div>
            <textarea className="mps" spellCheck={false} value={scenario} onChange={(e) => setScenario(e.target.value)} />
            <div className="row">
              <button className="btn primary" onClick={() => void run()} disabled={busy}>
                <Ic n="bolt" size={14} /> {busy ? 'Собираю и запускаю…' : 'Запустить на компьютере'}
              </button>
              <button className="btn" onClick={() => setShowAdv((v) => !v)}>
                <Ic n="info" size={14} /> Как это работает
              </button>
            </div>
            {showAdv && (
              <div className="hint">
                MicroPIDE генерирует своё ядро-совместимый рантайм (Arduino.h, Serial, millis/delay, пины, АЦП, EEPROM),
                собирает скетч обычным компилятором вашей системы и запускает его с виртуальными часами:
                <span className="mono"> delay(1000)</span> проходит мгновенно, а сценарий проверяет вывод и уровни на пинах.
                Так можно поймать логические ошибки до того, как плата будет прошита.
              </div>
            )}
          </div>
          <div className="sim-right">
            {!res && <div className="lab-note">Запустите проверку — здесь появится вывод Serial, события пинов и результат шагов сценария.</div>}
            {res && (
              <>
                <div className={'test-verdict ' + (res.ok ? 'ok' : 'bad')}>
                  {res.ok ? '✓ Скетч отработал' : '✗ ' + (res.error || 'Ошибка')}
                  {res.summary ? ` · итераций ${res.summary.iterations}, виртуально ${res.summary.ms} мс` : ''}
                  {res.ms ? ` · реально ${(res.ms / 1000).toFixed(1)} с` : ''}
                </div>
                {res.checks && (
                  <div className="lab-hint">
                    Проверок сценария: пройдено {res.checks.passed}, провалено {res.checks.failed}
                  </div>
                )}
                {!!(res.checks?.results || []).length && (
                  <table className="tbl">
                    <thead><tr><th>Шаг</th><th>Проверка</th><th></th></tr></thead>
                    <tbody>
                      {res.checks.results.map((r: any, i: number) => (
                        <tr key={i} className={r.status === 'fail' ? 'bad-row' : ''}>
                          <td className="dim">{r.step?.line ?? i + 1}</td>
                          <td className="mono">{describeStep(r.step)}</td>
                          <td>{r.status === 'ok' ? '✓' : '✗'} {r.matched || r.text || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="side-h">Вывод Serial</div>
                <pre className="lab-doc small">{res.text || res.stdout || '(пусто)'}</pre>
                {!!(res.pins || []).length && (
                  <>
                    <div className="side-h">События пинов</div>
                    <pre className="lab-doc small">
                      {res.pins.slice(0, 40).map((p: any) => `${p.t} мс  пин ${p.pin} → ${p.pwm !== undefined ? 'ШИМ ' + p.pwm : p.value}`).join('\n')}
                    </pre>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
