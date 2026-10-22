/**
 * The state machine, as a pure function. No DB, no Meta, no clock of its own.
 *
 *   NEW --prompt--> PROMPTED --tap--> CHECKING --follows--> DELIVERED
 *                                        |  ^
 *                           not following|  | taps again
 *                                        v  |
 *                                       GATED
 *
 * Terminals: DELIVERED (happy), FAILED (we gave up, reason recorded),
 * ABANDONED (the person never came back).
 *
 * `decide()` is the only place a transition is allowed to be invented. The
 * worker applies whatever it returns; tests drive it directly.
 */
import type { ConversationState } from '../types.js';

export type Trigger =
  /** A matching comment created the conversation. */
  | { kind: 'comment_matched' }
  /** A matching DM arrived (no comment) — the DM itself opens the window. */
  | { kind: 'dm_matched' }
  /** The person tapped our button. */
  | { kind: 'button_tapped' }
  /** The follow check came back. */
  | { kind: 'follow_result'; follows: boolean }
  /** The profile API refused: the person has not granted consent yet. */
  | { kind: 'consent_required' }
  /** Something unrecoverable (permission error, window closed, out of attempts). */
  | { kind: 'give_up'; reason: string }
  /** Housekeeping: nothing happened for too long. */
  | { kind: 'timed_out' };

export type Effect =
  /** Public reply under the comment + the one private reply with the button. */
  | { kind: 'send_comment_prompt' }
  /** Button prompt as a normal DM. */
  | { kind: 'send_dm_prompt' }
  /** Call the profile API for is_user_follow_business. */
  | { kind: 'check_follow' }
  /** "Please follow, then tap again" + button. */
  | { kind: 'send_gate' }
  /** "Tap once more" — consent is granted by a tap, so ask for one. */
  | { kind: 'send_reprompt' }
  /** Deliver the goods. */
  | { kind: 'send_resource' }
  /** Deliberately do nothing (duplicate tap inside the cooldown, etc.). */
  | { kind: 'none' };

export interface Decision {
  to: ConversationState;
  reason: string;
  effects: Effect[];
  /** Add 1 to conversation.attempts (one follow check = one attempt). */
  incrementAttempts: boolean;
}

export interface DecideOptions {
  /** Rule setting: when false we never call the profile API and just deliver. */
  requireFollow: boolean;
  /** How many follow checks this conversation has already had. */
  attempts: number;
  /** Guard against an endless gate loop. */
  maxAttempts: number;
  /**
   * True when the conversation is already DELIVERED and the re-delivery
   * cooldown has elapsed, so a fresh tap may re-send the resource once.
   */
  redeliveryAllowed?: boolean;
}

export class InvalidTransition extends Error {
  constructor(
    readonly from: ConversationState,
    readonly trigger: Trigger['kind'],
  ) {
    super(`no transition from ${from} on ${trigger}`);
    this.name = 'InvalidTransition';
  }
}

const TERMINAL: ReadonlySet<ConversationState> = new Set(['FAILED', 'ABANDONED']);

export function isTerminal(state: ConversationState): boolean {
  return TERMINAL.has(state);
}

export function decide(
  from: ConversationState,
  trigger: Trigger,
  opts: DecideOptions,
): Decision {
  const noop = (reason: string): Decision => ({
    to: from,
    reason,
    effects: [{ kind: 'none' }],
    incrementAttempts: false,
  });

  if (trigger.kind === 'give_up') {
    return { to: 'FAILED', reason: trigger.reason, effects: [{ kind: 'none' }], incrementAttempts: false };
  }

  if (trigger.kind === 'timed_out') {
    if (from === 'DELIVERED' || isTerminal(from)) return noop('already settled');
    return { to: 'ABANDONED', reason: 'no activity before the abandon window elapsed', effects: [{ kind: 'none' }], incrementAttempts: false };
  }

  if (isTerminal(from)) {
    return noop(`conversation is ${from}; ignoring ${trigger.kind}`);
  }

  switch (trigger.kind) {
    case 'comment_matched': {
      if (from !== 'NEW') {
        // We already handled this person for this rule. Commenting again must
        // not produce a second DM.
        return noop(`comment ignored: conversation already ${from}`);
      }
      return {
        to: 'PROMPTED',
        reason: 'comment matched a rule; public reply + private reply with button queued',
        effects: [{ kind: 'send_comment_prompt' }],
        incrementAttempts: false,
      };
    }

    case 'dm_matched': {
      if (from !== 'NEW') return noop(`DM ignored: conversation already ${from}`);
      // A DM is itself a user-initiated interaction: the window is open and
      // consent is granted, so we can go straight to the follow check.
      if (!opts.requireFollow) {
        return {
          to: 'DELIVERED',
          reason: 'DM matched a rule with require_follow=false; delivering',
          effects: [{ kind: 'send_resource' }],
          incrementAttempts: false,
        };
      }
      return {
        to: 'CHECKING',
        reason: 'DM matched a rule; checking follow status',
        effects: [{ kind: 'check_follow' }],
        incrementAttempts: true,
      };
    }

    case 'button_tapped': {
      if (from === 'DELIVERED') {
        if (opts.redeliveryAllowed) {
          return {
            to: 'DELIVERED',
            reason: 're-sending the resource after the cooldown',
            effects: [{ kind: 'send_resource' }],
            incrementAttempts: false,
          };
        }
        return noop('already delivered and still inside the re-delivery cooldown');
      }
      if (from === 'CHECKING') {
        // A second tap while a check is in flight. One check is enough.
        return noop('a follow check is already in flight');
      }
      if (from !== 'PROMPTED' && from !== 'GATED' && from !== 'NEW') {
        throw new InvalidTransition(from, trigger.kind);
      }
      if (!opts.requireFollow) {
        return {
          to: 'DELIVERED',
          reason: 'rule does not require a follow; delivering',
          effects: [{ kind: 'send_resource' }],
          incrementAttempts: false,
        };
      }
      return {
        to: 'CHECKING',
        reason: 'button tapped; checking follow status',
        effects: [{ kind: 'check_follow' }],
        incrementAttempts: true,
      };
    }

    case 'follow_result': {
      if (from !== 'CHECKING') {
        return noop(`follow result arrived while ${from}; ignoring`);
      }
      if (trigger.follows) {
        return {
          to: 'DELIVERED',
          reason: 'is_user_follow_business = true; resource sent',
          effects: [{ kind: 'send_resource' }],
          incrementAttempts: false,
        };
      }
      if (attemptsExhausted(opts.attempts, opts.maxAttempts)) {
        // The person has been shown the gate this many times and still is not
        // following. Stop messaging them; they can tap again later and the
        // gate will have been reset only by an operator retry.
        return {
          to: 'ABANDONED',
          reason: `still not following after ${opts.attempts} checks; stopping`,
          effects: [{ kind: 'none' }],
          incrementAttempts: false,
        };
      }
      return {
        to: 'GATED',
        reason: 'is_user_follow_business = false; follow gate sent',
        effects: [{ kind: 'send_gate' }],
        incrementAttempts: false,
      };
    }

    case 'consent_required': {
      if (from !== 'CHECKING') return noop(`consent error while ${from}; ignoring`);
      return {
        to: 'GATED',
        reason: 'profile API needs user consent; asking for one more tap',
        effects: [{ kind: 'send_reprompt' }],
        incrementAttempts: false,
      };
    }
  }
}

/**
 * Should we still be talking to this person, or have we looped enough?
 * Called before `decide({kind:'button_tapped'})`.
 */
export function attemptsExhausted(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}
