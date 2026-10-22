/**
 * Webhook authenticity.
 *
 * Meta signs every POST with HMAC-SHA256 of the *raw* request body using the
 * app secret, and sends it as `X-Hub-Signature-256: sha256=<hex>`.
 * Docs: https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
 *       https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
 *
 * Two things matter here and both are easy to get wrong:
 *  1. hash the raw bytes, not `JSON.stringify(parsedBody)` — key order and
 *     whitespace differ and the signature will never match;
 *  2. compare in constant time, so an attacker cannot learn the digest byte by
 *     byte from response timing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'mismatch';

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

const PREFIX = 'sha256=';

/** Hex digest of the raw body, without the `sha256=` prefix. */
export function computeSignature(rawBody: Buffer | string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

/** The full header value Meta would send for this body. Used by tests + the simulator. */
export function signatureHeader(rawBody: Buffer | string, appSecret: string): string {
  return PREFIX + computeSignature(rawBody, appSecret);
}

export function verifySignature(
  rawBody: Buffer | string,
  headerValue: string | undefined | null,
  appSecret: string,
): SignatureResult {
  if (headerValue === undefined || headerValue === null || headerValue === '') {
    return { ok: false, reason: 'missing_header' };
  }
  if (!headerValue.startsWith(PREFIX)) {
    return { ok: false, reason: 'malformed_header' };
  }
  const provided = headerValue.slice(PREFIX.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: 'malformed_header' };
  }
  const expected = computeSignature(rawBody, appSecret);
  // Both are 64 lowercase hex chars by construction, so the lengths always
  // match and timingSafeEqual cannot throw.
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/**
 * Constant-time string compare for the admin token and the webhook verify
 * token. Length is compared first (it leaks only the length, which is fine)
 * because timingSafeEqual requires equal-length buffers.
 */
export function secretEquals(a: string | undefined | null, b: string): boolean {
  if (typeof a !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
