import type { ArchiveBundleWorkspace, ArchiveBundleWorkspaceFactory } from './archiveBundle';
import type { ReplacementBackupFile } from './replacementBackup';
import type { TransferByteSource } from './crypto';
import { MAX_CONTAINER_INPUT_BYTES } from './container';

export interface BrowserTransferDirectory {
  createFile(name: string): ReplacementBackupFile;
  writeText(name: string, text: string, signal?: AbortSignal): Promise<void>;
  name: string;
}

interface DiskWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface DiskFile {
  getFile(): Promise<Blob>;
  createWritable(options: { keepExistingData: false; mode: 'exclusive' }): Promise<DiskWriter>;
}
interface DiskDirectory {
  name: string;
  getDirectoryHandle(name: string, options?: { create: boolean }): Promise<DiskDirectory>;
  getFileHandle(name: string, options?: { create: boolean }): Promise<DiskFile>;
  removeEntry(name: string, options: { recursive: true }): Promise<void>;
}
interface PickerWindow {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<DiskDirectory>;
}
interface BrowserStorage {
  getDirectory?: () => Promise<DiskDirectory>;
}

const encoder = new TextEncoder();
const reservedDirectories = new Set<string>();
const CLEANUP_TIMEOUT_MS = 1000;
const cancelled = () => new DOMException('Browser transfer storage cancelled.', 'AbortError');
const cleanupError = () => new Error('Temporary plaintext cleanup could not be confirmed. Do not reuse this workspace.');
const isMissing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';

