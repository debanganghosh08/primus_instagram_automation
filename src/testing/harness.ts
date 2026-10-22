/**
 * The test/simulator harness.
 *
 * Boots the real service (real Fastify routes, real signature check, real
 * engine, real workers) against the MemoryRepository and the MockMeta app.
 * No Postgres, no Docker, no sockets, no network.
 *
 * A controllable clock is part of the deal: nothing in the suite sleeps.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../app.js';
import { testConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { HttpMetaClient } from '../meta/client.js';
import { MemoryRepository } from '../repo/memory.js';
import type { Repository } from '../repo/repository.js';
import { signatureHeader } from '../webhook/signature.js';
import type { NewRule, Rule } from '../types.js';
import { MockMeta } from './mock-meta.js';

export interface Clock {
  now: () => Date;
  set: (d: Date) => void;
  advance: (ms: number) => void;
}

export function createClock(start = new Date('2026-03-01T10:00:00.000Z')): Clock {
  let current = start;
  return {
    now: () => new Date(current.getTime()),
    set: (d: Date) => {
      current = d;
    },
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

export interface HarnessOptions {
  config?: Partial<Config>;
  /** Deterministic jitter: 0.5 by default, so backoff is predictable. */
  random?: () => number;
  start?: Date;
  /**
   * Swap the repository. Defaults to MemoryRepository; the Postgres
   * integration suite passes a PostgresRepository so the same flows exercise
   * real SQL.
   */
  repo?: Repository;
}

export interface WebhookResponse {
  statusCode: number;
  body: string;
}

export class Harness {
  readonly mock: MockMeta;
  readonly repo: Repository;
  readonly clock: Clock;
  app!: App;
  cfg!: Config;

  constructor(private readonly opts: HarnessOptions = {}) {
    this.mock = new MockMeta();
    this.repo = opts.repo ?? new MemoryRepository();
    this.clock = createClock(opts.start);
  }

  async start(): Promise<void> {
    this.cfg = testConfig({
      // Small numbers so the tests are quick to read.
      MAX_ATTEMPTS: 5,
      BACKOFF_BASE_MS: 1_000,
      BACKOFF_MAX_MS: 60_000,
      CONTACT_COOLDOWN_MINUTES: 0,
      REDELIVERY_COOLDOWN_MINUTES: 10,
      ...this.opts.config,
    });
    const log = createLogger(this.cfg);
    const meta = new HttpMetaClient({
      baseUrl: this.cfg.GRAPH_BASE_URL,
      apiVersion: this.cfg.API_VERSION,
      igUserId: this.cfg.IG_USER_ID,
      accessToken: this.cfg.IG_ACCESS_TOKEN,
      fetchImpl: this.mock.fetch(),
    });
    this.app = await buildApp({
      cfg: this.cfg,
      repo: this.repo,
      meta,
      log,
      migrate: false,
      now: this.clock.now,
      random: this.opts.random ?? (() => 0.5),
    });
  }

  async stop(): Promise<void> {
    await this.app.shutdown();
    await this.mock.close();
  }

  get server(): FastifyInstance {
    return this.app.server;
  }

  // -- rules ---------------------------------------------------------------

  async addRule(overrides: Partial<NewRule> & { id: string }): Promise<Rule> {
    return this.repo.createRule({
      name: `Rule ${overrides.id}`,
      enabled: true,
      scope: 'global',
      igMediaId: null,
      matchType: 'contains',
      keywords: ['guide'],
      caseInsensitive: true,
      publicReplyVariants: ['Sent you a DM ✅'],
      dmPromptText: 'Tap the button and I will send the guide.',
      buttonLabel: 'Send me the guide',
      gateMessage: 'One tap: follow, then press the button again.',
      resourcePayload: { text: 'Here it is', url: 'https://example.com/guide' },
      requireFollow: true,
      priority: 0,
      ...overrides,
    });
  }

  // -- webhooks ------------------------------------------------------------

  /** POST a signed notification, exactly as Meta would. */
  async postWebhook(payload: unknown, opts: { signature?: string | null } = {}): Promise<WebhookResponse> {
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const sig =
      opts.signature === undefined ? signatureHeader(raw, this.cfg.APP_SECRET) : opts.signature;
    if (sig !== null) headers['x-hub-signature-256'] = sig;
    const res = await this.server.inject({ method: 'POST', url: '/webhook', headers, payload: raw });
    return { statusCode: res.statusCode, body: res.body };
  }

  commentPayload(input: {
    igsid: string;
    commentId: string;
    text: string;
    mediaId?: string;
    username?: string;
    at?: Date;
  }): unknown {
    const at = input.at ?? this.clock.now();
    return {
      object: 'instagram',
      entry: [
        {
          id: this.cfg.IG_USER_ID,
          time: Math.floor(at.getTime() / 1000),
          field: 'comments',
          value: {
            id: input.commentId,
            from: { id: input.igsid, username: input.username ?? `user_${input.igsid.slice(-3)}` },
            text: input.text,
            media: { id: input.mediaId ?? 'media_1', media_product_type: 'REELS' },
          },
        },
      ],
    };
  }

  postbackPayload(input: { igsid: string; payload: string; mid: string; at?: Date }): unknown {
    const at = input.at ?? this.clock.now();
    return {
      object: 'instagram',
      entry: [
        {
          id: this.cfg.IG_USER_ID,
          time: Math.floor(at.getTime() / 1000),
          messaging: [
            {
              sender: { id: input.igsid },
              recipient: { id: this.cfg.IG_USER_ID },
              timestamp: at.getTime(),
              postback: { mid: input.mid, title: 'Send me the guide', payload: input.payload },
            },
          ],
        },
      ],
    };
  }

  messagePayload(input: { igsid: string; text: string; mid: string; at?: Date }): unknown {
    const at = input.at ?? this.clock.now();
    return {
      object: 'instagram',
      entry: [
        {
          id: this.cfg.IG_USER_ID,
          time: Math.floor(at.getTime() / 1000),
          messaging: [
            {
              sender: { id: input.igsid },
              recipient: { id: this.cfg.IG_USER_ID },
              timestamp: at.getTime(),
              message: { mid: input.mid, text: input.text },
            },
          ],
        },
      ],
    };
  }

  // -- driving -------------------------------------------------------------

  /** Process everything that is due, then return. */
  async drain(): Promise<void> {
    await this.app.workers.drain();
  }

  /** Move the clock and drain, for retry/backoff tests. */
  async advanceAndDrain(ms: number): Promise<void> {
    this.clock.advance(ms);
    await this.drain();
  }

  /** The postback payload Meta would send if the user tapped our last button. */
  lastButtonPayload(): string {
    for (let i = this.mock.calls.length - 1; i >= 0; i--) {
      const call = this.mock.calls[i];
      if (call?.buttonPayload) return call.buttonPayload;
    }
    throw new Error('no button has been sent yet');
  }

  /** Simulate the user tapping the most recent button. */
  async tapLastButton(igsid: string, mid: string): Promise<WebhookResponse> {
    return this.postWebhook(
      this.postbackPayload({ igsid, payload: this.lastButtonPayload(), mid }),
    );
  }
}

export async function withHarness<T>(
  opts: HarnessOptions,
  fn: (h: Harness) => Promise<T>,
): Promise<T> {
  const h = new Harness(opts);
  await h.start();
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}
