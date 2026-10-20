const SECRET_KEYS = new Set([
  'currentsessiontoken', 'currenttabid', 'sessionid', 'sessiontoken', 'tokenhash',
  'accesstoken', 'refreshtoken', 'servicerolekey', 'anonkey', 'password', 'passwordhash',
  'token', 'authorization', 'apikey', 'clientsecret', 'secret',
]);

export function assertTransferDeviceInfo(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('Device information exceeds the supported depth.');
  if (Array.isArray(value)) {
    for (const child of value) assertTransferDeviceInfo(child, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.replace(/[A-Z]/g, char => char.toLowerCase()).replace(/[_/:-]/g, ''))) {
        throw new Error('Device information contains a structured secret and cannot be transferred.');
      }
      assertTransferDeviceInfo(child, depth + 1);
    }
  }
}
