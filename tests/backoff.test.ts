import { describe, expect, it } from 'vitest';
import { backoffCeilingMs, backoffDelayMs, nextAttemptAt } from '../src/domain/backoff.js';

describe('backoff maths', () => {
  it('doubles the ceiling each attempt', () => {
    expect(backoffCeilingMs(1, 2_000, 300_000)).toBe(2_000);
    expect(backoffCeilingMs(2, 2_000, 300_000)).toBe(4_000);
    expect(backoffCeilingMs(3, 2_000, 300_000)).toBe(8_000);
    expect(backoffCeilingMs(4, 2_000, 300_000)).toBe(16_000);
    expect(backoffCeilingMs(5, 2_000, 300_000)).toBe(32_000);
  });

  it('caps at maxMs', () => {
    expect(backoffCeilingMs(20, 2_000, 300_000)).toBe(300_000);
    expect(backoffCeilingMs(200, 2_000, 300_000)).toBe(300_000);
    expect(Number.isFinite(backoffCeilingMs(1_000_000, 2_000, 300_000))).toBe(true);
  });

  it('returns 0 for a nonsensical attempt number', () => {
    expect(backoffCeilingMs(0, 2_000, 300_000)).toBe(0);
    expect(backoffCeilingMs(-3, 2_000, 300_000)).toBe(0);
  });

  it('applies full jitter: every delay lands in [0, ceiling)', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const ceiling = backoffCeilingMs(attempt, 1_000, 60_000);
      for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const d = backoffDelayMs(attempt, { baseMs: 1_000, maxMs: 60_000, random: () => r });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(Math.max(ceiling, 1));
      }
    }
  });

  it('spreads retries out rather than bunching them (that is the point of jitter)', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 200; i++) {
      delays.add(backoffDelayMs(4, { baseMs: 1_000, maxMs: 60_000 }));
    }
    expect(delays.size).toBeGreaterThan(50);
  });

  it('nextAttemptAt moves the clock forward by the delay', () => {
    const now = new Date('2026-03-01T10:00:00.000Z');
    const at = nextAttemptAt(now, 3, { baseMs: 1_000, maxMs: 60_000, random: () => 0.5 });
    // ceiling for attempt 3 is 4000ms; 0.5 jitter -> 2000ms
    expect(at.getTime() - now.getTime()).toBe(2_000);
  });
});
