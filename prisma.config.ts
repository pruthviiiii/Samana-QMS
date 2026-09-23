import { defineConfig } from 'prisma/config';
// Prisma CLI configuration (Prisma 7). Used by `prisma db pull`, which
// introspects the database into backend/prisma/schema.prisma, and by `prisma
// generate`, which writes the typed client to backend/generated/prisma.
//
// The datasource address is read lazily: generation needs no database, and it
// runs on every install (postinstall), including builds that have no
// DATABASE_URL at all. Only introspection needs the address, and it names the
// variable when it is missing. Operators run introspection as
// `npm run prisma:pull`, which loads .env.test.
//
// Migrations are not Prisma's job here. The queue engine's rules live in
// PostgreSQL functions, triggers and partial indexes that the Prisma schema
// language cannot express, so the numbered SQL files in db/ remain the single
// source of truth and scripts/migrate.mjs applies them with checksums. The
// Prisma schema describes the result, and tests/schema.test.ts fails when the
// committed schema no longer matches the migrated database.
const url = process.env.DATABASE_URL;
export default defineConfig({
  schema: 'backend/prisma/schema.prisma',
  ...(url ? { datasource: { url } } : {}),
});