function safeName(name: string): string {
  if (typeof name !== 'string' || !name || name.length > 255 || name !== name.normalize('NFC')
    || encoder.encode(name).length > 255 || name.includes('..') || name.endsWith('.')
    || !/^[\p{L}\p{N}_-][\p{L}\p{M}\p{N}._-]*$/u.test(name)
    || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error('Unsafe transfer filename.');
  }
  return name;
}
function safePath(path: string): string[] {
  if (typeof path !== 'string' || path.length > 1024 || encoder.encode(path).length > 1024) throw new Error('Unsafe transfer path.');
  const parts = path.split('/');
  if (parts.length > 32) throw new Error('Unsafe transfer path.');
  return parts.map(safeName);
}
function randomName(prefix: string): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('Secure random UUID support is required for browser transfer storage.');
  }
  const name = safeName(`${prefix}-${crypto.randomUUID()}`);
  if (reservedDirectories.has(name)) throw new Error('Duplicate transfer directory UUID.');
  reservedDirectories.add(name);
  return name;
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
function wait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function ignore(operation: () => unknown): void {
  try { void Promise.resolve(operation()).catch(() => undefined); } catch { /* A blocked producer must not delay cancellation. */ }
}
async function absent(directory: DiskDirectory, name: string, kind: 'file' | 'directory'): Promise<void> {
  try {
    if (kind === 'file') await directory.getFileHandle(name);
    else await directory.getDirectoryHandle(name);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error('Transfer storage entry already exists; refusing to overwrite it.');
}
function readFile(handle: () => Promise<DiskFile>, signal?: AbortSignal): TransferByteSource {
  return {
    async *[Symbol.asyncIterator]() {
      check(signal);
      const file = await wait((await wait(handle(), signal)).getFile(), signal);
      check(signal);
      for (let offset = 0; offset < file.size; offset += MAX_CONTAINER_INPUT_BYTES) {
        const bytes = new Uint8Array(await wait(file.slice(offset, offset + MAX_CONTAINER_INPUT_BYTES).arrayBuffer(), signal));
        check(signal);
        yield bytes;
      }
      check(signal);
    },
  };
}

function outputFile(directory: DiskDirectory, name: string): ReplacementBackupFile {
  let attempted = false, saved = false;
  return {
    async write(source, signal) {
      if (attempted) throw new Error('Transfer output files can only be written once.');
      attempted = true;
      let writer: DiskWriter | undefined, iterator: AsyncIterator<Uint8Array> | undefined, ended = false, stopped = false;
      const stop = () => {
        if (writer && !stopped) { stopped = true; ignore(() => writer!.abort(cancelled())); }
      };
      signal?.addEventListener('abort', stop, { once: true });
      try {
        check(signal);
        if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw new Error('Invalid transfer byte source.');
        await wait(absent(directory, name, 'file'), signal);
        check(signal);
        const handle = await wait(directory.getFileHandle(name, { create: true }), signal);
        check(signal);
        const opening = handle.createWritable({ keepExistingData: false, mode: 'exclusive' }).then(value => {
          writer = value;
          if (signal?.aborted) stop();
          return value;
        });
        await wait(opening, signal);
        check(signal);
        iterator = source[Symbol.asyncIterator]();
        while (true) {
          const next = await wait(Promise.resolve(iterator.next()), signal);
          check(signal);
          if (next.done) { ended = true; break; }
          if (!(next.value instanceof Uint8Array) || next.value.length > MAX_CONTAINER_INPUT_BYTES) {
            throw new Error('Transfer chunks must be Uint8Array values no larger than 1 MiB.');
          }
          await wait(writer!.write(new Uint8Array(next.value)), signal);
          check(signal);
        }
        await wait(writer!.close(), signal);
        check(signal);
        saved = true;
      } catch (error) {
        stop();
        throw error;
      } finally {
        signal?.removeEventListener('abort', stop);
        if (!ended && iterator) ignore(() => iterator!.return?.());
      }
    },
    open() {
      if (!saved) throw new Error('Transfer output has not been successfully saved.');
      return readFile(() => directory.getFileHandle(name));
    },
  };
}

export async function pickTransferDirectory(): Promise<BrowserTransferDirectory> {
  const browser = typeof window === 'undefined' ? undefined : window as unknown as PickerWindow;
  if (!browser?.showDirectoryPicker) throw new Error('This browser does not support choosing a transfer directory.');
  if (typeof navigator !== 'undefined' && navigator.userActivation?.isActive === false) {
    throw new Error('Choose the transfer directory directly from a user gesture.');
  }
  const selected = await browser.showDirectoryPicker({ mode: 'readwrite' });
  const name = randomName(`migration-${new Date().toISOString().slice(0, 10)}`);
  await absent(selected, name, 'directory');
  const directory = await selected.getDirectoryHandle(name, { create: true });
  const names = new Set<string>();
  const createFile = (filename: string): ReplacementBackupFile => {
    safeName(filename);
    const key = filename.toLowerCase();
    if (names.has(key)) throw new Error('Duplicate transfer output filename.');
    names.add(key);
    return outputFile(directory, filename);
  };
  return {
    name,
    createFile,
    async writeText(filename, text, signal) {
      const file = createFile(filename);
      if (typeof text !== 'string') throw new Error('Transfer text must be a string.');
      await file.write((async function* () {
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(offset + Math.floor(MAX_CONTAINER_INPUT_BYTES / 4), text.length);
          if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
          yield encoder.encode(text.slice(offset, end));
          offset = end;
        }
      })(), signal);
    },
  };
}

interface WorkspaceFile {
  frozen: boolean;
  busy: boolean;
  tail: Promise<void>;
  handle?: DiskFile;
  writer?: DiskWriter;
  sealed?: Promise<void>;
}

