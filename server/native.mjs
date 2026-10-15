// Симулятор MicroPIDE: скетч запускается как обычная программа на компьютере.
//
// Идея «всё своё»: у Arduino нет симулятора без установки чужого пакета, а у нас
// есть собственное ядро-рантайм для ПК. Мы генерируем исходники этого ядра
// (Arduino.h + реализация: Serial, millis/delay с виртуальными часами, пины,
// АЦП, I2C, EEPROM), собираем скетч нативным g++ через тот же сборщик
// buildcore.mjs и запускаем с файлом сценария. Задержки можно «прокручивать»
// мгновенно (fast on) — 10 секунд логики проверяются за миллисекунды.
//
// Наружу (в UI и в тесты) отдаём:
//   • вывод Serial с виртуальными метками времени;
//   • события пинов и ШИМ — их можно проверять сценарием (expect_pin);
//   • код выхода и понятный лог, если скетч не компилируется.
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './arduino.mjs';
import { buildWithOwnEngine, findToolchain, loadCoreProps, registerCoreProvider } from './buildcore.mjs';
import { parseScenario, parseTrace, checkExpectations } from './scenario.mjs';

export const SIM_FQBN = 'micropide:sim:sim';

// Своё ядро симулятора разворачивается на месте: сборка под micropide:sim:sim
// работает сразу, без склада и без интернета.
registerCoreProvider((fqbn) => (String(fqbn || '') === SIM_FQBN ? ensureNativeCore() : false));
const SIM_ROOT = () => join(DATA_DIR, 'packages', 'micropide', 'hardware', 'sim');
const SIM_VER = '1.0.0';

// ---------------------------------------------------------------------------
// Исходники нашего «ядра для ПК». Пишутся на диск один раз (по хэшу).
// ---------------------------------------------------------------------------

