// Дополнительная подсветка Arduino-кода поверх синтаксиса C++:
// константы (HIGH, INPUT, LED_BUILTIN…), объекты (Serial, SPI, Wire…) и
// известные функции (digitalWrite, millis…) красятся в свои цвета. Работает
// во всех темах — цвета берутся из CSS-переменных --tok-constant/--tok-arduino.
import { ViewPlugin, Decoration, type DecorationSet, type EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import type { SyntaxNodeRef } from '@lezer/common';

const CONSTANTS = new Set([
  'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP', 'LED_BUILTIN',
  'CHANGE', 'RISING', 'FALLING', 'PI', 'HALF_PI', 'QUARTER_PI',
  'DEC', 'HEX', 'OCT', 'BIN', 'MSBFIRST', 'LSBFIRST',
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
  'DEFAULT', 'EXTERNAL', 'INTERNAL', 'SPI_CLOCK_DIV2', 'SPI_CLOCK_DIV4',
  'SPI_CLOCK_DIV8', 'SPI_CLOCK_DIV16', 'SPI_CLOCK_DIV32', 'SPI_CLOCK_DIV64',
  'SPI_CLOCK_DIV128', 'SPI_MODE0', 'SPI_MODE1', 'SPI_MODE2', 'SPI_MODE3',
]);
const OBJECTS = new Set(['Serial', 'Serial1', 'Serial2', 'Serial3', 'SPI', 'Wire', 'EEPROM', 'USBSerial']);
const FUNCS = new Set([
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'analogReference',
  'delay', 'delayMicroseconds', 'millis', 'micros', 'pulseIn', 'pulseInLong',
  'shiftIn', 'shiftOut', 'tone', 'noTone', 'random', 'randomSeed',
  'attachInterrupt', 'detachInterrupt', 'interrupts', 'noInterrupts', 'digitalPinToInterrupt',
  'map', 'constrain', 'abs', 'min', 'max', 'pow', 'sqrt', 'sin', 'cos', 'tan',
  'lowByte', 'highByte', 'bitRead', 'bitWrite', 'bitSet', 'bitClear', 'bit', 'isinf', 'isnan',
]);

const markConst = Decoration.mark({ class: 'tok-ard-const' });
const markObj = Decoration.mark({ class: 'tok-ard-obj' });
const markFn = Decoration.mark({ class: 'tok-ard-fn' });

function build(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  const adds: { from: number; to: number; d: Decoration }[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(node: SyntaxNodeRef) {
        if (!/Identifier/.test(node.name)) return;
        const text = doc.sliceString(node.from, node.to);
        if (OBJECTS.has(text)) adds.push({ from: node.from, to: node.to, d: markObj });
        else if (CONSTANTS.has(text)) adds.push({ from: node.from, to: node.to, d: markConst });
        else if (FUNCS.has(text) && doc.sliceString(node.to, node.to + 1) === '(') {
          adds.push({ from: node.from, to: node.to, d: markFn });
        }
      },
    });
  }
  adds.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const a of adds) builder.add(a.from, a.to, a.d);
  return builder.finish();
}

export const ardTokens = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(u: any) {
    if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
  }
}, { decorations: (v) => v.decorations });
