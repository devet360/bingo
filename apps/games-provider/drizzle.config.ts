import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit resolves `schema`/`out` relative to the config file's cwd, which
// for `npm run db:generate -w @bingo/games-provider` is the app directory.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.GAMES_DATABASE_URL! },
  verbose: true,
});
