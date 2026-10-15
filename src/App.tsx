// MicroPIDE — аналог Arduino IDE в дизайне PSBees (linux_pcb_app).
// Шапка-тулбар с меню (Файл/Правка/Скетч/Инструменты/Справка), боковая панель
// (скетчбук, примеры, библиотеки, платы), редактор CodeMirror, панель низа
// (вывод, монитор порта, построитель графиков), строка состояния.
// Сборка/прошивка/монитор — через API локального сервера (server/server.mjs).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { Ic } from './ui/icons';
import { MenuBtn, Modal, ConfirmDialog, type MenuEntry } from './ui/widgets';
import { usePrefs, applyTheme } from './ui/prefs';
import { applyCustomColors } from './ui/palette';
import { useUpdater } from './ui/updater';
import { SettingsWindow } from './ui/settings';
import { CodeEditor } from './ide/editor';
import { api, type CliInfo, type SerialPortInfo, type SketchFile, type SystemInfo } from './ide/api';
import { ConsoleView, pushLine, type ConsoleLine } from './ide/console';
import { SerialMonitor, SerialPlotter } from './ide/serial';
import { SIDE_TABS, SketchbookPanel, ExamplesPanel, LibsPanel, BoardsPanel, type SideTab } from './ide/panels';
import { AnalysisPanel } from './ide/lab';
import { HistoryPanel, BuildStats } from './ide/history';
import { TestsPanel, SimDialog } from './ide/tests';
import { TelemetryPanel } from './ide/telemetry';
import { VaultPanel } from './ide/vault';
import { ReferencePanel } from './ide/reference';

type BottomTab = 'console' | 'serial' | 'plot' | 'analysis' | 'telemetry' | 'tests' | 'history';

interface OpenFile { path: string; content: string; dirty: boolean }

const BLINK_TEMPLATE = `/*
  ${'{NAME}'}
  Мигает светодиодом раз в секунду. Скетч по умолчанию MicroPIDE.
*/

void setup() {
  // initialize digital pin LED_BUILTIN as an output.
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);  // turn the LED on
  delay(1000);                      // wait a second
  digitalWrite(LED_BUILTIN, LOW);   // turn the LED off
  delay(1000);
}
`;

const DRAFT_KEY = 'micropide.draft';

const iconName = (p: string) => (/\.(ino|cpp|hpp|c|S)$/i.test(p) ? 'filecode' : 'file');

