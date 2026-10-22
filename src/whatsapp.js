// WhatsApp Business Cloud API connector.
// Set WA_TOKEN + WA_PHONE_NUMBER_ID to send real messages; otherwise messages are
// "simulated" and only appear in SmartDesk and the built-in Customer Simulator.

const GRAPH = 'https://graph.facebook.com/v21.0';

export function isLive() {
  return Boolean(process.env.WA_TOKEN && process.env.WA_PHONE_NUMBER_ID);
}

export async function sendText(phone, body) {
  if (!isLive()) return { delivery: 'simulated', waId: null };
  try {
    const res = await fetch(`${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body } }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    return { delivery: 'sent', waId: json.messages?.[0]?.id ?? null };
  } catch (err) {
    console.error('[whatsapp] send failed:', err.message);
    return { delivery: 'failed', waId: null };
  }
}

// Meta webhook verification (GET /webhook/whatsapp)
export function verifyWebhook(query) {
  const ok = query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === (process.env.WA_VERIFY_TOKEN || 'smartdesk-verify');
  return ok ? query.get('hub.challenge') : null;
}

// Pull text messages out of a Meta webhook payload.
export function parseWebhook(payload) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = Object.fromEntries((value.contacts ?? []).map(c => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        if (m.type !== 'text') continue;
        out.push({ phone: m.from, profileName: names[m.from] ?? null, text: m.text.body, waId: m.id });
      }
    }
  }
  return out;
}
