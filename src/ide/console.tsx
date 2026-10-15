// Консоль вывода MicroPIDE: строки с цветовой разметкой (ошибки, успех, азбука
// arduino-cli). Строки с «error:» или «✗» красятся как ошибки.
import { useEffect, useRef } from 'react';

export type ConsoleKind = 'info' | 'err' | 'ok' | 'dim' | 'hl';

export interface ConsoleLine { text: string; kind: ConsoleKind }
const MAX = 4000;

export function classifyLine(s: string): ConsoleKind {
  if (/✓|успешно завершена|установлен\.$|готово/i.test(s)) return 'ok';
  if (/✗|error:|ошибка|не удалось|Error:/i.test(s)) return 'err';
  if (/^warn|предупрежд/i.test(s)) return 'hl';
  if (/^--|^arduino-cli|^Ищу|^Скачиваю|^Распаковыва/i.test(s)) return 'dim';
  return 'info';
}

/** Панель вывода: массив строк управляется снаружи, здесь только рендер. */
export function ConsoleView({ lines, empty }: { lines: ConsoleLine[]; empty: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <div className="console" ref={ref}>
      {lines.length === 0 && <div className="console-empty">{empty}</div>}
      {lines.map((l, i) => (
        <div key={i} className={l.kind === 'info' ? '' : l.kind}>{l.text}</div>
      ))}
    </div>
  );
}

export function pushLine(arr: ConsoleLine[], text: string, kind?: ConsoleKind): ConsoleLine[] {
  const next = [...arr, { text, kind: kind ?? classifyLine(text) }];
  return next.length > MAX ? next.slice(next.length - MAX) : next;
}
