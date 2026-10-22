import { describe, expect, it } from 'vitest';
import { parseWebhook } from '../src/webhook/parse.js';

describe('webhook parsing', () => {
  it('reads the Instagram-Login comment shape (field/value on the entry)', () => {
    const { events } = parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig_account',
          time: 1_772_000_000,
          field: 'comments',
          value: {
            id: 'comment_1',
            from: { id: 'igsid_1', username: 'someone' },
            text: 'send me the guide',
            media: { id: 'media_1', media_product_type: 'REELS' },
          },
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerEventId: 'comment:comment_1',
      type: 'comment',
      igsid: 'igsid_1',
      username: 'someone',
      commentId: 'comment_1',
      mediaId: 'media_1',
      text: 'send me the guide',
    });
    expect(events[0]?.occurredAt.toISOString()).toBe(new Date(1_772_000_000_000).toISOString());
  });

  it('reads the Facebook-Login comment shape (changes[] with comment_id)', () => {
    const { events } = parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig_account',
          time: 1_772_000_000,
          changes: [
            {
              field: 'comments',
              value: {
                comment_id: 'comment_2',
                parent_id: 'comment_1',
                from: { id: 'igsid_2' },
                text: 'guide',
                media: { id: 'media_9' },
              },
            },
          ],
        },
      ],
    });
    expect(events[0]).toMatchObject({
      providerEventId: 'comment:comment_2',
      commentId: 'comment_2',
      igsid: 'igsid_2',
      mediaId: 'media_9',
    });
  });

  it('reads a postback', () => {
    const { events } = parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig_account',
          time: 1_772_000_000,
          messaging: [
            {
              sender: { id: 'igsid_1' },
              recipient: { id: 'ig_account' },
              timestamp: 1_772_000_123_456,
              postback: { mid: 'mid_1', title: 'Send it', payload: 'DELIVER:guide:n1' },
            },
          ],
        },
      ],
    });
    expect(events[0]).toMatchObject({
      providerEventId: 'postback:mid_1',
      type: 'postback',
      igsid: 'igsid_1',
      postbackPayload: 'DELIVER:guide:n1',
      text: 'Send it',
    });
  });

  it('reads a direct message', () => {
    const { events } = parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig_account',
          messaging: [
            {
              sender: { id: 'igsid_1' },
              recipient: { id: 'ig_account' },
              message: { mid: 'mid_2', text: 'guide please' },
            },
          ],
        },
      ],
    });
    expect(events[0]).toMatchObject({
      providerEventId: 'message:mid_2',
      type: 'message',
      text: 'guide please',
    });
  });

  it('drops our own echoed messages (acting on them would loop)', () => {
    const { events } = parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig_account',
          messaging: [
            {
              sender: { id: 'ig_account' },
              message: { mid: 'mid_3', text: 'Here it is', is_echo: true },
            },
            {
              sender: { id: 'ig_account' },
              message: { mid: 'mid_4', text: 'Here it is', is_self: true },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(0);
  });

  it('ignores deleted and unsupported messages, with a warning', () => {
    const { events, warnings } = parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig_account',
          messaging: [{ sender: { id: 'x' }, message: { mid: 'mid_5', is_deleted: true } }],
        },
      ],
    });
    expect(events).toHaveLength(0);
    expect(warnings.join(' ')).toContain('deleted');
  });

  it('ignores notifications for other objects', () => {
    const { events, warnings } = parseWebhook({ object: 'page', entry: [] });
    expect(events).toHaveLength(0);
    expect(warnings.join(' ')).toContain('page');
  });

  it('ignores fields we did not subscribe to', () => {
    const { events, warnings } = parseWebhook({
      object: 'instagram',
      entry: [{ id: 'a', field: 'story_insights', value: { x: 1 } }],
    });
    expect(events).toHaveLength(0);
    expect(warnings.join(' ')).toContain('story_insights');
  });

  it('never throws on junk', () => {
    for (const junk of [null, 42, 'hello', {}, { entry: 'nope' }, { entry: [{}] }]) {
      expect(() => parseWebhook(junk)).not.toThrow();
    }
    expect(parseWebhook(null).events).toHaveLength(0);
    expect(parseWebhook({ entry: [{}] }).events).toHaveLength(0);
  });

  it('skips a comment with no author id rather than guessing', () => {
    const { events, warnings } = parseWebhook({
      object: 'instagram',
      entry: [{ id: 'a', field: 'comments', value: { id: 'c1', text: 'guide' } }],
    });
    expect(events).toHaveLength(0);
    expect(warnings.join(' ')).toContain('no author id');
  });

  it('skips a postback with no mid, because it could not be de-duplicated', () => {
    const { events, warnings } = parseWebhook({
      object: 'instagram',
      entry: [
        { id: 'a', messaging: [{ sender: { id: 'x' }, postback: { payload: 'DELIVER:g:n' } }] },
      ],
    });
    expect(events).toHaveLength(0);
    expect(warnings.join(' ')).toContain('de-duplicate');
  });

  it('handles several events in one notification', () => {
    const { events } = parseWebhook({
      object: 'instagram',
      entry: [
        { id: 'a', field: 'comments', value: { id: 'c1', from: { id: 'u1' }, text: 'guide' } },
        { id: 'a', field: 'comments', value: { id: 'c2', from: { id: 'u2' }, text: 'guide' } },
      ],
    });
    expect(events.map((e) => e.providerEventId)).toEqual(['comment:c1', 'comment:c2']);
  });
});
