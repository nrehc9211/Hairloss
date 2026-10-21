// Demo clock. The dashboard can "fast-forward" hours or days so follow-ups
// and reminders can be shown live during a 3-minute demo.
import { config } from './config.js';

let offsetMs = 0;
export const setOffsetMs = (n) => { offsetMs = Number(n) || 0; };
export const getOffsetMs = () => offsetMs;
export const advanceHours = (h) => { offsetMs += Number(h) * 3600e3; return offsetMs; };
// kept for older callers
export const setOffsetDays = (n) => setOffsetMs(Number(n) * 864e5);
export const getOffsetDays = () => Math.round((offsetMs / 864e5) * 100) / 100;

export const nowMs = () => Date.now() + offsetMs;
export const now = () => new Date(nowMs());
export const nowIso = () => now().toISOString();

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
/** YYYY-MM-DD in Malaysia time */
export const toIsoDate = (d) => fmt.format(d);
export const todayIso = () => toIsoDate(now());
/** HH:MM in Malaysia time */
export const hhmm = (iso) => fmtTime.format(new Date(iso));

export function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function diffDays(aIso, bIso) {
  const a = Date.parse(aIso + 'T00:00:00Z');
  const b = Date.parse(bIso + 'T00:00:00Z');
  return Math.round((a - b) / 864e5);
}

export const minutesBetween = (fromIso, toMs = nowMs()) => Math.max(0, Math.round((toMs - Date.parse(fromIso)) / 60000));

export const weekday = (isoDate) => new Date(isoDate + 'T00:00:00Z').getUTCDay();

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "22 Oct (Thu)" */
export function prettyDate(isoDate) {
  const [, m, d] = isoDate.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} (${DAYS[weekday(isoDate)]})`;
}