const ARDUINO_H = String.raw`// Arduino.h — минимальный Arduino-совместимый рантайм MicroPIDE для ПК.
// Это НЕ копия чужого кода: написано для MicroPIDE, покрывает тот срез API,
// который нужен обычному скетчу, и позволяет проверить логику без платы.
#pragma once
#define MICROPIDE_SIM 1
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <ctype.h>
#include <string>
#include <vector>
#include <map>

typedef uint8_t byte;
typedef bool boolean;
typedef unsigned int word;

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define LSBFIRST 0
#define MSBFIRST 1
#define CHANGE 1
#define FALLING 2
#define RISING 3
#define DEFAULT 0
#define EXTERNAL 0
#define INTERNAL 1
#define NOT_AN_INTERRUPT -1
#define DEC 10
#define HEX 16
#define OCT 8
#define BIN 2
#define PROGMEM
#define PSTR(s) (s)
#define F(s) (s)
#define pgm_read_byte(p) (*(const unsigned char *)(p))
#define pgm_read_word(p) (*(const unsigned short *)(p))
#define LED_BUILTIN 13
#define PI 3.1415926535897932384626433832795
#define HALF_PI 1.5707963267948966192313216916398
#define TWO_PI 6.283185307179586476925286766559
#define DEG_TO_RAD 0.017453292519943295769236907684886
#define RAD_TO_DEG 57.295779513082320876798154814105

#define A0 14
#define A1 15
#define A2 16
#define A3 17
#define A4 18
#define A5 19
#define A6 20
#define A7 21
#define A8 22
#define A9 23
#define A10 24
#define A11 25
#define A12 26
#define A13 27
#define A14 28
#define A15 29

#ifndef min
#define min(a, b) ((a) < (b) ? (a) : (b))
#endif
#ifndef max
#define max(a, b) ((a) > (b) ? (a) : (b))
#endif
#ifndef abs
#define abs(x) ((x) > 0 ? (x) : -(x))
#endif
#ifndef constrain
#define constrain(a, l, h) ((a) < (l) ? (l) : ((a) > (h) ? (h) : (a)))
#endif
#ifndef round
#define round(x) ((x) >= 0 ? (long)((x) + 0.5) : (long)((x) - 0.5))
#endif
#define radians(d) ((d) * DEG_TO_RAD)
#define degrees(r) ((r) * RAD_TO_DEG)
#define sq(x) ((x) * (x))
#define bitRead(v, b) (((v) >> (b)) & 0x01)
#define bitSet(v, b) ((v) |= (1UL << (b)))
#define bitClear(v, b) ((v) &= ~(1UL << (b)))
#define bitWrite(v, b, x) ((x) ? bitSet(v, b) : bitClear(v, b))
#define bit(b) (1UL << (b))
#define lowByte(w) ((uint8_t)((w) & 0xff))
#define highByte(w) ((uint8_t)((w) >> 8))
#define digitalPinToInterrupt(p) (p)
#define digitalPinHasPWM(p) (1)
#define analogPinToChannel(p) ((p) - 14)
#define interrupts() sim_interrupts_enable()
#define noInterrupts() sim_interrupts_disable()
#define sei() sim_interrupts_enable()
#define cli() sim_interrupts_disable()

// ------------------------------------------------------------------ String
class String {
public:
  String() {}
  String(const char *s) : buf(s ? s : "") {}
  String(const std::string &s) : buf(s) {}
  String(char c) : buf(1, c) {}
  String(int v) { char t[24]; snprintf(t, sizeof(t), "%d", v); buf = t; }
  String(unsigned int v) { char t[24]; snprintf(t, sizeof(t), "%u", v); buf = t; }
  String(long v) { char t[32]; snprintf(t, sizeof(t), "%ld", v); buf = t; }
  String(unsigned long v) { char t[32]; snprintf(t, sizeof(t), "%lu", v); buf = t; }
  String(double v, int digits = 2) { char t[64]; snprintf(t, sizeof(t), "%.*f", digits, v); buf = t; }
  String(float v, int digits = 2) { char t[64]; snprintf(t, sizeof(t), "%.*f", digits, (double)v); buf = t; }
  // Перегрузки с основанием (DEC/HEX/BIN): без них String(analogRead(A0), DEC)
  // даёт «ambiguous» — а это очень частый приём в скетчах.
  static String fromNumber(long v, int base) {
    char t[36] = {0}; int i = 34;
    const char *d = base == 16 ? "0123456789abcdef" : base == 2 ? "01" : "0123456789";
    const bool neg = v < 0 && base == 10;
    unsigned long u = neg ? (unsigned long)(-v) : (unsigned long)v;
    if (!u) t[--i] = '0';
    while (u) { t[--i] = d[u % (unsigned)base]; u /= (unsigned)base; }
    if (neg) t[--i] = '-';
    return String(t + i);
  }
  String(int v, int base) : String(fromNumber(v, base)) {}
  String(unsigned int v, int base) : String(fromNumber((long)v, base)) {}
  String(long v, int base) : String(fromNumber(v, base)) {}
  String(unsigned long v, int base) : String(fromNumber((long)v, base)) {}
  String(char c, int base) : String(fromNumber((long)c, base)) {}

  unsigned int length() const { return (unsigned int)buf.size(); }
  const char *c_str() const { return buf.c_str(); }
  char charAt(unsigned int i) const { return i < buf.size() ? buf[i] : 0; }
  char operator[](unsigned int i) const { return charAt(i); }
  String substring(unsigned int from) const { return String(from < buf.size() ? buf.substr(from) : std::string()); }
  String substring(unsigned int from, unsigned int to) const {
    if (from >= buf.size() || to <= from) return String();
    return String(buf.substr(from, to - from));
  }
  int indexOf(char c) const { size_t p = buf.find(c); return p == std::string::npos ? -1 : (int)p; }
  int indexOf(const String &s) const { size_t p = buf.find(s.buf); return p == std::string::npos ? -1 : (int)p; }
  int indexOf(char c, unsigned int from) const { size_t p = buf.find(c, from); return p == std::string::npos ? -1 : (int)p; }
  int lastIndexOf(char c) const { size_t p = buf.rfind(c); return p == std::string::npos ? -1 : (int)p; }
  long toInt() const { return strtol(buf.c_str(), nullptr, 10); }
  double toDouble() const { return strtod(buf.c_str(), nullptr); }
  float toFloat() const { return (float)strtod(buf.c_str(), nullptr); }
  bool equals(const String &s) const { return buf == s.buf; }
  bool equalsIgnoreCase(const String &s) const {
    if (buf.size() != s.buf.size()) return false;
    for (size_t i = 0; i < buf.size(); i++) if (tolower(buf[i]) != tolower(s.buf[i])) return false;
    return true;
  }
  bool startsWith(const String &s) const { return buf.rfind(s.buf, 0) == 0; }
  bool endsWith(const String &s) const { return buf.size() >= s.buf.size() && buf.compare(buf.size() - s.buf.size(), s.buf.size(), s.buf) == 0; }
  void trim() {
    size_t a = buf.find_first_not_of(" \t\r\n");
    size_t b = buf.find_last_not_of(" \t\r\n");
    buf = (a == std::string::npos) ? "" : buf.substr(a, b - a + 1);
  }
  void toUpperCase() { for (auto &c : buf) c = toupper(c); }
  void toLowerCase() { for (auto &c : buf) c = tolower(c); }
  void replace(const String &from, const String &to) {
    if (from.buf.empty()) return;
    size_t p = 0;
    while ((p = buf.find(from.buf, p)) != std::string::npos) { buf.replace(p, from.buf.size(), to.buf); p += to.buf.size(); }
  }
  void remove(unsigned int idx) { if (idx < buf.size()) buf.erase(idx); }
  void concat(const String &s) { buf += s.buf; }
  void reserve(unsigned int n) { buf.reserve(n); }
  operator const char *() const { return buf.c_str(); }
  String &operator+=(const String &s) { buf += s.buf; return *this; }
  String &operator+=(char c) { buf += c; return *this; }
  String &operator+=(const char *s) { buf += (s ? s : ""); return *this; }
  String &operator+=(int v) { buf += String(v).buf; return *this; }
  String &operator+=(long v) { buf += String(v).buf; return *this; }
  String &operator+=(double v) { buf += String(v).buf; return *this; }
  bool operator==(const String &s) const { return buf == s.buf; }
  bool operator!=(const String &s) const { return buf != s.buf; }
  bool operator<(const String &s) const { return buf < s.buf; }
  const std::string &str() const { return buf; }
private:
  std::string buf;
};
inline String operator+(const String &a, const String &b) { String r(a); r += b; return r; }
inline String operator+(const String &a, const char *b) { String r(a); r += b; return r; }
inline String operator+(const char *a, const String &b) { String r(a); r += b; return r; }
inline String operator+(const String &a, int b) { String r(a); r += b; return r; }
inline String operator+(const String &a, char b) { String r(a); r += b; return r; }

// Нутро симулятора: объявляем до классов — их тела используют эти функции.
void sim_flush_serial();
void sim_interrupts_enable();
void sim_interrupts_disable();
bool sim_i2c_ack(uint8_t addr);
std::vector<uint8_t> sim_i2c_read(uint8_t addr, size_t n);
uint8_t sim_spi_transfer(uint8_t v);
unsigned long sim_now_ms();
void sim_init(int argc, char **argv);
void sim_tick();
bool sim_done();
void sim_finish();

// ------------------------------------------------------------------ Print/Stream
class Print {
public:
  virtual size_t write(uint8_t) = 0;
  virtual ~Print() {}
  size_t write(const char *s) { size_t n = 0; while (s && *s) n += write((uint8_t)*s++); return n; }
  size_t write(const char *s, size_t n) { size_t k = 0; for (size_t i = 0; i < n; i++) k += write((uint8_t)s[i]); return k; }
  size_t write(const uint8_t *b, size_t n) { size_t k = 0; for (size_t i = 0; i < n; i++) k += write(b[i]); return k; }
  size_t print(const char *s) { return write(s); }
  size_t print(const String &s) { return write(s.c_str()); }
  size_t print(char c) { return write((uint8_t)c); }
  size_t print(int v, int base = 10) { return printNumber((unsigned long)(v < 0 ? -v : v), base, v < 0); }
  size_t print(unsigned int v, int base = 10) { return printNumber(v, base, false); }
  size_t print(long v, int base = 10) { return printNumber((unsigned long)(v < 0 ? -v : v), base, v < 0); }
  size_t print(unsigned long v, int base = 10) { return printNumber(v, base, false); }
  size_t print(double v, int digits = 2) { return printFloat(v, digits); }
  size_t print(float v, int digits = 2) { return printFloat(v, digits); }
  size_t println() { return write((uint8_t)'\n'); }
  template <typename T> size_t println(T v) { size_t n = print(v); return n + println(); }
  size_t println(int v, int base) { size_t n = print(v, base); return n + println(); }
  size_t println(double v, int digits) { size_t n = print(v, digits); return n + println(); }
  size_t println(const char *s) { size_t n = print(s); return n + println(); }
  size_t println(const String &s) { size_t n = print(s); return n + println(); }
protected:
  size_t printNumber(unsigned long v, int base, bool neg) {
    char t[34]; int i = 33; t[i] = 0;
    if (base == 10) { if (!v) t[--i] = '0'; while (v) { t[--i] = (char)('0' + v % 10); v /= 10; } }
    else if (base == 16) { if (!v) t[--i] = '0'; while (v) { t[--i] = "0123456789abcdef"[v & 0xf]; v >>= 4; } }
    else if (base == 2) { if (!v) t[--i] = '0'; while (v) { t[--i] = (char)('0' + (v & 1)); v >>= 1; } }
    else { if (!v) t[--i] = '0'; while (v) { t[--i] = (char)('0' + v % base); v /= base; } }
    size_t n = 0;
    if (neg) n += write((uint8_t)'-');
    return write(t + i) + n;
  }
  size_t printFloat(double v, int digits) {
    char t[96];
    snprintf(t, sizeof(t), "%.*f", digits, v);
    return write(t);
  }
};

class Stream : public Print {
public:
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
  virtual void flush() {}
  virtual int availableForWrite() { return 64; }
  void setTimeout(unsigned long t) { timeout = t; }
  size_t readBytes(char *buf, size_t len) { size_t n = 0; while (n < len && available()) buf[n++] = (char)read(); return n; }
  size_t readBytes(uint8_t *buf, size_t len) { return readBytes((char *)buf, len); }
  String readString() { String s; while (available()) s += (char)read(); return s; }
  String readStringUntil(char term) { String s; int c; while ((c = read()) >= 0 && (char)c != term) s += (char)c; return s; }
  long parseInt() { long v = 0; bool neg = false, any = false; while (available()) { int c = peek(); if (c == '-' && !any) { neg = true; read(); continue; } if (c < '0' || c > '9') break; v = v * 10 + (read() - '0'); any = true; } return neg ? -v : v; }
  float parseFloat() { String s; while (available() && (isdigit(peek()) || peek() == '-' || peek() == '.' || peek() == '+')) s += (char)read(); return s.toFloat(); }
  bool find(const char *target) { size_t i = 0; while (available()) { int c = read(); if ((char)c == target[i]) { if (!target[++i]) return true; } else i = 0; } return false; }
protected:
  unsigned long timeout = 1000;
};

// ------------------------------------------------------------------ Serial
class SimSerial : public Stream {
public:
  void begin(unsigned long baud) { baudrate = baud; started = true; }
  void begin(unsigned long baud, uint32_t) { begin(baud); }
  void end() { started = false; }
  void flush() { sim_flush_serial(); }
  int available() override;
  int read() override;
  int peek() override;
  size_t write(uint8_t b) override;
  // без using базовые write(const char*) / write(const uint8_t*, n) оказываются
  // скрыты перегрузкой — и Serial.write(buf, sizeof(buf)) не компилируется
  using Print::write;
  operator bool() const { return true; }
  unsigned long baudrate = 9600;
  bool started = false;
};

// ------------------------------------------------------------------ Wire/SPI/EEPROM
class TwoWire {
public:
  void begin() { begin(100000); }
  void begin(int) {}
  void beginTransmission(uint8_t a) { addr = a; tx.clear(); }
  void beginTransmission(int a) { beginTransmission((uint8_t)a); }
  size_t write(uint8_t b) { tx.push_back(b); return 1; }
  size_t write(const uint8_t *b, size_t n) { for (size_t i = 0; i < n; i++) tx.push_back(b[i]); return n; }
  uint8_t endTransmission(bool = true) { lastTx = addr; txCount = (int)tx.size(); return sim_i2c_ack(addr) ? 0 : 2; }
  uint8_t requestFrom(uint8_t a, uint8_t n) { rx = sim_i2c_read(a, n); rxPos = 0; return (uint8_t)rx.size(); }
  uint8_t requestFrom(int a, int n) { return requestFrom((uint8_t)a, (uint8_t)n); }
  int available() { return (int)rx.size() - rxPos; }
  int read() { return rxPos < (int)rx.size() ? rx[rxPos++] : -1; }
  int peek() { return rxPos < (int)rx.size() ? rx[rxPos] : -1; }
  size_t readBytes(uint8_t *b, size_t n) { size_t k = 0; while (k < n && available()) b[k++] = (uint8_t)read(); return k; }
  void setClock(uint32_t) {}
private:
  uint8_t addr = 0, lastTx = 0; int txCount = 0;
  std::vector<uint8_t> tx, rx; size_t rxPos = 0;
};
struct SPISettings {
  SPISettings() {}
  SPISettings(uint32_t, uint8_t, uint8_t) {}
};
class SPIClass {
public:
  void begin() {}
  void end() {}
  void beginTransaction(int) {}
  void endTransaction() {}
  uint8_t transfer(uint8_t v) { return sim_spi_transfer(v); }
  uint16_t transfer16(uint16_t v) { return (uint16_t)((transfer(v >> 8) << 8) | transfer(v & 0xff)); }
  void setBitOrder(int) {}
  void setDataMode(int) {}
  void setClockDivider(int) {}
};
class EEPROMClass {
public:
  uint8_t read(int a) { return eeprom[a % (int)sizeof(eeprom)]; }
  void write(int a, uint8_t v) { eeprom[a % (int)sizeof(eeprom)] = v; }
  void update(int a, uint8_t v) { write(a, v); }
  uint16_t length() { return (uint16_t)sizeof(eeprom); }
  uint8_t &operator[](int a) { return eeprom[a % (int)sizeof(eeprom)]; }
private:
  uint8_t eeprom[1024] = {0};
};

// ------------------------------------------------------------------ переменные ядра
extern SimSerial Serial;
extern TwoWire Wire;
extern SPIClass SPI;
extern EEPROMClass EEPROM;

void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t value);
int digitalRead(uint8_t pin);
int analogRead(uint8_t pin);
void analogWrite(uint8_t pin, int value);
void analogReference(uint8_t mode);
unsigned long millis();
unsigned long micros();
void delay(unsigned long ms);
void delayMicroseconds(unsigned int us);
unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout = 1000000UL);
unsigned long pulseInLong(uint8_t pin, uint8_t state, unsigned long timeout = 1000000UL);
void shiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t val);
uint8_t shiftIn(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder);
void tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0);
void noTone(uint8_t pin);
void attachInterrupt(uint8_t interruptNum, void (*userFunc)(void), int mode);
void detachInterrupt(uint8_t interruptNum);
void yield();
long random(long howbig);
long random(long howsmall, long howbig);
void randomSeed(unsigned long seed);
long map(long x, long in_min, long in_max, long out_min, long out_max);

`;

