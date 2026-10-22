/**
 * PostgresRepository — the production implementation.
 *
 * Two things here are load-bearing:
 *   1. `FOR UPDATE SKIP LOCKED` claiming, so two workers (or two instances)
 *      never process the same event or send the same outbox row.
 *   2. `ON CONFLICT ... DO NOTHING` + `RETURNING` on inserts whose uniqueness
 *      *is* the idempotency guarantee (events.provider_event_id,
 *      conversations(igsid, rule_id), outbox.dedupe_key). Nothing is read first
 *      and written after: the database decides, in one statement.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  AuditEntry,
  Contact,
  Conversation,
  ConversationState,
  EventStatus,
  InboundEvent,
  InboundEventType,
  NewAuditEntry,
  NewOutboxItem,
  NewRule,
  OutboxItem,
  OutboxKind,
  OutboxRequest,
  OutboxStatus,
  ResourcePayload,
  Rule,
  StateTransition,
  StoredEvent,
} from '../types.js';
import { MESSAGE_KINDS } from '../types.js';
import type {
  ConversationPatch,
  EnqueueResult,
  HealthResult,
  InsertEventResult,
  NewConversation,
  Repository,
} from './repository.js';

const { Pool } = pg;

export interface PostgresRepositoryOptions {
  connectionString: string;
  ssl?: boolean;
  max?: number;
  /** Set by the migration runner; exposed so tests can skip it. */
  applicationName?: string;
}

type Row = Record<string, unknown>;

