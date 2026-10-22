import { describe, expect, it } from 'vitest';
import { matchesKeyword, pickPublicReply, safeRegex, selectRule } from '../src/domain/rules.js';
import type { Rule } from '../src/types.js';

function rule(overrides: Partial<Rule> & { id: string }): Rule {
  return {
    name: overrides.id,
    enabled: true,
    scope: 'global',
    igMediaId: null,
    matchType: 'contains',
    keywords: ['guide'],
    caseInsensitive: true,
    publicReplyVariants: ['Sent you a DM ✅'],
    dmPromptText: 'prompt',
    buttonLabel: 'Send it',
    gateMessage: 'gate',
    resourcePayload: { text: 'resource' },
    requireFollow: true,
    priority: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('matchesKeyword', () => {
  describe('exact', () => {
    it('matches the whole comment only', () => {
      expect(matchesKeyword('exact', 'guide', ['guide'], true)).toBe('guide');
      expect(matchesKeyword('exact', '  GUIDE  ', ['guide'], true)).toBe('guide');
      expect(matchesKeyword('exact', 'send guide', ['guide'], true)).toBeNull();
    });
    it('respects case sensitivity', () => {
      expect(matchesKeyword('exact', 'GUIDE', ['guide'], false)).toBeNull();
      expect(matchesKeyword('exact', 'guide', ['guide'], false)).toBe('guide');
    });
  });

  describe('contains', () => {
    it('matches on a word boundary', () => {
      expect(matchesKeyword('contains', 'please send the guide', ['guide'], true)).toBe('guide');
      expect(matchesKeyword('contains', 'GUIDE!!! 🙏', ['guide'], true)).toBe('guide');
      expect(matchesKeyword('contains', 'guide', ['guide'], true)).toBe('guide');
    });
    it('does not match inside a longer word', () => {
      expect(matchesKeyword('contains', 'guidelines please', ['guide'], true)).toBeNull();
      expect(matchesKeyword('contains', 'misguided', ['guide'], true)).toBeNull();
    });
    it('tries every keyword and reports which one fired', () => {
      expect(matchesKeyword('contains', 'send me the link', ['guide', 'link'], true)).toBe('link');
    });
    it('handles multi-word keywords', () => {
      expect(matchesKeyword('contains', 'yes send me the pdf now', ['send me'], true)).toBe('send me');
    });
  });

  describe('regex', () => {
    it('matches a pattern', () => {
      expect(matchesKeyword('regex', 'GUIDE pls', ['^guide\\b'], true)).toBe('^guide\\b');
      expect(matchesKeyword('regex', 'pls guide', ['^guide\\b'], true)).toBeNull();
    });
    it('honours case sensitivity', () => {
      expect(matchesKeyword('regex', 'GUIDE', ['^guide$'], false)).toBeNull();
      expect(matchesKeyword('regex', 'GUIDE', ['^guide$'], true)).toBe('^guide$');
    });
    it('never throws on an invalid pattern', () => {
      expect(safeRegex('([', true)).toBeNull();
      expect(matchesKeyword('regex', 'anything', ['(['], true)).toBeNull();
    });
  });

  describe('any', () => {
    it('matches everything, including an empty comment', () => {
      expect(matchesKeyword('any', '', [], true)).toBe('*');
      expect(matchesKeyword('any', 'literally anything', [], true)).toBe('*');
    });
  });

  it('never matches an empty comment for the text-based types', () => {
    expect(matchesKeyword('contains', '   ', ['guide'], true)).toBeNull();
    expect(matchesKeyword('exact', '', ['guide'], true)).toBeNull();
  });

  it('ignores empty keywords', () => {
    expect(matchesKeyword('contains', 'hello', ['', '  '], true)).toBeNull();
  });
});

describe('selectRule', () => {
  it('ignores disabled rules', () => {
    const rules = [rule({ id: 'a', enabled: false })];
    expect(selectRule(rules, { text: 'guide', mediaId: 'm1' })).toBeNull();
  });

  it('matches a post-scoped rule only on its own media', () => {
    const rules = [rule({ id: 'post', scope: 'post', igMediaId: 'm1' })];
    expect(selectRule(rules, { text: 'guide', mediaId: 'm1' })?.rule.id).toBe('post');
    expect(selectRule(rules, { text: 'guide', mediaId: 'm2' })).toBeNull();
    expect(selectRule(rules, { text: 'guide', mediaId: null })).toBeNull();
  });

  it('prefers the higher priority rule', () => {
    const rules = [
      rule({ id: 'low', priority: 0 }),
      rule({ id: 'high', priority: 10 }),
    ];
    expect(selectRule(rules, { text: 'guide', mediaId: 'm1' })?.rule.id).toBe('high');
  });

  it('prefers the post-scoped rule at equal priority', () => {
    const rules = [
      rule({ id: 'global', scope: 'global' }),
      rule({ id: 'post', scope: 'post', igMediaId: 'm1' }),
    ];
    expect(selectRule(rules, { text: 'guide', mediaId: 'm1' })?.rule.id).toBe('post');
  });

  it('breaks remaining ties by age, so behaviour is stable', () => {
    const rules = [
      rule({ id: 'newer', createdAt: new Date('2026-02-01T00:00:00Z') }),
      rule({ id: 'older', createdAt: new Date('2026-01-01T00:00:00Z') }),
    ];
    expect(selectRule(rules, { text: 'guide', mediaId: 'm1' })?.rule.id).toBe('older');
  });

  it('returns null when nothing matches', () => {
    const rules = [rule({ id: 'a', keywords: ['guide'] })];
    expect(selectRule(rules, { text: 'nice reel bro', mediaId: 'm1' })).toBeNull();
  });
});

describe('pickPublicReply', () => {
  it('is deterministic for the same comment, so a replay says the same thing', () => {
    const r = rule({ id: 'a', publicReplyVariants: ['one', 'two', 'three'] });
    expect(pickPublicReply(r, 'comment_1')).toBe(pickPublicReply(r, 'comment_1'));
  });

  it('spreads across the variants', () => {
    const r = rule({ id: 'a', publicReplyVariants: ['one', 'two', 'three'] });
    const seen = new Set<string | null>();
    for (let i = 0; i < 60; i++) seen.add(pickPublicReply(r, `comment_${i}`));
    expect(seen.size).toBeGreaterThan(1);
    for (const v of seen) expect(['one', 'two', 'three']).toContain(v);
  });

  it('returns null when there is nothing to say', () => {
    expect(pickPublicReply(rule({ id: 'a', publicReplyVariants: [] }), 'c')).toBeNull();
    expect(pickPublicReply(rule({ id: 'a', publicReplyVariants: ['', '  '] }), 'c')).toBeNull();
  });
});
