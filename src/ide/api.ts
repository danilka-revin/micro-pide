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
};

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
