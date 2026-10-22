/**
 * Server-rendered HTML for /admin. No build step, no framework, no CDN.
 * Everything interpolated goes through `esc()`.
 */
import type {
  AuditEntry,
  Conversation,
  OutboxItem,
  Rule,
} from '../types.js';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#17171a; --muted:#6b6b76;
  --line:#e3e3e8; --card:#fafafb; --accent:#2d6cdf; --ok:#1a7f45; --bad:#b4232c; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg:#141417; --fg:#ececf0; --muted:#9a9aa6;
  --line:#2b2b31; --card:#1c1c21; --accent:#6f9dfb; --ok:#5fcf8e; --bad:#ff8a8a; --warn:#e0b45c; } }
* { box-sizing:border-box; }
body { margin:0; padding:24px 16px 64px; background:var(--bg); color:var(--fg);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width:1060px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; }
h2 { font-size:16px; margin:32px 0 10px; letter-spacing:.01em; }
p.sub { color:var(--muted); margin:0 0 20px; }
table { width:100%; border-collapse:collapse; font-size:13.5px; }
th,td { text-align:left; padding:7px 9px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
code,.mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
.pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11.5px; font-weight:600;
  border:1px solid var(--line); }
.ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); } .muted { color:var(--muted); }
label { display:block; font-size:12.5px; color:var(--muted); margin:10px 0 3px; }
input,textarea,select,button { font:inherit; color:inherit; background:var(--bg);
  border:1px solid var(--line); border-radius:7px; padding:7px 9px; width:100%; }
textarea { min-height:62px; resize:vertical; }
button { background:var(--accent); color:#fff; border:none; font-weight:600; cursor:pointer; width:auto; padding:8px 16px; }
button.sm { padding:3px 10px; font-size:12px; font-weight:500; }
button.ghost { background:transparent; color:var(--accent); border:1px solid var(--line); }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:0 16px; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.banner { padding:10px 14px; border-radius:8px; margin-bottom:16px; border:1px solid var(--line); }
.banner.ok { background:rgba(26,127,69,.1); } .banner.bad { background:rgba(180,35,44,.1); }
.dryrun { background:rgba(138,90,0,.14); border-color:var(--warn); }
@media (max-width:720px) { .grid { grid-template-columns:1fr; } body { padding:16px 10px 48px; } }
`;

export interface LayoutOptions {
  title: string;
  dryRun: boolean;
  banner?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

export function layout(opts: LayoutOptions, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(opts.title)}</title>
<style>${STYLE}</style>
</head><body><div class="wrap">
${opts.dryRun ? '<div class="banner dryrun"><strong>DRY_RUN is on.</strong> Nothing is sent to Instagram. Outbound calls are logged and marked sent.</div>' : ''}
${opts.banner ? `<div class="banner ${opts.banner.kind}">${esc(opts.banner.text)}</div>` : ''}
${body}
</div></body></html>`;
}

export function loginPage(error?: string): string {
  return layout(
    { title: 'comment-to-DM · sign in', dryRun: false, banner: error ? { kind: 'bad', text: error } : undefined },
    `<h1>comment-to-DM</h1>
     <p class="sub">Paste your ADMIN_TOKEN to open the dashboard.</p>
     <form class="card" method="post" action="/admin/login" style="max-width:420px">
       <label for="t">Admin token</label>
       <input id="t" name="token" type="password" autocomplete="off" autofocus>
       <div style="margin-top:14px"><button type="submit">Sign in</button></div>
     </form>`,
  );
}

function stateClass(state: string): string {
  if (state === 'DELIVERED') return 'ok';
  if (state === 'FAILED') return 'bad';
  if (state === 'ABANDONED' || state === 'GATED') return 'warn';
  return 'muted';
}

function statusClass(status: string): string {
  if (status === 'sent') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'queued' || status === 'sending') return 'warn';
  return 'muted';
}

