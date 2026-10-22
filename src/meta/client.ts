/**
 * The only file that talks to Meta.
 *
 * Every method carries the documentation URL it was built from. All four
 * endpoints were re-checked against the live docs on 2026-10-22; differences
 * from the project spec are written up in docs/API_NOTES.md.
 *
 * Setup assumed here: **Instagram API with Instagram Login** (Business Login
 * for Instagram), so the host is `graph.instagram.com` and the credential is an
 * Instagram User access token sent as a Bearer token.
 */
import type { ButtonSpec } from '../types.js';
import { MetaApiError, MetaTransportError, parseErrorBody } from './errors.js';

export interface UserProfile {
  id: string;
  name: string | null;
  username: string | null;
  followerCount: number | null;
  /** The official follow signal. `null` when Meta omitted the field. */
  isUserFollowBusiness: boolean | null;
}

export interface SendResult {
  recipientId: string | null;
  messageId: string | null;
}

export interface CommentReplyResult {
  id: string;
}

/** What the workers depend on. Both the real client and DryRunMetaClient satisfy it. */
export interface MetaClient {
  replyToComment(commentId: string, message: string): Promise<CommentReplyResult>;
  sendPrivateReply(commentId: string, message: string, button?: ButtonSpec): Promise<SendResult>;
  sendDirectMessage(igsid: string, message: string, button?: ButtonSpec): Promise<SendResult>;
  getUserProfile(igsid: string): Promise<UserProfile>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface MetaClientOptions {
  baseUrl: string;
  apiVersion: string;
  igUserId: string;
  accessToken: string;
  /** Injectable so tests point at the mock without opening a socket. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** The message object, shared by private replies and normal DMs. */
export function buildMessageObject(text: string, button?: ButtonSpec): Record<string, unknown> {
  if (!button) return { text };
  // Button template.
  // https://developers.facebook.com/docs/messenger-platform/send-messages/template/button
  // `text` max 640 chars, 1-3 buttons. Postback buttons send the payload back
  // to our webhook as a `messaging_postbacks` notification; web_url buttons
  // open the link in Instagram's in-app browser and never call us back.
  // URL buttons render in the Instagram mobile app, not on desktop web.
  const spec =
    button.url !== undefined
      ? { type: 'web_url', title: button.label, url: button.url }
      : { type: 'postback', title: button.label, payload: button.payload };
  if (spec.type === 'postback' && button.payload === undefined) {
    throw new Error('ButtonSpec needs either a postback payload or a url');
  }
  return {
    attachment: {
      type: 'template',
      payload: { template_type: 'button', text, buttons: [spec] },
    },
  };
}

export class HttpMetaClient implements MetaClient {
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly igUserId: string;
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: MetaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiVersion = opts.apiVersion;
    this.igUserId = opts.igUserId;
    this.accessToken = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private url(path: string, query?: Record<string, string>): string {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    return `${this.baseUrl}/${this.apiVersion}/${path.replace(/^\/+/, '')}${qs}`;
  }

  private async request(
    method: 'GET' | 'POST',
    endpoint: string,
    url: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      // Instagram User access token. Never logged: see logger.ts redaction.
      authorization: `Bearer ${this.accessToken}`,
      accept: 'application/json',
    };
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: { status: number; text(): Promise<string> };
    try {
      res = await withTimeout(this.fetchImpl(url, init), this.timeoutMs, endpoint);
    } catch (cause) {
      throw new MetaTransportError(endpoint, cause);
    }

    const raw = await res.text();
    let parsed: unknown = undefined;
    if (raw.trim() !== '') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { error: { message: `non-JSON response: ${raw.slice(0, 200)}` } };
      }
    }