export class PostgresRepository implements Repository {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(opts: PostgresRepositoryOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      application_name: opts.applicationName ?? 'comment-to-dm',
      // Hosted Postgres (Supabase, Render, Neon) terminates TLS with a
      // certificate chain Node does not have, hence rejectUnauthorized:false.
      // The connection is still encrypted.
      ...(opts.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  /** Escape hatch for the migration runner and integration tests. */
  get rawPool(): pg.Pool {
    return this.pool;
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    client.release();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<HealthResult> {
    try {
      const r = await this.pool.query<{ one: number }>('select 1 as one');
      return r.rows[0]?.one === 1
        ? { ok: true, detail: 'postgres ready' }
        : { ok: false, detail: 'unexpected select 1 result' };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  // -- rules ---------------------------------------------------------------

  async listRules(): Promise<Rule[]> {
    const r = await this.pool.query<Row>(
      'select * from rules order by priority desc, created_at asc',
    );
    return r.rows.map(toRule);
  }

  async getRule(id: string): Promise<Rule | null> {
    const r = await this.pool.query<Row>('select * from rules where id = $1', [id]);
    const row = r.rows[0];
    return row ? toRule(row) : null;
  }

  async createRule(rule: NewRule): Promise<Rule> {
    const id = rule.id ?? randomUUID().replace(/-/g, '').slice(0, 12);
    const r = await this.pool.query<Row>(
      `insert into rules (id, name, enabled, scope, ig_media_id, match_type, keywords,
                          case_insensitive, public_reply_variants, dm_prompt_text, button_label,
                          gate_message, resource_payload, require_follow, priority)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
       returning *`,
      [
        id,
        rule.name,
        rule.enabled,
        rule.scope,
        rule.igMediaId,
        rule.matchType,
        rule.keywords,
        rule.caseInsensitive,
        rule.publicReplyVariants,
        rule.dmPromptText,
        rule.buttonLabel,
        rule.gateMessage,
        JSON.stringify(rule.resourcePayload),
        rule.requireFollow,
        rule.priority,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new Error('insert into rules returned no row');
    return toRule(row);
  }

  async updateRule(id: string, patch: Partial<NewRule>): Promise<Rule | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown, cast = ''): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.enabled !== undefined) push('enabled', patch.enabled);
    if (patch.scope !== undefined) push('scope', patch.scope);
    if (patch.igMediaId !== undefined) push('ig_media_id', patch.igMediaId);
    if (patch.matchType !== undefined) push('match_type', patch.matchType);
    if (patch.keywords !== undefined) push('keywords', patch.keywords);
    if (patch.caseInsensitive !== undefined) push('case_insensitive', patch.caseInsensitive);
    if (patch.publicReplyVariants !== undefined) {
      push('public_reply_variants', patch.publicReplyVariants);
    }
    if (patch.dmPromptText !== undefined) push('dm_prompt_text', patch.dmPromptText);
    if (patch.buttonLabel !== undefined) push('button_label', patch.buttonLabel);
    if (patch.gateMessage !== undefined) push('gate_message', patch.gateMessage);
    if (patch.resourcePayload !== undefined) {
      push('resource_payload', JSON.stringify(patch.resourcePayload), '::jsonb');
    }
    if (patch.requireFollow !== undefined) push('require_follow', patch.requireFollow);
    if (patch.priority !== undefined) push('priority', patch.priority);
    if (sets.length === 0) return this.getRule(id);

    sets.push('updated_at = now()');
    values.push(id);
    const r = await this.pool.query<Row>(
      `update rules set ${sets.join(', ')} where id = $${values.length} returning *`,
      values,
    );
    const row = r.rows[0];
    return row ? toRule(row) : null;
  }

  // -- contacts ------------------------------------------------------------

  async upsertContact(igsid: string, username: string | null, seenAt: Date): Promise<Contact> {
    const r = await this.pool.query<Row>(
      `insert into contacts (igsid, username, last_seen_at)
       values ($1, $2, $3)
       on conflict (igsid) do update
         set username = coalesce(excluded.username, contacts.username),
             last_seen_at = greatest(contacts.last_seen_at, excluded.last_seen_at)
       returning *`,
      [igsid, username, seenAt],
    );
    const row = r.rows[0];
    if (!row) throw new Error('upsert contact returned no row');
    return toContact(row);
  }

  async getContact(igsid: string): Promise<Contact | null> {
    const r = await this.pool.query<Row>('select * from contacts where igsid = $1', [igsid]);
    const row = r.rows[0];
    return row ? toContact(row) : null;
  }

  async setContactFollows(igsid: string, follows: boolean, at: Date): Promise<void> {
    await this.pool.query(
      `insert into contacts (igsid, last_seen_at, follows_cached, follows_checked_at)
       values ($1, $2, $3, $2)
       on conflict (igsid) do update
         set follows_cached = excluded.follows_cached,
             follows_checked_at = excluded.follows_checked_at`,
      [igsid, at, follows],
    );
  }

  // -- events --------------------------------------------------------------

  async insertEvent(event: InboundEvent, receivedAt: Date): Promise<InsertEventResult> {
    // One statement: the unique index decides whether this is new.
    const inserted = await this.pool.query<Row>(
      `insert into events (provider_event_id, type, igsid, username, comment_id, media_id,
                           text, postback_payload, occurred_at, raw, received_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       on conflict (provider_event_id) do nothing
       returning *`,
      [
        event.providerEventId,
        event.type,
        event.igsid,
        event.username,
        event.commentId,
        event.mediaId,
        event.text,
        event.postbackPayload,
        event.occurredAt,
        JSON.stringify(event.raw ?? null),
        receivedAt,
      ],
    );
    const row = inserted.rows[0];
    if (row) return { stored: toEvent(row), duplicate: false };

    const existing = await this.pool.query<Row>(
      'select * from events where provider_event_id = $1',
      [event.providerEventId],
    );
    const found = existing.rows[0];
    if (!found) throw new Error('event insert conflicted but the row is gone');
    return { stored: toEvent(found), duplicate: true };
  }

  async claimEvents(limit: number, _now: Date): Promise<StoredEvent[]> {
    void _now;
    const r = await this.pool.query<Row>(
      `update events set status = 'processing'
       where id in (
         select id from events
         where status = 'pending'
         order by received_at asc
         limit $1
         for update skip locked
       )
       returning *`,
      [limit],
    );
    return r.rows.map(toEvent);
  }

  async finishEvent(
    id: string,
    status: EventStatus,
    error: string | null,
    at: Date,
  ): Promise<void> {
    await this.pool.query(
      'update events set status = $2, error = $3, processed_at = $4 where id = $1',
      [id, status, error, at],
    );
  }

  async getEventByProviderId(providerEventId: string): Promise<StoredEvent | null> {
    const r = await this.pool.query<Row>('select * from events where provider_event_id = $1', [
      providerEventId,
    ]);
    const row = r.rows[0];
    return row ? toEvent(row) : null;
  }

  // -- conversations -------------------------------------------------------

  async createConversation(input: NewConversation, now: Date): Promise<Conversation> {
    const r = await this.pool.query<Row>(
      `insert into conversations (igsid, rule_id, state, comment_id, last_action_at, window_opened_at, created_at)
       values ($1,$2,$3,$4,$5,$5,$5)
       on conflict (igsid, rule_id) do update
         set comment_id = coalesce(conversations.comment_id, excluded.comment_id)
       returning *`,
      [input.igsid, input.ruleId, input.state, input.commentId, now],
    );
    const row = r.rows[0];
    if (!row) throw new Error('upsert conversation returned no row');
    return toConversation(row);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const r = await this.pool.query<Row>('select * from conversations where id = $1', [id]);
    const row = r.rows[0];
    return row ? toConversation(row) : null;
  }

  async findConversation(igsid: string, ruleId: string): Promise<Conversation | null> {
    const r = await this.pool.query<Row>(
      'select * from conversations where igsid = $1 and rule_id = $2',
      [igsid, ruleId],
    );
    const row = r.rows[0];
    return row ? toConversation(row) : null;
  }

  async updateConversation(id: string, patch: ConversationPatch): Promise<Conversation> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.state !== undefined) push('state', patch.state);
    if (patch.attempts !== undefined) push('attempts', patch.attempts);
    if (patch.lastActionAt !== undefined) push('last_action_at', patch.lastActionAt);
    if (patch.windowOpenedAt !== undefined) push('window_opened_at', patch.windowOpenedAt);
    if (patch.deliveredAt !== undefined) push('delivered_at', patch.deliveredAt);
    if (patch.commentId !== undefined) push('comment_id', patch.commentId);
    if (patch.lastReason !== undefined) push('last_reason', patch.lastReason);
    if (sets.length === 0) {
      const existing = await this.getConversation(id);
      if (!existing) throw new Error(`conversation ${id} not found`);
      return existing;
    }
    values.push(id);
    const r = await this.pool.query<Row>(
      `update conversations set ${sets.join(', ')} where id = $${values.length} returning *`,
      values,
    );
    const row = r.rows[0];
    if (!row) throw new Error(`conversation ${id} not found`);
    return toConversation(row);
  }

  async listConversations(limit: number): Promise<Conversation[]> {
    const r = await this.pool.query<Row>(
      'select * from conversations order by last_action_at desc limit $1',
      [limit],
    );
    return r.rows.map(toConversation);
  }

  async conversationsIdleSince(before: Date, limit: number): Promise<Conversation[]> {
    const r = await this.pool.query<Row>(
      `select * from conversations
       where last_action_at < $1
         and state not in ('DELIVERED', 'FAILED', 'ABANDONED')
       order by last_action_at asc
       limit $2`,
      [before, limit],
    );
    return r.rows.map(toConversation);
  }

  async recordTransition(t: StateTransition): Promise<void> {
    await this.pool.query(
      `insert into conversation_transitions (conversation_id, from_state, to_state, reason, at)
       values ($1,$2,$3,$4,$5)`,
      [t.conversationId, t.from, t.to, t.reason, t.at],
    );
  }

  async listTransitions(conversationId: string): Promise<StateTransition[]> {
    const r = await this.pool.query<Row>(
      'select * from conversation_transitions where conversation_id = $1 order by at asc, id asc',
      [conversationId],
    );
    return r.rows.map((row) => ({
      conversationId: str(row.conversation_id) ?? conversationId,
      from: (str(row.from_state) ?? 'NEW') as ConversationState,
      to: (str(row.to_state) ?? 'NEW') as ConversationState,
      reason: str(row.reason) ?? '',
      at: date(row.at) ?? new Date(0),
    }));
  }

  // -- outbox --------------------------------------------------------------

  async enqueue(item: NewOutboxItem, now: Date): Promise<EnqueueResult> {
    const inserted = await this.pool.query<Row>(
      `insert into outbox (conversation_id, igsid, window_opened_at, kind, dedupe_key, request, next_attempt_at, created_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       on conflict (dedupe_key) do nothing
       returning *`,
      [
        item.conversationId,
        item.igsid,
        item.windowOpenedAt ?? now,
        item.kind,
        item.dedupeKey,
        JSON.stringify(item.request),
        item.nextAttemptAt ?? now,
        now,
      ],
    );
    const row = inserted.rows[0];
    if (row) return { item: toOutbox(row), created: true };

    const existing = await this.pool.query<Row>('select * from outbox where dedupe_key = $1', [
      item.dedupeKey,
    ]);
    const found = existing.rows[0];
    if (!found) throw new Error('outbox insert conflicted but the row is gone');
    return { item: toOutbox(found), created: false };
  }

  async claimOutbox(limit: number, now: Date): Promise<OutboxItem[]> {
    const r = await this.pool.query<Row>(
      `update outbox set status = 'sending'
       where id in (
         select id from outbox
         where status = 'queued' and next_attempt_at <= $2
         order by next_attempt_at asc
         limit $1
         for update skip locked
       )
       returning *`,
      [limit, now],
    );
    return r.rows.map(toOutbox);
  }

  async markOutboxSent(id: string, providerMessageId: string | null, at: Date): Promise<void> {
    await this.pool.query(
      `update outbox
       set status = 'sent', sent_at = $3, provider_message_id = $2,
           attempts = attempts + 1, last_error = null
       where id = $1`,
      [id, providerMessageId, at],
    );
  }

  async rescheduleOutbox(
    id: string,
    nextAttemptAt: Date,
    lastError: string | null,
    countAttempt: boolean,
  ): Promise<void> {
    await this.pool.query(
      `update outbox
       set status = 'queued',
           next_attempt_at = $2,
           last_error = $3,
           attempts = attempts + case when $4 then 1 else 0 end
       where id = $1`,
      [id, nextAttemptAt, lastError, countAttempt],
    );
  }

  async markOutboxFailed(id: string, lastError: string, _at: Date): Promise<void> {
    void _at;
    await this.pool.query(
      `update outbox set status = 'failed', last_error = $2, attempts = attempts + 1 where id = $1`,
      [id, lastError],
    );
  }

  async getOutboxItem(id: string): Promise<OutboxItem | null> {
    const r = await this.pool.query<Row>('select * from outbox where id = $1', [id]);
    const row = r.rows[0];
    return row ? toOutbox(row) : null;
  }

  async listOutbox(status: OutboxStatus | 'all', limit: number): Promise<OutboxItem[]> {
    const r =
      status === 'all'
        ? await this.pool.query<Row>('select * from outbox order by created_at desc limit $1', [
            limit,
          ])
        : await this.pool.query<Row>(
            'select * from outbox where status = $1 order by created_at desc limit $2',
            [status, limit],
          );
    return r.rows.map(toOutbox);
  }

  async requeueOutbox(id: string, now: Date): Promise<OutboxItem | null> {
    const r = await this.pool.query<Row>(
      `update outbox
       set status = 'queued', attempts = 0, next_attempt_at = $2, last_error = null
       where id = $1 and status = 'failed'
       returning *`,
      [id, now],
    );
    const row = r.rows[0];
    if (row) return toOutbox(row);
    return this.getOutboxItem(id);
  }

  async countMessagesSentSince(since: Date): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `select count(*)::text as n from outbox
       where status = 'sent' and sent_at >= $1 and kind = any($2::text[])`,
      [since, MESSAGE_KINDS],
    );
    return Number(r.rows[0]?.n ?? '0');
  }

