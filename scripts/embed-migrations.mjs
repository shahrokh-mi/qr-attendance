#!/usr/bin/env node
/**
 * Inlines `drizzle/*.sql` into `lib/db/migrations.generated.ts`.
 *
 * Why: serverless bundles cannot reliably read the `drizzle/` directory at runtime,
 * and the migrator that ships with drizzle reads journal files from disk. Embedding
 * the statements makes boot deterministic and lets the snapshot self-heal after a
 * deploy that adds a migration.
 *
 * Runs automatically from `npm run build` and before the test suites.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const migrationsDir = path.join(root, 'drizzle');
const target = path.join(root, 'lib', 'db', 'migrations.generated.ts');

const files = (await readdir(migrationsDir))
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  throw new Error(`No .sql migrations found in ${migrationsDir}`);
}

const entries = [];
for (const file of files) {
  const sql = await readFile(path.join(migrationsDir, file), 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  entries.push({ name: file, hash, sql });
}

const header = `// GENERATED FILE — do not edit.
// Source: drizzle/*.sql. Regenerate with \`npm run migrations:embed\`.
// eslint-disable-next-line
export interface EmbeddedMigration {
  readonly name: string;
  readonly hash: string;
  readonly sql: string;
}

// The migrator splits on this token; a single statement cannot contain it.
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

export const EMBEDDED_MIGRATIONS: readonly EmbeddedMigration[] = [
`;

const body = entries
  .map(
    (entry) =>
      `  {\n    name: ${JSON.stringify(entry.name)},\n    hash: ${JSON.stringify(
        entry.hash,
      )},\n    sql: ${JSON.stringify(entry.sql)},\n  },`,
  )
  .join('\n');

await writeFile(target, `${header}${body}\n];\n`, 'utf8');

console.log(
  `Embedded ${entries.length} migration(s) into lib/db/migrations.generated.ts`,
);
