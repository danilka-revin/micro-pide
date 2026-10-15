// Кастомизация цветов интерфейса — перенос из PSBees (linux_pcb_app):
// пользователь задаёт базовые hex-цвета, из них выводятся производные
// CSS-переменные и применяются инлайн на <html>, перекрывая значения темы.
export type ThemeId = 'dark' | 'light';

export type CustomColors = {
  accent?: string;  // акцентный цвет, hex
  page?: string;    // фон страницы
  surface?: string; // панели, диалоги, шапка
  text?: string;    // основной текст
};

export const PALETTE_KEY = 'micropide.colors';

/** Базовые цвета тем: значения по умолчанию и основа для вывода производных. */
export const THEME_BASE: Record<ThemeId, Required<CustomColors>> = {
  dark: { accent: '#ffc233', page: '#0f1115', surface: '#15181e', text: '#edf0f4' },
  light: { accent: '#e08e00', page: '#eef0f3', surface: '#ffffff', text: '#1c232c' },
};

/** Пресеты акцента (первый — цвет темы по умолчанию). */
export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: 'Мёд', hex: '#ffc233' },
  { name: 'Океан', hex: '#3fa9ff' },
  { name: 'Изумруд', hex: '#3ddc84' },
  { name: 'Коралл', hex: '#ff6b57' },
  { name: 'Аметист', hex: '#a78bfa' },
  { name: 'Розовый', hex: '#ff7ab6' },
  { name: 'Циан', hex: '#2fd4d4' },
  { name: 'Лайм', hex: '#b6e33a' },
];

// ---------------- цветовые вычисления ----------------

type Rgb = { r: number; g: number; b: number };

