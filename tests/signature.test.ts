import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  computeSignature,
  secretEquals,
  signatureHeader,
  verifySignature,
} from '../src/webhook/signature.js';

const SECRET = 'app-secret-abc';
const BODY = JSON.stringify({ object: 'instagram', entry: [{ id: '1', time: 1 }] });

describe('webhook signature verification', () => {
  it('accepts a signature Meta would have produced', () => {
    const header = `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex')}`;
    expect(verifySignature(BODY, header, SECRET)).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const header = signatureHeader(BODY, SECRET);
    const tampered = BODY.replace('instagram', 'instagrom');
    expect(tampered).not.toBe(BODY);
    expect(verifySignature(tampered, header, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature made with the wrong secret', () => {
    const header = signatureHeader(BODY, 'not-the-app-secret');
    expect(verifySignature(BODY, header, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a missing header', () => {
    expect(verifySignature(BODY, undefined, SECRET)).toEqual({
      ok: false,
      reason: 'missing_header',
    });
    expect(verifySignature(BODY, '', SECRET)).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a malformed header', () => {
    expect(verifySignature(BODY, 'sha1=abc', SECRET)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
    expect(verifySignature(BODY, 'sha256=nothex', SECRET)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
    // Right alphabet, wrong length.
    expect(verifySignature(BODY, `sha256=${'a'.repeat(63)}`, SECRET)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
  });

  it('is case-insensitive about the hex digest', () => {
    const header = signatureHeader(BODY, SECRET).toUpperCase().replace('SHA256=', 'sha256=');
    expect(verifySignature(BODY, header, SECRET)).toEqual({ ok: true });
  });

  it('hashes the raw bytes, not a re-serialised object', () => {
    // Same JSON, different key order and whitespace: the digest must differ,
    // which is exactly why the route keeps the raw Buffer.
    const reordered = JSON.stringify({ entry: [{ time: 1, id: '1' }], object: 'instagram' });
    expect(computeSignature(BODY, SECRET)).not.toBe(computeSignature(reordered, SECRET));
  });

  it('validates the same signature twice (replay protection is not its job)', () => {
    // A replayed delivery is legitimately signed. De-duplication happens in the
    // events table; see the duplicate-webhook integration test.
    const header = signatureHeader(BODY, SECRET);
    expect(verifySignature(BODY, header, SECRET)).toEqual({ ok: true });
    expect(verifySignature(BODY, header, SECRET)).toEqual({ ok: true });
  });

  it('accepts an empty body signed as empty', () => {
    expect(verifySignature(Buffer.alloc(0), signatureHeader('', SECRET), SECRET)).toEqual({
      ok: true,
    });
  });
});

describe('secretEquals', () => {
  it('matches identical strings and nothing else', () => {
    expect(secretEquals('token', 'token')).toBe(true);
    expect(secretEquals('token', 'Token')).toBe(false);
    expect(secretEquals('tokenn', 'token')).toBe(false);
    expect(secretEquals('', 'token')).toBe(false);
    expect(secretEquals(undefined, 'token')).toBe(false);
    expect(secretEquals(null, 'token')).toBe(false);
  });
});
