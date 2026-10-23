import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

// Real browser CORS and HTTP; RPC/Storage are explicit local doubles, not hosted acceptance.
const driver = process.env.EMPLOYEE_TRANSFER_CORS_PLAYWRIGHT;
const required = process.env.EMPLOYEE_TRANSFER_CORS_REQUIRED === '1';
const engines = ['chromium', 'webkit'];
const ADMIN = 'cc000000-0000-4000-8000-000000000001';
const JOB = 'cc000000-0000-4000-8000-000000000002';
const USER = 'cc000000-0000-4000-8000-000000000003';
const ORIGIN = 'https://cors-fixture.supabase.co';
const PATH = `id-front/${USER}-synthetic.jpg`;
const SOURCE = `${ORIGIN}/storage/v1/object/public/verification-documents/${PATH}`;
const KEY = createHash('sha256').update(SOURCE).digest('hex');
const BYTES = Uint8Array.of(255, 216, 255, 224, 0, 3, 9, 255, 217);
const SHA = createHash('sha256').update(BYTES).digest('hex');
const FILE = { key: KEY, source_url: SOURCE, bytes: BYTES.length, sha256: SHA, content_type: 'image/jpeg' };
const SCOPES = ['verification', 'mapped-verification', 'notifications', 'chat', 'archives', 'employee-safety'];
const compiled = await build({ entryPoints: [new URL('../functions/employee-transfer-media/handler.ts', import.meta.url).pathname],
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020' });
const { createEmployeeTransferMediaHandler } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const local = async server => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async server => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };

if (required) test('browser CORS acceptance requires explicit local browser tooling', () => assert.ok(driver && isAbsolute(driver)));
for (const engine of engines) {
  test(`${engine}: real cross-origin media preflight and integrity headers`, {
    skip: !driver ? 'Local browser tooling not configured; not browser or hosted acceptance' : false, timeout: 90_000,
  }, async t => {
    assert.ok(isAbsolute(driver));
    const playwright = await import(pathToFileURL(driver).href);
    const requests = [], calls = [], storage = [], errors = [], external = [];
    let mode = 'deny';
    const handler = createEmployeeTransferMediaHandler({ supabaseUrl: ORIGIN, crypto: webcrypto,
      rpc: async (name, args) => {
        calls.push({ name, args });
        assert.equal(args.p_admin_session_token, ADMIN); assert.equal(args.p_job_token, JOB);
        if (mode === 'deny') return { error: { message: 'private fixture error must not escape' } };
        if (name === 'employee_transfer_verification_media_authorize') {
          return { data: { direction: mode === 'upload' ? 'import' : 'export', key: KEY, bucket: 'verification-documents',
            path: mode === 'upload' ? `id-front/${USER}-transfer-${'a'.repeat(32)}.jpg` : PATH,
            source_url: SOURCE, file: mode === 'upload' ? FILE : null, generation: mode === 'upload' ? '0' : 'export' } };
        }
        assert.equal(name, 'employee_transfer_verification_media_commit');
        return { data: { success: true, key: KEY, bytes: BYTES.length, sha256: SHA, content_type: 'image/jpeg', full_site_complete: false } };
      },
      store: {
        upload: async (bucket, path, bytes, options) => {
          storage.push({ action: 'upload', bucket, path });
          assert.deepEqual(options, { upsert: false, contentType: 'image/jpeg' });
          assert.equal(createHash('sha256').update(bytes).digest('hex'), SHA);
          return { data: { path } };
        },
        download: async (bucket, path) => { storage.push({ action: 'download', bucket, path }); return { data: new Response(BYTES) }; },
      },
    });
    const pageServer = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Security-Policy', "default-src 'none'; connect-src http://127.0.0.1:*");
      res.end('<!doctype html><title>Local media CORS acceptance</title>');
    });
    const mediaServer = createServer(async (req, res) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
        requests.push({ method: req.method, headers: Object.fromEntries(headers) });
        const input = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers,
          ...(req.method === 'POST' ? { body: req, duplex: 'half' } : {}) });
        const response = await handler(input);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { errors.push(error); res.writeHead(500); res.end(); }
    });
    let browser;
    try {
      const pageOrigin = await local(pageServer), mediaOrigin = await local(mediaServer);
      browser = await playwright[engine].launch({ headless: true,
        ...(engine === 'chromium' && process.env.EMPLOYEE_TRANSFER_CORS_CHROMIUM ? { executablePath: process.env.EMPLOYEE_TRANSFER_CORS_CHROMIUM } : {}) });
      const context = await browser.newContext();
      context.on('request', request => {
        if (![pageOrigin, mediaOrigin].includes(new URL(request.url()).origin)) external.push(request.url());
      });
      const page = await context.newPage(); await page.goto(pageOrigin);
      const send = (scope, action, bytes = null, extra = {}) => page.evaluate(async ({ endpoint, scope, action, bytes, extra, admin, job, key }) => {
        try {
          const response = await fetch(endpoint, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
            headers: { apikey: 'local-public-fixture-key', 'Content-Type': 'application/octet-stream', 'x-transfer-scope': scope,
              'x-transfer-action': action, 'x-admin-session-token': admin, 'x-transfer-job-token': job, 'x-transfer-object-key': key, ...extra },
            body: bytes === null ? undefined : new Uint8Array(bytes) });
          return { status: response.status, sha: response.headers.get('x-transfer-sha256'), type: response.headers.get('x-transfer-content-type'),
            bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
        } catch { return { rejected: true }; }
      }, { endpoint: `${mediaOrigin}/media`, scope, action, bytes, extra, admin: ADMIN, job: JOB, key: KEY });
      for (const scope of SCOPES) await t.test(`${scope}: CORS-readable authorization denial, no Storage access`, async () => {
        const action = scope === 'mapped-verification' ? 'recheck-import' : 'download';
        const result = await send(scope, action);
        assert.equal(result.status, 403);
        assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(result.bytes))), { success: false, error: 'NOT_AUTHORIZED' });
        assert.equal(storage.length, 0);
        assert.match(calls.at(-1).name, /_media_authorize$/);
      });
      await t.test('browser emits a complete POST preflight including scope and both tokens', () => {
        const preflight = requests.find(request => request.method === 'OPTIONS'); assert.ok(preflight);
        const headers = preflight.headers['access-control-request-headers'].split(',').map(value => value.trim().toLowerCase());
        for (const expected of ['apikey', 'content-type', 'x-transfer-scope', 'x-transfer-action', 'x-admin-session-token', 'x-transfer-job-token', 'x-transfer-object-key']) assert.ok(headers.includes(expected));
        assert.equal(preflight.headers.origin, pageOrigin);
        assert.equal(preflight.headers['access-control-request-method'], 'POST');
      });
      await t.test('a forbidden request header is rejected before POST or RPC', async () => {
        const postCount = requests.filter(request => request.method === 'POST').length, callCount = calls.length;
        assert.deepEqual(await send('verification', 'download', null, { 'x-transfer-url': 'forbidden-local-fixture' }), { rejected: true });
        assert.equal(requests.filter(request => request.method === 'POST').length, postCount); assert.equal(calls.length, callCount);
      });
      await t.test('cross-origin download exposes actual integrity headers and exact bytes', async () => {
        mode = 'download'; const result = await send('verification', 'download');
        assert.equal(result.status, 200); assert.equal(result.sha, SHA); assert.equal(result.type, 'image/jpeg');
        assert.deepEqual(result.bytes, Array.from(BYTES));
      });
      await t.test('cross-origin upload is followed by readback and readable receipt', async () => {
        mode = 'upload'; const result = await send('verification', 'upload', Array.from(BYTES));
        assert.equal(result.status, 200);
        const receipt = JSON.parse(new TextDecoder().decode(Uint8Array.from(result.bytes)));
        assert.equal(receipt.success, true); assert.equal(receipt.sha256, SHA); assert.equal(receipt.full_site_complete, false);
        assert.deepEqual(storage.slice(-2).map(call => call.action), ['upload', 'download']);
      });
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      assert.ok(requests.filter(request => request.method === 'POST').every(request => request.headers.cookie === undefined && request.headers.authorization === undefined));
    } finally {
      await browser?.close();
      await Promise.all([close(mediaServer), close(pageServer)]);
    }
  });
}
