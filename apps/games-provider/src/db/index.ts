import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Resolve the migrations folder from this module, not from `process.cwd()`:
// production boots from the repo root while `npm run dev` runs inside the app
// directory. From `src/db/index.ts` (`src/db` at runtime via tsx, or the built
// `dist` mirror) this lands on `apps/games-provider/drizzle`.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function createDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool);
  return {
    db,
    pool,
    async migrate() {
      await runMigrations(db, { migrationsFolder });
    },
    async close() {
      await pool.end();
    },
  };
}

export type Database = ReturnType<typeof createDb>['db'];
