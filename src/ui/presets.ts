// Пресеты настроек — перенос из PSBees (linux_pcb_app): готовые темы
// оформления и свои пресеты пользователя. Плюс специфика MicroPIDE —
// пресеты вида интерфейса и параметров редактора.
//
// Встроенные пресеты — «заплатки» (Partial<…>) поверх текущих значений:
// применить пресет = setPrefs/setColors с этой заплаткой. Свои пресеты
// хранятся в localStorage под ключом micropide.presets и не трогаются
// сбросом настроек.
import { isHex, type CustomColors, type ThemeId } from './palette';
import type { Prefs } from './prefs';

export const PRESETS_KEY = 'micropide.presets';

// ------------------------------------------------------------------ темы

export interface ThemePreset {
  id: string;
  name: string;
  hint?: string;
  /** базовая тема: от неё берутся производные цвета и состояния */
  theme: ThemeId;
  /** перекрытия цветов (пусто — чистая тема) */
  colors: CustomColors;
  /** сохранён пользователем (можно удалить) */
  user?: boolean;
}

/** Готовые темы оформления. Первые две — фирменные «пчелиные» без перекрытий. */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'bee-dark', name: 'Пчела', hint: 'Фирменная тёмная: золото на графите', theme: 'dark', colors: {} },
  { id: 'bee-light', name: 'Пчела светлая', hint: 'Фирменная светлая — для печати и светлых помещений', theme: 'light', colors: {} },
  { id: 'midnight', name: 'Полночь', hint: 'Глубокий синий с голубым акцентом', theme: 'dark', colors: { accent: '#3fa9ff', page: '#0b1020', surface: '#111831', text: '#e6ecff' } },
  { id: 'nord', name: 'Nord', hint: 'Спокойная холодная палитра', theme: 'dark', colors: { accent: '#88c0d0', page: '#2e3440', surface: '#3b4252', text: '#eceff4' } },
  { id: 'dracula', name: 'Dracula', hint: 'Фиолетовый акцент на тёмно-сером', theme: 'dark', colors: { accent: '#bd93f9', page: '#1e1f29', surface: '#282a36', text: '#f8f8f2' } },
  { id: 'monokai', name: 'Monokai', hint: 'Классика редакторов кода', theme: 'dark', colors: { accent: '#a6e22e', page: '#1e1f1c', surface: '#272822', text: '#f8f8f2' } },
  { id: 'solar-dark', name: 'Solarized тёмная', hint: 'Мягкий контраст, меньше устают глаза', theme: 'dark', colors: { accent: '#b58900', page: '#002b36', surface: '#073642', text: '#eee8d5' } },
  { id: 'textolite', name: 'Текстолит', hint: 'Зелёная маска и золото — как настоящая плата', theme: 'dark', colors: { accent: '#e8c93e', page: '#06200f', surface: '#0b2e18', text: '#e6f2e8' } },
  { id: 'graphite', name: 'Графит', hint: 'Нейтральный серый с оранжевым акцентом', theme: 'dark', colors: { accent: '#ff8a3d', page: '#121212', surface: '#1c1c1c', text: '#ececec' } },
  { id: 'contrast', name: 'Высокий контраст', hint: 'Чёрный фон, белый текст, жёлтый акцент', theme: 'dark', colors: { accent: '#ffd400', page: '#000000', surface: '#0a0a0a', text: '#ffffff' } },
  { id: 'one-dark', name: 'One Dark', hint: 'Atom One Dark: сдержанная классика редакторов кода', theme: 'dark', colors: { accent: '#61afef', page: '#21252b', surface: '#282c34', text: '#abb2bf' } },
  { id: 'tokyo-night', name: 'Tokyo Night', hint: 'Глубокий индиго с неоновым акцентом', theme: 'dark', colors: { accent: '#7aa2f7', page: '#1a1b26', surface: '#24283b', text: '#a9b1d6' } },
  { id: 'catppuccin', name: 'Catppuccin', hint: 'Catppuccin Mocha: мягкая пастель на тёмном', theme: 'dark', colors: { accent: '#cba6f7', page: '#181825', surface: '#1e1e2e', text: '#cdd6f4' } },
  { id: 'gruvbox', name: 'Gruvbox', hint: 'Тёплый ретро: песок и охра, ничего кислотного', theme: 'dark', colors: { accent: '#fabd2f', page: '#282828', surface: '#3c3836', text: '#ebdbb2' } },
  { id: 'github-dark', name: 'GitHub тёмная', hint: 'Привычная палитра GitHub: тёмно-синий и синий акцент', theme: 'dark', colors: { accent: '#4493f8', page: '#0d1117', surface: '#161b22', text: '#e6edf3' } },
  { id: 'rose-pine', name: 'Rosé Pine', hint: 'Приглушённые розово-лиловые тона', theme: 'dark', colors: { accent: '#ebbcba', page: '#191724', surface: '#1f1d2e', text: '#e0def4' } },
  { id: 'everforest', name: 'Everforest', hint: 'Спокойная зелень леса и тёплый песок', theme: 'dark', colors: { accent: '#a7c080', page: '#2d353b', surface: '#343f44', text: '#d3c6aa' } },
  { id: 'neon', name: 'Неон', hint: 'Киберпанк: розовый неон на глубоком фиолетовом', theme: 'dark', colors: { accent: '#ff2a6d', page: '#0d0221', surface: '#1a0b38', text: '#f2e9ff' } },
  { id: 'matrix', name: 'Матрица', hint: 'Зелёный терминал из девяностых', theme: 'dark', colors: { accent: '#3fff6e', page: '#04120a', surface: '#0a2113', text: '#bfffd0' } },
  { id: 'phosphor', name: 'Фосфор', hint: 'Янтарный ретро-монитор', theme: 'dark', colors: { accent: '#ffb000', page: '#141005', surface: '#221a08', text: '#ffd9a0' } },
  { id: 'solar-light', name: 'Solarized светлая', hint: 'Тёплый светлый фон, синий акцент', theme: 'light', colors: { accent: '#268bd2', page: '#eee8d5', surface: '#fdf6e3', text: '#073642' } },
  { id: 'paper', name: 'Бумага', hint: 'Сепия: как чертёж на бумаге', theme: 'light', colors: { accent: '#b5651d', page: '#efe6d6', surface: '#fbf6ec', text: '#3b2f22' } },
  { id: 'sky', name: 'Небо', hint: 'Светлая с синим акцентом', theme: 'light', colors: { accent: '#1f6feb', page: '#eaf1fb', surface: '#ffffff', text: '#14243a' } },
  { id: 'mint', name: 'Мята', hint: 'Светлая с зелёным акцентом', theme: 'light', colors: { accent: '#12a37a', page: '#e8f4ef', surface: '#ffffff', text: '#17302a' } },
  { id: 'one-light', name: 'One Light', hint: 'Atom One Light: чистый минимализм', theme: 'light', colors: { accent: '#4078f2', page: '#f0f1f3', surface: '#ffffff', text: '#383a42' } },
  { id: 'github-light', name: 'GitHub светлая', hint: 'Аккуратные серые с синим акцентом', theme: 'light', colors: { accent: '#0969da', page: '#f6f8fa', surface: '#ffffff', text: '#1f2328' } },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', hint: 'Пастель на светлом: сиреневый акцент', theme: 'light', colors: { accent: '#8839ef', page: '#e6e9ef', surface: '#f4f5fb', text: '#4c4f69' } },
  { id: 'rose-dawn', name: 'Розовая заря', hint: 'Rosé Pine Dawn: тёплый рассвет', theme: 'light', colors: { accent: '#b4637a', page: '#f5ece2', surface: '#fdf8f2', text: '#575279' } },
  { id: 'lavender', name: 'Лаванда', hint: 'Светлая с фиолетовым акцентом', theme: 'light', colors: { accent: '#7c5cff', page: '#f0edfa', surface: '#ffffff', text: '#2d2749' } },
  { id: 'peach', name: 'Персик', hint: 'Тёплая светлая с апельсиновым акцентом', theme: 'light', colors: { accent: '#e8590c', page: '#fdeee2', surface: '#fff8f1', text: '#472b18' } },
];

