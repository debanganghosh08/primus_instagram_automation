import { describe, expect, it } from 'vitest';
import {
  bypassesContactCaps,
  checkCaps,
  checkSendWindow,
  isUnsolicited,
  redeliveryAllowed,
} from '../src/core/guards.js';

const now = new Date('2026-03-01T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe('send windows', () => {
  it('lets a public reply through at any age', () => {
    expect(checkSendWindow({
      kind: 'public_reply',
      windowOpenedAt: hoursAgo(1_000),
      now,
      messagingWindowHours: 24,
      privateReplyMaxAgeHours: 168,
    })).toEqual({ decision: 'send' });
  });

  it('allows a private reply inside 7 days and drops it after', () => {
    const base = { now, messagingWindowHours: 24, privateReplyMaxAgeHours: 168 } as const;
    expect(
      checkSendWindow({ ...base, kind: 'private_reply_prompt', windowOpenedAt: hoursAgo(167) }).decision,
    ).toBe('send');
    const late = checkSendWindow({
      ...base,
      kind: 'private_reply_prompt',
      windowOpenedAt: hoursAgo(169),
    });
    expect(late.decision).toBe('drop');
    expect(late.decision === 'drop' && late.reason).toContain('private reply window expired');
  });

  it('drops a normal DM once the 24-hour window has passed', () => {
    const base = { now, messagingWindowHours: 24, privateReplyMaxAgeHours: 168 } as const;
    expect(checkSendWindow({ ...base, kind: 'resource', windowOpenedAt: hoursAgo(23) }).decision).toBe('send');
    const late = checkSendWindow({ ...base, kind: 'resource', windowOpenedAt: hoursAgo(25) });
    expect(late.decision).toBe('drop');
    expect(late.decision === 'drop' && late.reason).toContain('messaging window expired');
  });

  it('applies the same window to gates and re-prompts', () => {
    for (const kind of ['gate_message', 'reprompt', 'dm_prompt'] as const) {
      expect(
        checkSendWindow({
          kind,
          windowOpenedAt: hoursAgo(30),
          now,
          messagingWindowHours: 24,
          privateReplyMaxAgeHours: 168,
        }).decision,
      ).toBe('drop');
    }
  });
});

describe('caps and cooldowns', () => {
  const base = {
    now,
    sentLastHour: 0,
    maxPerHour: 100,
    sentToContactLast24h: 0,
    maxPerContactPerDay: 3,
    lastMessageToContactAt: null,
    contactCooldownMinutes: 10,
  };

  it('sends when nothing is in the way', () => {
    expect(checkCaps({ ...base, kind: 'gate_message' })).toEqual({ decision: 'send' });
  });

  it('defers everything when the account hourly cap is hit', () => {
    const r = checkCaps({ ...base, kind: 'resource', sentLastHour: 100 });
    expect(r.decision).toBe('defer');
    expect(r.decision === 'defer' && r.reason).toContain('hourly cap');
  });

  it('drops a prompt when the per-contact daily cap is hit', () => {
    const r = checkCaps({ ...base, kind: 'gate_message', sentToContactLast24h: 3 });
    expect(r.decision).toBe('drop');
  });

  it('still delivers the promised resource past the per-contact cap', () => {
    // Deliberate: silently swallowing a resource we promised is worse than one
    // extra message.
    expect(bypassesContactCaps('resource')).toBe(true);
    expect(bypassesContactCaps('resource_followup')).toBe(true);
    expect(bypassesContactCaps('gate_message')).toBe(false);
    expect(
      checkCaps({ ...base, kind: 'resource', sentToContactLast24h: 99 }),
    ).toEqual({ decision: 'send' });
  });

  it('defers an unsolicited prompt inside the per-contact cooldown and reports the wait', () => {
    const r = checkCaps({
      ...base,
      kind: 'private_reply_prompt',
      lastMessageToContactAt: new Date(now.getTime() - 4 * 60_000),
      contactCooldownMinutes: 10,
    });
    expect(r.decision).toBe('defer');
    expect(r.decision === 'defer' && r.retryAfterMs).toBe(6 * 60_000);
  });

  it('sends once the cooldown has elapsed', () => {
    expect(
      checkCaps({
        ...base,
        kind: 'private_reply_prompt',
        lastMessageToContactAt: new Date(now.getTime() - 11 * 60_000),
      }),
    ).toEqual({ decision: 'send' });
  });

  it('a zero cooldown disables the cooldown', () => {
    expect(
      checkCaps({
        ...base,
        kind: 'private_reply_prompt',
        lastMessageToContactAt: now,
        contactCooldownMinutes: 0,
      }),
    ).toEqual({ decision: 'send' });
  });

  it('never cools down a reply to the person\'s own tap', () => {
    // They pressed the button one second ago; making them wait would just look
    // broken. Only the unsolicited first prompt is cooled down.
    expect(isUnsolicited('private_reply_prompt')).toBe(true);
    expect(isUnsolicited('dm_prompt')).toBe(true);
    for (const kind of ['gate_message', 'reprompt', 'resource', 'resource_followup'] as const) {
      expect(isUnsolicited(kind)).toBe(false);
      expect(
        checkCaps({ ...base, kind, lastMessageToContactAt: now, contactCooldownMinutes: 60 }),
      ).toEqual({ decision: 'send' });
    }
  });

  it('does not cap or cool down calls that are not messages to a person', () => {
    for (const kind of ['follow_check', 'public_reply'] as const) {
      expect(
        checkCaps({
          ...base,
          kind,
          sentLastHour: 9_999,
          sentToContactLast24h: 9_999,
          lastMessageToContactAt: now,
        }),
      ).toEqual({ decision: 'send' });
    }
  });
});

describe('redelivery cooldown', () => {
  it('allows a first delivery', () => {
    expect(redeliveryAllowed(null, now, 10)).toBe(true);
  });
  it('blocks a re-send inside the cooldown', () => {
    expect(redeliveryAllowed(new Date(now.getTime() - 60_000), now, 10)).toBe(false);
  });
  it('allows a re-send after the cooldown', () => {
    expect(redeliveryAllowed(new Date(now.getTime() - 11 * 60_000), now, 10)).toBe(true);
  });
  it('a zero cooldown allows every re-send', () => {
    expect(redeliveryAllowed(now, now, 0)).toBe(true);
  });
});

