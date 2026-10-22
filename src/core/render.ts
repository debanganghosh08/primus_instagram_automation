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

/**
 * The resource message. When the rule has a link, the link rides on a tappable
 * button (see renderResourceButton) rather than sitting in the text, so the
 * person taps once instead of copying a URL. With no link, the text is all
 * there is, so any URL in it is left in place.
 */
export function renderResource(payload: ResourcePayload): string {
  return clampText(payload.text.trim());
}

/** The button carrying the resource link, or null when the rule has no link. */
export function renderResourceButton(payload: ResourcePayload): { label: string; url: string } | null {
  const url = payload.url?.trim();
  if (!url) return null;
  return { label: clampText(payload.buttonLabel || 'Resource', 20), url };
}

export function renderFollowUp(payload: ResourcePayload): string | null {
  if (!payload.followUp || payload.followUp.trim() === '') return null;
  return clampText(payload.followUp);
}

export function renderButtonLabel(rule: Rule): string {
  // Meta's guidance is to keep button titles under ~20 characters.
  return clampText(rule.buttonLabel || 'Send it to me', 20);
}
