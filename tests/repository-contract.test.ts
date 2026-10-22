/**
 * The Repository contract, asserted against every implementation.
 *
 * MemoryRepository always runs. PostgresRepository runs too when
 * TEST_DATABASE_URL is set. Both must behave identically — especially around
 * the three uniqueness guarantees that keep us from messaging anyone twice.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { MemoryRepository } from '../src/repo/memory.js';
import { PostgresRepository } from '../src/repo/postgres.js';
import { runMigrations } from '../src/repo/migrate.js';
import type { Repository } from '../src/repo/repository.js';
import type { InboundEvent, NewRule } from '../src/types.js';

const NOW = new Date('2026-03-01T10:00:00.000Z');

function ruleDraft(id: string): NewRule {
  return {
    id,
    name: `rule ${id}`,
    enabled: true,
    scope: 'global',
    igMediaId: null,
    matchType: 'contains',
    keywords: ['guide', 'link'],
    caseInsensitive: true,
    publicReplyVariants: ['Sent you a DM ✅', 'Check your DMs ✅'],
    dmPromptText: 'Tap below',
    buttonLabel: 'Send it',
    gateMessage: 'Follow first',
    resourcePayload: { text: 'Here it is', url: 'https://example.com/x', followUp: 'enjoy' },
    requireFollow: true,
    priority: 3,
  };
}

function eventDraft(providerEventId: string): InboundEvent {
  return {
    providerEventId,
    type: 'comment',
    igsid: 'igsid_1',
    username: 'someone',
    commentId: 'comment_1',
    mediaId: 'media_1',
    text: 'send the guide',
    postbackPayload: null,
    occurredAt: NOW,
    raw: { object: 'instagram' },
  };
}

function contractTests(label: string, makeRepo: () => Promise<Repository>): void {
  describe(`Repository contract [${label}]`, () => {
    let repo: Repository;

    const fresh = async (): Promise<Repository> => {
      repo = await makeRepo();
      await repo.init();
      return repo;
    };

    afterEach(async () => {
      if (repo) await repo.close();
    });

    it('round-trips a rule, arrays and jsonb included', async () => {
      const r = await (await fresh()).createRule(ruleDraft('guide'));
      expect(r.id).toBe('guide');
      const read = await repo.getRule('guide');
      expect(read).toEqual(r);
      expect(read?.keywords).toEqual(['guide', 'link']);
      expect(read?.publicReplyVariants).toHaveLength(2);
      expect(read?.resourcePayload).toEqual({
        text: 'Here it is',
        url: 'https://example.com/x',
        followUp: 'enjoy',
      });
    });

    it('patches only the fields given', async () => {
      await (await fresh()).createRule(ruleDraft('guide'));
      const updated = await repo.updateRule('guide', { enabled: false });
      expect(updated?.enabled).toBe(false);
      expect(updated?.keywords).toEqual(['guide', 'link']);
      expect(await repo.updateRule('nope', { enabled: false })).toBeNull();
    });

    it('de-duplicates events on provider_event_id', async () => {
      await fresh();
      const first = await repo.insertEvent(eventDraft('comment:1'), NOW);
      expect(first.duplicate).toBe(false);
      const second = await repo.insertEvent(eventDraft('comment:1'), NOW);
      expect(second.duplicate).toBe(true);
      expect(second.stored.id).toBe(first.stored.id);
    });

    it('claims each event exactly once', async () => {
      await fresh();
      await repo.insertEvent(eventDraft('comment:1'), NOW);
      await repo.insertEvent(eventDraft('comment:2'), NOW);
      const a = await repo.claimEvents(10, NOW);
      expect(a).toHaveLength(2);
      const b = await repo.claimEvents(10, NOW);
      expect(b).toHaveLength(0);
      await repo.finishEvent(a[0]!.id, 'done', null, NOW);
      const done = await repo.getEventByProviderId(a[0]!.providerEventId);
      expect(done?.status).toBe('done');
      expect(done?.processedAt).not.toBeNull();
    });

    it('keeps one conversation per (person, rule)', async () => {
      await fresh();
      await repo.createRule(ruleDraft('guide'));
      await repo.upsertContact('igsid_1', 'someone', NOW);
      const a = await repo.createConversation(
        { igsid: 'igsid_1', ruleId: 'guide', commentId: 'c1', state: 'NEW' },
        NOW,
      );
      const b = await repo.createConversation(
        { igsid: 'igsid_1', ruleId: 'guide', commentId: 'c2', state: 'NEW' },
        NOW,
      );
      expect(b.id).toBe(a.id);
      // The first comment id is kept, not overwritten.
      expect(b.commentId).toBe('c1');
      expect(await repo.listConversations(10)).toHaveLength(1);
    });

    it('fills in a comment id that was missing', async () => {
      await fresh();
      await repo.createRule(ruleDraft('guide'));
      await repo.upsertContact('igsid_1', null, NOW);
      await repo.createConversation(
        { igsid: 'igsid_1', ruleId: 'guide', commentId: null, state: 'NEW' },
        NOW,
      );
      const second = await repo.createConversation(
        { igsid: 'igsid_1', ruleId: 'guide', commentId: 'c9', state: 'NEW' },
        NOW,
      );
      expect(second.commentId).toBe('c9');
    });

    it('patches a conversation and records transitions', async () => {
      await fresh();
      await repo.createRule(ruleDraft('guide'));
      await repo.upsertContact('igsid_1', null, NOW);
      const conv = await repo.createConversation(
        { igsid: 'igsid_1', ruleId: 'guide', commentId: 'c1', state: 'NEW' },
        NOW,
      );
      const updated = await repo.updateConversation(conv.id, {
        state: 'DELIVERED',
        attempts: 2,
        deliveredAt: NOW,
        lastReason: 'followed',
      });
      expect(updated.state).toBe('DELIVERED');
      expect(updated.attempts).toBe(2);
      expect(updated.deliveredAt?.toISOString()).toBe(NOW.toISOString());

      await repo.recordTransition({
        conversationId: conv.id,
        from: 'NEW',
        to: 'DELIVERED',
        reason: 'followed',
        at: NOW,
      });
      const transitions = await repo.listTransitions(conv.id);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({ from: 'NEW', to: 'DELIVERED', reason: 'followed' });
    });

    it('collapses outbox rows with the same dedupe key', async () => {
      await fresh();
      const a = await repo.enqueue(
        {
          conversationId: null,
          igsid: 'igsid_1',
          kind: 'resource',
          dedupeKey: 'resource:conv-1',
          request: { op: 'dm', igsid: 'igsid_1', message: 'here' },
        },
        NOW,
      );
      expect(a.created).toBe(true);
      const b = await repo.enqueue(
        {
          conversationId: null,
          igsid: 'igsid_1',
          kind: 'resource',
          dedupeKey: 'resource:conv-1',
          request: { op: 'dm', igsid: 'igsid_1', message: 'here again' },
        },
        NOW,
      );
      expect(b.created).toBe(false);
      expect(b.item.id).toBe(a.item.id);
      expect(await repo.listOutbox('all', 10)).toHaveLength(1);
    });

    it('claims only rows that are due, and only once', async () => {
      await fresh();
      await repo.enqueue(
        {
          conversationId: null,
          igsid: 'u',
          kind: 'resource',
          dedupeKey: 'now',
          request: { op: 'dm', igsid: 'u', message: 'a' },
        },
        NOW,
      );
      await repo.enqueue(
        {
          conversationId: null,
          igsid: 'u',
          kind: 'resource',
          dedupeKey: 'later',
          request: { op: 'dm', igsid: 'u', message: 'b' },
          nextAttemptAt: new Date(NOW.getTime() + 60_000),
        },
        NOW,
      );
      expect(await repo.claimOutbox(10, NOW)).toHaveLength(1);
      expect(await repo.claimOutbox(10, NOW)).toHaveLength(0);
      expect(await repo.claimOutbox(10, new Date(NOW.getTime() + 61_000))).toHaveLength(1);
    });

    it('tracks sends, retries and failures', async () => {
      await fresh();
      const { item } = await repo.enqueue(
        {
          conversationId: null,
          igsid: 'u',
          kind: 'resource',
          dedupeKey: 'k',
          request: { op: 'dm', igsid: 'u', message: 'a' },
        },
        NOW,
      );
      await repo.claimOutbox(10, NOW);
      await repo.rescheduleOutbox(item.id, new Date(NOW.getTime() + 1_000), 'rate_limit', true);
      let row = await repo.getOutboxItem(item.id);
      expect(row).toMatchObject({ status: 'queued', attempts: 1, lastError: 'rate_limit' });

      // A deferral does not burn an attempt.
      await repo.rescheduleOutbox(item.id, new Date(NOW.getTime() + 2_000), 'cooldown', false);
      row = await repo.getOutboxItem(item.id);
      expect(row?.attempts).toBe(1);

      await repo.markOutboxSent(item.id, 'mid_1', NOW);
      row = await repo.getOutboxItem(item.id);
      expect(row).toMatchObject({ status: 'sent', providerMessageId: 'mid_1', attempts: 2 });
      expect(row?.lastError).toBeNull();
    });

    it('only requeues failed rows', async () => {
      await fresh();
      const { item } = await repo.enqueue(
        {
          conversationId: null,
          igsid: 'u',
          kind: 'resource',
          dedupeKey: 'k',
          request: { op: 'dm', igsid: 'u', message: 'a' },
        },
        NOW,
      );
      await repo.markOutboxSent(item.id, 'mid', NOW);
      const notRequeued = await repo.requeueOutbox(item.id, NOW);
      expect(notRequeued?.status).toBe('sent');

      await repo.markOutboxFailed(item.id, 'boom', NOW);
      const requeued = await repo.requeueOutbox(item.id, NOW);
      expect(requeued).toMatchObject({ status: 'queued', attempts: 0, lastError: null });
      expect(await repo.requeueOutbox('00000000-0000-0000-0000-000000000000', NOW)).toBeNull();
    });

    it('counts messages for the caps, ignoring follow checks', async () => {
      await fresh();
      const enqueueAndSend = async (
        key: string,
        kind: 'resource' | 'follow_check',
        at: Date,
      ): Promise<void> => {
        const { item } = await repo.enqueue(
          {
            conversationId: null,
            igsid: 'u',
            kind,
            dedupeKey: key,
            request:
              kind === 'follow_check'
                ? { op: 'follow_check', igsid: 'u' }
                : { op: 'dm', igsid: 'u', message: 'x' },
          },
          at,
        );
        await repo.markOutboxSent(item.id, 'mid', at);
      };
      await enqueueAndSend('a', 'resource', NOW);
      await enqueueAndSend('b', 'resource', NOW);
      await enqueueAndSend('c', 'follow_check', NOW);
      const since = new Date(NOW.getTime() - 3_600_000);
      expect(await repo.countMessagesSentSince(since)).toBe(2);
      expect(await repo.countMessagesSentToContactSince('u', since)).toBe(2);
      expect(await repo.countMessagesSentToContactSince('other', since)).toBe(0);
      expect((await repo.lastMessageToContactAt('u'))?.toISOString()).toBe(NOW.toISOString());
      expect(await repo.lastMessageToContactAt('nobody')).toBeNull();
    });

    it('upserts a contact without losing the username, and caches the follow answer', async () => {
      await fresh();
      await repo.upsertContact('igsid_1', 'someone', NOW);
      const later = new Date(NOW.getTime() + 1_000);
      const again = await repo.upsertContact('igsid_1', null, later);
      expect(again.username).toBe('someone');
      expect(again.lastSeenAt.getTime()).toBe(later.getTime());

      await repo.setContactFollows('igsid_1', true, later);
      const contact = await repo.getContact('igsid_1');
      expect(contact?.followsCached).toBe(true);
      expect(contact?.followsCheckedAt?.getTime()).toBe(later.getTime());
      expect(await repo.getContact('nobody')).toBeNull();
    });

    it('appends to the audit log, newest first', async () => {
      await fresh();
      await repo.appendAudit({ direction: 'inbound', action: 'a', status: 'ok' }, NOW);
      await repo.appendAudit(
        { direction: 'outbound', action: 'b', status: 'sent', providerId: 'mid' },
        new Date(NOW.getTime() + 1_000),
      );
      const audit = await repo.listAudit(10);
      expect(audit).toHaveLength(2);
      expect(audit[0]?.action).toBe('b');
      expect(audit[0]?.providerId).toBe('mid');
    });

    it('finds idle conversations but leaves settled ones alone', async () => {
      await fresh();
      await repo.createRule(ruleDraft('guide'));
      await repo.upsertContact('a', null, NOW);
      await repo.upsertContact('b', null, NOW);
      const idle = await repo.createConversation(
        { igsid: 'a', ruleId: 'guide', commentId: null, state: 'GATED' },
        NOW,
      );
      const done = await repo.createConversation(
        { igsid: 'b', ruleId: 'guide', commentId: null, state: 'NEW' },
        NOW,
      );
      await repo.updateConversation(idle.id, { state: 'GATED', lastActionAt: NOW });
      await repo.updateConversation(done.id, { state: 'DELIVERED', lastActionAt: NOW });

      const stale = await repo.conversationsIdleSince(new Date(NOW.getTime() + 1_000), 10);
      expect(stale.map((c) => c.igsid)).toEqual(['a']);
    });

    it('reports healthy', async () => {
      await fresh();
      expect(await repo.health()).toMatchObject({ ok: true });
    });
  });
}

contractTests('memory', async () => new MemoryRepository());

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  describe.skip('Repository contract [postgres]', () => {
    it('skipped: set TEST_DATABASE_URL to run against real Postgres', () => {
      /* intentionally empty */
    });
  });
} else {
  const connectionString = url;
  let admin: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString, max: 2 });
    await runMigrations(admin);
  }, 60_000);

  afterAll(async () => {
    await admin.end();
  });

  contractTests('postgres', async () => {
    await admin.query(
      'truncate conversation_transitions, outbox, conversations, events, audit_log, contacts, rules restart identity cascade',
    );
    return new PostgresRepository({ connectionString, max: 3 });
  });
}
