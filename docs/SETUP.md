# Setup, start to finish

Written for someone who has never made a Meta app. Follow it in order; each step
says what to click, what to copy, and where it goes.

Set aside about an hour for steps 1–8. **App Review (step 11) is the one that
takes real time** — days to weeks — and until it is done the service can only
message people you have added as testers. Read step 11 before you plan a launch.

**Contents**

1. [Make the account a Professional account](#1-make-the-account-a-professional-account)
2. [Create a Meta app](#2-create-a-meta-app)
3. [Add the Instagram product](#3-add-the-instagram-product)
4. [Permissions you need](#4-permissions-you-need)
5. [Get your App Secret](#5-get-your-app-secret)
6. [Get an access token](#6-get-an-access-token)
7. [Find your Instagram user id](#7-find-your-instagram-user-id)
8. [Create the database](#8-create-the-database)
9. [Deploy](#9-deploy)
10. [Configure the webhook](#10-configure-the-webhook)
11. [App Review — read this before you launch](#11-app-review--read-this-before-you-launch)
12. [Test it end to end](#12-test-it-end-to-end)
13. [Go live](#13-go-live)
14. [Pointing Meta at a laptop](#pointing-meta-at-a-laptop)
15. [When something does not work](#when-something-does-not-work)

---

## 1. Make the account a Professional account

In the Instagram app: **Settings and privacy → Account type and tools → Switch
to professional account**. Pick **Creator** or **Business** — either works.

Then, still in Instagram settings, make sure the account is **public**. Meta
will not send `comments` webhooks for a private account.

**Gotcha:** if the account is connected to a Facebook Page you no longer use,
that is fine — this setup uses *Business Login for Instagram*, which does not
need a Page.

## 2. Create a Meta app

1. Go to <https://developers.facebook.com/apps>. Log in with the Facebook
   account you want to own the app. (You do not need a Facebook Page.)
2. If you have never done this, Meta will ask you to register as a developer and
   verify a phone number or email. Do that first.
3. **Create app**.
4. **Use case:** choose **Other** → **Next**.
5. **App type:** choose **Business** → **Next**.
6. Name it something you will recognise (`primus-comment-dm`). The name is
   internal unless you submit for review. Add a contact email.
7. **Create app**, and re-enter your password when asked.

You are now in the App Dashboard. Note the **App ID** at the top — you will see
it everywhere.

## 3. Add the Instagram product

1. In the left sidebar: **Add product** (or the product list on the dashboard).
2. Find **Instagram** → **Set up**.
3. Open **Instagram → API setup with Instagram login**.

   **This is the right option.** The other one, "API setup with Facebook login",
   uses a different host (`graph.facebook.com`) and different permission names.
   This service is built for Instagram login. If you pick the wrong one, every
   call will fail with a permissions error.

4. Under **1. Generate access tokens**, click **Add account** and connect your
   Instagram professional account. Log in as that account and approve.

Leave this page open — steps 6 and 7 come back to it.

## 4. Permissions you need

Under **Instagram → API setup with Instagram login → 2. Configure webhooks** and
in **App Review → Permissions and features**, these are the three that matter:

| Permission | Why this service needs it |
|---|---|
| `instagram_business_basic` | read your account, and read a commenter's profile |
| `instagram_business_manage_comments` | receive `comments` webhooks and post the public reply |
| `instagram_business_manage_messages` | receive `messages` / `messaging_postbacks`, send the private reply and the DMs |

You get **Standard Access** to these immediately, which is enough to test
against accounts you own or have added as testers. **Advanced Access** is what
you need to reach everybody else — step 11.

## 5. Get your App Secret

**App settings → Basic → App secret → Show.** Copy it.

```
APP_SECRET=<the value you just copied>
```

This is used for one thing only: verifying that an incoming webhook really came
from Meta (the `X-Hub-Signature-256` header). It is never sent anywhere.

**Treat it like a password.** If it leaks, anyone can forge webhooks into your
service. Rotate it on the same page if that happens.

## 6. Get an access token

Back on **Instagram → API setup with Instagram login → 1. Generate access
tokens**:

1. Click **Generate token** next to your connected account.
2. Log in / approve.
3. Copy the token. It is long. Copy all of it.

```
IG_ACCESS_TOKEN=<the token>
```

### How long it lasts, and how to refresh it

The token Meta hands you here is a **long-lived Instagram User access token**:
**60 days**.

Refresh it by calling, any time after it is 24 hours old and before it expires:

```
GET https://graph.instagram.com/refresh_access_token
    ?grant_type=ig_refresh_token
    &access_token=<YOUR_CURRENT_LONG_LIVED_TOKEN>
```

PowerShell:

```powershell
$t = "<current token>"
(Invoke-RestMethod "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=$t")
```

The response gives you a **new** token, valid 60 days from the refresh, plus
`expires_in` in seconds. Put the new value into `IG_ACCESS_TOKEN` and restart
the service.

**Do this now:** put a repeating reminder in your calendar for **every 45 days**,
titled something like "refresh comment-to-DM Instagram token". If the token
expires, every send fails with error 190 and people who tapped your button get
nothing. `docs/OPERATIONS.md` has the full procedure and what the failure looks
like.

**Gotcha:** generating a new token from the dashboard does *not* invalidate the
old one immediately, so you can rotate without downtime.

## 7. Find your Instagram user id

On the same **API setup with Instagram login** page, the connected account shows
its **Instagram-scoped ID** / user id. Copy it.

If you cannot find it, ask the API with the token from step 6:

```powershell
$t = "<your token>"
Invoke-RestMethod "https://graph.instagram.com/v26.0/me?fields=user_id,username&access_token=$t"
```

Use the `user_id` value:

```
IG_USER_ID=<the number>
```

**Gotcha:** this is not your `@username`, and it is not your Facebook Page id.
It is a long number.

## 8. Create the database

Postgres 13 or newer. Supabase has a free tier and is what this is set up for.

1. <https://supabase.com> → **New project**. Pick a region near your host.
2. Save the database password it shows you; you cannot see it again.
3. **Project Settings → Database → Connection string → URI.** Copy it.
4. Replace `[YOUR-PASSWORD]` in the string with the password from step 2.

```
DATABASE_URL=postgres://postgres:...@...supabase.com:5432/postgres
DATABASE_SSL=true
REPOSITORY=postgres
```

**Gotchas:**

- `DATABASE_SSL=true` for Supabase (and any hosted Postgres). `false` only for
  the local docker-compose database.
- On a small Supabase plan, use the **connection pooler** host (port **6543**)
  rather than the direct one (5432). The direct connection limit is low and the
  service keeps a pool open.
- You do not need to create any tables. The service applies
  `migrations/*.sql` itself on boot, and it is safe to restart.

## 9. Deploy

### Render (there is a blueprint in the repo)

1. Push this repo to GitHub.
2. <https://dashboard.render.com> → **New → Blueprint** → pick the repo. Render
   reads `render.yaml`.
3. It will prompt for the values marked as secrets:
   `DATABASE_URL`, `APP_SECRET`, `VERIFY_TOKEN`, `IG_USER_ID`,
   `IG_ACCESS_TOKEN`. (`ADMIN_TOKEN` is generated for you — read it from the
   Environment tab afterwards.)
4. For `VERIFY_TOKEN`, invent a random string now and keep it; you type the same
   one into Meta in step 10:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

5. Deploy. `DRY_RUN` is `true` in the blueprint — leave it there for now.
6. Note your URL: `https://comment-to-dm-xxxx.onrender.com`.

**Gotcha:** do **not** use Render's free plan. Free services sleep when idle,
and a sleeping service misses webhooks — Meta will not redeliver them forever.
The blueprint uses `starter`.

Check it is up:

```powershell
Invoke-RestMethod https://your-host.onrender.com/healthz
```

You want `status: ok` and `repository: postgres`.

### Anywhere else

`Dockerfile` and `docker-compose.yml` are in the repo, so Fly, Railway or a VPS
all work. Requirements: a long-running process (not a lambda — the workers poll),
a public HTTPS URL, and the environment variables from `.env.example`. Run the
container with `--init` so `SIGTERM` reaches the process and shutdown is clean.

## 10. Configure the webhook

Back in the Meta App Dashboard: **Instagram → API setup with Instagram login →
2. Configure webhooks** (or **Webhooks** in the sidebar).

1. **Callback URL:** `https://your-host/webhook`
2. **Verify token:** the random string from step 9.4 — it must match
   `VERIFY_TOKEN` exactly.
3. **Verify and save.**

   Meta immediately sends `GET /webhook?hub.mode=subscribe&...` and expects the
   challenge echoed back. If it fails:
   - the service is not deployed, or is asleep;
   - the URL is wrong (it must end in `/webhook`);
   - `VERIFY_TOKEN` does not match (watch for a trailing space on paste);
   - the URL is not HTTPS, or has a self-signed certificate.

4. **Subscribe to these three fields**, and only these three:

   - `comments`
   - `messages`
   - `messaging_postbacks`

**Gotchas:**

- Subscribed fields are set **per app**, not per account.
- `comments` requires **Advanced Access** for accounts you do not own or
  manage — fine for your own account under Standard Access.
- Comment notifications only arrive for a **public** professional account that
  owns the media.
- If you ever change your host, update the callback URL here too. There is no
  warning when it silently stops working.

## 11. App Review — read this before you launch

**This is the step that surprises people, so here it is plainly.**

A new Meta app has **Standard Access** to its permissions. With Standard Access,
you can only message Instagram users who are **admins, developers or testers on
your app**. Everyone else fails with:

```
(#200) Cannot message users who are not admins, developers or testers of the app
```

The public reply under the comment usually still works. The DM does not. From
your audience's point of view: you promised them something and nothing arrived.

### What to do while you wait

You can test properly today by adding a second Instagram account as a tester:

1. App Dashboard → **App roles → Roles → Add people**.
2. Add the person (or your own second account) as a **Tester**.
3. They accept the invitation at
   <https://developers.facebook.com/settings/developer/requests/>.

Instagram Tester invitations are accepted in the Instagram app under
**Settings → Website permissions → Apps and websites → Tester invites**.

Comment from that account and the whole flow works end to end.

### What you have to submit for Advanced Access

App Dashboard → **App Review → Permissions and features**, and request Advanced
Access for:

- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

For each one Meta asks for:

1. **Business verification.** Meta verifies the business behind the app:
   legal name, address, and a document (registration, utility bill, bank
   statement). As an individual creator this is the slowest part — expect to
   use whatever business entity or sole-proprietor registration you have. Start
   this first; the rest cannot complete without it.
2. **A screencast** showing the real flow: someone comments, the public reply
   appears, the DM with the button arrives, they tap it, they get the resource.
   Record it with your tester account once everything works (step 12). Show the
   whole journey without cuts.
3. **Written step-by-step instructions** for the reviewer to reproduce it, naming
   the account, the post and the keyword.
4. **A plain explanation of why you need each permission**, in terms of what the
   user gets. "Users comment a keyword on my post to request a free resource,
   and the app replies to that comment and sends them the resource they asked
   for."
5. **A privacy policy URL** that actually works, saying what data you store
   (Instagram-scoped id, username, the comment, the conversation state) and how
   someone can ask you to delete it.
6. **App icon, display name and category** filled in.

Expect a few days to a few weeks, and expect at least one rejection — usually
for a screencast that does not clearly show the permission being used, or a
privacy policy that does not mention the data you actually collect. Re-record
and resubmit; it is not a judgement on the app.

See also `docs/OPERATIONS.md`, "The App Review situation".

## 12. Test it end to end

With `DRY_RUN=true` still set:

1. Open `https://your-host/admin` and paste your `ADMIN_TOKEN`.
2. There is one example rule, **disabled**. Expand **edit texts**, change them to
   what you actually want to say, point **Resource URL** at your real link, and
   **Save**.
3. Use the **dry-run tester**: type the comment you expect ("send me the
   guide"). It shows the rule it matched and every message that would be sent.
   It writes nothing and calls nothing.
4. **Enable** the rule.
5. From your tester account (step 11), comment the keyword on one of your posts.
6. Watch the dashboard:
   - **Audit log** shows `webhook.comment` then `comment.matched`.
   - **Conversations** shows the person in `PROMPTED`.
   - **Outbox** shows `public_reply` and `private_reply_prompt` as `sent`.

   Because `DRY_RUN=true`, nothing actually reached Instagram. That is the point:
   you have just proved the webhook, the signature, the rule and the state
   machine all work, without touching anyone.

If the audit log stays empty, the webhook is not arriving — go back to step 10.

## 13. Go live

1. Set `DRY_RUN=false` (Render: Environment → edit → the service restarts).
2. Keep **one** rule enabled.
3. Comment from your tester account again. This time you should actually get the
   public reply and the DM.
4. Tap the button. If that account follows you, the resource arrives. Unfollow,
   tap again, and you should get the gate instead.
5. Watch the **Outbox** for anything `failed`, and read the **Last error**
   column. `docs/OPERATIONS.md` explains each one.

Sensible defaults are already set: 600 API calls/hour, 400 messages/hour, 6
messages per person per day, and a 10-minute cooldown before the same person can
get another unsolicited first DM. Replies to someone's own button tap are never
delayed.

## Pointing Meta at a laptop

Meta needs a public HTTPS URL, so a webhook cannot reach `localhost` directly.
To develop against real notifications, put a tunnel in front of it — Cloudflare
Tunnel (`cloudflared`) and `ngrok` both work — and use the tunnel's HTTPS URL as
the callback URL.

Two things to know:

- The tunnel URL changes every restart on free plans, and you have to update the
  callback URL in the Meta dashboard each time.
- Only one callback URL can be registered per app, so a tunnel pointing at your
  laptop takes notifications **away** from your deployed service. Use a separate
  Meta app for development if you are running both.

The simulator (`npm run simulate`) and `npm test` need none of this, which is why
most development does not need a tunnel at all.

## When something does not work

| Symptom | Likely cause |
|---|---|
| "The URL couldn't be validated" when saving the webhook | service not deployed or asleep; URL missing `/webhook`; `VERIFY_TOKEN` mismatch (check for a trailing space); not HTTPS |
| Webhook saves, but the audit log stays empty | not subscribed to the fields; account is private; account is not a professional account; you are commenting on a *different* account's post |
| `webhook.rejected` with `mismatch` in the audit log | `APP_SECRET` is wrong, or a proxy is rewriting the request body |
| Public reply works, DM does not | App Review: the commenter is not a tester and you only have Standard Access (error 200) |
| `(#190)` on every send | the access token expired or was invalidated — refresh it (step 6) |
| `(#10) ... outside of allowed window` | more than 24 hours passed since the person's last action; nothing to fix, the conversation is marked `FAILED` with that reason |
| `User consent is required to access user profile` | the person has not tapped anything yet. Expected on a first attempt; the service re-prompts automatically |
| Rule never matches | `match type: contains` matches whole words — "guide" does not match "guidelines". Try the dry-run tester |
| Post-scoped rule never matches | the media id is wrong. A global rule is easier to start with |
| Nothing sends and the outbox fills with `queued` | a cap or the rate limiter is deferring; read the **Last error** column |
| `/healthz` returns 503 | the database is unreachable — check `DATABASE_URL` and `DATABASE_SSL`, and the pooler port on Supabase |

Anything else: `docs/OPERATIONS.md` → "When messages stop sending".
