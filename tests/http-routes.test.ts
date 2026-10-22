/**
 * The HTTP surface: the verification handshake, the signature gate on the
 * notification route, and the admin dashboard's auth and actions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../src/testing/harness.js';

let h: Harness;

beforeEach(async () => {
  h = new Harness();
  await h.start();
});

afterEach(async () => {
  await h.stop();
});

describe('GET /webhook (verification handshake)', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const res = await h.server.inject({
      method: 'GET',
      url: `/webhook?hub.mode=subscribe&hub.verify_token=${h.cfg.VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
  });

  it('refuses a wrong verify token', async () => {
    const res = await h.server.inject({
      method: 'GET',
      url: '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(h.cfg.VERIFY_TOKEN);
  });

  it('refuses a wrong mode', async () => {
    const res = await h.server.inject({
      method: 'GET',
      url: `/webhook?hub.mode=unsubscribe&hub.verify_token=${h.cfg.VERIFY_TOKEN}&hub.challenge=123`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a request with no parameters', async () => {
    expect((await h.server.inject({ method: 'GET', url: '/webhook' })).statusCode).toBe(403);
  });
});

describe('POST /webhook', () => {
  it('answers 200 quickly and leaves the work to the worker', async () => {
    await h.addRule({ id: 'guide', keywords: ['guide'] });
    const started = Date.now();
    const res = await h.postWebhook(
      h.commentPayload({ igsid: 'igsid_1', commentId: 'c1', text: 'guide' }),
    );
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    // Nothing sent yet: the row is only queued.
    expect(h.mock.calls).toHaveLength(0);
    expect((await h.repo.getEventByProviderId('comment:c1'))?.status).toBe('pending');
  });

  it('accepts a notification it cannot act on, rather than making Meta retry', async () => {
    const res = await h.postWebhook({ object: 'instagram', entry: [{ id: 'x', field: 'mentions', value: {} }] });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ received: 0, stored: 0 });
  });

  it('accepts a body that is not even JSON-shaped, with a valid signature', async () => {
    const res = await h.postWebhook('not an envelope');
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unsigned body', async () => {
    const res = await h.postWebhook({ object: 'instagram', entry: [] }, { signature: null });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid signature' });
  });

  it('rejects a signature for a different body', async () => {
    const other = new Harness();
    await other.start();
    try {
      const payload = h.commentPayload({ igsid: 'igsid_1', commentId: 'c2', text: 'guide' });
      const res = await h.postWebhook(payload, {
        signature: 'sha256=' + 'f'.repeat(64),
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await other.stop();
    }
  });
});

describe('/healthz', () => {
  it('reports the repository, API version and dry-run flag', async () => {
    const res = await h.server.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
      repository: 'memory',
      apiVersion: h.cfg.API_VERSION,
      dryRun: false,
    });
  });
});

describe('/admin', () => {
  const html = { accept: 'text/html' };

  it('shows a login form instead of the dashboard when unauthenticated', async () => {
    const res = await h.server.inject({ method: 'GET', url: '/admin', headers: html });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Paste your ADMIN_TOKEN');
    expect(res.body).not.toContain(h.cfg.ADMIN_TOKEN);
  });

  it('returns JSON 401 for an API client', async () => {
    const res = await h.server.inject({ method: 'GET', url: '/admin/api/state' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
  });

  it('accepts a bearer token', async () => {
    const res = await h.server.inject({
      method: 'GET',
      url: '/admin',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('comment-to-DM');
  });

  it('rejects a nearly-correct token', async () => {
    const res = await h.server.inject({
      method: 'GET',
      url: '/admin',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}x` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('sets an HttpOnly cookie on login and accepts it afterwards', async () => {
    const login = await h.server.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(h.cfg.ADMIN_TOKEN)}`,
    });
    expect(login.statusCode).toBe(303);
    const cookie = login.headers['set-cookie'];
    expect(String(cookie)).toContain('HttpOnly');
    expect(String(cookie)).toContain('SameSite=Strict');

    const res = await h.server.inject({
      method: 'GET',
      url: '/admin',
      headers: { ...html, cookie: String(cookie).split(';')[0] ?? '' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a bad login', async () => {
    const res = await h.server.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=nope',
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('did not match');
  });

  it('creates a rule, disabled by default', async () => {
    const res = await h.server.inject({
      method: 'POST',
      url: '/admin/rules',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        id: 'newrule',
        name: 'New rule',
        matchType: 'contains',
        keywords: 'guide, link',
        publicReplyVariants: 'Sent you a DM ✅',
        dmPromptText: 'Tap below',
        buttonLabel: 'Send it',
        gateMessage: 'Follow first',
        resourceText: 'Here it is',
        resourceUrl: 'https://example.com/x',
        requireFollow: 'true',
        priority: '5',
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    const rule = await h.repo.getRule('newrule');
    expect(rule).toMatchObject({
      enabled: false,
      keywords: ['guide', 'link'],
      priority: 5,
      requireFollow: true,
    });
    expect(rule?.resourcePayload).toEqual({ text: 'Here it is', url: 'https://example.com/x' });
  });

  it('rejects a rule id that would break the button payload', async () => {
    const res = await h.server.inject({
      method: 'POST',
      url: '/admin/rules',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ id: 'bad:id', name: 'x' }).toString(),
    });
    expect(res.body).toContain('letters, numbers');
    expect(await h.repo.getRule('bad:id')).toBeNull();
  });

  it('rejects a post-scoped rule with no media id', async () => {
    const res = await h.server.inject({
      method: 'POST',
      url: '/admin/rules',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ id: 'ps', name: 'x', scope: 'post' }).toString(),
    });
    expect(res.body).toContain('needs a media id');
  });

  it('toggles a rule', async () => {
    await h.addRule({ id: 'guide', enabled: false });
    const res = await h.server.inject({
      method: 'POST',
      url: '/admin/rules/guide/toggle',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect((await h.repo.getRule('guide'))?.enabled).toBe(true);
  });

  it('retries a failed outbox row', async () => {
    const { item } = await h.repo.enqueue(
      {
        conversationId: null,
        igsid: 'u',
        kind: 'resource',
        dedupeKey: 'k',
        request: { op: 'dm', igsid: 'u', message: 'x' },
      },
      h.clock.now(),
    );
    await h.repo.markOutboxFailed(item.id, 'boom', h.clock.now());
    const res = await h.server.inject({
      method: 'POST',
      url: `/admin/outbox/${item.id}/retry`,
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect((await h.repo.getOutboxItem(item.id))?.status).toBe('queued');
  });

  it('runs the dry-run tester without writing or sending anything', async () => {
    await h.addRule({ id: 'guide', keywords: ['guide'] });
    const res = await h.server.inject({
      method: 'POST',
      url: '/admin/test',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ text: 'please send the guide' }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('matched rule &quot;guide&quot;');
    expect(res.body).toContain('Sent you a DM');
    expect(h.mock.calls).toHaveLength(0);
    expect(await h.repo.listConversations(10)).toHaveLength(0);
    expect(await h.repo.listOutbox('all', 10)).toHaveLength(0);
  });

  it("says plainly when nothing would match", async () => {
    await h.addRule({ id: 'guide', keywords: ['guide'] });
    const res = await h.server.inject({
      method: 'POST',
      url: '/admin/test',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ text: 'nice reel' }).toString(),
    });
    expect(res.body).toContain('no rule matched');
  });

  it('escapes rule text so a rule cannot inject HTML into the dashboard', async () => {
    await h.addRule({ id: 'xss', name: '<script>alert(1)</script>', keywords: ['guide'] });
    const res = await h.server.inject({
      method: 'GET',
      url: '/admin',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}` },
    });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('never prints a secret on the page', async () => {
    await h.addRule({ id: 'guide' });
    const res = await h.server.inject({
      method: 'GET',
      url: '/admin',
      headers: { ...html, authorization: `Bearer ${h.cfg.ADMIN_TOKEN}` },
    });
    expect(res.body).not.toContain(h.cfg.IG_ACCESS_TOKEN);
    expect(res.body).not.toContain(h.cfg.APP_SECRET);
    expect(res.body).not.toContain(h.cfg.VERIFY_TOKEN);
    expect(res.body).not.toContain(h.cfg.ADMIN_TOKEN);
  });
});
