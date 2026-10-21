// ---------------------------------------------------------------------------
// MOCK ORBYTE API
// Every function here stands in for an Orbyte module. When Orbyte gives you a
// sandbox / API docs, replace the body of each function with a real API call
// and keep the same return shape. Nothing else in the app has to change.
//
//   crm.*            -> Orbyte Connect: Sales & CRM apps
//   people.*         -> Orbyte People: Directory + eLeave (who approves today)
//   audit.*          -> Orbyte approvals / audit log (same idea as eSign's log)
//   connect.*        -> Orbyte Connect: accounting integration, payments & collections
//   sales.*          -> order history (would come from Connect / POS / Business Graph)
// ---------------------------------------------------------------------------
import { getDb, nextId, save, round2 } from '../store.js';
import { config } from '../config.js';
import { nowIso, todayIso, diffDays } from '../clock.js';

const normPhone = (p) => String(p || '').replace(/\D/g, '');

export const crm = {
  findCustomerByPhone(phone) {
    return getDb().customers.find((c) => normPhone(c.phone) === normPhone(phone)) || null;
  },
  getCustomer(id) {
    return getDb().customers.find((c) => c.id === id) || null;
  },
  /** Unknown number -> create a lead so the boss can decide. */
  createLead(phone, profileName) {
    const db = getDb();
    const c = {
      id: nextId('customer', 'c', 3), name: profileName || `New customer (${phone})`, phone: normPhone(phone),
      trusted: false, creditLimit: 0, paymentTermsDays: 0, prices: {}, isLead: true,
    };
    db.customers.push(c);
    save();
    return c;
  },
};

export const catalog = {
  list: () => getDb().catalog,
  get: (sku) => getDb().catalog.find((c) => c.sku === sku) || null,
  /** Customer-specific price wins over list price. AI never sets prices. */
  priceFor(customer, sku) {
    const item = catalog.get(sku);
    if (!item) return null;
    return customer?.prices?.[sku] ?? item.price;
  },
};

export const people = {
  staff: () => getDb().staff,
  findStaffByPhone(phone) {
    return getDb().staff.find((s) => normPhone(s.phone) === normPhone(phone)) || null;
  },
  byRole: (role) => getDb().staff.find((s) => s.role === role) || null,
  get: (id) => getDb().staff.find((s) => s.id === id) || null,
  /** eLeave: is this person on approved leave on that date? */
  isOnLeave(staffId, isoDate = todayIso()) {
    return getDb().leave.some((l) => l.staffId === staffId && l.status === 'approved' && l.from <= isoDate && isoDate <= l.to);
  },
  /** Owner approves; if owner is on approved leave, the supervisor does. */
  getApprover(isoDate = todayIso()) {
    const owner = people.byRole('owner');
    if (owner && !people.isOnLeave(owner.id, isoDate)) return { approver: owner, reason: null };
    const sup = people.byRole('supervisor');
    if (sup && !people.isOnLeave(sup.id, isoDate)) {
      return { approver: sup, reason: `${owner?.name || 'Owner'} on approved leave (eLeave) — routed to ${sup.name}` };
    }
    return { approver: owner, reason: 'No delegate available — sent to owner' };
  },
  canApprove(staff) {
    return staff && (staff.role === 'owner' || staff.role === 'supervisor');
  },
};

export const audit = {
  /**
   * Append-only log. Every automated or human step writes here.
   * @param {{orderId?:string, invoiceId?:string, actor:string, actorType:'customer'|'staff'|'system'|'ai'|'connect', action:string, detail?:string, before?:any, after?:any, data?:any}} e
   */
  log(e) {
    const db = getDb();
    const entry = { id: nextId('audit', 'A', 5), ts: nowIso(), ...e };
    db.audit.push(entry);
    save();
    return entry;
  },
  forOrder: (orderId) => getDb().audit.filter((a) => a.orderId === orderId),
};

export const sales = {
  /** Average qty per SKU from this customer's past orders. */
  averages(customerId) {
    const sums = {};
    const counts = {};
    for (const o of getDb().orders) {
      if (o.customerId !== customerId || !['invoiced', 'paid', 'delivered'].includes(o.status)) continue;
      for (const l of o.lines) {
        sums[l.sku] = (sums[l.sku] || 0) + l.qty;
        counts[l.sku] = (counts[l.sku] || 0) + 1;
      }
    }
    return Object.fromEntries(Object.keys(sums).map((k) => [k, round2(sums[k] / counts[k])]));
  },
  openInvoices(customerId) {
    return getDb().invoices.filter((i) => i.customerId === customerId && i.status !== 'paid' && i.status !== 'void');
  },
  overdueInvoices(customerId, today = todayIso()) {
    return sales.openInvoices(customerId).filter((i) => diffDays(today, i.dueDate) > 0);
  },
};

export const connect = {
  accounting: {
    /** Would push to the SME's accounting app through Orbyte Connect. */
    pushInvoice(invoice) {
      return { ref: `ACC-${invoice.id}`, system: 'Accounting (via Orbyte Connect, mocked)', syncedAt: nowIso() };
    },
  },
  payments: {
    /** Would create a DuitNow / FPX payment link through Orbyte Connect. */
    createLink(invoice) {
      return `${config.baseUrl}/pay/${invoice.id}`;
    },
  },
};

export const orbyte = { crm, catalog, people, audit, sales, connect };
export default orbyte;