const ARDUINO_CPP = String.raw`// Реализация симулятора MicroPIDE для ПК.
// Стандартные заголовки — до Arduino.h: наши макросы min/max/near мешают libstdc++.
#include <fstream>
#include <sstream>
#include <iostream>
#include <algorithm>
#include "Arduino.h"

SimSerial Serial;
TwoWire Wire;
SPIClass SPI;
EEPROMClass EEPROM;

// ------------------------------------------------------------------ состояние
struct Action {
  unsigned long at;       // виртуальное время, мс
  std::string kind;       // pin | adc | send | interrupt | i2c
  int pin = -1;
  int value = 0;
  std::string text;
  std::string mode;
};
static std::vector<Action> g_actions;
static size_t g_nextAction = 0;
static unsigned long g_now = 0;          // виртуальные мс
static unsigned long g_duration = 3000;
static bool g_fast = false;
static unsigned long g_loopLimit = 5000000;
static unsigned long g_iterations = 0;
static bool g_aborted = false;
static bool g_serialStarted = true;
static std::string g_pending;            // байты, ещё не попавшие в трассу
static unsigned long g_lastFlush = 0;
static std::ofstream g_trace;
static std::vector<uint8_t> g_serialRx;  // то, что «пришло» в порт
static size_t g_rxPos = 0;
static std::map<int, int> g_extDigital;  // внешние уровни на пинах
static std::map<int, int> g_outDigital;  // что мы выставили
static std::map<int, int> g_pwm;
static std::map<int, int> g_adc;
static std::map<int, std::vector<uint8_t>> g_i2cData;
static std::map<int, bool> g_i2cAck;
static std::map<uint8_t, void (*)(void)> g_isr;
static std::map<uint8_t, int> g_isrMode;
static bool g_isrBusy = false;
static int g_interruptsEnabled = 1;
static bool g_traceHeader = false;

static std::string b64(const std::string &in) {
  static const char *tab = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  size_t i = 0;
  while (i + 2 < in.size()) {
    unsigned v = (unsigned char)in[i] << 16 | (unsigned char)in[i + 1] << 8 | (unsigned char)in[i + 2];
    out += tab[(v >> 18) & 63]; out += tab[(v >> 12) & 63]; out += tab[(v >> 6) & 63]; out += tab[v & 63];
    i += 3;
  }
  if (i + 1 == in.size()) {
    unsigned v = (unsigned char)in[i] << 16;
    out += tab[(v >> 18) & 63]; out += tab[(v >> 12) & 63]; out += "==";
  } else if (i + 2 == in.size()) {
    unsigned v = (unsigned char)in[i] << 16 | (unsigned char)in[i + 1] << 8;
    out += tab[(v >> 18) & 63]; out += tab[(v >> 12) & 63]; out += tab[(v >> 6) & 63]; out += '=';
  }
  return out;
}

unsigned long sim_now_ms() { return g_now; }

void sim_flush_serial() {
  if (g_pending.empty()) return;
  if (g_trace.is_open()) g_trace << g_now << "\tout\t" << b64(g_pending) << "\n";
  g_trace.flush();
  g_pending.clear();
  g_lastFlush = g_now;
}

static void tracePin(int pin, int value) {
  if (g_trace.is_open()) { g_trace << g_now << "\tpin\t" << pin << "=" << value << "\n"; g_trace.flush(); }
}
static void tracePwm(int pin, int value) {
  if (g_trace.is_open()) { g_trace << g_now << "\tpwm\t" << pin << "=" << value << "\n"; g_trace.flush(); }
}

// ------------------------------------------------------------------ сценарий
static std::string trim(const std::string &s) {
  size_t a = s.find_first_not_of(" \t\r\n");
  size_t b = s.find_last_not_of(" \t\r\n");
  return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}
static std::vector<std::string> splitWs(const std::string &s) {
  std::vector<std::string> out; std::istringstream is(s); std::string t;
  while (is >> t) out.push_back(t);
  return out;
}
static std::string unquote(const std::string &s) {
  std::string t = trim(s);
  if (t.size() >= 2 && (t.front() == '"' || t.front() == '\'')) t = t.substr(1, t.size() - 2);
  std::string out;
  for (size_t i = 0; i < t.size(); i++) {
    if (t[i] == '\\' && i + 1 < t.size()) {
      char c = t[++i];
      out += (c == 'n') ? '\n' : (c == 'r') ? '\r' : (c == 't') ? '\t' : c;
    } else out += t[i];
  }
  return out;
}
static int pinNum(const std::string &s) {
  if (s.size() >= 2 && (s[0] == 'D' || s[0] == 'd')) return atoi(s.c_str() + 1);
  if (s.size() >= 2 && (s[0] == 'A' || s[0] == 'a')) return 14 + atoi(s.c_str() + 1);
  return atoi(s.c_str());
}

static void loadScenario(const char *path) {
  std::ifstream f(path);
  if (!f.is_open()) return;
  std::string line;
  unsigned long t = 0;
  while (std::getline(f, line)) {
    std::string s = trim(line);
    if (s.empty() || s[0] == '#') continue;
    // отрезаем комментарий в конце строки
    size_t hash = s.find(" #");
    if (hash != std::string::npos) s = trim(s.substr(0, hash));
    auto parts = splitWs(s);
    if (parts.empty()) continue;
    std::string cmd = parts[0];
    std::string rest = trim(s.substr(cmd.size()));
    if (cmd == "duration") { g_duration = strtoul(rest.c_str(), nullptr, 10); }
    else if (cmd == "fast") { g_fast = !(rest == "off" || rest == "0" || rest == "no"); }
    else if (cmd == "loop_limit") { g_loopLimit = strtoul(rest.c_str(), nullptr, 10); }
    else if (cmd == "wait") { t += strtoul(rest.c_str(), nullptr, 10); }
    else if (cmd == "pin") {
      size_t eq = rest.find('=');
      if (eq == std::string::npos) continue;
      Action a; a.at = t; a.kind = "pin";
      a.pin = pinNum(trim(rest.substr(0, eq)));
      a.value = atoi(trim(rest.substr(eq + 1)).c_str());
      g_actions.push_back(a);
    } else if (cmd == "adc" || cmd == "analog") {
      size_t eq = rest.find('=');
      if (eq == std::string::npos) continue;
      Action a; a.at = t; a.kind = "adc";
      a.pin = pinNum(trim(rest.substr(0, eq)));
      a.value = atoi(trim(rest.substr(eq + 1)).c_str());
      g_actions.push_back(a);
    } else if (cmd == "pulse") {
      size_t eq = rest.find('=');
      if (eq == std::string::npos) continue;
      int pin = pinNum(trim(rest.substr(0, eq)));
      auto vals = splitWs(trim(rest.substr(eq + 1)));
      std::string csv = vals.empty() ? "" : vals[0];
      auto commas = splitWs(csv);
      // формат 0,200,1
      std::string v0, ms, v1;
      { std::istringstream is(csv); std::string p; int k = 0; while (std::getline(is, p, ',')) { if (k == 0) v0 = p; else if (k == 1) ms = p; else if (k == 2) v1 = p; k++; } }
      Action a; a.at = t; a.kind = "pin"; a.pin = pin; a.value = atoi(v0.c_str()); g_actions.push_back(a);
      t += strtoul(ms.c_str(), nullptr, 10);
      Action b; b.at = t; b.kind = "pin"; b.pin = pin; b.value = atoi(v1.c_str()); g_actions.push_back(b);
    } else if (cmd == "serial" || cmd == "send") {
      Action a; a.at = t; a.kind = "send"; a.text = unquote(rest); g_actions.push_back(a);
    } else if (cmd == "interrupt") {
      size_t eq = rest.find('=');
      if (eq == std::string::npos) continue;
      Action a; a.at = t; a.kind = "interrupt";
      a.pin = pinNum(trim(rest.substr(0, eq)));
      a.mode = trim(rest.substr(eq + 1));
      g_actions.push_back(a);
    } else if (cmd == "i2c") {
      size_t eq = rest.find('=');
      if (eq == std::string::npos) continue;
      int addr = (int)strtol(trim(rest.substr(0, eq)).c_str(), nullptr, 0);
      g_i2cAck[addr] = true;
      std::vector<uint8_t> data;
      std::istringstream is(trim(rest.substr(eq + 1)));
      std::string p;
      while (std::getline(is, p, ',')) data.push_back((uint8_t)strtol(trim(p).c_str(), nullptr, 0));
      g_i2cData[addr] = data;
    }
    // expect* и прочее проверяет сервер — рантайм их игнорирует
  }
  // стабильная сортировка по времени
  for (size_t i = 1; i < g_actions.size(); i++)
    for (size_t j = i; j > 0 && g_actions[j].at < g_actions[j - 1].at; j--) std::swap(g_actions[j], g_actions[j - 1]);
}

void sim_interrupts_enable() { g_interruptsEnabled = 1; }
void sim_interrupts_disable() { g_interruptsEnabled = 0; }
bool sim_i2c_ack(uint8_t addr) { auto it = g_i2cAck.find(addr); return it != g_i2cAck.end() ? it->second : true; }
std::vector<uint8_t> sim_i2c_read(uint8_t addr, size_t n) {
  std::vector<uint8_t> out;
  auto it = g_i2cData.find(addr);
  if (it != g_i2cData.end()) {
    for (size_t i = 0; i < n; i++) out.push_back(it->second.empty() ? 0 : it->second[i % it->second.size()]);
  } else for (size_t i = 0; i < n; i++) out.push_back(0);
  return out;
}
uint8_t sim_spi_transfer(uint8_t v) { (void)v; return 0; }

static void fireInterrupt(int pin, int level) {
  auto it = g_isr.find((uint8_t)pin);
  if (it == g_isr.end() || !g_interruptsEnabled || g_isrBusy) return;
  int mode = g_isrMode[(uint8_t)pin];
  bool fire = (mode == CHANGE) || (mode == RISING && level == 1) || (mode == FALLING && level == 0);
  if (!fire) return;
  g_isrBusy = true;
  it->second();
  g_isrBusy = false;
}

static void applyActions() {
  while (g_nextAction < g_actions.size() && g_actions[g_nextAction].at <= g_now) {
    const Action &a = g_actions[g_nextAction++];
    if (a.kind == "pin") {
      g_extDigital[a.pin] = a.value;
      fireInterrupt(a.pin, a.value);
    } else if (a.kind == "adc") {
      g_adc[a.pin] = a.value;
    } else if (a.kind == "send") {
      for (char c : a.text) g_serialRx.push_back((uint8_t)c);
    } else if (a.kind == "interrupt") {
      int mode = a.mode == "RISING" ? RISING : a.mode == "FALLING" ? FALLING : CHANGE;
      g_isrMode[(uint8_t)a.pin] = mode;
      int level = (mode == FALLING) ? 0 : 1;
      g_extDigital[a.pin] = level;
      fireInterrupt(a.pin, level);
    }
  }
}

static unsigned long nextActionTime() {
  return g_nextAction < g_actions.size() ? g_actions[g_nextAction].at : (unsigned long)-1;
}

void sim_init(int argc, char **argv) {
  const char *scenario = getenv("MICROPIDE_SIM_SCENARIO");
  const char *tracePath = getenv("MICROPIDE_SIM_TRACE");
  if (scenario) loadScenario(scenario);
  const char *dur = getenv("MICROPIDE_SIM_DURATION");
  if (dur) g_duration = strtoul(dur, nullptr, 10);
  const char *fast = getenv("MICROPIDE_SIM_FAST");
  if (fast) g_fast = !(std::string(fast) == "0");
  (void)argc; (void)argv;
  if (tracePath) g_trace.open(tracePath, std::ios::out | std::ios::trunc);
  setvbuf(stdout, nullptr, _IONBF, 0);
}

void sim_tick() {
  g_iterations++;
  applyActions();
  // Если скетч не спит — двигаем виртуальное время сами, чтобы wait/ожидания
  // сценария наступали, а не висели вечно.
  if (g_iterations % 2000 == 0) g_now++;
  if (g_pending.size() >= 32 || (!g_pending.empty() && g_now - g_lastFlush >= 5)) sim_flush_serial();
  if (g_iterations > g_loopLimit) { g_aborted = true; }
}

bool sim_done() {
  applyActions();
  if (g_aborted) return true;
  if (g_now >= g_duration && g_nextAction >= g_actions.size()) return true;
  return false;
}

void sim_finish() {
  sim_flush_serial();
  if (g_trace.is_open()) {
    g_trace << g_now << "\tsummary\titerations=" << g_iterations << ",ms=" << g_now
            << ",aborted=" << (g_aborted ? 1 : 0) << "\n";
    g_trace.close();
  }
  fprintf(stderr, "[sim] виртуально %lu мс, итераций %lu%s\n", g_now, g_iterations, g_aborted ? " (остановлен по лимиту циклов)" : "");
}

// ------------------------------------------------------------------ Serial
int SimSerial::available() { return (int)g_serialRx.size() - (int)g_rxPos; }
int SimSerial::read() { return g_rxPos < g_serialRx.size() ? g_serialRx[g_rxPos++] : -1; }
int SimSerial::peek() { return g_rxPos < g_serialRx.size() ? g_serialRx[g_rxPos] : -1; }
size_t SimSerial::write(uint8_t b) {
  if (!started) return 1;
  g_pending += (char)b;
  fputc(b, stdout);
  if (b == '\n' || g_pending.size() >= 32) sim_flush_serial();
  return 1;
}

// ------------------------------------------------------------------ пины и время
void pinMode(uint8_t pin, uint8_t mode) { (void)pin; (void)mode; }
void digitalWrite(uint8_t pin, uint8_t value) {
  int v = value ? 1 : 0;
  if (g_outDigital[pin] == v) return;
  g_outDigital[pin] = v;
  tracePin(pin, v);
  if (g_extDigital.find(pin) == g_extDigital.end()) fireInterrupt(pin, v);
}
int digitalRead(uint8_t pin) {
  auto it = g_extDigital.find(pin);
  if (it != g_extDigital.end()) return it->second;
  return g_outDigital[pin];
}
int analogRead(uint8_t pin) {
  auto it = g_adc.find(pin);
  if (it != g_adc.end()) return it->second;
  return 512;
}
void analogWrite(uint8_t pin, int value) {
  g_pwm[pin] = value;
  tracePwm(pin, value);
}
void analogReference(uint8_t) {}
unsigned long millis() { return g_now; }
unsigned long micros() { return g_now * 1000UL; }
void delay(unsigned long ms) {
  if (ms == 0) return;
  unsigned long target = g_now + ms;
  while (g_now < target) {
    g_now++;              // виртуальные часы идут всегда — тесты не ждут реального времени
    applyActions();
    sim_flush_serial();
  }
}
void delayMicroseconds(unsigned int us) { if (us > 1000) delay(us / 1000); }
void yield() {}
unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout) {
  // Смотрим сценарий: когда пин получит нужный уровень
  unsigned long t = g_now;
  unsigned long limit = g_now + timeout;
  while (t < limit) {
    for (size_t i = g_nextAction; i < g_actions.size(); i++) {
      if (g_actions[i].kind == "pin" && (uint8_t)g_actions[i].pin == pin && g_actions[i].value == (int)state) {
        unsigned long dur = g_actions[i].at > g_now ? g_actions[i].at - g_now : 1;
        g_now = g_actions[i].at;
        applyActions();
        return dur;
      }
    }
    g_now += 1; applyActions();
    t++;
  }
  return 0;
}
unsigned long pulseInLong(uint8_t pin, uint8_t state, unsigned long timeout) { return pulseIn(pin, state, timeout); }
void shiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t val) {
  for (int i = 0; i < 8; i++) {
    int bitVal = (bitOrder == LSBFIRST) ? ((val >> i) & 1) : ((val >> (7 - i)) & 1);
    digitalWrite(dataPin, bitVal);
    digitalWrite(clockPin, HIGH);
    digitalWrite(clockPin, LOW);
  }
}
uint8_t shiftIn(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder) {
  uint8_t value = 0;
  for (int i = 0; i < 8; i++) {
    digitalWrite(clockPin, HIGH);
    if (bitOrder == LSBFIRST) value |= digitalRead(dataPin) << i;
    else value |= digitalRead(dataPin) << (7 - i);
    digitalWrite(clockPin, LOW);
  }
  return value;
}
void tone(uint8_t pin, unsigned int frequency, unsigned long) { tracePwm(pin, (int)frequency); }
void noTone(uint8_t) {}
void attachInterrupt(uint8_t interruptNum, void (*userFunc)(void), int mode) {
  g_isr[interruptNum] = userFunc;
  g_isrMode[interruptNum] = mode;
}
void detachInterrupt(uint8_t interruptNum) { g_isr.erase(interruptNum); }
static uint32_t g_rng = 1;
void randomSeed(unsigned long seed) { g_rng = seed ? (uint32_t)seed : 1; }
long random(long howbig) { if (howbig <= 0) return 0; g_rng = g_rng * 1103515245 + 12345; return (long)((g_rng >> 16) % (unsigned long)howbig); }
long random(long howsmall, long howbig) { return howsmall + random(howbig - howsmall); }
long map(long x, long in_min, long in_max, long out_min, long out_max) {
  if (in_max == in_min) return out_min;
  return (x - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}
`;

