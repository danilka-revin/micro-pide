#!/usr/bin/env node
// ИИ-агент MicroPIDE: берёт ключ из окружения, отправляет задачу модели
// вместе с контекстом проекта, печатает план/команды. Без ключа — отключён.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function env(name) { return process.env[name]; }

const OPENAI_KEY = env('OPENAI_API_KEY');
const ANTHROPIC_KEY = env('ANTHROPIC_API_KEY');
const GEMINI_KEY = env('GEMINI_API_KEY');
const KEY = OPENAI_KEY || ANTHROPIC_KEY || GEMINI_KEY;

if (!KEY) {
  console.error('ИИ-агент отключён: не найден API-ключ.');
  console.error('Подключите ключ один раз:');
  console.error('  export OPENAI_API_KEY=sk-...        # OpenAI');
  console.error('  export ANTHROPIC_API_KEY=sk-ant-... # Anthropic');
  console.error('  export GEMINI_API_KEY=...           # Google Gemini');
  process.exit(2);
}

const task = process.argv.slice(2).join(' ').trim();
if (!task) {
  console.error('Использование: node scripts/agent.mjs "задача"');
  process.exit(2);
}

let context = '';
try { context = readFileSync(resolve(ROOT, 'AGENTS.md'), 'utf8'); } catch {}
try { context += '\n\n' + readFileSync(resolve(ROOT, 'README.md'), 'utf8').slice(0, 4000); } catch {}

const system = `Ты — ИИ-агент разработчика проекта MicroPIDE. Работаешь вместо пользователя.
Отвечай по-русски. Давай конкретный план и команды (bash). Не выполняй деструктивные действия без подтверждения.
Контекст проекта:\n${context}`;

const baseUrl = env('AI_BASE_URL') || (ANTHROPIC_KEY ? 'https://api.anthropic.com/v1/messages'
  : GEMINI_KEY ? 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'
  : 'https://api.openai.com/v1/chat/completions');
const model = env('AI_MODEL') || (ANTHROPIC_KEY ? 'claude-3-5-sonnet-20241022'
  : GEMINI_KEY ? null : 'gpt-4o-mini');

async function callOpenAI() {
  const r = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: task }], temperature: 0.3 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.choices?.[0]?.message?.content || '';
}

async function callAnthropic() {
  const r = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2048, system, messages: [{ role: 'user', content: task }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return (j.content || []).map((c) => c.text).join('');
}

async function callGemini() {
  const url = `${baseUrl}?key=${KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: system + '\n\n' + task }] }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
}

(async () => {
  try {
    let out = '';
    if (ANTHROPIC_KEY) out = await callAnthropic();
    else if (GEMINI_KEY) out = await callGemini();
    else out = await callOpenAI();
    console.log(out);
  } catch (e) {
    console.error('Ошибка агента:', e.message);
    process.exit(1);
  }
})();
