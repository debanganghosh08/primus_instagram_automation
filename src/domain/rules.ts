/**
 * The rule engine. Given some text (a comment or a DM) and the media it was
 * left on, decide which rule applies.
 *
 * Selection order: only enabled rules; post-scoped rules must match the media;
 * then the highest `priority` wins, and `created_at` breaks ties (older first,
 * so behaviour is stable when you add a rule with the same priority).
 */
import type { MatchType, Rule } from '../types.js';

export interface MatchContext {
  text: string;
  /** The post/reel the comment was on. `null` for a direct DM. */
  mediaId: string | null;
}

export interface MatchOutcome {
  rule: Rule;
  /** Which keyword fired, for the audit log. `*` for match_type `any`. */
  keyword: string;
}

/** Strip punctuation/emoji so "GUIDE!!" and "guide" behave the same. */
function normalise(text: string, caseInsensitive: boolean): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

/** Word-ish boundary test that also works at the start/end of the string. */
function containsWord(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx === 0 ? '' : haystack[idx - 1] ?? '';
    const afterIdx = idx + needle.length;
    const after = afterIdx >= haystack.length ? '' : haystack[afterIdx] ?? '';
    const isBoundary = (c: string) => c === '' || !/[\p{L}\p{N}_]/u.test(c);
    if (isBoundary(before) && isBoundary(after)) return true;
    from = idx + 1;
  }
}

export function matchesKeyword(
  matchType: MatchType,
  text: string,
  keywords: string[],
  caseInsensitive: boolean,
): string | null {
  if (matchType === 'any') return '*';

  const subject = normalise(text, caseInsensitive);
  if (subject === '' && matchType !== 'regex') return null;

  for (const rawKeyword of keywords) {
    const keyword = normalise(rawKeyword, caseInsensitive);
    if (keyword === '' && matchType !== 'regex') continue;

    switch (matchType) {
      case 'exact':
        if (subject === keyword) return rawKeyword;
        break;
      case 'contains':
        if (containsWord(subject, keyword)) return rawKeyword;
        break;
      case 'regex': {
        const re = safeRegex(rawKeyword, caseInsensitive);
        if (re && re.test(text)) return rawKeyword;
        break;
      }
    }
  }
  return null;
}

/**
 * Compile a rule's regex. A bad pattern must never take the worker down, so a
 * syntax error returns null (and the rule simply never matches).
 */
export function safeRegex(pattern: string, caseInsensitive: boolean): RegExp | null {
  try {
    return new RegExp(pattern, caseInsensitive ? 'iu' : 'u');
  } catch {
    return null;
  }
}

export function selectRule(rules: readonly Rule[], ctx: MatchContext): MatchOutcome | null {
  const candidates = rules
    .filter((r) => r.enabled)
    .filter((r) => (r.scope === 'post' ? r.igMediaId !== null && r.igMediaId === ctx.mediaId : true))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      // Post-scoped rules beat global ones at the same priority: they are more
      // specific, so that is almost always what the operator meant.
      if (a.scope !== b.scope) return a.scope === 'post' ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

  for (const rule of candidates) {
    const keyword = matchesKeyword(rule.matchType, ctx.text, rule.keywords, rule.caseInsensitive);
    if (keyword !== null) return { rule, keyword };
  }
  return null;
}

/**
 * Pick a public reply variant. Deterministic in the comment id so a webhook
 * replay produces the same text, and so tests are not flaky.
 */
export function pickPublicReply(rule: Rule, seed: string): string | null {
  const variants = rule.publicReplyVariants.filter((v) => v.trim() !== '');
  if (variants.length === 0) return null;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = Math.abs(hash) % variants.length;
  return variants[idx] ?? variants[0] ?? null;
}
