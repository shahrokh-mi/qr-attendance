import { rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Starts every run from an empty snapshot so the first request seeds exactly one
 * administrator — the same state a fresh deployment sees.
 */
export default async function globalSetup(): Promise<void> {
  const dataDir = path.resolve(process.cwd(), 'data', 'e2e');
  await rm(dataDir, { recursive: true, force: true });
}
