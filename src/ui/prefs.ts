// Общие настройки MicroPIDE (порт логики PSBees / linux_pcb_app).
//
// Здесь живёт то, что относится к программе целиком: тема, редактор,
// автосохранение, монитор порта, обновления. Всё хранится в localStorage
// под ключом micropide.prefs и читается один раз при старте: правка любой
// настройки применяется сразу, перезапуск не нужен.
import { useCallback, useState } from 'react';
import type { CustomColors, ThemeId } from './palette';
import { loadCustomColors, saveCustomColors } from './palette';

export const PREFS_KEY = 'micropide.prefs';

export interface Prefs {
  // ---------------- оформление ----------------
  /** базовая тема: тёмная или светлая */
  theme: ThemeId;
  /** свои цвета поверх темы (акцент, фон, панели, текст) */
  colors: CustomColors;

  // ---------------- редактор ----------------
  /** размер шрифта редактора кода, px */
  fontSize: number;
  /** перенос длинных строк */
  wordWrap: boolean;
  /** показывать пробелы и табы */
  showWhitespace: boolean;
  /** автосохранение черновика в браузере */
  autosave: boolean;
  /** как часто писать черновик, мс */
  autosaveMs: number;

  // ---------------- интерфейс ----------------
  /** боковая панель (скетч-бук, примеры, библиотеки, платы) */
  showSidebar: boolean;
  /** строка состояния внизу окна */
  statusBar: boolean;
  /** компактный интерфейс: плотнее шапка и панели */
  compactUi: boolean;

  // ---------------- монитор порта ----------------
  /** скорость порта по умолчанию */
  serialBaud: number;
  /** что отправлять в конце строки */
  serialEol: 'none' | 'nl' | 'cr' | 'crlf';
  /** автопрокрутка лога */
  serialAutoscroll: boolean;
  /** штампы времени у строк */
  serialTimestamps: boolean;
  /** байты, не попавшие в печатные символы, как \xNN */
  serialHex: boolean;

  // ---------------- сборка и прошивка ----------------
  /** показывать подробный вывод компиляции (verbose) */
  verboseBuild: boolean;
  /** сохранять скетч на диск перед сборкой/прошивкой */
  saveBeforeBuild: boolean;

  // ---------------- обновления ----------------
  /** проверять обновления при запуске */
  checkUpdates: boolean;

  // ---------------- окно настроек ----------------
  /** последний открытый раздел */
  setSection: string;
  /** размер окна настроек */
  setW: number;
  setH: number;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  colors: {},
  fontSize: 14,
  wordWrap: false,
  showWhitespace: false,
  autosave: true,
  autosaveMs: 600,
  showSidebar: true,
  statusBar: true,
  compactUi: false,
  serialBaud: 9600,
  serialEol: 'nl',
  serialAutoscroll: true,
  serialTimestamps: false,
  serialHex: false,
  verboseBuild: false,
  saveBeforeBuild: true,
  checkUpdates: true,
  setSection: 'general',
  setW: 0,
  setH: 0,
};

/** Прочитать настройки; битые значения заменяются значениями по умолчанию. */
export function loadPrefs(): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS, colors: loadCustomColors() };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return out;
    const o = JSON.parse(raw) as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
      if (k === 'theme') { if (o.theme === 'light' || o.theme === 'dark') out.theme = o.theme; continue; }
      if (k === 'colors') continue; // хранится отдельно (micropide.colors)
      const d = DEFAULT_PREFS[k], v = o[k];
      if (typeof v === typeof d) (out as unknown as Record<string, unknown>)[k] = v;
    }
  } catch { /* ignore */ }
  return out;
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    saveCustomColors(p.colors);
  } catch { /* ignore */ }
}

/** Хук настроек: единая точка правды + запись в localStorage на каждое изменение. */
export function usePrefs(): {
  prefs: Prefs;
  set: (patch: Partial<Prefs>) => void;
  reset: () => void;
} {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const set = useCallback((patch: Partial<Prefs>) => {
    setPrefs((cur) => {
      const next = { ...cur, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    setPrefs((cur) => {
      const next: Prefs = { ...DEFAULT_PREFS, theme: cur.theme, colors: cur.colors };
      savePrefs(next);
      return next;
    });
  }, []);
  return { prefs, set, reset };
}

/** Применить тему к <html> (data-theme) — вызывать при изменении prefs.theme. */
export function applyTheme(t: ThemeId): void {
  document.documentElement.dataset.theme = t;
}
