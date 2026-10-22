/**
 * Structured JSON logging with hard redaction.
 *
 * Rule: a token, a signature or the full text of a message must never reach the
 * log. Redaction is done by pino's `redact` (so it also covers objects we pass
 * through by accident) plus the helpers below for the places we build strings.
 */
import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

const REDACTED = '[redacted]';

export function createLogger(cfg: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: cfg.LOG_LEVEL,
    base: { service: 'comment-to-dm' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'access_token',
        'accessToken',
        'IG_ACCESS_TOKEN',
        'APP_SECRET',
        'ADMIN_TOKEN',
        'VERIFY_TOKEN',
        'authorization',
        'headers.authorization',
        'headers["x-hub-signature-256"]',
        'signature',
        'token',
        'message.text',
        'request.message',
        'req.headers.authorization',
        '*.access_token',
        '*.message.text',
      ],
      censor: REDACTED,
    },
  });
}

/** For log lines that must mention a message without leaking it. */
export function previewText(text: string | null | undefined, max = 24): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}...(${flat.length} chars)`;
}

/** Only the shape of a secret, never the secret. */
export function fingerprint(secret: string | undefined): string {
  if (!secret) return 'absent';
  return `len=${secret.length}`;
}
