/**
 * The safety rails, as pure functions so they can be read and tested on their
 * own. Every one of these exists to stop the two failure modes that matter:
 * messaging someone twice, and failing to deliver something we promised.
 */
import { isMessageKind, type OutboxKind } from '../types.js';

/**
 * Deliveries bypass the per-contact cooldown and daily cap on purpose.
 *
 * The caps exist so one person spamming comments cannot be messaged over and
 * over. But if we have already told someone "tap the button and I'll send it",
 * silently swallowing the resource because of our own cap is worse than sending
 * one extra message. Prompts, gates and re-prompts are rate-limited; the
 * promised resource is not.
 */
export function bypassesContactCaps(kind: OutboxKind): boolean {
  return kind === 'resource' || kind === 'resource_followup';
}

/**
 * Is this a message the person did not just ask for?
 *
 * Only the first prompt is unsolicited: it is triggered by a comment, and a
 * comment is not a request for a DM. The gate, the re-prompt and the resource
 * are all answers to a button the person pressed seconds ago, so making them
 * wait out a cooldown would just look broken. The per-contact cooldown
 * therefore applies to the unsolicited kinds only.
 */
export function isUnsolicited(kind: OutboxKind): boolean {
  return kind === 'private_reply_prompt' || kind === 'dm_prompt';
}

export type SendGate =
  | { decision: 'send' }
  /** Try again later; this is not a failure and does not burn an attempt. */
  | { decision: 'defer'; retryAfterMs: number; reason: string }
  /** Stop. The row is failed with this reason and never retried. */
  | { decision: 'drop'; reason: string };

export interface WindowCheckInput {
  kind: OutboxKind;
  /**
   * When the permission to send started: the user's own action for a DM, the
   * comment's creation time for a private reply. NOT when we queued the row —
   * a row can sit in the queue across retries and deferrals.
   */
  windowOpenedAt: Date;
  now: Date;
  /** Standard messaging window for a normal DM. */
  messagingWindowHours: number;
  /** Meta allows a private reply within 7 days of the comment. */
  privateReplyMaxAgeHours: number;
}

/**
 * Has the permission to send this thing expired?
 *
 * A private reply is tied to the comment (7 days). A normal DM is tied to the
 * 24-hour window the person's own action opened. Rows can sit in the queue
 * across retries, so this is checked immediately before every send — sending
 * late would just earn error code 10 / subcode 2018278 anyway.
 */
export function checkSendWindow(input: WindowCheckInput): SendGate {
  const ageMs = input.now.getTime() - input.windowOpenedAt.getTime();
  if (input.kind === 'public_reply' || input.kind === 'follow_check') {
    return { decision: 'send' };
  }
  if (input.kind === 'private_reply_prompt') {
    const maxMs = input.privateReplyMaxAgeHours * 3_600_000;
    if (ageMs > maxMs) {
      return {
        decision: 'drop',
        reason: `private reply window expired: comment is older than ${input.privateReplyMaxAgeHours}h`,
      };
    }
    return { decision: 'send' };
  }
  const maxMs = input.messagingWindowHours * 3_600_000;
  if (ageMs > maxMs) {
    return {
      decision: 'drop',
      reason: `messaging window expired: no user action in the last ${input.messagingWindowHours}h`,
    };
  }
  return { decision: 'send' };
}

export interface CapCheckInput {
  kind: OutboxKind;
  now: Date;
  /** Messages sent account-wide in the last hour. */
  sentLastHour: number;
  maxPerHour: number;
  /** Messages sent to this person in the last 24 h. */
  sentToContactLast24h: number;
  maxPerContactPerDay: number;
  /** When we last messaged this person, if ever. */
  lastMessageToContactAt: Date | null;
  contactCooldownMinutes: number;
}

export function checkCaps(input: CapCheckInput): SendGate {
  // The caps count MESSAGES TO PEOPLE. A public comment reply and a profile
  // lookup are not messages, so they are not capped or cooled down here —
  // their cost is API quota, which the token-bucket limiter governs. Capping
  // the follow check would stall the gate without telling anyone.
  if (!isMessageKind(input.kind)) return { decision: 'send' };

  // The account hourly cap applies to every message, deliveries included: it
  // is there to protect the account itself. Deferring is safe — the window
  // check above drops the row if it ends up waiting too long.
  if (input.sentLastHour >= input.maxPerHour) {
    return {
      decision: 'defer',
      retryAfterMs: 60_000,
      reason: `account hourly cap reached (${input.sentLastHour}/${input.maxPerHour})`,
    };
  }

  if (bypassesContactCaps(input.kind)) return { decision: 'send' };

  if (input.sentToContactLast24h >= input.maxPerContactPerDay) {
    return {
      decision: 'drop',
      reason: `per-contact daily cap reached (${input.sentToContactLast24h}/${input.maxPerContactPerDay})`,
    };
  }

  if (isUnsolicited(input.kind) && input.lastMessageToContactAt && input.contactCooldownMinutes > 0) {
    const cooldownMs = input.contactCooldownMinutes * 60_000;
    const elapsed = input.now.getTime() - input.lastMessageToContactAt.getTime();
    if (elapsed < cooldownMs) {
      return {
        decision: 'defer',
        retryAfterMs: cooldownMs - elapsed,
        reason: `per-contact cooldown: ${Math.ceil((cooldownMs - elapsed) / 1000)}s left`,
      };
    }
  }

  return { decision: 'send' };
}

/**
 * May a fresh tap re-send the resource to someone who already has it?
 * Yes, but at most once per cooldown — otherwise a bored tester can make the
 * service DM them on a loop.
 */
export function redeliveryAllowed(
  deliveredAt: Date | null,
  now: Date,
  cooldownMinutes: number,
): boolean {
  if (deliveredAt === null) return true;
  if (cooldownMinutes <= 0) return true;
  return now.getTime() - deliveredAt.getTime() >= cooldownMinutes * 60_000;
}
