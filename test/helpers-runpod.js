// Starts a fake RunPod vLLM endpoint (OpenAI-compatible) and points the app at it.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// env first, synchronously: with top-level await, sibling imports (config.js) keep evaluating
const PORT = 40000 + Math.floor(Math.random() * 20000);
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orderlah-runpod-'));
process.env.AI_PROVIDER = 'runpod';
process.env.RUNPOD_API_KEY = 'rp_test_key';
process.env.RUNPOD_ENDPOINT_ID = 'abc123';
process.env.RUNPOD_MODEL = 'Qwen/Qwen2.5-7B-Instruct';
process.env.RUNPOD_BASE_URL = `http://127.0.0.1:${PORT}/v2/abc123/openai/v1`;
process.env.WHATSAPP_TOKEN = '';
process.env.BASE_URL = 'http://localhost:3999';

export const calls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    calls.push({ url: req.url, auth: req.headers.authorization, model: json.model, json });
    const system = json.messages?.[0]?.content || '';
    const user = JSON.stringify(json.messages?.[1]?.content || '');
    if (user.includes('FAIL')) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"boom"}'); }
    let content;
    if (system.includes('manage WhatsApp chats')) content = { intent: 'comparing', urgency: 'normal', summary: 'Asks red velvet price, Shopee cheaper', reply: 'Hi Kevin! (from RunPod) Our cakes are fresh today.' };
    else if (system.includes('read customer orders')) content = { isOrder: true, items: [{ sku: 'KEK-RV', raw: 'one red velvet', qty: 1, confidence: 0.95 }], deliveryDate: null, notes: null };
    else if (system.includes('follow-up')) content = { message: 'Hi Kevin! (RunPod follow-up) Shall I reserve one?' };
    else content = {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Sure! ' + JSON.stringify(content) } }] }));
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
server.unref();

