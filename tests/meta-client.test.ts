/**
 * The real HttpMetaClient against the mock Meta API. This is what proves the
 * request shapes match the documented ones: paths, recipient objects, the
 * button template and the profile fields.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMessageObject,
  DryRunMetaClient,
  HttpMetaClient,
} from '../src/meta/client.js';
import { MetaApiError, MetaTransportError } from '../src/meta/errors.js';
import { MockErrors, MockMeta } from '../src/testing/mock-meta.js';

const IG_USER_ID = '17841400000000000';
const BASE = 'https://graph.instagram.test';
const VERSION = 'v26.0';

let mock: MockMeta;
let client: HttpMetaClient;

beforeEach(() => {
  mock = new MockMeta();
  client = new HttpMetaClient({
    baseUrl: BASE,
    apiVersion: VERSION,
    igUserId: IG_USER_ID,
    accessToken: 'a-token',
    fetchImpl: mock.fetch(),
  });
});

afterEach(async () => {
  await mock.close();
});

describe('replyToComment', () => {
  it('POSTs to /<version>/<comment_id>/replies with the message in the body', async () => {
    const r = await client.replyToComment('comment_1', 'Sent you a DM ✅');
    expect(r.id).toMatch(/^comment_/);
    const call = mock.callsTo('comment_reply')[0];
    expect(call?.target).toBe('comment_1');
    expect(call?.text).toBe('Sent you a DM ✅');
    expect(call?.authorizationPresent).toBe(true);
  });

  it('surfaces an API error as a MetaApiError', async () => {
    mock.failNext({ ...MockErrors.rateLimit(), endpoint: 'comment_reply' });
    await expect(client.replyToComment('comment_1', 'hi')).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe('sendPrivateReply', () => {
  it('uses recipient.comment_id, as the private replies doc specifies', async () => {
    await client.sendPrivateReply('comment_7', 'Tap below', {
      label: 'Send it',
      payload: 'DELIVER:guide:n1',
    });
    const call = mock.privateReplies()[0];
    expect(call?.target).toBe('comment_7');
    expect(call?.privateReply).toBe(true);
    expect(call?.text).toBe('Tap below');
    expect(call?.buttonPayload).toBe('DELIVER:guide:n1');
    expect(call?.buttonLabel).toBe('Send it');
  });

  it('returns the message id Meta hands back', async () => {
    const r = await client.sendPrivateReply('comment_7', 'hi');
    expect(r.messageId).toMatch(/^mid_/);
  });
});

describe('sendDirectMessage', () => {
  it('uses recipient.id', async () => {
    await client.sendDirectMessage('igsid_1', 'here it is');
    const call = mock.directMessages()[0];
    expect(call?.target).toBe('igsid_1');
    expect(call?.privateReply).toBe(false);
    expect(call?.text).toBe('here it is');
  });

  it('fails with window_expired outside the 24-hour window', async () => {
    mock.failNext(MockErrors.windowExpired());
    const err = await client.sendDirectMessage('igsid_1', 'late').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).category).toBe('window_expired');
    expect((err as MetaApiError).retryable).toBe(false);
  });
});

describe('getUserProfile', () => {
  it('requests the documented fields and reads is_user_follow_business', async () => {
    mock.setProfile('igsid_1', { isUserFollowBusiness: true, username: 'someone', followerCount: 10 });
    const p = await client.getUserProfile('igsid_1');
    expect(p.isUserFollowBusiness).toBe(true);
    expect(p.username).toBe('someone');
    expect(p.followerCount).toBe(10);
    expect(mock.callsTo('user_profile')).toHaveLength(1);
  });

  it('reports null when Meta omits the follow field', async () => {
    mock.setProfile('igsid_2', { username: 'other' });
    const p = await client.getUserProfile('igsid_2');
    expect(p.isUserFollowBusiness).toBeNull();
  });

  it('raises consent_required when the person has not interacted yet', async () => {
    mock.failNext(MockErrors.consentRequired());
    const err = await client.getUserProfile('igsid_3').catch((e: unknown) => e);
    expect((err as MetaApiError).category).toBe('consent_required');
  });
});

describe('transport failures', () => {
  it('wraps a network error', async () => {
    const broken = new HttpMetaClient({
      baseUrl: BASE,
      apiVersion: VERSION,
      igUserId: IG_USER_ID,
      accessToken: 'a-token',
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const err = await broken.sendDirectMessage('x', 'y').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaTransportError);
    expect((err as MetaTransportError).retryable).toBe(true);
  });

  it('wraps a non-JSON response', async () => {
    const html = new HttpMetaClient({
      baseUrl: BASE,
      apiVersion: VERSION,
      igUserId: IG_USER_ID,
      accessToken: 'a-token',
      fetchImpl: async () => ({ status: 502, text: async () => '<html>bad gateway</html>' }),
    });
    const err = await html.sendDirectMessage('x', 'y').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).category).toBe('transient');
  });
});

describe('buildMessageObject', () => {
  it('is plain text with no button', () => {
    expect(buildMessageObject('hello')).toEqual({ text: 'hello' });
  });

  it('is a one-button template with a button', () => {
    expect(buildMessageObject('hello', { label: 'Go', payload: 'DELIVER:r:n' })).toEqual({
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: 'hello',
          buttons: [{ type: 'postback', title: 'Go', payload: 'DELIVER:r:n' }],
        },
      },
    });
  });
});

describe('DryRunMetaClient', () => {
  it('records calls and makes none', async () => {
    const dry = new DryRunMetaClient();
    await dry.replyToComment('c1', 'public');
    await dry.sendPrivateReply('c1', 'prompt', { label: 'Go', payload: 'DELIVER:r:n' });
    await dry.sendDirectMessage('igsid', 'resource');
    const profile = await dry.getUserProfile('igsid');
    expect(dry.calls.map((c) => c.method)).toEqual([
      'replyToComment',
      'sendPrivateReply',
      'sendDirectMessage',
      'getUserProfile',
    ]);
    expect(profile.isUserFollowBusiness).toBe(true);
  });

  it('can be told the person does not follow', async () => {
    const dry = new DryRunMetaClient();
    dry.setFollows('igsid', false);
    expect((await dry.getUserProfile('igsid')).isUserFollowBusiness).toBe(false);
  });
});
