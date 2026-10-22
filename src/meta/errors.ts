/**
 * Classifying Meta's errors. This decides whether we retry, so getting it
 * wrong either spams the API or silently drops a promised resource.
 *
 * Codes confirmed against:
 *   https://developers.facebook.com/docs/messenger-platform/error-codes
 *   https://developers.facebook.com/docs/graph-api/guides/error-handling
 *
 * The categories:
 *   rate_limit       — slow down and retry later.         RETRY
 *   transient        — 5xx, timeouts, socket errors.      RETRY
 *   window_expired   — the 24 h messaging window closed.  NEVER RETRY
 *   consent_required — profile API before a user action.  NEVER RETRY (re-prompt)
 *   permission       — missing scope / app not approved.  NEVER RETRY
 *   invalid          — our request was wrong.             NEVER RETRY
 *   unknown          — anything we have not seen.         NEVER RETRY (fail loud)
 *
 * "Never retry" matters as much as "retry": blindly retrying a permission error
 * is how an app gets flagged.
 */
export type MetaErrorCategory =
  | 'rate_limit'
  | 'transient'
  | 'window_expired'
  | 'consent_required'
  | 'permission'
  | 'invalid'
  | 'unknown';

export interface MetaErrorBody {
  code?: number;
  subcode?: number;
  type?: string;
  message?: string;
  fbtrace_id?: string;
}

/** Rate limiting: application/account/page budget exhausted. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007]);
/** Missing permission, app not approved, or caller cannot act. */
const PERMISSION_CODES = new Set([10, 200, 190, 102, 230, 2500, 3]);
/** Subcodes of code 10 that specifically mean "outside the allowed window". */
const WINDOW_SUBCODES = new Set([2018278, 2534022, 2018065]);

export class MetaApiError extends Error {
  readonly category: MetaErrorCategory;
  readonly retryable: boolean;

  constructor(
    readonly httpStatus: number,
    readonly body: MetaErrorBody,
    readonly endpoint: string,
  ) {
    super(
      `Meta API ${endpoint} failed: HTTP ${httpStatus}` +
        (body.code !== undefined ? ` code=${body.code}` : '') +
        (body.subcode !== undefined ? ` subcode=${body.subcode}` : '') +
        (body.message ? ` "${body.message}"` : ''),
    );
    this.name = 'MetaApiError';
    this.category = classify(httpStatus, body);
    this.retryable = this.category === 'rate_limit' || this.category === 'transient';
  }

  /** Short string for `outbox.last_error` and the dashboard. Never a token. */
  summary(): string {
    const parts = [`${this.category}`, `http=${this.httpStatus}`];
    if (this.body.code !== undefined) parts.push(`code=${this.body.code}`);
    if (this.body.subcode !== undefined) parts.push(`subcode=${this.body.subcode}`);
    if (this.body.message) parts.push(`msg=${this.body.message.slice(0, 160)}`);
    if (this.body.fbtrace_id) parts.push(`fbtrace=${this.body.fbtrace_id}`);
    return parts.join(' ');
  }
}

/** A network failure — no HTTP response at all. Always retryable. */
export class MetaTransportError extends Error {
  readonly category: MetaErrorCategory = 'transient';
  readonly retryable = true;

  readonly reason: unknown;

  constructor(
    readonly endpoint: string,
    reason: unknown,
  ) {
    super(`Meta API ${endpoint} transport failure: ${describe(reason)}`);
    this.name = 'MetaTransportError';
    this.reason = reason;
  }

  summary(): string {
    return `transient transport ${describe(this.reason).slice(0, 160)}`;
  }
}

export type MetaError = MetaApiError | MetaTransportError;

export function isMetaError(e: unknown): e is MetaError {
  return e instanceof MetaApiError || e instanceof MetaTransportError;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

export function classify(httpStatus: number, body: MetaErrorBody): MetaErrorCategory {
  const { code, subcode, message } = body;
  const text = (message ?? '').toLowerCase();

  if (httpStatus === 429) return 'rate_limit';
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) return 'rate_limit';
  if (/rate limit|request limit reached|exceeded the rate/.test(text)) return 'rate_limit';

  // The 24-hour messaging window. Meta reports it as code 10 with one of
  // several subcodes; the message text is identical in all of them.
  if (subcode !== undefined && WINDOW_SUBCODES.has(subcode)) return 'window_expired';
  if (/outside of allowed window|outside the allowed window/.test(text)) return 'window_expired';

  // Profile API before the person has messaged us / tapped anything.
  // Documented as "User consent is required to access user profile"; reported
  // in the wild as code 230 (see docs/API_NOTES.md).
  if (/user consent is required/.test(text)) return 'consent_required';
  if (code === 230 && /consent/.test(text)) return 'consent_required';

  if (httpStatus >= 500 || httpStatus === 408) return 'transient';
  if (code !== undefined && PERMISSION_CODES.has(code)) return 'permission';
  if (/permission|not authorized|access token|cannot message users who are not/.test(text)) {
    return 'permission';
  }
  if (httpStatus === 400 && code === 100) return 'invalid';
  if (httpStatus >= 400 && httpStatus < 500) return 'invalid';
  return 'unknown';
}

/**
 * Parse Meta's error envelope: `{"error": {...}}`. Anything else becomes an
 * empty body, which classify() will treat by HTTP status alone.
 */
export function parseErrorBody(raw: unknown): MetaErrorBody {
  if (typeof raw !== 'object' || raw === null) return {};
  const outer = raw as Record<string, unknown>;
  const err = typeof outer.error === 'object' && outer.error !== null ? (outer.error as Record<string, unknown>) : outer;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const body: MetaErrorBody = {};
  const code = num(err.code);
  if (code !== undefined) body.code = code;
  const subcode = num(err.error_subcode) ?? num(err.subcode);
  if (subcode !== undefined) body.subcode = subcode;
  const type = str(err.type);
  if (type !== undefined) body.type = type;
  const message = str(err.message);
  if (message !== undefined) body.message = message;
  const trace = str(err.fbtrace_id);
  if (trace !== undefined) body.fbtrace_id = trace;
  return body;
}
