-- 002_example_rule.sql
-- One example rule so the dashboard is not empty on first boot.
-- It is DISABLED. Edit the texts at /admin, point resource_payload at your real
-- link, then flip it on. Nothing is sent while enabled = false.

insert into rules (
  id, name, enabled, scope, ig_media_id, match_type, keywords, case_insensitive,
  public_reply_variants, dm_prompt_text, button_label, gate_message,
  resource_payload, require_follow, priority
) values (
  'example',
  'Example: comment "GUIDE" to get the guide',
  false,
  'global',
  null,
  'contains',
  array['guide', 'send', 'link'],
  true,
  array[
    'DM Sent! 📩',
    'DM check kro! 🎉',
    'Thanks for comment, Check your DM! 📩'
  ],
  'Hey! Tap the button below and I''ll send you the resource.',
  'Send Resource!',
  'Please follow. It just takes a click and I will share the resource with you.',
  '{"text": "Here is your Resource", "url": "https://example.com/replace-me", "buttonLabel": "Resource"}'::jsonb,
  true,
  0
)
on conflict (id) do nothing;
