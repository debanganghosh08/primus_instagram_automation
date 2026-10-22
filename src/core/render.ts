/**
 * Turning a rule into the exact text we send. Kept separate so the operator can
 * see, in one short file, every string that can reach their audience.
 */
import type { ResourcePayload, Rule } from '../types.js';

/** Instagram/Messenger button-template text limit. */
export const MAX_MESSAGE_TEXT = 640;

export function clampText(text: string, max = MAX_MESSAGE_TEXT): string {
  const flat = text.trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The first DM: the prompt that carries the button. Never the resource. */
export function renderPrompt(rule: Rule): string {
  return clampText(rule.dmPromptText);
}

/** "Follow first, then tap again." */
export function renderGate(rule: Rule): string {
  return clampText(rule.gateMessage);
}

/**
 * Shown when the profile API says consent is not granted yet. Consent comes
 * from the person's own tap, so the only thing to do is ask for one.
 */
export function renderReprompt(rule: Rule): string {
  return clampText(`${rule.dmPromptText}\n\n(Tap the button once more and it'll come through.)`);
}

/** The resource itself: text, then the link on its own line. */
export function renderResource(payload: ResourcePayload): string {
  const parts = [payload.text.trim()].filter((p) => p !== '');
  if (payload.url && payload.url.trim() !== '') parts.push(payload.url.trim());
  return clampText(parts.join('\n\n'));
}

export function renderFollowUp(payload: ResourcePayload): string | null {
  if (!payload.followUp || payload.followUp.trim() === '') return null;
  return clampText(payload.followUp);
}

export function renderButtonLabel(rule: Rule): string {
  // Meta's guidance is to keep button titles under ~20 characters.
  return clampText(rule.buttonLabel || 'Send it to me', 20);
}