const MAIN_CPP = String.raw`// main.cpp — точка входа симулятора MicroPIDE.
#include "Arduino.h"

void setup();
void loop();

int main(int argc, char **argv) {
  sim_init(argc, argv);
  setup();
  while (!sim_done()) {
    loop();
    sim_tick();
  }
  sim_finish();
  return 0;
}
`;

const PLATFORM_TXT = (gpp, gcc, ar) => `# platform.txt платформы MicroPIDE «Симулятор на ПК» (генерируется автоматически)
name=MicroPIDE Native Simulator
version=${SIM_VER}
micropide.native=1
compiler.path=/usr/bin/
compiler.cpp.cmd=${gpp.split('/').pop()}
compiler.c.cmd=${gcc.split('/').pop()}
compiler.ar.cmd=${ar.split('/').pop()}
compiler.size.cmd=size
compiler.cpp.flags=-std=gnu++17 -O0 -g0 -Wno-narrowing -fpermissive -w
recipe.cpp.o.pattern="{compiler.path}{compiler.cpp.cmd}" -c {compiler.cpp.flags} {includes} {build.extra_flags} -o "{object_file}" "{source_file}"
recipe.c.o.pattern="{compiler.path}{compiler.c.cmd}" -c {compiler.c.flags} {includes} {build.extra_flags} -o "{object_file}" "{source_file}"
recipe.ar.pattern="{compiler.path}{compiler.ar.cmd}" rcs "{archive_file_path}" "{object_file}"
recipe.c.combine.pattern="{compiler.path}{compiler.cpp.cmd}" -o "{build.path}/{build.project_name}.elf" {object_files} "{archive_file_path}" -lm
`;

