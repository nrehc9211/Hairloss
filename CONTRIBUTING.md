# Team workflow: how we change OrderLah together

In one line: **one branch per change → run the tests locally → push → open a Pull Request → tests go green automatically → merge into main**. main must always be demo-ready.

## First time: put it on GitHub (only one person does this)

This folder is already a git repo with commits.

**Option A: GitHub website + terminal**

1. Go to https://github.com/new, name the repository `orderlah`, choose **Private**, **don't** tick README / .gitignore / license, press Create
2. In a terminal inside this folder:

   ```bash
   git remote add origin https://github.com/<your-account>/orderlah.git
   git push -u origin main
   ```

**Option B: with the GitHub CLI (`gh`)**

```bash
gh auth login
gh repo create orderlah --private --source . --push
```

Then invite teammates under the repo's **Settings → Collaborators**.

## Each teammate, the first time

```bash
git clone https://github.com/<account>/orderlah.git
cd orderlah
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run dev               # restarts automatically when you change code
```

Open http://localhost:3000.

## Every time you change something

```bash
git checkout main
git pull                              # get the latest first
git checkout -b feat/inbox-kpi        # one branch per change, name says what it does
# ...change code...
npm test                              # only push when everything passes
git add -A
git commit -m "Inbox: show follow-up win rate"
git push -u origin feat/inbox-kpi
```

Then press **Compare & pull request** on GitHub:

1. Say what changed and how you tested it (the template appears automatically)
2. Wait for the **CI** check to turn green (`.github/workflows/ci.yml` runs `npm test` on Node 22 and 24)
3. Ask a teammate to take a look, then press **Merge**
4. Back to main locally: `git checkout main && git pull`

## Who mainly works where (fewer conflicts)

| Role | Main files |
| --- | --- |
| Backend · WhatsApp | `src/flows/`, `src/inbox/`, `src/whatsapp/`, `src/orbyte/`, `src/server.js` |
| AI · RunPod | `src/ai/`, `.env` (your own, never committed) |
| Frontend · UX | `public/` |
| Business · pitch | `data/seed.json` (products, prices, rule numbers), slides |

If two people need the same file, say so in the group chat first.

## Where to make common changes

| To change | Go here |
| --- | --- |
| Products, prices, business details | `data/seed.json` → `npm run reset` |
| Follow-up timing, max follow-ups, queue bonuses, repeat-customer threshold | `settings` in `data/seed.json` |
| Keyword tags (what counts as comparing, what counts as urgent) | `RE` in `src/ai/tagger.js` |
| Suggested reply and follow-up template sentences | `templateReply`, `draftFollowUp` in `src/ai/tagger.js` |
| Prompts for the RunPod model | `src/ai/tagger.js` (`TAG_SYSTEM`, `FU_SYSTEM`), `src/ai/index.js` (`SYSTEM`) |
| Sentences customers and the owner see on WhatsApp | `src/flows/orderFlow.js`, `src/inbox/index.js` |
| Inbox screen | `public/inbox.html` (colours and fonts in `public/app.css`) |
| Sample buttons in the simulator | `SAMPLES` in `public/simulator.html` |
| Demo script (who sends what first) | `SCENARIO` in `src/server.js` |
| Switching to the real Orbyte API | `src/orbyte/index.js` |

If you change a sentence or a rule, update the matching test in `test/`.

## Rules

- **Never commit `.env` or any key** (`.gitignore` already blocks `.env`). If one gets pushed by accident, revoke it on RunPod / Meta right away and create a new one.
- main only changes through Pull Requests. You can protect main under **Settings → Branches**: require CI to pass before merging.
- Tag a version the night before the demo so you can roll back: `git tag demo-v1 && git push --tags`
