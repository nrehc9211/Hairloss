// Turns WhatsApp Cloud API webhook payloads into one simple shape the app uses.
import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * @returns {Array<{from:string, waId:string, name:string|null, type:'text'|'audio'|'image'|'button'|'other', text?:string, mediaId?:string, mimeType?:string, caption?:string, buttonId?:string}>}
 */
export function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || null]));
      for (const m of v.messages || []) {
        const base = { from: m.from, waId: m.id, name: names[m.from] || null };
        if (m.type === 'text') out.push({ ...base, type: 'text', text: m.text?.body || '' });
        else if (m.type === 'audio') out.push({ ...base, type: 'audio', mediaId: m.audio?.id, mimeType: m.audio?.mime_type });
        else if (m.type === 'image') out.push({ ...base, type: 'image', mediaId: m.image?.id, mimeType: m.image?.mime_type, caption: m.image?.caption || '' });
        else if (m.type === 'interactive' && m.interactive?.type === 'button_reply')
          out.push({ ...base, type: 'button', buttonId: m.interactive.button_reply.id, text: m.interactive.button_reply.title });
        else if (m.type === 'interactive' && m.interactive?.type === 'list_reply')
          out.push({ ...base, type: 'button', buttonId: m.interactive.list_reply.id, text: m.interactive.list_reply.title });
        else if (m.type === 'button') out.push({ ...base, type: 'button', buttonId: m.button?.payload, text: m.button?.text });
        else out.push({ ...base, type: 'other' });
      }
      // v.statuses (sent / delivered / read) are ignored in this prototype
    }
  }
  return out;
}

/** Checks the X-Hub-Signature-256 header when WHATSAPP_APP_SECRET is set. */
export function verifySignature(rawBody, header) {
  if (!config.wa.appSecret) return true;
  if (!header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.wa.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
