import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'glavinstrument-consultant-v1.0.md');

let cached: string | null = null;

function fillVariable(name: string, value: string): string {
  if (value) return value;
  // Раздел 0: если переменная не заполнена — нейтральная формулировка, не выдумывать значение.
  return '(не заполнено в конфигурации — не называть пользователю, передать вопрос специалисту)';
}

export function loadSystemPrompt(): string {
  if (cached) return cached;
  const raw = fs.readFileSync(PROMPT_PATH, 'utf-8');
  let filled = raw;
  for (const [key, value] of Object.entries(config.productVars)) {
    filled = filled.split(`{{${key}}}`).join(fillVariable(key, value));
  }
  cached = filled;
  return filled;
}
