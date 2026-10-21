import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';

import { EMBEDDED_MIGRATIONS, STATEMENT_BREAKPOINT } from './migrations.generated';
import * as schema from './schema';
import { SnapshotPreconditionError, type SnapshotStore } from './store';

export type Database = PgliteDatabase<typeof schema> & { $client: PGlite };

export interface DatabaseContextOptions {
  store: SnapshotStore;
  /** Runs after migrations on every boot; must be idempotent. */
  seed?: (db: Database) => Promise<void>;
  /** Max retries after a conditional-write conflict. Plan: at most two. */
  maxWriteRetries?: number;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export type AccessMode = 'read' | 'write';

export interface AccessOptions {
  mode?: AccessMode;
}

/** Thrown when a write could not land after exhausting retries. Becomes HTTP 409. */
export class WriteConflictError extends Error {
  readonly code = 'write_conflict';
  constructor(message = 'The server could not commit the change, please retry') {
    super(message);
    this.name = 'WriteConflictError';
  }
}

const BOOT_LOCK_TABLE = '__qa_migrations';

/**
 * Owns exactly one PGlite instance per serverless instance and the snapshot protocol
 * around it.
 *
 *   boot      read snapshot -> PGlite memory:// -> migrations -> seed
 *   read      stat() revalidation, no writes
 *   write     one dump + one conditional put, retried on conflict
 *
 * The whole-database snapshot means concurrency is optimistic: two instances can
 * both work, but only one write lands; the loser reloads and retries. Losing work is
 * impossible, and a 409 is returned rather than a silent overwrite.
 */
export class DatabaseController {
  private pg: PGlite | null = null;
  private handle: Database | null = null;
  private etag: string | null = null;
  private loading: Promise<void> | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private bootCount = 0;

  private readonly maxWriteRetries: number;

  constructor(private readonly options: DatabaseContextOptions) {
    this.maxWriteRetries = options.maxWriteRetries ?? 2;
  }

  /** Public entry point used by every route handler. */
  async withDatabase<T>(
    fn: (db: Database) => Promise<T>,
    access: AccessOptions = {},
  ): Promise<T> {
    if ((access.mode ?? 'read') === 'read') {
      await this.ensureFresh();
      return fn(this.handle as Database);
    }
    // Serialize writes per instance: the handler work and its dump happen together,
    // so a second request cannot be working against a snapshot that is being replaced.
    const run = this.writeQueue.then(
      () => this.runWrite(fn),
      () => this.runWrite(fn),
    );
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Diagnostics for `/api/v1/health` and tests. */
  info(): { loaded: boolean; bootCount: number; etag: string | null } {
    return { loaded: this.handle !== null, bootCount: this.bootCount, etag: this.etag };
  }

  private async runWrite<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= this.maxWriteRetries; attempt += 1) {
      await this.ensureFresh();
      const db = this.handle as Database;
      const etag = this.etag;

      // The handler runs in one transaction: a thrown ApiError rolls the in-memory
      // database back to its pre-request state, so a rejected login or a 409 never
      // costs a reload and can never leak a half-applied change into the snapshot.
      const result = await db.transaction(async (tx) => fn(tx as unknown as Database));

      try {
        const dumped = await (this.pg as PGlite).dumpDataDir('gzip');
        const bytes = new Uint8Array(await dumped.arrayBuffer());
        this.etag = await this.options.store.write(bytes, { ifMatch: etag });
        return result;
      } catch (error) {
        if (error instanceof SnapshotPreconditionError) {
          this.log('snapshot conflict, reloading and retrying', { attempt });
          await this.discard();
          continue;
        }
        await this.discard();
        throw error;
      }
    }
    throw new WriteConflictError();
  }

  /** Loads the instance if needed and discards it when the snapshot moved on. */
  private async ensureFresh(): Promise<void> {
    if (this.handle) {
      const current = await this.options.store.stat();
      if (current !== null && current === this.etag) return;
      this.log('snapshot changed on another instance, reloading');
      await this.discard();
    }
    await this.load();
  }

  private async load(): Promise<void> {
    if (this.handle) return;
    if (this.loading) {
      await this.loading;
      return;
    }
    this.loading = this.doLoad().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  private async doLoad(): Promise<void> {
    const startedAt = Date.now();
    const snapshot = await this.options.store.read();

    const pg = snapshot
      ? await PGlite.create({
          dataDir: 'memory://',
          loadDataDir: new Blob([new Uint8Array(snapshot.data)]),
        })
      : await PGlite.create({ dataDir: 'memory://' });

    const db = drizzle(pg, { schema });
    await this.applyMigrations(db);
    if (this.options.seed) await this.options.seed(db);

    this.pg = pg;
    this.handle = db;
    this.etag = snapshot?.etag ?? null;
    this.bootCount += 1;

    if (!snapshot) {
      // First boot ever: persist the initialised database so the next instance does
      // not have to rebuild it. A concurrent first boot makes this write fail and
      // falls through to a reload of the winner's snapshot.
      try {
        const dumped = await pg.dumpDataDir('gzip');
        const bytes = new Uint8Array(await dumped.arrayBuffer());
        this.etag = await this.options.store.write(bytes, { ifMatch: null });
      } catch (error) {
        if (!(error instanceof SnapshotPreconditionError)) throw error;
        this.log('another instance initialised the snapshot first, reloading');
        await this.discard();
        await this.load();
        return;
      }
    }

    this.log('database ready', {
      bootMs: Date.now() - startedAt,
      loadedFromSnapshot: snapshot !== null,
      bytes: snapshot?.data.byteLength ?? null,
    });
  }

  private async applyMigrations(db: Database): Promise<void> {
    await db.execute(
      sql`create table if not exists ${sql.identifier(BOOT_LOCK_TABLE)} (
            hash text primary key,
            name text not null,
            applied_at timestamptz not null default now()
          )`,
    );
    const existing = await db.execute<{ hash: string }>(
      sql`select hash from ${sql.identifier(BOOT_LOCK_TABLE)}`,
    );
    const applied = new Set(existing.rows.map((row) => row.hash));

    for (const migration of EMBEDDED_MIGRATIONS) {
      if (applied.has(migration.hash)) continue;
      const statements = migration.sql
        .split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter(Boolean);
      await db.transaction(async (tx) => {
        for (const statement of statements) {
          await tx.execute(sql.raw(statement));
        }
        await tx.execute(
          sql`insert into ${sql.identifier(BOOT_LOCK_TABLE)} (hash, name) values (${migration.hash}, ${migration.name})`,
        );
      });
    }
  }

  private async discard(): Promise<void> {
    const pg = this.pg;
    this.pg = null;
    this.handle = null;
    this.etag = null;
    if (pg) {
      try {
        await pg.close();
      } catch (error) {
        this.log('failed to close PGlite instance', { error: String(error) });
      }
    }
  }

  private log(message: string, meta?: Record<string, unknown>): void {
    (this.options.logger ?? defaultLogger)(message, meta);
  }
}

function defaultLogger(message: string, meta?: Record<string, unknown>): void {
  // Never log secrets: callers only pass sizes, timings and attempt numbers.
  console.info(JSON.stringify({ scope: 'db', message, ...meta }));
}
