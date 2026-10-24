

# Orbyte SmartDesk

> A WhatsApp order desk for micro and small businesses: AI answers routine customer questions, turns chats into checked draft invoices for the owner to approve, and chases payments automatically, all inside the Orbyte approval workflow.

---

## Team Information

| Field                  | Details                                     |
| ---------------------- | ------------------------------------------- |
| **Team Name**          | Hairloss                                    |
| **Team Domain**        | Domain 2                                    |
| **SDG Track (1–17)**   | SDG 8 — Decent Work and Economic Growth     | 
|                        | SDG 9 Innovation                            |
|                        | SDG 12 Less waste (paperless)               |
| **Team Leader**        | Judah Teoh Em Yu                            |
| **University**         | University Malaya                           |
| **Number of Members**  | 5                                           |

## Links

| Resource          | Link                                             |
| ----------------- | ------------------------------------------------ |
| GitHub Repository | https://github.com/nrehc9211/Smart-Desk          |
| Live Demo         | https://orbyte-smartdesk.replit.app/             |
| Orbyte Sandbox    | https://orbyte-xyz.alphareds.com/                |
| Slide Deck        | https://canva.link/7zo3mywqf4o9idn               |
| Demo Video        | https://youtu.be/J02ctPJ9VnU?si=n5iiHofS-ZHKVHCl |

---

## Overview

### Problem

Micro and small businesses sell mostly through WhatsApp. Our demo business is a kek lapis shop with one owner and two staff (customer service, packing & delivery). The owner spends hours every day answering the same questions (price, delivery time, discounts), typing invoices by hand and chasing payments. Mistakes creep into totals, and customers who ask a question and then go quiet are simply lost.

### Solution

SmartDesk automates one recurring burden end to end — **WhatsApp order to approved invoice to payment** — while keeping the owner in control:

| Step | What happens |
|---|---|
| **Trigger** | A customer sends a WhatsApp message |
| **Data** | Message, customer, order and items are saved to the database |
| **Logic** | AI classifies the message and extracts order details. Routine questions get an instant reply built from the owner's own settings. Anything unexpected goes to the owner's Inbox with an AI-drafted answer from the shop's FAQ. Orders become a draft invoice with automatic checks. |
| **Approval (logged)** | The owner reviews the checks and approves or rejects. Every decision and override is written to the Activity Log. |
| **Outcome** | Invoice sent on WhatsApp, synced to Orbyte, payment tracked with automatic reminders, delivery updates sent to the customer |

The AI never invents prices or terms: it only classifies and extracts, and replies are built from Settings. When the AI is unsure, it escalates instead of guessing.

### Key Features

- **AI WhatsApp replies + owner Inbox** — Routine questions (price, delivery, discount, order status) are answered instantly. Unexpected questions appear in the Inbox in time order; clicking one opens that customer's WhatsApp chat on the right so the owner can reply from the website (the customer receives it on WhatsApp).
- **FAQ answer drafts (RAG)** — For unexpected questions, the AI searches `knowledge/faq.json` and the shop settings and drafts a reply in the customer's language. Code then verifies it (every RM price must exist in shop data, the answer must cite a real FAQ entry). The owner taps **Send draft**, **Edit first**, or writes their own.
- **Order details with approval checks** — Each order shows Order ID, total, customer name, status (where the order is) and the checks before approving: customer name, delivery address, prices match catalogue, stock available, total recalculated, order size, duplicate check, unanswered questions.
- **Invoice approval lists** — One list of invoices waiting for approval, one of approved invoices with payment status, due date, reminders sent and Orbyte reference.
- **Automatic follow-ups** — Customers who asked and went quiet get a follow-up within 48 hours; overdue invoices get payment reminders.
- **Multilingual** — Hand-written English, Malay and Chinese replies; other languages are translated by AI with a safety check that numbers, prices, dates, codes and bank details are unchanged.
- **Full audit trail** — Every AI action, owner decision and override is logged.

### Tech Stack

| Layer         | Technology                                                     |
| ------------- | -------------------------------------------------------------- |
| Frontend      | HTML, CSS, vanilla JavaScript (`public/`)                      |
| Backend       | Node.js 22.5+ (built-in `http`, no npm dependencies)           |
| Database      | SQLite via Node's built-in `node:sqlite` (`data/smartdesk.db`) |
| AI            | Google Gemini (default) or Claude, with a keyword-engine fallback; Gemini / Voyage embeddings for semantic search |
| AI / Compute  | RunPod (GPU)                                                   |
| Messaging     | WhatsApp Business Cloud API                                    |
| Integration   | Orbyte (invoice sync)                                          |
| Hosting / Dev | Replit                                                         |

---

## Project Structure

