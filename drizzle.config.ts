import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit is only used to author migrations (`npm run migrations:generate`).
 * The application never reads `drizzle/` at runtime: `scripts/embed-migrations.mjs`
 * inlines the SQL into `lib/db/migrations.generated.ts` so the serverless bundle
 * does not depend on filesystem layout.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/db/schema.ts',
  out: './drizzle',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
  strict: true,
  verbose: true,
});