  async countMessagesSentToContactSince(igsid: string, since: Date): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `select count(*)::text as n from outbox
       where igsid = $1 and status = 'sent' and sent_at >= $2 and kind = any($3::text[])`,
      [igsid, since, MESSAGE_KINDS],
    );
    return Number(r.rows[0]?.n ?? '0');
  }

  async lastMessageToContactAt(igsid: string): Promise<Date | null> {
    const r = await this.pool.query<Row>(
      `select max(sent_at) as last_at from outbox
       where igsid = $1 and status = 'sent' and kind = any($2::text[])`,
      [igsid, MESSAGE_KINDS],
    );
    return date(r.rows[0]?.last_at) ?? null;
  }

  // -- audit ---------------------------------------------------------------

  async appendAudit(entry: NewAuditEntry, at: Date): Promise<AuditEntry> {
    const r = await this.pool.query<Row>(
      `insert into audit_log (at, direction, action, igsid, conversation_id, provider_id, status, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [
        at,
        entry.direction,
        entry.action,
        entry.igsid ?? null,
        entry.conversationId ?? null,
        entry.providerId ?? null,
        entry.status,
        entry.detail ?? null,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new Error('insert into audit_log returned no row');
    return toAudit(row);
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    const r = await this.pool.query<Row>('select * from audit_log order by at desc limit $1', [
      limit,
    ]);
    return r.rows.map(toAudit);
  }
}

// ---------------------------------------------------------------------------
// row -> domain mapping. No `any`: every column is read through a narrow reader.
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function date(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function toResourcePayload(v: unknown): ResourcePayload {
  if (typeof v !== 'object' || v === null) return { text: '' };
  const o = v as Record<string, unknown>;
  const out: ResourcePayload = { text: str(o.text) ?? '' };
  const url = str(o.url);
  if (url !== null) out.url = url;
  const followUp = str(o.followUp) ?? str(o.follow_up);
  if (followUp !== null) out.followUp = followUp;
  return out;
}

function toRule(row: Row): Rule {
  return {
    id: str(row.id) ?? '',
    name: str(row.name) ?? '',
    enabled: bool(row.enabled) ?? false,
    scope: (str(row.scope) ?? 'global') === 'post' ? 'post' : 'global',
    igMediaId: str(row.ig_media_id),
    matchType: (str(row.match_type) ?? 'contains') as Rule['matchType'],
    keywords: strArray(row.keywords),
    caseInsensitive: bool(row.case_insensitive) ?? true,
    publicReplyVariants: strArray(row.public_reply_variants),
    dmPromptText: str(row.dm_prompt_text) ?? '',
    buttonLabel: str(row.button_label) ?? '',
    gateMessage: str(row.gate_message) ?? '',
    resourcePayload: toResourcePayload(row.resource_payload),
    requireFollow: bool(row.require_follow) ?? true,
    priority: num(row.priority) ?? 0,
    createdAt: date(row.created_at) ?? new Date(0),
    updatedAt: date(row.updated_at) ?? new Date(0),
  };
}

function toContact(row: Row): Contact {
  return {
    igsid: str(row.igsid) ?? '',
    username: str(row.username),
    lastSeenAt: date(row.last_seen_at) ?? new Date(0),
    followsCached: bool(row.follows_cached),
    followsCheckedAt: date(row.follows_checked_at),
  };
}

function toEvent(row: Row): StoredEvent {
  return {
    id: str(row.id) ?? '',
    providerEventId: str(row.provider_event_id) ?? '',
    type: (str(row.type) ?? 'comment') as InboundEventType,
    igsid: str(row.igsid) ?? '',
    username: str(row.username),
    commentId: str(row.comment_id),
    mediaId: str(row.media_id),
    text: str(row.text),
    postbackPayload: str(row.postback_payload),
    occurredAt: date(row.occurred_at) ?? new Date(0),
    raw: row.raw ?? null,
    receivedAt: date(row.received_at) ?? new Date(0),
    processedAt: date(row.processed_at),
    status: (str(row.status) ?? 'pending') as EventStatus,
    error: str(row.error),
  };
}

function toConversation(row: Row): Conversation {
  return {
    id: str(row.id) ?? '',
    igsid: str(row.igsid) ?? '',
    ruleId: str(row.rule_id) ?? '',
    state: (str(row.state) ?? 'NEW') as ConversationState,
    attempts: num(row.attempts) ?? 0,
    lastActionAt: date(row.last_action_at) ?? new Date(0),
    windowOpenedAt: date(row.window_opened_at) ?? date(row.last_action_at) ?? new Date(0),
    deliveredAt: date(row.delivered_at),
    commentId: str(row.comment_id),
    lastReason: str(row.last_reason),
    createdAt: date(row.created_at) ?? new Date(0),
  };
}

function toOutboxRequest(v: unknown): OutboxRequest {
  if (typeof v === 'object' && v !== null && 'op' in v) {
    // The column is written only by enqueue(), from the typed union.
    return v as OutboxRequest;
  }
  throw new Error('outbox.request is not a recognised request object');
}

function toOutbox(row: Row): OutboxItem {
  return {
    id: str(row.id) ?? '',
    conversationId: str(row.conversation_id),
    igsid: str(row.igsid),
    windowOpenedAt: date(row.window_opened_at) ?? date(row.created_at) ?? new Date(0),
    kind: (str(row.kind) ?? 'resource') as OutboxKind,
    dedupeKey: str(row.dedupe_key) ?? '',
    request: toOutboxRequest(row.request),
    status: (str(row.status) ?? 'queued') as OutboxStatus,
    attempts: num(row.attempts) ?? 0,
    nextAttemptAt: date(row.next_attempt_at) ?? new Date(0),
    lastError: str(row.last_error),
    createdAt: date(row.created_at) ?? new Date(0),
    sentAt: date(row.sent_at),
    providerMessageId: str(row.provider_message_id),
  };
}

function toAudit(row: Row): AuditEntry {
  return {
    id: str(row.id) ?? '',
    at: date(row.at) ?? new Date(0),
    direction: (str(row.direction) ?? 'internal') as AuditEntry['direction'],
    action: str(row.action) ?? '',
    igsid: str(row.igsid),
    conversationId: str(row.conversation_id),
    providerId: str(row.provider_id),
    status: str(row.status) ?? '',
    detail: str(row.detail),
  };
}
