/**
 * Domain types shared by every layer.
 *
 * Read this file first: the whole service is "turn an inbound event into rows in
 * these shapes, then drain the outbox". Nothing here depends on Postgres, Meta
 * or Fastify.
 */

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RuleScope = 'global' | 'post';
export type MatchType = 'exact' | 'contains' | 'regex' | 'any';

/** What we send once the follow gate is satisfied. */
export interface ResourcePayload {
  /** The main message text. The link is appended by the renderer if present. */
  text: string;
  /** Optional link to the resource (Notion page, Drive file, landing page...). */
  url?: string;
  /** Optional second message sent right after the resource. */
  followUp?: string;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  scope: RuleScope;
  /** Only used when scope === 'post'. */
  igMediaId: string | null;
  matchType: MatchType;
  keywords: string[];
  caseInsensitive: boolean;
  /** Rotated so the comment section does not read like a robot. */
  publicReplyVariants: string[];
  /** First DM. Carries the button; never the resource (one private reply only). */
  dmPromptText: string;
  buttonLabel: string;
  /** Sent when the person does not follow yet. */
  gateMessage: string;
  resourcePayload: ResourcePayload;
  requireFollow: boolean;
  /** Higher wins when several rules match the same comment. */
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewRule = Omit<Rule, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface Contact {
  igsid: string;
  username: string | null;
  lastSeenAt: Date;
  followsCached: boolean | null;
  followsCheckedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Inbound events
// ---------------------------------------------------------------------------

export type InboundEventType = 'comment' | 'postback' | 'message';

export type EventStatus = 'pending' | 'processing' | 'done' | 'skipped' | 'error';

/** A webhook notification, normalised and de-duplicated. */
export interface InboundEvent {
  /**
   * Dedupe key. Meta retries webhooks; this is what makes processing
   * exactly-once. `comment:<id>`, `postback:<mid>`, `message:<mid>`.
   */
  providerEventId: string;
  type: InboundEventType;
  /** The Instagram-scoped id of the person who acted. */
  igsid: string;
  username: string | null;
  /** Comment id (comment events) — also the private-reply recipient. */
  commentId: string | null;
  /** Media (post/reel) the comment was left on. */
  mediaId: string | null;
  /** Comment text, message text, or the postback title. */
  text: string | null;
  /** Raw postback payload string (`ACTION:ruleId:nonce`). */
  postbackPayload: string | null;
  /** When the person acted, per Meta. */
  occurredAt: Date;
  /** The untouched notification, for debugging. */
  raw: unknown;
}

export interface StoredEvent extends InboundEvent {
  id: string;
  receivedAt: Date;
  processedAt: Date | null;
  status: EventStatus;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Conversations / the state machine
// ---------------------------------------------------------------------------

/**
 * NEW -> PROMPTED -> (GATED <-> CHECKING) -> DELIVERED
 * plus the terminals FAILED and ABANDONED.
 */
export type ConversationState =
  | 'NEW'
  | 'PROMPTED'
  | 'GATED'
  | 'CHECKING'
  | 'DELIVERED'
  | 'FAILED'
  | 'ABANDONED';

export interface Conversation {
  id: string;
  igsid: string;
  ruleId: string;
  state: ConversationState;
  /** How many follow checks this person has been through. */
  attempts: number;
  /** Last time anything happened here, ours or theirs. */
  lastActionAt: Date;
  /**
   * When the person last did something themselves (commented, tapped, DMed).
   * This — not our own activity — is what opens the 24-hour messaging window,
   * so it is what the send-window guard measures from.
   */
  windowOpenedAt: Date;
  /** When the resource was actually confirmed sent. Null until then. */
  deliveredAt: Date | null;
  commentId: string | null;
  /** Why we last moved. Shown in the dashboard. */
  lastReason: string | null;
  createdAt: Date;
}

export interface StateTransition {
  conversationId: string;
  from: ConversationState;
  to: ConversationState;
  reason: string;
  at: Date;
}

// ---------------------------------------------------------------------------
// Outbox — every outbound Meta call goes through here
// ---------------------------------------------------------------------------

export type OutboxKind =
  /** Public reply under the comment ("Sent you a DM"). */
  | 'public_reply'
  /** The one permitted private reply to a comment: text + button. */
  | 'private_reply_prompt'
  /** Same prompt, but as a normal DM (the "user DMed a keyword" path). */
  | 'dm_prompt'
  /** GET the profile to read is_user_follow_business. */
  | 'follow_check'
  /** "Please follow, then tap again" + button. */
  | 'gate_message'
  /** "Tap the button once more" — used when consent is not granted yet. */
  | 'reprompt'
  /** The actual resource. */
  | 'resource'
  /** Optional extra message after the resource. */
  | 'resource_followup';

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

/** The shapes the Meta client knows how to send. Discriminated, never `any`. */
export type OutboxRequest =
  | { op: 'comment_reply'; commentId: string; message: string }
  | { op: 'private_reply'; commentId: string; message: string; button?: ButtonSpec }
  | { op: 'dm'; igsid: string; message: string; button?: ButtonSpec }
  | { op: 'follow_check'; igsid: string };

export interface ButtonSpec {
  label: string;
  /** Encoded `ACTION:ruleId:nonce`. */
  payload: string;
}

/** Kinds that actually send a person a message (so they count against caps). */
export const MESSAGE_KINDS: readonly OutboxKind[] = [
  'private_reply_prompt',
  'dm_prompt',
  'gate_message',
  'reprompt',
  'resource',
  'resource_followup',
];

export function isMessageKind(kind: OutboxKind): boolean {
  return MESSAGE_KINDS.includes(kind);
}

export interface OutboxItem {
  id: string;
  conversationId: string | null;
  /** Who it is going to. Null for a public comment reply. */
  igsid: string | null;
  /**
   * When the permission to send this expired-from: the user action that opened
   * the window (a tap/DM) or the comment the private reply answers. Checked
   * immediately before every send, because rows can sit in the queue.
   */
  windowOpenedAt: Date;
  kind: OutboxKind;
  /**
   * Unique. Two attempts to enqueue the same logical send collapse into one
   * row — this is the last line of defence against messaging someone twice.
   */
  dedupeKey: string;
  request: OutboxRequest;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  /** Meta's id for the thing we created (message_id / comment id). */
  providerMessageId: string | null;
}

export interface NewOutboxItem {
  conversationId: string | null;
  igsid: string | null;
  /** Defaults to the enqueue time when omitted. */
  windowOpenedAt?: Date;
  kind: OutboxKind;
  dedupeKey: string;
  request: OutboxRequest;
  nextAttemptAt?: Date;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditDirection = 'inbound' | 'outbound' | 'internal';

export interface AuditEntry {
  id: string;
  at: Date;
  direction: AuditDirection;
  /** e.g. 'webhook.comment', 'meta.private_reply', 'state.DELIVERED'. */
  action: string;
  igsid: string | null;
  conversationId: string | null;
  /** Provider id involved (comment id, message id). Never a token. */
  providerId: string | null;
  status: string;
  detail: string | null;
}

export interface NewAuditEntry {
  direction: AuditDirection;
  action: string;
  igsid?: string | null;
  conversationId?: string | null;
  providerId?: string | null;
  status: string;
  detail?: string | null;
}
