-- 001_init.sql
-- The whole schema. Safe to run repeatedly (every statement is IF NOT EXISTS),
-- and the migration runner records it so it only runs once anyway.

create table if not exists rules (
  id                    text primary key,
  name                  text        not null,
  enabled               boolean     not null default true,
  scope                 text        not null,
  ig_media_id           text,
  match_type            text        not null,
  keywords              text[]      not null default '{}',
  case_insensitive      boolean     not null default true,
  public_reply_variants text[]      not null default '{}',
  dm_prompt_text        text        not null,
  button_label          text        not null,
  gate_message          text        not null,
  resource_payload      jsonb       not null,
  require_follow        boolean     not null default true,
  priority              integer     not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint rules_scope_valid      check (scope in ('global', 'post')),
  constraint rules_match_type_valid check (match_type in ('exact', 'contains', 'regex', 'any')),
  -- A post-scoped rule without a media id would match nothing; catch it here.
  constraint rules_post_needs_media check (scope <> 'post' or ig_media_id is not null),
  -- The id travels inside the button postback payload (ACTION:rule_id:nonce),
  -- so it must not contain the ':' separator or anything exotic.
  constraint rules_id_payload_safe  check (id ~ '^[A-Za-z0-9_-]+$')
);

create index if not exists rules_lookup_idx on rules (enabled, priority desc, created_at);


create table if not exists contacts (
  igsid              text primary key,
  username           text,
  last_seen_at       timestamptz not null default now(),
  -- Cached answer from is_user_follow_business. Never used in place of a live
  -- check before delivering; it exists for the dashboard and for debugging.
  follows_cached     boolean,
  follows_checked_at timestamptz
);


-- Every inbound webhook notification. provider_event_id is the dedupe key:
-- Meta retries deliveries, and this unique index is what makes our processing
-- exactly-once.
create table if not exists events (
  id                 uuid primary key default gen_random_uuid(),
  provider_event_id  text        not null unique,
  type               text        not null,
  igsid              text        not null,
  username           text,
  comment_id         text,
  media_id           text,
  text               text,
  postback_payload   text,
  occurred_at        timestamptz not null,
  raw                jsonb       not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  status             text        not null default 'pending',
  error              text,

  constraint events_type_valid   check (type in ('comment', 'postback', 'message')),
  constraint events_status_valid check (status in ('pending', 'processing', 'done', 'skipped', 'error'))
);

create index if not exists events_claim_idx on events (status, received_at) where status = 'pending';
create index if not exists events_igsid_idx on events (igsid, received_at desc);


-- One conversation per (person, rule). The unique constraint is the reason a
-- second comment from the same person cannot create a second DM thread.
create table if not exists conversations (
  id             uuid primary key default gen_random_uuid(),
  igsid          text        not null references contacts (igsid) on delete cascade,
  rule_id        text        not null references rules (id) on delete cascade,
  state          text        not null default 'NEW',
  attempts       integer     not null default 0,
  last_action_at timestamptz not null default now(),
  -- The last time the PERSON did something (commented, tapped, DMed). That is
  -- what opens the 24-hour messaging window, so it is what the send guard
  -- measures from -- not our own activity.
  window_opened_at timestamptz not null default now(),
  -- When the resource was confirmed sent. Null until then, even if the state
  -- machine has already decided to deliver.
  delivered_at   timestamptz,
  comment_id     text,
  last_reason    text,
  created_at     timestamptz not null default now(),

  constraint conversations_state_valid check (
    state in ('NEW', 'PROMPTED', 'GATED', 'CHECKING', 'DELIVERED', 'FAILED', 'ABANDONED')
  ),
  constraint conversations_unique_per_rule unique (igsid, rule_id)
);

create index if not exists conversations_recent_idx on conversations (last_action_at desc);
create index if not exists conversations_idle_idx on conversations (state, last_action_at);


create table if not exists conversation_transitions (
  id              bigserial primary key,
  conversation_id uuid        not null references conversations (id) on delete cascade,
  from_state      text        not null,
  to_state        text        not null,
  reason          text        not null,
  at              timestamptz not null default now()
);

create index if not exists conversation_transitions_conv_idx
  on conversation_transitions (conversation_id, at);


-- Every outbound Meta call. dedupe_key is unique, which is the last line of
-- defence against messaging the same person twice for the same reason.
create table if not exists outbox (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid references conversations (id) on delete set null,
  igsid                text,
  -- When the permission to send this started. See conversations.window_opened_at.
  window_opened_at     timestamptz not null default now(),
  kind                 text        not null,
  dedupe_key           text        not null unique,
  request              jsonb       not null,
  status               text        not null default 'queued',
  attempts             integer     not null default 0,
  next_attempt_at      timestamptz not null default now(),
  last_error           text,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz,
  provider_message_id  text,

  constraint outbox_kind_valid check (
    kind in ('public_reply', 'private_reply_prompt', 'dm_prompt', 'follow_check',
             'gate_message', 'reprompt', 'resource', 'resource_followup')
  ),
  constraint outbox_status_valid check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled'))
);

create index if not exists outbox_claim_idx on outbox (next_attempt_at)
  where status = 'queued';
create index if not exists outbox_contact_idx on outbox (igsid, sent_at desc)
  where status = 'sent';
create index if not exists outbox_recent_idx on outbox (created_at desc);


-- Append-only. Ids and statuses only: never a token, never a full message body.
create table if not exists audit_log (
  id              uuid primary key default gen_random_uuid(),
  at              timestamptz not null default now(),
  direction       text        not null,
  action          text        not null,
  igsid           text,
  conversation_id uuid,
  provider_id     text,
  status          text        not null,
  detail          text,

  constraint audit_direction_valid check (direction in ('inbound', 'outbound', 'internal'))
);

create index if not exists audit_log_recent_idx on audit_log (at desc);
create index if not exists audit_log_conv_idx on audit_log (conversation_id, at desc);
