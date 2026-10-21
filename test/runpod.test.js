import { calls } from './helpers-runpod.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initStore, getDb } from '../src/store.js';
import { handleIncoming } from '../src/flows/orderFlow.js';
import * as inbox from '../src/inbox/index.js';
import { advanceHours, setOffsetMs } from '../src/clock.js';
import { runpodBaseUrl } from '../src/config.js';

test.after(() => setOffsetMs(0));

test('default RunPod URL format', () => {
  assert.match(runpodBaseUrl(), /\/v2\/abc123\/openai\/v1$/);
});

test('tags, order extraction and follow-up drafts come from the RunPod endpoint', async () => {
  initStore({ fresh: true, persist: false });
  await handleIncoming({ from: '60120000014', name: 'Kevin', type: 'text', text: 'How much is the red velvet? Shopee is cheaper' }, 'sim');
  const c = inbox.conversationForPhone('60120000014');
  assert.equal(c.tagEngine, 'runpod');
  assert.match(c.suggestedReply, /from RunPod/);
  const first = calls[0];
  assert.equal(first.url, '/v2/abc123/openai/v1/chat/completions');
  assert.equal(first.auth, 'Bearer rp_test_key');
  assert.equal(first.model, 'Qwen/Qwen2.5-7B-Instruct');
  assert.equal(first.json.response_format, undefined, 'JSON mode is off by default for RunPod');

  await inbox.replyFromInbox(c, { text: c.suggestedReply, by: 'Kak Lina', usedSuggestion: true });
  advanceHours(3);
  const drafted = await inbox.runFollowUps();
  assert.match(drafted[0].draft, /RunPod follow-up/);
});

test('model error -> keyword fallback, nothing breaks', async () => {
  initStore({ fresh: true, persist: false });
  await handleIncoming({ from: '60120000015', name: 'Farah', type: 'text', text: 'FAIL ok let me think about it first' }, 'sim');
  const c = inbox.conversationForPhone('60120000015');
  assert.equal(c.tags.intent, 'considering');
  assert.equal(c.tagEngine, 'keywords');
  assert.ok(getDb().audit.some((a) => a.action === 'inbox.tagged' && /model error/.test(a.detail)));
});
