// Deterministic business rules. No AI in here: same input -> same output,
// so the boss (and the judges) can see exactly why an order was flagged.
import { round2 } from '../store.js';
import { addDays, diffDays, weekday } from '../clock.js';

export const FLAG = {
  UNKNOWN_ITEM: 'UNKNOWN_ITEM',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  NEW_CUSTOMER: 'NEW_CUSTOMER',
  QTY_ANOMALY: 'QTY_ANOMALY',
  OVERDUE: 'OVERDUE',
  CREDIT_LIMIT: 'CREDIT_LIMIT',
  DELIVERY_DATE: 'DELIVERY_DATE',
  OVER_AUTO_LIMIT: 'OVER_AUTO_LIMIT',
};

export function nextOpenDay(fromIso, closedDays = []) {
  let d = fromIso;
  for (let i = 0; i < 7 && closedDays.includes(weekday(d)); i++) d = addDays(d, 1);
  return d;
}

/**
 * Price the order and decide what happens next.
 * @param {object} p
 * @param {{items:any[], deliveryDate:string|null}} p.extraction
 * @param {object|null} p.customer
 * @param {any[]} p.catalog
 * @param {Record<string,number>} p.averages      avg qty per sku for this customer
 * @param {any[]} p.openInvoices                   unpaid invoices of this customer
 * @param {object} p.settings
 * @param {string} p.todayIso
 * @returns {{lines:any[], unknown:any[], total:number, deliveryDate:string, flags:Array<{code:string, severity:'info'|'warning'|'critical', message:string, line?:number}>, decision:'clarify'|'needs_approval'|'auto_approve'}}
 */
export function evaluateOrder({ extraction, customer, catalog, averages = {}, openInvoices = [], settings, todayIso }) {
  const bySku = Object.fromEntries(catalog.map((c) => [c.sku, c]));
  const flags = [];
  const lines = [];
  const unknown = [];

  // 1. Price each line from the catalog (customer price first). Merge duplicate SKUs.
  for (const item of extraction.items || []) {
    if (!item.sku || !bySku[item.sku]) {
      unknown.push({ raw: item.raw, qty: item.qty });
      continue;
    }
    const c = bySku[item.sku];
    const unitPrice = customer?.prices?.[item.sku] ?? c.price;
    const existing = lines.find((l) => l.sku === item.sku);
    if (existing) {
      existing.qty += item.qty;
      existing.amount = round2(existing.qty * existing.unitPrice);
      existing.confidence = Math.min(existing.confidence, item.confidence);
      continue;
    }
    lines.push({ sku: c.sku, name: c.name, unit: c.unit, qty: item.qty, unitPrice, amount: round2(item.qty * unitPrice), confidence: item.confidence, raw: item.raw });
  }
  const kept = lines.filter((l) => l.qty > 0);
  const total = round2(kept.reduce((s, l) => s + l.amount, 0));

  // 2. Flags
  unknown.forEach((u) => flags.push({ code: FLAG.UNKNOWN_ITEM, severity: 'critical', message: `Unknown item: "${u.raw}"` }));

  kept.forEach((l, i) => {
    if (l.confidence < (settings.lowConfidence ?? 0.7)) {
      flags.push({ code: FLAG.LOW_CONFIDENCE, severity: 'warning', line: i, message: `AI not sure: ${l.qty} × ${l.name} (from "${l.raw}")` });
    }
    const avg = averages[l.sku];
    if (avg && l.qty > avg * (settings.qtyAnomalyFactor ?? 3)) {
      flags.push({ code: FLAG.QTY_ANOMALY, severity: 'warning', line: i, message: `Unusual qty: ${l.qty} × ${l.name} (usually ~${Math.round(avg)})` });
    }
  });

  if (!customer || customer.isLead) {
    flags.push({ code: FLAG.NEW_CUSTOMER, severity: 'warning', message: 'New customer — has never ordered before' });
  }

  const overdue = openInvoices.filter((inv) => diffDays(todayIso, inv.dueDate) > (settings.overdueDays ?? 30));
  if (overdue.length) {
    const amt = round2(overdue.reduce((s, i) => s + i.total, 0));
    const days = Math.max(...overdue.map((i) => diffDays(todayIso, i.dueDate)));
    flags.push({ code: FLAG.OVERDUE, severity: 'warning', message: `Overdue balance RM${amt.toFixed(2)} (${days} days late)` });
  }

  const openBalance = round2(openInvoices.reduce((s, i) => s + i.total, 0));
  if (customer && customer.creditLimit > 0 && openBalance + total > customer.creditLimit) {
    flags.push({ code: FLAG.CREDIT_LIMIT, severity: 'critical', message: `Over credit limit: balance RM${openBalance.toFixed(2)} + order RM${total.toFixed(2)} > limit RM${customer.creditLimit}` });
  }

  const closed = settings.closedDays || [];
  let deliveryDate = extraction.deliveryDate || nextOpenDay(addDays(todayIso, 1), closed);
  if (diffDays(deliveryDate, todayIso) < 0) {
    flags.push({ code: FLAG.DELIVERY_DATE, severity: 'warning', message: `Delivery date already passed (${deliveryDate})` });
    deliveryDate = nextOpenDay(addDays(todayIso, 1), closed);
  } else if (closed.includes(weekday(deliveryDate))) {
    const next = nextOpenDay(deliveryDate, closed);
    flags.push({ code: FLAG.DELIVERY_DATE, severity: 'warning', message: `Shop closed on ${deliveryDate} — suggest delivering ${next}` });
    deliveryDate = next;
  }

  // 3. Decision
  const auto = settings.autoApprove || {};
  let decision = 'needs_approval';
  if (unknown.length) decision = 'clarify';
  else if (
    auto.enabled &&
    flags.length === 0 &&
    total > 0 &&
    total <= (auto.maxTotal ?? 0) &&
    (!auto.trustedOnly || customer?.trusted)
  ) decision = 'auto_approve';

  if (decision === 'needs_approval' && auto.enabled && total > (auto.maxTotal ?? 0)) {
    flags.push({ code: FLAG.OVER_AUTO_LIMIT, severity: 'info', message: `Above auto-approve limit RM${auto.maxTotal}` });
  }

  return { lines: kept, unknown, total, deliveryDate, flags, decision };
}

/** Apply the owner's edit ("chocolate cake 3, cheesecake 0") to existing lines. */
export function applyEdits(lines, edits, customer, catalog) {
  const bySku = Object.fromEntries(catalog.map((c) => [c.sku, c]));
  const next = lines.map((l) => ({ ...l }));
  for (const e of edits) {
    if (!e.sku || !bySku[e.sku]) continue;
    const found = next.find((l) => l.sku === e.sku);
    if (found) {
      found.qty = e.qty;
      found.amount = round2(found.qty * found.unitPrice);
      found.confidence = 1;
    } else if (e.qty > 0) {
      const c = bySku[e.sku];
      const unitPrice = customer?.prices?.[e.sku] ?? c.price;
      next.push({ sku: c.sku, name: c.name, unit: c.unit, qty: e.qty, unitPrice, amount: round2(e.qty * unitPrice), confidence: 1, raw: '(boss edit)' });
    }
  }
  return next.filter((l) => l.qty > 0);
}