function when(d: Date | null): string {
  if (!d) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export interface DashboardData {
  dryRun: boolean;
  repositoryKind: string;
  apiVersion: string;
  rateTokens: number;
  health: { ok: boolean; detail: string };
  rules: Rule[];
  conversations: Conversation[];
  outbox: OutboxItem[];
  audit: AuditEntry[];
  banner?: { kind: 'ok' | 'bad'; text: string } | undefined;
  /** Result of the dry-run tester, if it was just used. */
  testResult?: string | undefined;
}

export function dashboard(d: DashboardData): string {
  const rulesRows = d.rules
    .map(
      (r) => `<tr>
  <td><code>${esc(r.id)}</code><br><span class="muted">${esc(r.name)}</span></td>
  <td><span class="pill ${r.enabled ? 'ok' : 'muted'}">${r.enabled ? 'on' : 'off'}</span></td>
  <td>${esc(r.scope)}${r.igMediaId ? `<br><span class="muted mono">${esc(r.igMediaId)}</span>` : ''}</td>
  <td>${esc(r.matchType)}<br><span class="muted">${esc(r.keywords.join(', ') || '—')}</span></td>
  <td>${r.requireFollow ? 'yes' : 'no'}</td>
  <td>${esc(r.priority)}</td>
  <td>
    <form method="post" action="/admin/rules/${encodeURIComponent(r.id)}/toggle">
      <button class="sm ghost" type="submit">${r.enabled ? 'Disable' : 'Enable'}</button>
    </form>
  </td>
</tr>
<tr><td colspan="7" style="border-bottom:2px solid var(--line)">
  <details><summary class="muted">edit texts</summary>
  <form method="post" action="/admin/rules/${encodeURIComponent(r.id)}">
    <div class="grid">
      <div><label>Name</label><input name="name" value="${esc(r.name)}"></div>
      <div><label>Keywords (comma separated)</label><input name="keywords" value="${esc(r.keywords.join(', '))}"></div>
      <div><label>Match type</label>
        <select name="matchType">${['exact', 'contains', 'regex', 'any']
          .map((m) => `<option value="${m}"${m === r.matchType ? ' selected' : ''}>${m}</option>`)
          .join('')}</select></div>
      <div><label>Priority</label><input name="priority" value="${esc(r.priority)}"></div>
      <div><label>Public reply variants (one per line)</label><textarea name="publicReplyVariants">${esc(r.publicReplyVariants.join('\n'))}</textarea></div>
      <div><label>First DM (carries the button)</label><textarea name="dmPromptText">${esc(r.dmPromptText)}</textarea></div>
      <div><label>Button label</label><input name="buttonLabel" value="${esc(r.buttonLabel)}"></div>
      <div><label>Gate message</label><textarea name="gateMessage">${esc(r.gateMessage)}</textarea></div>
      <div><label>Resource text</label><textarea name="resourceText">${esc(r.resourcePayload.text)}</textarea></div>
      <div><label>Resource URL</label><input name="resourceUrl" value="${esc(r.resourcePayload.url ?? '')}"></div>
      <div><label>Follow-up message (optional)</label><textarea name="resourceFollowUp">${esc(r.resourcePayload.followUp ?? '')}</textarea></div>
      <div><label>Require follow</label>
        <select name="requireFollow">
          <option value="true"${r.requireFollow ? ' selected' : ''}>yes</option>
          <option value="false"${r.requireFollow ? '' : ' selected'}>no</option>
        </select></div>
    </div>
    <div style="margin-top:12px"><button type="submit">Save rule</button></div>
  </form></details>
</td></tr>`,
    )
    .join('');

  const convRows = d.conversations
    .map(
      (c) => `<tr>
  <td class="mono">${esc(c.igsid)}</td>
  <td><code>${esc(c.ruleId)}</code></td>
  <td><span class="pill ${stateClass(c.state)}">${esc(c.state)}</span></td>
  <td>${esc(c.attempts)}</td>
  <td>${esc(when(c.deliveredAt))}</td>
  <td>${esc(when(c.lastActionAt))}</td>
  <td class="muted">${esc(c.lastReason ?? '')}</td>
</tr>`,
    )
    .join('');

  const outboxRows = d.outbox
    .map(
      (o) => `<tr>
  <td>${esc(o.kind)}</td>
  <td><span class="pill ${statusClass(o.status)}">${esc(o.status)}</span></td>
  <td class="mono">${esc(o.igsid ?? '—')}</td>
  <td>${esc(o.attempts)}</td>
  <td>${esc(when(o.sentAt ?? o.nextAttemptAt))}</td>
  <td class="muted">${esc(o.lastError ?? '')}</td>
  <td>${
    o.status === 'failed'
      ? `<form method="post" action="/admin/outbox/${encodeURIComponent(o.id)}/retry"><button class="sm ghost" type="submit">Retry</button></form>`
      : ''
  }</td>
</tr>`,
    )
    .join('');

  const auditRows = d.audit
    .map(
      (a) => `<tr>
  <td class="muted">${esc(when(a.at))}</td>
  <td>${esc(a.direction)}</td>
  <td><code>${esc(a.action)}</code></td>
  <td>${esc(a.status)}</td>
  <td class="muted">${esc(a.detail ?? '')}</td>
</tr>`,
    )
    .join('');

  const body = `
<h1>comment-to-DM</h1>
<p class="sub">
  repository <strong>${esc(d.repositoryKind)}</strong> ·
  API <strong>${esc(d.apiVersion)}</strong> ·
  DB <span class="${d.health.ok ? 'ok' : 'bad'}">${d.health.ok ? 'ok' : esc(d.health.detail)}</span> ·
  rate-limit tokens left <strong>${Math.floor(d.rateTokens)}</strong>
</p>

<h2>Dry-run tester</h2>
<form class="card" method="post" action="/admin/test">
  <p class="sub" style="margin:0 0 8px">
    Runs a fake comment through the rule engine only. It writes nothing and calls nothing.
  </p>
  <div class="grid">
    <div><label>Comment text</label><input name="text" placeholder="send me the guide" required></div>
    <div><label>Media id (optional, for post-scoped rules)</label><input name="mediaId"></div>
  </div>
  <div style="margin-top:12px"><button type="submit">Test</button></div>
  ${d.testResult ? `<pre class="mono" style="margin-top:14px;white-space:pre-wrap">${esc(d.testResult)}</pre>` : ''}
</form>

<h2>Rules</h2>
<div class="card" style="padding:0;overflow:auto">
  <table><thead><tr><th>Rule</th><th>State</th><th>Scope</th><th>Match</th><th>Gate</th><th>Prio</th><th></th></tr></thead>
  <tbody>${rulesRows || '<tr><td colspan="7" class="muted" style="padding:16px">No rules yet.</td></tr>'}</tbody></table>
</div>

<details class="card"><summary><strong>Add a rule</strong></summary>
<form method="post" action="/admin/rules">
  <div class="grid">
    <div><label>Id (letters, numbers, - and _ only)</label><input name="id" required placeholder="guide"></div>
    <div><label>Name</label><input name="name" required placeholder="Comment GUIDE to get the guide"></div>
    <div><label>Scope</label><select name="scope"><option value="global">global</option><option value="post">post</option></select></div>
    <div><label>Media id (post scope only)</label><input name="igMediaId"></div>
    <div><label>Match type</label><select name="matchType"><option>contains</option><option>exact</option><option>regex</option><option>any</option></select></div>
    <div><label>Keywords (comma separated)</label><input name="keywords" placeholder="guide, send, link"></div>
    <div><label>Public reply variants (one per line)</label><textarea name="publicReplyVariants">Sent you a DM ✅
Check your DMs ✅</textarea></div>
    <div><label>First DM (carries the button)</label><textarea name="dmPromptText">Tap the button and I'll send it over.</textarea></div>
    <div><label>Button label</label><input name="buttonLabel" value="Send me the resource"></div>
    <div><label>Gate message</label><textarea name="gateMessage">One tap: follow the account, then press the button again.</textarea></div>
    <div><label>Resource text</label><textarea name="resourceText">Here it is 👇</textarea></div>
    <div><label>Resource URL</label><input name="resourceUrl" placeholder="https://..."></div>
    <div><label>Follow-up (optional)</label><textarea name="resourceFollowUp"></textarea></div>
    <div><label>Require follow</label><select name="requireFollow"><option value="true">yes</option><option value="false">no</option></select></div>
    <div><label>Priority</label><input name="priority" value="0"></div>
  </div>
  <div style="margin-top:12px"><button type="submit">Create rule</button></div>
</form></details>

<h2>Recent conversations</h2>
<div class="card" style="padding:0;overflow:auto">
  <table><thead><tr><th>Person</th><th>Rule</th><th>State</th><th>Checks</th><th>Delivered</th><th>Last action</th><th>Reason</th></tr></thead>
  <tbody>${convRows || '<tr><td colspan="7" class="muted" style="padding:16px">Nothing yet.</td></tr>'}</tbody></table>
</div>

<h2>Outbox</h2>
<div class="card" style="padding:0;overflow:auto">
  <table><thead><tr><th>Kind</th><th>Status</th><th>Person</th><th>Attempts</th><th>Sent / next try</th><th>Last error</th><th></th></tr></thead>
  <tbody>${outboxRows || '<tr><td colspan="7" class="muted" style="padding:16px">Nothing yet.</td></tr>'}</tbody></table>
</div>

<h2>Audit log</h2>
<div class="card" style="padding:0;overflow:auto">
  <table><thead><tr><th>At</th><th>Dir</th><th>Action</th><th>Status</th><th>Detail</th></tr></thead>
  <tbody>${auditRows || '<tr><td colspan="5" class="muted" style="padding:16px">Nothing yet.</td></tr>'}</tbody></table>
</div>

<form method="post" action="/admin/logout" style="margin-top:28px"><button class="ghost" type="submit">Sign out</button></form>
`;

  return layout(
    { title: 'comment-to-DM · dashboard', dryRun: d.dryRun, banner: d.banner },
    body,
  );
}