```
.
├── knowledge/
│   └── faq.json             # Shop FAQ used for AI answer drafts (RAG)
├── public/
│   ├── index.html           # Single-page web app
│   ├── app.js               # Dashboard, Inbox, Orders, Invoices, Settings, Simulator
│   └── styles.css
├── src/
│   ├── ai.js                # Message classification + order extraction
│   ├── db.js                # SQLite schema, settings, audit log
│   ├── env.js               # Loads .env (Replit Secrets take priority)
│   ├── orbyte.js            # Orbyte connector (pushes approved invoices)
│   ├── rag.js               # FAQ draft pipeline
│   ├── replies.js           # Reply templates (EN / MS / ZH)
│   ├── service.js           # Automated journey: trigger → checks → approval → outcome
│   ├── translate.js         # AI translation with number/price safety check
│   ├── whatsapp.js          # WhatsApp Business Cloud API connector
│   └── rag/                 # Chunking, keyword + embedding search, LLM clients, question report
├── test/
│   ├── faq-drafts.test.mjs
│   ├── gemini.test.mjs
│   ├── rag.test.cjs
│   └── fixtures/
├── submission/              # Required submission documents
│   ├── SDC2026_TeamName_Preliminary.pdf
│   ├── SDC2026_TeamName_TechDeclaration.pdf
│   └── SDC2026_TeamName_Replit_POU.pdf
├── server.js                # HTTP server, REST API, WhatsApp webhook
├── start.bat                # One-click start on Windows
├── .env.example             # Example environment variables
├── .gitignore
├── LICENSE
├── package.json
└── README.md
```

### Architecture

```
Customer (WhatsApp) ──► WhatsApp Cloud API ──► /webhook/whatsapp
                                                     │
                                               SmartDesk server (Replit)
                                     ┌───────────────┼──────────────────┐
                                     ▼               ▼                  ▼
                              AI (Gemini / Claude /   SQLite DB      Orbyte API
                              RunPod) + FAQ search   (orders,        (approved
                                     │               invoices,       invoices)
                                     ▼               audit log)
                     Instant reply  or  Owner Inbox (draft + checks)
                                     │
                     Owner approves in web app ──► Invoice on WhatsApp ──► Payment reminders
```

### Pages

- **Dashboard** — what needs attention, money outstanding / overdue, time saved
- **Inbox** — unexpected questions, oldest first; click to open the WhatsApp chat and reply
- **Orders** — every order with status; order page shows details and approval checks
- **Invoices** — waiting for approval / approved
- **Activity Log** — who did what, when
- **Settings** — prices, stock, delivery info, discount rules, payment terms, follow-up timing, FAQ report
- **Customer Simulator** — acts as a customer's WhatsApp for demos

### Database

SQLite tables: `customers`, `messages`, `escalations`, `orders`, `order_items`, `invoices`, `products`, `settings`, `audit_log`.

---

## How to Run

Requires **Node.js 22.5 or newer**. There is nothing to install (no npm packages).

### Option 1 — Run on Replit (Recommended)

1. Open the [Replit Project](https://orbyte-smartdesk.replit.app/), or import this repository via **Create Repl → Import from GitHub**.
2. Open the **Secrets** tab (🔒) and add the variables listed in `.env.example`:
   - `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`)
   - `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`
   - Optional: `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN`, `ORBYTE_API_URL`, `ORBYTE_API_KEY`
3. Click **Run** (runs `node server.js`).

### Option 2 — Run Locally

```bash
# 1. Clone the repository
git clone https://github.com/nrehc9211/Smart-Desk.git
cd orbyte-smartdesk

# 2. Configure environment variables
cp .env.example .env            # then fill in your values

# 3. Run the app
node server.js
```

Open http://localhost:3000. On Windows you can double-click `start.bat` instead.
Use `node server.js --reset` (or `npm run reset`) to wipe the database.

Without any AI key the app still works: the built-in keyword engine answers in English, Malay and Chinese, and FAQ drafts are turned off. Without WhatsApp keys, messages are simulated and appear in the Customer Simulator.

### Environment Variables

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini for message understanding, order extraction and FAQ drafts |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | Optional model overrides (main model falls back on 503 / timeout) |
| `ANTHROPIC_API_KEY` | Optional alternative to Gemini (`AI_PROVIDER=anthropic` if both are set) |
| `AI_REPLY_TIMEOUT_MS` | Default `8000`; keyword engine replies if the AI is slower |
| `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` | WhatsApp Business Cloud API. Webhook: `https://<your-host>/webhook/whatsapp` |
| `ORBYTE_API_URL`, `ORBYTE_API_KEY` | Push approved invoices to Orbyte; otherwise a mock reference is saved |
| `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` | RunPod GPU endpoint |

### Run Tests

```bash
npm test
```

### Demo Script (about 3 minutes)

1. **Customer Simulator:** click *Hi* → *How long does delivery take…* → *I want 2 original and 1 cheese* → the Name/Address message → *Can you write Happy Birthday…*
2. **Inbox:** the birthday question is waiting with an AI draft. Tap **Send draft**; it appears in the simulator's WhatsApp. Then send *Is it halal certified?*: the FAQ has no answer, so the draft is flagged and the question appears in **Settings → Open question report**.
3. **Invoices:** review ORD-0001 (all checks pass) and approve. The invoice arrives on WhatsApp.
4. **Simulator:** *Dah transfer*. Invoices shows "Customer says paid – verify". Mark paid, then move the order through packing and delivery.
5. **Settings:** *Skip ahead 49 hours* → *Run follow-ups & reminders* to show the follow-up to quiet customers and the overdue payment reminder.

