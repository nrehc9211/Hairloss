# OrderLah — stop losing orders in your WhatsApp inbox

For micro and small businesses that sell on WhatsApp. OrderLah tags every chat and tells the owner who to answer first. It turns orders into invoices that the customer has confirmed and the owner has approved. When a customer goes quiet, it drafts a follow-up, and the message is only sent when the owner taps Send.

Prototype for the Orbyte Smart SME Challenge (SDC Hackathon). The demo business "Dapur Lina Cakes" and all its customers and phone numbers are fictional.

Everything the app sends is in English. Customers can still write in English, Malay, Chinese or Manglish, and OrderLah understands them.

## Run it in 5 minutes

```bash
npm install          # only one dependency: pdf-lib
npm start            # open http://localhost:3000
npm test             # 47 tests, all should pass
```

| Page | URL | What it's for |
| --- | --- | --- |
| Home | `/` | Intro + three entry points |
| **Orbyte inbox** | `/inbox.html` | Who to answer first, AI tags, suggested replies, follow-up drafts, sales won back |
| WhatsApp simulator | `/simulator.html` | Customer, owner, supervisor and staff phones side by side |
| Orders | `/dashboard.html` | Orders, rule checks, approvals, invoices, audit trail |

You don't need a WhatsApp account or an AI key to run the demo: without a key, OrderLah uses keyword rules. The simulator always works, even when real WhatsApp is connected.

### 3-minute demo

1. Open the simulator and the inbox side by side, press **Reset demo**
2. Press **▶ Inbox scenario**: Mei Ling, Aina and Kevin write, Ali sends 5 messages in a row → in the inbox, Aina's urgent order is first and Ali did not jump the queue
3. Approve Aina's order (in the inbox or on the owner's phone) → invoice, payment link and packing list go out
4. Send Kevin the suggested reply, press **+3 hours** → the owner's phone gets a follow-up draft → tap **Send**
5. In the simulator, tap "Kevin: I'll take one!" → Kevin confirms → the owner approves → "Won back by follow-up" goes up

## Settings (copy `.env.example` to `.env`)

| Variable | What it does |
| --- | --- |
| `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, `RUNPOD_MODEL` | Use a RunPod Serverless vLLM model for tags, order reading, replies and follow-ups |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Other AI options; `OPENAI_API_KEY` also handles voice-to-text |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | When set, messages go through the real WhatsApp Cloud API |
| `WHATSAPP_VERIFY_TOKEN` | Any string you choose; must match the webhook setting in Meta |
| `OWNER_PHONE`, `SUPERVISOR_PHONE`, `STAFF_PHONE` | Real numbers for the team, so approval cards and packing lists reach real phones |
| `BASE_URL` | Your public https tunnel URL, so WhatsApp can download the invoice PDF |

The RunPod URL format is `https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1`; the code builds it for you. If the model is slow or fails, OrderLah falls back to keyword rules, so the demo never stops.

## Connect a real WhatsApp

OrderLah uses Meta's official **WhatsApp Cloud API**. The free test setup gives you a test business number that can message up to 5 phones you verify, which is enough for a team demo.

**1. Create the Meta app (once)**

1. Go to [developers.facebook.com](https://developers.facebook.com/) → **My Apps** → **Create app** → choose the **Business** type (or the "Connect with customers through WhatsApp" use case)
2. Add the **WhatsApp** product → open **API Setup**
3. Copy the **temporary access token** and the **Phone number ID** of the test number
4. Under **To**, add each teammate's phone number (up to 5); each phone gets a code to confirm

**2. Fill in `.env`**

```
WHATSAPP_TOKEN=<temporary access token>
WHATSAPP_PHONE_NUMBER_ID=<phone number ID>
WHATSAPP_VERIFY_TOKEN=orderlah-dev
OWNER_PHONE=60123456789
SUPERVISOR_PHONE=
STAFF_PHONE=
```

Phone numbers are digits only, with the country code and no `+` (Malaysia starts with `60`). The owner's phone gets the order approval cards and follow-up drafts.

**3. Give your laptop a public https address**

Meta has to reach your webhook from the internet. Start OrderLah, then open a second terminal and run one of these:

```bash
npm start
```

```bash
ngrok http 3000
```

`ngrok` needs a free ngrok account. `cloudflared tunnel --url http://localhost:3000` works without an account, but its URL changes each time you start it.

