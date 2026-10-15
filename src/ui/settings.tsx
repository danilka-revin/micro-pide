// Окно настроек MicroPIDE — перенос структуры окна PSBees (linux_pcb_app):
// разделы слева, страницы справа; темы-пресеты с образцами цветов, свои темы
// и полные профили настроек, экспорт/импорт файла настроек.
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ic } from './icons';
import { NI, TI, SI, ConfirmDialog } from './widgets';
import { ACCENT_PRESETS, THEME_BASE, isHex, mix, rgba, type ThemeId } from './palette';
import { api, type SystemInfo } from '../ide/api';
import {
  THEME_PRESETS, UI_PRESETS, isThemeActive, makeProfile, makeThemePreset,
  loadUserPresets, saveUserPresets, patchActive, type SettingsProfile, type ThemePreset, type UserPresets,
} from './presets';
import type { Prefs } from './prefs';

interface Section { id: string; icon: string; title: string; hint: string; keys: string }

const SECTIONS: Section[] = [
  { id: 'general', icon: 'gear', title: 'Общие', hint: 'Тема, акцент, автосохранение, обновления', keys: 'тема цвет акцент автосохранение обновления запуск' },
  { id: 'presets', icon: 'palette', title: 'Пресеты', hint: 'Темы оформления, вид интерфейса, свои профили', keys: 'пресет пресеты тема темы оформление nord dracula monokai профиль профили' },
  { id: 'editor', icon: 'filecode', title: 'Редактор', hint: 'Шрифт, перенос строк, пробелы', keys: 'редактор шрифт размер перенос пробелы код' },
  { id: 'serial', icon: 'monitor', title: 'Монитор порта', hint: 'Скорость, конец строки, автопрокрутка, время', keys: 'монитор порт serial скорость бод строка автопрокрутка время' },
  { id: 'build', icon: 'chip', title: 'Сборка и прошивка', hint: 'Подробный вывод, сохранение перед сборкой', keys: 'сборка компиляция прошивка verbose загрузка' },
  { id: 'hotkeys', icon: 'info', title: 'Горячие клавиши', hint: 'Список сочетаний клавиш', keys: 'горячие клавиши хоткеи сочетания' },
];

interface Props {
  prefs: Prefs;
  set: (patch: Partial<Prefs>) => void;
  reset: () => void;
  onClose: () => void;
  onOpenUpdater: () => void;
  version: string | null;
  sys: SystemInfo | null;
  onSysChanged: () => void;
}

/** Образец темы для карточки: полоски цветов превью. */
function themeSwatch(p: ThemePreset): { bg: string; bars: string[] } {
  const base = THEME_BASE[p.theme];
  const c = {
    accent: p.colors.accent || base.accent,
    page: p.colors.page || base.page,
    surface: p.colors.surface || base.surface,
    text: p.colors.text || base.text,
  };
  return { bg: c.page, bars: [c.surface, mix(c.surface, c.text, 0.08), c.accent, c.text] };
}

function ThemeCard({ p, active, onPick, onDelete }: {
  p: ThemePreset; active: boolean; onPick: () => void; onDelete?: () => void;
}) {
  const sw = themeSwatch(p);
  return (
    <button className={'theme-card' + (active ? ' active' : '')} onClick={onPick} title={p.hint || p.name}>
      <span className="sw" style={{ background: sw.bg }}>
        {sw.bars.map((c, i) => <i key={i} style={{ background: c }} />)}
      </span>
      <span className="cap">
        <b>{p.name}</b>
        <span>{p.hint || (p.theme === 'dark' ? 'тёмная' : 'светлая')}</span>
      </span>
      {onDelete && (
        <span
          className="user-del" title="Удалить тему"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        ><Ic n="close" size={12} /></span>
      )}
    </button>
  );
}

