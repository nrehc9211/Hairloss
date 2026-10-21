// npm run wa:check               -> checks your WhatsApp Cloud API settings in .env
// npm run wa:check -- 60123456789 -> also sends Meta's "hello_world" test template to that number
import { config, waEnabled } from '../src/config.js';
import { initStore, getDb } from '../src/store.js';

const ok = (s) => console.log(`  ✅ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const fail = (s) => { console.log(`  ❌ ${s}`); process.exitCode = 1; };
const graph = (p) => `https://graph.facebook.com/${config.wa.graphVersion}/${p}`;
const auth = { Authorization: `Bearer ${config.wa.token}` };

console.log('\nOrderLah · WhatsApp check\n');

if (!waEnabled()) {
  fail('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not both set in .env');
  console.log('\nCopy them from Meta for Developers → your app → WhatsApp → API Setup.\n');
  process.exit();
}
ok('Token and phone number ID are set');

const res = await fetch(graph(`${config.wa.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`), { headers: auth });
const info = await res.json().catch(() => ({}));
if (!res.ok) {
  fail(`Meta rejected the token or phone number ID: ${info?.error?.message || `HTTP ${res.status}`}`);
  console.log('   Temporary tokens from the API Setup page expire after 24 hours — generate a new one.\n');
  process.exit();
}
ok(`Connected to WhatsApp number ${info.display_phone_number} (${info.verified_name || 'test number'})`);

if (/localhost|127\.0\.0\.1/.test(config.baseUrl)) {
  warn(`BASE_URL is ${config.baseUrl} — Meta cannot reach that. Start a tunnel (ngrok / cloudflared) and put its https URL in BASE_URL.`);
} else {
  ok(`Webhook URL for Meta: ${config.baseUrl}/webhook`);
}
console.log(`     Verify token for Meta: ${config.wa.verifyToken}`);
if (!config.wa.appSecret) warn('WHATSAPP_APP_SECRET is empty — webhook signatures are not checked (fine for a demo)');

initStore();
for (const s of getDb().staff) {
  if (/^6011000000\d$/.test(s.phone)) warn(`${s.name} (${s.role}) still has the demo number ${s.phone} — set ${s.role.toUpperCase()}_PHONE in .env`);
  else ok(`${s.name} (${s.role}) → ${s.phone}`);
}

const to = (process.argv[2] || '').replace(/\D/g, '');
if (to) {
  const r = await fetch(graph(`${config.wa.phoneNumberId}/messages`), {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) ok(`Test message sent to ${to} — check that phone`);
  else fail(`Could not send to ${to}: ${j?.error?.message || `HTTP ${r.status}`} (with a test number, add ${to} as a recipient in API Setup first)`);
}
console.log('');
