// One place that talks to a language model. Supports:
//   runpod    -> RunPod Serverless vLLM endpoint (OpenAI-compatible)  <- recommended for the hackathon
//   openai    -> OpenAI, or any OpenAI-compatible server via OPENAI_BASE_URL
//   anthropic -> Anthropic Messages API
//   none      -> no model; callers fall back to rules / keywords
import { config, runpodBaseUrl } from '../config.js';

export const provider = () => config.ai.provider;
export const hasLLM = () => provider() !== 'none';

function timeout() {
  return AbortSignal.timeout(config.ai.timeoutMs);
}

async function openAICompatible({ baseUrl, key, model, system, user, json }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: timeout(),
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 700,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error?.message || out?.error || `HTTP ${res.status}`);
  return out.choices?.[0]?.message?.content || '';
}

async function anthropic({ system, user }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: timeout(),
    headers: { 'x-api-key': config.ai.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.ai.anthropicModel, max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Anthropic HTTP ${res.status}`);
  return (json.content || []).map((c) => c.text || '').join('');
}

/**
 * @param {{system:string, user:string|any[], json?:boolean}} p  user may be an array of content parts (images)
 * @returns {Promise<string>}
 */
export async function chat({ system, user, json = true }) {
  const p = provider();
  if (p === 'runpod') {
    return openAICompatible({
      baseUrl: runpodBaseUrl(), key: config.ai.runpodKey, model: config.ai.runpodModel,
      system, user, json: json && config.ai.runpodJsonMode,
    });
  }
  if (p === 'openai') {
    return openAICompatible({ baseUrl: config.ai.openaiBaseUrl, key: config.ai.openaiKey, model: config.ai.openaiModel, system, user, json });
  }
  if (p === 'anthropic') return anthropic({ system, user });
  throw new Error('No AI provider configured');
}

export function parseJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('No JSON in AI reply');
  return JSON.parse(text.slice(a, b + 1));
}

export async function chatJson(p) {
  return parseJson(await chat({ ...p, json: true }));
}
