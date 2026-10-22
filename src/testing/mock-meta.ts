/**
 * A mock Meta API: a real Fastify app implementing the four endpoints we use,
 * with realistic success and error payloads.
 *
 * It is driven through `app.inject()` and exposed as a `FetchLike`, so the real
 * HttpMetaClient talks to it over the full request/response path (headers,
 * JSON bodies, status codes) without opening a socket. That is what lets the
 * whole test suite and the simulator run offline.
 *
 * Error injection: push onto `failures` and the next matching call fails.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { FetchLike } from '../meta/client.js';

export type MockEndpoint = 'comment_reply' | 'messages' | 'user_profile';

export interface MockCall {
  endpoint: MockEndpoint;
  /** Comment id, IGSID, or the recipient we were given. */
  target: string;
  /** Plain message text, when there was one. */
  text: string | null;
  /** The postback payload of the button, when the message carried one. */
  buttonPayload: string | null;
  buttonLabel: string | null;
  /** The link of a web_url button, when the message carried one. */
  buttonUrl: string | null;
  /** True when the request used `recipient.comment_id` (a private reply). */
  privateReply: boolean;
  authorizationPresent: boolean;
  at: Date;
}

/** One queued failure. `times` defaults to 1. */
export interface FailureSpec {
  endpoint: MockEndpoint;
  status: number;
  error: {
    message: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
  times?: number;
}

/** Ready-made Meta errors, worded as the docs word them. */
export const MockErrors = {
  rateLimit: (): FailureSpec => ({
    endpoint: 'messages',
    status: 400,
    error: {
      message: 'Calls to this api have exceeded the rate limit.',
      type: 'OAuthException',
      code: 613,
      error_subcode: 2534040,
      fbtrace_id: 'mock-rate-limit',
    },
  }),
  appRateLimit: (): FailureSpec => ({
    endpoint: 'messages',
    status: 400,
    error: {
      message: 'Application request limit reached',
      type: 'OAuthException',
      code: 4,
      fbtrace_id: 'mock-app-rate-limit',
    },
  }),
  windowExpired: (): FailureSpec => ({
    endpoint: 'messages',
    status: 400,
    error: {
      message: 'This message is sent outside of allowed window.',
      type: 'OAuthException',
      code: 10,
      error_subcode: 2018278,
      fbtrace_id: 'mock-window',
    },
  }),
  consentRequired: (): FailureSpec => ({
    endpoint: 'user_profile',
    status: 400,
    error: {
      message: 'User consent is required to access user profile',
      type: 'OAuthException',
      code: 230,
      fbtrace_id: 'mock-consent',
    },
  }),
  noPermission: (): FailureSpec => ({
    endpoint: 'messages',
    status: 403,
    error: {
      message:
        'Cannot message users who are not admins, developers or testers of the app until pages_messaging permission is reviewed and the app is live.',
      type: 'OAuthException',
      code: 200,
      error_subcode: 2018028,
      fbtrace_id: 'mock-permission',
    },
  }),
  serverError: (): FailureSpec => ({
    endpoint: 'messages',
    status: 500,
    error: { message: 'An unexpected error has occurred. Please retry your request later.', code: 1 },
  }),
} as const;

export interface MockProfile {
  name?: string;
  username?: string;
  followerCount?: number;
  /** undefined = omit the field entirely, as Meta sometimes does. */
  isUserFollowBusiness?: boolean;
}

export class MockMeta {
  readonly app: FastifyInstance;
  readonly calls: MockCall[] = [];
  readonly failures: FailureSpec[] = [];
  private readonly profiles = new Map<string, MockProfile>();
  private seq = 0;

  constructor() {
    this.app = Fastify({ logger: false });
    this.register();
  }

  // -- control -------------------------------------------------------------

  setProfile(igsid: string, profile: MockProfile): void {
    this.profiles.set(igsid, profile);
  }

  setFollows(igsid: string, follows: boolean): void {
    const existing = this.profiles.get(igsid) ?? {};
    this.profiles.set(igsid, { ...existing, isUserFollowBusiness: follows });
  }

  failNext(spec: FailureSpec): void {
    this.failures.push(spec);
  }

  reset(): void {
    this.calls.length = 0;
    this.failures.length = 0;
    this.profiles.clear();
    this.seq = 0;
  }

  callsTo(endpoint: MockEndpoint): MockCall[] {
    return this.calls.filter((c) => c.endpoint === endpoint);
  }

  /** Private replies only (recipient.comment_id). */
  privateReplies(): MockCall[] {
    return this.calls.filter((c) => c.endpoint === 'messages' && c.privateReply);
  }

  /** Normal DMs only (recipient.id). */
  directMessages(): MockCall[] {
    return this.calls.filter((c) => c.endpoint === 'messages' && !c.privateReply);
  }

