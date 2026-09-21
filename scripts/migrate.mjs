import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { open } from './db.mjs';
import { migrationFile, splitStatements } from './sql.mjs';
// Migrations run as the schema owner. When the app connects as the restricted
// qms_app role (scripts/create-app-role.mjs), keep the owner connection string
// in MIGRATE_DATABASE_URL; otherwise DATABASE_URL is used for both.
const db = await open(
  process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL,
);
try {
  await db.query('CREATE SCHEMA IF NOT EXISTS qms');
  await db.query(
    'CREATE TABLE IF NOT EXISTS qms.migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  // The ledger records a checksum of each applied file. Editing an applied
  // migration is refused: the change would never run anywhere. Add a new one.
  await db.query(
    'ALTER TABLE qms.migrations ADD COLUMN IF NOT EXISTS checksum text',
  );
  const checksumOf = (content) =>
    createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
  for (const name of (await readdir(new URL('../db/', import.meta.url)))
    .filter((n) => migrationFile.test(n))
    .sort()) {
    const content = await readFile(
      new URL(`../db/${name}`, import.meta.url),
      'utf8',
    );
    const checksum = checksumOf(content);
    const [applied] = await db.query(
      'SELECT name,checksum FROM qms.migrations WHERE name=$1',
      [name],
    );
    if (applied) {
      if (!applied.checksum) {
        await db.query('UPDATE qms.migrations SET checksum=$2 WHERE name=$1', [
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
    // Every statement of a file and its ledger row commit together.
    await db.transaction(async (run) => {
      for (const statement of splitStatements(content)) await run(statement);
      await run('INSERT INTO qms.migrations(name,checksum) VALUES($1,$2)', [
        name,
        checksum,
      ]);
    });
    console.log(`Applied ${name}`);
  }
} finally {
  await db.end();
}
