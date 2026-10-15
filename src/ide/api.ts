// Клиент API сервера MicroPIDE. Все запросы однопроходные (fetch),
// кроме сборки/прошивки и монитора порта — там стриминг.
export interface CliInfo {
  ok: boolean;
  path: string | null;
  version: string;
  error: string | null;
  dataDir: string;
  sketchbook: string;
}

export interface SerialPortInfo {
  address: string;
  protocol: string;
  boardName: string;
  fqbn: string;
}

export interface Core {
  id: string;
  name: string;
  version: string;
  latest?: string;
  installed?: string;
  boards: { name: string; fqbn: string }[];
}

export interface LibInfo {
  name: string;
  version: string;
  author: string;
  sentence: string;
  releases?: number;
  category?: string;
}

export interface SketchFile { path: string; content: string; size?: number }
export interface SketchInfo { name: string; mtime: number; files: { path: string; size: number }[] }

export interface SystemInfo {
  ok: boolean;
  dataDir: string;
  sketchbook: string;
  sketchbookExists: boolean;
  useSystem: boolean;
  systemFound: boolean;
  systemSketchbook: string;
  systemData: string;
  config: { sketchbook?: string | null; useSystemArduino?: boolean | null };
}

async function getJson(url: string, timeout = 120_000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: 'Сервер вернул не JSON' }; }
  } finally { clearTimeout(t); }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: 'Сервер вернул не JSON' }; }
}

