# Meta API notes

Every endpoint this service calls, the documentation page it was built from, and
anything that differed from the project specification.

**Verified against the live docs on 2026-10-22.** If something below stops
matching reality, the docs win — change the code and update this file.

Setup assumed throughout: **Instagram API with Instagram Login** (Business Login
for Instagram). That choice decides the host and the credential, so it is the
first thing to check if calls start failing.

- Host: `https://graph.instagram.com`
- Version: `v26.0` (the current version at build time), pinned in `API_VERSION`
- Credential: an **Instagram User access token**, sent as `Authorization: Bearer <token>`
- Permissions: `instagram_business_basic`, `instagram_business_manage_comments`,
  `instagram_business_manage_messages`

---

## 1. Webhook verification — `GET /webhook`

**Doc:** <https://developers.facebook.com/documentation/instagram-platform/webhooks/setup>

Meta sends `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`. If the
token matches ours we reply `200` with the challenge value as plain text;
otherwise `403`.

- The comparison is constant-time (`secretEquals` in `src/webhook/signature.ts`).
- The response body is the bare challenge, not JSON. Meta will not accept a
  JSON-wrapped challenge.

**Matches the spec.**

## 2. Event authenticity — `X-Hub-Signature-256`

**Docs:**
<https://developers.facebook.com/documentation/instagram-platform/webhooks/setup>,
<https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads>

Header value is `sha256=<hex>` of HMAC-SHA256 over the **raw request body**,
keyed with the app secret, compared in constant time.

**Difference from the spec:** none in substance, but two details the spec does
not spell out and which are the usual cause of "signature never matches":

1. The hash is over the raw bytes. `JSON.stringify(parsedBody)` produces a
   different byte string (key order, whitespace) and will never match. The
   service keeps the original `Buffer` in a custom content-type parser
   (`src/server.ts`) specifically for this.
2. The setup page says "generate a SHA256 signature" without saying HMAC or
   naming the body encoding. It is HMAC-SHA256 over the raw body; that is
   documented on the Graph API webhooks page linked above, not on the
   Instagram page.

A rejected notification returns `403` with no detail, and the signature itself
is never logged.

## 3. Public comment reply — `POST /{ig_comment_id}/replies`

**Doc:** <https://developers.facebook.com/docs/instagram-platform/comment-moderation>

```
POST https://graph.instagram.com/v26.0/<IG_COMMENT_ID>/replies
Authorization: Bearer <IG_USER_ACCESS_TOKEN>
Content-Type: application/json

{"message": "Sent you a DM ✅"}
```

Permissions: `instagram_business_basic`, `instagram_business_manage_comments`.
Returns `{"id": "<new comment id>"}`.

**Differences from the spec:**

- The spec gives the path only. Confirmed: the host is `graph.instagram.com` for
  Instagram Login, and `message` goes in the **JSON body**. The older
  `IG Comment -> Replies` Graph API reference page shows
  `graph.facebook.com/{ig-comment-id}/replies?message={message}` — a query
  parameter on a different host — because that page documents the *Facebook
  Login* path. Do not follow that page for this setup.
- Limitations the docs add and the spec does not mention: you can only reply to
  **top-level** comments (a reply to a reply is attached to the top-level
  comment instead), you cannot reply to a **hidden** comment, and you cannot
  reply to comments on a **live video** (use a private reply there).
- `comments` webhooks and comment moderation need a **public** professional
  account that owns the media, and the `comments` field requires **Advanced
  Access** for accounts you do not own or manage. See `docs/OPERATIONS.md`.

## 4. Private reply to a comment — `POST /{ig_user_id}/messages`

**Doc:** <https://developers.facebook.com/docs/instagram-platform/private-replies>

```
POST https://graph.instagram.com/v26.0/<IG_USER_ID>/messages
Authorization: Bearer <IG_USER_ACCESS_TOKEN>
Content-Type: application/json

{"recipient": {"comment_id": "<COMMENT_ID>"},
 "message": { ...text or attachment... }}
```

