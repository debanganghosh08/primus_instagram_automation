/**
 * All configuration comes from the environment. Nothing else.
 * `.env.example` documents every variable; this file is the single source of
 * truth for defaults and validation.
 */
import { z } from 'zod';

const boolish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const intIn = (min: number, max: number, dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intIn(1, 65535, 3000),
  HOST: z.string().default('0.0.0.0'),

  /** Postgres connection string. Omit it only with REPOSITORY=memory. */
  DATABASE_URL: z.string().optional(),
  /** 'postgres' in production; 'memory' for the simulator and tests. */
  REPOSITORY: z.enum(['postgres', 'memory']).default('postgres'),
  /** Supabase and most hosted Postgres need TLS; local Docker does not. */
  DATABASE_SSL: boolish.optional().default(false),

  /** Meta app secret — used ONLY to verify X-Hub-Signature-256. */
  APP_SECRET: z.string().min(1),
  /** The string you typed into the Meta dashboard's webhook Verify Token box. */
  VERIFY_TOKEN: z.string().min(1),
  /** Your Instagram professional account's id (the app user's IG id). */
  IG_USER_ID: z.string().min(1),
  /** Long-lived Instagram User access token. Rotate every <60 days. */
  IG_ACCESS_TOKEN: z.string().min(1),
  API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),
  GRAPH_BASE_URL: z.string().url().default('https://graph.instagram.com'),

  /** Bearer token for /admin. Long and random. */
  ADMIN_TOKEN: z.string().min(8),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** true = never call Meta. Outbound calls are logged and marked sent. */
  DRY_RUN: boolish.optional().default(false),

  // -- workers -------------------------------------------------------------
  EVENT_POLL_MS: intIn(50, 60_000, 1_000),
  OUTBOX_POLL_MS: intIn(50, 60_000, 1_000),
  EVENT_BATCH: intIn(1, 200, 10),
  OUTBOX_BATCH: intIn(1, 200, 10),
  /** Max delivery attempts per outbox row before it is FAILED. */
  MAX_ATTEMPTS: intIn(1, 20, 5),
  BACKOFF_BASE_MS: intIn(100, 600_000, 2_000),
  BACKOFF_MAX_MS: intIn(1_000, 86_400_000, 300_000),

  // -- safety rails --------------------------------------------------------
  /** Meta's documented private-reply budget is 750/hour/account. */
  RATE_LIMIT_PER_HOUR: intIn(1, 10_000, 600),
  RATE_LIMIT_BURST: intIn(1, 1_000, 20),
  /** One person cannot be messaged again inside this window. */
  CONTACT_COOLDOWN_MINUTES: intIn(0, 10_080, 10),
  /** Hard ceiling of messages to one person in 24 h. */
  MAX_MESSAGES_PER_CONTACT_PER_DAY: intIn(1, 100, 6),
  /** Hard ceiling of messages from the account in one hour. */
  MAX_MESSAGES_PER_HOUR: intIn(1, 10_000, 400),
  /** Meta allows a private reply within 7 days of the comment. */
  PRIVATE_REPLY_MAX_AGE_HOURS: intIn(1, 168, 168),
  /** The standard messaging window a user action opens. */
  MESSAGING_WINDOW_HOURS: intIn(1, 168, 24),
  /** A tap after delivery re-sends the resource at most once per cooldown. */
  REDELIVERY_COOLDOWN_MINUTES: intIn(0, 10_080, 10),
  /** Conversations with no action for this long are ABANDONED. */
  ABANDON_AFTER_HOURS: intIn(1, 8_760, 72),
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const cfg = parsed.data;
  if (cfg.REPOSITORY === 'postgres' && !cfg.DATABASE_URL) {
    throw new ConfigError('Invalid configuration:\n  DATABASE_URL: required when REPOSITORY=postgres');
  }
  return cfg;
}

/** Defaults good enough to boot the whole system with no services at all. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = schema.parse({
    NODE_ENV: 'test',
    REPOSITORY: 'memory',
    APP_SECRET: 'test-app-secret',
    VERIFY_TOKEN: 'test-verify-token',
    IG_USER_ID: '17841400000000000',
    IG_ACCESS_TOKEN: 'test-token-not-a-real-credential',
    ADMIN_TOKEN: 'test-admin-token',
    LOG_LEVEL: 'silent',
    GRAPH_BASE_URL: 'https://graph.instagram.test',
  } satisfies Record<string, string>);
  return { ...base, ...overrides };
}
