import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { open } from './db.mjs';
const username = process.env.BOOTSTRAP_USERNAME || 'admin';
const password = process.env.BOOTSTRAP_PASSWORD;
if (!password || password.length < 14)
  throw new Error('Set BOOTSTRAP_PASSWORD to at least 14 characters.');
const salt = randomBytes(32).toString('hex');
const iterations = 600000; // Keep in step with PBKDF2_ITERATIONS in lib/security.ts.
const hash = `pbkdf2$${iterations}$${salt}$${pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex')}`;
const db = await open(process.env.DATABASE_URL);
try {
  const rows = await db.query(
    `INSERT INTO qms.users(username,name,role,password_hash,services,must_change_password,counter) VALUES($1,'QMS Administrator','admin',$2,ARRAY['crm-general','crm-noc','crm-refund','crm-handover','collection','general'],true,'Reception') ON CONFLICT(username) DO NOTHING RETURNING id`,
    [username, hash],
  );
  console.log(
    rows.length
      ? 'Administrator created. Use the username and password in your local .env, then change the password at first sign-in.'
      : 'Administrator already exists; credentials were not changed.',
  );
} finally {
  await db.end();
}
