import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Snapshot storage abstraction. This is the only seam between the application and
 * durable storage: `withDatabase` (lib/db/controller.ts) is the only caller.
 *
 * An "etag" is an opaque version marker. Writes are conditional: passing the etag a
 * reader observed makes the write fail if another writer landed first, which is what
 * turns a whole-database snapshot into a safe optimistic-concurrency store.
 */

export class SnapshotPreconditionError extends Error {
  constructor(message = 'Snapshot was modified by another writer') {
    super(message);
    this.name = 'SnapshotPreconditionError';
  }
}

export interface Snapshot {
  etag: string;
  data: Uint8Array;
}

export interface SnapshotStore {
  readonly kind: string;
  /** Current etag, or null when no snapshot exists yet. Cheap metadata read. */
  stat(): Promise<string | null>;
  /** Full snapshot body plus its etag, or null when absent. */
  read(): Promise<Snapshot | null>;
  /**
   * Writes the snapshot. `ifMatch: null` means "only if absent"; a string means
   * "only if the current etag still equals this". Throws SnapshotPreconditionError
   * when the condition fails. Returns the new etag.
   */
  write(data: Uint8Array, options: { ifMatch: string | null }): Promise<string>;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Local development store: a snapshot file on disk.
 *
 * It deliberately uses the same dump/load path as the production Blob store so local
 * development exercises the real concurrency and size behaviour. A real on-disk
 * PGlite datadir would hide snapshot bugs until deploy time.
 */
export class FileSnapshotStore implements SnapshotStore {
  readonly kind = 'file';

  constructor(private readonly filePath: string) {}

  private async currentEtag(): Promise<string | null> {
    try {
      const data = await readFile(this.filePath);
      return sha256Hex(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async stat(): Promise<string | null> {
    return this.currentEtag();
  }

  async read(): Promise<Snapshot | null> {
    try {
      const data = await readFile(this.filePath);
      return { etag: sha256Hex(data), data: new Uint8Array(data) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(data: Uint8Array, options: { ifMatch: string | null }): Promise<string> {
    const current = await this.currentEtag();
    if (options.ifMatch === null && current !== null) {
      throw new SnapshotPreconditionError();
    }
    if (options.ifMatch !== null && current !== options.ifMatch) {
      throw new SnapshotPreconditionError();
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, data);
    await rename(temp, this.filePath);
    return sha256Hex(data);
  }
}

/**
 * In-memory store used by tests (and by the spike) to reproduce Blob semantics —
 * including conditional-write failure — with no network.
 */
export class MemorySnapshotStore implements SnapshotStore {
  readonly kind = 'memory';
  private data: Uint8Array | null = null;
  private version = 0;
  stats = { stat: 0, read: 0, write: 0 };

  async stat(): Promise<string | null> {
    this.stats.stat += 1;
    return this.data === null ? null : this.etagOf();
  }

  async read(): Promise<Snapshot | null> {
    this.stats.read += 1;
    if (this.data === null) return null;
    return { etag: this.etagOf(), data: new Uint8Array(this.data) };
  }

  async write(data: Uint8Array, options: { ifMatch: string | null }): Promise<string> {
    this.stats.write += 1;
    const current = this.data === null ? null : this.etagOf();
    if (options.ifMatch === null && current !== null) {
      throw new SnapshotPreconditionError();
    }
    if (options.ifMatch !== null && current !== options.ifMatch) {
      throw new SnapshotPreconditionError();
    }
    this.data = new Uint8Array(data);
    this.version += 1;
    return this.etagOf();
  }

  private etagOf(): string {
    return `v${this.version}-${sha256Hex(this.data ?? new Uint8Array())}`;
  }
}

/**
 * Production store: one private object in Vercel Blob.
 *
 * `access: 'private'` matters — a public blob URL would expose the entire database
 * to anyone holding the link.
 */
export class BlobSnapshotStore implements SnapshotStore {
  readonly kind = 'blob';

  constructor(
    private readonly pathname: string,
    private readonly token: string,
  ) {}

  private async sdk() {
    // Imported lazily so local `file` mode never loads the Blob SDK.
    return import('@vercel/blob');
  }

  async stat(): Promise<string | null> {
    const { head, BlobNotFoundError } = await this.sdk();
    try {
      const meta = await head(this.pathname, { token: this.token });
      return meta.etag;
    } catch (error) {
      if (
        error instanceof BlobNotFoundError ||
        (error as { name?: string }).name === 'BlobNotFoundError'
      ) {
        return null;
      }
      throw error;
    }
  }

  async read(): Promise<Snapshot | null> {
    const { get, BlobNotFoundError } = await this.sdk();
    try {
      const result = await get(this.pathname, {
        access: 'private',
        token: this.token,
        useCache: false,
      });
      if (!result || result.statusCode === 304 || !result.stream) {
        return null;
      }
      const buffer = await new Response(result.stream).arrayBuffer();
      return { etag: result.blob.etag, data: new Uint8Array(buffer) };
    } catch (error) {
      if (
        error instanceof BlobNotFoundError ||
        (error as { name?: string }).name === 'BlobNotFoundError'
      ) {
        return null;
      }
      throw error;
    }
  }

  async write(data: Uint8Array, options: { ifMatch: string | null }): Promise<string> {
    const { put, BlobPreconditionFailedError } = await this.sdk();
    try {
      const result = await put(this.pathname, Buffer.from(data), {
        access: 'private',
        token: this.token,
        addRandomSuffix: false,
        contentType: 'application/gzip',
        cacheControlMaxAge: 60,
        ...(options.ifMatch
          ? { ifMatch: options.ifMatch }
          : { allowOverwrite: false }),
      });
      return result.etag;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) {
        throw new SnapshotPreconditionError();
      }
      // A concurrent first-write with allowOverwrite:false surfaces as a conflict
      // rather than a precondition error on some API versions.
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (message.includes('already exists') || message.includes('precondition')) {
        throw new SnapshotPreconditionError();
      }
      throw error;
    }
  }
}
