/**
 * Turn a Meta webhook notification into zero or more normalised InboundEvents.
 *
 * Docs (payload shapes, confirmed 2026-10-22):
 *   https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
 *
 * Two layouts exist and we accept both, because which one you get depends on
 * how the app logs in:
 *   - Business Login for Instagram: `field` and `value` sit directly on the
 *     entry (no `changes` array).
 *   - Facebook Login for Business: the entry carries a `changes[]` array, and
 *     the comment value uses `comment_id`/`parent_id` instead of `id`.
 * Messaging events (`messages`, `messaging_postbacks`) always arrive in
 * `entry[].messaging[]` and carry no `field`.
 *
 * Parsing never throws on junk: unknown shapes are returned as warnings so the
 * webhook can still answer 200 and we can see them in the log.
 */
import { z } from 'zod';
import type { InboundEvent } from '../types.js';

const commentValue = z.object({
  // Instagram Login uses `id`; Facebook Login uses `comment_id`.
  id: z.string().optional(),
  comment_id: z.string().optional(),
  parent_id: z.string().optional(),
  text: z.string().optional(),
  from: z.object({ id: z.string(), username: z.string().optional() }).optional(),
  media: z
    .object({ id: z.string().optional(), media_product_type: z.string().optional() })
    .optional(),
});

const messagingItem = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }).optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  message: z
    .object({
      mid: z.string(),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      is_deleted: z.boolean().optional(),
      is_self: z.boolean().optional(),
      is_unsupported: z.boolean().optional(),
    })
    .optional(),
  postback: z
    .object({
      mid: z.string().optional(),
      title: z.string().optional(),
      payload: z.string().optional(),
    })
    .optional(),
});

const entrySchema = z.object({
  id: z.string().optional(),
  time: z.union([z.number(), z.string()]).optional(),
  field: z.string().optional(),
  value: z.unknown().optional(),
  changes: z
    .array(z.object({ field: z.string(), value: z.unknown() }))
    .optional(),
  messaging: z.array(z.unknown()).optional(),
});

export const webhookEnvelope = z.object({
  object: z.string().optional(),
  entry: z.array(entrySchema).default([]),
});

export type WebhookEnvelope = z.infer<typeof webhookEnvelope>;

export interface ParseResult {
  events: InboundEvent[];
  /** Human-readable notes about anything we deliberately dropped. */
  warnings: string[];
}

function toDate(value: number | string | undefined, fallback: Date): Date {
  if (value === undefined) return fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return fallback;
  // Meta sends seconds at the entry level and milliseconds on messaging items.
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function parseComment(value: unknown, at: Date, raw: unknown, warnings: string[]): InboundEvent | null {
  const parsed = commentValue.safeParse(value);
  if (!parsed.success) {
    warnings.push('comment value did not match the expected shape');
    return null;
  }
  const v = parsed.data;
  const commentId = v.id ?? v.comment_id;
  if (!commentId) {
    warnings.push('comment notification without a comment id');
    return null;
  }
  if (!v.from?.id) {
    // Happens for comments by the account owner on some setups, and for
    // notifications where the author is hidden. Nothing we can act on.
    warnings.push(`comment ${commentId} has no author id`);
    return null;
  }
  return {
    providerEventId: `comment:${commentId}`,
    type: 'comment',
    igsid: v.from.id,
    username: v.from.username ?? null,
    commentId,
    mediaId: v.media?.id ?? null,
    text: v.text ?? '',
    postbackPayload: null,
    occurredAt: at,
    raw,
  };
}

export function parseWebhook(body: unknown, now = new Date()): ParseResult {
  const warnings: string[] = [];
  const envelope = webhookEnvelope.safeParse(body);
  if (!envelope.success) {
    return { events: [], warnings: ['body is not a webhook envelope'] };
  }
  if (envelope.data.object && envelope.data.object !== 'instagram') {
    warnings.push(`ignoring notification for object "${envelope.data.object}"`);
    return { events: [], warnings };
  }

  const events: InboundEvent[] = [];

  for (const entry of envelope.data.entry) {
    const entryAt = toDate(entry.time, now);

    // --- comments: `field`/`value` on the entry (Instagram Login) -----------
    if (entry.field === 'comments' && entry.value !== undefined) {
      const ev = parseComment(entry.value, entryAt, entry, warnings);
      if (ev) events.push(ev);
    } else if (entry.field && entry.field !== 'comments' && entry.value !== undefined) {
      warnings.push(`ignoring unsubscribed field "${entry.field}"`);
    }

    // --- comments: `changes[]` (Facebook Login) -----------------------------
    for (const change of entry.changes ?? []) {
      if (change.field === 'comments') {
        const ev = parseComment(change.value, entryAt, change, warnings);
        if (ev) events.push(ev);
      } else {
        warnings.push(`ignoring unsubscribed field "${change.field}"`);
      }
    }

    // --- messaging: messages + messaging_postbacks --------------------------
    for (const item of entry.messaging ?? []) {
      const parsed = messagingItem.safeParse(item);
      if (!parsed.success) {
        warnings.push('messaging item did not match the expected shape');
        continue;
      }
      const m = parsed.data;
      const at = toDate(m.timestamp, entryAt);

      if (m.postback) {
        const mid = m.postback.mid;
        if (!mid) {
          warnings.push('postback without a mid; cannot de-duplicate it');
          continue;
        }
        events.push({
          providerEventId: `postback:${mid}`,
          type: 'postback',
          igsid: m.sender.id,
          username: null,
          commentId: null,
          mediaId: null,
          text: m.postback.title ?? null,
          postbackPayload: m.postback.payload ?? null,
          occurredAt: at,
          raw: item,
        });
        continue;
      }

      if (m.message) {
        if (m.message.is_echo || m.message.is_self) {
          // Our own outbound message echoed back. Acting on it would loop.
          continue;
        }
        if (m.message.is_deleted || m.message.is_unsupported) {
          warnings.push(`message ${m.message.mid} is deleted/unsupported`);
          continue;
        }
        events.push({
          providerEventId: `message:${m.message.mid}`,
          type: 'message',
          igsid: m.sender.id,
          username: null,
          commentId: null,
          mediaId: null,
          text: m.message.text ?? '',
          postbackPayload: null,
          occurredAt: at,
          raw: item,
        });
      }
    }
  }

  return { events, warnings };
}
