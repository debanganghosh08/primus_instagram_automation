/**
 * The engine. If you read one file in this project, read this one.
 *
 * It has exactly two jobs:
 *
 *   processEvent(event)   an inbound webhook -> a state machine decision ->
 *                         rows in the outbox. It never calls Meta.
 *
 *   deliver(outboxItem)   one outbox row -> one Meta call -> the row marked
 *                         sent, retried, or failed. It never decides policy;
 *                         it only reports what happened, and for a follow check
 *                         it hands the answer back to the state machine.
 *
 * The separation is deliberate. Meta retries webhooks and our own network calls
 * fail; keeping "decide" and "send" apart is what makes both safely repeatable.
 */
import { backoffCeilingMs, nextAttemptAt } from '../domain/backoff.js';
import { decodePayload, encodePayload, makeNonce } from '../domain/payload.js';
import { pickPublicReply, selectRule } from '../domain/rules.js';
import {
  attemptsExhausted,
  decide,
  isTerminal,
  type Decision,
  type Effect,
  type Trigger,
} from '../domain/state.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { previewText } from '../logger.js';
import { isMetaError, type MetaError } from '../meta/errors.js';
import type { MetaClient } from '../meta/client.js';
import type { TokenBucket } from '../meta/ratelimit.js';
import type { Repository } from '../repo/repository.js';
import type {
  ButtonSpec,
  Conversation,
  NewOutboxItem,
  OutboxItem,
  Rule,
  StoredEvent,
} from '../types.js';
import { checkCaps, checkSendWindow, redeliveryAllowed } from './guards.js';
import {
  renderButtonLabel,
  renderFollowUp,
  renderGate,
  renderPrompt,
  renderReprompt,
  renderResource,
  renderResourceButton,
} from './render.js';

export interface EngineDeps {
  repo: Repository;
  meta: MetaClient;
  cfg: Config;
  log: Logger;
  limiter: TokenBucket;
  /** Injectable clock. Tests drive it; production passes Date.now. */
  now?: () => Date;
  /** Injectable jitter so backoff is assertable. */
  random?: () => number;
}

export interface DeliveryOutcome {
  status: 'sent' | 'retried' | 'failed' | 'deferred' | 'dropped';
  reason?: string;
}

/** What processEvent writes back onto the events row. */
interface EventOutcome {
  status: 'done' | 'skipped';
  detail: string | null;
}

/** Everything runEffect needs that is not on the conversation row itself. */
interface EffectContext {
  rule: Rule;
  /** The event that triggered this, when there was one. */
  event: StoredEvent | null;
  /** conversation.attempts AFTER the decision was applied. */
  attempts: number;
  /** Was this conversation already delivered BEFORE this decision? */
  wasDelivered: boolean;
}

export class Engine {
  private readonly repo: Repository;
  private readonly meta: MetaClient;
  private readonly cfg: Config;
  private readonly log: Logger;
  private readonly limiter: TokenBucket;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(deps: EngineDeps) {
    this.repo = deps.repo;
    this.meta = deps.meta;
    this.cfg = deps.cfg;
    this.log = deps.log;
    this.limiter = deps.limiter;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
  }

  // =========================================================================
  // 1. Inbound events
  // =========================================================================

  async processEvent(event: StoredEvent): Promise<void> {
    try {
      await this.repo.upsertContact(event.igsid, event.username, event.occurredAt);

      let outcome: EventOutcome;
      switch (event.type) {
        case 'comment':
          outcome = await this.handleComment(event);
          break;
        case 'postback':
          outcome = await this.handlePostback(event);
          break;
        case 'message':
          outcome = await this.handleMessage(event);
          break;
      }
      await this.repo.finishEvent(event.id, outcome.status, outcome.detail, this.now());
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.log.error(
        { eventId: event.id, providerEventId: event.providerEventId, err: detail },
        'event processing failed',
      );
      await this.repo.finishEvent(event.id, 'error', detail, this.now());
      await this.audit({
        direction: 'internal',
        action: `event.${event.type}`,
        igsid: event.igsid,
        providerId: event.providerEventId,
        status: 'error',
        detail,
      });
    }
  }

