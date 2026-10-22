/**
 * `npm run migrate` — apply the SQL migrations and exit.
 *
 * The service also migrates on boot, so this is for when you want to run the
 * schema change first (or check what is pending) without starting the service.
 */
import 'dotenv/config';
import { loadConfig } from '../config.js';
import { PostgresRepository } from './postgres.js';
import { defaultMigrationsDir, listMigrationFiles, runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  if (!cfg.DATABASE_URL) {
    process.stderr.write('DATABASE_URL is not set; nothing to migrate.\n');
    process.exit(78);
  }
  const dir = defaultMigrationsDir();
  const files = await listMigrationFiles(dir);
  process.stdout.write(`migrations dir: ${dir}\nfound ${files.length} file(s)\n`);

  const repo = new PostgresRepository({
    connectionString: cfg.DATABASE_URL,
    ssl: cfg.DATABASE_SSL,
    applicationName: 'comment-to-dm-migrate',
  });
  try {
    const result = await runMigrations(repo.rawPool, dir);
    for (const f of result.applied) process.stdout.write(`  applied  ${f}\n`);
    for (const f of result.skipped) process.stdout.write(`  already  ${f}\n`);
    for (const f of result.checksumMismatches) {
      process.stdout.write(`  WARNING  ${f} changed since it was applied; add a new file instead\n`);
    }
    process.stdout.write('done\n');
  } finally {
    await repo.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`migration failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
