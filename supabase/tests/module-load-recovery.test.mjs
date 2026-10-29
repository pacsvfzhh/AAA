import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../../src/lib/moduleLoadRecovery.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  define: { 'import.meta.url': '__BUILD_URL' },
  logLevel: 'silent',
});

function loadRecovery({ storage = new Map(), buildUrl = '/assets/index-build-a.js', online = true, storageFailure = null } = {}) {
  let reloads = 0;
  const module = { exports: {} };
  const navigator = { onLine: online };
  runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    __BUILD_URL: buildUrl,
    navigator,
    window: {
      sessionStorage: {
        getItem(key) {
          if (storageFailure === 'read') throw new Error('Storage blocked');
          return storage.get(key) ?? null;
        },
        setItem(key, value) {
          if (storageFailure === 'write') throw new Error('Storage quota exceeded');
          storage.set(key, value);
        },
      },
      location: { reload() { reloads++; } },
    },
  });
  return { ...module.exports, storage, navigator, reloads: () => reloads };
}

const chunkError = () => new TypeError('Failed to fetch dynamically imported module: /assets/DispatchManagement-old.js');

for (const message of [
  'Failed to fetch dynamically imported module: /assets/page.js',
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module: /assets/page.js',
  'Importing a module script failed.',
  'Unable to preload CSS for /assets/page.css',
]) {
  test(`recognizes module-loading failure: ${message}`, () => {
    assert.equal(loadRecovery().isModuleLoadError(new TypeError(message)), true);
  });
}

for (const error of [null, undefined, 'Failed to fetch', {}, { message: 1 }, new TypeError('Failed to fetch'), new Error('Session expired'), new Error('Cannot read properties of undefined'), new Error('Application failed to fetch dynamically imported module metadata')]) {
  test(`does not reload for unrelated errors: ${String(error?.message ?? error)}`, () => {
    const recovery = loadRecovery();
    assert.equal(recovery.isModuleLoadError(error), false);
    assert.equal(recovery.recoverFromModuleLoadError(error), false);
    assert.equal(recovery.reloads(), 0);
    assert.equal(recovery.storage.size, 0);
  });
}

test('reloads once without changing authentication or other stored data', () => {
  const auth = JSON.stringify({ userType: 'admin', adminSessionToken: 'isolated-fixture' });
  const recovery = loadRecovery({ storage: new Map([['work_platform_auth', auth], ['other-key', 'keep']]) });
  assert.equal(recovery.recoverFromModuleLoadError(chunkError()), true);
  assert.equal(recovery.recoverFromModuleLoadError(chunkError()), false);
  assert.equal(recovery.reloads(), 1);
  assert.equal(recovery.storage.get('work_platform_auth'), auth);
  assert.equal(recovery.storage.get('other-key'), 'keep');
});

test('a fresh page on the same build cannot enter an automatic reload loop', () => {
  const storage = new Map();
  const firstPage = loadRecovery({ storage });
  assert.equal(firstPage.recoverFromModuleLoadError(chunkError()), true);
  for (let i = 0; i < 5; i++) {
    const reloadedPage = loadRecovery({ storage });
    assert.equal(reloadedPage.recoverFromModuleLoadError(chunkError()), false);
    assert.equal(reloadedPage.reloads(), 0);
  }
});

test('a later deployment has its own single recovery attempt', () => {
  const storage = new Map();
  assert.equal(loadRecovery({ storage }).recoverFromModuleLoadError(chunkError()), true);
  const nextDeployment = loadRecovery({ storage, buildUrl: '/assets/index-build-b.js' });
  assert.equal(nextDeployment.recoverFromModuleLoadError(chunkError()), true);
  assert.equal(loadRecovery({ storage, buildUrl: '/assets/index-build-b.js' }).recoverFromModuleLoadError(chunkError()), false);
});

test('offline errors preserve the page and do not consume the recovery attempt', () => {
  const recovery = loadRecovery({ online: false });
  assert.equal(recovery.recoverFromModuleLoadError(chunkError()), false);
  assert.equal(recovery.storage.size, 0);
  assert.equal(recovery.reloads(), 0);
  recovery.navigator.onLine = true;
  assert.equal(recovery.recoverFromModuleLoadError(chunkError()), true);
});

for (const storageFailure of ['read', 'write']) {
  test(`blocked storage (${storageFailure}) falls back to manual refresh instead of looping`, () => {
    const recovery = loadRecovery({ storageFailure });
    assert.equal(recovery.recoverFromModuleLoadError(chunkError()), false);
    assert.equal(recovery.recoverFromModuleLoadError(chunkError()), false);
    assert.equal(recovery.reloads(), 0);
  });
}
