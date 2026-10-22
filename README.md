# comment-to-DM

Someone comments a keyword on your reel. The service replies publicly under the
comment, sends them one DM with a button, and when they tap it, checks whether
they follow you. Followers get the resource immediately. Non-followers get one
polite nudge and the same button again.

Built for **one** Instagram Professional account — your own — using **official
Meta APIs only**. No scraping, no unofficial endpoints, no logging in with a
password, no browser automation.

- [What it does](#what-it-does)
- [Why the first DM is a button](#why-the-first-dm-is-a-button)
- [Architecture](#architecture)
- [Run it locally](#run-it-locally)
- [Run the tests](#run-the-tests)
- [The dashboard](#the-dashboard)
- [Going live](#going-live)
- [What it will not do](#what-it-will-not-do)

---

## What it does

```
1.  someone comments "guide" on your reel
       │
       ├─► a public reply under their comment:  "Sent you a DM ✅"
       │
       └─► one DM:  "Tap the button and I'll send it."   [ Send me the guide ]
                                                              │
2.  they tap the button  ──────────────────────────────────────┘
       │
       │   their tap does two things Meta requires: it opens the 24-hour
       │   messaging window, and it grants consent to read their profile
       │
       ▼
3.  is_user_follow_business ?
       │
       ├── true  ──►  the resource, straight away.  Done.
       │
       └── false ──►  "One tap: follow, then press the button again."
                          [ Send me the guide ]
                               │
                      they follow and tap again  ──►  back to step 3
```

Someone who already follows you gets the resource on their **first** tap. No
extra step, no nagging.

Also supported: somebody DMs you the keyword with no comment involved. Their DM
is itself a user-initiated interaction, so the service goes straight to the
follow check.

## Why the first DM is a button

This is the one design decision worth understanding, because everything else
follows from it.

Meta lets you send **exactly one** private reply per comment, and a comment on
its own does **not** give you permission to read the commenter's profile. So at
the moment someone comments, you cannot yet ask whether they follow you — and
you only get one message to work with.

So the one message is a **button**. Their tap grants profile consent and opens
the 24-hour messaging window at the same time, and from then on you can send
normal DMs and check their follow status. Putting the resource in that first
message instead would mean giving it away without ever being able to check the
follow, and giving up your only private reply to do it.

## Architecture

```
          Instagram
              │
              │  comments / messages / messaging_postbacks
              ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  POST /webhook                                                │
  │    1. verify X-Hub-Signature-256 over the RAW body            │
  │    2. INSERT INTO events (provider_event_id UNIQUE)           │
  │    3. return 200.  That is all.                               │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  (Meta never waits on our work)
                                  ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  event worker                                                 │
  │    claim pending events  (FOR UPDATE SKIP LOCKED)             │
  │    match a rule  ──►  run the state machine  ──►  enqueue     │
  └───────────────────────────────┬───────────────────────────────┘
                                  ▼
                         ┌─────────────────┐
                         │     outbox      │  dedupe_key UNIQUE
                         └────────┬────────┘
                                  ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  outbox worker                                                │
  │    still inside the allowed window?   caps and cooldowns ok?  │
  │    a token left in the rate-limit bucket?                     │
  │      └─► Meta client ──► graph.instagram.com                  │
  │            success  → mark sent                               │
  │            5xx/429  → backoff + jitter, retry                 │
  │            permission / window / consent → fail, never retry  │
  └───────────────────────────────────────────────────────────────┘

  GET /healthz   liveness + a real database check
  /admin         one server-rendered page: rules, conversations, outbox,
                 audit log, retry button, dry-run tester
```

### The state machine

```
   NEW ──comment──► PROMPTED ──tap──► CHECKING ──follows──► DELIVERED
                                        │   ▲
                           not following│   │taps again
                                        ▼   │
                                       GATED
```

Terminals: `DELIVERED`, `FAILED` (we gave up, reason recorded), `ABANDONED`
(they never came back). Every transition is persisted with a reason, visible on
the dashboard.

### Engineered against the two failure modes

Messaging someone twice, and failing to deliver something you promised. In
order of how much they matter:

| Guard | How |
|---|---|
| A replayed webhook sends nothing | `events.provider_event_id` is **unique**. Meta retries deliveries; the second insert is a no-op. |
| One conversation per person per rule | `conversations (igsid, rule_id)` is **unique**. Commenting five times cannot produce five DMs. |
| One message per logical send | `outbox.dedupe_key` is **unique**. Two attempts to queue the same message collapse into one row. |
| One private reply per comment | its dedupe key *is* the comment id. |
| Exactly one follow check per attempt | dedupe key `follow_check:<conversation>:<attempt>`. |
| Each row is processed by one worker | `FOR UPDATE SKIP LOCKED`. |
| A promised resource is never dropped by our own caps | deliveries are exempt from the per-contact cooldown and daily cap. Prompts and gates are not. |
| We never retry into a wall | permission, validation and closed-window errors are never retried. Rate limits and 5xx are, with exponential backoff and full jitter. |
| We never message outside the allowed window | checked locally before every send, from the person's **own** last action — not from when the row was queued. |
| Nothing leaks into the logs | pino redaction, plus the audit log stores ids and statuses only. |

### Where things are

| Path | What |
|---|---|
| `src/core/engine.ts` | **Read this first.** Inbound event → decision → outbox, and outbox row → one Meta call. |
| `src/domain/state.ts` | The state machine, as a pure function. |
| `src/domain/rules.ts` | Keyword matching and rule selection. |
| `src/core/guards.ts` | Windows, caps, cooldowns. Every safety rail, pure and testable. |
| `src/meta/client.ts` | The only file that talks to Meta. Each method cites its doc URL. |
| `src/meta/errors.ts` | What is retryable and what is not. |
| `src/repo/repository.ts` | The one data-access interface. |
| `src/repo/postgres.ts` / `memory.ts` | Its two implementations. |
| `src/server.ts` | Webhook, health, admin routes. |
| `src/testing/mock-meta.ts` | A fake Meta API with realistic errors. |
| `migrations/*.sql` | The schema, applied in order on boot. |
| `docs/SETUP.md` | First-time Meta app setup, start to finish. |
| `docs/API_NOTES.md` | Every endpoint, its doc URL, and where the docs differed from the spec. |
| `docs/OPERATIONS.md` | Token rotation, App Review, what to do when sending stops. |

## Run it locally

Node 20.11 or newer.

```powershell
npm install
```

### 1. See it work, with nothing installed and nothing configured

```powershell
npm run simulate
```

This boots the whole service in memory against a fake Meta API and replays both
journeys — the follower and the gated non-follower — printing exactly what the
person on Instagram would see, then the resulting database rows. No Postgres, no
Docker, no network, no credentials. **Start here.**

### 2. Run it for real, against a local database

```powershell
Copy-Item .env.example .env
# fill in APP_SECRET, VERIFY_TOKEN, IG_USER_ID, IG_ACCESS_TOKEN, ADMIN_TOKEN
# leave DRY_RUN=true

docker compose up -d db          # Postgres on localhost:5432
npm run migrate                  # apply the schema (the service also does this on boot)
npm run dev                      # http://localhost:3000
```

Then open <http://localhost:3000/admin>, paste your `ADMIN_TOKEN`, and use the
**dry-run tester** to check what a given comment would trigger.

To receive real webhooks on your laptop you need a public HTTPS URL — see
`docs/SETUP.md`, "Pointing Meta at a laptop".

### 3. Or run the whole stack in Docker

```powershell
docker compose up --build        # service on :3000, Postgres on :5432
docker compose down              # stop
docker compose down -v           # stop and delete the database
```

### Scripts

| Command | What it does |
|---|---|
| `npm run simulate` | the in-memory demo described above |
| `npm test` | the whole suite, offline |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev` | watch mode |
| `npm run build` | compile to `dist/` |
| `npm start` | run the compiled service |
| `npm run migrate` | apply migrations and exit |

All of them are plain node/npm invocations and work the same in PowerShell,
cmd.exe and any POSIX shell.

## Run the tests

```powershell
npm test
```

Offline from a clean checkout: no Docker, no Postgres, no Meta credentials, no
network. 199 tests covering signature verification, rule matching for every
match type, the button payload codec, every state transition, backoff maths, the
rate limiter, error classification, the webhook parser (both payload shapes),
the Repository contract, the admin routes, `DRY_RUN`, and the full flows:
already-following, gated non-follower, duplicate webhook, non-matching comment,
the operator's own comment, rate limit with backoff, consent-required,
expired 24-hour window, permission error, caps and cooldowns.

### Also exercise the real SQL

The same integration suite runs against real Postgres when you point it at one,
and skips cleanly when you do not:

```powershell
docker compose up -d db
$env:TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/comment_to_dm"
npm test
```

That runs every flow twice — once on the in-memory repository, once on real
Postgres — so the unique indexes, `FOR UPDATE SKIP LOCKED`, and the `jsonb` and
`text[]` columns are genuinely tested.

## The dashboard

`/admin`, protected by `ADMIN_TOKEN` (constant-time compare; a bearer header for
scripts, an HttpOnly cookie for the browser). Server-rendered HTML, no build
step, no JavaScript.

- **Dry-run tester** — type a comment, see exactly what would be sent. Writes
  nothing, calls nothing.
- **Rules** — create, edit every piece of text, enable and disable. New rules
  start **disabled**.
- **Recent conversations** — who is in which state, how many follow checks,
  when they were delivered to, and why the last transition happened.
- **Outbox** — every outbound call, its status, attempts, last error, and a
  **Retry** button for failed rows.
- **Audit log** — every inbound event and outbound call. Ids and statuses only;
  never a token, never a full message body.

## Going live

The short version; `docs/SETUP.md` is the real guide and `docs/OPERATIONS.md`
covers running it.

1. Convert the account to a **Professional** account and make it public.
2. Create a Meta app, add the Instagram product, set up **Business Login for
   Instagram**.
3. Generate a long-lived Instagram User access token (60 days) and note the
   date you will need to refresh it.
4. Deploy (Render blueprint included) with `DRY_RUN=true`.
5. Point Meta's webhook at `https://your-host/webhook` with your
   `VERIFY_TOKEN`, and subscribe to `comments`, `messages` and
   `messaging_postbacks`.
6. Comment on your own post from a second account and watch the dashboard. With
   `DRY_RUN=true` nothing is sent.
7. **App Review.** Until your app has Advanced Access, you can only message
   people who are **testers on the app**. Everyone else gets error 200,
   *"Cannot message users who are not admins, developers or testers"*. This is
   the step people miss, and it is covered honestly in `docs/SETUP.md` and
   `docs/OPERATIONS.md`.
8. Set `DRY_RUN=false`, enable one rule, and watch the first few go through.

## What it will not do

Deliberately out of scope, and not quietly worked around:

- Multiple accounts or tenants.
- Any attempt to detect follow status other than `is_user_follow_business`.
  There is no fallback and no heuristic.
- Follower lists, follower scraping, hashtag or business discovery.
- Messaging people who have not interacted with you.
- Message tags, one-time notifications or the human-agent tag to reach someone
  outside the 24-hour window.
- Buying or automating engagement.
- Anything that logs into Instagram as a user instead of using the API.
