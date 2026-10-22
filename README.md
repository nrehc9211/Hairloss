# Orbyte SmartDesk

WhatsApp order desk for micro & small businesses (demo business: a kek lapis shop with 1 owner + 2 staff).

**Problem:** the owner spends hours every day answering the same WhatsApp questions, typing invoices by hand and chasing payments. Some customers ask a question, then go quiet and are lost.

**Automated journey:**

| Step | What happens |
|---|---|
| Trigger | Customer sends a WhatsApp message |
| Data | Message, customer, order and items saved to the database |
| Logic | AI works out what the customer wants. Routine questions (price, delivery time, discount, order status) get an instant reply built from the owner's settings. If the AI isn't sure, the question goes to the owner's Inbox. Orders become a draft invoice with automatic checks. |
| Approval (logged) | Owner reviews the checks and approves or rejects. Every decision and override goes into the Activity Log. |
| Outcome | Invoice sent on WhatsApp, synced to Orbyte, payment tracked with automatic reminders, delivery status updates sent to the customer |

## Run it

Requires Node.js 22.5 or newer. Nothing to install.

```bash
node server.js
```

Open http://localhost:3000. Use `node server.js --reset` to wipe the database.

## Pages

- **Dashboard**: things that need you, money outstanding/overdue, time saved
- **Inbox**: questions the AI couldn't answer, oldest first. Click one to open the WhatsApp chat and reply from the website.
- **Orders**: every order with its status; the order page shows Order ID, total, name, status and the **checks before approving**
- **Invoices**: waiting for approval / approved (with payment status, due date, reminders, Orbyte reference)
- **Activity Log**: full audit trail (who did what, when)
- **Settings**: prices, stock, delivery info, discount rules, payment terms, follow-up timing
- **Customer Simulator**: acts as a customer's WhatsApp for demos

## Database

SQLite file at `data/smartdesk.db` (tables: customers, messages, escalations, orders, order_items, invoices, products, settings, audit_log).

## Connecting the real services (environment variables)

| Variable | Purpose |
|---|---|
| `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` | WhatsApp Business Cloud API. Webhook URL: `https://<your-host>/webhook/whatsapp` |
| `ANTHROPIC_API_KEY` (+ `npm install`) | Use Claude to understand messages (English/Malay/mixed). Without it, the built-in keyword engine is used. |
| `ORBYTE_API_URL`, `ORBYTE_API_KEY` | Push approved invoices to Orbyte. Without them a mock reference is saved. |

Notes:
- WhatsApp only allows free-form messages within 24 hours of the customer's last message. The 48-hour follow-up and overdue payment reminders need pre-approved WhatsApp **template messages** in production.
- The Orbyte endpoint (`POST {ORBYTE_API_URL}/invoices`) is a placeholder. Swap in Orbyte's real API once it is available.

## Demo script (about 3 minutes)

1. Customer Simulator: click *Hi* → *How long does delivery take…* → *I want 2 original and 1 cheese* → the Name/Address message → *Can you write Happy Birthday…*
2. Inbox: the birthday question is waiting. Open it and reply. The reply appears in the simulator's WhatsApp.
3. Invoices: review ORD-0001 (all checks pass) and approve. The invoice arrives on WhatsApp.
4. Simulator: *Dah transfer*. Invoices shows "Customer says paid - verify". Mark paid, then move the order through packing and delivery on the order page.
5. Settings → *Skip ahead 49 hours* → *Run follow-ups & reminders* to show the follow-up to quiet customers and the overdue payment reminder.

SDG links: **8** (decent work & economic growth: less admin, more selling), **9** (digital tools for SMEs), **12** (paperless invoices).
