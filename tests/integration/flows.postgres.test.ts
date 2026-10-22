/**
 * The same integration suite against real Postgres, so the SQL — the unique
 * indexes, FOR UPDATE SKIP LOCKED, the jsonb and text[] columns — is actually
 * exercised.
 *
 * It runs only when TEST_DATABASE_URL is set, and skips cleanly otherwise:
 *
 *   PowerShell:  $env:TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/c2dm_test"; npm test
 *   bash:        TEST_DATABASE_URL=postgres://... npm test
 *
 * `docker compose up -d db` gives you a Postgres that matches that URL.
 * The schema is created by the real migration runner, and the tables are
 * truncated between tests.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import pg from 'pg';
import { PostgresRepository } from '../../src/repo/postgres.js';
import { runMigrations } from '../../src/repo/migrate.js';
import { runFlowSuite } from './flow-suite.js';

const url = process.env.TEST_DATABASE_URL;

const TABLES = [
  'conversation_transitions',
  'outbox',
  'conversations',
  'events',
  'audit_log',
  'contacts',
  'rules',
];

if (!url) {
  describe.skip('end-to-end flows [postgres]', () => {
    it('skipped: set TEST_DATABASE_URL to run the suite against real Postgres', () => {
      /* intentionally empty */
    });
  });
} else {
  const connectionString = url;
  let admin: pg.Pool;
  const pools: PostgresRepository[] = [];

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString, max: 2 });
    await runMigrations(admin);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.close().catch(() => undefined)));
    await admin.end();
  });

  runFlowSuite({
    label: 'postgres',
    makeRepo: async () => {
      // A clean slate for every test. schema_migrations is left alone so the
      // migrations are not re-run.
      await admin.query(`truncate ${TABLES.join(', ')} restart identity cascade`);
      const repo = new PostgresRepository({ connectionString, max: 4 });
      pools.push(repo);
      return repo;
    },
  });
}
