/**
 * Migration runner. Plain numbered .sql files in /migrations, applied in
 * filename order, each inside a transaction, each recorded so it runs once.
 *
 * Idempotent and safe to run on every boot:
 *   - a Postgres advisory lock serialises two instances starting together;
 *   - `schema_migrations` records what has been applied;
 *   - a file that is already recorded is skipped.
 *
 * Changing an already-applied file is a mistake (the checksum is recorded and a
 * mismatch is reported, not silently ignored). Add a new numbered file instead.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Same advisory-lock key every instance uses. Arbitrary but fixed. */
const LOCK_KEY = 8_123_440_177;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  checksumMismatches: string[];
}

export function defaultMigrationsDir(): string {
  // src/repo/migrate.ts -> <project>/migrations
  // dist/repo/migrate.js -> <project>/migrations (same two levels up)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'migrations');
}

export async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export async function runMigrations(
  pool: pg.Pool,
  dir: string = defaultMigrationsDir(),
): Promise<MigrationResult> {
  const files = await listMigrationFiles(dir);
  const result: MigrationResult = { applied: [], skipped: [], checksumMismatches: [] };

  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        filename   text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const done = await client.query<{ filename: string; checksum: string }>(
      'select filename, checksum from schema_migrations',
    );
    const seen = new Map(done.rows.map((r) => [r.filename, r.checksum]));

    for (const filename of files) {
      const sql = await readFile(path.join(dir, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      const previous = seen.get(filename);

      if (previous !== undefined) {
        if (previous !== checksum) result.checksumMismatches.push(filename);
        result.skipped.push(filename);
        continue;
      }

      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(
          'insert into schema_migrations (filename, checksum) values ($1, $2)',
          [filename, checksum],
        );
        await client.query('commit');
        result.applied.push(filename);
      } catch (e) {
        await client.query('rollback');
        throw new Error(
          `migration ${filename} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }

  return result;
}