Returns `{"recipient_id": "...", "message_id": "..."}`.

Platform limits, confirmed and encoded in the service:

| Limit | Where it is enforced |
|---|---|
| **One** private reply per comment | `outbox.dedupe_key = private_reply:<comment_id>`, a unique index |
| Within **7 days** of the comment | `PRIVATE_REPLY_MAX_AGE_HOURS=168`, checked in `checkSendWindow()` |
| ~**750** calls/hour/account | `RATE_LIMIT_PER_HOUR=600` token bucket, with headroom |

**Differences from the spec:**

- The spec writes the recipient as `{recipient:{comment_id}}` — confirmed
  exactly right.
- Two limits the docs state that the spec does not: on **Instagram Live**,
  private replies work only while the broadcast is running; and a follow-up
  message is allowed only if the recipient responds, within 24 hours of that
  response. Neither affects this service (it never sends a second private reply
  to the same comment), but they are worth knowing.
- `/me/messages` is accepted in place of `/<IG_USER_ID>/messages`. The service
  uses the explicit id so a misconfigured `IG_USER_ID` fails loudly rather than
  silently acting as whoever the token belongs to.

## 5. Normal DM inside the window — `POST /{ig_user_id}/messages`

**Doc:** <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api>

Same endpoint, different recipient:

```
{"recipient": {"id": "<IGSID>"}, "message": {...}}
```

The window, per the docs: you may send only **after the person has messaged the
account**, and for the duration of the applicable standard messaging window —
**24 hours** for most user actions, up to **7 days** for a first message after a
click-to-Direct ad, and a separate 7-day window for a response tagged for human
agent use.

**Differences from the spec:**

- The spec says "outside a 24-hour window, only the private reply (or a
  tag/OTN) is permitted". Confirmed in substance. This service does **not** use
  message tags or the human-agent tag: it relies entirely on the person's own
  button tap, which opens the window legitimately. That is a deliberate choice,
  not an omission — tags are for human follow-up, not automation.
