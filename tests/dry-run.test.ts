/**
 * DRY_RUN=true must exercise the whole service — webhook, state machine,
 * outbox, dashboard — while making zero Meta calls. This is how the operator
 * rehearses before going live, so it has to be genuinely end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { testConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { DryRunMetaClient } from '../src/meta/client.js';
import { MemoryRepository } from '../src/repo/memory.js';
import { createClock } from '../src/testing/harness.js';
import { signatureHeader } from '../src/webhook/signature.js';
import { MockMeta } from '../src/testing/mock-meta.js';

const FAN = 'igsid_dry_1';

let app: App;
let dry: DryRunMetaClient;
let mock: MockMeta;
let repo: MemoryRepository;
const clock = createClock();
const cfg = testConfig({ DRY_RUN: true, REDELIVERY_COOLDOWN_MINUTES: 10 });

beforeEach(async () => {
  repo = new MemoryRepository();
  dry = new DryRunMetaClient();
  // A real mock server is wired up as well, purely so the test can prove that
  // nothing reached it.
  mock = new MockMeta();
  app = await buildApp({
    cfg,
    repo,
    meta: dry,
    log: createLogger(cfg),
    migrate: false,
    now: clock.now,
    fetchImpl: mock.fetch(),
  });
  await repo.createRule({
    id: 'guide',
    name: 'guide',
    enabled: true,
    scope: 'global',
    igMediaId: null,
    matchType: 'contains',
    keywords: ['guide'],
    caseInsensitive: true,
    publicReplyVariants: ['Sent you a DM ✅'],
    dmPromptText: 'Tap below',
    buttonLabel: 'Send it',
    gateMessage: 'Follow first, then tap again.',
    resourcePayload: { text: 'Here it is', url: 'https://example.com/guide' },
    requireFollow: true,
    priority: 0,
  });
});

afterEach(async () => {
  await app.shutdown();
  await mock.close();
});

async function post(payload: unknown): Promise<number> {
  const raw = JSON.stringify(payload);
  const res = await app.server.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signatureHeader(raw, cfg.APP_SECRET),
    },
    payload: raw,
  });
  return res.statusCode;
}

function comment(commentId: string, text: string): unknown {
  return {
    object: 'instagram',
    entry: [
      {
        id: cfg.IG_USER_ID,
        time: Math.floor(clock.now().getTime() / 1000),
        field: 'comments',
        value: {
          id: commentId,
          from: { id: FAN, username: 'dryrunner' },
          text,
          media: { id: 'media_1' },
        },
      },
    ],
  };
}

function tap(payload: string, mid: string): unknown {
  return {
    object: 'instagram',
    entry: [
      {
        id: cfg.IG_USER_ID,
        messaging: [
          {
            sender: { id: FAN },
            recipient: { id: cfg.IG_USER_ID },
            timestamp: clock.now().getTime(),
            postback: { mid, title: 'Send it', payload },
          },
        ],
      },
    ],
  };
}

describe('DRY_RUN', () => {
  it('runs the whole journey with no Meta calls at all', async () => {
    expect(await post(comment('c_dry_1', 'send me the guide'))).toBe(200);
    await app.workers.drain();

    expect(dry.calls.map((c) => c.method)).toEqual(['replyToComment', 'sendPrivateReply']);
    const buttonPayload = dry.calls.find((c) => c.buttonLabel)?.buttonLabel;
    expect(buttonPayload).toBe('Send it');

    // The outbox rows are marked sent, so the state machine advances for real.
    const outbox = await repo.listOutbox('all', 20);
    expect(outbox.every((o) => o.status === 'sent')).toBe(true);
    expect((await repo.findConversation(FAN, 'guide'))?.state).toBe('PROMPTED');

    // The tap: DryRunMetaClient answers "following" by default.
    const row = outbox.find((o) => o.kind === 'private_reply_prompt');
    const payload =
      row?.request.op === 'private_reply' ? (row.request.button?.payload ?? '') : '';
    expect(payload).toMatch(/^DELIVER:guide:/);

    expect(await post(tap(payload, 'mid_dry_1'))).toBe(200);
    await app.workers.drain();

    expect(dry.calls.map((c) => c.method)).toEqual([
      'replyToComment',
      'sendPrivateReply',
      'getUserProfile',
      'sendDirectMessage',
    ]);
    expect((await repo.findConversation(FAN, 'guide'))?.state).toBe('DELIVERED');

    // The decisive assertion: the mock Meta API was never touched.
    expect(mock.calls).toHaveLength(0);
  });

  it('can be told to simulate a non-follower, and still never calls Meta', async () => {
    dry.setDefaultFollows(false);
    await post(comment('c_dry_2', 'guide'));
    await app.workers.drain();
    const row = (await repo.listOutbox('all', 20)).find((o) => o.kind === 'private_reply_prompt');
    const payload = row?.request.op === 'private_reply' ? (row.request.button?.payload ?? '') : '';

    await post(tap(payload, 'mid_dry_2'));
    await app.workers.drain();

    expect((await repo.findConversation(FAN, 'guide'))?.state).toBe('GATED');
    const gate = dry.calls.filter((c) => c.method === 'sendDirectMessage');
    expect(gate).toHaveLength(1);
    expect(gate[0]?.message).toContain('Follow first');
    expect(mock.calls).toHaveLength(0);
  });

  it('says so on /healthz and on the dashboard', async () => {
    const health = await app.server.inject({ method: 'GET', url: '/healthz' });
    expect(JSON.parse(health.body)).toMatchObject({ dryRun: true });

    const page = await app.server.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: `Bearer ${cfg.ADMIN_TOKEN}`, accept: 'text/html' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('DRY_RUN is on');
  });
});
