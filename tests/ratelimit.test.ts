import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/meta/ratelimit.js';

function bucket(perHour: number, burst: number) {
  let t = 1_000_000;
  const b = new TokenBucket({ perHour, burst, now: () => t });
  return { b, advance: (ms: number) => (t += ms) };
}

describe('token bucket rate limiter', () => {
  it('allows a burst, then refuses', () => {
    const { b } = bucket(3_600, 5);
    for (let i = 0; i < 5; i++) expect(b.tryRemove().allowed).toBe(true);
    const denied = b.tryRemove();
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time at the configured rate', () => {
    // 3600/hour = 1 per second.
    const { b, advance } = bucket(3_600, 2);
    expect(b.tryRemove().allowed).toBe(true);
    expect(b.tryRemove().allowed).toBe(true);
    expect(b.tryRemove().allowed).toBe(false);
    advance(1_000);
    expect(b.tryRemove().allowed).toBe(true);
    expect(b.tryRemove().allowed).toBe(false);
  });

  it('tells you roughly how long to wait', () => {
    const { b } = bucket(3_600, 1);
    expect(b.tryRemove().allowed).toBe(true);
    const denied = b.tryRemove();
    expect(denied.retryAfterMs).toBeGreaterThan(900);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1_000);
  });

  it('never accumulates more than the burst size', () => {
    const { b, advance } = bucket(3_600, 3);
    advance(60 * 60 * 1000);
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (b.tryRemove().allowed) allowed++;
    expect(allowed).toBe(3);
  });

  it('reports what is left, for the dashboard', () => {
    const { b } = bucket(600, 10);
    expect(Math.floor(b.available())).toBe(10);
    b.tryRemove();
    expect(Math.floor(b.available())).toBe(9);
  });

  it("defaults to Meta's documented order of magnitude without blowing past it", () => {
    // 750 private replies/hour/account is the documented ceiling; the default
    // config uses 600 so a burst cannot walk us into it.
    const { b, advance } = bucket(600, 20);
    let sent = 0;
    for (let minute = 0; minute < 60; minute++) {
      advance(60_000);
      for (let i = 0; i < 40; i++) if (b.tryRemove().allowed) sent++;
    }
    expect(sent).toBeLessThanOrEqual(620);
    expect(sent).toBeGreaterThan(500);
  });
});