const BOARDS_TXT = `# boards.txt платформы-симулятора MicroPIDE
sim.name=MicroPIDE Simulator (ПК)
sim.build.core=micropide
sim.build.variant=native
sim.build.mcu=native
sim.build.f_cpu=100000000L
sim.upload.tool=none
`;

const PINS_ARDUINO_H = `#pragma once
// Карта пинов симулятора: «плата» без железа, пины 0..29 плюс A0..A15 (14..29).
#define NUM_DIGITAL_PINS 30
#define NUM_ANALOG_INPUTS 16
#define analogInputToDigitalPin(p) ((p) + 14)
#define digitalPinToPort(p) (p)
#define digitalPinToBitMask(p) (1 << (p % 8))
`;

/** Файлы нашего «ядра для ПК». */
export function shimFiles() {
  // Заголовки отдельных библиотек ядра: в настоящем Arduino это Wire.h, SPI.h,
  // EEPROM.h — скетчи их включают, и в симуляторе они должны находиться.
  const gate = (what) => `// ${what} — в симуляторе MicroPIDE реализация целиком внутри Arduino.h.\n#pragma once\n#include <Arduino.h>\n`;
  return {
    'Arduino.h': ARDUINO_H,
    'Arduino.cpp': ARDUINO_CPP,
    'main.cpp': MAIN_CPP,
    'pins_arduino.h': PINS_ARDUINO_H,
    'Wire.h': gate('Wire.h (I2C)'),
    'SPI.h': gate('SPI.h'),
    'EEPROM.h': gate('EEPROM.h'),
    'WString.h': gate('WString.h'),
  };
}

