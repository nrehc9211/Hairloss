// Sends messages either to the real WhatsApp Cloud API ('wa' channel) or to
// the web simulator ('sim' channel). Every message is also stored so the
// simulator and the dashboard can show it.
import { config, waEnabled } from '../config.js';
import { getDb, nextId, save } from '../store.js';
import { nowIso } from '../clock.js';

const graph = (p) => `https://graph.facebook.com/${config.wa.graphVersion}/${p}`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * @param {string} to   phone number, digits only, e.g. 60120000001
 * @param {object} msg  {type:'text', text} | {type:'buttons', text, buttons:[{id,title}]}
 *                      | {type:'document', url, filename, caption} | {type:'template', name, params:[...], fallbackText}
 * @param {'wa'|'sim'} channel
 */
export async function send(to, msg, channel = 'sim') {
  const db = getDb();
  const record = { id: nextId('message', 'M', 6), ts: nowIso(), direction: 'out', to: String(to), channel, ...msg };
  db.messages.push(record);
  save();

  if (channel === 'wa' && waEnabled()) {
    try {
      const body = toCloudPayload(to, msg);
      const res = await fetch(graph(`${config.wa.phoneNumberId}/messages`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.wa.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        record.error = json?.error?.message || `HTTP ${res.status}`;
        console.error('[whatsapp] send failed:', record.error);
      } else {
        record.waMessageId = json?.messages?.[0]?.id;
      }
      save();
    } catch (err) {
      record.error = String(err.message || err);
      console.error('[whatsapp] send error:', record.error);
    }
  }
  return record;
}

export function toCloudPayload(to, msg) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to) };
  switch (msg.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: clip(msg.text, 4096), preview_url: true } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: clip(msg.text, 1024) },
          action: {
            // WhatsApp allows max 3 reply buttons, 20 chars per title, 256 per id
            buttons: msg.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: clip(b.id, 256), title: clip(b.title, 20) } })),
          },
        },
      };
    case 'document':
      return { ...base, type: 'document', document: { link: msg.url, filename: msg.filename, caption: msg.caption ? clip(msg.caption, 1024) : undefined } };
    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: msg.name,
          language: { code: config.wa.templateLang },
          components: [{ type: 'body', parameters: (msg.params || []).map((t) => ({ type: 'text', text: String(t) })) }],
        },
      };
    default:
      throw new Error(`Unknown message type ${msg.type}`);
  }
}

/** Download an inbound media file (voice note / photo). Returns {buffer, mimeType}. */
export async function downloadMedia(mediaId) {
  if (!waEnabled()) throw new Error('WhatsApp not configured');
  const meta = await fetch(graph(mediaId), { headers: { Authorization: `Bearer ${config.wa.token}` } }).then((r) => r.json());
  if (!meta.url) throw new Error('Media URL not found');
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${config.wa.token}` } });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: meta.mime_type || res.headers.get('content-type') };
}
