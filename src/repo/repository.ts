/**
 * The single data-access seam.
 *
 * Everything above this interface is pure logic. There are two
 * implementations:
 *   - PostgresRepository — production. Real SQL, the numbered migrations,
 *     `FOR UPDATE SKIP LOCKED` claiming.
 *   - MemoryRepository   — tests and `npm run simulate`. Same semantics,
 *     no services, no network.
 *
 * The contract both must honour:
 *   - insertEvent() is the de-dupe point: the same provider_event_id twice
 *     returns `duplicate: true` and does not create a row.
 *   - createConversation() is keyed on (igsid, rule_id): calling it twice
 *     returns the same row.
 *   - enqueue() is keyed on dedupe_key: calling it twice returns the same row
 *     with `created: false`. This is what stops a person being messaged twice.
 *   - claimEvents()/claimOutbox() must not hand the same row to two workers.
 */
import type {
  AuditEntry,
  Contact,
  Conversation,
  ConversationState,
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

export interface InsertEventResult {
  stored: StoredEvent;
  duplicate: boolean;
}

export interface EnqueueResult {
  item: OutboxItem;
  created: boolean;
}

export interface NewConversation {
  igsid: string;
  ruleId: string;
  commentId: string | null;
  state: ConversationState;
}

export interface ConversationPatch {
  state?: ConversationState;
  attempts?: number;
  lastActionAt?: Date;
  windowOpenedAt?: Date;
  deliveredAt?: Date | null;
  commentId?: string | null;
  lastReason?: string | null;
}

export interface HealthResult {
  ok: boolean;
  detail: string;
}

export interface Repository {
  readonly kind: 'postgres' | 'memory';

  init(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<HealthResult>;

  // -- rules ---------------------------------------------------------------
  listRules(): Promise<Rule[]>;
  getRule(id: string): Promise<Rule | null>;
  createRule(rule: NewRule): Promise<Rule>;
  updateRule(id: string, patch: Partial<NewRule>): Promise<Rule | null>;

  // -- contacts ------------------------------------------------------------
  upsertContact(igsid: string, username: string | null, seenAt: Date): Promise<Contact>;
  getContact(igsid: string): Promise<Contact | null>;
  setContactFollows(igsid: string, follows: boolean, at: Date): Promise<void>;

  // -- events --------------------------------------------------------------
  insertEvent(event: InboundEvent, receivedAt: Date): Promise<InsertEventResult>;
  claimEvents(limit: number, now: Date): Promise<StoredEvent[]>;
  finishEvent(id: string, status: EventStatus, error: string | null, at: Date): Promise<void>;
  getEventByProviderId(providerEventId: string): Promise<StoredEvent | null>;

  // -- conversations -------------------------------------------------------
  createConversation(input: NewConversation, now: Date): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  findConversation(igsid: string, ruleId: string): Promise<Conversation | null>;
  updateConversation(id: string, patch: ConversationPatch): Promise<Conversation>;
  listConversations(limit: number): Promise<Conversation[]>;
  conversationsIdleSince(before: Date, limit: number): Promise<Conversation[]>;
  recordTransition(t: StateTransition): Promise<void>;
  listTransitions(conversationId: string): Promise<StateTransition[]>;

  // -- outbox --------------------------------------------------------------
  enqueue(item: NewOutboxItem, now: Date): Promise<EnqueueResult>;
  claimOutbox(limit: number, now: Date): Promise<OutboxItem[]>;
  markOutboxSent(id: string, providerMessageId: string | null, at: Date): Promise<void>;
  /** Put it back in the queue. `countAttempt` false = deferred, not a failure. */
  rescheduleOutbox(
    id: string,
    nextAttemptAt: Date,
    lastError: string | null,
    countAttempt: boolean,
  ): Promise<void>;
  markOutboxFailed(id: string, lastError: string, at: Date): Promise<void>;
  getOutboxItem(id: string): Promise<OutboxItem | null>;
  listOutbox(status: OutboxStatus | 'all', limit: number): Promise<OutboxItem[]>;
  /** Admin "retry": only a failed row, back to queued with attempts reset. */
  requeueOutbox(id: string, now: Date): Promise<OutboxItem | null>;
  /** Messages (not follow checks) sent account-wide since `since`. */
  countMessagesSentSince(since: Date): Promise<number>;
  /** Messages sent to one person since `since`. */
  countMessagesSentToContactSince(igsid: string, since: Date): Promise<number>;
  /** When we last messaged this person, for the per-contact cooldown. */
  lastMessageToContactAt(igsid: string): Promise<Date | null>;

  // -- audit ---------------------------------------------------------------
  appendAudit(entry: NewAuditEntry, at: Date): Promise<AuditEntry>;
  listAudit(limit: number): Promise<AuditEntry[]>;
}
