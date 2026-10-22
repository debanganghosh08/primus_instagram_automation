/**
 * In-memory Repository. Used by the test suite and by `npm run simulate`, so
 * both run with no Postgres, no Docker and no network.
 *
 * It is held to exactly the same contract as PostgresRepository, including the
 * unique keys. Where Postgres relies on a unique index, this uses a Map — and
 * tests/repository_contract.test.ts runs the same assertions against both.
 *
 * Node runs our handlers on one thread and nothing here awaits mid-mutation,
 * so "claiming" is naturally atomic: a claimed row is flipped to
 * processing/sending before the method returns.
 */
import { randomUUID } from 'node:crypto';
import type {
  AuditEntry,
  Contact,
  Conversation,
  EventStatus,
  InboundEvent,
  NewAuditEntry,
  NewOutboxItem,
  NewRule,
  OutboxItem,
  OutboxStatus,
  Rule,
  StateTransition,
  StoredEvent,
} from '../types.js';
import { isMessageKind } from '../types.js';
import type {
  ConversationPatch,
  EnqueueResult,
  HealthResult,
  InsertEventResult,
  NewConversation,
  Repository,
} from './repository.js';

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class MemoryRepository implements Repository {
  readonly kind = 'memory' as const;

  private rules = new Map<string, Rule>();
  private contacts = new Map<string, Contact>();
  private events = new Map<string, StoredEvent>();
  private eventsByProvider = new Map<string, string>();
  private conversations = new Map<string, Conversation>();
  private conversationsByKey = new Map<string, string>();
  private transitions: StateTransition[] = [];
  private outbox = new Map<string, OutboxItem>();
  private outboxByDedupe = new Map<string, string>();
  private audit: AuditEntry[] = [];
  private closed = false;

  async init(): Promise<void> {
    this.closed = false;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async health(): Promise<HealthResult> {
    return this.closed
      ? { ok: false, detail: 'memory repository closed' }
      : { ok: true, detail: 'memory repository ready' };
  }

  /** Test helper: drop everything. */
  reset(): void {
    this.rules.clear();
    this.contacts.clear();
    this.events.clear();
    this.eventsByProvider.clear();
    this.conversations.clear();
    this.conversationsByKey.clear();
    this.transitions = [];
    this.outbox.clear();
    this.outboxByDedupe.clear();
    this.audit = [];
  }

  // -- rules ---------------------------------------------------------------

  async listRules(): Promise<Rule[]> {
    return [...this.rules.values()].map(clone);
  }

  async getRule(id: string): Promise<Rule | null> {
    const r = this.rules.get(id);
    return r ? clone(r) : null;
  }

  async createRule(rule: NewRule): Promise<Rule> {
    const now = new Date();
    const id = rule.id ?? randomUUID().replace(/-/g, '').slice(0, 12);
    if (this.rules.has(id)) throw new Error(`rule ${id} already exists`);
    const { id: _ignored, ...rest } = rule;
    const stored: Rule = { ...rest, id, createdAt: now, updatedAt: now };
    this.rules.set(id, stored);
    return clone(stored);
  }

  async updateRule(id: string, patch: Partial<NewRule>): Promise<Rule | null> {
    const existing = this.rules.get(id);
    if (!existing) return null;
    const { id: _ignored, ...rest } = patch;
    const next: Rule = { ...existing, ...rest, id, updatedAt: new Date() };
    this.rules.set(id, next);
    return clone(next);
  }

  // -- contacts ------------------------------------------------------------

  async upsertContact(igsid: string, username: string | null, seenAt: Date): Promise<Contact> {
    const existing = this.contacts.get(igsid);
    const next: Contact = existing
      ? { ...existing, username: username ?? existing.username, lastSeenAt: seenAt }
      : {
          igsid,
          username,
          lastSeenAt: seenAt,
          followsCached: null,
          followsCheckedAt: null,
        };
    this.contacts.set(igsid, next);
    return clone(next);
  }

  async getContact(igsid: string): Promise<Contact | null> {
    const c = this.contacts.get(igsid);
    return c ? clone(c) : null;
  }

  async setContactFollows(igsid: string, follows: boolean, at: Date): Promise<void> {
    const existing = await this.upsertContact(igsid, null, at);
    this.contacts.set(igsid, { ...existing, followsCached: follows, followsCheckedAt: at });
  }

  // -- events --------------------------------------------------------------

  async insertEvent(event: InboundEvent, receivedAt: Date): Promise<InsertEventResult> {
    const existingId = this.eventsByProvider.get(event.providerEventId);
    if (existingId !== undefined) {
      const stored = this.events.get(existingId);
      if (stored) return { stored: clone(stored), duplicate: true };
    }
    const stored: StoredEvent = {
      ...event,
      id: randomUUID(),
      receivedAt,
      processedAt: null,
      status: 'pending',
      error: null,
    };
    this.events.set(stored.id, stored);
    this.eventsByProvider.set(event.providerEventId, stored.id);
    return { stored: clone(stored), duplicate: false };
  }

  async claimEvents(limit: number, _now: Date): Promise<StoredEvent[]> {
    void _now;
    const claimed: StoredEvent[] = [];
    for (const ev of [...this.events.values()].sort(
      (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
    )) {
      if (claimed.length >= limit) break;
      if (ev.status !== 'pending') continue;
      ev.status = 'processing';
      claimed.push(clone(ev));
    }
    return claimed;
  }

  async finishEvent(
    id: string,
    status: EventStatus,
    error: string | null,
    at: Date,
  ): Promise<void> {
    const ev = this.events.get(id);
    if (!ev) return;
    ev.status = status;
    ev.error = error;
    ev.processedAt = at;
  }

  async getEventByProviderId(providerEventId: string): Promise<StoredEvent | null> {
    const id = this.eventsByProvider.get(providerEventId);
    if (id === undefined) return null;
    const ev = this.events.get(id);
    return ev ? clone(ev) : null;
  }

  // -- conversations -------------------------------------------------------

  private convKey(igsid: string, ruleId: string): string {
    return `${igsid}::${ruleId}`;
  }

  async createConversation(input: NewConversation, now: Date): Promise<Conversation> {
    const key = this.convKey(input.igsid, input.ruleId);
    const existingId = this.conversationsByKey.get(key);
    if (existingId !== undefined) {
      const existing = this.conversations.get(existingId);
      if (existing) {
        // Same as the Postgres ON CONFLICT: fill in a comment id we did not
        // have before, but never overwrite one.
        if (existing.commentId === null && input.commentId !== null) {
          existing.commentId = input.commentId;
        }
        return clone(existing);
      }
    }
    const conv: Conversation = {
      id: randomUUID(),
      igsid: input.igsid,
      ruleId: input.ruleId,
      state: input.state,
      attempts: 0,
      lastActionAt: now,
      windowOpenedAt: now,
      deliveredAt: null,
      commentId: input.commentId,
      lastReason: null,
      createdAt: now,
    };
    this.conversations.set(conv.id, conv);
    this.conversationsByKey.set(key, conv.id);
    return clone(conv);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const c = this.conversations.get(id);
    return c ? clone(c) : null;
  }

  async findConversation(igsid: string, ruleId: string): Promise<Conversation | null> {
    const id = this.conversationsByKey.get(this.convKey(igsid, ruleId));
    if (id === undefined) return null;
    const c = this.conversations.get(id);
    return c ? clone(c) : null;
  }

  async updateConversation(id: string, patch: ConversationPatch): Promise<Conversation> {
    const existing = this.conversations.get(id);
    if (!existing) throw new Error(`conversation ${id} not found`);
    const next: Conversation = { ...existing };
    if (patch.state !== undefined) next.state = patch.state;
    if (patch.attempts !== undefined) next.attempts = patch.attempts;
    if (patch.lastActionAt !== undefined) next.lastActionAt = patch.lastActionAt;
    if (patch.windowOpenedAt !== undefined) next.windowOpenedAt = patch.windowOpenedAt;
    if (patch.deliveredAt !== undefined) next.deliveredAt = patch.deliveredAt;
    if (patch.commentId !== undefined) next.commentId = patch.commentId;
    if (patch.lastReason !== undefined) next.lastReason = patch.lastReason;
    this.conversations.set(id, next);
    return clone(next);
  }

  async listConversations(limit: number): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .sort((a, b) => b.lastActionAt.getTime() - a.lastActionAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async conversationsIdleSince(before: Date, limit: number): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter(
        (c) =>
          c.lastActionAt.getTime() < before.getTime() &&
          c.state !== 'DELIVERED' &&
          c.state !== 'FAILED' &&
          c.state !== 'ABANDONED',
      )
      .slice(0, limit)
      .map(clone);
  }

  async recordTransition(t: StateTransition): Promise<void> {
    this.transitions.push(clone(t));
  }

  async listTransitions(conversationId: string): Promise<StateTransition[]> {
    return this.transitions.filter((t) => t.conversationId === conversationId).map(clone);
  }

  // -- outbox --------------------------------------------------------------

  async enqueue(item: NewOutboxItem, now: Date): Promise<EnqueueResult> {
    const existingId = this.outboxByDedupe.get(item.dedupeKey);
    if (existingId !== undefined) {
      const existing = this.outbox.get(existingId);
      if (existing) return { item: clone(existing), created: false };
    }
    const row: OutboxItem = {
      id: randomUUID(),
      conversationId: item.conversationId,
      igsid: item.igsid,
      windowOpenedAt: item.windowOpenedAt ?? now,
      kind: item.kind,
      dedupeKey: item.dedupeKey,
      request: item.request,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: item.nextAttemptAt ?? now,
      lastError: null,
      createdAt: now,
      sentAt: null,
      providerMessageId: null,
    };
    this.outbox.set(row.id, row);
    this.outboxByDedupe.set(row.dedupeKey, row.id);
    return { item: clone(row), created: true };
  }

  async claimOutbox(limit: number, now: Date): Promise<OutboxItem[]> {
    const claimed: OutboxItem[] = [];
    for (const row of [...this.outbox.values()].sort(
      (a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime(),
    )) {
      if (claimed.length >= limit) break;
      if (row.status !== 'queued') continue;
      if (row.nextAttemptAt.getTime() > now.getTime()) continue;
      row.status = 'sending';
      claimed.push(clone(row));
    }
    return claimed;
  }

  async markOutboxSent(id: string, providerMessageId: string | null, at: Date): Promise<void> {
    const row = this.outbox.get(id);
    if (!row) return;
    row.status = 'sent';
    row.sentAt = at;
    row.providerMessageId = providerMessageId;
    row.attempts += 1;
    row.lastError = null;
  }

  async rescheduleOutbox(
    id: string,
    nextAttemptAt: Date,
    lastError: string | null,
    countAttempt: boolean,
  ): Promise<void> {
    const row = this.outbox.get(id);
    if (!row) return;
    row.status = 'queued';
    row.nextAttemptAt = nextAttemptAt;
    row.lastError = lastError;
    if (countAttempt) row.attempts += 1;
  }

  async markOutboxFailed(id: string, lastError: string, at: Date): Promise<void> {
    const row = this.outbox.get(id);
    if (!row) return;
    row.status = 'failed';
    row.lastError = lastError;
    row.attempts += 1;
    row.sentAt = null;
    void at;
  }

  async getOutboxItem(id: string): Promise<OutboxItem | null> {
    const row = this.outbox.get(id);
    return row ? clone(row) : null;
  }

  async listOutbox(status: OutboxStatus | 'all', limit: number): Promise<OutboxItem[]> {
    return [...this.outbox.values()]
      .filter((r) => status === 'all' || r.status === status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async requeueOutbox(id: string, now: Date): Promise<OutboxItem | null> {
    const row = this.outbox.get(id);
    if (!row) return null;
    if (row.status !== 'failed') return clone(row);
    row.status = 'queued';
    row.attempts = 0;
    row.nextAttemptAt = now;
    row.lastError = null;
    return clone(row);
  }

  async countMessagesSentSince(since: Date): Promise<number> {
    return [...this.outbox.values()].filter(
      (r) =>
        r.status === 'sent' &&
        isMessageKind(r.kind) &&
        r.sentAt !== null &&
        r.sentAt.getTime() >= since.getTime(),
    ).length;
  }

  async countMessagesSentToContactSince(igsid: string, since: Date): Promise<number> {
    return [...this.outbox.values()].filter(
      (r) =>
        r.igsid === igsid &&
        r.status === 'sent' &&
        isMessageKind(r.kind) &&
        r.sentAt !== null &&
        r.sentAt.getTime() >= since.getTime(),
    ).length;
  }

  async lastMessageToContactAt(igsid: string): Promise<Date | null> {
    let latest: Date | null = null;
    for (const r of this.outbox.values()) {
      if (r.igsid !== igsid || r.status !== 'sent' || !isMessageKind(r.kind) || r.sentAt === null) {
        continue;
      }
      if (latest === null || r.sentAt.getTime() > latest.getTime()) latest = r.sentAt;
    }
    return latest;
  }

  // -- audit ---------------------------------------------------------------

  async appendAudit(entry: NewAuditEntry, at: Date): Promise<AuditEntry> {
    const row: AuditEntry = {
      id: randomUUID(),
      at,
      direction: entry.direction,
      action: entry.action,
      igsid: entry.igsid ?? null,
      conversationId: entry.conversationId ?? null,
      providerId: entry.providerId ?? null,
      status: entry.status,
      detail: entry.detail ?? null,
    };
    this.audit.push(row);
    return clone(row);
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    return this.audit.slice(-limit).reverse().map(clone);
  }
}
