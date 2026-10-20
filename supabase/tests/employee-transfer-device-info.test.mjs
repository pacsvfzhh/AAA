import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const built = await build({ stdin: { contents: `export {assertTransferDeviceInfo} from './src/lib/employeeTransfer/deviceInfo';export {validateActivityRow} from './src/lib/employeeTransfer/activityTransfer';`,
  resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, platform: 'browser', format: 'esm' });
const { assertTransferDeviceInfo, validateActivityRow } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const SECRET = 'LOCAL-SESSION-CANARY-NEVER-EXPORT';
const row = device => JSON.stringify({ id: '43000000-0000-4000-8000-000000000001', user_id: '43000000-0000-4000-8000-000000000002',
  username: 'local-user', employee_id: 'E-local', action_type: 'login', ip_address: null, user_agent: null,
  session_id: 'history-' + 'a'.repeat(64), created_at: '2024-02-29T03:04:05.123456Z', device_info: device, device_info_is_sql_null: false }) + '\n';
const keys = ['current_session_token', 'current_tab_id', 'session_id', 'session_token', 'token_hash', 'access_token', 'refresh_token',
  'service_role_key', 'anon_key', 'password', 'password_hash', 'token', 'authorization', 'api_key', 'client_secret', 'secret'];
for (const key of keys) test(`activity export/import validation refuses nested secret key ${key} without exposing its value`, () => {
  for (const spelling of [key, key.toUpperCase(), key.replaceAll('_', '-'), key.replaceAll('_', '/')]) {
    const value = { browsers: [{ metadata: { [spelling]: SECRET } }] };
    assert.throws(() => assertTransferDeviceInfo(value), error => !error.message.includes(SECRET));
    assert.throws(() => validateActivityRow(row(value), 'employee_login_history'), error => !error.message.includes(SECRET));
  }
});
test('ordinary device data and historical timestamps are accepted and not rewritten', () => {
  const device = { browser: 'Chromium', session_created_at: '2024-02-29T03:04:05Z', token_count: 1,
    password_policy: 'historical', notes: 'current_session_token is just prose here', agents: [null, false, 42] };
  const original = row(device);
  assertTransferDeviceInfo(device);
  assert.equal(validateActivityRow(original, 'employee_login_history'), '43000000-0000-4000-8000-000000000001');
  assert.equal(row(device), original);
  assertTransferDeviceInfo(null);
});
test('shared device guard preserves the previously reviewed 64-level boundary', () => {
  const nested = depth => { let value = 'leaf'; while (depth--) value = { child: value }; return value; };
  assert.doesNotThrow(() => assertTransferDeviceInfo(nested(64)));
  assert.throws(() => assertTransferDeviceInfo(nested(65)), /supported depth/);
});
test('escaped secret keys and array nesting cannot bypass activity row validation', () => {
  const original = row({ device: { access_token: SECRET } }).replace('access_token', 'access_\\u0074oken');
  assert.throws(() => validateActivityRow(original, 'employee_login_history'));
});
