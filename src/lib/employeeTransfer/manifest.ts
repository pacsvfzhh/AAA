import type { TransferMetadata } from './crypto';

export const MANIFEST_PATH = 'manifest.json';
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_VOLUME_ENTRIES = 4096;
export const MAX_VOLUME_COUNT = 4096;
export const MAX_ENTRY_PATH_BYTES = 512;
export const MEDIA_BUCKETS = [
  'announcement-images', 'chat-images', 'template-images', 'super-customer-avatars',
  'website-icons', 'verification-documents', 'content-audit-evidence',
] as const;

export type TransferScope = 'full-site' | 'replacement-backup';
export type EntryKind = 'ndjson' | 'media';
export interface VolumeInfo extends TransferMetadata {
  sourceSiteId: string;
  createdAt: string;
  scope: TransferScope;
  volumeIndex: number;
  volumeCount: number;
}
export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
  kind: EntryKind;
}
export interface VolumeManifest extends VolumeInfo {
  version: 1;
  entries: ManifestEntry[];
}

const infoKeys = ['exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'scope', 'volumeIndex', 'volumeCount'];
const encoder = new TextEncoder();

function invalid(): never {
  throw new Error('Invalid transfer manifest.');
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const record = value as Record<string, unknown>;
  const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))
    || actual.some(key => !Object.getOwnPropertyDescriptor(record, key)?.enumerable
      || !('value' in Object.getOwnPropertyDescriptor(record, key)!))) invalid();
  return record;
}

export function validateTransferMetadata(value: unknown): TransferMetadata {
  const record = object(value, ['exportId', 'volumeId']);
  const id = (v: unknown): v is string => typeof v === 'string' && v.length <= 256
    && encoder.encode(v).length <= 256 && /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._:-]*$/u.test(v);
  if (!id(record.exportId) || !id(record.volumeId)) invalid();
  return { exportId: record.exportId, volumeId: record.volumeId };
}

export function validateVolumeInfo(value: unknown): VolumeInfo {
  const record = object(value, infoKeys);
  const metadata = validateTransferMetadata({ exportId: record.exportId, volumeId: record.volumeId });
  if (typeof record.sourceSiteId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.sourceSiteId)
    || typeof record.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.createdAt)
    || !Number.isFinite(Date.parse(record.createdAt)) || new Date(record.createdAt).toISOString() !== record.createdAt
    || (record.scope !== 'full-site' && record.scope !== 'replacement-backup')
    || !Number.isInteger(record.volumeCount) || (record.volumeCount as number) < 1
    || (record.volumeCount as number) > MAX_VOLUME_COUNT || !Number.isInteger(record.volumeIndex)
    || (record.volumeIndex as number) < 1 || (record.volumeIndex as number) > (record.volumeCount as number)) invalid();
  return {
    ...metadata, sourceSiteId: record.sourceSiteId, createdAt: record.createdAt, scope: record.scope,
    volumeIndex: record.volumeIndex as number, volumeCount: record.volumeCount as number,
  };
}

// Intentionally portable ASCII paths: no decoding, normalizing, case folding or filesystem aliases on import.
export function validateEntryPath(value: unknown): EntryKind {
  if (typeof value !== 'string' || value.length > MAX_ENTRY_PATH_BYTES) invalid();
  const segments = value.split('/');
  const safe = (segment: string) => segment.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) && !segment.endsWith('.')
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment);
  if (!segments.every(safe)) invalid();
  if (segments.length === 2 && segments[0] === 'data' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.ndjson$/.test(segments[1])) return 'ndjson';
  if (segments.length >= 3 && segments[0] === 'media'
    && MEDIA_BUCKETS.some(bucket => bucket === segments[1])) return 'media';
  return invalid();
}

// Also reject case aliases and file/directory collisions for portable temporary sinks.
export function claimEntryPath(path: string, paths: Set<string>): EntryKind {
  const kind = validateEntryPath(path);
  const canonical = path.toLowerCase();
  if (paths.has(canonical) || [...paths].some(existing => existing.startsWith(canonical + '/')
    || canonical.startsWith(existing + '/'))) invalid();
  paths.add(canonical);
  return kind;
}

export function validateManifest(value: unknown): VolumeManifest {
  const record = object(value, [...infoKeys, 'version', 'entries']);
  const info = validateVolumeInfo(Object.fromEntries(infoKeys.map(key => [key, record[key]])));
  if (record.version !== 1 || !Array.isArray(record.entries) || record.entries.length > MAX_VOLUME_ENTRIES) invalid();
  const paths = new Set<string>();
  const entries = Array.from(record.entries, value => {
    const entry = object(value, ['path', 'bytes', 'sha256', 'kind']);
    const kind = claimEntryPath(entry.path as string, paths);
    if (entry.kind !== kind || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0
      || (entry.bytes as number) >= 0xffffffff || typeof entry.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(entry.sha256)) invalid();
    return { path: entry.path as string, bytes: entry.bytes as number, sha256: entry.sha256, kind };
  });
  return { version: 1, ...info, entries };
}

export function serializeManifest(value: VolumeManifest): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(validateManifest(value)));
  if (bytes.length > MAX_MANIFEST_BYTES) invalid();
  return bytes;
}

// Canonical serialization is part of v1. Re-encoding comparison rejects duplicate JSON keys,
// alternate number/escape spellings, unknown keys and ambiguous parser interpretations.
export function parseManifest(bytes: Uint8Array): VolumeManifest {
  if (bytes.length > MAX_MANIFEST_BYTES) invalid();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return invalid();
  }
  const manifest = validateManifest(value);
  const canonical = serializeManifest(manifest);
  if (canonical.length !== bytes.length || !canonical.every((byte, index) => byte === bytes[index])) invalid();
  return manifest;
}

// All indices 1..volumeCount are required; no optional volume descriptors in v1.
export function validateVolumeSet(values: readonly VolumeManifest[]): VolumeManifest[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_VOLUME_COUNT) invalid();
  const manifests = values.map(validateManifest);
  const first = manifests[0];
  if (manifests.length !== first.volumeCount) invalid();
  const indices = new Set<number>();
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.exportId !== first.exportId || manifest.sourceSiteId !== first.sourceSiteId
      || manifest.scope !== first.scope || manifest.createdAt !== first.createdAt
      || manifest.volumeCount !== first.volumeCount || indices.has(manifest.volumeIndex)
      || ids.has(manifest.volumeId)) invalid();
    indices.add(manifest.volumeIndex);
    ids.add(manifest.volumeId);
    for (const entry of manifest.entries) claimEntryPath(entry.path, paths);
  }
  return manifests.sort((a, b) => a.volumeIndex - b.volumeIndex);
}