    if (res.status < 200 || res.status >= 300) {
      throw new MetaApiError(res.status, parseErrorBody(parsed), endpoint);
    }
    // A 200 can still carry an error envelope on some Graph endpoints.
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      throw new MetaApiError(200, parseErrorBody(parsed), endpoint);
    }
    return parsed;
  }

  /**
   * Public reply under a comment.
   *
   * POST https://graph.instagram.com/<version>/<IG_COMMENT_ID>/replies
   * body: {"message": "..."}
   * Permissions: instagram_business_basic, instagram_business_manage_comments
   * Docs: https://developers.facebook.com/docs/instagram-platform/comment-moderation
   *
   * Note: Meta only allows replying to *top-level* comments; a reply to a reply
   * is attached to the top-level comment instead. Hidden comments and live-video
   * comments cannot be replied to.
   */
  async replyToComment(commentId: string, message: string): Promise<CommentReplyResult> {
    const out = await this.request(
      'POST',
      'comment_reply',
      this.url(`${encodeURIComponent(commentId)}/replies`),
      { message },
    );
    return { id: readString(out, 'id') ?? '' };
  }

  /**
   * The one private reply a comment entitles us to.
   *
   * POST https://graph.instagram.com/<version>/<IG_USER_ID>/messages
   * body: {"recipient": {"comment_id": "<COMMENT_ID>"}, "message": {...}}
   * Permissions: instagram_business_basic, instagram_business_manage_messages
   * Docs: https://developers.facebook.com/docs/instagram-platform/private-replies
   *
   * Platform limits encoded elsewhere in this service: exactly one private
   * reply per comment, and it must be sent within 7 days of the comment.
   */
  async sendPrivateReply(
    commentId: string,
    message: string,
    button?: ButtonSpec,
  ): Promise<SendResult> {
    const out = await this.request(
      'POST',
      'private_reply',
      this.url(`${encodeURIComponent(this.igUserId)}/messages`),
      { recipient: { comment_id: commentId }, message: buildMessageObject(message, button) },
    );
    return {
      recipientId: readString(out, 'recipient_id'),
      messageId: readString(out, 'message_id'),
    };
  }

  /**
   * A normal DM. Only works inside the messaging window the person's own action
   * opened (24 h for a message/postback; up to 7 days after a click-to-DM ad).
   *
   * POST https://graph.instagram.com/<version>/<IG_USER_ID>/messages
   * body: {"recipient": {"id": "<IGSID>"}, "message": {...}}
   * Permissions: instagram_business_basic, instagram_business_manage_messages
   * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
   */
  async sendDirectMessage(
    igsid: string,
    message: string,
    button?: ButtonSpec,
  ): Promise<SendResult> {
    const out = await this.request(
      'POST',
      'dm',
      this.url(`${encodeURIComponent(this.igUserId)}/messages`),
      { recipient: { id: igsid }, message: buildMessageObject(message, button) },
    );
    return {
      recipientId: readString(out, 'recipient_id'),
      messageId: readString(out, 'message_id'),
    };
  }

  /**
   * The follow check. `is_user_follow_business` is the only official way to
   * know whether someone follows the account — there is no follower list here
   * and we never try to infer it any other way.
   *
   * GET https://graph.instagram.com/<version>/<IGSID>
   *     ?fields=name,username,follower_count,is_user_follow_business
   * Permissions: instagram_business_basic, instagram_business_manage_messages
   * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile
   *
   * Consent: this call only works after the person has messaged the account or
   * tapped an icebreaker / persistent menu / button. A comment alone does NOT
   * grant consent — that is exactly why the first DM is a button and not the
   * resource.
   */
  async getUserProfile(igsid: string): Promise<UserProfile> {
    const out = await this.request(
      'GET',
      'user_profile',
      this.url(encodeURIComponent(igsid), {
        fields: 'name,username,follower_count,is_user_follow_business',
      }),
    );
    return {
      id: readString(out, 'id') ?? igsid,
      name: readString(out, 'name'),
      username: readString(out, 'username'),
      followerCount: readNumber(out, 'follower_count'),
      isUserFollowBusiness: readBoolean(out, 'is_user_follow_business'),
    };
  }
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export interface DryRunCall {
  method: keyof MetaClient;
  target: string;
  message?: string;
  buttonLabel?: string;
  at: Date;
}

/**
 * DRY_RUN=true. Nothing leaves the process: calls are recorded, the worker
 * marks the outbox row sent, and the state machine runs for real. This is how
 * the operator rehearses before going live.
 *
 * The follow check answers `true` by default so a dry run walks the happy path;
 * `setFollows()` lets the dashboard's tester and the simulator force the gate.
 */
export class DryRunMetaClient implements MetaClient {
  readonly calls: DryRunCall[] = [];
  private follows = new Map<string, boolean>();
  private defaultFollows = true;
  private seq = 0;

  constructor(private readonly onCall?: (call: DryRunCall) => void) {}

  setFollows(igsid: string, follows: boolean): void {
    this.follows.set(igsid, follows);
  }

  setDefaultFollows(follows: boolean): void {
    this.defaultFollows = follows;
  }

  private record(call: Omit<DryRunCall, 'at'>): void {
    const full: DryRunCall = { ...call, at: new Date() };
    this.calls.push(full);
    this.onCall?.(full);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `dryrun_${prefix}_${this.seq}`;
  }

  async replyToComment(commentId: string, message: string): Promise<CommentReplyResult> {
    this.record({ method: 'replyToComment', target: commentId, message });
    return { id: this.nextId('comment') };
  }

  async sendPrivateReply(
    commentId: string,
    message: string,
    button?: ButtonSpec,
  ): Promise<SendResult> {
    const call: Omit<DryRunCall, 'at'> = { method: 'sendPrivateReply', target: commentId, message };
    if (button) call.buttonLabel = button.label;
    this.record(call);
    return { recipientId: null, messageId: this.nextId('private') };
  }

  async sendDirectMessage(igsid: string, message: string, button?: ButtonSpec): Promise<SendResult> {
    const call: Omit<DryRunCall, 'at'> = { method: 'sendDirectMessage', target: igsid, message };
    if (button) call.buttonLabel = button.label;
    this.record(call);
    return { recipientId: igsid, messageId: this.nextId('dm') };
  }

  async getUserProfile(igsid: string): Promise<UserProfile> {
    this.record({ method: 'getUserProfile', target: igsid });
    return {
      id: igsid,
      name: 'Dry Run User',
      username: `dryrun_${igsid.slice(-4)}`,
      followerCount: null,
      isUserFollowBusiness: this.follows.get(igsid) ?? this.defaultFollows,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = async (url, init) => {
  // Node 20+ global fetch (undici). No HTTP client dependency.
  const res = await fetch(url, init);
  return { status: res.status, text: () => res.text() };
};

async function withTimeout<T>(p: Promise<T>, ms: number, endpoint: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void endpoint;
  }
}

function field(out: unknown, key: string): unknown {
  if (typeof out !== 'object' || out === null) return undefined;
  return (out as Record<string, unknown>)[key];
}

function readString(out: unknown, key: string): string | null {
  const v = field(out, key);
  return typeof v === 'string' ? v : null;
}

function readNumber(out: unknown, key: string): number | null {
  const v = field(out, key);
  return typeof v === 'number' ? v : null;
}

function readBoolean(out: unknown, key: string): boolean | null {
  const v = field(out, key);
  if (typeof v === 'boolean') return v;
  // Graph sometimes serialises booleans as the strings "true"/"false".
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}