Put the https URL it prints into `BASE_URL` in `.env`, then restart `npm start`.

**4. Connect the webhook in Meta**

1. **WhatsApp → Configuration → Webhook → Edit**
2. Callback URL: `https://<your tunnel>/webhook`
3. Verify token: the same string as `WHATSAPP_VERIFY_TOKEN`
4. Press **Verify and save**, then under **Webhook fields** subscribe to **messages**

**5. Check it**

```bash
npm run wa:check -- 60123456789
```

This checks your token, phone number ID, `BASE_URL` and team numbers, then sends Meta's "hello_world" test message to that phone.

**6. Try it**

1. **The owner sends "hi" to the test number first.** WhatsApp only lets a business send free-form messages to someone who has written in the last 24 hours, so this opens the window for approval cards. The owner gets the OrderLah help message back.
2. From another verified phone, message the test number like a customer: `I want 2 chocolate cakes for Saturday`
3. The customer gets the order summary with **Correct / Change** buttons → the owner gets the approval card → **Approve** → the customer gets the invoice PDF and payment link

The inbox and orders pages show real WhatsApp chats too. The top bar says **WhatsApp: cloud** when it's connected.

**Good to know**

- The temporary token expires after 24 hours. When `wa:check` says the token is rejected, copy a new one from API Setup. For a token that lasts longer, create a System User in Meta Business settings.
- Real customers are not in the demo data, so OrderLah treats them as new customers, and their orders always need the owner's approval.
- Follow-ups are only sent inside the 24-hour window. Outside it, WhatsApp only allows pre-approved templates (`WHATSAPP_REMINDER_TEMPLATE` for payment reminders).
- With a tunnel, keep both terminals open during the demo. If you use `cloudflared`, update `BASE_URL` and the Meta callback URL every time its URL changes.

## File map

```
src/
  server.js            routes: /webhook, inbox API, simulator API, orders API, pay page, demo script
  http.js              tiny web framework (no express)
  flows/orderFlow.js   ★ entry for every message: tag → order lane / wait for reply
  inbox/index.js       ★ inbox: queue, tags, follow-ups (inside 24h, max 2, owner approves)
  ai/llm.js            model calls: RunPod / OpenAI-compatible / Anthropic
  ai/tagger.js         tags, suggested replies, follow-up drafts + keyword fallback
  ai/index.js          order reading (model), voice notes, photos
  ai/parser.js         rule parser: English, Malay, Chinese, Manglish
  rules/engine.js      business rules: prices, unusual qty, overdue, credit limit, delivery day, auto-approve
  invoice/index.js     invoice PDF
  orbyte/index.js      ★ mock Orbyte API (CRM, eLeave, Connect, audit log)
  whatsapp/*           send messages, read the webhook
scripts/
  reset.js             npm run reset — reload demo data
  wa-check.js          npm run wa:check — test your WhatsApp setup
public/                index.html, inbox.html, simulator.html, dashboard.html, pay.html, app.css
data/seed.json         demo data: business, staff, customers, products, past orders, all rule numbers
test/                  parser, tags, rules, order flow, inbox, fake RunPod tests
.github/workflows/     runs the tests on every push
```

To change rule numbers (follow-up timing, queue bonuses, repeat-customer threshold) you don't need to touch code: edit `settings` in `data/seed.json`, then run `npm run reset`.

## Connect the real Orbyte

Each function in `src/orbyte/index.js` stands for one Orbyte module. Once you have Orbyte's API docs, change only this file and keep the same return format.

For how the team works on the code together, see [CONTRIBUTING.md](CONTRIBUTING.md).
