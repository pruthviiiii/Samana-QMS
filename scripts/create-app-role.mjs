import { randomBytes } from 'node:crypto';
import { open } from './db.mjs';
// Creates the restricted runtime role, or refreshes its grants, in the
// database that the owner connection string points at. The web and worker
// connect as this role: read and write the qms tables, run its functions,
// nothing else (no DDL, no other schemas). Migrations keep running as the
// owner through MIGRATE_DATABASE_URL. Works on any PostgreSQL server; the
// connecting role needs CREATEROLE (or superuser) the first time.
//
//   node --env-file=.env scripts/create-app-role.mjs        (npm run db:app-role)
//   QMS_APP_PASSWORD=... node --env-file=.env scripts/create-app-role.mjs
//
// Run it once per database (samana_qms, samana_qms_test). The password is
// printed only when the role is created or QMS_APP_PASSWORD is given; put the
// printed DATABASE_URL in the environment and move the owner string to
// MIGRATE_DATABASE_URL.
const ownerUrl = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!ownerUrl)
  throw new Error(
    'Set MIGRATE_DATABASE_URL or DATABASE_URL to the owner connection string.',
  );
const role = process.env.QMS_APP_ROLE || 'qms_app';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role))
  throw new Error('QMS_APP_ROLE must be a plain lowercase identifier.');
let password = process.env.QMS_APP_PASSWORD || null;
if (password && !/^[A-Za-z0-9_-]{16,128}$/.test(password))
  throw new Error('QMS_APP_PASSWORD must be 16 to 128 letters, digits, _ or -.');
const db = await open(ownerUrl);
try {
  const [owner] = await db.query('SELECT current_user AS name');
  const [existing] = await db.query(
    'SELECT 1 FROM pg_roles WHERE rolname=$1',
    [role],
  );
  if (!existing) {
    password ||= randomBytes(24).toString('base64url');
    await db.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    console.log(`Created role ${role}.`);
  } else if (password) {
    await db.query(`ALTER ROLE "${role}" PASSWORD '${password}'`);
    console.log(`Role ${role} exists; password updated.`);
  } else console.log(`Role ${role} exists; password unchanged.`);
  const database = new URL(ownerUrl).pathname.slice(1);
  for (const statement of [
    `GRANT CONNECT ON DATABASE "${database}" TO "${role}"`,
    `GRANT USAGE ON SCHEMA qms TO "${role}"`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA qms TO "${role}"`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA qms TO "${role}"`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA qms TO "${role}"`,
    // Objects that later migrations create as the owner are covered too.
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner.name}" IN SCHEMA qms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${role}"`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner.name}" IN SCHEMA qms GRANT USAGE, SELECT ON SEQUENCES TO "${role}"`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner.name}" IN SCHEMA qms GRANT EXECUTE ON FUNCTIONS TO "${role}"`,
  ])
    await db.query(statement);
  console.log(`Grants refreshed for ${role} in ${database}.`);
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password || 'PASSWORD';
  console.log(`DATABASE_URL=${url.toString()}`);
  if (!password)
    console.log(
      'Replace PASSWORD with the password issued when the role was created.',
    );
} finally {
  await db.end();
}
