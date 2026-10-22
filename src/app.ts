/**
 * Wiring. One function builds the whole system from a Config, so the
 * production entrypoint, the test harness and the simulator all assemble the
 * same objects in the same order.
 */
import type { FastifyInstance } from 'fastify';
import { type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { Engine } from './core/engine.js';
import { Workers } from './core/workers.js';
import { DryRunMetaClient, HttpMetaClient, type FetchLike, type MetaClient } from './meta/client.js';
import { TokenBucket } from './meta/ratelimit.js';
import { MemoryRepository } from './repo/memory.js';
import { PostgresRepository } from './repo/postgres.js';
import { runMigrations } from './repo/migrate.js';
import type { Repository } from './repo/repository.js';
import { createServer } from './server.js';

export interface BuildOptions {
  cfg: Config;
  /** Supply one to override the config-driven choice (tests, simulator). */
  repo?: Repository;
  meta?: MetaClient;
  log?: Logger;
  /** Point the real client at a mock without opening a socket. */
  fetchImpl?: FetchLike;
  now?: () => Date;
  random?: () => number;
  /** Run the SQL migrations on boot. Default true for the postgres repo. */
  migrate?: boolean;
}

export interface App {
  cfg: Config;
  log: Logger;
  repo: Repository;
  meta: MetaClient;
  limiter: TokenBucket;
  engine: Engine;
  workers: Workers;
  server: FastifyInstance;
  /** Stop workers, close the server and the DB pool, in that order. */
  shutdown: () => Promise<void>;
}

export function buildRepository(cfg: Config): Repository {
  if (cfg.REPOSITORY === 'memory') return new MemoryRepository();
  if (!cfg.DATABASE_URL) throw new Error('DATABASE_URL is required when REPOSITORY=postgres');
  return new PostgresRepository({ connectionString: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL });
}

export function buildMetaClient(cfg: Config, fetchImpl?: FetchLike): MetaClient {
  if (cfg.DRY_RUN) return new DryRunMetaClient();
  return new HttpMetaClient({
    baseUrl: cfg.GRAPH_BASE_URL,
    apiVersion: cfg.API_VERSION,
    igUserId: cfg.IG_USER_ID,
    accessToken: cfg.IG_ACCESS_TOKEN,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export async function buildApp(opts: BuildOptions): Promise<App> {
  const { cfg } = opts;
  const log = opts.log ?? createLogger(cfg);
  const repo = opts.repo ?? buildRepository(cfg);
  const meta = opts.meta ?? buildMetaClient(cfg, opts.fetchImpl);

  await repo.init();

  const shouldMigrate = opts.migrate ?? repo.kind === 'postgres';
  if (shouldMigrate && repo instanceof PostgresRepository) {
    const result = await runMigrations(repo.rawPool);
    log.info(
      { applied: result.applied, skipped: result.skipped.length },
      'migrations up to date',
    );
    if (result.checksumMismatches.length > 0) {
      log.error(
        { files: result.checksumMismatches },
        'an applied migration file has changed on disk; add a new numbered file instead of editing one',
      );
    }
  }

  const limiter = new TokenBucket({
    perHour: cfg.RATE_LIMIT_PER_HOUR,
    burst: cfg.RATE_LIMIT_BURST,
    ...(opts.now ? { now: () => opts.now!().getTime() } : {}),
  });

  const engine = new Engine({
    repo,
    meta,
    cfg,
    log,
    limiter,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.random ? { random: opts.random } : {}),
  });

  const workers = new Workers({
    repo,
    engine,
    cfg,
    log,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const server = await createServer({ cfg, log, repo, limiter });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down');
    await workers.stop();
    await server.close();
    await repo.close();
    log.info('shutdown complete');
  };

  return { cfg, log, repo, meta, limiter, engine, workers, server, shutdown };
}
