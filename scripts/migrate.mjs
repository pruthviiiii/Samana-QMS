import { neon } from '@neondatabase/serverless';
import { readFile, readdir } from 'node:fs/promises';
import { splitStatements } from './sql.mjs';
const sql = neon(process.env.DATABASE_URL);
await sql.query('CREATE SCHEMA IF NOT EXISTS qms');
await sql.query(
  'CREATE TABLE IF NOT EXISTS qms.migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
);
for (const name of (await readdir(new URL('../db/', import.meta.url)))
  .filter((n) => n.endsWith('.sql'))
  .sort()) {
  const applied = await sql.query(
    'SELECT name FROM qms.migrations WHERE name=$1',
    [name],
  );
  if (applied.length) {
    console.log(`Already applied ${name}`);
    continue;
  }
  const content = await readFile(
    new URL(`../db/${name}`, import.meta.url),
    'utf8',
  );
  await sql.transaction([
    ...splitStatements(content).map((statement) => sql.query(statement)),
    sql.query('INSERT INTO qms.migrations(name) VALUES($1)', [name]),
  ]);
  console.log(`Applied ${name}`);
}