const COLOR_KEYS = ['accent', 'page', 'surface', 'text'] as const;

/** Только валидные hex-цвета, в нижнем регистре. */
export function cleanColors(c: unknown): CustomColors {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  const out: CustomColors = {};
  for (const k of COLOR_KEYS) if (isHex(o[k])) out[k] = (o[k] as string).toLowerCase();
  return out;
}

/** Совпадает ли текущее оформление с пресетом темы. */
export function isThemeActive(p: ThemePreset, theme: ThemeId, colors: CustomColors): boolean {
  if (p.theme !== theme) return false;
  const a = cleanColors(p.colors), b = cleanColors(colors);
  return COLOR_KEYS.every((k) => (a[k] ?? '') === (b[k] ?? ''));
}

// ------------------------------------------------------------------ «заплатки» настроек

export interface PatchPreset<T> {
  id: string;
  name: string;
  hint: string;
  patch: Partial<T>;
}

/** Совпадают ли текущие значения с заплаткой (числа — с допуском). */
export function patchActive<T extends object>(cur: T, patch: Partial<T>): boolean {
  return (Object.keys(patch) as (keyof T)[]).every((k) => {
    const a = cur[k], b = patch[k];
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
    return a === b;
  });
}

/** Вид интерфейса и редактора. */
export const UI_PRESETS: PatchPreset<Prefs>[] = [
  {
    id: 'std', name: 'Стандартный', hint: 'Всё на месте: панель, статус-строка, автопрокрутка монитора',
    patch: { compactUi: false, showSidebar: true, statusBar: true, fontSize: 14, serialAutoscroll: true, serialTimestamps: false },
  },
  {
    id: 'laptop', name: 'Ноутбук', hint: 'Компактные панели, шрифт редактора поменьше',
    patch: { compactUi: true, showSidebar: true, statusBar: true, fontSize: 12.5, serialAutoscroll: true, serialTimestamps: false },
  },
  {
    id: 'minimal', name: 'Минимализм', hint: 'Ничего лишнего: без боковой панели и статус-строки',
    patch: { compactUi: true, showSidebar: false, statusBar: false, fontSize: 14, serialAutoscroll: true, serialTimestamps: false },
  },
  {
    id: 'debug', name: 'Отладка', hint: 'Для возни с устройством: штампы времени и крупный лог',
    patch: { compactUi: false, showSidebar: true, statusBar: true, fontSize: 14, serialAutoscroll: true, serialTimestamps: true },
  },
];

