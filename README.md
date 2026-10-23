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

## FAQ answers from the AI (RAG)

Routine questions (price, delivery, discount, order status) get instant template replies built from Settings. For everything else, SmartDesk now **drafts an answer** for the owner:

1. The customer gets the usual "checking with the owner" reply, and the question goes to the Inbox.
2. In the background, the AI searches the shop's knowledge base: `knowledge/faq.json` (plus any `.md` / `.txt` files in `knowledge/`) and the current prices, delivery and discount settings.
3. The AI drafts a reply in the customer's language, using only what it found. Code then checks it: any RM price must appear in the shop data, the answer must cite a real FAQ entry, and questions the FAQ can't answer are flagged.
4. In the Inbox the owner sees the draft with its checks and taps **Send draft**, **Edit first**, or writes their own reply. Every decision is in the Activity Log.

Settings has an option to auto-send drafts that pass every check; it is off by default. **Settings → FAQ knowledge base** opens the question report (what customers ask that the FAQ can't answer, written as testable hypotheses) and re-tests unanswered questions after you update the FAQ.

Drafts need an AI key (see the table below). With Gemini, search also matches by meaning ("kek coklat" finds "chocolate cake") using Gemini embeddings. Without a key the Inbox works exactly as before.

## Languages

Customers can write in any language.

- **English, Malay and Chinese** get hand-written replies (prices and terms always from Settings).
- **Any other language** (Tamil, Indonesian, Japanese...) is recognised by the AI. Automatic replies, invoices, reminders and updates are translated by the AI before sending. A safety check makes sure every number, price, date, order/invoice code and bank account number is unchanged; if anything changed, the English reply is sent instead (logged as *translation skipped*).
- FAQ drafts are written directly in the customer's language, with an English version for the owner.
- The owner always sees the English meaning under foreign-language messages in the Inbox. Owner replies are sent exactly as typed.
- Without an AI key, everything works in English, Malay and Chinese only.

## Run it

Requires Node.js 22.5 or newer. Nothing to install: the Gemini connection uses Node's built-in `fetch`.

```bash
node server.js
```

Open http://localhost:3000. Use `node server.js --reset` to wipe the database. Run the tests with `npm test`.

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

Put these in a `.env` file in the project folder (loaded automatically), or in Replit's Secrets tab.

| Variable | Purpose |
|---|---|
| `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` | WhatsApp Business Cloud API. Webhook URL: `https://<your-host>/webhook/whatsapp` |
| `GEMINI_API_KEY` | Google Gemini reads customer messages (English/Malay/mixed), extracts orders and drafts FAQ answers. Get a key at aistudio.google.com. Without any AI key, the built-in keyword engine is used and FAQ drafts are off. |
| `GEMINI_MODEL` | Optional. Default `gemini-3.8-flash`. `GEMINI_THINKING_LEVEL` (default `low`) and `GEMINI_EMBEDDINGS=off` (keyword search only) are also available. |
| `GEMINI_FALLBACK_MODEL` | Optional. Default `gemini-3.5-flash`. If the main model is busy (503) or unreachable, SmartDesk retries once, then uses this model, then the keyword engine. `off` disables it. |
| `AI_REPLY_TIMEOUT_MS` | Optional. Default `8000`: if the AI hasn't answered a customer message within 8 seconds, the keyword engine replies instead. `GEMINI_TIMEOUT_MS` (default `15000`) limits background calls such as FAQ drafts. |
| `ANTHROPIC_API_KEY` | Optional alternative: use Claude instead of Gemini (`AI_PROVIDER=anthropic` if both keys are set). |
| `ORBYTE_API_URL`, `ORBYTE_API_KEY` | Push approved invoices to Orbyte. Without them a mock reference is saved. |

Notes:
- WhatsApp only allows free-form messages within 24 hours of the customer's last message. The 48-hour follow-up and overdue payment reminders need pre-approved WhatsApp **template messages** in production.
- The Orbyte endpoint (`POST {ORBYTE_API_URL}/invoices`) is a placeholder. Swap in Orbyte's real API once it is available.

## Demo script (about 3 minutes)

1. Customer Simulator: click *Hi* → *How long does delivery take…* → *I want 2 original and 1 cheese* → the Name/Address message → *Can you write Happy Birthday…*
2. Inbox: the birthday question is waiting with an AI draft from the FAQ. Check it and tap **Send draft**; it appears in the simulator's WhatsApp. Then send *Is it halal certified?*: the FAQ has no answer, so the draft is flagged and the question appears in **Settings → Open question report**.
3. Invoices: review ORD-0001 (all checks pass) and approve. The invoice arrives on WhatsApp.
4. Simulator: *Dah transfer*. Invoices shows "Customer says paid - verify". Mark paid, then move the order through packing and delivery on the order page.
5. Settings → *Skip ahead 49 hours* → *Run follow-ups & reminders* to show the follow-up to quiet customers and the overdue payment reminder.

SDG links: **8** (decent work & economic growth: less admin, more selling), **9** (digital tools for SMEs), **12** (paperless invoices).
