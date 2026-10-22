// Orbyte connector.
// Approved invoices are pushed to Orbyte so they live next to the business's
// other approval records (eLeave, eClaim) and use the same approve -> log -> outcome pattern.
// Set ORBYTE_API_URL + ORBYTE_API_KEY to sync for real; otherwise a mock reference is recorded.

export function isLive() {
  return Boolean(process.env.ORBYTE_API_URL && process.env.ORBYTE_API_KEY);
}

export async function syncInvoice(invoice, order, items) {
  const payload = {
    type: 'sales_invoice',
    invoice_no: invoice.invoice_no,
    issue_date: invoice.approved_at,
    due_date: invoice.due_date,
    customer: { name: order.customer_name, phone: order.phone, address: order.address },
    lines: items.map(i => ({ description: i.name, qty: i.qty, unit_price: i.unit_price, amount: i.line_total })),
    discount: order.discount,
    delivery_fee: order.delivery_fee,
    total: invoice.amount,
    currency: 'MYR',
    approved_by: invoice.approved_by,
    source: 'SmartDesk/WhatsApp',
  };
  if (!isLive()) {
    return { status: 'mock', ref: `ORB-MOCK-${invoice.invoice_no}` };
  }
  try {
    const res = await fetch(`${process.env.ORBYTE_API_URL.replace(/\/$/, '')}/invoices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.ORBYTE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
    return { status: 'synced', ref: json.id || json.reference || null };
  } catch (err) {
    console.error('[orbyte] sync failed:', err.message);
    return { status: 'failed', ref: null };
  }
}
