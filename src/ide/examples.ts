// Встроенные примеры MicroPIDE — классика Arduino IDE (01.Basics, Digital,
// Analog, Communication). Работают без сервера: это просто текст скетчей.
export interface Example {
  name: string;
  hint: string;
  code: string;
}

export interface ExampleGroup {
  name: string;
  examples: Example[];
}

export const EXAMPLE_GROUPS: ExampleGroup[] = [
  {
    name: '01.Basics',
    examples: [
      {
        name: 'Blink',
        hint: 'Мигаем встроенным светодиодом',
        code: `/*
  Blink
  Мигает встроенным светодиодом (LED_BUILTIN).
*/

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}
`,
      },
      {
        name: 'BlinkWithoutDelay',
        hint: 'Мигаем без delay() — по millis()',
        code: `/* Мигание без delay(): смотрим на часы millis(). */

const int ledPin = LED_BUILTIN;
int ledState = LOW;

unsigned long previousMillis = 0;
const unsigned long interval = 1000;

void setup() {
  pinMode(ledPin, OUTPUT);
}

void loop() {
  unsigned long currentMillis = millis();
  if (currentMillis - previousMillis >= interval) {
    previousMillis = currentMillis;
    ledState = ledState == LOW ? HIGH : LOW;
    digitalWrite(ledPin, ledState);
  }
}
`,
      },
      {
        name: 'AnalogReadSerial',
        hint: 'Читаем А0 и печатаем в монитор порта',
        code: `/* Читаем аналоговый пин A0 и печатаем значение в Serial. */

void setup() {
  Serial.begin(9600);
}

void loop() {
  int sensorValue = analogRead(A0);
  Serial.println(sensorValue);
  delay(100);
}
`,
      },
      {
        name: 'Fade',
        hint: 'Плавное затухание светодиода (PWM)',
        code: `/* Плавное затухание светодиода на ШИМ-пине. */

int led = 9;
int brightness = 0;
int fadeAmount = 5;

void setup() {
  pinMode(led, OUTPUT);
}

void loop() {
  analogWrite(led, brightness);
  brightness += fadeAmount;
  if (brightness <= 0 || brightness >= 255) {
    fadeAmount = -fadeAmount;
  }
  delay(30);
}
`,
      },
      {
        name: 'ReadDigitalInput',
        hint: 'Кнопка на пине 2, светодиод на 13',
        code: `/* Читаем кнопку (пин 2) и включаем светодиод (LED_BUILTIN). */

const int buttonPin = 2;

void setup() {
  pinMode(buttonPin, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  int pressed = digitalRead(buttonPin) == LOW;
  digitalWrite(LED_BUILTIN, pressed ? HIGH : LOW);
}
`,
      },
    ],
  },
  {
    name: '02.Digital',
    examples: [
      {
        name: 'ToneMelody',
        hint: 'Мелодия через piezo-пищалку',
        code: `/* Мелодия «Мэрирула» через piezo на пине 8. */

const int buzzer = 8;

const int melody[] = { 262, 262, 294, 294, 330, 330, 392 };
const int noteDur[] = { 300, 300, 300, 300, 300, 300, 600 };

void setup() {
  for (int i = 0; i < 7; i++) {
    tone(buzzer, melody[i]);
    delay(noteDur[i]);
    noTone(buzzer);
    delay(60);
  }
}

void loop() {
}
`,
      },
      {
        name: 'Debounce',
        hint: 'Антидребезг кнопки',
        code: `/* Счётчик нажатий с антидребезгом. Печать в Serial. */

const int buttonPin = 2;
int counter = 0;

int lastState = HIGH;
unsigned long lastChange = 0;
const unsigned long debounce = 50;

void setup() {
  pinMode(buttonPin, INPUT_PULLUP);
  Serial.begin(9600);
}

void loop() {
  int s = digitalRead(buttonPin);
  if (s != lastState) {
    unsigned long now = millis();
    if (now - lastChange > debounce) {
      lastChange = now;
      if (s == LOW) {
        counter++;
        Serial.print("Нажатий: ");
        Serial.println(counter);
      }
      lastState = s;
    }
  }
}
`,
      },
    ],
  },
  {
    name: '03.Analog',
    examples: [
      {
        name: 'Smoothing',
        hint: 'Сглаживание аналоговых показаний',
        code: `/* Сглаживание показаний А0 скользящим средним. */

const int numReadings = 10;
int readings[numReadings];
int idx = 0;
long total = 0;

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < numReadings; i++) readings[i] = 0;
}

void loop() {
  total -= readings[idx];
  readings[idx] = analogRead(A0);
  total += readings[idx];
  idx = (idx + 1) % numReadings;
  Serial.println(total / numReadings);
  delay(50);
}
`,
      },
      {
        name: 'AnalogInOut',
        hint: 'Потенциометр управляет яркостью светодиода',
        code: `/* А0 — потенциометр, пин 9 — светодиод: яркость = положение ручки. */

const int analogInPin = A0;
const int analogOutPin = 9;

int sensorValue = 0;
int outputValue = 0;

void setup() {
  Serial.begin(9600);
}

void loop() {
  sensorValue = analogRead(analogInPin);
  outputValue = map(sensorValue, 0, 1023, 0, 255);
  analogWrite(analogOutPin, outputValue);
  Serial.print("sensor = ");
  Serial.print(sensorValue);
  Serial.print(" -> output = ");
  Serial.println(outputValue);
  delay(10);
}
`,
      },
    ],
  },
  {
    name: '04.Communication',
    examples: [
      {
        name: 'SerialEvent',
        hint: 'Эхо-монитор: что пришло — то и вернули',
        code: `/* Эхо через Serial: пришедшая строка возвращается с приветом. */

String input = "";

void setup() {
  Serial.begin(9600);
  Serial.println("MicroPIDE эхо. Введите строку:");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\\n') {
      Serial.print("Вы сказали: ");
      Serial.println(input);
      input = "";
    } else if (c != '\\r') {
      input += c;
    }
  }
}
`,
      },
      {
        name: 'Graph',
        hint: 'Данные для построителя графиков',
        code: `/* Печать значений для «Построителя графиков»: синус + шум. */

void setup() {
  Serial.begin(115200);
}

void loop() {
  float t = millis() / 1000.0;
  Serial.print(sin(t) * 100.0);
  Serial.print("\\t");
  Serial.print(sin(t * 2.3) * 60.0);
  Serial.print("\\t");
  Serial.println(random(-20, 20));
  delay(30);
}
`,
      },
      {
        name: 'Dimmer',
        hint: 'Управление яркостью из монитора (0–255)',
        code: `/* Печатаете число 0..255 в монитор — светодиод на 9 получает яркость. */

const int ledPin = 9;

void setup() {
  Serial.begin(9600);
  pinMode(ledPin, OUTPUT);
}

void loop() {
  if (Serial.available()) {
    int v = Serial.parseInt();
    if (v >= 0 && v <= 255) {
      analogWrite(ledPin, v);
      Serial.print("Яркость: ");
      Serial.println(v);
    }
  }
}
`,
      },
    ],
  },
];