export const api = {
  system: (): Promise<SystemInfo> => getJson('/api/system', 20_000),
  configGet: (): Promise<{ config: SystemInfo['config'] }> => getJson('/api/config', 20_000),
  configSet: (patch: { sketchbook?: string | null; useSystemArduino?: boolean | null }): Promise<any> =>
    postJson('/api/config', patch),
  cli: (): Promise<CliInfo> => getJson('/api/cli', 20_000),
  installCli: (onLine: (s: string) => void): Promise<void> =>
    streamPost('/api/cli/install', {}, onLine),

  ports: (): Promise<{ ok: boolean; ports: SerialPortInfo[]; err: string | null }> => getJson('/api/ports'),
  cores: (): Promise<{ ok: boolean; cores: (Core & { source?: string })[]; err: string | null; via?: string }> => getJson('/api/cores'),
  coresSearch: (q: string): Promise<{ ok: boolean; cores: Core[]; err: string | null }> =>
    getJson('/api/cores/search?q=' + encodeURIComponent(q), 180_000),
  coreInstall: (id: string, onLine: (s: string) => void): Promise<void> =>
    streamPost('/api/cores/install', { id }, onLine),
  coreRemove: (id: string): Promise<any> => postJson('/api/cores/remove', { id }),
  boards: (): Promise<{ ok: boolean; boards: { name: string; fqbn: string }[]; err: string | null }> => getJson('/api/boards', 180_000),

  libs: (): Promise<{ ok: boolean; libs: (LibInfo & { source?: string })[]; err: string | null }> => getJson('/api/libs'),
  libsSearch: (q: string): Promise<{ ok: boolean; libs: LibInfo[]; err: string | null }> =>
    getJson('/api/libs/search?q=' + encodeURIComponent(q), 180_000),
  libInstall: (name: string, onLine: (s: string) => void): Promise<void> =>
    streamPost('/api/libs/install', { name }, onLine),
  libRemove: (name: string): Promise<any> => postJson('/api/libs/remove', { name }),

  examples: (): Promise<{ ok: boolean; groups: { name: string; examples: { name: string; path: string; sketches: { name: string; path: string }[] }[] }[]; err: string | null }> =>
    getJson('/api/examples', 180_000),

  sketches: (): Promise<{ ok: boolean; sketchbook: string; useSystem: boolean; systemFound: boolean; sketches: SketchInfo[] }> => getJson('/api/sketches'),
  exampleGet: (path: string): Promise<{ ok?: boolean; files: SketchFile[]; name: string; error?: string }> =>
    getJson('/api/example/get?path=' + encodeURIComponent(path)),
  sketchGet: (name: string): Promise<{ ok?: boolean; files: SketchFile[]; name: string; error?: string }> =>
    getJson('/api/sketches/get?name=' + encodeURIComponent(name)),
  sketchSave: (name: string, files: SketchFile[]): Promise<any> => postJson('/api/sketches/save', { name, files }),
  sketchDelete: (name: string): Promise<any> => postJson('/api/sketches/delete', { name }),
  sketchRename: (from: string, to: string): Promise<any> => postJson('/api/sketches/rename', { from, to }),

  build: (args: { name: string; fqbn: string; files: SketchFile[]; verbose: boolean }, onLine: (s: string) => void): Promise<void> =>
    streamPost('/api/build', args, onLine),
  upload: (args: { name: string; fqbn: string; port: string; files: SketchFile[]; verbose: boolean }, onLine: (s: string) => void): Promise<void> =>
    streamPost('/api/upload', args, onLine),

  serialOpen: (port: string, baud: number): Promise<any> => postJson('/api/serial/open', { port, baud }),
  serialClose: (): Promise<any> => postJson('/api/serial/close', {}),
  serialSend: (text: string): Promise<any> => postJson('/api/serial/send', { text }),

  // ---------------- свои подсистемы MicroPIDE ----------------
  // каталог плат и карта пинов — из встроенной базы, без arduino-cli и без сети
  boardsCatalog: (q = ''): Promise<BoardsCatalog> => getJson('/api/boards/catalog?q=' + encodeURIComponent(q), 20_000),
  boardInfo: (fqbn: string): Promise<any> => getJson('/api/boards/info?fqbn=' + encodeURIComponent(fqbn), 20_000),
  boardDetect: (vid: string, pid: string, name = ''): Promise<any> =>
    getJson(`/api/boards/detect?vid=${encodeURIComponent(vid)}&pid=${encodeURIComponent(pid)}&name=${encodeURIComponent(name)}`, 20_000),
  boardDefine: (board: Record<string, unknown>): Promise<any> => postJson('/api/boards/define', board),

  // анализ скетча: линтер под конкретную плату, карта пинов, профиль
  analyze: (args: { files: SketchFile[]; fqbn: string; baud?: number; name?: string }): Promise<AnalyzeResult> =>
    postJson('/api/analyze', args),
  analyzeDocs: (args: { files: SketchFile[]; fqbn: string; name?: string }): Promise<any> => postJson('/api/analyze/docs', args),
  analyzePins: (args: { files: SketchFile[]; fqbn: string; name?: string }): Promise<any> => postJson('/api/analyze/pins', args),
  analyzeTelemetry: (args: { channels: string[]; baud?: number; periodMs?: number }): Promise<any> => postJson('/api/analyze/telemetry', args),
  analyzeTelemetryExample: (channels: string[]): Promise<any> => postJson('/api/analyze/telemetry/example', { channels }),
  analyzeInstrument: (files: SketchFile[], periodMs = 1000): Promise<any> => postJson('/api/analyze/instrument', { files, periodMs }),
  analyzeFix: (files: SketchFile[], fix: Record<string, unknown>, file: string): Promise<any> =>
    postJson('/api/analyze/apply-fix', { files, fix, file }),

  // история: снимки, диффы, журнал сборок с размерами
  history: (): Promise<any> => getJson('/api/history', 20_000),
  historySnapshots: (name: string, limit = 50): Promise<any> => getJson(`/api/history/snapshots?name=${encodeURIComponent(name)}&limit=${limit}`, 20_000),
  historySnapshot: (name: string, files: SketchFile[], reason = 'manual', note = ''): Promise<any> =>
    postJson('/api/history/snapshot', { name, files, reason, note }),
  historyDiff: (name: string, a: string, b: string, files?: SketchFile[]): Promise<any> =>
    postJson('/api/history/diff', { name, a, b, files }),
  historyRestore: (name: string, id: string): Promise<any> => postJson('/api/history/restore', { name, id }),
  historyDelete: (name: string, id: string): Promise<any> => postJson('/api/history/delete', { name, id }),
  historyBuilds: (name = '', limit = 100): Promise<any> => getJson(`/api/history/builds?name=${encodeURIComponent(name)}&limit=${limit}`, 20_000),
  historyStats: (name = ''): Promise<any> => getJson('/api/history/stats?name=' + encodeURIComponent(name), 20_000),

  // автономность: склад, инструменты, свои индексы, зеркала
  offlineStatus: (): Promise<any> => getJson('/api/offline/status', 60_000),
  offlineTools: (): Promise<any> => getJson('/api/offline/tools', 60_000),
  offlinePlatforms: (): Promise<any> => getJson('/api/offline/platforms', 60_000),
  offlineVault: (): Promise<any> => getJson('/api/offline/vault', 60_000),
  offlineInspect: (file: string): Promise<any> => postJson('/api/offline/inspect', { file }),
  offlineImport: (args: { file: string; type?: string; id?: string; name?: string; version?: string }, onLine: (s: string) => void): Promise<any> =>
    streamPostResult('/api/offline/import', args, onLine),
  offlineDownload: (args: { kind: 'platform' | 'library' | 'urls'; id?: string; urls?: string[]; name?: string; import?: boolean }, onLine: (s: string) => void): Promise<any> =>
    streamPostResult('/api/offline/download', args, onLine),
  offlineUpload: async (file: File, opts: { type?: string; autoImport?: boolean } = {}, onLine: (s: string) => void): Promise<any> => {
    let result: any = null;
    const qs = `?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(opts.type || '')}&import=${opts.autoImport ? 1 : 0}`;
    const r = await fetch('/api/offline/upload' + qs, { method: 'POST', body: file });
    const text = await r.text();
    for (const line of text.split('\n')) {
      const m = /^#result (.*)$/.exec(line.trim());
      if (m) { try { result = JSON.parse(m[1]); } catch { /* ignore */ } continue; }
      if (line.trim()) onLine(line);
    }
    return result ?? { ok: r.ok, error: r.ok ? null : 'HTTP ' + r.status };
  },
  offlineMirrors: (): Promise<any> => getJson('/api/offline/mirrors', 20_000),
  offlineSetMirrors: (patch: Record<string, unknown>): Promise<any> => postJson('/api/offline/mirrors', patch),
  offlineIndexes: (): Promise<any> => postJson('/api/offline/indexes', {}),
  offlineUrls: (id?: string, lib?: string): Promise<any> =>
    getJson(`/api/offline/urls?id=${encodeURIComponent(id || '')}&lib=${encodeURIComponent(lib || '')}`, 20_000),

  // симулятор: скетч собирается под компьютер и выполняется по сценарию
  simStatus: (): Promise<any> => getJson('/api/sim/status', 60_000),
  simRun: (args: { name: string; files: SketchFile[]; scenario: string; timeoutMs?: number }, onLine: (s: string) => void): Promise<any> =>
    streamPostResult('/api/sim/run', args, onLine),

  // аппаратные тесты: один сценарий — и на плате, и в симуляторе
  tests: (): Promise<any> => getJson('/api/tests', 20_000),
  testGet: (name: string): Promise<any> => getJson('/api/tests/get?name=' + encodeURIComponent(name), 20_000),
  testSave: (args: { name: string; scenario: string; sketch?: string; baud?: number; note?: string }): Promise<any> => postJson('/api/tests/save', args),
  testDelete: (name: string): Promise<any> => postJson('/api/tests/delete', { name }),
  testDraft: (args: { files: SketchFile[]; baud?: number; duration?: number }): Promise<any> => postJson('/api/tests/draft', args),
  testRun: (args: { name: string; scenario: string; files: SketchFile[]; target: 'sim' | 'board'; port?: string; saveReport?: string | boolean }, onLine: (s: string) => void): Promise<any> =>
    streamPostResult('/api/tests/run', args, onLine),
  testReports: (): Promise<any> => getJson('/api/tests/reports', 20_000),
  testReport: (file: string): Promise<any> => getJson('/api/tests/report?file=' + encodeURIComponent(file), 20_000),

  // офлайн-справочник по API
  reference: (q = '', kind?: string, group?: string): Promise<ReferenceResult> =>
    getJson(`/api/reference?q=${encodeURIComponent(q)}${kind ? '&kind=' + encodeURIComponent(kind) : ''}${group ? '&group=' + encodeURIComponent(group) : ''}`, 20_000),
  referenceSnippet: (name: string): Promise<any> => getJson('/api/reference/snippet?name=' + encodeURIComponent(name), 20_000),

  // своя сборка и прошивка (когда arduino-cli недоступен)
  buildOwn: (args: { name: string; fqbn: string; files: SketchFile[]; verbose?: boolean }, onLine: (s: string) => void): Promise<any> =>
    streamPostResult('/api/build/own', args, onLine),
  buildMatrix: (args: { name: string; files: SketchFile[]; fqbns: string[] }, onLine: (s: string) => void): Promise<any> =>
    streamPostResult('/api/build/matrix', args, onLine),
  buildMap: (name: string): Promise<any> => getJson('/api/build/map?name=' + encodeURIComponent(name), 60_000),
  buildLast: (): Promise<any> => getJson('/api/build/last', 20_000),
  uploadOwn: (args: { name: string; fqbn: string; port: string; files: SketchFile[]; verbose?: boolean }, onLine: (s: string) => void): Promise<any> =>
    streamPostResult('/api/upload/own', args, onLine),
};