export default function App() {
  const { prefs, set, reset } = usePrefs();
  const [version, setVersion] = useState<string | null>(null);

  // ---------------- скетч ----------------
  const [sketchName, setSketchName] = useState('Sketch');
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState(0);
  const [sketchbook, setSketchbook] = useState<{ name: string; mtime: number; files: { path: string; size: number }[] }[]>([]);
  const [loadedFrom, setLoadedFrom] = useState<string>(''); // имя скетча, открытого с диска

  // ---------------- железо ----------------
  const [cli, setCli] = useState<CliInfo | null>(null);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [boards, setBoards] = useState<{ name: string; fqbn: string }[]>([]);
  const [fqbn, setFqbn] = useState(localStorage.getItem('micropide.fqbn') || '');
  const [boardLabel, setBoardLabel] = useState(localStorage.getItem('micropide.boardLabel') || '');
  const [port, setPort] = useState(localStorage.getItem('micropide.port') || '');
  const [cliBusy, setCliBusy] = useState(false);
  const [hwKey, setHwKey] = useState(0);
  // refs для автоопределения платы (актуальные значения внутри колбэков)
  const portRef = useRef('');
  const fqbnRef = useRef('');
  const lastDetect = useRef('');
  portRef.current = port;
  fqbnRef.current = fqbn;

  // ---------------- панели ----------------
  const [sideTab, setSideTab] = useState<SideTab>('sketchbook');
  const [bottomTab, setBottomTab] = useState<BottomTab>('console');
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomMax, setBottomMax] = useState(false);
  const [conLines, setConLines] = useState<ConsoleLine[]>([]);
  const [toast, setToast] = useState('');
  const [gotoLine, setGotoLine] = useState<{ file: string; line: number; token: number } | null>(null);
  const [simOpen, setSimOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [mapData, setMapData] = useState<any>(null);
  const [matrixPicked, setMatrixPicked] = useState<string[]>([]);
  const [matrixRows, setMatrixRows] = useState<any[]>([]);

  // ---------------- busy-состояния ----------------
  const [building, setBuilding] = useState(false);
  const [uploading, setUploading] = useState(false);

  // ---------------- диалоги ----------------
  const [dlg, setDlg] = useState<'' | 'new' | 'saveas' | 'rename' | 'about' | 'hotkeys'>('');
  const [dlgText, setDlgText] = useState('');
  const [confirmDel, setConfirmDel] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const edView = useRef<EditorView | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  // -------- свои подсистемы: файлы для API, переходы, вставка кода --------
  const sketchFiles = useCallback((): SketchFile[] => files.map((f) => ({ path: f.path, content: f.content })), [files]);

  const applyFiles = useCallback((next: SketchFile[]) => {
    setFiles(next.map((f) => ({ path: f.path, content: f.content, dirty: true })));
    setActiveFile((i) => Math.min(i, Math.max(0, next.length - 1)));
  }, []);

  const addOrReplaceFile = useCallback((path: string, content: string) => {
    setFiles((cur) => {
      const i = cur.findIndex((f) => f.path === path);
      if (i >= 0) return cur.map((f, k) => (k === i ? { ...f, content, dirty: true } : f));
      return [...cur, { path, content, dirty: true }];
    });
  }, []);

  const goToLine = useCallback((file: string, line: number) => {
    const idx = files.findIndex((f) => f.path === file || f.path.endsWith('/' + file));
    if (idx >= 0 && idx !== activeFile) setActiveFile(idx);
    setGotoLine({ file: files[idx]?.path || file, line, token: Date.now() });
    setBottomOpen(true);
  }, [files, activeFile]);

  // ---------------- тема ----------------
  useEffect(() => {
    applyTheme(prefs.theme);
    applyCustomColors(prefs.colors, prefs.theme);
  }, [prefs.theme, prefs.colors]);

  // ---------------- версия и обновления ----------------
  const updater = useUpdater(version, prefs.checkUpdates);
  useEffect(() => {
    fetch('/version', { cache: 'no-store' }).then((r) => r.json()).then((v) => {
      if (v?.ok) setVersion(v.short || null);
    }).catch(() => {});
  }, []);

  const log = useCallback((text: string, kind?: ConsoleLine['kind']) => {
    setConLines((arr) => pushLine(arr, text, kind));
  }, []);
  const say = useCallback((s: string) => {
    setToast(s);
    window.setTimeout(() => setToast((cur) => (cur === s ? '' : cur)), 5000);
  }, []);

  const insertIntoEditor = useCallback((code: string) => {
    const v = edView.current;
    if (!v) { log('Откройте файл скетча, чтобы вставить код.', 'err'); return; }
    const pos = v.state.selection.main.from;
    v.dispatch({ changes: { from: pos, insert: code }, selection: { anchor: pos + code.length } });
    v.focus();
  }, [log]);

  // ---------------- cli / порты / платы ----------------
  const refreshCli = useCallback(async () => {
    try { setCli(await api.cli()); } catch { setCli(null); }
  }, []);
  const refreshSys = useCallback(async () => {
    try { setSys(await api.system()); } catch { setSys(null); }
  }, []);

  const refreshPorts = useCallback(async () => {
    try {
      const r = await api.ports();
      if (!r.ok) return;
      setPorts(r.ports || []);
      // автоопределение: если на каком-то порту видна плата — выбрать её самим
      const detected = (r.ports || []).find((p) => p.boardName || p.fqbn);
      const sig = detected ? `${detected.address}|${detected.boardName}|${detected.fqbn}` : '';
      if (detected && sig !== lastDetect.current) {
        lastDetect.current = sig;
        const still = (r.ports || []).some((p) => p.address === portRef.current);
        if (!portRef.current || !still) {
          setPort(detected.address);
          say(`Плата найдена: ${detected.boardName || 'устройство'} на ${detected.address}`);
        }
        if (!fqbnRef.current && detected.fqbn) {
          setFqbn(detected.fqbn);
          setBoardLabel(detected.boardName || '');
          if (still) say(`Плата: ${detected.boardName || detected.fqbn} на ${detected.address}`);
        }
      } else if (!detected) {
        lastDetect.current = '';
      }
    } catch { /* ignore */ }
  }, [say]);

  const refreshBoards = useCallback(async () => {
    try {
      const r = await api.boards();
      if (r.ok) setBoards(r.boards || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshCli();
    void refreshSys();
  }, [refreshCli, refreshSys, hwKey]);

  useEffect(() => {
    if (!cli?.ok) return;
    void refreshPorts();
    void refreshBoards();
    const t = setInterval(() => void refreshPorts(), 4000);
    return () => clearInterval(t);
  }, [cli?.ok, refreshPorts, refreshBoards]);

  useEffect(() => { localStorage.setItem('micropide.fqbn', fqbn); }, [fqbn]);
  useEffect(() => { localStorage.setItem('micropide.boardLabel', boardLabel); }, [boardLabel]);
  useEffect(() => { localStorage.setItem('micropide.port', port); }, [port]);

  const installCli = useCallback(async () => {
    setCliBusy(true);
    setBottomTab('console');
    setBottomOpen(true);
    log('Устанавливаю arduino-cli…', 'hl');
    try {
      await api.installCli((line) => log(line));
      await refreshCli();
      setHwKey((k) => k + 1);
    } catch { /* вывод уже в консоли */ }
    setCliBusy(false);
  }, [log, refreshCli]);

  // ---------------- черновик ----------------
  const draftTimer = useRef<number>(0);
  const draftState = useRef({ sketchName, files, loadedFrom });
  draftState.current = { sketchName, files, loadedFrom };

  useEffect(() => {
    if (!prefs.autosave) return;
    draftTimer.current = window.setInterval(() => {
      const { sketchName: n, files: f, loadedFrom: lf } = draftState.current;
      if (!f.length) return;
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: n, files: f, from: lf, at: Date.now() }));
      } catch { /* переполнение — не страшно */ }
    }, Math.max(200, prefs.autosaveMs));
    return () => clearInterval(draftTimer.current);
  }, [prefs.autosave, prefs.autosaveMs]);

  // стартовый скетч: черновик → иначе Blink
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d?.files?.length) {
          setSketchName(String(d.name || 'Sketch'));
          setFiles(d.files.map((f: SketchFile) => ({ path: f.path, content: f.content, dirty: !!d.from ? false : true })));
          setLoadedFrom(String(d.from || ''));
          return;
        }
      }
    } catch { /* ignore */ }
    newSketch('Blink');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- скетчи ----------------
  const reloadSketchbook = useCallback(async () => {
    try {
      const r = await api.sketches();
      setSketchbook(r.sketches || []);
    } catch { /* сервер может быть недоступен в dev-режиме */ }
  }, []);

  useEffect(() => { void reloadSketchbook(); }, [reloadSketchbook, building, uploading]);

  function newSketch(name = 'Sketch') {
    const clean = name.replace(/[^\wа-яА-ЯёЁ -]/g, '').trim() || 'Sketch';
    const ino = `${clean}/${clean}.ino`;
    setSketchName(clean);
    setFiles([{ path: `${clean}.ino`, content: BLINK_TEMPLATE.replace('{NAME}', clean), dirty: false }]);
    setActiveFile(0);
    setLoadedFrom('');
    setDlg('');
  }

  function openSketch(name: string) {
    void (async () => {
      try {
        const r = await api.sketchGet(name);
        if (r.ok === false) { say('Не удалось открыть: ' + (r.error || name)); return; }
        setSketchName(r.name);
        setFiles((r.files || []).map((f) => ({ path: f.path, content: f.content, dirty: false })));
        setActiveFile(0);
        setLoadedFrom(r.name);
        say(`Открыт скетч «${r.name}»`);
      } catch (e) {
        say('Не удалось открыть скетч (сервер недоступен?)');
      }
    })();
  }

  function openExample(name: string, filesIn: SketchFile[]) {
    setSketchName(name);
    setFiles(filesIn.map((f) => ({ path: f.path, content: f.content, dirty: false })));
    setActiveFile(0);
    setLoadedFrom('');
    say(`Пример «${name}» открыт — сохраните его в скетчбук перед прошивкой`);
  }

  const saveFiles = useCallback(async (name: string, fs: OpenFile[]): Promise<boolean> => {
    try {
      // главный .ino обязан называться как скетч (требование arduino-cli)
      const norm = fs.map((f) => (/\.ino$/i.test(f.path) ? { ...f, path: name + '.ino' } : f));
      await api.sketchSave(name, norm.map((f) => ({ path: f.path, content: f.content })));
      setFiles(norm.map((f) => ({ ...f, dirty: false })));
      setLoadedFrom(name);
      await reloadSketchbook();
      return true;
    } catch (e) {
      log('✗ Не удалось сохранить: ' + (e instanceof Error ? e.message : String(e)), 'err');
      return false;
    }
  }, [log, reloadSketchbook]);

  const doSave = useCallback(async () => {
    if (!loadedFrom) { setDlg('saveas'); return; }
    const ok = await saveFiles(loadedFrom, files);
    if (ok) say(`Сохранено: ${loadedFrom}`);
  }, [files, loadedFrom, saveFiles, say]);

  const doSaveAs = useCallback(async (name: string) => {
    const ok = await saveFiles(name, files);
    if (ok) { setSketchName(name); setDlg(''); say(`Сохранено: ${name}`); }
  }, [files, saveFiles, say]);

  // ---------------- сборка и прошивка ----------------
  const needBoard = () => {
    if (!fqbn) {
      setBottomTab('console'); setBottomOpen(true);
      log('✗ Не выбрана плата. Выберите плату в шапке или установите её в панели «Платы».', 'err');
      return false;
    }
    return true;
  };

  const doVerify = useCallback(async () => {
    if (building || uploading) return;
    if (!needBoard()) return;
    if (!cli?.ok) log('arduino-cli недоступен — собираю своим движком MicroPIDE (свой препроцессор и рецепты platform.txt).', 'hl');
    setBuilding(true);
    setBottomTab('console');
    setBottomOpen(true);
    log(`— Проверка: ${sketchName} для ${boardLabel || fqbn} —`, 'hl');
    try {
      await api.build(
        { name: sketchName, fqbn, files: files.map((f) => ({ path: f.path, content: f.content })), verbose: prefs.verboseBuild },
        (line) => log(line),
      );
    } catch (e) {
      log('✗ ' + (e instanceof Error ? e.message : String(e)), 'err');
    }
    setBuilding(false);
    void reloadSketchbook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, uploading, fqbn, cli, sketchName, boardLabel, files, prefs.verboseBuild, log]);

  const doUpload = useCallback(async () => {
    if (building || uploading) return;
    if (!needBoard()) return;
    if (!port) {
      setBottomTab('console'); setBottomOpen(true);
      log('✗ Не выбран порт. Подключите плату и выберите порт в шапке.', 'err');
      return;
    }
    setUploading(true);
    setBottomTab('console');
    setBottomOpen(true);
    log(`— Прошивка: ${sketchName} → ${port} —`, 'hl');
    try {
      await api.upload(
        { name: sketchName, fqbn, port, files: files.map((f) => ({ path: f.path, content: f.content })), verbose: prefs.verboseBuild },
        (line) => log(line),
      );
    } catch (e) {
      log('✗ ' + (e instanceof Error ? e.message : String(e)), 'err');
    }
    setUploading(false);
    void reloadSketchbook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, uploading, fqbn, port, sketchName, files, prefs.verboseBuild, log]);

  // ---------------- файлы скетча ----------------
  const setFileContent = useCallback((i: number, content: string) => {
    setFiles((cur) => cur.map((f, k) => (k === i ? { ...f, content, dirty: true } : f)));
  }, []);

  const addFile = useCallback((path: string) => {
    const fn = path.trim().replace(/[^\w.\- ]/g, '');
    if (!fn) return;
    setFiles((cur) => {
      if (cur.some((f) => f.path === fn)) { say('Такой файл уже есть'); return cur; }
      return [...cur, { path: fn, content: '', dirty: true }];
    });
    setActiveFile(files.length);
  }, [files.length, say]);

  const closeFile = useCallback((i: number) => {
    setFiles((cur) => {
      if (cur.length === 1) return cur;
      const next = cur.filter((_, k) => k !== i);
      setActiveFile((a) => Math.max(0, a > i ? a - 1 : a));
      return next;
    });
  }, []);

  const dirty = files.some((f) => f.dirty);

  // ---------------- горячие клавиши ----------------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === 'Escape' && settingsOpen) setSettingsOpen(false);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'r' && !e.shiftKey) { e.preventDefault(); void doVerify(); }
      else if (k === 'u') { e.preventDefault(); void doUpload(); }
      else if (k === 's' && !e.shiftKey) { e.preventDefault(); void doSave(); }
      else if (k === 'n') { e.preventDefault(); setDlgText('Sketch' + (sketchbook.length + 1)); setDlg('new'); }
      else if (k === 'o') { e.preventDefault(); setSideTab('sketchbook'); set(prefs.showSidebar ? {} : { showSidebar: true }); }
      else if (k === 'f' && edView.current) { e.preventDefault(); openSearchPanel(edView.current); }
      else if (k === 'm' && e.shiftKey) { e.preventDefault(); setBottomTab('serial'); setBottomOpen(true); }
      else if (k === ',') { e.preventDefault(); setSettingsOpen(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [doVerify, doUpload, doSave, sketchbook.length, set, prefs.showSidebar, settingsOpen]);

  const openMap = useCallback(async () => {
    setMapOpen(true);
    setMapData({ loading: true });
    try {
      const r = await api.buildMap(sketchName);
      setMapData(r);
    } catch (e) {
      setMapData({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [sketchName]);

  const runMatrix = useCallback(async () => {
    if (!matrixPicked.length) { say('Выберите хотя бы одну плату'); return; }
    setBottomTab('console');
    setBottomOpen(true);
    setMatrixRows([]);
    log(`— Сборка «${sketchName}» под ${matrixPicked.length} плат(ы) —`, 'hl');
    try {
      const r = await api.buildMatrix({ name: sketchName, files: sketchFiles(), fqbns: matrixPicked }, (line) => log(line));
      setMatrixRows(r?.rows || []);
      say(r?.ok ? 'Собрано для всех выбранных плат' : 'Часть плат не собралась — смотрите вывод');
    } catch (e) {
      log('✗ ' + (e instanceof Error ? e.message : String(e)), 'err');
    }
  }, [matrixPicked, sketchName, sketchFiles, log, say]);

  // ---------------- меню ----------------
  const fileMenu: MenuEntry[] = [
    { icon: 'new', label: 'Новый скетч', kbd: 'Ctrl+N', onClick: () => { setDlgText('Sketch' + (sketchbook.length + 1)); setDlg('new'); } },
    { icon: 'open', label: 'Открыть из скетчбука', kbd: 'Ctrl+O', onClick: () => { setSideTab('sketchbook'); if (!prefs.showSidebar) set({ showSidebar: true }); } },
    { icon: 'examples', label: 'Открыть пример', onClick: () => { setSideTab('examples'); if (!prefs.showSidebar) set({ showSidebar: true }); } },
    { sep: true },
    { icon: 'save', label: 'Сохранить', kbd: 'Ctrl+S', onClick: () => void doSave() },
    { icon: 'saveas', label: 'Сохранить как…', onClick: () => { setDlgText(sketchName); setDlg('saveas'); } },
    { icon: 'edit', label: 'Переименовать скетч…', onClick: () => { setDlgText(sketchName); setDlg('rename'); } },
    { sep: true },
    { icon: 'gear', label: 'Настройки', kbd: 'Ctrl+,', onClick: () => setSettingsOpen(true) },
  ];

  const editMenu: MenuEntry[] = [
    { icon: 'undo', label: 'Отменить', kbd: 'Ctrl+Z', onClick: () => { if (edView.current) void cmUndo(edView.current); } },
    { icon: 'redo', label: 'Вернуть', kbd: 'Ctrl+Shift+Z', onClick: () => { if (edView.current) void cmRedo(edView.current); } },
    { sep: true },
    { icon: 'find', label: 'Найти…', kbd: 'Ctrl+F', onClick: () => { if (edView.current) openSearchPanel(edView.current); } },
    { icon: 'copy', label: 'Дублировать строку', onClick: () => duplicateLine() },
    { icon: 'cut', label: 'Закомментировать строку', kbd: 'Ctrl+/', onClick: () => toggleComment() },
  ];

  const sketchMenu: MenuEntry[] = [
    { icon: 'verify', label: 'Проверить / Компилировать', kbd: 'Ctrl+R', onClick: () => void doVerify(), disabled: building || uploading },
    { icon: 'upload', label: 'Загрузить в плату', kbd: 'Ctrl+U', onClick: () => void doUpload(), disabled: building || uploading },
    { sep: true },
    { icon: 'lib', label: 'Менеджер библиотек', onClick: () => { setSideTab('libs'); if (!prefs.showSidebar) set({ showSidebar: true }); } },
    { icon: 'board', label: 'Менеджер плат', onClick: () => { setSideTab('boards'); if (!prefs.showSidebar) set({ showSidebar: true }); } },
  ];

  const toolsMenu: MenuEntry[] = [
    { icon: 'bolt', label: 'Проверить логику без платы…', onClick: () => setSimOpen(true) },
    { icon: 'find', label: 'Анализ скетча и карта пинов', onClick: () => { setBottomTab('analysis'); setBottomOpen(true); } },
    { icon: 'verify', label: 'Тесты на железе и в симуляторе', onClick: () => { setBottomTab('tests'); setBottomOpen(true); } },
    { icon: 'clock', label: 'История версий и сборок', onClick: () => { setBottomTab('history'); setBottomOpen(true); } },
    { icon: 'info', label: 'Карта памяти (символы .elf)', onClick: () => { void openMap(); } },
    { icon: 'board', label: 'Сборка под несколько плат…', onClick: () => { setMatrixRows([]); setMatrixPicked(fqbn ? [fqbn] : []); setMatrixOpen(true); } },
    { icon: 'inventory', label: 'Автономный режим и склад', onClick: () => { setSideTab('vault'); if (!prefs.showSidebar) set({ showSidebar: true }); } },
    { sep: true },
    { icon: 'monitor', label: 'Монитор порта', kbd: 'Ctrl+Shift+M', onClick: () => { setBottomTab('serial'); setBottomOpen(true); } },
    { icon: 'plot', label: 'Телеметрия MicroTelem', onClick: () => { setBottomTab('telemetry'); setBottomOpen(true); } },
    { icon: 'plot', label: 'Построитель графиков', onClick: () => { setBottomTab('plot'); setBottomOpen(true); } },
    { icon: 'terminal', label: 'Вывод', onClick: () => { setBottomTab('console'); setBottomOpen(true); } },
    { sep: true },
    { icon: 'plug', label: ports.length ? `Порт: ${port || 'не выбран'}` : 'Порты не найдены', disabled: true },
    { icon: 'refresh', label: 'Обновить порты и платы', onClick: () => { void refreshPorts(); void refreshBoards(); void refreshCli(); } },
    ...(cli?.ok ? [] : [{ icon: 'down', label: 'Установить arduino-cli', onClick: () => void installCli() } as MenuEntry]),
  ];

  const helpMenu: MenuEntry[] = [
    { icon: 'book', label: 'Справочник по API (офлайн)', onClick: () => { setSideTab('reference'); if (!prefs.showSidebar) set({ showSidebar: true }); } },
    { icon: 'book', label: 'Документация по скетчу', onClick: () => { setBottomTab('analysis'); setBottomOpen(true); } },
    { sep: true },
    { icon: 'info', label: 'О программе', onClick: () => setDlg('about') },
    { icon: 'info', label: 'Горячие клавиши', onClick: () => setDlg('hotkeys') },
    { sep: true },
    { icon: 'refresh', label: 'Репозиторий на GitHub', onClick: () => window.open('https://github.com/danilka-revin/micro-pide', '_blank') },
  ];

  function duplicateLine() {
    const v = edView.current;
    if (!v) return;
    const { state } = v;
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    const insert = state.doc.sliceString(line.from, line.to);
    v.dispatch({ changes: { from: line.to, insert: '\n' + insert }, selection: { anchor: pos + insert.length + 1 } });
  }

  function toggleComment() {
    const v = edView.current;
    if (!v) return;
    const { state } = v;
    const sel = state.selection.main;
    const fromLine = state.doc.lineAt(sel.from).number;
    const toLine = state.doc.lineAt(sel.to).number;
    const changes: { from: number; to?: number; insert?: string }[] = [];
    let allCommented = true;
    for (let n = fromLine; n <= toLine; n++) {
      const line = state.doc.line(n);
      if (!line.text.trim()) continue;
      if (!line.text.trimStart().startsWith('//')) allCommented = false;
    }
    for (let n = fromLine; n <= toLine; n++) {
      const line = state.doc.line(n);
      if (!line.text.trim()) continue;
      if (allCommented) {
        const idx = line.text.indexOf('//');
        changes.push({ from: line.from + idx, to: line.from + idx + 2 });
      } else {
        const indent = line.text.length - line.text.trimStart().length;
        changes.push({ from: line.from + indent, insert: '// ' });
      }
    }
    if (changes.length) v.dispatch({ changes });
  }

  // ---------------- рендер ----------------
  const boardValue = boardLabel || fqbn;
  const busyTop = building || uploading;

  return (
    <>
      {/* ============================== шапка ============================== */}
      <header className="toolbar">
        <div className="brand">
          <span className="brandmark"><img src="/icon.svg" alt="" /></span>
          <span className="brandtext">
            <b>Micro<em>PIDE</em></b>
            <small>СРЕДА ARDUINO · СБОРКА · ПРОШИВКА</small>
          </span>
        </div>

        <MenuBtn label="Файл" title="Файл" items={fileMenu} />
        <MenuBtn label="Правка" title="Правка" items={editMenu} />
        <MenuBtn label="Скетч" title="Скетч" items={sketchMenu} />
        <MenuBtn label="Инструменты" title="Инструменты" items={toolsMenu} />
        <MenuBtn label="Справка" title="Справка" items={helpMenu} />

        <div className="tb-group">
          <button
            className={'tb-btn verify' + (building ? ' busy' : '')}
            title="Проверить / Компилировать (Ctrl+R)" onClick={() => void doVerify()} disabled={busyTop}
          ><Ic n="verify" /></button>
          <button
            className={'tb-btn upload' + (uploading ? ' busy' : '')}
            title="Загрузить в плату (Ctrl+U)" onClick={() => void doUpload()} disabled={busyTop}
          ><Ic n="upload" /></button>
        </div>

        <div className="tb-group">
          <div className="tb-sel-w">
            <span className="tb-sel-lab">Плата</span>
            <select className="tb-sel" style={{ width: 168 }} value={fqbn}
              onChange={(e) => {
                const v = e.target.value;
                setFqbn(v);
                setBoardLabel(boards.find((b) => b.fqbn === v)?.name || '');
              }}
              title={boardLabel || 'Выберите плату'}>
              <option value="">{boards.length ? '— выберите плату —' : 'платы недоступны'}</option>
              {boards.map((b) => <option key={b.fqbn} value={b.fqbn}>{b.name}</option>)}
            </select>
          </div>
          <div className="tb-sel-w">
            <span className="tb-sel-lab">Порт</span>
            <select className="tb-sel" style={{ width: 130 }} value={port}
              onChange={(e) => setPort(e.target.value)} title={port || 'Выберите порт'}>
              <option value="">{ports.length ? '— без порта —' : 'порты не найдены'}</option>
              {ports.map((p) => <option key={p.address} value={p.address}>{p.address}</option>)}
            </select>
          </div>
          <button className="tb-btn" title="Обновить порты и платы" onClick={() => { void refreshPorts(); void refreshBoards(); }}>
            <Ic n="refresh" size={15} />
          </button>
        </div>

        <div className="tb-group">
          <button
            className={'tb-btn' + (prefs.showSidebar ? ' active' : '')}
            title="Боковая панель (скетчи, примеры, библиотеки, платы)"
            onClick={() => set({ showSidebar: !prefs.showSidebar })}
          ><Ic n="inventory" size={16} /></button>
          <button
            className={'tb-btn' + (bottomOpen ? ' active' : '')}
            title="Панель низа (вывод, монитор порта)"
            onClick={() => setBottomOpen((v) => !v)}
          ><Ic n="terminal" size={16} /></button>
          <button
            className="tb-btn"
            title={prefs.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            onClick={() => set({ theme: prefs.theme === 'dark' ? 'light' : 'dark' })}
          ><Ic n={prefs.theme === 'dark' ? 'sun' : 'moon'} size={16} /></button>
        </div>

        <div className="tb-group">
          {updater.Button}
          <button className="tb-btn" title="Настройки (Ctrl+,)" onClick={() => setSettingsOpen(true)}>
            <Ic n="gear" size={16} />
          </button>
        </div>
      </header>

      {/* ============================== рабочая область ============================== */}
      <div className="work">
        {prefs.showSidebar && (
          <aside className="sidebar" style={prefs.compactUi ? { width: 230 } : undefined}>
            <div className="side-tabs">
              {SIDE_TABS.map((t) => (
                <button key={t.id} className={'side-tab' + (sideTab === t.id ? ' active' : '')} onClick={() => setSideTab(t.id)} title={t.label}>
                  <Ic n={t.icon} size={17} />
                  {t.label}
                </button>
              ))}
            </div>
            <div className="side-body">
              {sideTab === 'sketchbook' && (
                <SketchbookPanel
                  active={sideTab === 'sketchbook'}
                  sys={sys}
                  currentName={loadedFrom}
                  onOpen={openSketch}
                  onNew={() => { setDlgText('Sketch' + (sketchbook.length + 1)); setDlg('new'); }}
                  onDelete={(n) => setConfirmDel(n)}
                  onImport={(n) => openSketch(n)}
                  onToast={say}
                />
              )}
              {sideTab === 'examples' && (
                <ExamplesPanel cli={cli} onOpen={openExample} onToast={say} />
              )}
              {sideTab === 'libs' && (
                <LibsPanel cli={cli} onToast={say} refreshKey={hwKey + sketchbook.length} />
              )}
              {sideTab === 'vault' && (
                <VaultPanel
                  active={sideTab === 'vault'}
                  fqbn={fqbn}
                  onPickBoard={(label, f) => { setFqbn(f); setBoardLabel(label); say(`Плата: ${label}`); }}
                  onToast={say}
                  onLog={(l) => log(l)}
                />
              )}
              {sideTab === 'reference' && (
                <ReferencePanel
                  active={sideTab === 'reference'}
                  onInsert={(code) => insertIntoEditor(code)}
                  onToast={say}
                />
              )}
              {sideTab === 'boards' && (
                <BoardsPanel
                  cli={cli}
                  onInstallCli={() => void installCli()}
                  onPickBoard={(label, f) => { setFqbn(f); setBoardLabel(label); say(`Плата: ${label}`); }}
                  fqbn={fqbn}
                  onToast={say}
                  refreshKey={hwKey}
                />
              )}
            </div>
          </aside>
        )}

        <main className="main">
          {/* вкладки файлов */}
          <div className="tabs">
            {files.map((f, i) => (
              <div
                key={f.path + i}
                className={'tab' + (activeFile === i ? ' active' : '') + (f.dirty ? ' item-dirty' : '')}
                onClick={() => setActiveFile(i)}
                title={f.path}
              >
                <span className="ic"><Ic n={iconName(f.path)} size={14} /></span>
                {f.path}
                {files.length > 1 && (
                  <span className="x" title="Закрыть файл" onClick={(e) => { e.stopPropagation(); closeFile(i); }}>
                    <Ic n="close" size={11} />
                  </span>
                )}
              </div>
            ))}
            <div style={{ flex: 1 }} />
            <button
              className="tb-btn" title="Добавить файл в скетч (новая вкладка)"
              style={{ width: 26, marginRight: 4, alignSelf: 'center' }}
              onClick={() => { const n = prompt('Имя файла (например, helpers.h):'); if (n) addFile(n); }}
            ><Ic n="new" size={14} /></button>
          </div>

          {/* редактор */}
          {files[activeFile] ? (
            <CodeEditor
              key={files[activeFile].path}
              path={files[activeFile].path}
              value={files[activeFile].content}
              onChange={(v) => setFileContent(activeFile, v)}
              opts={{ fontSize: prefs.fontSize, wordWrap: prefs.wordWrap, showWhitespace: prefs.showWhitespace }}
              onSave={() => void doSave()}
              onVerify={() => void doVerify()}
              onUpload={() => void doUpload()}
              onReady={(v) => { edView.current = v ?? null; }}
              goto={gotoLine}
            />
          ) : (
            <div className="ed-wrap"><div className="empty">Нет открытых файлов</div></div>
          )}

          {/* панель низа */}
          <section className={'bottom' + (bottomOpen ? '' : ' closed') + (bottomMax ? ' max' : '')}>
            <div className="bottom-tabs">
              <button className={'bottom-tab' + (bottomTab === 'console' ? ' active' : '')} onClick={() => { setBottomTab('console'); setBottomOpen(true); }}>
                <Ic n="terminal" size={14} />Вывод
              </button>
              <button className={'bottom-tab' + (bottomTab === 'serial' ? ' active' : '')} onClick={() => { setBottomTab('serial'); setBottomOpen(true); }}>
                <Ic n="monitor" size={14} />Монитор порта
              </button>
              <button className={'bottom-tab' + (bottomTab === 'plot' ? ' active' : '')} onClick={() => { setBottomTab('plot'); setBottomOpen(true); }}>
                <Ic n="plot" size={14} />Графики
              </button>
              <button className={'bottom-tab' + (bottomTab === 'telemetry' ? ' active' : '')} onClick={() => { setBottomTab('telemetry'); setBottomOpen(true); }}>
                <Ic n="plot" size={14} />Телеметрия
              </button>
              <button className={'bottom-tab' + (bottomTab === 'analysis' ? ' active' : '')} onClick={() => { setBottomTab('analysis'); setBottomOpen(true); }}>
                <Ic n="find" size={14} />Анализ
              </button>
              <button className={'bottom-tab' + (bottomTab === 'tests' ? ' active' : '')} onClick={() => { setBottomTab('tests'); setBottomOpen(true); }}>
                <Ic n="check" size={14} />Тесты
              </button>
              <button className={'bottom-tab' + (bottomTab === 'history' ? ' active' : '')} onClick={() => { setBottomTab('history'); setBottomOpen(true); }}>
                <Ic n="clock" size={14} />История
              </button>
              <div className="bottom-tools">
                <button className="tb-btn" title={bottomMax ? 'Восстановить размер' : 'На весь экран'} onClick={() => setBottomMax((v) => !v)}>
                  <Ic n={bottomMax ? 'fit' : 'zoomin'} size={14} />
                </button>
                <button className="tb-btn" title="Скрыть панель" onClick={() => setBottomOpen(false)}>
                  <Ic n="close" size={14} />
                </button>
              </div>
            </div>
            {bottomOpen && (
              <div className="bottom-body" style={{ display: bottomTab === 'console' ? 'flex' : 'none' }}>
                <ConsoleView lines={conLines} empty="Здесь появится вывод компиляции и прошивки." />
              </div>
            )}
            {bottomOpen && bottomTab === 'serial' && (
              <div className="bottom-body">
                <SerialMonitor
                  ports={ports}
                  prefs={prefs}
                  set={set}
                  port={port}
                  setPort={setPort}
                  onLog={(kind, text) => log(text, kind === 'err' ? 'err' : undefined)}
                />
              </div>
            )}
            {bottomOpen && bottomTab === 'plot' && (
              <div className="bottom-body">
                <SerialPlotter ports={ports} prefs={prefs} set={set} port={port} setPort={setPort} active={bottomTab === 'plot' && bottomOpen} />
              </div>
            )}
            {bottomOpen && bottomTab === 'telemetry' && (
              <div className="bottom-body">
                <TelemetryPanel
                  active={bottomTab === 'telemetry' && bottomOpen}
                  ports={ports}
                  port={port}
                  setPort={setPort}
                  prefs={prefs}
                  onLog={(t, k) => log(t, k)}
                />
              </div>
            )}
            {bottomOpen && bottomTab === 'analysis' && (
              <div className="bottom-body">
                <AnalysisPanel
                  active={bottomTab === 'analysis' && bottomOpen}
                  files={sketchFiles()}
                  fqbn={fqbn || 'micropide:sim:sim'}
                  boardLabel={boardLabel}
                  baud={prefs.serialBaud}
                  sketchName={sketchName}
                  onToast={say}
                  onGoto={goToLine}
                  onApplyFiles={(nf) => { applyFiles(nf); say('Правка применена'); }}
                  onAddFile={(p, c) => { addOrReplaceFile(p, c); say(`Файл ${p} добавлен в скетч`); }}
                />
              </div>
            )}
            {bottomOpen && bottomTab === 'tests' && (
              <div className="bottom-body">
                <TestsPanel
                  active={bottomTab === 'tests' && bottomOpen}
                  files={sketchFiles()}
                  sketchName={sketchName}
                  port={port}
                  onToast={say}
                  onLog={(l) => log(l)}
                />
              </div>
            )}
            {bottomOpen && bottomTab === 'history' && (
              <div className="bottom-body">
                <HistoryPanel
                  active={bottomTab === 'history' && bottomOpen}
                  sketchName={loadedFrom || sketchName}
                  files={sketchFiles()}
                  onRestore={(nf) => { applyFiles(nf); say('Версия восстановлена'); }}
                  onToast={say}
                />
              </div>
            )}
          </section>
        </main>
      </div>

      {/* ============================== строка состояния ============================== */}
      {prefs.statusBar && (
        <footer className="status">
          <span className="lg">
            <span className={'pulse ' + (cli ? (cli.ok ? '' : 'err') : 'off')} />
            {cli === null ? 'сервер недоступен' : cli.ok ? `arduino-cli ${cli.version}` : 'свой движок MicroPIDE (arduino-cli нет)'}
          </span>
          <span title={fqbn}>Плата: <b>{boardValue || '—'}</b></span>
          <span>Порт: <b>{port || '—'}</b></span>
          {busyTop && <span className="pulse-info">{uploading ? 'Прошивка…' : 'Сборка…'}</span>}
          <span className="sp" />
          {dirty && <span style={{ color: 'var(--accent-text)' }}>есть несохранённые изменения</span>}
          <span title="Версия сборки">{version || ''}</span>
        </footer>
      )}

      {/* ============================== диалоги ============================== */}
      {dlg === 'new' && (
        <Modal
          title="Новый скетч"
          onClose={() => setDlg('')}
          foot={<>
            <button className="btn" onClick={() => setDlg('')}>Отмена</button>
            <button className="btn primary" onClick={() => newSketch(dlgText)}>Создать</button>
          </>}
        >
          {dirty && <p style={{ marginTop: 0 }}>Текущий скетч не сохранён — изменения будут потеряны.</p>}
          <div className="field">
            <label>Имя</label>
            <input className="txt" autoFocus value={dlgText} onChange={(e) => setDlgText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') newSketch(dlgText); }} ref={nameInput} />
          </div>
          <p className="hint">Будет создан скетч с шаблоном Blink. Сохраните его в скетчбук (Ctrl+S).</p>
        </Modal>
      )}

      {dlg === 'saveas' && (
        <Modal
          title="Сохранить скетч как"
          onClose={() => setDlg('')}
          foot={<>
            <button className="btn" onClick={() => setDlg('')}>Отмена</button>
            <button className="btn primary" onClick={() => void doSaveAs(dlgText)}>Сохранить</button>
          </>}
        >
          <div className="field">
            <label>Имя</label>
            <input className="txt" autoFocus value={dlgText} onChange={(e) => setDlgText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doSaveAs(dlgText); }} />
          </div>
          <p className="hint">Скетч сохраняется в каталог скетчбука на сервере: {cli?.sketchbook || ''}</p>
        </Modal>
      )}

      {dlg === 'rename' && (
        <Modal
          title="Переименовать скетч"
          onClose={() => setDlg('')}
          foot={<>
            <button className="btn" onClick={() => setDlg('')}>Отмена</button>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await api.sketchRename(loadedFrom, dlgText);
                  setSketchName(dlgText); setLoadedFrom(dlgText); setDlg('');
                  void reloadSketchbook();
                } catch (e) { say('Не удалось: ' + (e instanceof Error ? e.message : String(e))); }
              }}
            >Переименовать</button>
          </>}
        >
          <div className="field">
            <label>Новое имя</label>
            <input className="txt" autoFocus value={dlgText} onChange={(e) => setDlgText(e.target.value)} />
          </div>
        </Modal>
      )}

      {dlg === 'about' && (
        <Modal title="О программе" onClose={() => setDlg('')}
          foot={<button className="btn primary" onClick={() => setDlg('')}>Закрыть</button>}>
          <p>
            <b>MicroPIDE</b> — свободная среда разработки для Arduino: редактор скетчей, компиляция,
            прошивка, монитор порта и построитель графиков. Дизайн, темы, пресеты и автообновление
            унаследованы от PSBees (linux_pcb_app).
          </p>
          <p>Сборка и прошивка выполняются утилитой <span className="mono">arduino-cli</span> на вашем компьютере.</p>
          {version && <p className="hint">Версия сборки: <span className="mono">{version}</span></p>}
        </Modal>
      )}

      {dlg === 'hotkeys' && (
        <Modal title="Горячие клавиши" onClose={() => setDlg('')}
          foot={<button className="btn primary" onClick={() => setDlg('')}>Закрыть</button>}>
          <ul>
            <li><span className="kbd">Ctrl+R</span> — проверить (компилировать)</li>
            <li><span className="kbd">Ctrl+U</span> — загрузить в плату</li>
            <li><span className="kbd">Ctrl+S</span> — сохранить</li>
            <li><span className="kbd">Ctrl+N</span> — новый скетч</li>
            <li><span className="kbd">Ctrl+O</span> — открыть из скетчбука</li>
            <li><span className="kbd">Ctrl+F</span> — найти</li>
            <li><span className="kbd">Ctrl+Space</span> — подсказки кода (стрелки + Tab)</li>
            <li><span className="kbd">Ctrl+/</span> — закомментировать строку</li>
            <li><span className="kbd">Ctrl+Shift+M</span> — монитор порта</li>
            <li><span className="kbd">Ctrl+,</span> — настройки</li>
          </ul>
        </Modal>
      )}

      {confirmDel && (
        <ConfirmDialog
          title="Удалить скетч?"
          text={`Скетч «${confirmDel}» будет удалён с диска безвозвратно.`}
          ok="Удалить" danger
          onOk={async () => {
            try { await api.sketchDelete(confirmDel); } catch { /* ignore */ }
            if (loadedFrom === confirmDel) setLoadedFrom('');
            setConfirmDel('');
            void reloadSketchbook();
          }}
          onClose={() => setConfirmDel('')}
        />
      )}

      {simOpen && (
        <SimDialog
          open={simOpen}
          files={sketchFiles()}
          sketchName={sketchName}
          onClose={() => setSimOpen(false)}
          onLog={(l) => log(l)}
          onToast={say}
        />
      )}

      {mapOpen && (
        <Modal
          title="Карта памяти"
          onClose={() => setMapOpen(false)}
          foot={<button className="btn primary" onClick={() => setMapOpen(false)}>Закрыть</button>}
        >
          {mapData?.loading && <p>Читаю .elf последней сборки…</p>}
          {mapData && !mapData.loading && !mapData.ok && (
            <p className="hint">Не получилось: {mapData.error || 'неизвестная причина'}</p>
          )}
          {mapData?.ok && (
            <>
              <div className="row">
                {Object.entries(mapData.bySection || {}).map(([k, v]) => (
                  <span key={k} className="badge">{k}: {String(v)} Б</span>
                ))}
                <span className="badge">{mapData.fqbn}</span>
              </div>
              <table className="tbl">
                <thead><tr><th>Размер</th><th>Секция</th><th>Символ</th></tr></thead>
                <tbody>
                  {(mapData.top || mapData.all || []).slice(0, 40).map((x: any, i: number) => (
                    <tr key={i}><td>{x.size}</td><td className="dim">{x.section}</td><td className="mono">{x.name}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">Топ символов по размеру: сразу видно, что «съело» флеш и ОЗУ.</p>
            </>
          )}
        </Modal>
      )}

      {matrixOpen && (
        <Modal
          title="Сборка под несколько плат"
          onClose={() => setMatrixOpen(false)}
          foot={<>
            <button className="btn" onClick={() => setMatrixOpen(false)}>Закрыть</button>
            <button className="btn primary" onClick={() => void runMatrix()}>Собрать ({matrixPicked.length})</button>
          </>}
        >
          <p className="hint">Один и тот же скетч собирается под каждую выбранную плату своим движком — видно, где он не влезает по памяти.</p>
          <div className="mtrx">
            {boards.map((b) => (
              <label key={b.fqbn} className="chk">
                <input
                  type="checkbox"
                  checked={matrixPicked.includes(b.fqbn)}
                  onChange={(e) => setMatrixPicked((cur) => (e.target.checked ? [...cur, b.fqbn] : cur.filter((x) => x !== b.fqbn)))}
                />
                {b.name}
              </label>
            ))}
            {!boards.length && <p className="hint">Платы не загружены — откройте панель «Платы» или «Склад».</p>}
          </div>
          {!!matrixRows.length && (
            <table className="tbl">
              <thead><tr><th>Плата</th><th>Флеш</th><th>ОЗУ</th><th></th></tr></thead>
              <tbody>
                {matrixRows.map((r) => (
                  <tr key={r.fqbn} className={r.ok ? '' : 'bad-row'}>
                    <td>{r.name}</td>
                    <td>{r.flash != null ? `${r.flash} Б${r.pctFlash != null ? ` (${r.pctFlash}%)` : ''}` : '—'}</td>
                    <td>{r.ram != null ? `${r.ram} Б${r.pctRam != null ? ` (${r.pctRam}%)` : ''}` : '—'}</td>
                    <td>{r.ok ? '✓' : '✗ ' + (r.error || '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}

      {settingsOpen && (
        <SettingsWindow
          prefs={prefs}
          set={set}
          reset={reset}
          onClose={() => setSettingsOpen(false)}
          onOpenUpdater={() => updater.open()}
          version={version}
          sys={sys}
          onSysChanged={() => { void refreshSys(); void refreshCli(); void reloadSketchbook(); }}
        />
      )}

      {updater.Dialog}

      {toast && (
        <div className="upd-toast" style={{ zIndex: 130 }}>
          <span className="upd-toast-ico"><Ic n="info" size={18} /></span>
          <span className="upd-toast-body"><span>{toast}</span></span>
        </div>
      )}
    </>
  );
}
