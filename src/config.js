import fs from 'node:fs';
import path from 'node:path';

// Load .env without any package (Node >= 20.12). Real env vars win.
if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function' && process.env.NODE_ENV !== 'test') {
  process.loadEnvFile('.env');
}

const env = process.env;
const port = Number(env.PORT || 3000);

function pickProvider() {
  const p = (env.AI_PROVIDER || '').toLowerCase();
  if (p) return p;
  if (env.RUNPOD_API_KEY && env.RUNPOD_ENDPOINT_ID) return 'runpod';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

export const config = {
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: env.DATA_DIR || path.resolve('data'),
  persist: env.PERSIST !== 'false',
  timeZone: 'Asia/Kuala_Lumpur',
  wa: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || 'orderlah-dev',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v23.0',
    reminderTemplate: env.WHATSAPP_REMINDER_TEMPLATE || '',
    templateLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
  },
  // Real numbers for the team (digits only, e.g. 60123456789). Empty = keep the demo numbers in seed.json.
  staffPhones: {
    owner: (env.OWNER_PHONE || '').replace(/\D/g, ''),
    supervisor: (env.SUPERVISOR_PHONE || '').replace(/\D/g, ''),
    staff: (env.STAFF_PHONE || '').replace(/\D/g, ''),
  },
  ai: {
    provider: pickProvider(),
    timeoutMs: Number(env.AI_TIMEOUT_MS || 25000),
    // RunPod Serverless vLLM endpoint (OpenAI-compatible)
    runpodKey: env.RUNPOD_API_KEY || '',
    runpodEndpointId: env.RUNPOD_ENDPOINT_ID || '',
    runpodModel: env.RUNPOD_MODEL || 'Qwen/Qwen2.5-7B-Instruct',
    runpodJsonMode: env.RUNPOD_JSON_MODE === 'true',
    runpodBaseUrl: env.RUNPOD_BASE_URL || '', // optional override, e.g. a local mock in tests
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    openaiKey: env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
  },
};

export const waEnabled = () => Boolean(config.wa.token && config.wa.phoneNumberId);
export const runpodBaseUrl = () =>
  (config.ai.runpodBaseUrl || `https://api.runpod.ai/v2/${config.ai.runpodEndpointId}/openai/v1`).replace(/\/$/, '');
