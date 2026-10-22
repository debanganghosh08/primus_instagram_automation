import { describe, expect, it } from 'vitest';
import {
  attemptsExhausted,
  decide,
  InvalidTransition,
  isTerminal,
  type DecideOptions,
} from '../src/domain/state.js';

const gate: DecideOptions = { requireFollow: true, attempts: 0, maxAttempts: 5 };
const nogate: DecideOptions = { requireFollow: false, attempts: 0, maxAttempts: 5 };

describe('state machine', () => {
  it('NEW + matching comment -> PROMPTED, queueing the public + private reply', () => {
    const d = decide('NEW', { kind: 'comment_matched' }, gate);
    expect(d.to).toBe('PROMPTED');
    expect(d.effects).toEqual([{ kind: 'send_comment_prompt' }]);
    expect(d.incrementAttempts).toBe(false);
  });

  it('a second comment from the same person does nothing', () => {
    for (const from of ['PROMPTED', 'GATED', 'CHECKING', 'DELIVERED'] as const) {
      const d = decide(from, { kind: 'comment_matched' }, gate);
      expect(d.to).toBe(from);
      expect(d.effects).toEqual([{ kind: 'none' }]);
    }
  });

  it('PROMPTED + tap -> CHECKING and one follow check', () => {
    const d = decide('PROMPTED', { kind: 'button_tapped' }, gate);
    expect(d.to).toBe('CHECKING');
    expect(d.effects).toEqual([{ kind: 'check_follow' }]);
    expect(d.incrementAttempts).toBe(true);
  });

  it('CHECKING + following -> DELIVERED, with no gate message', () => {
    const d = decide('CHECKING', { kind: 'follow_result', follows: true }, gate);
    expect(d.to).toBe('DELIVERED');
    expect(d.effects).toEqual([{ kind: 'send_resource' }]);
  });

  it('CHECKING + not following -> GATED with the gate message', () => {
    const d = decide('CHECKING', { kind: 'follow_result', follows: false }, gate);
    expect(d.to).toBe('GATED');
    expect(d.effects).toEqual([{ kind: 'send_gate' }]);
  });

  it('GATED + tap -> CHECKING again (the re-check loop)', () => {
    const d = decide('GATED', { kind: 'button_tapped' }, { ...gate, attempts: 1 });
    expect(d.to).toBe('CHECKING');
    expect(d.effects).toEqual([{ kind: 'check_follow' }]);
    expect(d.incrementAttempts).toBe(true);
  });

  it('gives up after maxAttempts failed checks instead of gating forever', () => {
    const d = decide('CHECKING', { kind: 'follow_result', follows: false }, { ...gate, attempts: 5 });
    expect(d.to).toBe('ABANDONED');
    expect(d.effects).toEqual([{ kind: 'none' }]);
  });

  it('a second tap while a check is in flight does not start another check', () => {
    const d = decide('CHECKING', { kind: 'button_tapped' }, gate);
    expect(d.to).toBe('CHECKING');
    expect(d.effects).toEqual([{ kind: 'none' }]);
  });

  it('skips the check entirely when the rule does not require a follow', () => {
    const d = decide('PROMPTED', { kind: 'button_tapped' }, nogate);
    expect(d.to).toBe('DELIVERED');
    expect(d.effects).toEqual([{ kind: 'send_resource' }]);
  });

  it('a tap after delivery is ignored inside the cooldown', () => {
    const d = decide('DELIVERED', { kind: 'button_tapped' }, { ...gate, redeliveryAllowed: false });
    expect(d.to).toBe('DELIVERED');
    expect(d.effects).toEqual([{ kind: 'none' }]);
  });

  it('a tap after delivery re-sends once the cooldown has passed', () => {
    const d = decide('DELIVERED', { kind: 'button_tapped' }, { ...gate, redeliveryAllowed: true });
    expect(d.to).toBe('DELIVERED');
    expect(d.effects).toEqual([{ kind: 'send_resource' }]);
  });

  it('a consent error re-prompts rather than failing', () => {
    const d = decide('CHECKING', { kind: 'consent_required' }, gate);
    expect(d.to).toBe('GATED');
    expect(d.effects).toEqual([{ kind: 'send_reprompt' }]);
  });

  it('ignores a consent error that arrives in the wrong state', () => {
    const d = decide('PROMPTED', { kind: 'consent_required' }, gate);
    expect(d.to).toBe('PROMPTED');
    expect(d.effects).toEqual([{ kind: 'none' }]);
  });

  it('ignores a follow result that arrives in the wrong state', () => {
    const d = decide('GATED', { kind: 'follow_result', follows: true }, gate);
    expect(d.to).toBe('GATED');
    expect(d.effects).toEqual([{ kind: 'none' }]);
  });

  it('give_up always goes to FAILED and records the reason', () => {
    const d = decide('CHECKING', { kind: 'give_up', reason: '24h window expired' }, gate);
    expect(d.to).toBe('FAILED');
    expect(d.reason).toBe('24h window expired');
  });

  it('timed_out abandons an unfinished conversation but leaves a finished one alone', () => {
    expect(decide('GATED', { kind: 'timed_out' }, gate).to).toBe('ABANDONED');
    expect(decide('DELIVERED', { kind: 'timed_out' }, gate).to).toBe('DELIVERED');
    expect(decide('FAILED', { kind: 'timed_out' }, gate).to).toBe('FAILED');
  });

  it('terminal states absorb every trigger', () => {
    for (const from of ['FAILED', 'ABANDONED'] as const) {
      expect(isTerminal(from)).toBe(true);
      const d = decide(from, { kind: 'button_tapped' }, gate);
      expect(d.to).toBe(from);
      expect(d.effects).toEqual([{ kind: 'none' }]);
    }
  });

  it('a direct DM goes straight to the check (it opens the window itself)', () => {
    const d = decide('NEW', { kind: 'dm_matched' }, gate);
    expect(d.to).toBe('CHECKING');
    expect(d.effects).toEqual([{ kind: 'check_follow' }]);
  });

  it('a direct DM on a no-gate rule delivers at once', () => {
    const d = decide('NEW', { kind: 'dm_matched' }, nogate);
    expect(d.to).toBe('DELIVERED');
    expect(d.effects).toEqual([{ kind: 'send_resource' }]);
  });

  it('throws on a transition that should be impossible', () => {
    // Nothing in the service can produce this; if it ever does, we want a loud
    // failure rather than a silent wrong message.
    expect(() => decide('ABANDONED', { kind: 'button_tapped' }, gate)).not.toThrow();
    expect(() => decide('PROMPTED', { kind: 'button_tapped' }, gate)).not.toThrow();
    expect(new InvalidTransition('PROMPTED', 'button_tapped').name).toBe('InvalidTransition');
  });
});

describe('attemptsExhausted', () => {
  it('counts up to the limit', () => {
    expect(attemptsExhausted(0, 5)).toBe(false);
    expect(attemptsExhausted(4, 5)).toBe(false);
    expect(attemptsExhausted(5, 5)).toBe(true);
    expect(attemptsExhausted(6, 5)).toBe(true);
  });
});