/** Создать/обновить платформу-симулятор в каталоге ядер. Возвращает путь. */
export function ensureNativeCore() {
  const versionDir = join(SIM_ROOT(), SIM_VER);
  const files = shimFiles();
  const stamp = createHash('sha1').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  const stampFile = join(versionDir, '.stamp');
  const upToDate = existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === stamp;
  if (!upToDate) {
    const coresDir = join(versionDir, 'cores', 'micropide');
    const variantDir = join(versionDir, 'variants', 'native');
    mkdirSync(coresDir, { recursive: true });
    mkdirSync(variantDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      if (name === 'pins_arduino.h') writeFileSync(join(variantDir, name), text);
      else writeFileSync(join(coresDir, name), text);
    }
    // находим настоящие g++/gcc/ar на этой машине
    const gpp = process.env.MICROPIDE_SIM_CXX || '/usr/bin/g++';
    const gcc = gpp.replace(/g\+\+$/, 'gcc');
    const ar = gpp.replace(/g\+\+$/, 'ar');
    writeFileSync(join(versionDir, 'platform.txt'), PLATFORM_TXT(gpp, gcc, ar));
    writeFileSync(join(versionDir, 'boards.txt'), BOARDS_TXT);
    writeFileSync(stampFile, stamp);
  }
  return versionDir;
}