function workspace(root: DiskDirectory, name: string): ArchiveBundleWorkspace {
  const controller = new AbortController();
  const files = new Map<string, WorkspaceFile>();
  const directories = new Map<string, Promise<DiskDirectory>>();
  const claims = new Map<string, string>();
  const pending = new Set<Promise<unknown>>();
  const writers = new Set<DiskWriter>();
  const stopping = new Map<DiskWriter, Promise<void>>();
  let owned = false, cleanup: Promise<void> | undefined;
  const alive = () => check(controller.signal);
  const remove = async () => {
    if (!owned) return;
    try { await root.removeEntry(name, { recursive: true }); }
    catch (error) { if (!isMissing(error)) throw error; }
  };
  const stop = (writer: DiskWriter): Promise<void> => {
    let operation = stopping.get(writer);
    if (!operation) {
      operation = Promise.resolve().then(() => writer.abort(cancelled()));
      stopping.set(writer, operation);
      void operation.catch(() => undefined);
    }
    return operation;
  };
  const mutate = <T>(operation: () => Promise<T>, accept?: (value: T) => void): Promise<T> => {
    alive();
    const task = Promise.resolve().then(() => { alive(); return operation(); }).then(value => {
      accept?.(value);
      alive();
      return value;
    });
    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
      if (controller.signal.aborted) ignore(remove);
    }).catch(() => undefined);
    return task;
  };
  const directory = (parts: string[]): Promise<DiskDirectory> => {
    const key = parts.join('/');
    let result = directories.get(key);
    if (!result) {
      result = parts.length === 0
        ? (async () => {
          await absent(root, name, 'directory');
          alive();
          return mutate(() => { owned = true; return root.getDirectoryHandle(name, { create: true }); });
        })()
        : directory(parts.slice(0, -1)).then(parent => mutate(() => parent.getDirectoryHandle(parts[parts.length - 1], { create: true })));
      directories.set(key, result);
      void result.catch(() => undefined);
    }
    return result;
  };
  const claim = (parts: string[]): void => {
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/'), key = path.toLowerCase();
      const value = `${i === parts.length ? 'file' : 'directory'}:${path}`;
      if (claims.has(key) && claims.get(key) !== value) throw new Error('Conflicting transfer workspace paths.');
    }
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/');
      claims.set(path.toLowerCase(), `${i === parts.length ? 'file' : 'directory'}:${path}`);
    }
  };
  const abort = (): Promise<void> => {
    if (cleanup) return cleanup;
    controller.abort();
    cleanup = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const tasks = [...writers].map(stop);
        tasks.push(remove());
        const results = await Promise.race([
          Promise.allSettled(tasks),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(cleanupError()), CLEANUP_TIMEOUT_MS); }),
        ]);
        if (pending.size || results.some(result => result.status === 'rejected')) throw cleanupError();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return cleanup;
  };
  return {
    append(path, bytes, signal) {
      const cancel = () => ignore(abort);
      if (signal?.aborted) { cancel(); return Promise.reject(cancelled()); }
      try {
        alive();
        const parts = safePath(path);
        if (!(bytes instanceof Uint8Array) || bytes.length > MAX_CONTAINER_INPUT_BYTES) throw new Error('Invalid transfer workspace chunk.');
        claim(parts);
        let file = files.get(path);
        if (!file) {
          file = { frozen: false, busy: false, tail: Promise.resolve() };
          files.set(path, file);
        }
        if (file.frozen || file.busy) throw new Error('Transfer workspace path is frozen or has an append in progress.');
        file.busy = true;
        const state = file, input = new Uint8Array(bytes);
        signal?.addEventListener('abort', cancel, { once: true });
        state.tail = state.tail.then(async () => {
          alive();
          if (!state.writer) {
            const parent = await directory(parts.slice(0, -1));
            alive();
            await absent(parent, parts[parts.length - 1], 'file');
            state.handle = await mutate(() => parent.getFileHandle(parts[parts.length - 1], { create: true }));
            state.writer = await mutate(() => state.handle!.createWritable({ keepExistingData: false, mode: 'exclusive' }), writer => {
              writers.add(writer);
              if (controller.signal.aborted) ignore(() => stop(writer));
            });
          }
          await mutate(() => state.writer!.write(input));
        });
        void state.tail.finally(() => { state.busy = false; }).catch(() => undefined);
        return wait(state.tail, controller.signal).finally(() => signal?.removeEventListener('abort', cancel));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    open(path) {
      alive();
      safePath(path);
      const file = files.get(path);
      if (!file) throw new Error('Transfer workspace file does not exist.');
      file.frozen = true;
      file.sealed ??= file.tail.then(async () => {
        alive();
        await mutate(() => file.writer!.close());
        writers.delete(file.writer!);
        file.writer = undefined;
      });
      void file.sealed.catch(() => undefined);
      return readFile(async () => {
        await wait(file.sealed!, controller.signal);
        alive();
        return file.handle!;
      }, controller.signal);
    },
    abort,
  };
}

export async function createBrowserWorkspaceFactory(): Promise<ArchiveBundleWorkspaceFactory> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage as unknown as BrowserStorage | undefined;
  if (!storage?.getDirectory) throw new Error('This browser does not support OPFS transfer workspaces.');
  const root = await storage.getDirectory();
  return () => workspace(root, randomName('migration-plaintext'));
}
