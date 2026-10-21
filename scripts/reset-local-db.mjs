#!/usr/bin/env node
/**
 * Deletes the local snapshot so the next request initialises a fresh database and
 * re-seeds the bootstrap administrator.
 *
 * Local development only: production state lives in Vercel Blob and is never touched by
 * this script.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve(process.cwd(), 'data');

if (process.env.STORAGE_MODE === 'blob') {
  console.error('Refusing to reset: STORAGE_MODE=blob. This script only touches ./data.');
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
console.log(`Removed ${target}. The next request will create a fresh snapshot.`);
