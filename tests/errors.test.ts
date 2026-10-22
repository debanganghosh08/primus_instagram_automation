import { describe, expect, it } from 'vitest';
import { classify, MetaApiError, MetaTransportError, parseErrorBody } from '../src/meta/errors.js';
import { MockErrors } from '../src/testing/mock-meta.js';

describe('Meta error classification', () => {
  it('treats the documented rate-limit codes as retryable', () => {
    for (const code of [4, 17, 32, 613]) {
      expect(classify(400, { code })).toBe('rate_limit');
      expect(new MetaApiError(400, { code }, 'messages').retryable).toBe(true);
    }
    expect(classify(429, {})).toBe('rate_limit');
  });

  it('treats permission errors as never-retry', () => {
    for (const code of [10, 200, 190]) {
      const err = new MetaApiError(403, { code, message: 'nope' }, 'messages');
      // Code 10 only means "permission" when it is not a window subcode.
      if (code === 10) expect(err.category).toBe('permission');
      expect(err.retryable).toBe(false);
    }
  });

  it('recognises the 24-hour window error by subcode and by text', () => {
    for (const subcode of [2018278, 2534022, 2018065]) {
      expect(classify(400, { code: 10, subcode })).toBe('window_expired');
    }
    expect(classify(400, { code: 10, message: 'This message is sent outside of allowed window.' })).toBe(
      'window_expired',
    );
    expect(new MetaApiError(400, { code: 10, subcode: 2018278 }, 'messages').retryable).toBe(false);
  });

  it('recognises the profile consent error', () => {
    expect(
      classify(400, { code: 230, message: 'User consent is required to access user profile' }),
    ).toBe('consent_required');
    expect(classify(400, { message: 'user consent is required' })).toBe('consent_required');
  });

  it('treats 5xx as transient', () => {
    expect(classify(500, {})).toBe('transient');
    expect(classify(503, {})).toBe('transient');
    expect(classify(408, {})).toBe('transient');
    expect(new MetaApiError(500, {}, 'messages').retryable).toBe(true);
  });

  it('treats a plain 400 as invalid, not retryable', () => {
    expect(classify(400, { code: 100, message: 'The parameter message is required.' })).toBe('invalid');
    expect(new MetaApiError(400, { code: 100 }, 'messages').retryable).toBe(false);
  });

  it('classifies the mock error fixtures exactly as the docs describe them', () => {
    const cases: Array<[() => ReturnType<typeof MockErrors.rateLimit>, string]> = [
      [MockErrors.rateLimit, 'rate_limit'],
      [MockErrors.appRateLimit, 'rate_limit'],
      [MockErrors.windowExpired, 'window_expired'],
      [MockErrors.consentRequired, 'consent_required'],
      [MockErrors.noPermission, 'permission'],
      [MockErrors.serverError, 'transient'],
    ];
    for (const [make, expected] of cases) {
      const spec = make();
      const body = parseErrorBody({ error: spec.error });
      expect(classify(spec.status, body)).toBe(expected);
    }
  });

  it('parses the error envelope, subcode included', () => {
    const body = parseErrorBody({
      error: {
        message: 'oops',
        type: 'OAuthException',
        code: 10,
        error_subcode: 2018278,
        fbtrace_id: 'abc',
      },
    });
    expect(body).toEqual({
      message: 'oops',
      type: 'OAuthException',
      code: 10,
      subcode: 2018278,
      fbtrace_id: 'abc',
    });
  });

  it('survives a response that is not an error envelope', () => {
    expect(parseErrorBody(null)).toEqual({});
    expect(parseErrorBody('a string')).toEqual({});
    expect(parseErrorBody({ nope: 1 })).toEqual({});
  });

  it('a transport failure is always retryable', () => {
    const err = new MetaTransportError('messages', new Error('ECONNRESET'));
    expect(err.retryable).toBe(true);
    expect(err.category).toBe('transient');
    expect(err.summary()).toContain('ECONNRESET');
  });

  it('summaries carry the ids an operator needs and no secrets', () => {
    const summary = new MetaApiError(
      400,
      { code: 613, subcode: 2534040, message: 'Calls to this api have exceeded the rate limit.', fbtrace_id: 'xyz' },
      'messages',
    ).summary();
    expect(summary).toContain('rate_limit');
    expect(summary).toContain('code=613');
    expect(summary).toContain('subcode=2534040');
    expect(summary).toContain('fbtrace=xyz');
    expect(summary).not.toContain('Bearer');
  });
});
