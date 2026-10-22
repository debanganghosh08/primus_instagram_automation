/**
 * Production entrypoint. Loads .env, validates the config, runs the
 * migrations, starts the workers, listens, and shuts down cleanly on
 * SIGTERM/SIGINT (Render sends SIGTERM on every deploy).
 */
import 'dotenv/config';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { fingerprint } from './logger.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n\nSee .env.example for every variable.\n`);
      process.exit(78); // EX_CONFIG
    }
    throw e;
  }

  const app = await buildApp({ cfg });
  const { log } = app;

  log.info(
    {
      nodeEnv: cfg.NODE_ENV,
      repository: app.repo.kind,
      apiVersion: cfg.API_VERSION,
      dryRun: cfg.DRY_RUN,
      igUserId: cfg.IG_USER_ID,
      accessToken: fingerprint(cfg.IG_ACCESS_TOKEN),
      rateLimitPerHour: cfg.RATE_LIMIT_PER_HOUR,
    },
    'comment-to-dm starting',
  );
  if (cfg.DRY_RUN) {
    log.warn('DRY_RUN=true - nothing will be sent to Instagram');
  }

  app.workers.start();
  await app.server.listen({ port: cfg.PORT, host: cfg.HOST });
  log.info({ port: cfg.PORT, host: cfg.HOST }, 'listening');

  let closing = false;
  const close = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'signal received');
    void app
      .shutdown()
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        log.error({ err: e instanceof Error ? e.message : String(e) }, 'unclean shutdown');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => close('SIGTERM'));
  process.on('SIGINT', () => close('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
