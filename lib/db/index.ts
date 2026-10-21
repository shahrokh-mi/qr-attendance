import path from 'node:path';

import { getConfig } from '@/lib/config';

import { seedDatabase } from './bootstrap';
import { DatabaseController } from './controller';
import { BlobSnapshotStore, FileSnapshotStore, type SnapshotStore } from './store';

/**
 * Process-wide database accessor.
 *
 * `withDatabase` is the only function application code calls. Everything about
 * snapshot storage lives behind it, so moving to a hosted Postgres later means
 * replacing this module, not the handlers.
 */

function createStore(): SnapshotStore {
  const config = getConfig();
  if (config.storageMode === 'blob') {
    return new BlobSnapshotStore(config.snapshotPath, config.blobToken as string);
  }
  // Local mode: the snapshot tarball lives inside the git-ignored data directory so
  // local development exercises the same dump/load/conditional-write path as Vercel.
  return new FileSnapshotStore(
    path.resolve(process.cwd(), config.localDataDir, 'snapshot.tar.gz'),
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __qrAttendanceDb: DatabaseController | undefined;
}

export function getDatabaseController(): DatabaseController {
  if (!globalThis.__qrAttendanceDb) {
    const config = getConfig();
    globalThis.__qrAttendanceDb = new DatabaseController({
      store: createStore(),
      seed: (db) => seedDatabase(db, config.bootstrapAdminPassword),
    });
  }
  return globalThis.__qrAttendanceDb;
}

/** Read-only access: revalidates the snapshot metadata, never writes. */
export function withDatabase<T>(fn: (db: import('./controller').Database) => Promise<T>) {
  return getDatabaseController().withDatabase(fn, { mode: 'read' });
}

/** Mutating access: one dump and one conditional put after the handler succeeds. */
export function withDatabaseWrite<T>(
  fn: (db: import('./controller').Database) => Promise<T>,
) {
  return getDatabaseController().withDatabase(fn, { mode: 'write' });
}

export type { Database } from './controller';
export { WriteConflictError } from './controller';
