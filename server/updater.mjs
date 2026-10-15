// Движок автообновления MicroPIDE — перенос механики PSBees (linux_pcb_app,
// scripts/server.mjs + scripts/update.mjs), упрощённый до одного модуля.
//
//   GET  /update/check   — сверить установленную версию с веткой main на GitHub;
//   POST /update/run     — запустить обновление (git fetch+merge либо tar.gz);
//   GET  /update/status  — ход выполнения (long-poll: этапы, байты, скорость, ETA);
//   POST /update/cancel  — отменить обновление.
//
// Два пути обновления, как в PSBees:
//   • git-клон (есть .git, чистая рабочая копия на ветке обновления):
//     git fetch + merge --ff-only + npm ci (если lock изменился) + build;
//   • установленная программа (без .git): скачиваем tar.gz ветки через
//     codeload.github.com, ставим зависимости, собираем и подменяем файлы
//     программы по манифесту (dist + server + package*.json + run-скрипты).
// Сервер после установки перезапускается сам (process.env.MICRO_PIDE_RESTART).
import { spawn, execFile } from 'node:child_process';
import {
  mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync, renameSync,
  statSync, createWriteStream,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const DEFAULT_REPO = 'https://github.com/danilka-revin/micro-pide.git';
const IS_WIN = process.platform === 'win32';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => (s || '').slice(0, 7);
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/i.test(s.trim());
const firstLine = (s, n = 180) => String(s || '').split('\n').filter(Boolean)[0]?.slice(0, n) || '';

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 60_000, windowsHide: true, cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function githubJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'micro-pide', 'Accept': 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- состояние задания

export class Updater {
  constructor(appDir, root) {
    this.appDir = resolve(appDir);
    this.root = resolve(root);
    this.job = null;          // активное обновление
    this.rev = 0;             // версия состояния для long-poll
    this.waiters = new Set(); // ждущие long-poll ответы
    this.lastLatest = null;   // кэш последнего коммита ветки
  }

  snapshot() {
    const j = this.job;
    if (!j) return { status: 'idle', rev: this.rev };
    return {
      rev: this.rev,
      status: j.status,             // run | done | error | cancelled
      phase: j.phase,
      mode: j.mode,
      from: j.from, to: j.to,
      output: j.output.slice(-14_000),
      changes: j.changes,
      restart: j.restart,
      stages: j.stages,
      stage: j.stage,
      pct: j.pct,
      bytes: j.bytes, total: j.total, exact: j.exact,
      speed: j.speed, eta: j.eta, elapsed: j.elapsed,
      count: j.count, countTotal: j.countTotal,
      cancelable: j.cancelable,
    };
  }

  /** Применить правку состояния: пересчитать процент и разбудить ждущих. */
  touch(patch = {}) {
    const j = this.job;
    if (!j) return;
    Object.assign(j, patch);
    // процент: сумма весов завершённых этапов + доля текущего
    let done = 0, cur = 0;
    for (const s of j.stages) {
      if (s.state === 'done' || s.state === 'skip') done += s.weight;
      else if (s.state === 'run') cur += s.weight * (s.frac || 0);
    }
    j.pct = Math.max(0, Math.min(100, Math.round((done + cur))));
    const now = Date.now();
    j.elapsed = now - j.startedAt;
    if (j.down && j.down.total > 0 && j.down.at > 0) {
      const dt = (now - j.down.at) / 1000;
      j.speed = dt > 0.4 ? j.down.got / dt : j.speed;
      j.eta = j.speed > 1 ? Math.max(0, ((j.down.total - j.down.got) / j.speed) * 1000) : null;
      j.bytes = j.down.got;
      j.total = j.down.total;
      j.exact = true;
    } else {
      j.speed = 0;
      j.eta = null;
    }
    this.rev++;
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  log(line) {
    const j = this.job;
    if (!j) return;
    j.output += (j.output ? '\n' : '') + line;
    if (j.output.length > 40_000) j.output = j.output.slice(-30_000);
    this.touch();
  }

  stage(id, state, frac = 0, msg = '') {
    const j = this.job;
    if (!j) return;
    const s = j.stages.find((x) => x.id === id);
    if (!s) return;
    s.state = state;
    if (state === 'done' || state === 'skip') s.frac = 1;
    else s.frac = frac;
    if (msg) s.msg = msg;
    j.stage = state === 'done' || state === 'skip' ? j.stage : id;
    this.touch();
  }

  // ---------------------------------------------------------------- окружение

  async isGitClone() {
    try { statSync(join(this.appDir, '.git')); } catch { return false; }
    const r = await execFileP('git', ['-C', this.appDir, 'rev-parse', '--is-inside-work-tree'], { timeout: 10_000 });
    return !r.err && r.stdout.trim() === 'true';
  }

  async discoverRepo() {
    const u = await execFileP('git', ['-C', this.appDir, 'remote', 'get-url', 'origin'], { timeout: 10_000 });
    if (!u.err && u.stdout.trim()) return u.stdout.trim();
    try {
      const s = readFileSync(join(this.appDir, 'repo.txt'), 'utf8').trim();
      if (s) return s;
    } catch { /* нет файла */ }
    return DEFAULT_REPO;
  }

  repoInfo(url) {
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
    if (!m) return null;
    return { url, owner: m[1], name: m[2] };
  }

  async branch() {
    const b = await execFileP('git', ['-C', this.appDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 10_000 });
    if (!b.err && b.stdout.trim() && b.stdout.trim() !== 'HEAD') return b.stdout.trim();
    try {
      const s = readFileSync(join(this.appDir, 'branch.txt'), 'utf8').trim();
      if (s) return s;
    } catch { /* нет файла */ }
    return 'main';
  }

  async localVersion() {
    try {
      const v = JSON.parse(readFileSync(join(this.root, 'version.json'), 'utf8'));
      if (isSha(v.sha)) return { sha: v.sha, short: v.short || short(v.sha) };
    } catch { /* нет */ }
    try {
      const s = readFileSync(join(this.appDir, 'version.txt'), 'utf8').trim();
      if (isSha(s)) return { sha: s, short: short(s) };
    } catch { /* нет */ }
    if (await this.isGitClone()) {
      const h = await execFileP('git', ['-C', this.appDir, 'rev-parse', 'HEAD'], { timeout: 10_000 });
      if (!h.err && isSha(h.stdout)) return { sha: h.stdout.trim(), short: short(h.stdout.trim()) };
    }
    return { sha: '', short: '' };
  }

  /** Последний коммит ветки: git ls-remote и GitHub API наперегонки. */
  async latestOfBranch(branch) {
    if (this.lastLatest && Date.now() - this.lastLatest.at < 30_000) {
      const c = this.lastLatest;
      if (c.branch === branch) return { sha: c.sha, msg: c.msg };
    }
    const repoUrl = await this.discoverRepo();
    const repo = this.repoInfo(repoUrl);
    if (!repo) throw new Error('Не удалось определить репозиторий GitHub (нет repo.txt и git remote).');
    const viaGit = (async () => {
      const ls = await execFileP('git', ['ls-remote', repo.url, `refs/heads/${branch}`], { timeout: 20_000 });
      if (ls.err) throw new Error('git: ' + firstLine(ls.stderr || ls.err.message));
      const sha = (ls.stdout.match(/^([0-9a-f]{40})\s+refs\/heads\//m) || [])[1];
      if (!sha) throw new Error('GitHub не вернул коммит ветки ' + branch + '.');
      return { sha };
    })();
    const viaApi = githubJson(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(branch)}`)
      .then((c) => {
        if (!isSha(c.sha)) throw new Error('API: нет коммита');
        return { sha: c.sha, msg: (c.commit?.message || '').split('\n')[0] };
      });
    let out;
    try {
      out = await Promise.any([viaApi, viaGit]);
    } catch {
      out = await viaGit; // обе упали — покажем ошибку git
    }
    this.lastLatest = { branch, sha: out.sha, msg: out.msg || '', at: Date.now() };
    return out;
  }

  /** Проверка: что установлено и что вышло. */
  async check() {
    let branch = await this.branch();
    let local, latest;
    try {
      [local, latest] = await Promise.all([this.localVersion(), this.latestOfBranch(branch)]);
    } catch (e) {
      // в dev-клоне ветка может не существовать на GitHub (рабочая ветка сессии) — следим за main
      if (branch !== 'main') {
        branch = 'main';
        [local, latest] = await Promise.all([this.localVersion(), this.latestOfBranch(branch)]);
      } else throw e;
    }
    let behind = 0;
    if (local.sha && isSha(local.sha) && latest.sha !== local.sha) {
      try {
        const repo = this.repoInfo(await this.discoverRepo());
        // local...latest: ahead_by — на сколько latest впереди установленной версии
        const cmp = await githubJson(`https://api.github.com/repos/${repo.owner}/${repo.name}/compare/${local.sha}...${latest.sha}`);
        behind = cmp.status === 'ahead' || cmp.status === 'diverged' ? (cmp.ahead_by ?? 0) : 0;
      } catch { /* без сети посчитать не вышло — не страшно */ }
    }
    const gitTool = await execFileP('git', ['--version'], { timeout: 10_000 });
    const npmTool = await execFileP(IS_WIN ? 'npm.cmd' : 'npm', ['--version'], { timeout: 15_000 });
    const tooling = { git: !gitTool.err, npm: !npmTool.err };
    return {
      ok: true,
      branch,
      repo: this.repoInfo(await this.discoverRepo())?.url || '',
      // форма ответа — как в PSBees: локальная версия, последняя, отставание
      local: local.short || '',
      latest: short(latest.sha),
      latestSha: latest.sha,
      latestMsg: latest.msg || '',
      from: local.short || '',
      to: short(latest.sha),
      behind,
      updateAvailable: !!local.sha && latest.sha !== local.sha,
      tooling,
    };
  }

  // ---------------------------------------------------------------- запуск

  run() {
    if (this.job && this.job.status === 'run') return { ok: false, error: 'Обновление уже выполняется' };
    const j = {
      status: 'run',
      mode: 'unknown',
      phase: 'Запуск…',
      from: '', to: '',
      output: '', changes: 0, restart: false,
      stages: [
        { id: 'check', label: 'Проверка версии', weight: 3, state: 'run', frac: 0, msg: '' },
        { id: 'download', label: 'Скачивание', weight: 20, state: 'wait', frac: 0, msg: '' },
        { id: 'extract', label: 'Распаковка', weight: 3, state: 'wait', frac: 0, msg: '' },
        { id: 'deps', label: 'Зависимости', weight: 36, state: 'wait', frac: 0, msg: '' },
        { id: 'build', label: 'Сборка', weight: 33, state: 'wait', frac: 0, msg: '' },
        { id: 'install', label: 'Установка', weight: 5, state: 'wait', frac: 0, msg: '' },
      ],
      stage: 'check', pct: 0,
      bytes: 0, total: 0, exact: false, speed: 0, eta: null,
      elapsed: 0, count: 0, countTotal: 0,
      cancelable: false, startedAt: Date.now(),
      down: null,
      cancelRequested: false,
    };
    this.job = j;
    this.rev++;
    this._work(j).catch((e) => {
      if (j.status !== 'run') return;
      j.status = 'error';
      j.phase = firstLine(e?.message || String(e), 400);
      this.stage('check', 'error');
      this.touch();
    });
    return { ok: true };
  }

  cancel() {
    if (this.job && this.job.status === 'run') {
      this.job.cancelRequested = true;
      this.touch({ phase: 'Отмена…' });
      return { ok: true };
    }
    return { ok: false, error: 'Обновление не выполняется' };
  }

  requestCancel() { if (this.job) this.job.cancelRequested = true; }
  get cancelled() { return !!this.job?.cancelRequested; }

  async _work(j) {
    const gitMode = await this.isGitClone();
    j.mode = gitMode ? 'git' : 'tarball';
    const branch = await this.branch();

    // этап check
    this.stage('check', 'run');
    const local = await this.localVersion();
    j.from = local.short || '';
    const latest = await this.latestOfBranch(branch);
    j.to = short(latest.sha);
    if (local.sha && latest.sha === local.sha) {
      this.stage('check', 'done');
      j.status = 'done';
      j.phase = 'У вас уже последняя версия.';
      j.changes = 0;
      this.touch();
      return;
    }
    if (!local.sha) this.log('Установленная версия не определена — ставлю ветку ' + branch + ' целиком.');
    else this.log(`Обновление: ${local.short} → ${short(latest.sha)} (ветка ${branch})`);
    this.stage('check', 'done');

    if (this.cancelled) return this._cancel(j);

    if (gitMode) await this._runGit(j, branch, latest.sha);
    else await this._runTarball(j, branch, latest.sha);
  }

  _cancel(j) {
    j.status = 'cancelled';
    j.phase = 'Отменено.';
    this.touch();
  }

  _guard(j) {
    if (this.cancelled) { this._cancel(j); throw new Error('cancelled'); }
  }

  /** Git-путь: fetch + merge --ff-only. */
  async _runGit(j, branch, toSha) {
    const git = (args, opts = {}) => execFileP('git', ['-C', this.appDir, ...args], { timeout: 120_000, ...opts });

    // рабочая копия должна быть чистой и на нужной ветке
    const st = await git(['status', '--porcelain']);
    if (st.stdout.trim()) {
      throw new Error('Рабочая копия содержит изменения — обновление git-ом невозможно. Сохраните изменения или используйте установку без .git.');
    }
    const cur = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur.stdout.trim() !== branch) {
      throw new Error(`Рабочая копия на ветке «${cur.stdout.trim()}», а обновление следит за «${branch}». Переключите ветку.`);
    }
    j.cancelable = true; this.touch();

    this.stage('download', 'run');
    this.log('git fetch…');
    const f = await git(['fetch', '--prune', 'origin', branch]);
    if (f.err) throw new Error('git fetch: ' + firstLine(f.stderr || f.err.message));
    this.stage('download', 'done');

    this._guard(j);
    this.stage('extract', 'run');
    this.log('git merge --ff-only…');
    const m = await git(['merge', '--ff-only', `origin/${branch}`]);
    if (m.err) throw new Error('git merge: ' + firstLine(m.stderr || m.err.message));
    const head = await git(['rev-parse', 'HEAD']);
    j.to = short(head.stdout.trim());
    j.changes = 1;
    this.stage('extract', 'done');

    await this._depsAndBuild(j, this.appDir);
    j.restart = true;
    j.status = 'done';
    j.phase = 'Обновление установлено. Сервер перезапускается…';
    this.stage('install', 'done');
    this.touch();
  }

  /** Tarball-путь: codeload tar.gz ветки → deps → build → подмена файлов. */
  async _runTarball(j, branch, toSha) {
    const repo = this.repoInfo(await this.discoverRepo());
    if (!repo) throw new Error('Не удалось определить репозиторий GitHub.');
    const cache = join(this.appDir, '.update-cache');
    mkdirSync(cache, { recursive: true });

    j.cancelable = true; this.touch();

    // скачивание с прогрессом
    this.stage('download', 'run');
    this.log('Скачиваю исходники (tar.gz)…');
    const tgz = join(cache, 'src.tar.gz');
    const resp = await fetch(`https://codeload.github.com/${repo.owner}/${repo.name}/tar.gz/refs/heads/${branch}`);
    if (!resp.ok || !resp.body) throw new Error(`codeload: ${resp.status}`);
    const total = Number(resp.headers.get('content-length') || 0);
    j.down = { got: 0, total, at: Date.now() };
    let got = 0;
    const chunks = [];
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      j.down.got = got;
      if (!total) j.down.total = 0;
      this.stage('download', 'run', total ? got / total : 0);
      if (this.cancelled) { try { reader.cancel(); } catch { /* ignore */ } return this._cancel(j); }
    }
    await pipeline(
      (async function* () { for (const c of chunks) yield c; })(),
      createWriteStream(tgz),
    );
    const dlHash = createHash('sha1').update(got.toString()).digest('hex').slice(0, 6);
    this.log(`Скачано ${(got / 1048576).toFixed(1)} МБ (${dlHash}).`);
    this.stage('download', 'done');

    // распаковка
    this._guard(j);
    this.stage('extract', 'run');
    const srcDir = join(cache, 'src');
    rmSync(srcDir, { recursive: true, force: true });
    mkdirSync(srcDir, { recursive: true });
    const tar = await execFileP('tar', ['-xzf', tgz, '-C', srcDir, '--strip-components=1'], { timeout: 180_000 });
    if (tar.err) throw new Error('tar: ' + firstLine(tar.stderr || tar.err.message));
    this.log('Распаковано.');
    this.stage('extract', 'done');

    // зависимости + сборка в исходнике
    await this._depsAndBuild(j, srcDir);

    // установка: подмена файлов программы
    this._guard(j);
    this.stage('install', 'run');
    const RUNTIME = ['server', 'dist', 'public', 'scripts', 'package.json', 'package-lock.json', 'run.sh', 'run.cmd'];
    const backup = join(cache, 'backup');
    rmSync(backup, { recursive: true, force: true });
    mkdirSync(backup, { recursive: true });
    for (const name of RUNTIME) {
      const src = join(srcDir, name);
      const dst = join(this.appDir, name);
      if (!existsSync(src)) continue;
      if (existsSync(dst)) {
        try { cpSync(dst, join(backup, basename(name)), { recursive: true }); } catch { /* ignore */ }
        rmSync(dst, { recursive: true, force: true });
      }
      cpSync(src, dst, { recursive: true });
    }
    writeFileSync(join(this.appDir, 'version.txt'), toSha || '', 'utf8');
    writeFileSync(join(this.appDir, 'repo.txt'), repo.url, 'utf8');
    try { writeFileSync(join(this.appDir, 'branch.txt'), branch, 'utf8'); } catch { /* ignore */ }
    j.changes = 1;
    j.restart = true;
    this.stage('install', 'done');
    j.status = 'done';
    j.phase = 'Обновление установлено. Сервер перезапускается…';
    this.touch();
  }

  /** Зависимости (npm ci / переиспользование node_modules) и сборка vite. */
  async _depsAndBuild(j, dir) {
    const npm = IS_WIN ? 'npm.cmd' : 'npm';
    const env = { ...process.env, MICRO_PIDE_SKIP_RESTART: '1' };

    // зависимости
    this._guard(j);
    this.stage('deps', 'run');
    const curLock = (() => { try { return readFileSync(join(dir, 'package-lock.json'), 'utf8'); } catch { return ''; } })();
    const prevLock = (() => { try { return readFileSync(join(this.appDir, '.update-cache', 'last-lock'), 'utf8'); } catch { return ''; } })();
    const nmHere = existsSync(join(dir, 'node_modules'));
    const reuse = curLock && curLock === prevLock && existsSync(join(this.appDir, 'node_modules'));
    let depsOk = true;
    if (reuse) {
      this.log('package-lock.json не менялся — переиспользую node_modules.');
      this.stage('deps', 'done');
    } else {
      this.log('Устанавливаю зависимости (npm ci)…');
      const r = await execFileP(npm, ['ci', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: dir, timeout: 900_000, env });
      if (r.err) {
        depsOk = false;
        this.log('npm ci не удался: ' + firstLine(r.stderr || r.err.message, 300));
        // попробуем старые node_modules скопировать
        if (!nmHere && existsSync(join(this.appDir, 'node_modules'))) {
          this.log('Пробую существующие node_modules…');
          try { cpSync(join(this.appDir, 'node_modules'), join(dir, 'node_modules'), { recursive: true }); depsOk = true; } catch { depsOk = false; }
        }
        if (!depsOk) throw new Error('Не удалось установить зависимости');
      } else {
        this.stage('deps', 'done');
      }
    }
    if (curLock) {
      mkdirSync(join(this.appDir, '.update-cache'), { recursive: true });
      try { writeFileSync(join(this.appDir, '.update-cache', 'last-lock'), curLock); } catch { /* ignore */ }
    }

    // сборка
    this._guard(j);
    this.stage('build', 'run');
    this.log('Собираю фронтенд (vite build)…');
    const b = await execFileP(npm, ['run', 'build'], { cwd: dir, timeout: 900_000, env });
    if (b.err) {
      throw new Error('Сборка не удалась: ' + firstLine(b.stderr || b.stdout || b.err.message, 400));
    }
    this.log('Сборка готова.');
    this.stage('build', 'done');
  }
}
