# comment-to-DM automation — specification

Self-hosted Instagram comment → auto-reply → auto-DM with a follow gate. Runs for one Instagram
Professional account (the operator's own). Official Meta APIs only. No scraping, no unofficial
endpoints, no logging into the account with a password, no browser automation.

Target host: **Render** (long-running Node service) + **Supabase Postgres**. Must also run locally
via Docker Compose and be portable to Fly/Railway/a VPS.

## 1. The flow (this is the product)

1. Someone comments on a post/reel. Meta sends a `comments` webhook.
2. If the comment text matches a **rule** (keyword, per-post or global), the service:
   - **a.** posts a **public reply** to that comment ("Sent you a DM ✅" — rotating variants), and
   - **b.** sends **one private reply** to the commenter: a short message with a **button**
     ("Send me the resource"). Private replies are limited to exactly one message per comment, so
     this first message must be the button — not the resource.
3. The user **taps the button** → `messaging_postbacks` webhook. The tap is a user-initiated
   interaction: it opens the 24-hour messaging window **and** grants consent for the profile API.
4. Service calls the user profile API for `is_user_follow_business`:
   - **following → deliver the resource immediately** (link + any follow-up text).
   - **not following → send the gate message** ("Please follow — it's one tap, then press the button
     again and I'll send it") with the button again (`RECHECK` payload).
5. User follows, taps again → check repeats → resource delivered.
6. Someone who already follows gets the resource on their **first** tap. No extra step.

Also supported: a user **DMs** a keyword directly (no comment involved) → same flow from step 3.

### State machine

`NEW → PROMPTED → (GATED ⇄ CHECKING) → DELIVERED`, plus terminals `FAILED`, `ABANDONED`.
Every transition is persisted with a reason. Re-entry is idempotent: a second tap after delivery
re-sends the resource at most once per cooldown (default 10 min) and never duplicates a DB row.

## 2. Meta API surface (verify each against current docs before coding)

Instagram API with Instagram Login. Base `https://graph.instagram.com/<API_VERSION>`.
Pin `API_VERSION` in env; default to the current stable version at build time.

| Purpose | Call |
|---|---|
| Webhook verification | `GET /webhook` with `hub.mode`, `hub.verify_token`, `hub.challenge` |
| Event authenticity | verify `X-Hub-Signature-256` = HMAC-SHA256(raw body, APP_SECRET), timing-safe compare |
| Public comment reply | `POST /{comment_id}/replies` `{message}` |
| Private reply to comment | `POST /{ig_user_id}/messages` `{recipient:{comment_id}, message}` |
| Normal DM (inside 24 h) | `POST /{ig_user_id}/messages` `{recipient:{id: IGSID}, message}` |
| Follow check | `GET /{IGSID}?fields=name,username,follower_count,is_user_follow_business` |

Button message shape: `message.attachment.type = "template"`, `payload.template_type = "button"`,
one `postback` button whose `payload` encodes `ACTION:rule_id:nonce`.

**Confirm before implementing** (cite the doc URL in a code comment next to each client method):
exact path shape for private replies, whether `graph.instagram.com` or `graph.facebook.com` applies
to the chosen login path, the current API version, and the postback webhook field name. If a doc
contradicts this spec, **follow the doc** and note the difference in `docs/API_NOTES.md`.

### Hard platform constraints to encode
- **One** private reply per comment, within **7 days** of the comment.
- Outside a 24-hour window, only the private reply (or a tag/OTN) is permitted — a normal DM will
  fail. Detect window expiry and fail gracefully with a logged reason; never retry blindly.
- Private replies: ~750 calls/hour/account. Respect it with a token-bucket limiter, and back off on
  error codes 4, 17, 32, 613 (rate limit) and 10, 200 (permission).
- Never reply to the operator's own comments, or to a comment the service already handled.

## 3. Data model (Postgres)

- `rules` — id, name, enabled, scope (`global` | `post`), ig_media_id (nullable), match_type
  (`exact` | `contains` | `regex` | `any`), keywords[], case_insensitive, public_reply_variants[],
  dm_prompt_text, button_label, gate_message, resource_payload (jsonb: text + url + optional
  follow-up), require_follow (bool), priority, created_at/updated_at.
- `contacts` — igsid (pk), username, last_seen_at, follows_cached (bool), follows_checked_at.
- `events` — provider_event_id (unique: comment id or message mid) — **dedupe key**, type, raw jsonb,
  received_at, processed_at, status. Meta retries webhooks; this table makes processing exactly-once.
- `conversations` — id, igsid, rule_id, state, attempts, last_action_at, delivered_at, comment_id.
- `outbox` — id, conversation_id, kind, request jsonb, status, attempts, next_attempt_at, last_error.
  All outbound calls go through here: enqueue → worker sends → retry with exponential backoff and
  jitter, max 5 attempts, then `FAILED` with the error recorded.
- `audit_log` — append-only record of every inbound event and outbound call (ids + status, **never**
  access tokens).

Migrations as plain numbered `.sql` files, applied by a small runner on boot (idempotent).

## 4. Service shape

Single Node 20 + TypeScript service, Fastify:

- `GET /webhook` verify, `POST /webhook` receive — **responds 200 within ~1 s**, writes the event and
  returns; all processing happens in the worker. Never let Meta's delivery wait on our work.
- Worker loop (in-process, interval-driven): claims unprocessed events (`FOR UPDATE SKIP LOCKED`),
  runs the state machine, enqueues outbox items; a second loop drains the outbox.
- `GET /healthz` — liveness + DB check (Render health check).
- Admin API + a single minimal HTML dashboard at `/admin` (server-rendered, no build step):
  list/create/edit/toggle rules, view recent conversations and deliveries, retry a failed outbox row,
  and a **dry-run tester** that runs a fake comment through the rule engine without calling Meta.
  Protected by `ADMIN_TOKEN` (constant-time compare); dashboard is read-mostly, writes are POSTs.

Config via env only (`.env.example` documented, never a real secret in git):
`PORT, DATABASE_URL, APP_SECRET, VERIFY_TOKEN, IG_USER_ID, IG_ACCESS_TOKEN, API_VERSION, ADMIN_TOKEN,
LOG_LEVEL, DRY_RUN`.

`DRY_RUN=true` must make the service fully exercisable with **no** Meta calls: outbound requests are
logged and marked sent. This is how the operator tests before going live.

## 5. Reliability and safety requirements

- Idempotent everywhere: replaying the same webhook payload twice must produce no second message.
- Token-bucket rate limiter in front of the Meta client; per-account budget configurable.
- Retries only on 5xx / network / rate-limit errors. Never retry a permission or validation error.
- Structured JSON logs (pino). **Redact** access tokens, signatures and full message bodies at
  info level. No secrets in logs or in the dashboard.
- Graceful shutdown: stop claiming work, finish in-flight, close the pool.
- Per-contact cooldown so one person spamming comments cannot be messaged repeatedly.
- Daily cap per contact and a global hourly cap, both configurable.

## 6. Testing (non-negotiable — the build is not done without this)

1. **Mock Meta API**: a Fastify app implementing the four endpoints above with realistic success and
   error payloads (including rate-limit and consent-required errors). The Meta client's base URL is
   injectable so tests point at it.
2. **Unit tests**: signature verification (valid, tampered, wrong secret, replay), rule matching for
   every match type, button payload encode/decode, state machine transitions, backoff maths.
3. **Integration tests** against the mock + a real Postgres (Docker, or Supabase test schema), run as
   full flows and asserting on DB state and the exact Meta calls made:
   - already-following user → comment → public reply + private reply → tap → **resource delivered,
     exactly one check, no gate message**.
   - non-follower → comment → tap → **gate message**, taps again still not following → gate again
     (attempt 2), follows → taps → **resource delivered**.
   - duplicate webhook delivery → **no duplicate messages**.
   - non-matching comment → **nothing sent**.
   - operator's own comment → **ignored**.
   - rate-limited response → retried with backoff → eventually sent.
   - consent-required error on profile → handled, user re-prompted, not crashed.
   - expired 24 h window → marked failed with reason, not retried forever.
4. **End-to-end simulator**: `npm run simulate` boots the service + mock + Postgres and replays a
   scripted scenario, printing the transcript of what the user would see. This is the demo.
5. CI-able: `npm test` must pass from a clean checkout with one command, no network access to Meta.

## 7. Documentation to produce

- `README.md` — what it is, the flow, architecture diagram (ASCII), local run, test run.
- `docs/SETUP.md` — step by step: convert to a Professional account, create the Meta app, add the
  Instagram product, permissions needed, generate a long-lived token and **how to refresh it**,
  configure the webhook URL and verify token, subscribe to `comments` + `messages` +
  `messaging_postbacks`, deploy to Render, create the Supabase DB, set env vars, go live. Written for
  someone doing it for the first time, with the gotchas called out.
- `docs/API_NOTES.md` — every Meta endpoint used, its doc URL, and anything that differed from this
  spec.
- `docs/OPERATIONS.md` — token expiry and rotation, what to do when messages stop sending, reading
  the logs, rate limits, and the **App Review** situation: which permissions need Advanced Access to
  message people who are not testers on the app, and what to submit.

## 8. Non-goals / out of scope

Multi-account or multi-tenant. Paid features. Follower scraping or follower lists. Any attempt to
detect follow status without the official field. Mass DMing people who did not interact. Buying or
automating engagement. Anything that logs into Instagram as a user rather than using the API.
