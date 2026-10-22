import { describe, expect, it } from 'vitest';
import {
  decodePayload,
  encodePayload,
  makeNonce,
  MAX_PAYLOAD_LENGTH,
  PayloadError,
} from '../src/domain/payload.js';

describe('button payload codec', () => {
  it('round-trips', () => {
    const payload = encodePayload('DELIVER', 'guide', 'abc123');
    expect(payload).toBe('DELIVER:guide:abc123');
    expect(decodePayload(payload)).toEqual({ action: 'DELIVER', ruleId: 'guide', nonce: 'abc123' });
  });

  it('round-trips the RECHECK action used by the gate', () => {
    const payload = encodePayload('RECHECK', 'rule_1', makeNonce());
    const decoded = decodePayload(payload);
    expect(decoded?.action).toBe('RECHECK');
    expect(decoded?.ruleId).toBe('rule_1');
  });

  it('generates url-safe nonces', () => {
    for (let i = 0; i < 50; i++) expect(makeNonce()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a rule id that would break the format', () => {
    expect(() => encodePayload('DELIVER', 'has:colon', 'n')).toThrow(PayloadError);
    expect(() => encodePayload('DELIVER', 'has space', 'n')).toThrow(PayloadError);
    expect(() => encodePayload('DELIVER', '', 'n')).toThrow(PayloadError);
  });

  it('refuses an over-long payload', () => {
    expect(() => encodePayload('DELIVER', 'a'.repeat(MAX_PAYLOAD_LENGTH), 'n')).toThrow(PayloadError);
  });

  it('returns null for payloads that are not ours', () => {
    // Icebreakers, persistent menu items and anything a different tool set up.
    expect(decodePayload('ICEBREAKER_1')).toBeNull();
    expect(decodePayload('GET_STARTED')).toBeNull();
    expect(decodePayload('DELIVER:guide')).toBeNull();
    expect(decodePayload('DELIVER:guide:nonce:extra')).toBeNull();
    expect(decodePayload('DELETE:guide:nonce')).toBeNull();
    expect(decodePayload('deliver:guide:nonce')).toBeNull();
    expect(decodePayload('DELIVER::nonce')).toBeNull();
    expect(decodePayload('')).toBeNull();
    expect(decodePayload(null)).toBeNull();
    expect(decodePayload(undefined)).toBeNull();
    expect(decodePayload('a'.repeat(MAX_PAYLOAD_LENGTH + 1))).toBeNull();
  });

  it('rejects payload-unsafe characters on the way back in', () => {
    expect(decodePayload('DELIVER:rule id:nonce')).toBeNull();
    expect(decodePayload('DELIVER:rule:non ce')).toBeNull();
  });
});