// ------------------------------------------------------------------ свои пресеты

const PREFS_SKIP = new Set<string>(['setSection', 'setW', 'setH', 'setX', 'setY', 'setMax']);

/** Полный профиль настроек: оформление, программа, редактор, монитор. */
export interface SettingsProfile {
  id: string;
  name: string;
  created: number;
  theme: ThemeId;
  colors: CustomColors;
  prefs: Partial<Prefs>;
}

export interface UserPresets {
  themes: ThemePreset[];
  profiles: SettingsProfile[];
}

const EMPTY: UserPresets = { themes: [], profiles: [] };

const uid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : d);
const theme = (v: unknown): ThemeId => (v === 'light' ? 'light' : 'dark');
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Профиль из текущих настроек (без геометрии окна настроек). */
export function makeProfile(
  name: string,
  cur: { theme: ThemeId; colors: CustomColors; prefs: Prefs },
): SettingsProfile {
  const prefs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cur.prefs)) if (!PREFS_SKIP.has(k)) prefs[k] = v;
  return {
    id: 'p-' + uid(),
    name: str(name, 'Мой профиль'),
    created: Date.now(),
    theme: cur.theme,
    colors: cleanColors(cur.colors),
    prefs: JSON.parse(JSON.stringify(prefs)),
  };
}

export function makeThemePreset(name: string, t: ThemeId, colors: CustomColors): ThemePreset {
  return { id: 't-' + uid(), name: str(name, 'Моя тема'), theme: t, colors: cleanColors(colors), user: true };
}

/** Отбросить битые записи (данные из localStorage или файла). */
export function normalizeUserPresets(raw: unknown): UserPresets {
  const o = obj(raw);
  const themes = (Array.isArray(o.themes) ? o.themes : []).map(obj)
    .filter((t) => typeof t.id === 'string')
    .map((t): ThemePreset => ({
      id: t.id as string, name: str(t.name, 'Моя тема'), theme: theme(t.theme),
      colors: cleanColors(t.colors), user: true,
    }));
  const profiles = (Array.isArray(o.profiles) ? o.profiles : []).map(obj)
    .filter((p) => typeof p.id === 'string')
    .map((p): SettingsProfile => ({
      id: p.id as string,
      name: str(p.name, 'Мой профиль'),
      created: typeof p.created === 'number' ? p.created : 0,
      theme: theme(p.theme),
      colors: cleanColors(p.colors),
      prefs: obj(p.prefs) as Partial<Prefs>,
    }));
  return { themes: themes.slice(0, 50), profiles: profiles.slice(0, 50) };
}

export function loadUserPresets(): UserPresets {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return EMPTY;
    return normalizeUserPresets(JSON.parse(raw));
  } catch { return EMPTY; }
}

export function saveUserPresets(p: UserPresets): void {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
