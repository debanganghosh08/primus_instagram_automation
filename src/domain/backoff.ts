/**
 * Retry timing: exponential backoff with full jitter, capped.
 *
 *   delay(attempt) = random(0, min(base * 2^(attempt-1), max))
 *
 * Full jitter (rather than `delay/2 + random(delay/2)`) is deliberate: if the
 * account gets rate limited, every queued row would otherwise retry in the
 * same instant and trip the limit again.
 *
 * `attempt` is 1 for the first retry. The jitter source is injectable so tests
 * can assert on exact numbers.
 */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Returns a number in [0, 1). Defaults to Math.random. */
  random?: () => number;
}

/** The ceiling for this attempt, before jitter. Deterministic — easy to test. */
export function backoffCeilingMs(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt < 1) return 0;
  // 2^30 is already far beyond maxMs for any sane base, and avoids Infinity.
  const exponent = Math.min(attempt - 1, 30);
  const raw = baseMs * 2 ** exponent;
  return Math.min(raw, maxMs);
}

export function backoffDelayMs(attempt: number, opts: BackoffOptions): number {
  const ceiling = backoffCeilingMs(attempt, opts.baseMs, opts.maxMs);
  const random = opts.random ?? Math.random;
  return Math.floor(random() * ceiling);
}

export function nextAttemptAt(now: Date, attempt: number, opts: BackoffOptions): Date {
  return new Date(now.getTime() + backoffDelayMs(attempt, opts));
}