---

## Orbyte Fit and Reuse

- Orbyte already runs approval workflows such as **eLeave** and **eClaim**. SmartDesk applies the same **request → approve → log → outcome** pattern to sales invoices, so owners and staff already know how it works.
- Approved invoices are pushed to Orbyte (`src/orbyte.js`) so they sit next to the business's other approval records.
- The journey is configured through Settings (products, prices, terms, follow-up timing) and a FAQ file, so any SME selling through WhatsApp — bakery, catering, florist, online retail — can reuse it without code changes.

## Business Benefit and SDG Link

- **Time saved:** routine questions and invoice typing are automated; the dashboard shows the estimated time saved.
- **Accuracy and consistency:** prices come from the catalogue, totals are recalculated, duplicates and stock issues are flagged before approval.
- **Less lost revenue:** quiet customers get a follow-up; overdue invoices get reminders.
- **People stay in control:** nothing is invoiced without the owner's approval, and every action is logged.

SDG links: **8** (Decent Work & Economic Growth: less admin, more selling), **9** (Industry, Innovation & Infrastructure: digital tools for SMEs), **12** (Responsible Consumption & Production: paperless invoices).

## Ease of Learning

- Everything happens in one web app with seven plain-English pages.
- The owner keeps using WhatsApp the way customers already do; replies sent from SmartDesk arrive in the same chat.
- Approval checks are shown as simple pass / warn / fail items with an explanation.
- The Customer Simulator lets new users practise the full journey without a real WhatsApp account.

---

## How We Use Replit *(Required)*

- **Development:** Collaborative coding in a shared Repl.
- **Hosting:** The app is deployed with Replit Deployments at the Live Demo link above.
- **Secrets:** API keys are stored in Replit Secrets, never in the code. `src/env.js` loads `.env` locally, but real environment variables (Replit Secrets) always win.
- **AI Integrations:** The Claude client (`src/rag/llm.cjs`) also supports Replit AI Integrations (`AI_INTEGRATIONS_ANTHROPIC_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`).

📄 Proof of use: [`submission/SDC2026_Hairloss_Replit_POU.pdf`](submission/SDC2026_Hairloss_Replit_POU.pdf)

---

## Challenges & Learnings

- **Stopping the AI from making up prices:** we limited the AI to classifying and extracting. Replies are built from Settings, and FAQ drafts are checked in code so every RM amount must exist in shop data.
- **Mixed-language messages:** Malaysian customers mix English, Malay and Chinese. We combined hand-written templates for these with AI translation plus a safety check for numbers and codes.
- **Reliability when the AI is slow or down:** a timeout, a fallback model and a keyword engine mean customers always get an answer.
- **WhatsApp's 24-hour rule:** free-form messages are only allowed within 24 hours of the customer's last message, so follow-ups and overdue reminders need pre-approved template messages in production.

## Future Improvements

- [ ] Connect to Orbyte's real invoice API (the current endpoint `POST {ORBYTE_API_URL}/invoices` is a placeholder)
- [ ] Register WhatsApp template messages for follow-ups and payment reminders
- [ ] Automatic payment matching from bank / DuitNow transfer notifications
- [ ] Staff roles (customer service vs packing & delivery) with their own task views
- [ ] Self-hosted model on RunPod for all AI calls to cut API costs

## Team
 
| Name              | Role                | GitHub                                                            |
| -----------       | ------------------- | ------------------------------------------------------------------|
| JUDAH TEOH EM YU  | Team Lead / Backend | [@JudahTeoh](https://github.com/JudahTeoh)                        |
| CHEW SIAN CHERN   | Frontend / Bankend  | [@nrehc9211](https://github.com/nrehc9211)                        |
| JANET SOO YU TING | Replit / Frontend   | [@Janet-lab3142](https://github.com/Janet-lab3142)                |
| ONG SEN HUI       | Database            | [@ONGSENHUI-2026](https://github.com/ONGSENHUI-2026)              |
| TEH SHIANG HAN   | Replit               | [@tehshianghan-24225861](https://github.com/tehshianghan-24225861)|

---

## Submission Checklist

- [/] Team name, domain (Domain 1 / Domain 2) and SDG track filled in
- [/] Slide deck link added
- [/] Demo video link added
- [/] Replit used, with proof of use in `submission/`
- [/] Preliminary submission completed (`SDC2026_Hairloss_Preliminary.pdf`)
- [/] Technology declaration completed (`SDC2026_Hairloss_TechDeclaration.pdf`)
- [/] Submission files renamed with your team name (replace `Hairloss`)
- [/] "How to Run" steps verified
- [/] No API keys or secrets committed to the repository

## License

This project is licensed under the [Apache License 2.0](LICENSE).