/** Доступен ли симулятор (есть ли g++). */
export async function simulatorStatus() {
  const dir = ensureNativeCore();
  const { vars } = loadCoreProps(dir, 'sim');
  const tc = await findToolchain({ coreDir: dir, vars, arch: 'sim' });
  return {
    ok: tc.ok,
    core: dir,
    compiler: tc.ok ? tc.cpp : null,
    version: tc.ok ? tc.version : null,
    error: tc.ok ? null : tc.error,
    arch: tc.arch,
  };
}

/**
 * Собрать и запустить скетч на ПК.
 * opts: {name, files, scenario (текст), fqbn (информационно), timeoutMs, onLine}
 * Возвращает {ok, stdout, timeline, pins, text, summary, results?, error, log, ms}
 */
export async function simulate(opts) {
  const { name = 'sim', files = [], scenario = '', timeoutMs = 60_000, onLine = () => {}, runChecks = true } = opts;
  const log = [];
  const say = (s) => { log.push(s); onLine(s); };
  const t0 = Date.now();
  const parsed = parseScenario(scenario);
  if (!parsed.ok) return { ok: false, error: 'Ошибка в сценарии: ' + parsed.errors.map((e) => `строка ${e.line}: ${e.text}`).join('; '), log, scenarioErrors: parsed.errors };

  ensureNativeCore();
  const workDir = join(DATA_DIR, 'sim', `${String(name).replace(/[^\w.-]/g, '_')}-${Date.now().toString(36)}`);
  mkdirSync(workDir, { recursive: true });
  const scenarioPath = join(workDir, 'scenario.mps');
  const tracePath = join(workDir, 'trace.tsv');
  writeFileSync(scenarioPath, scenario || 'duration 2000\nfast on\n');

  say('Собираю симулятор (свой рантайм Arduino для ПК)…');
  const build = await buildWithOwnEngine({
    name, fqbn: SIM_FQBN, files, onLine: (l) => say(l), buildRoot: join(workDir, 'build'), skipSave: true,
  });
  if (!build.ok) {
    return { ok: false, error: build.error, detail: build.log?.slice(-40), log, ms: Date.now() - t0, phase: 'build' };
  }
  const exe = build.elf;
  if (!exe || !existsSync(exe)) return { ok: false, error: 'Симулятор не собран', log };
  try { chmodSync(exe, 0o755); } catch { /* ignore */ }

  const duration = parsed.config.duration || 3000;
  const fast = parsed.config.fast !== false;
  say(`Запускаю: не дольше ${duration} мс виртуального времени${fast ? ' (ускоренно)' : ''}…`);
  const runEnv = {
    ...process.env,
    MICROPIDE_SIM_SCENARIO: scenarioPath,
    MICROPIDE_SIM_TRACE: tracePath,
    MICROPIDE_SIM_DURATION: String(duration),
    MICROPIDE_SIM_FAST: fast ? '1' : '0',
  };

  const run = await new Promise((resolve) => {
    const p = spawn(exe, [], { env: runEnv, cwd: workDir });
    let out = '';
    let err = '';
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString('binary'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, out, err: err + String(e.message) }); });
    p.on('close', (code) => { clearTimeout(to); resolve({ code: code ?? -1, out, err }); });
  });

  const traceText = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '';
  const { timeline, pins, text } = parseTrace(traceText);
  const summaryMatch = /summary\titerations=(\d+),ms=(\d+),aborted=(\d)/.exec(traceText);
  const summary = summaryMatch
    ? { iterations: Number(summaryMatch[1]), ms: Number(summaryMatch[2]), aborted: summaryMatch[3] === '1' }
    : { iterations: 0, ms: duration, aborted: false };
  if (run.err.trim()) say(run.err.trim());

  const result = {
    ok: run.code === 0 && !summary.aborted,
    exitCode: run.code, stdout: run.out, stderr: run.err,
    timeline, pins, text, summary, trace: traceText,
    log, ms: Date.now() - t0, core: build.core, compiler: build.toolchain,
    sizes: build.sizes,
  };
  if (runChecks && parsed.steps.some((s) => /^expect/.test(s.kind))) {
    const check = checkExpectations(parsed.steps, timeline, pins);
    result.checks = check;
    result.ok = result.ok && check.ok;
  }
  return result;
}