- The window is measured from the **person's** last action, not from when we
  queued the message. The service therefore stores `window_opened_at` on both
  the conversation and the outbox row and checks it immediately before every
  send. (This column is an addition to the spec's data model; see "Schema
  additions" below.)

## 6. Button template with a postback button

**Docs:**
<https://developers.facebook.com/docs/messenger-platform/send-messages/template/button>,
<https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons>

```json
{
  "attachment": {
    "type": "template",
    "payload": {
      "template_type": "button",
      "text": "Tap below and I'll send it.",
      "buttons": [
        { "type": "postback", "title": "Send me the guide", "payload": "DELIVER:guide:k3Jx" }
      ]
    }
  }
}
```

- `text`: max **640** characters (documented). Enforced in `src/core/render.ts`.
- `buttons`: **1–3**. We send one.
- Button title: the docs give **guidance** ("keep your text under 20
  characters") rather than a hard limit. The service clamps titles to 20.
- Button payload: a developer-defined string. **No published length limit.**
  Flagged uncertainty: the service caps it at 900 characters and refuses longer
  rather than letting Meta truncate it silently. Our payloads are ~25
  characters, so this is a guard, not a constraint.
- A tap produces a `messaging_postbacks` notification carrying the payload
  back — that is the whole mechanism this service depends on.

## 7. Follow check — `GET /{IGSID}`

**Doc:** <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile>

```
GET https://graph.instagram.com/v26.0/<IGSID>
    ?fields=name,username,follower_count,is_user_follow_business
```

Confirmed fields: `name`, `username`, `follower_count`,
`is_user_follow_business`, `is_verified_user`, `profile_pic`.
Permissions: `instagram_business_basic` + `instagram_business_manage_messages`.

**Consent — the single most important detail in this document.**

The profile API only works once the person has **messaged the account, or tapped
an icebreaker, persistent menu item or button**. A comment does **not** grant
consent. Without it the call fails with *"User consent is required to access
user profile."*

This is exactly why the first DM is a button and not the resource: we get one
private reply per comment, and at that moment we are not yet allowed to ask
whether they follow. Their tap grants consent *and* opens the messaging window
in one action.

**Differences from the spec:** none — the spec's field list is right. Two
additions:

- The docs state the error **message text** but not its numeric code. Reported
  in the wild (and by third-party tooling) as **code 230**. Flagged uncertainty:
  `src/meta/errors.ts` therefore matches on the message text *as well as* code
  230, so classification does not depend on an undocumented code.
- `is_user_follow_business` can be **absent** from the response. The service
  treats an absent field as "not following" rather than handing out the resource
  on a guess.
- The profile cannot be read if the person has blocked the account.

## 8. Webhook fields and payload shapes

**Docs:**
<https://developers.facebook.com/documentation/instagram-platform/webhooks/fields>,
<https://developers.facebook.com/documentation/instagram-platform/webhooks/examples>

Fields to subscribe to, with the Instagram-Login permissions they need:

| Field | Permissions |
|---|---|
| `comments` | `instagram_business_basic`, `instagram_business_manage_comments` |
| `messages` | `instagram_business_basic`, `instagram_business_manage_messages` |
| `messaging_postbacks` | `instagram_business_basic`, `instagram_business_manage_messages` |

**Differences from the spec:**

- The spec calls the postback field `messaging_postbacks`. **Confirmed correct.**
- The spec does not mention that **comment notifications come in two different
  shapes** depending on the login path, and this trips people up:
  - *Business Login for Instagram*: `field` and `value` sit **directly on the
    entry**, with **no `changes` array**, and the comment id is `value.id`.
  - *Facebook Login for Business*: the entry carries a **`changes[]`** array and
    the comment id is `value.comment_id` (plus `parent_id`).

  `src/webhook/parse.ts` accepts both, so the service keeps working if the
  account is ever migrated between login paths.
- Messaging events (`messages`, `messaging_postbacks`) always arrive in
  `entry[].messaging[]` and carry **no `field` key**. The postback example has
  no `field` at all — do not route on it.
- Message notifications can carry `is_echo` / `is_self`, which are our own
  outbound messages reflected back. Acting on them would loop; the parser drops
  them.
- Subscribed fields are **per app, not per account**: every connected account
  receives every field the app selected.
- Subscribing is `POST /<IG_ID>/subscribed_apps` with
  `subscribed_fields=comments,messages,messaging_postbacks`.

## 9. Error codes

**Docs:**
<https://developers.facebook.com/docs/messenger-platform/error-codes>,
<https://developers.facebook.com/docs/graph-api/guides/error-handling>

How `src/meta/errors.ts` classifies them, and what that causes:

| Category | Codes / subcodes confirmed in the docs | Behaviour |
|---|---|---|
| `rate_limit` | `4` (*Application request limit reached*), `17`, `32`, `613` + subcode `2534040` (*Calls to this api have exceeded the rate limit*), HTTP 429 | retry with exponential backoff + full jitter |
| `transient` | HTTP 5xx, 408, network/socket failures | retry |
| `window_expired` | code `10` with subcode `2018278`, `2534022` or `2018065` — all three read *"This message is sent outside of allowed window."* | **never** retried; conversation → `FAILED` with the reason recorded |
| `consent_required` | message *"User consent is required to access user profile"*; reported as code `230` | **never** retried; the person is re-prompted for one more tap |
| `permission` | `10` (*Application does not have permission for this action*), `200` + subcodes `2018028`/`2018027` (*Cannot message users who are not admins, developers or testers of the app*), `190` (token), `102`, `230`, `2500`, `3` | **never** retried; a human has to act |
| `invalid` | HTTP 4xx, e.g. `100` (*The parameter message is required*) | **never** retried |

**Differences from the spec:**

- The spec lists `4, 17, 32, 613` as rate limit and `10, 200` as permission.
  Confirmed, with one correction that matters: **code 10 is not always a
  permission error.** Code 10 with subcode 2018278 is the closed messaging
  window, which needs completely different handling. Subcode is checked first.
- The messaging-window error has **three** documented subcodes with identical
  text, not one.
- `code 613 subcode 2018338` ("behaviour that may be considered bothersome or
  abusive") is a warning to slow down hard. It currently classifies as
  `rate_limit`, i.e. it backs off. Flagged: if it ever appears in the logs,
  treat it as a signal to reduce volume deliberately, not just to retry.
- The docs have no entry for a private reply that has already been used on a
  comment, so there is no error code to detect it. The service relies on its own
  unique index instead — the right approach anyway.

## 10. Token lifetime and refresh

**Docs:**
<https://developers.facebook.com/docs/instagram-platform/overview>,
<https://developers.facebook.com/documentation/instagram-platform/reference/refresh_access_token>

- A short-lived Instagram User access token lasts **1 hour**; exchange it for a
  long-lived one.
- A long-lived token lasts **60 days** and can be refreshed.
- Refresh: `GET https://graph.instagram.com/refresh_access_token`
  `?grant_type=ig_refresh_token&access_token=<CURRENT_LONG_LIVED_TOKEN>`
- The token must be **at least 24 hours old** and not yet expired. Requires
  `instagram_business_basic`. The refreshed token is valid 60 days **from the
  refresh**, and `expires_in` reports the remaining seconds.

**Difference from the spec:** the spec asks for "how to refresh it" in SETUP.md
but does not give the mechanism. Documented above and in
`docs/OPERATIONS.md`. The service does **not** refresh the token
automatically — it would have to write a new secret to its own environment,
which is worse than a calendar reminder. See `docs/OPERATIONS.md`.

## 11. Rate limits

**Doc:** <https://developers.facebook.com/docs/instagram-platform/overview>

- Instagram Business Use Case limiting: counted per app + app-user pair over a
  rolling 24-hour window, computed as `4800 × impressions`.
- **Private replies: 750 calls per hour per Instagram professional account**
  (comments on posts and reels). Instagram Live comments: 100 calls/second.

**Matches the spec.** The default `RATE_LIMIT_PER_HOUR=600` keeps a margin.

---

## Schema additions beyond the spec

Two columns the spec's data model does not list. Both exist to prevent a real
failure, and both are documented here so the deviation is on the record.

1. **`outbox.dedupe_key` (unique)** — the spec lists the outbox columns without
   a uniqueness key. Without one, two concurrent workers (or a replayed webhook
   that slipped past the event table) could enqueue the same message twice.
   With it, the second `INSERT ... ON CONFLICT DO NOTHING` collapses into the
   first. This is the last line of defence against messaging someone twice.

2. **`conversations.window_opened_at` and `outbox.window_opened_at`** — the
   24-hour messaging window starts at the person's own action, and an outbox row
   can sit in the queue for a while across retries, deferrals and caps. Timing
   the window from row creation would let a late send fire and earn error
   10/2018278. These columns record when the permission actually started.

Also worth noting, though not a schema change: `conversations.delivered_at` is
set only when Meta **accepts** the resource message, not when the state machine
decides to deliver. A conversation that says `DELIVERED` with a null
`delivered_at` is one where the send is still in flight, and it can still move
to `FAILED`.

## Things deliberately not used

- **Message tags / one-time notifications / human agent tag.** They exist to
  reach someone outside the 24-hour window. This service never needs to: the
  person taps a button, which opens the window itself. Using a tag for
  automation is exactly the kind of thing that gets an app restricted.
- **Follower lists, Business Discovery, hashtag search, scraping.**
  `is_user_follow_business` is the only official follow signal and the only one
  used. There is no fallback, on purpose.
- **`/me/messages`.** The explicit `IG_USER_ID` is used so a misconfiguration
  fails loudly.
- **`live_comments`.** Private replies on Live only work during the broadcast,
  which does not fit a queue-and-retry design.
