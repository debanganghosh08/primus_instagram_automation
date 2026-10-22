/**
 * The full-flow integration suite.
 *
 * It is a function, not a test file, because it runs twice: once against the
 * MemoryRepository (always) and once against real Postgres (only when
 * TEST_DATABASE_URL is set). Same assertions, same harness, two storage
 * engines — so the SQL is exercised without making Postgres a requirement.
 *
 * Every test drives the service through its real HTTP webhook, with a real
 * HMAC signature, and asserts on both the database state and the exact calls
 * the Meta client made.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../../src/testing/harness.js';
import { MockErrors } from '../../src/testing/mock-meta.js';
import type { Repository } from '../../src/repo/repository.js';
import type { Config } from '../../src/config.js';

export interface SuiteContext {
  label: string;
  /** A fresh, empty repository for each test. */
  makeRepo: () => Promise<Repository>;
}

const FAN = 'igsid_fan_1';
const NON_FOLLOWER = 'igsid_fan_2';

export function runFlowSuite(ctx: SuiteContext): void {
  describe(`end-to-end flows [${ctx.label}]`, () => {
    let h: Harness;

    const boot = async (config: Partial<Config> = {}): Promise<Harness> => {
      const repo = await ctx.makeRepo();
      h = new Harness({ repo, config });
      await h.start();
      return h;
    };

    beforeEach(async () => {
      await boot();
    });

    afterEach(async () => {
      await h.stop();
    });

    // -------------------------------------------------------------------
    // The happy path
    // -------------------------------------------------------------------

    it('already-following user: comment -> public reply + private reply -> tap -> resource, exactly one check, no gate', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);

      const res = await h.postWebhook(
        h.commentPayload({ igsid: FAN, commentId: 'comment_1', text: 'send me the guide' }),
      );
      expect(res.statusCode).toBe(200);
      await h.drain();

      // (a) a public reply under the comment
      expect(h.mock.callsTo('comment_reply')).toHaveLength(1);
      expect(h.mock.callsTo('comment_reply')[0]?.target).toBe('comment_1');
      expect(h.mock.callsTo('comment_reply')[0]?.text).toBe('Sent you a DM ✅');

      // (b) exactly one private reply, and it carries the button, not the resource
      const privateReplies = h.mock.privateReplies();
      expect(privateReplies).toHaveLength(1);
      expect(privateReplies[0]?.target).toBe('comment_1');
      expect(privateReplies[0]?.buttonPayload).toMatch(/^DELIVER:guide:/);
      expect(privateReplies[0]?.text).not.toContain('https://example.com/guide');

      let conv = await h.repo.findConversation(FAN, 'guide');
      expect(conv?.state).toBe('PROMPTED');

      // The tap.
      const tap = await h.tapLastButton(FAN, 'mid_tap_1');
      expect(tap.statusCode).toBe(200);
      await h.drain();

      // Exactly one follow check.
      expect(h.mock.callsTo('user_profile')).toHaveLength(1);
      expect(h.mock.callsTo('user_profile')[0]?.target).toBe(FAN);

      // The resource arrived, as a normal DM, with the link.
      const dms = h.mock.directMessages();
      expect(dms).toHaveLength(1);
      expect(dms[0]?.text).toContain('https://example.com/guide');

      // No gate message anywhere.
      const texts = h.mock.calls.map((c) => c.text ?? '').join('\n');
      expect(texts).not.toContain('One tap: follow');

      conv = await h.repo.findConversation(FAN, 'guide');
      expect(conv?.state).toBe('DELIVERED');
      expect(conv?.attempts).toBe(1);
      expect(conv?.deliveredAt).not.toBeNull();

      const outbox = await h.repo.listOutbox('all', 50);
      expect(outbox.filter((o) => o.status !== 'sent')).toHaveLength(0);
      expect(outbox.map((o) => o.kind).sort()).toEqual([
        'follow_check',
        'private_reply_prompt',
        'public_reply',
        'resource',
      ]);
    });

    // -------------------------------------------------------------------
    // The gate
    // -------------------------------------------------------------------

    it('non-follower: tap -> gate, tap again -> gate (attempt 2), then follows -> resource', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(NON_FOLLOWER, false);

      await h.postWebhook(
        h.commentPayload({ igsid: NON_FOLLOWER, commentId: 'comment_2', text: 'guide pls' }),
      );
      await h.drain();

      // First tap: not following -> gate, with the button again.
      await h.tapLastButton(NON_FOLLOWER, 'mid_tap_1');
      await h.drain();

      let conv = await h.repo.findConversation(NON_FOLLOWER, 'guide');
      expect(conv?.state).toBe('GATED');
      expect(conv?.attempts).toBe(1);
      expect(h.mock.callsTo('user_profile')).toHaveLength(1);

      let dms = h.mock.directMessages();
      expect(dms).toHaveLength(1);
      expect(dms[0]?.text).toContain('One tap: follow');
      expect(dms[0]?.buttonPayload).toMatch(/^RECHECK:guide:/);

      // Second tap, still not following -> gate again, attempt 2.
      await h.tapLastButton(NON_FOLLOWER, 'mid_tap_2');
      await h.drain();

      conv = await h.repo.findConversation(NON_FOLLOWER, 'guide');
      expect(conv?.state).toBe('GATED');
      expect(conv?.attempts).toBe(2);
      expect(h.mock.callsTo('user_profile')).toHaveLength(2);
      dms = h.mock.directMessages();
      expect(dms).toHaveLength(2);
      expect(dms[1]?.text).toContain('One tap: follow');

      // They follow, and tap once more.
      h.mock.setFollows(NON_FOLLOWER, true);
      await h.tapLastButton(NON_FOLLOWER, 'mid_tap_3');
      await h.drain();

      conv = await h.repo.findConversation(NON_FOLLOWER, 'guide');
      expect(conv?.state).toBe('DELIVERED');
      expect(conv?.attempts).toBe(3);
      expect(h.mock.callsTo('user_profile')).toHaveLength(3);

      dms = h.mock.directMessages();
      expect(dms).toHaveLength(3);
      expect(dms[2]?.text).toContain('https://example.com/guide');

      // Still exactly one private reply across the whole journey.
      expect(h.mock.privateReplies()).toHaveLength(1);

      const contact = await h.repo.getContact(NON_FOLLOWER);
      expect(contact?.followsCached).toBe(true);
    });

    it('stops gating after MAX_ATTEMPTS and marks the conversation abandoned', async () => {
      await h.stop();
      await boot({ MAX_ATTEMPTS: 2 });
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(NON_FOLLOWER, false);

      await h.postWebhook(
        h.commentPayload({ igsid: NON_FOLLOWER, commentId: 'comment_x', text: 'guide' }),
      );
      await h.drain();

      await h.tapLastButton(NON_FOLLOWER, 'mid_1');
      await h.drain();
      await h.tapLastButton(NON_FOLLOWER, 'mid_2');
      await h.drain();
      await h.tapLastButton(NON_FOLLOWER, 'mid_3');
      await h.drain();

      const conv = await h.repo.findConversation(NON_FOLLOWER, 'guide');
      expect(conv?.state).toBe('ABANDONED');
      // Two checks happened; the third tap was refused before calling Meta.
      expect(h.mock.callsTo('user_profile')).toHaveLength(2);
      expect(h.mock.directMessages().filter((d) => d.text?.includes('One tap'))).toHaveLength(1);
    });

    // -------------------------------------------------------------------
    // Idempotency
    // -------------------------------------------------------------------

    it('duplicate webhook delivery sends nothing twice', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);

      const payload = h.commentPayload({ igsid: FAN, commentId: 'comment_3', text: 'guide' });
      const first = await h.postWebhook(payload);
      const second = await h.postWebhook(payload);
      expect(JSON.parse(first.body)).toMatchObject({ stored: 1, duplicates: 0 });
      expect(JSON.parse(second.body)).toMatchObject({ stored: 0, duplicates: 1 });

      await h.drain();
      expect(h.mock.callsTo('comment_reply')).toHaveLength(1);
      expect(h.mock.privateReplies()).toHaveLength(1);

      // And the same for a replayed tap.
      const tapPayload = h.postbackPayload({
        igsid: FAN,
        payload: h.lastButtonPayload(),
        mid: 'mid_tap_dup',
      });
      await h.postWebhook(tapPayload);
      await h.postWebhook(tapPayload);
      await h.drain();

      expect(h.mock.callsTo('user_profile')).toHaveLength(1);
      expect(h.mock.directMessages()).toHaveLength(1);

      // One conversation row, one of each outbox row.
      expect(await h.repo.listConversations(10)).toHaveLength(1);
      const kinds = (await h.repo.listOutbox('all', 50)).map((o) => o.kind);
      expect(kinds.filter((k) => k === 'resource')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'private_reply_prompt')).toHaveLength(1);
    });

    it('a second comment from the same person does not start a second DM', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_a', text: 'guide' }));
      await h.drain();
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_b', text: 'guide again' }));
      await h.drain();

      expect(h.mock.privateReplies()).toHaveLength(1);
      expect(await h.repo.listConversations(10)).toHaveLength(1);
      // The second comment did get its public reply: that is a comment-level
      // courtesy, not a DM.
      expect(h.mock.callsTo('comment_reply')).toHaveLength(1);
    });

    it('a tap after delivery is ignored inside the cooldown, and re-sends once after it', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_1', text: 'guide' }));
      await h.drain();
      const button = h.lastButtonPayload();
      await h.postWebhook(h.postbackPayload({ igsid: FAN, payload: button, mid: 'm1' }));
      await h.drain();
      expect(h.mock.directMessages()).toHaveLength(1);

      // Inside the 10-minute cooldown: nothing.
      h.clock.advance(60_000);
      await h.postWebhook(h.postbackPayload({ igsid: FAN, payload: button, mid: 'm2' }));
      await h.drain();
      expect(h.mock.directMessages()).toHaveLength(1);

      // After it: exactly one more.
      h.clock.advance(11 * 60_000);
      await h.postWebhook(h.postbackPayload({ igsid: FAN, payload: button, mid: 'm3' }));
      await h.drain();
      expect(h.mock.directMessages()).toHaveLength(2);
      expect(h.mock.callsTo('user_profile')).toHaveLength(1);

      // The cooldown slides off the LAST delivery, so tapping again right away
      // gets nothing. Without this, a bored tester could farm messages.
      h.clock.advance(60_000);
      await h.postWebhook(h.postbackPayload({ igsid: FAN, payload: button, mid: 'm4' }));
      await h.drain();
      expect(h.mock.directMessages()).toHaveLength(2);

      // ...and one more cooldown later, one more copy. Never more than that.
      h.clock.advance(11 * 60_000);
      await h.postWebhook(h.postbackPayload({ igsid: FAN, payload: button, mid: 'm5' }));
      await h.drain();
      expect(h.mock.directMessages()).toHaveLength(3);
    });

    // -------------------------------------------------------------------
    // Things that must do nothing
    // -------------------------------------------------------------------

    it('a non-matching comment sends nothing', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      await h.postWebhook(
        h.commentPayload({ igsid: FAN, commentId: 'c_n', text: 'great reel bro 🔥' }),
      );
      await h.drain();

      expect(h.mock.calls).toHaveLength(0);
      expect(await h.repo.listConversations(10)).toHaveLength(0);
      expect(await h.repo.listOutbox('all', 10)).toHaveLength(0);
      const event = await h.repo.getEventByProviderId('comment:c_n');
      expect(event?.status).toBe('skipped');
      expect(event?.error).toContain('no_rule_matched');
    });

    it("the operator's own comment is ignored", async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'], matchType: 'any' });
      await h.postWebhook(
        h.commentPayload({
          igsid: h.cfg.IG_USER_ID,
          commentId: 'c_self',
          text: 'guide — pinned comment',
        }),
      );
      await h.drain();

      expect(h.mock.calls).toHaveLength(0);
      const event = await h.repo.getEventByProviderId('comment:c_self');
      expect(event?.status).toBe('skipped');
      expect(event?.error).toContain('operator_own_comment');
    });

    it('a disabled rule sends nothing', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'], enabled: false });
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_d', text: 'guide' }));
      await h.drain();
      expect(h.mock.calls).toHaveLength(0);
    });

    it('a postback we did not send (icebreaker, old button) is ignored', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      await h.postWebhook(
        h.postbackPayload({ igsid: FAN, payload: 'GET_STARTED', mid: 'mid_ice' }),
      );
      await h.drain();
      expect(h.mock.calls).toHaveLength(0);
      const event = await h.repo.getEventByProviderId('postback:mid_ice');
      expect(event?.status).toBe('skipped');
      expect(event?.error).toContain('unknown_postback');
    });

    it('a tampered signature is rejected and nothing is stored', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      const payload = h.commentPayload({ igsid: FAN, commentId: 'c_bad', text: 'guide' });
      const res = await h.postWebhook(payload, {
        signature: `sha256=${'0'.repeat(64)}`,
      });
      expect(res.statusCode).toBe(403);
      await h.drain();
      expect(h.mock.calls).toHaveLength(0);
      expect(await h.repo.getEventByProviderId('comment:c_bad')).toBeNull();

      const audit = await h.repo.listAudit(10);
      expect(audit.some((a) => a.action === 'webhook.rejected')).toBe(true);
    });

    it('a missing signature is rejected too', async () => {
      const res = await h.postWebhook({ object: 'instagram', entry: [] }, { signature: null });
      expect(res.statusCode).toBe(403);
    });

    // -------------------------------------------------------------------
    // Failure handling
    // -------------------------------------------------------------------

    it('a rate-limited send is retried with backoff and eventually goes through', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);
      // Fail the first two attempts at the private reply.
      h.mock.failNext({ ...MockErrors.rateLimit(), times: 2 });

      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_rl', text: 'guide' }));
      await h.drain();

      let rows = await h.repo.listOutbox('all', 20);
      let prompt = rows.find((r) => r.kind === 'private_reply_prompt');
      expect(prompt?.status).toBe('queued');
      expect(prompt?.attempts).toBe(1);
      expect(prompt?.lastError).toContain('rate_limit');
      // Backed off into the future, not retried immediately.
      expect(prompt!.nextAttemptAt.getTime()).toBeGreaterThan(h.clock.now().getTime());

      // Attempt 2: still limited.
      await h.advanceAndDrain(2_000);
      rows = await h.repo.listOutbox('all', 20);
      prompt = rows.find((r) => r.kind === 'private_reply_prompt');
      expect(prompt?.attempts).toBe(2);
      expect(prompt?.status).toBe('queued');

      // Attempt 3 succeeds.
      await h.advanceAndDrain(5_000);
      rows = await h.repo.listOutbox('all', 20);
      prompt = rows.find((r) => r.kind === 'private_reply_prompt');
      expect(prompt?.status).toBe('sent');
      expect(prompt?.attempts).toBe(3);
      expect(h.mock.privateReplies()).toHaveLength(3);

      // And the journey still completes.
      await h.tapLastButton(FAN, 'mid_rl');
      await h.drain();
      expect((await h.repo.findConversation(FAN, 'guide'))?.state).toBe('DELIVERED');
    });

    it('gives up after MAX_ATTEMPTS retries instead of retrying forever', async () => {
      await h.stop();
      await boot({ MAX_ATTEMPTS: 3 });
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.failNext({ ...MockErrors.serverError(), times: 10 });

      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_5xx', text: 'guide' }));
      for (let i = 0; i < 8; i++) await h.advanceAndDrain(120_000);

      const prompt = (await h.repo.listOutbox('all', 20)).find(
        (r) => r.kind === 'private_reply_prompt',
      );
      expect(prompt?.status).toBe('failed');
      expect(prompt?.attempts).toBe(3);
      expect(prompt?.lastError).toContain('gave up');
      expect((await h.repo.findConversation(FAN, 'guide'))?.state).toBe('FAILED');
      // Exactly MAX_ATTEMPTS calls: no runaway retrying.
      expect(h.mock.privateReplies()).toHaveLength(3);
    });

    it('a permission error is never retried', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.failNext({ ...MockErrors.noPermission(), times: 5 });

      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_perm', text: 'guide' }));
      await h.drain();
      await h.advanceAndDrain(600_000);

      const prompt = (await h.repo.listOutbox('all', 20)).find(
        (r) => r.kind === 'private_reply_prompt',
      );
      expect(prompt?.status).toBe('failed');
      expect(prompt?.attempts).toBe(1);
      expect(prompt?.lastError).toContain('permission');
      expect(h.mock.privateReplies()).toHaveLength(1);
      expect((await h.repo.findConversation(FAN, 'guide'))?.state).toBe('FAILED');
    });

    it('a consent-required error on the profile API re-prompts and does not crash', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_cons', text: 'guide' }));
      await h.drain();

      h.mock.failNext(MockErrors.consentRequired());
      await h.tapLastButton(FAN, 'mid_cons_1');
      await h.drain();

      const conv = await h.repo.findConversation(FAN, 'guide');
      expect(conv?.state).toBe('GATED');

      const check = (await h.repo.listOutbox('all', 20)).find((r) => r.kind === 'follow_check');
      expect(check?.status).toBe('failed');
      expect(check?.lastError).toContain('consent_required');
      expect(check?.attempts).toBe(1);

      // The person was asked for one more tap, and no resource leaked out.
      const dms = h.mock.directMessages();
      expect(dms).toHaveLength(1);
      expect(dms[0]?.text).toContain('Tap the button once more');
      expect(dms[0]?.buttonPayload).toMatch(/^RECHECK:guide:/);
      expect(dms[0]?.text).not.toContain('https://example.com/guide');

      // Their next tap grants consent and the flow finishes.
      await h.tapLastButton(FAN, 'mid_cons_2');
      await h.drain();
      expect((await h.repo.findConversation(FAN, 'guide'))?.state).toBe('DELIVERED');
      expect(h.mock.directMessages()[1]?.text).toContain('https://example.com/guide');
    });

    it('an expired 24h window is recorded and never retried (reported by Meta)', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_win', text: 'guide' }));
      await h.drain();

      // The resource DM is the next 'messages' call after the tap.
      h.mock.failNext({ ...MockErrors.windowExpired(), times: 5 });
      await h.tapLastButton(FAN, 'mid_win');
      await h.drain();
      const callsAfterFailure = h.mock.calls.length;

      const resource = (await h.repo.listOutbox('all', 20)).find((r) => r.kind === 'resource');
      expect(resource?.status).toBe('failed');
      expect(resource?.attempts).toBe(1);
      expect(resource?.lastError).toContain('window_expired');

      const conv = await h.repo.findConversation(FAN, 'guide');
      expect(conv?.state).toBe('FAILED');
      expect(conv?.lastReason).toContain('window expired');

      // Several more worker passes: no further calls at all.
      for (let i = 0; i < 5; i++) await h.advanceAndDrain(600_000);
      expect(h.mock.calls.length).toBe(callsAfterFailure);
    });

    it('an expired window is detected locally, before calling Meta', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_win2', text: 'guide' }));
      await h.drain();
      await h.tapLastButton(FAN, 'mid_win2');

      // The event is stored, but nothing drains for 30 hours.
      h.clock.advance(30 * 3_600_000);
      await h.drain();

      const resource = (await h.repo.listOutbox('all', 20)).find((r) => r.kind === 'resource');
      expect(resource?.status).toBe('failed');
      expect(resource?.lastError).toContain('messaging window expired');
      // The follow check still ran (it is not window-limited), but no DM was attempted.
      expect(h.mock.directMessages()).toHaveLength(0);
    });

    // -------------------------------------------------------------------
    // The direct-DM entry point
    // -------------------------------------------------------------------

    it('a keyword DM goes straight to the follow check and delivers', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);

      await h.postWebhook(
        h.messagePayload({ igsid: FAN, text: 'hey can you send the guide', mid: 'mid_dm_1' }),
      );
      await h.drain();

      expect(h.mock.callsTo('comment_reply')).toHaveLength(0);
      expect(h.mock.privateReplies()).toHaveLength(0);
      expect(h.mock.callsTo('user_profile')).toHaveLength(1);
      const dms = h.mock.directMessages();
      expect(dms).toHaveLength(1);
      expect(dms[0]?.text).toContain('https://example.com/guide');
      expect((await h.repo.findConversation(FAN, 'guide'))?.state).toBe('DELIVERED');
    });

    it('a keyword DM from a non-follower is gated', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(NON_FOLLOWER, false);
      await h.postWebhook(
        h.messagePayload({ igsid: NON_FOLLOWER, text: 'guide', mid: 'mid_dm_2' }),
      );
      await h.drain();
      expect(h.mock.directMessages()[0]?.text).toContain('One tap: follow');
      expect((await h.repo.findConversation(NON_FOLLOWER, 'guide'))?.state).toBe('GATED');
    });

    // -------------------------------------------------------------------
    // Rule options
    // -------------------------------------------------------------------

    it('require_follow=false delivers on the first tap with no profile call', async () => {
      await h.addRule({ id: 'open', keywords: ['guide'], requireFollow: false });
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_open', text: 'guide' }));
      await h.drain();
      await h.tapLastButton(FAN, 'mid_open');
      await h.drain();

      expect(h.mock.callsTo('user_profile')).toHaveLength(0);
      expect(h.mock.directMessages()).toHaveLength(1);
      expect((await h.repo.findConversation(FAN, 'open'))?.state).toBe('DELIVERED');
    });

    it('sends the optional follow-up after the resource, in order', async () => {
      await h.addRule({
        id: 'guide',
        keywords: ['guide'],
        resourcePayload: {
          text: 'Here it is',
          url: 'https://example.com/guide',
          followUp: 'Reply here if anything breaks.',
        },
      });
      h.mock.setFollows(FAN, true);
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_fu', text: 'guide' }));
      await h.drain();
      await h.tapLastButton(FAN, 'mid_fu');
      await h.drain();
      // The follow-up is scheduled a second later so the two arrive in order.
      await h.advanceAndDrain(2_000);

      const dms = h.mock.directMessages();
      expect(dms).toHaveLength(2);
      expect(dms[0]?.text).toContain('https://example.com/guide');
      expect(dms[1]?.text).toBe('Reply here if anything breaks.');
    });

    it('a post-scoped rule only answers comments on its own post', async () => {
      await h.addRule({
        id: 'postonly',
        scope: 'post',
        igMediaId: 'media_42',
        keywords: ['guide'],
      });
      await h.postWebhook(
        h.commentPayload({ igsid: FAN, commentId: 'c_other', text: 'guide', mediaId: 'media_1' }),
      );
      await h.drain();
      expect(h.mock.calls).toHaveLength(0);

      await h.postWebhook(
        h.commentPayload({ igsid: FAN, commentId: 'c_right', text: 'guide', mediaId: 'media_42' }),
      );
      await h.drain();
      expect(h.mock.callsTo('comment_reply')).toHaveLength(1);
    });

    // -------------------------------------------------------------------
    // Safety rails
    // -------------------------------------------------------------------

    it('the per-contact cooldown defers a second prompt rather than spamming', async () => {
      await h.stop();
      await boot({ CONTACT_COOLDOWN_MINUTES: 30 });
      await h.addRule({ id: 'a', keywords: ['guide'], priority: 10 });
      await h.addRule({ id: 'b', keywords: ['checklist'], priority: 0 });

      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_a', text: 'guide' }));
      await h.drain();
      expect(h.mock.privateReplies()).toHaveLength(1);

      // A different rule, same person, five minutes later: deferred.
      h.clock.advance(5 * 60_000);
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_b', text: 'checklist' }));
      await h.drain();
      expect(h.mock.privateReplies()).toHaveLength(1);
      const deferred = (await h.repo.listOutbox('queued', 20)).find(
        (r) => r.kind === 'private_reply_prompt',
      );
      expect(deferred?.lastError).toContain('cooldown');
      expect(deferred?.attempts).toBe(0); // a deferral is not a failed attempt

      // Once the cooldown is over it goes out.
      await h.advanceAndDrain(30 * 60_000);
      expect(h.mock.privateReplies()).toHaveLength(2);
    });

    it('the account hourly cap defers sends instead of dropping them', async () => {
      await h.stop();
      await boot({ MAX_MESSAGES_PER_HOUR: 1 });
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);

      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_cap', text: 'guide' }));
      await h.drain();
      expect(h.mock.privateReplies()).toHaveLength(1);

      await h.tapLastButton(FAN, 'mid_cap');
      await h.drain();
      // The resource is held back by the cap, not lost.
      const resource = (await h.repo.listOutbox('all', 20)).find((r) => r.kind === 'resource');
      expect(resource?.status).toBe('queued');
      expect(resource?.lastError).toContain('hourly cap');

      // An hour later the private reply has aged out of the window and it sends.
      await h.advanceAndDrain(61 * 60_000);
      expect(h.mock.directMessages()).toHaveLength(1);
      expect((await h.repo.findConversation(FAN, 'guide'))?.state).toBe('DELIVERED');
    });

    it('writes an audit trail with ids and no secrets', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(FAN, true);
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_audit', text: 'guide' }));
      await h.drain();
      await h.tapLastButton(FAN, 'mid_audit');
      await h.drain();

      const audit = await h.repo.listAudit(100);
      const actions = audit.map((a) => a.action);
      expect(actions).toContain('webhook.comment');
      expect(actions).toContain('comment.matched');
      expect(actions).toContain('meta.private_reply_prompt');
      expect(actions).toContain('meta.resource');
      const serialised = JSON.stringify(audit);
      expect(serialised).not.toContain(h.cfg.IG_ACCESS_TOKEN);
      expect(serialised).not.toContain(h.cfg.APP_SECRET);
      expect(serialised).not.toContain(h.cfg.ADMIN_TOKEN);
    });

    it('records every state transition with a reason', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      h.mock.setFollows(NON_FOLLOWER, false);
      await h.postWebhook(
        h.commentPayload({ igsid: NON_FOLLOWER, commentId: 'c_tr', text: 'guide' }),
      );
      await h.drain();
      await h.tapLastButton(NON_FOLLOWER, 'mid_tr');
      await h.drain();

      const conv = await h.repo.findConversation(NON_FOLLOWER, 'guide');
      const transitions = await h.repo.listTransitions(conv!.id);
      expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
        'NEW->PROMPTED',
        'PROMPTED->CHECKING',
        'CHECKING->GATED',
      ]);
      for (const t of transitions) expect(t.reason.length).toBeGreaterThan(0);
    });

    it('abandons a conversation nobody came back to', async () => {
      await h.addRule({ id: 'guide', keywords: ['guide'] });
      await h.postWebhook(h.commentPayload({ igsid: FAN, commentId: 'c_ab', text: 'guide' }));
      await h.drain();
      h.clock.advance((h.cfg.ABANDON_AFTER_HOURS + 1) * 3_600_000);
      expect(await h.app.engine.sweepIdle()).toBe(1);
      expect((await h.repo.findConversation(FAN, 'guide'))?.state).toBe('ABANDONED');
      // Sweeping again finds nothing, and sends nothing.
      expect(await h.app.engine.sweepIdle()).toBe(0);
    });

    it('reports health', async () => {
      const res = await h.server.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: 'ok', repository: h.repo.kind });
    });
  });
}
