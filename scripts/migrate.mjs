import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { splitStatements } from './sql.mjs';
const sql = neon(process.env.DATABASE_URL);
await sql.query('CREATE SCHEMA IF NOT EXISTS qms');
await sql.query(
  'CREATE TABLE IF NOT EXISTS qms.migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
);
// The ledger records a checksum of each applied file. Editing an applied
// migration is refused: the change would never run anywhere. Add a new one.
await sql.query(
  'ALTER TABLE qms.migrations ADD COLUMN IF NOT EXISTS checksum text',
);
const checksumOf = (content) =>
  createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
for (const name of (await readdir(new URL('../db/', import.meta.url)))
  .filter((n) => n.endsWith('.sql'))
  .sort()) {
  const content = await readFile(
    new URL(`../db/${name}`, import.meta.url),
    'utf8',
  );
  const checksum = checksumOf(content);
  const [applied] = await sql.query(
    'SELECT name,checksum FROM qms.migrations WHERE name=$1',
    [name],
  );
  if (applied) {
    if (!applied.checksum) {
      await sql.query('UPDATE qms.migrations SET checksum=$2 WHERE name=$1', [
        name,
        checksum,
      ]);
      console.log(`Already applied ${name} (checksum recorded)`);
    } else if (applied.checksum !== checksum) {
      throw new Error(
        `${name} was changed after it was applied. Applied migrations are immutable; add a new migration instead.`,
      );
    } else console.log(`Already applied ${name}`);
    continue;
  }
  await sql.transaction([
    ...splitStatements(content).map((statement) => sql.query(statement)),
    sql.query('INSERT INTO qms.migrations(name,checksum) VALUES($1,$2)', [
      name,
      checksum,
    ]),
  ]);
  console.log(`Applied ${name}`);
}
