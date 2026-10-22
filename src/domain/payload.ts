/**
 * Button postback payloads.
 *
 * The payload is the only thing that comes back from the user's tap, so it has
 * to carry everything we need: which action they took and which rule they are
 * in. Format: `ACTION:ruleId:nonce`.
 *
 * The nonce is random and is NOT a security token — a postback is already
 * authenticated by the webhook signature. It exists so that two buttons sent to
 * the same person for the same rule produce distinguishable taps in the logs.
 *
 * Messenger's postback payload is a short string, so keep it compact: the
 * documented guidance for button titles is under ~20 characters and payloads
 * are a "developer-defined" string with no published limit. We cap at 900
 * characters and reject anything longer rather than letting Meta truncate it.
 * Docs: https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/buttons
 */
import { randomBytes } from 'node:crypto';

export const BUTTON_ACTIONS = ['DELIVER', 'RECHECK'] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

export const MAX_PAYLOAD_LENGTH = 900;
/** Meta's own guidance for button titles. We warn, we do not truncate. */
export const RECOMMENDED_LABEL_LENGTH = 20;

export interface DecodedPayload {
  action: ButtonAction;
  ruleId: string;
  nonce: string;
}

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function makeNonce(bytes = 6): string {
  return randomBytes(bytes).toString('base64url');
}

export function encodePayload(
  action: ButtonAction,
  ruleId: string,
  nonce: string = makeNonce(),
): string {
  if (!SAFE_SEGMENT.test(ruleId)) {
    throw new PayloadError(`rule id "${ruleId}" is not payload-safe (allowed: A-Za-z0-9_-)`);
  }
  if (!SAFE_SEGMENT.test(nonce)) {
    throw new PayloadError('nonce is not payload-safe (allowed: A-Za-z0-9_-)');
  }
  const payload = `${action}:${ruleId}:${nonce}`;
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    throw new PayloadError(`payload is ${payload.length} chars, max ${MAX_PAYLOAD_LENGTH}`);
  }
  return payload;
}

/** Returns null for anything that is not one of our payloads (icebreakers, menus). */
export function decodePayload(payload: string | null | undefined): DecodedPayload | null {
  if (typeof payload !== 'string') return null;
  if (payload.length > MAX_PAYLOAD_LENGTH) return null;
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  const [action, ruleId, nonce] = parts;
  if (!action || !ruleId || !nonce) return null;
  if (!(BUTTON_ACTIONS as readonly string[]).includes(action)) return null;
  if (!SAFE_SEGMENT.test(ruleId) || !SAFE_SEGMENT.test(nonce)) return null;
  return { action: action as ButtonAction, ruleId, nonce };
}
