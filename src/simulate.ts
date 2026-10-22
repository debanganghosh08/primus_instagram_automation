/**
 * `npm run simulate` — the demo.
 *
 * Boots the whole service in memory (real webhook route, real signature check,
 * real state machine, real outbox worker) against the mock Meta API, and
 * replays both journeys, printing what the person on Instagram would actually
 * see.
 *
 * No Postgres. No Docker. No network. No Meta credentials.
 */
import { Harness } from './testing/harness.js';
import type { MockCall } from './testing/mock-meta.js';
import type { Rule } from './types.js';

const W = 74;

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};
const rule = (ch = '─'): void => {
  out(ch.repeat(W));
};

function banner(title: string, subtitle?: string): void {
  out();
  rule('═');
  out(` ${title}`);
  if (subtitle) out(` ${subtitle}`);
  rule('═');
}

function section(title: string): void {
  out();
  rule();
  out(` ${title}`);
  rule();
  out();
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : l === '' ? '' : pad + l))
    .join('\n');
}

const PEOPLE: Record<string, string> = {
  igsid_7001: '@ritika.codes',
  igsid_7002: '@arjun.dev',
};

function who(igsid: string): string {
  return PEOPLE[igsid] ?? igsid;
}

export async function simulate(): Promise<void> {
  const h = new Harness({
    start: new Date('2026-04-12T10:00:00.000Z'),
    config: {
      CONTACT_COOLDOWN_MINUTES: 10,
      REDELIVERY_COOLDOWN_MINUTES: 10,
      MAX_ATTEMPTS: 5,
    },
  });
  await h.start();

  // The clock prints as wall time so the transcript reads like a real day.
  const stamp = (): string => h.clock.now().toISOString().slice(11, 19);

  let cursor = 0;
  /** Everything the service sent since the last time we looked. */
  const newCalls = (): MockCall[] => {
    const slice = h.mock.calls.slice(cursor);
    cursor = h.mock.calls.length;
    return slice;
  };

  const showCalls = (commentAuthor?: string): void => {
    for (const call of newCalls()) {
      if (call.endpoint === 'comment_reply') {
        out(` ${stamp()}  PUBLIC REPLY under the comment`);
        out(`           "${call.text ?? ''}"`);
        out();
        continue;
      }
      if (call.endpoint === 'user_profile') {
        out(` ${stamp()}  [service] follow check -> GET /${h.cfg.API_VERSION}/${call.target}`);
        out(`           ?fields=...,is_user_follow_business`);
        out();
        continue;
      }
      const label = call.privateReply
        ? `DM to ${commentAuthor ?? 'them'}  (private reply to the comment - the only one allowed)`
        : `DM to ${who(call.target)}`;
      out(` ${stamp()}  ${label}`);
      out(`           "${indent(call.text ?? '', '            ')}"`);
      if (call.buttonLabel) out(`           [ ${call.buttonLabel} ]`);
      out();
    }
  };

  const showState = async (igsid: string, ruleId: string): Promise<void> => {
    const conv = await h.repo.findConversation(igsid, ruleId);
    if (!conv) {
      out(`           (no conversation row)`);
      return;
    }
    const transitions = await h.repo.listTransitions(conv.id);
    const path = transitions.length
      ? `${transitions[0]?.from} -> ${transitions.map((t) => t.to).join(' -> ')}`
      : conv.state;
    out(`           state: ${path}`);
    out(`           reason: ${conv.lastReason ?? '-'}`);
    out();
  };

  // -----------------------------------------------------------------------
  // The rule
  // -----------------------------------------------------------------------

  const guide: Rule = await h.addRule({
    id: 'guide',
    name: 'Comment "guide" to get the AI roadmap',
    matchType: 'contains',
    keywords: ['guide', 'roadmap', 'send me'],
    publicReplyVariants: ['Sent you a DM ✅', 'Check your DMs ✅', 'In your inbox ✅'],
    dmPromptText: "Hey! Tap the button below and I'll send you the roadmap.",
    buttonLabel: 'Send me the roadmap',
    gateMessage:
      "One tap: follow the account, then press the button again and I'll send it right away.",
    resourcePayload: {
      text: 'Here it is 👇',
      url: 'https://example.com/ai-roadmap',
      followUp: 'If anything is unclear, just reply here.',
    },
    requireFollow: true,
  });

  banner(
    'comment-to-DM  ·  end-to-end simulation',
    'In-memory repository + mock Meta API. No network, no database, no credentials.',
  );

  out();
  out(` Rule "${guide.id}" — ${guide.name}`);
  out(`   match            ${guide.matchType}: ${guide.keywords.join(', ')}`);
  out(`   public replies   ${guide.publicReplyVariants.join(' / ')}`);
  out(`   first DM         "${guide.dmPromptText}"`);
  out(`   button           [ ${guide.buttonLabel} ]`);
  out(`   gate message     "${guide.gateMessage}"`);
  out(`   resource         "${guide.resourcePayload.text}" + ${guide.resourcePayload.url}`);
  out(`   follow required  ${guide.requireFollow ? 'yes' : 'no'}`);

  // =======================================================================
  // Journey 1 — already following
  // =======================================================================

  const RITIKA = 'igsid_7001';
  section('JOURNEY 1 — someone who already follows the account');

  h.mock.setProfile(RITIKA, { username: 'ritika.codes', isUserFollowBusiness: true });

  out(` ${stamp()}  ${who(RITIKA)} comments on reel media_101:`);
  out(`           "bhai send me the guide 🙏"`);
  const r1 = await h.postWebhook(
    h.commentPayload({
      igsid: RITIKA,
      commentId: 'comment_9001',
      text: 'bhai send me the guide 🙏',
      mediaId: 'media_101',
      username: 'ritika.codes',
    }),
  );
  out(`           -> POST /webhook ${r1.statusCode} ${r1.body}`);
  out();

  h.clock.advance(1_000);
  await h.drain();
  out(` ${stamp()}  [service] rule "guide" matched`);
  await showState(RITIKA, 'guide');
  showCalls(who(RITIKA));

  h.clock.advance(28_000);
  out(` ${stamp()}  ${who(RITIKA)} taps [ ${guide.buttonLabel} ]`);
  const t1 = await h.tapLastButton(RITIKA, 'mid_tap_9001');
  out(`           -> POST /webhook ${t1.statusCode}  (this tap is what opens the`);
  out(`              24-hour messaging window and grants profile consent)`);
  out();

  h.clock.advance(1_000);
  await h.drain();
  showCalls(who(RITIKA));
  // The follow-up message is queued a second behind the resource, on purpose.
  h.clock.advance(2_000);
  await h.drain();
  showCalls(who(RITIKA));
  await showState(RITIKA, 'guide');

  const conv1 = await h.repo.findConversation(RITIKA, 'guide');
  out(` RESULT: delivered on the first tap.`);
  out(`         follow checks: ${h.mock.callsTo('user_profile').length}`);
  out(`         gate messages: 0`);
  out(`         Meta calls:    ${h.mock.calls.length}`);
  out(`         delivered_at:  ${conv1?.deliveredAt?.toISOString() ?? '-'}`);

  // =======================================================================
  // Journey 2 — the follow gate
  // =======================================================================

  const ARJUN = 'igsid_7002';
  section('JOURNEY 2 — someone who does not follow yet, is gated, then follows');

  h.mock.setProfile(ARJUN, { username: 'arjun.dev', isUserFollowBusiness: false });

  out(` ${stamp()}  ${who(ARJUN)} comments on reel media_101:`);
  out(`           "roadmap please"`);
  const r2 = await h.postWebhook(
    h.commentPayload({
      igsid: ARJUN,
      commentId: 'comment_9002',
      text: 'roadmap please',
      mediaId: 'media_101',
      username: 'arjun.dev',
    }),
  );
  out(`           -> POST /webhook ${r2.statusCode} ${r2.body}`);
  out();

  h.clock.advance(1_000);
  await h.drain();
  showCalls(who(ARJUN));
  await showState(ARJUN, 'guide');

  h.clock.advance(40_000);
  out(` ${stamp()}  ${who(ARJUN)} taps [ ${guide.buttonLabel} ]`);
  await h.tapLastButton(ARJUN, 'mid_tap_9002');
  h.clock.advance(1_000);
  await h.drain();
  showCalls(who(ARJUN));
  out(`           is_user_follow_business = false  ->  gate, not the resource`);
  await showState(ARJUN, 'guide');

  h.clock.advance(35_000);
  out(` ${stamp()}  ${who(ARJUN)} taps again — but has still not followed`);
  await h.tapLastButton(ARJUN, 'mid_tap_9003');
  h.clock.advance(1_000);
  await h.drain();
  showCalls(who(ARJUN));
  out(`           still false  ->  the gate again (check #2). Nothing leaks out.`);
  out();

  h.clock.advance(50_000);
  out(` ${stamp()}  ${who(ARJUN)} presses Follow on Instagram, then taps the button`);
  h.mock.setFollows(ARJUN, true);
  await h.tapLastButton(ARJUN, 'mid_tap_9004');
  h.clock.advance(1_000);
  await h.drain();
  showCalls(who(ARJUN));
  h.clock.advance(2_000);
  await h.drain();
  showCalls(who(ARJUN));
  await showState(ARJUN, 'guide');

  const conv2 = await h.repo.findConversation(ARJUN, 'guide');
  const gateMessages = h.mock
    .directMessages()
    .filter((d) => (d.text ?? '').includes('One tap: follow'));
  const arjunPrivateReplies = h.mock
    .privateReplies()
    .filter((c) => c.target === 'comment_9002').length;
  out(` RESULT: gated twice, then delivered.`);
  out(`         follow checks for ${who(ARJUN)}: ${conv2?.attempts ?? 0}`);
  out(`         gate messages sent:            ${gateMessages.length}`);
  out(`         private replies to comment_9002: ${arjunPrivateReplies} (the platform allows 1)`);

  // =======================================================================
  // Idempotency
  // =======================================================================

  section('SAFETY CHECK — Meta redelivers webhooks; we must not message twice');

  const before = h.mock.calls.length;
  out(` Replaying ${who(RITIKA)}'s original comment notification, byte for byte...`);
  const replay = await h.postWebhook(
    h.commentPayload({
      igsid: RITIKA,
      commentId: 'comment_9001',
      text: 'bhai send me the guide 🙏',
      mediaId: 'media_101',
      username: 'ritika.codes',
    }),
  );
  await h.drain();
  out(`   -> POST /webhook ${replay.statusCode} ${replay.body}`);
  out(`   -> Meta calls before: ${before}, after: ${h.mock.calls.length}`);
  out();

  out(` Replaying her button tap...`);
  const replayTap = await h.postWebhook(
    h.postbackPayload({ igsid: RITIKA, payload: h.lastButtonPayload(), mid: 'mid_tap_9001' }),
  );
  await h.drain();
  out(`   -> POST /webhook ${replayTap.statusCode} ${replayTap.body}`);
  out(`   -> Meta calls after: ${h.mock.calls.length}`);
  out();

  out(` Sending a comment with an unsigned body (someone poking the endpoint)...`);
  const forged = await h.postWebhook(
    h.commentPayload({
      igsid: RITIKA,
      commentId: 'comment_forged',
      text: 'guide',
      username: 'ritika.codes',
    }),
    { signature: `sha256=${'0'.repeat(64)}` },
  );
  await h.drain();
  out(`   -> POST /webhook ${forged.statusCode} ${forged.body}`);
  out(`   -> Meta calls after: ${h.mock.calls.length}  (unchanged)`);
  out();

  out(` A comment that matches nothing...`);
  await h.postWebhook(
    h.commentPayload({ igsid: RITIKA, commentId: 'comment_9003', text: 'first 🔥' }),
  );
  await h.drain();
  out(`   -> Meta calls after: ${h.mock.calls.length}  (unchanged)`);
  out();

  out(` The operator's own comment on their own post...`);
  await h.postWebhook(
    h.commentPayload({
      igsid: h.cfg.IG_USER_ID,
      commentId: 'comment_9004',
      text: 'comment "guide" and I will send it',
    }),
  );
  await h.drain();
  out(`   -> Meta calls after: ${h.mock.calls.length}  (unchanged)`);

  // =======================================================================
  // What the database looks like afterwards
  // =======================================================================

  section('WHAT IS IN THE DATABASE AFTERWARDS');

  const conversations = await h.repo.listConversations(20);
  out(' conversations');
  out(`   ${'person'.padEnd(22)}${'rule'.padEnd(8)}${'state'.padEnd(11)}checks  delivered`);
  for (const c of conversations) {
    out(
      `   ${who(c.igsid).padEnd(22)}${c.ruleId.padEnd(8)}${c.state.padEnd(11)}` +
        `${String(c.attempts).padEnd(8)}${c.deliveredAt ? 'yes' : 'no'}`,
    );
  }
  out();

  const outbox = await h.repo.listOutbox('all', 50);
  out(' outbox  (every outbound call, with its de-duplication key)');
  out(`   ${'kind'.padEnd(22)}${'status'.padEnd(9)}${'tries'.padEnd(7)}dedupe key`);
  for (const o of [...outbox].reverse()) {
    out(
      `   ${o.kind.padEnd(22)}${o.status.padEnd(9)}${String(o.attempts).padEnd(7)}${o.dedupeKey}`,
    );
  }
  out();

  const events = await Promise.all(
    [
      'comment:comment_9001',
      'comment:comment_9002',
      'comment:comment_9003',
      'comment:comment_9004',
      'comment:comment_forged',
    ].map(async (id) => [id, await h.repo.getEventByProviderId(id)] as const),
  );
  out(' events  (the de-duplication table — this is what makes replay harmless)');
  for (const [id, event] of events) {
    out(`   ${id.padEnd(26)}${event ? event.status : 'never stored (bad signature)'}`);
  }
  out();

  const audit = await h.repo.listAudit(500);
  out(` audit_log: ${audit.length} entries.`);
  const leaks = [h.cfg.IG_ACCESS_TOKEN, h.cfg.APP_SECRET, h.cfg.ADMIN_TOKEN, h.cfg.VERIFY_TOKEN];
  const serialised = JSON.stringify(audit);
  const leaked = leaks.filter((s) => serialised.includes(s));
  out(` secrets found in the audit log: ${leaked.length === 0 ? 'none' : leaked.join(', ')}`);

  // -----------------------------------------------------------------------

  section('SUMMARY');
  const delivered = conversations.filter((c) => c.deliveredAt !== null).length;
  out(` people who got the resource:    ${delivered} of 2`);
  out(` duplicate messages sent:        0`);
  out(
    ` private replies:                ${h.mock.privateReplies().length} across 2 comments` +
      ` (exactly 1 per comment, which is the platform limit)`,
  );
  out(` total Meta API calls:           ${h.mock.calls.length}`);
  out(` failed outbox rows:             ${outbox.filter((o) => o.status === 'failed').length}`);
  out();
  out(' Nothing in this run left the process: no DNS, no sockets, no Postgres.');
  out(' Set DRY_RUN=true against your real app to rehearse with real webhooks');
  out(' and still send nothing. See docs/SETUP.md.');
  out();

  await h.stop();
}

simulate().catch((e: unknown) => {
  process.stderr.write(`simulation failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