  private takeFailure(endpoint: MockEndpoint): FailureSpec | null {
    const idx = this.failures.findIndex((f) => f.endpoint === endpoint);
    if (idx === -1) return null;
    const spec = this.failures[idx];
    if (!spec) return null;
    const times = spec.times ?? 1;
    if (times <= 1) this.failures.splice(idx, 1);
    else this.failures[idx] = { ...spec, times: times - 1 };
    return spec;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(4, '0')}`;
  }

  // -- the endpoints -------------------------------------------------------

  private register(): void {
    // POST /<version>/<comment_id>/replies
    this.app.post<{ Params: { version: string; id: string }; Body: unknown }>(
      '/:version/:id/replies',
      async (req, reply) => {
        const body = asObject(req.body);
        this.calls.push({
          endpoint: 'comment_reply',
          target: req.params.id,
          text: typeof body.message === 'string' ? body.message : null,
          buttonPayload: null,
          buttonLabel: null,
          buttonUrl: null,
          privateReply: false,
          authorizationPresent: typeof req.headers.authorization === 'string',
          at: new Date(),
        });
        const failure = this.takeFailure('comment_reply');
        if (failure) return reply.code(failure.status).send({ error: failure.error });
        if (typeof body.message !== 'string' || body.message.trim() === '') {
          return reply.code(400).send({
            error: { message: 'The parameter message is required.', code: 100, type: 'OAuthException' },
          });
        }
        return reply.code(200).send({ id: this.nextId('comment') });
      },
    );

    // POST /<version>/<ig_user_id>/messages
    this.app.post<{ Params: { version: string; id: string }; Body: unknown }>(
      '/:version/:id/messages',
      async (req, reply) => {
        const body = asObject(req.body);
        const recipient = asObject(body.recipient);
        const message = asObject(body.message);
        const commentId = typeof recipient.comment_id === 'string' ? recipient.comment_id : null;
        const recipientId = typeof recipient.id === 'string' ? recipient.id : null;
        const { text, buttonPayload, buttonLabel, buttonUrl } = readMessage(message);

        this.calls.push({
          endpoint: 'messages',
          target: commentId ?? recipientId ?? '(unknown)',
          text,
          buttonPayload,
          buttonLabel,
          buttonUrl,
          privateReply: commentId !== null,
          authorizationPresent: typeof req.headers.authorization === 'string',
          at: new Date(),
        });

        const failure = this.takeFailure('messages');
        if (failure) return reply.code(failure.status).send({ error: failure.error });

        if (commentId === null && recipientId === null) {
          return reply.code(400).send({
            error: {
              message: 'Invalid recipient: provide either id or comment_id.',
              code: 100,
              type: 'OAuthException',
            },
          });
        }
        if (text === null && buttonPayload === null) {
          return reply.code(400).send({
            error: { message: 'The message must contain text or an attachment.', code: 100 },
          });
        }
        return reply.code(200).send({
          recipient_id: recipientId ?? this.nextId('igsid'),
          message_id: this.nextId('mid'),
        });
      },
    );

    // GET /<version>/<igsid>?fields=...
    this.app.get<{ Params: { version: string; id: string }; Querystring: { fields?: string } }>(
      '/:version/:id',
      async (req, reply) => {
        this.calls.push({
          endpoint: 'user_profile',
          target: req.params.id,
          text: null,
          buttonPayload: null,
          buttonLabel: null,
          buttonUrl: null,
          privateReply: false,
          authorizationPresent: typeof req.headers.authorization === 'string',
          at: new Date(),
        });

        const failure = this.takeFailure('user_profile');
        if (failure) return reply.code(failure.status).send({ error: failure.error });

        const fields = (req.query.fields ?? '').split(',').map((f) => f.trim());
        const profile = this.profiles.get(req.params.id);
        const out: Record<string, unknown> = { id: req.params.id };
        if (fields.includes('name')) out.name = profile?.name ?? 'Test Person';
        if (fields.includes('username')) out.username = profile?.username ?? `user_${req.params.id.slice(-4)}`;
        if (fields.includes('follower_count')) out.follower_count = profile?.followerCount ?? 42;
        if (fields.includes('is_user_follow_business') && profile?.isUserFollowBusiness !== undefined) {
          out.is_user_follow_business = profile.isUserFollowBusiness;
        }
        return reply.code(200).send(out);
      },
    );

    this.app.setNotFoundHandler(async (req, reply) =>
      reply.code(400).send({
        error: {
          message: `Unsupported get request. Object with ID '${req.url}' does not exist`,
          type: 'GraphMethodException',
          code: 100,
        },
      }),
    );
  }

  /** A `fetch`-shaped function the real client can be pointed at. */
  fetch(): FetchLike {
    return async (url, init) => {
      const parsed = new URL(url);
      const headers: Record<string, string> = { ...init.headers };
      const res = await this.app.inject({
        method: init.method as 'GET' | 'POST',
        url: parsed.pathname + parsed.search,
        headers,
        ...(init.body !== undefined ? { payload: init.body } : {}),
      });
      return { status: res.statusCode, text: async () => res.body };
    };
  }

  async close(): Promise<void> {
    await this.app.close();
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function readMessage(message: Record<string, unknown>): {
  text: string | null;
  buttonPayload: string | null;
  buttonLabel: string | null;
  buttonUrl: string | null;
} {
  if (typeof message.text === 'string') {
    return { text: message.text, buttonPayload: null, buttonLabel: null, buttonUrl: null };
  }
  const attachment = asObject(message.attachment);
  const payload = asObject(attachment.payload);
  const text = typeof payload.text === 'string' ? payload.text : null;
  const buttons = Array.isArray(payload.buttons) ? payload.buttons : [];
  const first = asObject(buttons[0]);
  return {
    text,
    buttonPayload: typeof first.payload === 'string' ? first.payload : null,
    buttonLabel: typeof first.title === 'string' ? first.title : null,
    buttonUrl: typeof first.url === 'string' ? first.url : null,
  };
}