export function isHex(s: unknown): s is string {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

function parse(hex: string): Rgb {
  const h = hex.slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function toHex(c: Rgb): string {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${q(c.r)}${q(c.g)}${q(c.b)}`;
}

/** Линейная интерполяция: t=0 → a, t=1 → b. */
export function mix(a: string, b: string, t: number): string {
  const x = parse(a), y = parse(b);
  return toHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

export function rgba(hex: string, a: number): string {
  const c = parse(hex);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

/** Относительная яркость (WCAG). */
export function lum(hex: string): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const c = parse(hex);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrast(a: string, b: string): number {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Доводит контраст цвета к target, смещая к чёрному или белому. */
function readable(hex: string, bg: string, target: number): string {
  const dir = contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000';
  let out = hex;
  for (let i = 0; i < 24 && contrast(out, bg) < target; i++) out = mix(out, dir, 0.09);
  return out;
}

/** Текст поверх акцентной заливки: чёрный или белый — что контрастнее. */
function inkOn(hex: string): string {
  return contrast(hex, '#000000') >= contrast(hex, '#ffffff') ? '#12100a' : '#ffffff';
}

// ---------------- хранилище ----------------

export function loadCustomColors(): CustomColors {
  try {
    const raw = localStorage.getItem(PALETTE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: CustomColors = {};
    for (const k of ['accent', 'page', 'surface', 'text'] as const) {
      if (isHex(o[k])) out[k] = o[k] as string;
    }
    return out;
  } catch { return {}; }
}

export function saveCustomColors(c: CustomColors): void {
  try {
    if (Object.keys(c).length) localStorage.setItem(PALETTE_KEY, JSON.stringify(c));
    else localStorage.removeItem(PALETTE_KEY);
  } catch { /* ignore */ }
}

// ---------------- применение ----------------

const OVERRIDE_VARS = [
  'page', 'surface', 'surface-2', 'hover', 'line', 'line-soft',
  'text', 'text-2', 'muted', 'code-bg', 'info-bg', 'info-ink',
  'modal-veil', 'sw-line',
  'accent', 'accent-text', 'accent-ink', 'accent-soft', 'accent-line', 'accent-glow',
  'tok-keyword', 'tok-type', 'tok-string', 'tok-number', 'tok-comment', 'tok-func', 'tok-macro', 'tok-op',
  'ed-sel', 'ed-caret', 'ed-line',
];

/** Перекрыть цвета синтаксиса редактора под акцент/фон темы. */
function applySyntaxColors(root: HTMLElement, accent: string, sf: string, tx: string, lightish: boolean): void {
  const dark = !lightish;
  root.style.setProperty('--tok-keyword', mix(accent, dark ? '#ff9d5c' : '#b25309', 0.35));
  root.style.setProperty('--tok-type', mix(accent, dark ? '#ffd97a' : '#8a6d00', 0.3));
  root.style.setProperty('--tok-string', dark ? '#9ddc7a' : '#256029');
  root.style.setProperty('--tok-number', dark ? '#6fd3ff' : '#0b5e87');
  root.style.setProperty('--tok-comment', mix(tx, sf, 0.55));
  root.style.setProperty('--tok-func', dark ? '#67cdea' : '#0e6a8a');
  root.style.setProperty('--tok-macro', dark ? '#d9a3ff' : '#6d28a8');
  root.style.setProperty('--tok-op', mix(tx, sf, 0.16));
  root.style.setProperty('--ed-sel', rgba(accent, lightish ? 0.2 : 0.22));
  root.style.setProperty('--ed-caret', readable(accent, sf, 3.2));
  root.style.setProperty('--ed-line', rgba(tx, lightish ? 0.035 : 0.035));
}

/** Накладывает пользовательские цвета на <html> (снимает старые override'ы). */
export function applyCustomColors(c: CustomColors, theme: ThemeId): void {
  const root = document.documentElement;
  for (const v of OVERRIDE_VARS) root.style.removeProperty(`--${v}`);
  const any = (['accent', 'page', 'surface', 'text'] as const).some((k) => isHex(c[k]));
  if (!any) return;

  const base = THEME_BASE[theme];
  const accent = isHex(c.accent) ? c.accent : null;
  const page = isHex(c.page) ? c.page : null;
  const surface = isHex(c.surface) ? c.surface : null;
  const text = isHex(c.text) ? c.text : null;

  if (accent) {
    const sf = surface ?? base.surface;
    const lightish = lum(sf) >= 0.45;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-text', readable(accent, sf, 3.2));
    root.style.setProperty('--accent-ink', inkOn(accent));
    root.style.setProperty('--accent-soft', rgba(accent, 0.13));
    root.style.setProperty('--accent-glow', rgba(accent, 0.2));
    root.style.setProperty('--accent-line', mix(accent, lightish ? '#ffffff' : '#000000', lightish ? 0.3 : 0.65));
  }

  if (page || surface || text) {
    const bg = page ?? base.page;
    const sf = surface ?? base.surface;
    const tx = text ?? base.text;
    const lightish = lum(sf) >= 0.45;
    const edge = lightish ? '#000000' : '#ffffff';
    root.style.setProperty('--page', bg);
    root.style.setProperty('--surface', sf);
    root.style.setProperty('--text', tx);
    root.style.setProperty('--surface-2', mix(sf, edge, 0.05));
    root.style.setProperty('--hover', mix(sf, edge, 0.09));
    root.style.setProperty('--line', mix(sf, edge, 0.16));
    root.style.setProperty('--line-soft', mix(sf, edge, 0.1));
    root.style.setProperty('--text-2', mix(tx, sf, 0.16));
    root.style.setProperty('--muted', mix(tx, sf, 0.34));
    root.style.setProperty('--code-bg', mix(bg, lightish ? '#ffffff' : '#000000', lightish ? 0.35 : 0.25));
    root.style.setProperty('--info-bg', rgba(tx, 0.05));
    root.style.setProperty('--info-ink', mix(tx, sf, 0.15));
    root.style.setProperty('--modal-veil', lightish ? rgba('#1e232a', 0.45) : rgba(bg, 0.72));
    root.style.setProperty('--sw-line', rgba(tx, 0.25));
  }

  // Цвета редактора следуют за оформлением всегда (и на чистых темах тоже).
  const acc = accent ?? base.accent;
  const sf = surface ?? base.surface;
  const tx = text ?? base.text;
  applySyntaxColors(root, acc, sf, tx, lum(sf) >= 0.45);
}
