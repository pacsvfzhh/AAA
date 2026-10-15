import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

let worker: Worker | null = null;
let workerFailed = false;

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./bcryptWorker.ts', import.meta.url), { type: 'module' });
    worker.onerror = () => {
      workerFailed = true;
      worker = null;
    };
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

function runInWorker<T>(type: 'hash' | 'verify', payload: unknown): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('worker unavailable'));
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      w.removeEventListener('message', handler);
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    w.addEventListener('message', handler);
    w.postMessage({ type, payload });
  });
}

export async function hashPassword(password: string): Promise<string> {
  try {
    return await runInWorker<string>('hash', { password });
  } catch {
    return bcrypt.hash(password, SALT_ROUNDS);
  }
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await runInWorker<boolean>('verify', { password, hash });
  } catch {
    return bcrypt.compare(password, hash);
  }
}
