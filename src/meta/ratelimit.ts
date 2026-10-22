/**
 * Token-bucket limiter in front of the Meta client.
 *
 * Meta's documented budget for private replies is 750 calls per hour per
 * Instagram professional account (Instagram Platform overview, "Rate limits").
 * We default to 600/hour so a burst of comments cannot walk us into the real
 * ceiling, and the burst size caps how fast we can spend it.
 *
 * The clock is injectable: tests advance time instead of sleeping.
 */
export interface RateLimiterOptions {
  /** Sustained budget. */
  perHour: number;
  /** Bucket capacity — the most we will ever send back-to-back. */
  burst: number;
  now?: () => number;
}

export interface RateDecision {
  allowed: boolean;
  /** When a token will next be available, in ms from now. 0 when allowed. */
  retryAfterMs: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly refillPerMs: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions) {
    this.capacity = Math.max(1, opts.burst);
    this.refillPerMs = opts.perHour / 3_600_000;
    this.now = opts.now ?? Date.now;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = t;
  }

  /** Available tokens, for the dashboard. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Take one token if there is one. Never blocks. */
  tryRemove(): RateDecision {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const missing = 1 - this.tokens;
    const retryAfterMs = Math.max(1, Math.ceil(missing / this.refillPerMs));
    return { allowed: false, retryAfterMs };
  }
}
