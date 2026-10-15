import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

self.onmessage = async (e: MessageEvent<{ type: 'hash' | 'verify'; payload: unknown }>) => {
  const { type, payload } = e.data;
  try {
    if (type === 'hash') {
      const { password } = payload as { password: string };
      const result = await bcrypt.hash(password, SALT_ROUNDS);
      self.postMessage({ ok: true, result });
    } else if (type === 'verify') {
      const { password, hash } = payload as { password: string; hash: string };
      const result = await bcrypt.compare(password, hash);
      self.postMessage({ ok: true, result });
    }
  } catch (err) {
    self.postMessage({ ok: false, error: (err as Error).message });
  }
};