  /** A comment landed. Match it, or skip it with a recorded reason. */
  private async handleComment(event: StoredEvent): Promise<EventOutcome> {
    // Never reply to ourselves. The operator's own comments arrive on the same
    // webhook, and answering them would start a conversation with ourselves.
    if (event.igsid === this.cfg.IG_USER_ID) {
      return this.skip(event, 'operator_own_comment', 'comment is from the account owner');
    }
    if (!event.commentId) {
      return this.skip(event, 'no_comment_id', 'comment notification had no comment id');
    }

    const rules = await this.repo.listRules();
    const outcome = selectRule(rules, { text: event.text ?? '', mediaId: event.mediaId });
    if (!outcome) {
      return this.skip(event, 'no_rule_matched', `no rule matched "${previewText(event.text)}"`);
    }

    const { rule, keyword } = outcome;
    const conversation = await this.repo.createConversation(
      { igsid: event.igsid, ruleId: rule.id, commentId: event.commentId, state: 'NEW' },
      this.now(),
    );

    await this.audit({
      direction: 'inbound',
      action: 'comment.matched',
      igsid: event.igsid,
      conversationId: conversation.id,
      providerId: event.commentId,
      status: 'ok',
      detail: `rule=${rule.id} keyword=${keyword}`,
    });

    const decision = await this.apply(conversation, rule, { kind: 'comment_matched' }, event);
    return { status: 'done', detail: decision.reason };
  }

  /** The person tapped our button. This is the consent + window opener. */
  private async handlePostback(event: StoredEvent): Promise<EventOutcome> {
    const decoded = decodePayload(event.postbackPayload);
    if (!decoded) {
      return this.skip(
        event,
        'unknown_postback',
        'postback payload is not one of ours (icebreaker or persistent menu?)',
      );
    }
    const rule = await this.repo.getRule(decoded.ruleId);
    if (!rule) {
      return this.skip(event, 'rule_deleted', `postback references missing rule ${decoded.ruleId}`);
    }
    if (!rule.enabled) {
      return this.skip(event, 'rule_disabled', `rule ${rule.id} is disabled`);
    }

    // A tap can arrive for someone who never commented (an old button, a
    // forwarded message). createConversation is keyed on (igsid, rule) so this
    // is safe either way.
    const conversation = await this.repo.createConversation(
      { igsid: event.igsid, ruleId: rule.id, commentId: null, state: 'NEW' },
      this.now(),
    );

    await this.audit({
      direction: 'inbound',
      action: 'postback.received',
      igsid: event.igsid,
      conversationId: conversation.id,
      providerId: event.providerEventId,
      status: 'ok',
      detail: `action=${decoded.action} rule=${rule.id} state=${conversation.state}`,
    });

    if (
      conversation.state !== 'DELIVERED' &&
      !isTerminal(conversation.state) &&
      attemptsExhausted(conversation.attempts, this.cfg.MAX_ATTEMPTS)
    ) {
      const decision = await this.apply(
        conversation,
        rule,
        { kind: 'give_up', reason: `too many follow checks (${conversation.attempts})` },
        event,
      );
      return { status: 'done', detail: decision.reason };
    }

    const decision = await this.apply(conversation, rule, { kind: 'button_tapped' }, event);
    return { status: 'done', detail: decision.reason };
  }

  /** Someone DMed a keyword with no comment involved. */
  private async handleMessage(event: StoredEvent): Promise<EventOutcome> {
    if (event.igsid === this.cfg.IG_USER_ID) {
      return this.skip(event, 'operator_own_message', 'message is from the account owner');
    }
    const rules = await this.repo.listRules();
    const outcome = selectRule(rules, { text: event.text ?? '', mediaId: null });
    if (!outcome) {
      return this.skip(event, 'no_rule_matched', `no rule matched "${previewText(event.text)}"`);
    }
    const { rule, keyword } = outcome;
    const conversation = await this.repo.createConversation(
      { igsid: event.igsid, ruleId: rule.id, commentId: null, state: 'NEW' },
      this.now(),
    );
    await this.audit({
      direction: 'inbound',
      action: 'message.matched',
      igsid: event.igsid,
      conversationId: conversation.id,
      providerId: event.providerEventId,
      status: 'ok',
      detail: `rule=${rule.id} keyword=${keyword}`,
    });

    // A DM is itself a user-initiated interaction: it opens the 24-hour window
    // and grants profile consent, so this path skips straight to the check.
    const trigger: Trigger =
      conversation.state === 'NEW' ? { kind: 'dm_matched' } : { kind: 'button_tapped' };
    const decision = await this.apply(conversation, rule, trigger, event);
    return { status: 'done', detail: decision.reason };
  }

