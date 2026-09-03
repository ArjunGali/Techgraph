import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { badRequest } from './errors.js';

/**
 * File storage for payment proofs and identity documents.
 *
 * Files are written under STORAGE_DIR with generated names and are never
 * served statically. Every read goes through an authorised, audited endpoint,
 * so a leaked filename is not by itself enough to retrieve an Aadhaar scan.
 */
const root = resolve(env.STORAGE_DIR);

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);

export function assertAllowedMime(mimeType: string): void {
  if (!ALLOWED_MIME.has(mimeType)) {
    throw badRequest(
      `Unsupported file type "${mimeType}". Upload a JPEG, PNG, WebP, HEIC or PDF.`,
    );
  }
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/heic':
      return '.heic';
    case 'application/pdf':
      return '.pdf';
    default:
      return '.bin';
  }
}

/**
 * Resolves a stored key to an absolute path, refusing anything that escapes
 * the storage root. Keys come from the database, but a traversal bug anywhere
 * upstream must not turn into arbitrary file access.
 */
export function resolveStorageKey(key: string): string {
  const target = resolve(root, normalize(key));
  if (target !== root && !target.startsWith(root + sep)) {
    throw badRequest('Invalid storage key');
  }
  return target;
}

export type StoredFile = {
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

/** Writes a buffer into a namespaced folder and returns its storage key. */
export async function storeFile(
  folder: string,
  file: { originalname: string; mimetype: string; buffer: Buffer; size: number },
): Promise<StoredFile> {
  assertAllowedMime(file.mimetype);
  if (file.size > env.MAX_UPLOAD_BYTES) {
    throw badRequest(`File is larger than the ${env.MAX_UPLOAD_BYTES} byte limit`);
  }

  const storageKey = join(folder, `${randomUUID()}${extensionFor(file.mimetype)}`);
  const target = resolveStorageKey(storageKey);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.buffer, { mode: 0o600 });

  return {
    storageKey,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
  };
}

export function readFileStream(storageKey: string): NodeJS.ReadableStream {
  return createReadStream(resolveStorageKey(storageKey));
}

export async function deleteFile(storageKey: string): Promise<void> {
  await unlink(resolveStorageKey(storageKey)).catch(() => undefined);
}

/**
 * Masks an identity number for display, keeping only the last four digits:
 * `123456789012` becomes `XXXX XXXX 9012`. The full number is never stored in
 * a column that ordinary listings read.
 */
export function maskIdentifier(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return 'XXXX';
  const groups = Math.ceil((digits.length - 4) / 4);
  return `${'XXXX '.repeat(groups).trim()} ${digits.slice(-4)}`;
}