export function SettingsWindow({ prefs, set, reset, onClose, onOpenUpdater, version, sys, onSysChanged }: Props) {
  const [sec, setSec] = useState(prefs.setSection && SECTIONS.some((s) => s.id === prefs.setSection) ? prefs.setSection : 'general');
  const [user, setUser] = useState<UserPresets>(() => loadUserPresets());
  const [newThemeName, setNewThemeName] = useState('');
  const [profileName, setProfileName] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [delTheme, setDelTheme] = useState<string>('');
  const [sbPath, setSbPath] = useState('');
  const [sbBusy, setSbBusy] = useState(false);

  const goto = (id: string) => {
    setSec(id);
    set({ setSection: id });
  };

  const applyConfig = async (patch: { sketchbook?: string | null; useSystemArduino?: boolean | null }) => {
    setSbBusy(true);
    try {
      await api.configSet(patch);
      onSysChanged();
    } catch { /* пользователь увидит путь без изменений */ }
    setSbBusy(false);
  };

  const allThemes = useMemo(() => [...THEME_PRESETS, ...user.themes], [user.themes]);

  const saveThemes = (u: UserPresets) => { setUser(u); saveUserPresets(u); };

  const addUserTheme = () => {
    const t = makeThemePreset(newThemeName || 'Моя тема', prefs.theme, prefs.colors);
    saveThemes({ ...user, themes: [...user.themes, t].slice(-50) });
    setNewThemeName('');
  };

  const addProfile = () => {
    const p = makeProfile(profileName || 'Мой профиль', { theme: prefs.theme, colors: prefs.colors, prefs });
    saveThemes({ ...user, profiles: [...user.profiles, p].slice(-50) });
    setProfileName('');
  };

  const doApplyProfile = (p: SettingsProfile) => {
    set({ theme: p.theme, colors: p.colors, ...p.prefs });
  };

  const exportSettings = () => {
    const data = {
      app: 'micro-pide',
      version: 1,
      saved: new Date().toISOString(),
      prefs: { ...prefs, setSection: 'general', setW: 0, setH: 0 },
      user,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'micropide-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importSettings = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (data.app !== 'micro-pide' && !data.prefs) throw new Error('не файл настроек MicroPIDE');
        if (data.prefs) set(data.prefs);
        if (data.user) saveThemes({
          themes: Array.isArray(data.user.themes) ? data.user.themes : [],
          profiles: Array.isArray(data.user.profiles) ? data.user.profiles : [],
        });
      } catch (e) {
        alert('Не удалось импортировать настройки: ' + (e instanceof Error ? e.message : String(e)));
      }
    };
    input.click();
  };

  return createPortal(
    <div className="settings-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="Настройки">
        <div className="settings-head">
          <Ic n="gear" size={17} />
          <h2>Настройки</h2>
          <button className="btn tiny" onClick={exportSettings} title="Сохранить настройки в файл">Экспорт</button>
          <button className="btn tiny" onClick={importSettings} title="Загрузить настройки из файла">Импорт</button>
          <button className="btn tiny danger" onClick={() => setConfirmReset(true)}>Сброс</button>
          <button className="tb-btn" onClick={onClose} title="Закрыть (Esc)"><Ic n="close" size={15} /></button>
        </div>
        <div className="settings-main">
          <div className="settings-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} className={'settings-nav-item' + (sec === s.id ? ' active' : '')} onClick={() => goto(s.id)} title={s.hint}>
                <span className="ic"><Ic n={s.icon} size={15} /></span>
                {s.title}
              </button>
            ))}
          </div>
          <div className="settings-page">
            {sec === 'general' && (
              <>
                <h3>Тема</h3>
                <p className="sub">Базовая тема оформления: тёмная «Пчела» — фирменный стиль золота на графите.</p>
                <SI
                  label="Тема" value={prefs.theme}
                  options={[['dark', 'Тёмная'], ['light', 'Светлая']]}
                  on={(v) => set({ theme: v as ThemeId })}
                />
                <h3>Акцент</h3>
                <p className="sub">Цвет кнопок, выделений и активных элементов.</p>
                <div className="swatch-row">
                  {ACCENT_PRESETS.map((a) => (
                    <button
                      key={a.hex}
                      className="swatch"
                      style={isHex(prefs.colors.accent) && prefs.colors.accent.toLowerCase() === a.hex.toLowerCase() ? { borderColor: 'var(--accent)' } : undefined}
                      onClick={() => set({ colors: { ...prefs.colors, accent: a.hex } })}
                      title={a.name}
                    >
                      <i style={{ background: a.hex }} />{a.name}
                    </button>
                  ))}
                  <label className="swatch" title="Свой цвет">
                    <input
                      type="color" value={isHex(prefs.colors.accent) ? prefs.colors.accent : '#ffc233'}
                      style={{ width: 14, height: 14, border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
                      onChange={(e) => set({ colors: { ...prefs.colors, accent: e.target.value } })}
                    />
                    Свой
                  </label>
                  {isHex(prefs.colors.accent) && (
                    <button className="swatch" onClick={() => set({ colors: { ...prefs.colors, accent: undefined } })}>
                      Сбросить акцент
                    </button>
                  )}
                </div>
                <h3>Свои цвета поверх темы</h3>
                <div className="swatch-row">
                  {(['page', 'surface', 'text'] as const).map((k) => (
                    <label className="swatch" key={k}>
                      <input
                        type="color" value={isHex(prefs.colors[k]) ? prefs.colors[k]! : THEME_BASE[prefs.theme][k]}
                        style={{ width: 14, height: 14, border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
                        onChange={(e) => set({ colors: { ...prefs.colors, [k]: e.target.value } })}
                      />
                      {{ page: 'Фон', surface: 'Панели', text: 'Текст' }[k]}
                    </label>
                  ))}
                  <button className="swatch" onClick={() => set({ colors: {} })} disabled={!Object.keys(prefs.colors).length}>
                    Сбросить всё
                  </button>
                </div>
                <h3>Файлы и запуск</h3>
                <label className="chk">
                  <input type="checkbox" checked={prefs.autosave} onChange={(e) => set({ autosave: e.target.checked })} />
                  Автосохранение черновика в браузере
                </label>
                {prefs.autosave && (
                  <NI label="Интервал, мс" value={prefs.autosaveMs} step={100} min={200} max={60_000}
                    on={(v) => set({ autosaveMs: Math.round(v) })} />
                )}
                <label className="chk">
                  <input type="checkbox" checked={prefs.checkUpdates} onChange={(e) => set({ checkUpdates: e.target.checked })} />
                  Проверять обновления при запуске
                </label>
                <div className="row">
                  <button className="btn" onClick={onOpenUpdater}><Ic n="refresh" size={14} />Проверить обновления</button>
                  <span className="hint" style={{ padding: 0 }}>Версия: <span className="mono">{version || 'неизвестно'}</span></span>
                </div>
                <h3>Скетчбук (проекты Arduino IDE)</h3>
                <p className="sub">
                  {sys?.systemFound
                    ? <>Каталоги Arduino IDE найдены: проекты и библиотеки открываются прямо из вашей папки Arduino.</>
                    : <>Стандартные папки Arduino IDE не найдены — используется внутренний скетчбук. Можно указать свою папку проектов.</>}
                </p>
                <div className="upd-vers" style={{ gridTemplateColumns: '1fr' }}>
                  <div className="upd-ver">
                    <span className="upd-lab">Активный скетчбук</span>
                    <b className="upd-mono" style={{ wordBreak: 'break-all' }}>{sys?.sketchbook || '…'}</b>
                  </div>
                  <span className="meta" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    Источник: {sys?.useSystem ? 'папка Arduino IDE' : sys?.config?.sketchbook ? 'задан вручную' : 'внутренний каталог'} ·
                    {' '}данные плат: {sys?.useSystem ? sys?.systemData : '.data/arduino15'}
                  </span>
                </div>
                <div className="field">
                  <label>Своя папка</label>
                  <input
                    className="txt" placeholder="/home/user/Arduino"
                    value={sbPath} onChange={(e) => setSbPath(e.target.value)}
                  />
                  <button className="btn" disabled={sbBusy || !sbPath.trim()} onClick={() => void applyConfig({ sketchbook: sbPath.trim() })}>
                    Применить
                  </button>
                </div>
                <div className="row">
                  <button className="btn" disabled={sbBusy} onClick={() => void applyConfig({ sketchbook: null })}>
                    Сбросить на авто
                  </button>
                  <button className="btn" disabled={sbBusy || sys?.useSystem} onClick={() => void applyConfig({ useSystemArduino: true, sketchbook: null })}>
                    Папка Arduino IDE
                  </button>
                  <button className="btn" disabled={sbBusy || sys?.useSystem === false && !sys?.config?.sketchbook} onClick={() => void applyConfig({ useSystemArduino: false, sketchbook: null })}>
                    Внутренний каталог
                  </button>
                </div>
                <p className="sub" style={{ marginTop: 6 }}>
                  Смена действует сразу: списки скетчей, библиотек и плат перечитаются. Компиляция будет
                  видеть библиотеки из папки <span className="mono">libraries/</span> выбранного скетчбука.
                </p>
              </>
            )}

            {sec === 'presets' && (
              <>
                <h3>Темы оформления</h3>
                <p className="sub">
                  Готовые палитры: клик — применить. «Сохранить текущую» добавит ваши цвета в список.
                </p>
                <div className="field">
                  <label>Название</label>
                  <input className="txt" value={newThemeName} placeholder="Моя тема"
                    onChange={(e) => setNewThemeName(e.target.value)} />
                  <button className="btn" onClick={addUserTheme}><Ic n="save" size={13} />Сохранить текущую</button>
                </div>
                <div className="theme-grid">
                  {allThemes.map((p) => (
                    <ThemeCard
                      key={p.id}
                      p={p}
                      active={isThemeActive(p, prefs.theme, prefs.colors)}
                      onPick={() => set({ theme: p.theme, colors: p.colors })}
                      onDelete={p.user ? () => setDelTheme(p.id) : undefined}
                    />
                  ))}
                </div>
                <h3>Вид интерфейса</h3>
                <div className="theme-grid">
                  {UI_PRESETS.map((p) => (
                    <ThemeCard
                      key={p.id}
                      p={{ id: p.id, name: p.name, hint: p.hint, theme: prefs.theme, colors: prefs.colors }}
                      active={patchActive(prefs, p.patch)}
                      onPick={() => set(p.patch)}
                    />
                  ))}
                </div>
                <h3>Свои профили настроек</h3>
                <p className="sub">Профиль запоминает тему, цвета и все настройки: можно переключать одним кликом.</p>
                <div className="field">
                  <label>Название</label>
                  <input className="txt" value={profileName} placeholder="Мой профиль"
                    onChange={(e) => setProfileName(e.target.value)} />
                  <button className="btn" onClick={addProfile}><Ic n="save" size={13} />Сохранить профиль</button>
                </div>
                {user.profiles.length === 0 && <p className="sub">Профилей пока нет.</p>}
                {user.profiles.map((p) => (
                  <div key={p.id} className="card" style={{ marginTop: 6 }}>
                    <b>{p.name}</b>
                    <span className="meta">Тема: {p.theme}; создан {p.created ? new Date(p.created).toLocaleString() : '—'}</span>
                    <div className="foot">
                      <button className="btn tiny primary" onClick={() => doApplyProfile(p)}>Применить</button>
                      <span style={{ flex: 1 }} />
                      <button className="btn tiny danger" onClick={() => saveThemes({ ...user, profiles: user.profiles.filter((x) => x.id !== p.id) })}>Удалить</button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {sec === 'editor' && (
              <>
                <h3>Шрифт и вид</h3>
                <NI label="Размер шрифта" value={prefs.fontSize} step={0.5} min={9} max={32} on={(v) => set({ fontSize: v })} />
                <label className="chk">
                  <input type="checkbox" checked={prefs.wordWrap} onChange={(e) => set({ wordWrap: e.target.checked })} />
                  Переносить длинные строки
                </label>
                <label className="chk">
                  <input type="checkbox" checked={prefs.showWhitespace} onChange={(e) => set({ showWhitespace: e.target.checked })} />
                  Показывать пробелы и табы
                </label>
                <h3>Интерфейс</h3>
                <label className="chk">
                  <input type="checkbox" checked={prefs.showSidebar} onChange={(e) => set({ showSidebar: e.target.checked })} />
                  Боковая панель (скетчи, примеры, библиотеки, платы)
                </label>
                <label className="chk">
                  <input type="checkbox" checked={prefs.statusBar} onChange={(e) => set({ statusBar: e.target.checked })} />
                  Строка состояния внизу окна
                </label>
                <label className="chk">
                  <input type="checkbox" checked={prefs.compactUi} onChange={(e) => set({ compactUi: e.target.checked })} />
                  Компактный интерфейс
                </label>
              </>
            )}

            {sec === 'serial' && (
              <>
                <h3>Монитор порта</h3>
                <SI
                  label="Скорость" value={String(prefs.serialBaud)}
                  options={[
                    ['300', '300'], ['600', '600'], ['1200', '1200'], ['2400', '2400'], ['4800', '4800'],
                    ['9600', '9600'], ['14400', '14400'], ['19200', '19200'], ['28800', '28800'],
                    ['38800', '38800'], ['57600', '57600'], ['115200', '115200'],
                  ].map(([v, t]) => [v, t + ' бод'] as [string, string])}
                  on={(v) => set({ serialBaud: Number(v) })}
                />
                <SI
                  label="Конец строки" value={prefs.serialEol}
                  options={[['nl', '\\n (LF)'], ['cr', '\\r (CR)'], ['crlf', '\\r\\n (CRLF)'], ['none', 'Без перевода строки']]}
                  on={(v) => set({ serialEol: v as Prefs['serialEol'] })}
                />
                <label className="chk">
                  <input type="checkbox" checked={prefs.serialAutoscroll} onChange={(e) => set({ serialAutoscroll: e.target.checked })} />
                  Автопрокрутка лога
                </label>
                <label className="chk">
                  <input type="checkbox" checked={prefs.serialTimestamps} onChange={(e) => set({ serialTimestamps: e.target.checked })} />
                  Штампы времени у строк
                </label>
              </>
            )}

            {sec === 'build' && (
              <>
                <h3>Сборка и прошивка</h3>
                <label className="chk">
                  <input type="checkbox" checked={prefs.verboseBuild} onChange={(e) => set({ verboseBuild: e.target.checked })} />
                  Подробный вывод компиляции (--verbose)
                </label>
                <label className="chk">
                  <input type="checkbox" checked={prefs.saveBeforeBuild} onChange={(e) => set({ saveBeforeBuild: e.target.checked })} />
                  Сохранять файлы на диск перед сборкой и прошивкой
                </label>
                <p className="sub">
                  Сборка выполняется arduino-cli на вашем компьютере: сначала нужно выбрать плату
                  (панель «Платы») и установить её платформу.
                </p>
              </>
            )}

            {sec === 'hotkeys' && (
              <>
                <h3>Горячие клавиши</h3>
                <p className="sub">Сочетания как в Arduino IDE.</p>
                {[
                  ['Проверить (компилировать)', 'Ctrl+R'],
                  ['Загрузить в плату', 'Ctrl+U'],
                  ['Сохранить скетч', 'Ctrl+S'],
                  ['Новый скетч', 'Ctrl+N'],
                  ['Открыть скетч…', 'Ctrl+O'],
                  ['Найти в файле', 'Ctrl+F'],
                  ['Автодополнение кода', 'Ctrl+Space'],
                  ['Принять подсказку', 'Tab / Enter'],
                  ['Методы объекта (Serial.)', 'печать точки'],
                  ['Отменить / вернуть', 'Ctrl+Z / Ctrl+Shift+Z'],
                  ['Комментарий строки', 'Ctrl+/'],
                  ['Монитор порта', 'Ctrl+Shift+M'],
                  ['Настройки', 'Ctrl+Запятая'],
                ].map(([label, kbd]) => (
                  <div className="field" key={label}>
                    <label>{label}</label>
                    <span className="kbd">{kbd}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {confirmReset && (
        <ConfirmDialog
          title="Сбросить настройки?"
          text="Все настройки вернутся к значениям по умолчанию. Свои темы и профили останутся."
          ok="Сбросить" danger
          onOk={() => { reset(); set({ colors: {} }); setConfirmReset(false); }}
          onClose={() => setConfirmReset(false)}
        />
      )}
      {delTheme && (
        <ConfirmDialog
          title="Удалить тему?"
          text="Тема будет удалена из списка ваших пресетов."
          ok="Удалить" danger
          onOk={() => {
            saveThemes({ ...user, themes: user.themes.filter((t) => t.id !== delTheme) });
            setDelTheme('');
          }}
          onClose={() => setDelTheme('')}
        />
      )}
    </div>,
    document.body,
  );
}