  /** The follow check came back. Called by deliver() once Meta answers. */
  async onFollowResult(conversationId: string, follows: boolean): Promise<void> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) return;
    const rule = await this.repo.getRule(conversation.ruleId);
    if (!rule) return;
    await this.repo.setContactFollows(conversation.igsid, follows, this.now());
    await this.apply(conversation, rule, { kind: 'follow_result', follows }, null);
  }

  /** The profile API refused for lack of consent. Ask for one more tap. */
  async onConsentRequired(conversationId: string): Promise<void> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) return;
    const rule = await this.repo.getRule(conversation.ruleId);
    if (!rule) return;
    await this.apply(conversation, rule, { kind: 'consent_required' }, null);
  }

  /** Something unrecoverable happened while sending for this conversation. */
  async onUnrecoverable(conversationId: string, reason: string): Promise<void> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) return;
    // If the resource genuinely arrived, a later failure (e.g. the follow-up
    // message) must not reopen the conversation as FAILED. If it did not
    // arrive, FAILED is the truth even when the state machine said DELIVERED.
    if (conversation.deliveredAt !== null || isTerminal(conversation.state)) return;
    const rule = await this.repo.getRule(conversation.ruleId);
    if (!rule) return;
    await this.apply(conversation, rule, { kind: 'give_up', reason }, null);
  }

  // =========================================================================
  // 2. Applying a decision
  // =========================================================================

  private async apply(
    conversation: Conversation,
    rule: Rule,
    trigger: Trigger,
    event: StoredEvent | null,
  ): Promise<Decision> {
    const now = this.now();
    const wasDelivered = conversation.deliveredAt !== null;
    const decision = decide(conversation.state, trigger, {
      requireFollow: rule.requireFollow,
      attempts: conversation.attempts,
      maxAttempts: this.cfg.MAX_ATTEMPTS,
      redeliveryAllowed: redeliveryAllowed(
        conversation.deliveredAt,
        now,
        this.cfg.REDELIVERY_COOLDOWN_MINUTES,
      ),
    });

    const attempts = decision.incrementAttempts ? conversation.attempts + 1 : conversation.attempts;
    const patch = {
      state: decision.to,
      attempts,
      lastActionAt: now,
      lastReason: decision.reason,
      // A comment, a tap or a DM is the person's own action: it (re)opens the
      // messaging window. Our own activity does not.
      ...(event ? { windowOpenedAt: event.occurredAt } : {}),
      ...(event?.commentId && conversation.commentId === null
        ? { commentId: event.commentId }
        : {}),
    };
    // Note: `deliveredAt` is NOT set here. The state machine can decide to
    // deliver, but the resource is only "delivered" once Meta has accepted the
    // message â€” see markDelivered(), called from deliver().
    const updated = await this.repo.updateConversation(conversation.id, patch);

    if (decision.to !== conversation.state) {
      await this.repo.recordTransition({
        conversationId: conversation.id,
        from: conversation.state,
        to: decision.to,
        reason: decision.reason,
        at: now,
      });
      this.log.info(
        {
          conversationId: conversation.id,
          igsid: conversation.igsid,
          from: conversation.state,
          to: decision.to,
          trigger: trigger.kind,
        },
        decision.reason,
      );
    }

    await this.audit({
      direction: 'internal',
      action: `state.${conversation.state}->${decision.to}`,
      igsid: conversation.igsid,
      conversationId: conversation.id,
      status: 'ok',
      detail: decision.reason,
    });

    const ctx: EffectContext = { rule, event, attempts, wasDelivered };
    for (const effect of decision.effects) {
      await this.runEffect(effect, updated, ctx);
    }
    return decision;
  }

  private async runEffect(
    effect: Effect,
    conversation: Conversation,
    ctx: EffectContext,
  ): Promise<void> {
    const { rule, event, attempts } = ctx;
    const now = this.now();
    const triggerId = event?.providerEventId ?? 'internal';

    // Every row inherits the conversation's window origin: the person's last
    // own action. That is what decides whether we are still allowed to send
    // when the row finally reaches the front of the queue.
    const queue = (item: Omit<NewOutboxItem, 'windowOpenedAt'>): Promise<void> =>
      this.enqueue({ ...item, windowOpenedAt: conversation.windowOpenedAt });

    switch (effect.kind) {
      case 'none':
        return;

      case 'send_comment_prompt': {
        const commentId = conversation.commentId ?? event?.commentId ?? null;
        if (!commentId) {
          this.log.warn(
            { conversationId: conversation.id },
            'comment prompt effect with no comment id; nothing queued',
          );
          return;
        }
        // (a) the public reply under the comment.
        const publicReply = pickPublicReply(rule, commentId);
        if (publicReply) {
          await queue({
            conversationId: conversation.id,
            igsid: null,
            kind: 'public_reply',
            dedupeKey: `public_reply:${commentId}`,
            request: { op: 'comment_reply', commentId, message: publicReply },
          });
        }
        // (b) the one private reply we are entitled to. It carries the button,
        // because a comment alone does not grant profile consent and we only
        // get one shot.
        await queue({
          conversationId: conversation.id,
          igsid: conversation.igsid,
          kind: 'private_reply_prompt',
          dedupeKey: `private_reply:${commentId}`,
          request: {
            op: 'private_reply',
            commentId,
            message: renderPrompt(rule),
            button: this.button('DELIVER', rule),
          },
        });
        return;
      }

      case 'send_dm_prompt': {
        await queue({
          conversationId: conversation.id,
          igsid: conversation.igsid,
          kind: 'dm_prompt',
          dedupeKey: `dm_prompt:${conversation.id}:${triggerId}`,
          request: {
            op: 'dm',
            igsid: conversation.igsid,
            message: renderPrompt(rule),
            button: this.button('DELIVER', rule),
          },
        });
        return;
      }

      case 'check_follow': {
        // One check per attempt, enforced by the dedupe key. A second tap while
        // a check is in flight cannot produce a second call.
        await queue({
          conversationId: conversation.id,
          igsid: conversation.igsid,
          kind: 'follow_check',
          dedupeKey: `follow_check:${conversation.id}:${attempts}`,
          request: { op: 'follow_check', igsid: conversation.igsid },
        });
        return;
      }

      case 'send_gate': {
        await queue({
          conversationId: conversation.id,
          igsid: conversation.igsid,
          kind: 'gate_message',
          dedupeKey: `gate:${conversation.id}:${attempts}`,
          request: {
            op: 'dm',
            igsid: conversation.igsid,
            message: renderGate(rule),
            button: this.button('RECHECK', rule),
          },
        });
        return;
      }

      case 'send_reprompt': {
        await queue({
          conversationId: conversation.id,
          igsid: conversation.igsid,
          kind: 'reprompt',
          dedupeKey: `reprompt:${conversation.id}:${attempts}`,
          request: {
            op: 'dm',
            igsid: conversation.igsid,
            message: renderReprompt(rule),
            button: this.button('RECHECK', rule),
          },
        });
        return;
      }

      case 'send_resource': {
        // The first delivery is keyed on the conversation alone, so no amount
        // of webhook replay can send it twice. A deliberate re-delivery (a tap
        // after the cooldown) is keyed on the tap, so it is replay-safe too.
        const suffix = ctx.wasDelivered ? `:redeliver:${triggerId}` : '';
        const resourceButton = renderResourceButton(rule.resourcePayload);
        await queue({
          conversationId: conversation.id,
          igsid: conversation.igsid,
          kind: 'resource',
          dedupeKey: `resource:${conversation.id}${suffix}`,
          request: {
            op: 'dm',
            igsid: conversation.igsid,
            message: renderResource(rule.resourcePayload),
            // The link rides on a tappable button when the rule has one.
            ...(resourceButton ? { button: resourceButton } : {}),
          },
        });
        const followUp = renderFollowUp(rule.resourcePayload);
        if (followUp) {
          await queue({
            conversationId: conversation.id,
            igsid: conversation.igsid,
            kind: 'resource_followup',
            dedupeKey: `resource_followup:${conversation.id}${suffix}`,
            request: { op: 'dm', igsid: conversation.igsid, message: followUp },
            // A beat after the resource so the two messages arrive in order.
            nextAttemptAt: new Date(now.getTime() + 1_000),
          });
        }
        return;
      }
    }
  }

  private button(action: 'DELIVER' | 'RECHECK', rule: Rule): ButtonSpec {
    return {
      label: renderButtonLabel(rule),
      payload: encodePayload(action, rule.id, makeNonce()),
    };
  }

  /**
   * Queue one outbound call. `windowOpenedAt` defaults to the conversation's,
   * which is the person's last own action â€” the thing that actually governs
   * whether we are still allowed to send.
   */
  private async enqueue(item: NewOutboxItem): Promise<void> {
    const { item: row, created } = await this.repo.enqueue(item, this.now());
    await this.audit({
      direction: 'internal',
      action: `outbox.${created ? 'queued' : 'deduped'}`,
      igsid: item.igsid,
      conversationId: item.conversationId,
      providerId: row.id,
      status: created ? 'queued' : 'duplicate',
      detail: `kind=${item.kind} dedupe=${item.dedupeKey}`,
    });
    if (!created) {
      this.log.info(
        { kind: item.kind, dedupeKey: item.dedupeKey },
        'outbox row already existed; not sending twice',
      );
    }
  }

  // =========================================================================
  // 3. Sending
  // =========================================================================

  async deliver(item: OutboxItem): Promise<DeliveryOutcome> {
    const now = this.now();

    // --- is it still allowed to be sent at all? ---------------------------
    const windowGate = checkSendWindow({
      kind: item.kind,
      windowOpenedAt: item.windowOpenedAt,
      now,
      messagingWindowHours: this.cfg.MESSAGING_WINDOW_HOURS,
      privateReplyMaxAgeHours: this.cfg.PRIVATE_REPLY_MAX_AGE_HOURS,
    });
    if (windowGate.decision === 'drop') {
      return this.dropRow(item, windowGate.reason);
    }

    // --- caps and cooldowns ----------------------------------------------
    const capGate = checkCaps({
      kind: item.kind,
      now,
      sentLastHour: await this.repo.countMessagesSentSince(new Date(now.getTime() - 3_600_000)),
      maxPerHour: this.cfg.MAX_MESSAGES_PER_HOUR,
      sentToContactLast24h: item.igsid
        ? await this.repo.countMessagesSentToContactSince(
            item.igsid,
            new Date(now.getTime() - 86_400_000),
          )
        : 0,
      maxPerContactPerDay: this.cfg.MAX_MESSAGES_PER_CONTACT_PER_DAY,
      lastMessageToContactAt: item.igsid
        ? await this.repo.lastMessageToContactAt(item.igsid)
        : null,
      contactCooldownMinutes: this.cfg.CONTACT_COOLDOWN_MINUTES,
    });
    if (capGate.decision === 'drop') {
      return this.dropRow(item, capGate.reason);
    }
    if (capGate.decision === 'defer') {
      await this.repo.rescheduleOutbox(
        item.id,
        new Date(now.getTime() + capGate.retryAfterMs),
        capGate.reason,
        false,
      );
      this.log.info({ outboxId: item.id, kind: item.kind }, `deferred: ${capGate.reason}`);
      return { status: 'deferred', reason: capGate.reason };
    }

    // --- the account's API budget ----------------------------------------
    const token = this.limiter.tryRemove();
    if (!token.allowed) {
      await this.repo.rescheduleOutbox(
        item.id,
        new Date(now.getTime() + token.retryAfterMs),
        'local rate limiter: no tokens',
        false,
      );
      return { status: 'deferred', reason: 'local rate limiter' };
    }

    // --- the actual call --------------------------------------------------
    try {
      const providerId = await this.call(item);
      await this.repo.markOutboxSent(item.id, providerId, this.now());
      // The resource is only "delivered" once Meta has accepted it. Until this
      // line runs, the conversation can still move to FAILED.
      if (item.kind === 'resource' && item.conversationId) {
        await this.markDelivered(item.conversationId);
      }
      await this.audit({
        direction: 'outbound',
        action: `meta.${item.kind}`,
        igsid: item.igsid,
        conversationId: item.conversationId,
        providerId,
        status: 'sent',
        detail: this.cfg.DRY_RUN ? 'DRY_RUN: no Meta call was made' : null,
      });
      this.log.info(
        { outboxId: item.id, kind: item.kind, providerId, dryRun: this.cfg.DRY_RUN },
        'sent',
      );
      return { status: 'sent' };
    } catch (e) {
      return this.handleSendError(item, e);
    }
  }

  /** Dispatch one typed request to the Meta client. */
  private async call(item: OutboxItem): Promise<string | null> {
    const req = item.request;
    switch (req.op) {
      case 'comment_reply': {
        const r = await this.meta.replyToComment(req.commentId, req.message);
        return r.id;
      }
      case 'private_reply': {
        const r = await this.meta.sendPrivateReply(req.commentId, req.message, req.button);
        return r.messageId;
      }
      case 'dm': {
        const r = await this.meta.sendDirectMessage(req.igsid, req.message, req.button);
        return r.messageId;
      }
      case 'follow_check': {
        const profile = await this.meta.getUserProfile(req.igsid);
        if (item.conversationId) {
          // Meta can omit the field; treat "unknown" as "not following" rather
          // than handing out the resource on a guess.
          await this.onFollowResult(item.conversationId, profile.isUserFollowBusiness === true);
        }
        return profile.id;
      }
    }
  }

  private async handleSendError(item: OutboxItem, e: unknown): Promise<DeliveryOutcome> {
    const now = this.now();
    if (!isMetaError(e)) {
      // A bug in our own code, not Meta's fault. Fail loudly; do not retry.
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await this.repo.markOutboxFailed(item.id, `internal: ${detail}`, now);
      this.log.error({ outboxId: item.id, kind: item.kind, err: detail }, 'send failed internally');
      if (item.conversationId) await this.onUnrecoverable(item.conversationId, `internal: ${detail}`);
      return { status: 'failed', reason: detail };
    }

    const err: MetaError = e;
    const summary = err.summary();

    await this.audit({
      direction: 'outbound',
      action: `meta.${item.kind}`,
      igsid: item.igsid,
      conversationId: item.conversationId,
      providerId: item.id,
      status: `error:${err.category}`,
      detail: summary,
    });

    // Consent on the profile API is not a failure of ours: the person simply
    // has not tapped anything yet. Re-prompt instead of retrying.
    if (err.category === 'consent_required') {
      await this.repo.markOutboxFailed(item.id, summary, now);
      if (item.conversationId) await this.onConsentRequired(item.conversationId);
      this.log.info({ outboxId: item.id }, 'profile consent not granted; re-prompting');
      return { status: 'failed', reason: 'consent_required' };
    }

    // The window closed. Retrying would fail forever and looks like abuse.
    if (err.category === 'window_expired') {
      await this.repo.markOutboxFailed(item.id, summary, now);
      if (item.conversationId) {
        await this.onUnrecoverable(item.conversationId, '24h messaging window expired');
      }
      this.log.warn({ outboxId: item.id, kind: item.kind }, 'messaging window expired; not retrying');
      return { status: 'failed', reason: 'window_expired' };
    }

    // Permission / validation / unknown: never retry. A human has to look.
    if (!err.retryable) {
      await this.repo.markOutboxFailed(item.id, summary, now);
      if (item.conversationId) await this.onUnrecoverable(item.conversationId, summary);
      this.log.error({ outboxId: item.id, kind: item.kind, category: err.category }, summary);
      return { status: 'failed', reason: err.category };
    }

    // Rate limit or transient: back off and try again.
    const attempt = item.attempts + 1;
    if (attempt >= this.cfg.MAX_ATTEMPTS) {
      await this.repo.markOutboxFailed(item.id, `${summary} (gave up after ${attempt})`, now);
      if (item.conversationId) {
        await this.onUnrecoverable(item.conversationId, `gave up after ${attempt} attempts`);
      }
      this.log.error({ outboxId: item.id, attempts: attempt }, 'out of retries');
      return { status: 'failed', reason: 'max_attempts' };
    }
    const at = nextAttemptAt(now, attempt, {
      baseMs: this.cfg.BACKOFF_BASE_MS,
      maxMs: this.cfg.BACKOFF_MAX_MS,
      random: this.random,
    });
    await this.repo.rescheduleOutbox(item.id, at, summary, true);
    this.log.warn(
      {
        outboxId: item.id,
        kind: item.kind,
        category: err.category,
        attempt,
        retryInMs: at.getTime() - now.getTime(),
        ceilingMs: backoffCeilingMs(attempt, this.cfg.BACKOFF_BASE_MS, this.cfg.BACKOFF_MAX_MS),
      },
      'retrying after backoff',
    );
    return { status: 'retried', reason: err.category };
  }

  /**
   * Stamp the moment the person actually received the resource.
   *
   * This is updated on EVERY confirmed delivery, not just the first, so the
   * re-delivery cooldown slides: someone tapping the button over and over gets
   * at most one copy per REDELIVERY_COOLDOWN_MINUTES, not one per tap.
   */
  private async markDelivered(conversationId: string): Promise<void> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) return;
    await this.repo.updateConversation(conversationId, {
      state: 'DELIVERED',
      deliveredAt: this.now(),
      lastReason: 'resource delivered',
    });
    await this.audit({
      direction: 'internal',
      action: 'resource.delivered',
      igsid: conversation.igsid,
      conversationId,
      status: 'ok',
    });
  }

  private async dropRow(item: OutboxItem, reason: string): Promise<DeliveryOutcome> {
    await this.repo.markOutboxFailed(item.id, reason, this.now());
    await this.audit({
      direction: 'internal',
      action: `outbox.dropped`,
      igsid: item.igsid,
      conversationId: item.conversationId,
      providerId: item.id,
      status: 'dropped',
      detail: reason,
    });
    if (item.conversationId) await this.onUnrecoverable(item.conversationId, reason);
    this.log.warn({ outboxId: item.id, kind: item.kind }, `dropped: ${reason}`);
    return { status: 'dropped', reason };
  }

  // =========================================================================
  // 4. Housekeeping
  // =========================================================================

  /** Mark conversations ABANDONED when the person never came back. */
  async sweepIdle(limit = 50): Promise<number> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - this.cfg.ABANDON_AFTER_HOURS * 3_600_000);
    const stale = await this.repo.conversationsIdleSince(cutoff, limit);
    for (const conversation of stale) {
      const rule = await this.repo.getRule(conversation.ruleId);
      if (!rule) continue;
      await this.apply(conversation, rule, { kind: 'timed_out' }, null);
    }
    return stale.length;
  }

  private async skip(event: StoredEvent, code: string, detail: string): Promise<EventOutcome> {
    this.log.info({ eventId: event.id, code }, detail);
    await this.audit({
      direction: 'inbound',
      action: `event.${event.type}.skipped`,
      igsid: event.igsid,
      providerId: event.providerEventId,
      status: code,
      detail,
    });
    return { status: 'skipped', detail: `${code}: ${detail}` };
  }

  private async audit(entry: Parameters<Repository['appendAudit']>[0]): Promise<void> {
    await this.repo.appendAudit(entry, this.now());
  }
}

