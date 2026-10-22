/**
 * The HTTP surface. Three things:
 *
 *   GET  /webhook   Meta's verification handshake.
 *   POST /webhook   event notifications. Verify the signature, write the rows,
 *                   return 200. Nothing else — Meta must not wait on our work.
 *   GET  /healthz   liveness + a real DB check (Render's health check).
 *   /admin          one server-rendered page: rules, conversations, outbox,
 *                   audit, a retry button and a dry-run tester.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { parseWebhook } from './webhook/parse.js';
import { secretEquals, verifySignature } from './webhook/signature.js';
import { selectRule, pickPublicReply } from './domain/rules.js';
import { renderGate, renderPrompt, renderResource } from './core/render.js';
import type { Repository } from './repo/repository.js';
import type { TokenBucket } from './meta/ratelimit.js';
import type { NewRule } from './types.js';
import { dashboard, loginPage } from './admin/views.js';

export interface ServerDeps {
  cfg: Config;
  log: Logger;
  repo: Repository;
  limiter: TokenBucket;
  /** Called after events are persisted, so tests can drain synchronously. */
  onEventsStored?: (count: number) => void;
}

const SIGNATURE_HEADER = 'x-hub-signature-256';
const ADMIN_COOKIE = 'c2dm_admin';

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { cfg, log, repo, limiter } = deps;

  const app = Fastify({
    // Fastify's own logger is off: we log through our pino instance, which has
    // the redaction rules. Anything Fastify would have logged is funnelled
    // through setErrorHandler / the routes themselves.
    logger: false,
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  app.setErrorHandler(async (error: unknown, request, reply) => {
    const err = error as { message?: string; code?: string; statusCode?: number };
    log.error(
      { url: request.url, method: request.method, err: err.message, code: err.code },
      'request failed',
    );
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    return reply.code(status >= 400 && status < 600 ? status : 500).send({ error: 'request failed' });
  });

  // --- raw body -----------------------------------------------------------
  const rawBodies = new WeakMap<FastifyRequest, Buffer>();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, bodyBuffer, done) => {
      const buf = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(String(bodyBuffer));
      rawBodies.set(req, buf);
      if (buf.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(buf.toString('utf8')) as unknown);
      } catch {
        // A body we cannot parse is still signed-or-not; let the route decide.
        done(null, { __unparsable: true });
      }
    },
  );
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      const params = new URLSearchParams(typeof body === 'string' ? body : String(body));
      const out: Record<string, string> = {};
      for (const [k, v] of params) out[k] = v;
      done(null, out);
    },
  );

  // =========================================================================
  // Webhook
  // =========================================================================

  const verifyQuery = z.object({
    'hub.mode': z.string().optional(),
    'hub.verify_token': z.string().optional(),
    'hub.challenge': z.string().optional(),
  });

  /**
   * Verification handshake.
   * https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
   * Meta sends hub.mode=subscribe, hub.verify_token and hub.challenge; we echo
   * the challenge back as plain text if (and only if) the token matches.
   */
  app.get('/webhook', async (req, reply) => {
    const q = verifyQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send('bad query');
    const mode = q.data['hub.mode'];
    const token = q.data['hub.verify_token'];
    const challenge = q.data['hub.challenge'];

    if (mode !== 'subscribe' || !secretEquals(token, cfg.VERIFY_TOKEN)) {
      log.warn({ mode, tokenMatched: secretEquals(token, cfg.VERIFY_TOKEN) }, 'webhook verification rejected');
      return reply.code(403).send('forbidden');
    }
    log.info('webhook verification accepted');
    return reply.code(200).type('text/plain').send(challenge ?? '');
  });

  /**
   * Event notifications. This handler is intentionally tiny: verify, persist,
   * 200. Everything else is the worker's job.
   */
  app.post('/webhook', async (req, reply) => {
    const raw = rawBodies.get(req) ?? Buffer.alloc(0);
    const header = req.headers[SIGNATURE_HEADER];
    const headerValue = Array.isArray(header) ? header[0] : header;

    const sig = verifySignature(raw, headerValue, cfg.APP_SECRET);
    if (!sig.ok) {
      // 403, no detail in the body. Do not log the signature itself.
      log.warn({ reason: sig.reason, bytes: raw.length }, 'webhook signature rejected');
      await repo.appendAudit(
        {
          direction: 'inbound',
          action: 'webhook.rejected',
          status: sig.reason,
          detail: `${raw.length} bytes`,
        },
        new Date(),
      );
      return reply.code(403).send({ error: 'invalid signature' });
    }

    const { events, warnings } = parseWebhook(req.body, new Date());
    for (const w of warnings) log.info({ warning: w }, 'webhook notification partially ignored');

    let stored = 0;
    let duplicates = 0;
    const receivedAt = new Date();
    for (const event of events) {
      try {
        const result = await repo.insertEvent(event, receivedAt);
        if (result.duplicate) {
          duplicates += 1;
          log.info(
            { providerEventId: event.providerEventId },
            'duplicate webhook delivery ignored',
          );
          await repo.appendAudit(
            {
              direction: 'inbound',
              action: `webhook.${event.type}`,
              igsid: event.igsid,
              providerId: event.providerEventId,
              status: 'duplicate',
            },
            receivedAt,
          );
        } else {
          stored += 1;
          await repo.appendAudit(
            {
              direction: 'inbound',
              action: `webhook.${event.type}`,
              igsid: event.igsid,
              providerId: event.providerEventId,
              status: 'stored',
            },
            receivedAt,
          );
        }
      } catch (e) {
        // Never 500 a webhook over one bad event: Meta would redeliver the
        // whole batch, including the events we did store.
        log.error(
          { providerEventId: event.providerEventId, err: e instanceof Error ? e.message : String(e) },
          'could not store webhook event',
        );
      }
    }

    deps.onEventsStored?.(stored);
    return reply.code(200).send({ received: events.length, stored, duplicates });
  });

  // =========================================================================
  // Health
  // =========================================================================

  app.get('/healthz', async (_req, reply) => {
    const health = await repo.health();
    return reply.code(health.ok ? 200 : 503).send({
      status: health.ok ? 'ok' : 'degraded',
      repository: repo.kind,
      detail: health.detail,
      dryRun: cfg.DRY_RUN,
      apiVersion: cfg.API_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get('/', async (_req, reply) => reply.code(200).send({ service: 'comment-to-dm' }));

  // =========================================================================
  // Admin
  // =========================================================================

  function readCookie(req: FastifyRequest, name: string): string | undefined {
    const header = req.headers.cookie;
    if (typeof header !== 'string') return undefined;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== name) continue;
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return undefined;
  }

  /** Bearer header (for curl / scripts) or the cookie (for the browser). */
  function authorised(req: FastifyRequest): boolean {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      if (secretEquals(auth.slice('Bearer '.length), cfg.ADMIN_TOKEN)) return true;
    }
    return secretEquals(readCookie(req, ADMIN_COOKIE), cfg.ADMIN_TOKEN);
  }

  function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
    if (authorised(req)) return true;
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) {
      reply.code(401).type('text/html; charset=utf-8').send(loginPage());
    } else {
      reply.code(401).send({ error: 'unauthorized' });
    }
    return false;
  }

  app.post('/admin/login', async (req, reply) => {
    const body = z.object({ token: z.string().optional() }).safeParse(req.body);
    const token = body.success ? body.data.token : undefined;
    if (!secretEquals(token, cfg.ADMIN_TOKEN)) {
      log.warn('admin login rejected');
      return reply.code(401).type('text/html; charset=utf-8').send(loginPage('That token did not match.'));
    }
    // HttpOnly + SameSite=Strict + Secure in production: the token never
    // reaches page JavaScript and never rides a cross-site request.
    const attrs = [
      `${ADMIN_COOKIE}=${encodeURIComponent(cfg.ADMIN_TOKEN)}`,
      'Path=/admin',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=43200',
    ];
    if (cfg.NODE_ENV === 'production') attrs.push('Secure');
    reply.header('set-cookie', attrs.join('; '));
    return reply.redirect('/admin', 303);
  });

  app.post('/admin/logout', async (_req, reply) => {
    reply.header('set-cookie', `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
    return reply.code(200).type('text/html; charset=utf-8').send(loginPage('Signed out.'));
  });

  async function renderDashboard(
    reply: FastifyReply,
    extra: { banner?: { kind: 'ok' | 'bad'; text: string }; testResult?: string } = {},
  ): Promise<FastifyReply> {
    const [health, rules, conversations, outbox, audit] = await Promise.all([
      repo.health(),
      repo.listRules(),
      repo.listConversations(40),
      repo.listOutbox('all', 40),
      repo.listAudit(60),
    ]);
    const html = dashboard({
      dryRun: cfg.DRY_RUN,
      repositoryKind: repo.kind,
      apiVersion: cfg.API_VERSION,
      rateTokens: limiter.available(),
      health,
      rules,
      conversations,
      outbox,
      audit,
      banner: extra.banner,
      testResult: extra.testResult,
    });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }

  app.get('/admin', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return renderDashboard(reply);
  });

  /** JSON view of the same data, for scripting. */
  app.get('/admin/api/state', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const [rules, conversations, outbox] = await Promise.all([
      repo.listRules(),
      repo.listConversations(100),
      repo.listOutbox('all', 100),
    ]);
    return reply.send({ rules, conversations, outbox, dryRun: cfg.DRY_RUN });
  });

  const ruleForm = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    enabled: z.string().optional(),
    scope: z.enum(['global', 'post']).optional(),
    igMediaId: z.string().optional(),
    matchType: z.enum(['exact', 'contains', 'regex', 'any']).optional(),
    keywords: z.string().optional(),
    caseInsensitive: z.string().optional(),
    publicReplyVariants: z.string().optional(),
    dmPromptText: z.string().optional(),
    buttonLabel: z.string().optional(),
    gateMessage: z.string().optional(),
    resourceText: z.string().optional(),
    resourceUrl: z.string().optional(),
    resourceFollowUp: z.string().optional(),
    requireFollow: z.string().optional(),
    priority: z.string().optional(),
  });

  type RuleForm = z.infer<typeof ruleForm>;

  function splitList(value: string | undefined, sep: RegExp): string[] {
    if (!value) return [];
    return value
      .split(sep)
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }

  function formToRule(f: RuleForm): NewRule {
    const resource: NewRule['resourcePayload'] = { text: f.resourceText ?? '' };
    if (f.resourceUrl && f.resourceUrl.trim() !== '') resource.url = f.resourceUrl.trim();
    if (f.resourceFollowUp && f.resourceFollowUp.trim() !== '') {
      resource.followUp = f.resourceFollowUp.trim();
    }
    const scope = f.scope ?? 'global';
    const mediaId = f.igMediaId && f.igMediaId.trim() !== '' ? f.igMediaId.trim() : null;
    return {
      ...(f.id && f.id.trim() !== '' ? { id: f.id.trim() } : {}),
      name: f.name ?? 'Untitled rule',
      enabled: f.enabled === undefined ? false : f.enabled === 'true',
      scope,
      igMediaId: scope === 'post' ? mediaId : null,
      matchType: f.matchType ?? 'contains',
      keywords: splitList(f.keywords, /,/),
      caseInsensitive: f.caseInsensitive === undefined ? true : f.caseInsensitive === 'true',
      publicReplyVariants: splitList(f.publicReplyVariants, /\r?\n/),
      dmPromptText: f.dmPromptText ?? '',
      buttonLabel: f.buttonLabel ?? 'Send it to me',
      gateMessage: f.gateMessage ?? '',
      resourcePayload: resource,
      requireFollow: f.requireFollow === undefined ? true : f.requireFollow === 'true',
      priority: Number(f.priority ?? '0') || 0,
    };
  }

  app.post('/admin/rules', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const parsed = ruleForm.safeParse(req.body);
    if (!parsed.success) {
      return renderDashboard(reply, { banner: { kind: 'bad', text: 'Could not read that form.' } });
    }
    const draft = formToRule(parsed.data);
    if (draft.id && !/^[A-Za-z0-9_-]+$/.test(draft.id)) {
      return renderDashboard(reply, {
        banner: { kind: 'bad', text: 'Rule id may only contain letters, numbers, - and _.' },
      });
    }
    if (draft.scope === 'post' && draft.igMediaId === null) {
      return renderDashboard(reply, {
        banner: { kind: 'bad', text: 'A post-scoped rule needs a media id.' },
      });
    }
    try {
      const created = await repo.createRule(draft);
      log.info({ ruleId: created.id }, 'rule created from the dashboard');
      return renderDashboard(reply, {
        banner: { kind: 'ok', text: `Rule "${created.id}" created (disabled — enable it when the texts look right).` },
      });
    } catch (e) {
      return renderDashboard(reply, {
        banner: { kind: 'bad', text: e instanceof Error ? e.message : 'Could not create that rule.' },
      });
    }
  });

  app.post('/admin/rules/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const params = z.object({ id: z.string() }).safeParse(req.params);
    const parsed = ruleForm.safeParse(req.body);
    if (!params.success || !parsed.success) {
      return renderDashboard(reply, { banner: { kind: 'bad', text: 'Could not read that form.' } });
    }
    const existing = await repo.getRule(params.data.id);
    if (!existing) {
      return renderDashboard(reply, { banner: { kind: 'bad', text: 'No such rule.' } });
    }
    const draft = formToRule(parsed.data);
    // The edit form does not include `enabled`; leave the toggle to its own button.
    const { id: _unused, ...patch } = draft;
    const updated = await repo.updateRule(params.data.id, {
      ...patch,
      enabled: existing.enabled,
    });
    return renderDashboard(reply, {
      banner: updated
        ? { kind: 'ok', text: `Rule "${updated.id}" saved.` }
        : { kind: 'bad', text: 'Could not save that rule.' },
    });
  });

  app.post('/admin/rules/:id/toggle', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const params = z.object({ id: z.string() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad id' });
    const rule = await repo.getRule(params.data.id);
    if (!rule) {
      return renderDashboard(reply, { banner: { kind: 'bad', text: 'No such rule.' } });
    }
    const updated = await repo.updateRule(rule.id, { enabled: !rule.enabled });
    log.info({ ruleId: rule.id, enabled: updated?.enabled }, 'rule toggled');
    return renderDashboard(reply, {
      banner: {
        kind: 'ok',
        text: `Rule "${rule.id}" is now ${updated?.enabled ? 'ENABLED — it will reply to live comments' : 'disabled'}.`,
      },
    });
  });

  app.post('/admin/outbox/:id/retry', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const params = z.object({ id: z.string() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad id' });
    const item = await repo.requeueOutbox(params.data.id, new Date());
    return renderDashboard(reply, {
      banner: item
        ? {
            kind: item.status === 'queued' ? 'ok' : 'bad',
            text:
              item.status === 'queued'
                ? `Queued ${item.kind} for another try.`
                : `That row is ${item.status}; only failed rows can be retried.`,
          }
        : { kind: 'bad', text: 'No such outbox row.' },
    });
  });

  /**
   * The dry-run tester. Runs the rule engine on text you type and shows exactly
   * what would be sent. It touches no database row and makes no Meta call.
   */
  app.post('/admin/test', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const parsed = z
      .object({ text: z.string().default(''), mediaId: z.string().optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      return renderDashboard(reply, { banner: { kind: 'bad', text: 'Could not read that form.' } });
    }
    const mediaId =
      parsed.data.mediaId && parsed.data.mediaId.trim() !== '' ? parsed.data.mediaId.trim() : null;
    const rules = await repo.listRules();
    const outcome = selectRule(rules, { text: parsed.data.text, mediaId });

    const lines: string[] = [];
    lines.push(`comment: ${JSON.stringify(parsed.data.text)}`);
    lines.push(`media id: ${mediaId ?? '(none)'}`);
    lines.push(`rules considered: ${rules.length} (${rules.filter((r) => r.enabled).length} enabled)`);
    lines.push('');
    if (!outcome) {
      lines.push('RESULT: no rule matched. Nothing would be sent.');
    } else {
      const { rule, keyword } = outcome;
      lines.push(`RESULT: matched rule "${rule.id}" on keyword ${JSON.stringify(keyword)}`);
      lines.push('');
      lines.push(`1. public reply under the comment:`);
      lines.push(`   ${pickPublicReply(rule, 'preview') ?? '(none configured)'}`);
      lines.push('');
      lines.push(`2. private reply (the one we are allowed), with a button "${rule.buttonLabel}":`);
      lines.push(`   ${renderPrompt(rule)}`);
      lines.push('');
      lines.push(`3. on tap, follow check: ${rule.requireFollow ? 'yes' : 'no (delivers immediately)'}`);
      if (rule.requireFollow) {
        lines.push('');
        lines.push(`4a. if not following, gate message:`);
        lines.push(`   ${renderGate(rule)}`);
      }
      lines.push('');
      lines.push(`${rule.requireFollow ? '4b' : '4'}. once allowed, the resource:`);
      lines.push(`   ${renderResource(rule.resourcePayload).replace(/\n/g, '\n   ')}`);
      if (rule.resourcePayload.followUp) {
        lines.push('');
        lines.push(`5. follow-up: ${rule.resourcePayload.followUp}`);
      }
    }
    return renderDashboard(reply, { testResult: lines.join('\n') });
  });

  return app;
}
