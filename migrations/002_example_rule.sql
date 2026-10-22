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
    'Sent you a DM ✅',
    'Check your DMs ✅',
    'In your inbox ✅'
  ],
  'Hey! Tap the button below and I''ll send you the guide.',
  'Send me the resource',
  'One tap: follow the account, then press the button again and I''ll send it right away.',
  '{"text": "Here it is 👇", "url": "https://example.com/replace-me", "followUp": "If anything is unclear, just reply here."}'::jsonb,
  true,
  0
)
on conflict (id) do nothing;
