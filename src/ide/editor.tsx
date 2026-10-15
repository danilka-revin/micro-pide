// Редактор кода MicroPIDE: CodeMirror 6 с подсветкой C++ и темой из
// CSS-переменных MicroPIDE (цвета синтаксиса --tok-* задаются в styles.css
// и перекрываются пресетами тем).
import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, ViewPlugin, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { EditorState, Compartment, RangeSetBuilder, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, foldGutter, indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import { tags as t } from '@lezer/highlight';

/** Подсветка синтаксиса через переменные темы (работает во всех пресетах). */
const microHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--tok-keyword)' },
  { tag: [t.controlKeyword, t.controlOperator], color: 'var(--tok-keyword)' },
  { tag: [t.typeName, t.className, t.standard(t.typeName)], color: 'var(--tok-type)' },
  { tag: t.string, color: 'var(--tok-string)' },
  { tag: t.number, color: 'var(--tok-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--tok-func)' },
  { tag: [t.macroName], color: 'var(--tok-macro)' },
  { tag: [t.operator, t.operatorKeyword], color: 'var(--tok-op)' },
  { tag: [t.definition(t.variableName)], color: 'var(--text)' },
  { tag: t.bool, color: 'var(--tok-number)' },
  { tag: t.null, color: 'var(--tok-number)' },
  { tag: t.variableName, color: 'var(--text)' },
  { tag: t.propertyName, color: 'var(--text)' },
  { tag: t.heading, color: 'var(--tok-type)' },
]);

const microTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--code-bg)', color: 'var(--text)' },
  '.cm-content': { caretColor: 'var(--ed-caret)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--hover)', border: '1px solid var(--line)', color: 'var(--muted)' },
}, { dark: false });

/** Видимая точка вместо пробела/таба (настройка «показывать пробелы»). */
class WsWidget extends WidgetType {
  constructor(readonly ch: string) { super(); }
  eq(o: WsWidget) { return o.ch === this.ch; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-ws';
    s.textContent = this.ch === '\t' ? '→' : '·';
    return s;
  }
  ignoreEvent() { return true; }
}

const wsPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = this.build(view);
  }
  update(u: any) {
    if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
  }
  build(view: EditorView) {
    const b = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to; pos++) {
        const ch = view.state.doc.sliceString(pos, pos + 1);
        if (ch === ' ' || ch === '\t') {
          b.add(pos, pos + 1, Decoration.replace({ widget: new WsWidget(ch) }));
        }
      }
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

const wsCss = EditorView.theme({
  '.cm-ws': { color: 'var(--tok-comment)', opacity: .55 },
});

export interface EditorOpts {
  fontSize: number;
  wordWrap: boolean;
  showWhitespace: boolean;
}

/**
 * Обёртка CodeMirror: управляемый value + колбэк изменений.
 * Пересоздание состояния — только при смене имени файла, правка текста
 * идёт через dispatch без потери истории отмены.
 */
export function CodeEditor({
  value, path, onChange, opts, onSave, onVerify, onUpload, onReady,
}: {
  value: string;
  path: string;
  onChange: (v: string) => void;
  opts: EditorOpts;
  onSave?: () => void;
  onVerify?: () => void;
  onUpload?: () => void;
  onReady?: (view: EditorView | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrapComp = useRef(new Compartment());
  const wsComp = useRef(new Compartment());
  const fsComp = useRef(new Compartment());
  const cbRef = useRef({ onChange, onSave, onVerify, onUpload, onReady });
  cbRef.current = { onChange, onSave, onVerify, onUpload, onReady };

  // создать редактор один раз
  useEffect(() => {
    if (!host.current) return;
    const shortcuts = keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { cbRef.current.onSave?.(); return true; } },
      { key: 'Mod-r', preventDefault: true, run: () => { cbRef.current.onVerify?.(); return true; } },
      { key: 'Mod-u', preventDefault: true, run: () => { cbRef.current.onUpload?.(); return true; } },
    ]);
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of('  '),
      syntaxHighlighting(microHighlight, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      shortcuts,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      cpp(),
      search({ top: true }),
      microTheme,
      fsComp.current.of(EditorView.theme({ '&': { fontSize: `${opts.fontSize}px` } })),
      wrapComp.current.of(opts.wordWrap ? EditorView.lineWrapping : []),
      wsComp.current.of(opts.showWhitespace ? [wsPlugin, wsCss] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cbRef.current.onChange(u.state.doc.toString());
      }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: value, extensions: exts }), parent: host.current });
    view.current = v;
    cbRef.current.onReady?.(v);
    return () => { cbRef.current.onReady?.(null); v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // внешний value (открытие другого файла, отмена)
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    }
  }, [value]);

  // опции отображения
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({
      effects: [
        wrapComp.current.reconfigure(opts.wordWrap ? EditorView.lineWrapping : []),
        fsComp.current.reconfigure(EditorView.theme({ '&': { fontSize: `${opts.fontSize}px` } })),
      ],
    });
  }, [opts.wordWrap, opts.fontSize]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({
      effects: wsComp.current.reconfigure(opts.showWhitespace ? [wsPlugin, wsCss] : []),
    });
  }, [opts.showWhitespace]);

  return <div className="ed-wrap" ref={host} />;
}
