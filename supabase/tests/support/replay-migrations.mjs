import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const migrationDir = new URL('../../migrations/', import.meta.url);
const supportDir = new URL('./', import.meta.url);

// baseline.sql is split on "-- @before <migration file prefix>" markers; the first segment runs
// right after the first migration, the others run immediately before the named migration.
function parseBaseline(text) {
  const segments = [{ before: null, sql: '' }];
  for (const line of text.split('\n')) {
    const marker = line.match(/^-- @before (\S+)/);
    if (marker) segments.push({ before: marker[1], sql: '' });
    else segments.at(-1).sql += `${line}\n`;
  }
  return segments;
}

export async function replayMigrations({ log = () => {}, upTo = null } = {}) {
  const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort()
    .filter(name => !upTo || name <= upTo);
  const segments = parseBaseline(await readFile(new URL('baseline.sql', supportDir), 'utf8'));
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await db.exec(await readFile(new URL('platform.sql', supportDir), 'utf8'));
  const failures = [];
  for (const [index, file] of files.entries()) {
    for (const segment of segments) {
      if (segment.before && file.startsWith(segment.before)) await db.exec(segment.sql);
    }
    let sql = await readFile(new URL(file, migrationDir), 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron[^;]*;/gi, '')
      .replace(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/gi, '');
    try {
      await db.exec(sql);
    } catch (error) {
      failures.push({ file, message: String(error.message).split('\n')[0] });
      try { await db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    }
    if (index === 0) await db.exec(segments[0].sql);
  }
  log(`replayed ${files.length} migrations, ${failures.length} failed`);
  return { db, failures, files };
}
