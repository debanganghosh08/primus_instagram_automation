# Operations

Running the thing once it is live. Four sections, in the order you will need
them:

1. [Token expiry and rotation](#1-token-expiry-and-rotation)
2. [When messages stop sending](#2-when-messages-stop-sending)
3. [Reading the logs](#3-reading-the-logs)
4. [Rate limits and caps](#4-rate-limits-and-caps)
5. [The App Review situation](#5-the-app-review-situation)
6. [Routine checks](#6-routine-checks)
7. [Backups and data deletion](#7-backups-and-data-deletion)

---

## 1. Token expiry and rotation

**The single most likely way this service breaks is an expired access token.**

A long-lived Instagram User access token lasts **60 days**. When it dies, every
outbound call fails with error `190`, the outbox fills with `failed` rows, and
people who tapped your button get nothing.

### The calendar reminder

Set a **repeating reminder every 45 days**. Not 59 — you want slack.

### How to refresh

Any time the token is at least 24 hours old and not yet expired:

```powershell
$t = "<your current IG_ACCESS_TOKEN>"
Invoke-RestMethod "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=$t"
```

```bash
curl -s "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=$IG_ACCESS_TOKEN"
```

The response:

```json
{ "access_token": "IGQV...", "token_type": "bearer", "expires_in": 5183944 }
```

`expires_in` is seconds (~60 days). Put the new `access_token` into
`IG_ACCESS_TOKEN` and restart:

- **Render:** Environment → edit `IG_ACCESS_TOKEN` → Save. It redeploys.
- **Docker Compose:** edit `.env`, then `docker compose up -d app`.

The old token keeps working for a while, so there is no downtime.

Reference: <https://developers.facebook.com/documentation/instagram-platform/reference/refresh_access_token>

### How to check how long you have left

```powershell
$t = "<token>"
Invoke-RestMethod "https://graph.instagram.com/v26.0/me?fields=user_id,username&access_token=$t"
```

A `200` means the token is alive. A `190` means it is not. There is no documented
"days remaining" field on this token type, which is exactly why the calendar
reminder matters.

### Why the service does not refresh automatically

It would have to write a new secret into its own environment — on Render that
means calling the Render API with a deploy key, which is a second long-lived
credential to manage and a worse failure mode (a bad write locks you out). A
45-day reminder and a two-minute manual rotation is the safer trade.

### If the token is already dead

1. Refresh if you can (the call fails if it has fully expired).
2. Otherwise generate a fresh one: Meta App Dashboard → **Instagram → API setup
   with Instagram login → Generate token**.
3. Update the environment variable and restart.
4. Go to `/admin` → **Outbox**, and press **Retry** on the failed rows. The
   conversations resume from where they were.

Retry is safe: the dedupe key means a retried row can only ever send the one
message it was always going to send.

### If the App Secret leaks

**App settings → Basic → App secret → Reset.** Update `APP_SECRET` and restart.
Between the reset and the restart, incoming webhooks fail signature verification
and are rejected with `403` — Meta retries for a while, so be quick.

## 2. When messages stop sending

Work down this list. Most of it is on the dashboard.

### Step 1 — is the service alive?

```powershell
Invoke-RestMethod https://your-host/healthz
```

```json
{ "status": "ok", "repository": "postgres", "dryRun": false, "apiVersion": "v26.0" }
```

- `503` → the database is unreachable. Check `DATABASE_URL`, `DATABASE_SSL`, and
  on Supabase whether you are over the connection limit (use the pooler, port
  6543).
- No response → the host is down or asleep. A sleeping service misses webhooks;
  do not run this on a free plan that sleeps.
- `"dryRun": true` → **that is your answer.** Nothing is being sent by design.

### Step 2 — are webhooks arriving?

`/admin` → **Audit log**. You are looking for `webhook.comment` entries.

- **Nothing at all** → the notifications are not reaching you:
  - the callback URL in the Meta dashboard no longer matches your host;
  - the subscription to `comments` / `messages` / `messaging_postbacks` was
    dropped;
  - the account went private, or stopped being a professional account;
  - Meta is having an incident (<https://metastatus.com>).
- **`webhook.rejected` with `mismatch`** → `APP_SECRET` is wrong, or something
  between Meta and the service is altering the request body. A proxy that
  re-serialises JSON will break the signature.
- **`webhook.rejected` with `missing_header`** → whatever is calling you is not
  Meta.

### Step 3 — is the rule matching?

`/admin` → **Dry-run tester**. Paste the exact comment text.

- "no rule matched" → the keyword, the match type, or the enabled flag.
  `contains` matches whole words: "guide" does not match "guidelines".
- Post-scoped rule → the media id must be exactly right. A global rule is
  easier.
- Also check the rule is **enabled**. New rules are created disabled on purpose.

Look for `event.comment.skipped` in the audit log; the status column names the
reason (`no_rule_matched`, `operator_own_comment`, `rule_disabled`).

### Step 4 — what does the outbox say?

`/admin` → **Outbox**, and read the **Last error** column.

| Last error contains | Meaning | What to do |
|---|---|---|
| `permission ... code=200` | your app is not approved and the recipient is not a tester | App Review (section 5) — or add them as a tester |
| `code=190` | the access token is dead | rotate it (section 1) |
| `window_expired` / `subcode=2018278` | more than 24 h since the person's own last action | nothing. Correct behaviour. The conversation is `FAILED` with that reason |
| `messaging window expired` | the service detected it locally, before calling Meta | nothing. Same thing, caught earlier |
| `private reply window expired` | the comment is older than 7 days | nothing. Meta's limit |
| `consent_required` | they have not tapped anything yet | nothing. The service re-prompts automatically |
| `rate_limit` | Meta is throttling | nothing. It retries with backoff. If it is constant, lower `RATE_LIMIT_PER_HOUR` |
| `hourly cap` / `cooldown` / `daily cap` | **our own** limits, not Meta's | raise the relevant variable if it is genuinely too tight |
| `code=100 ... parameter message is required` | a rule has an empty text field | fix the rule |
| `internal: ...` | a bug. Capture the row and the logs |

Rows that are `queued` with a `Last error` are **deferred**, not broken: they are
waiting out a cap or a backoff and will go on their own.

### Step 5 — is anything stuck?

- Many rows `sending` and never moving → the process was killed mid-send. They
  are claimed but unfinished. Restart the service; if they do not clear, set
  them back to `queued` in the database:

  ```sql
  update outbox set status = 'queued', next_attempt_at = now()
  where status = 'sending' and created_at < now() - interval '10 minutes';
  ```

- Many events stuck `processing` → same cause:

  ```sql
  update events set status = 'pending' where status = 'processing';
  ```

  Both are safe. The dedupe keys mean reprocessing cannot send anything twice.

### Step 6 — the nuclear option

Set `DRY_RUN=true` and restart. The service keeps running the whole state
machine and sends nothing, so you can watch behaviour without affecting anyone
while you work out what is wrong.

## 3. Reading the logs

Structured JSON, one object per line, through pino.

- **Render:** the Logs tab, or `render logs -r <service>`.
- **Docker:** `docker compose logs -f app`.

Pretty-print them locally without installing anything:

```powershell
docker compose logs --no-log-prefix app | node -e "require('readline').createInterface({input:process.stdin}).on('line',l=>{try{const o=JSON.parse(l);console.log(o.time,o.level,o.msg,JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k])=>!['time','level','msg','pid','hostname','service'].includes(k)))))}catch{console.log(l)}})"
```

### Lines worth knowing

| Message | Meaning |
|---|---|
| `comment-to-dm starting` | boot. Check `dryRun`, `repository`, `apiVersion` here |
| `migrations up to date` | schema applied |
| `workers started` | the loops are running |
| `webhook verification accepted` | Meta's handshake succeeded |
| `webhook signature rejected` | something unsigned or forged hit `/webhook` |
| `duplicate webhook delivery ignored` | **normal.** Meta redelivers; this is the de-duplication working |
| `NEW->PROMPTED` etc. | a state transition, with its reason as the message |
| `sent` | one outbound call succeeded (`dryRun` tells you whether it was real) |
| `outbox row already existed; not sending twice` | **normal and good.** The last line of defence fired |
| `retrying after backoff` | a rate limit or 5xx; `retryInMs` says when |
| `messaging window expired; not retrying` | correct behaviour, not an error |
| `an applied migration file has changed on disk` | someone edited a migration that was already applied. Add a new numbered file instead |
| `shutting down` / `shutdown complete` | graceful stop; in-flight work finished |

### What is deliberately not in the logs

Access tokens, the app secret, the admin token, the verify token, signatures, and
full message bodies. Redaction is configured in `src/logger.ts`, and the audit
log stores ids and statuses only. If you ever see a secret in a log line, that
is a bug worth fixing immediately.

Set `LOG_LEVEL=debug` for more detail. Put it back to `info` afterwards.

## 4. Rate limits and caps

Two separate things, and it is worth keeping them straight.

### Meta's limits (you cannot change these)

| Limit | Value |
|---|---|
| Private replies | ~**750** calls/hour/account |
| Business Use Case limit | per app + app-user, rolling 24 h, `4800 × impressions` |
| Private reply per comment | exactly **1** |
| Private reply age | within **7 days** of the comment |
| Standard messaging window | **24 hours** from the person's own action |

Source: <https://developers.facebook.com/docs/instagram-platform/overview>

### Our limits (you can change these)

| Variable | Default | What it protects |
|---|---|---|
| `RATE_LIMIT_PER_HOUR` | 600 | staying clear of Meta's 750 |
| `RATE_LIMIT_BURST` | 20 | how fast we are willing to spend it |
| `MAX_MESSAGES_PER_HOUR` | 400 | the account looking automated |
| `MAX_MESSAGES_PER_CONTACT_PER_DAY` | 6 | one person being pestered |
| `CONTACT_COOLDOWN_MINUTES` | 10 | one person triggering repeated first DMs |
| `MAX_ATTEMPTS` | 5 | both retry count and follow checks per person |

Two deliberate exceptions, so the service never fails to deliver something it
promised:

- **The resource is exempt** from the per-contact cooldown and the daily cap. If
  we said "tap and I'll send it", swallowing it because of our own cap is worse
  than one extra message.
- **Replies to a button tap are never cooled down.** The cooldown applies only
  to the *unsolicited* first DM (the one a comment triggers). Making someone
  wait ten minutes after they pressed a button would just look broken.

What happens at a limit:

- rate limiter empty → the row is **deferred** (no attempt burned) and retried
- hourly cap → **deferred**
- per-contact cooldown → **deferred** (first prompts only)
- per-contact daily cap → **dropped** with the reason recorded (prompts and
  gates only)
- the send window closed → **dropped**, never retried

The dashboard shows remaining rate-limit tokens at the top.

### If Meta starts throttling you

Lower `RATE_LIMIT_PER_HOUR` (try 300) and `RATE_LIMIT_BURST` (try 10). If you
ever see error `613` subcode `2018338` ("behaviour that may be considered
bothersome or abusive"), that is a serious warning: reduce volume deliberately
rather than waiting for the retry. Consider disabling the busiest rule for a
day.

## 5. The App Review situation

### Where you stand on day one

A new Meta app has **Standard Access** to its permissions. That means:

> You can only send messages to Instagram users who are **admins, developers or
> testers on your app.**

Everyone else fails with:

```
(#200) Cannot message users who are not admins, developers or testers of the app
```

The public comment reply generally still works. The DM does not. To your
audience that reads as: you promised something and nothing came.

**So: either keep the rule disabled, or run with `DRY_RUN=true`, until you have
Advanced Access.** The alternative is publicly promising things you cannot
deliver.

### Which permissions need Advanced Access

| Permission | Standard Access gives you | Advanced Access gives you |
|---|---|---|
| `instagram_business_basic` | your own / managed accounts | reading any interacting user's profile — **needed for `is_user_follow_business` on your audience** |
| `instagram_business_manage_comments` | accounts you own or manage | `comments` webhooks and replies for your audience |
| `instagram_business_manage_messages` | testers only | messaging anyone who interacts with you — **the one that actually gates this product** |

Request all three: App Dashboard → **App Review → Permissions and features** →
**Request advanced access** on each.

### What you submit

1. **Business verification.** Legal business name, address, and a verifying
   document (business registration, utility bill, or bank statement in the
   business name). This is usually the long pole — **start it first**, because
   the permission requests cannot complete without it.
2. **A screencast** of the real flow, uncut: a comment appears, the public reply
   appears, the DM with the button arrives, the tap, the resource arrives. Record
   it with a tester account once everything works.
3. **Reproduction steps** for the reviewer: which account, which post, which
   keyword, what to expect.
4. **A justification per permission**, written in terms of what the *user* gets.
   For example: *"People comment a keyword on my post to request a free
   resource. `instagram_business_manage_comments` lets the app see that comment
   and reply to it publicly. `instagram_business_manage_messages` lets the app
   send the person the resource they asked for.
   `instagram_business_basic` lets the app read whether they follow the account,
   which is the condition of the offer and is stated in the first message."*
5. **A working privacy policy URL.** It must name what you store (Instagram-scoped
   id, username, comment text, conversation state), why, how long for, and how
   someone requests deletion.
6. **App icon, display name, category** completed on the Basic settings page.

### Expectations

- Days to weeks. Plan a launch around it, do not hope.
- A first rejection is normal, usually for a screencast that does not clearly
  show each permission in use, or a privacy policy that does not mention the
  data you actually collect. Fix and resubmit.
- Rejections are not permanent. Address the stated reason specifically.

### Meanwhile: add testers

App Dashboard → **App roles → Roles → Add people → Tester**. They accept at
<https://developers.facebook.com/settings/developer/requests/>; from the
Instagram side, under **Settings → Website permissions → Apps and websites →
Tester invites**. Everything works fully for those accounts, which is enough to
record the screencast and to be confident before you launch.

## 6. Routine checks

**Weekly (two minutes)**

1. `/healthz` → `status: ok`.
2. `/admin` → **Outbox**: any `failed` rows? Read the error, retry if it was
   transient.
3. `/admin` → **Conversations**: anyone stuck in `GATED` who should have been
   delivered to?

**Every 45 days**

Rotate `IG_ACCESS_TOKEN` (section 1).

**When you change a rule**

Run the dry-run tester first. Enabling a rule with an empty text field produces
error 100 on every send.

**When Meta deprecates an API version**

`API_VERSION` is pinned (`v26.0`). Versions are supported for roughly two years.
When you bump it, re-read `docs/API_NOTES.md` against the live docs, run
`npm test`, and deploy with `DRY_RUN=true` for one cycle before going live.

## 7. Backups and data deletion

### What is stored

| Table | Contents |
|---|---|
| `contacts` | Instagram-scoped id, username, last seen, cached follow answer |
| `events` | every webhook notification, including the comment text, in `raw` |
| `conversations` | state, attempt count, delivery time |
| `outbox` | every outbound call and the message text in `request` |
| `audit_log` | ids and statuses only, no message bodies |
| `rules` | your own configuration |

No access token is ever stored in the database.

### Backups

Supabase takes daily backups on paid plans. On the free plan, take your own:

```powershell
pg_dump $env:DATABASE_URL --no-owner --format=custom --file backup.dump
```

The only thing genuinely painful to lose is `rules`; everything else is history.

### Deleting someone's data

If someone asks you to delete their data:

```sql
-- replace with their Instagram-scoped id
delete from contacts where igsid = '<IGSID>';          -- cascades to conversations
delete from events   where igsid = '<IGSID>';
delete from outbox   where igsid = '<IGSID>';
delete from audit_log where igsid = '<IGSID>';
```

`contacts` cascades to `conversations` and their transitions. `events`, `outbox`
and `audit_log` are deliberately not cascaded (they are the record of what
happened), so delete them explicitly as above.

### Housekeeping

Nothing expires on its own. A sensible monthly trim, if the tables grow:

```sql
delete from events    where received_at < now() - interval '90 days';
delete from audit_log where at          < now() - interval '90 days';
delete from outbox    where status in ('sent','failed','cancelled')
                        and created_at  < now() - interval '90 days';
```

Do **not** delete recent `events` rows: they are the de-duplication table, and
removing a row lets Meta's redelivery of that same notification be processed as
new. Ninety days is far beyond any redelivery window, so the query above is safe.