// ---------------- типы своих подсистем ----------------

export interface BoardCatalogItem {
  fqbn: string; name: string; source: string; vendor: string; arch: string; mcu: string;
  clock?: number; flash?: number; ram?: number; eeprom?: number; voltage?: number; led?: number;
  adcBits?: number; pwmBits?: number; pwm?: number; analog?: number; digital?: number; dac?: number;
  simulator?: boolean; uploadKind?: string; hints?: string[]; notes?: string;
}
export interface BoardsCatalog { ok: boolean; boards: BoardCatalogItem[]; query?: string }

export interface AnalyzeFinding {
  id: string; severity: 'error' | 'warn' | 'info'; file: string; line: number; col?: number;
  message: string; hint?: string; fix?: Record<string, unknown> | null; n?: number; text?: string;
}
export interface PinRecord {
  pin: number; label: string; roles: string[]; funcs: string[];
  outputs: boolean; inputs: boolean; pwm: boolean; adc: boolean; interrupt: boolean;
  inputOnly?: boolean; flash?: boolean; reserved?: string; led?: boolean; conflicts: string[]; notes: string[];
  /** Строки кода, где пин упоминается. */
  lines: number[];
}
export interface PinMapResult {
  ok: boolean; fqbn: string;
  board: { name: string; mcu: string; fqbn: string; flash?: number; ram?: number; adcBits?: number } | null;
  pins: PinRecord[]; free: number[]; byRole: Record<string, number>;
  stats: { used: number; free: number; total: number; pwmUsed: number; adcUsed: number; pwmFree: number[]; adcFree: number[]; conflicts: number };
  mermaid?: string;
}
export interface ScorePart { name: string; score: number; issues: number }
export interface AnalyzeResult {
  ok: boolean; fqbn: string; name?: string;
  board: { fqbn: string; name: string; mcu: string; flash: number; ram: number; adcBits?: number; pwmBits?: number; voltage?: number } | null;
  findings: AnalyzeFinding[]; issues?: AnalyzeFinding[];
  summary: { errors: number; warnings: number; infos: number; lines: number; files: number; functions: number; globals: number; includes: number; isrs: number; libs: string[] };
  score: { overall: number; grade: string; parts: ScorePart[] };
  pinMap?: PinMapResult; pins?: PinMapResult;
  profile?: any;
  functions?: { name: string; ret: string; args: string[]; file: string; line: number; isIsr?: boolean }[];
  installedLibs?: string[];
}
export interface ReferenceEntry {
  name: string; kind: string; sig?: string; group?: string; desc?: string; example?: string;
}
export interface ReferenceResult { ok?: boolean; total: number; entries: ReferenceEntry[]; groups?: { group: string; count: number }[]; kinds?: string[] }

/**
 * Потоковый POST, который вдобавок возвращает итог: сервер в конце потока пишет
 * строку «#result {json}» — её и разбираем (сборка, тесты, симулятор, склад).
 */
export async function streamPostResult(url: string, body: unknown, onLine: (s: string) => void): Promise<any> {
  let result: any = null;
  await streamPost(url, body, (line) => {
    const m = /^#result (.*)$/.exec(line.trim());
    if (m) { try { result = JSON.parse(m[1]); } catch { result = { ok: false, error: 'Не разобрать ответ сервера' }; } return; }
    onLine(line);
  });
  return result ?? { ok: false, error: 'Сервер не вернул результат' };
}

/** POST со стримингом текстового ответа построчно (сборка, прошивка, установка). */
export async function streamPost(url: string, body: unknown, onLine: (s: string) => void): Promise<void> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok && !r.body) {
    let msg = 'HTTP ' + r.status;
    try { msg = (await r.json())?.error || msg; } catch { /* ignore */ }
    onLine('✗ ' + msg);
    return;
  }
  if (!r.body) { onLine('✗ Пустой ответ сервера'); return; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}
