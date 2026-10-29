import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync(new URL('../migration-check/03_copy_storage_files.html', import.meta.url), 'utf8');
const core = /<script id="core">([\s\S]*?)<\/script>/.exec(html)[1];
const rejectNetwork = async url => { throw new Error(`Unmocked network request: ${url}`); };
const { runStorageCopy, runStorageDownload, runStorageUpload, runTransfer, keyProblem, projectRef, CONTENT_TABLES, parsePublicMediaUrl, transferReport, transferLabels, extractStorageUrls } = new Function('fetch',
  `${core}\nreturn { runStorageCopy, runStorageDownload, runStorageUpload, runTransfer, keyProblem, projectRef, CONTENT_TABLES, parsePublicMediaUrl, transferReport, transferLabels, extractStorageUrls };`)(rejectNetwork);

function memoryFolder(initial = {}) {
  const files = new Map(Object.entries(initial).map(([path, data]) => [path, new Blob([data])]));
  return {
    files,
    writes: [],
    reads: [],
    async read(path) { this.reads.push(path); return files.get(path) ?? null; },
    async write(path, blob) { this.writes.push(path); files.set(path, new Blob([await blob.arrayBuffer()])); },
  };
}
const bytesOf = async blob => Buffer.from(await blob.arrayBuffer());

const KEY = 'test-service-key';
const SOURCE_URL = 'https://ssssssssssssssssssss.supabase.co';
const TARGET_URL = 'https://tttttttttttttttttttt.supabase.co';
const EXTERNAL_URL = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
const mediaUrl = (origin, id) => `${origin}/storage/v1/object/public/${id.split('/').map(encodeURIComponent).join('/')}`;
const announcementRows = (origin, ids) => ids.map((id, index) => ({
  id: `announcement-${String(index).padStart(4, '0')}`, content: `<img src="${mediaUrl(origin, id)}">`,
}));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function singleFileBackup({ version, project, file, bytes }) {
  const entry = { mime: 'image/jpeg', ...file, size: bytes.length,
    ...(version === 2 ? { downloaded: true, sha256: sha256(bytes) } : {}) };
  return memoryFolder({
    'storage-manifest.json': JSON.stringify({ format: 'supabase-storage-backup', version, project, files: [entry] }),
    [`files/${file.bucket}/${file.path}`]: bytes,
  });
}

function startStorage({ buckets, oldFiles, newFiles, sourceRows = {}, targetRows = {}, externalFiles = new Map(), faults = {} }) {
  const uploads = [];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
    requests.push({ path: url.pathname, search: url.search, method: req.method, headers: req.headers,
      body: req.headers['content-type'] === 'application/json' ? JSON.parse(body.toString()) : null });
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    };
    const authed = req.headers.apikey === KEY && req.headers.authorization === `Bearer ${KEY}`;
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);

    if (['old', 'new'].includes(parts[0]) && parts[4] === 'object' && parts[5] === 'public') {
      const id = `${parts[6]}/${parts.slice(7).join('/')}`;
      assert.equal(req.headers.apikey, undefined, 'public fallback must not receive a secret');
      assert.equal(req.headers.authorization, undefined);
      const fault = (parts[0] === 'old' ? faults.sourcePublicErrors : faults.targetPublicErrors)?.get(id);
      if (fault) return send(fault.status, fault.body);
      const data = parts[0] === 'old' ? oldFiles.get(id) : newFiles.get(id)?.bytes;
      if (!data) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      if (faults.shortDownload?.has(id)) return send(200, data.subarray(1), { 'Content-Type': 'application/octet-stream' });
      return send(200, data, { 'Content-Type': 'application/octet-stream' });
    }
    if (parts[0] === 'external') {
      assert.equal(req.headers.apikey, undefined, 'secret keys must never be sent to media origins');
      assert.equal(req.headers.authorization, undefined);
      const bytes = externalFiles.get(parts.slice(1).join('/'));
      return bytes ? send(200, bytes, { 'Content-Type': 'image/jpeg' }) : send(404, { message: 'Not found' });
    }
    if (parts[0] !== 'new' && parts[0] !== 'old') return send(404, { message: 'unknown' });
    if (!authed) return send(403, { message: 'Invalid key' });
    const isOld = parts[0] === 'old';
    if (parts[2] === 'rest') {
      const table = parts[4];
      const rows = (isOld ? sourceRows : targetRows)[table] || [];
      const cursor = table === 'financial_operations' ? 'operation_id' : 'id';
      const after = (url.searchParams.get(cursor) || '').replace(/^gt\./, '');
      return send(200, rows.filter(row => !after || row[cursor] > after).slice(0, Number(url.searchParams.get('limit') || 500)));
    }
    const records = isOld ? new Map([...oldFiles].map(([id, bytes]) => {
      const slash = id.indexOf('/');
      const existing = newFiles.get(id);
      return [id, { bucket: id.slice(0, slash), path: id.slice(slash + 1), size: bytes.length, mime: existing?.mime || 'image/jpeg', cache: existing?.cache || 'max-age=3600', bytes }];
    })) : newFiles;
    const rest = parts.slice(4);
    if (rest[0] === 'bucket') return send(200, buckets);
    if (rest[0] === 'object' && rest[1] === 'list') {
      const { prefix, limit, offset } = JSON.parse(body.toString());
      const base = prefix ? `${prefix}/` : '';
      const children = new Map();
      for (const record of records.values()) {
        if (record.bucket !== rest[2] || !record.path.startsWith(base)) continue;
        const remainder = record.path.slice(base.length);
        const slash = remainder.indexOf('/');
        if (slash >= 0) children.set(remainder.slice(0, slash), { name: remainder.slice(0, slash), id: null, metadata: null });
        else children.set(remainder, { name: remainder, id: `${record.bucket}/${record.path}`, metadata: { size: record.size, mimetype: record.mime, cacheControl: record.cache }, user_metadata: record.user_metadata });
      }
      const sorted = [...children.values()].sort((a, b) => a.name.localeCompare(b.name));
      const start = faults.ignoreOffset ? 0 : offset;
      return send(200, sorted.slice(start, start + limit));
    }
    if (rest[0] === 'object' && rest[1] === 'info') {
      const record = records.get(`${rest[2]}/${rest.slice(3).join('/')}`);
      return record ? send(200, { size: record.size, metadata: record.user_metadata }) : send(404, {});
    }
    if (rest[0] === 'object' && rest[1] === 'authenticated') {
      const id = `${rest[2]}/${rest.slice(3).join('/')}`;
      const record = records.get(id);
      const fault = (isOld ? faults.sourceAuthenticatedErrors : faults.targetAuthenticatedErrors)?.get(id);
      if (fault) return send(fault.status, fault.body);
      if (!record?.bytes) return send(400, { statusCode: '404', error: 'Not found', code: 'NoSuchKey' });
      if (!req.headers.range) return send(200, faults.shortDownload?.has(id) ? record.bytes.subarray(1) : record.bytes, { 'Content-Type': 'application/octet-stream' });
      return send(206, record.bytes.subarray(0, 1), { 'Content-Range': `bytes 0-0/${record.bytes.length}`, 'Access-Control-Expose-Headers': 'Content-Range' });
    }
    if (rest[0] === 'object' && req.method === 'POST') {
      const id = `${rest[1]}/${rest.slice(2).join('/')}`;
      uploads.push({ id, headers: req.headers, size: body.length });
      const failCount = faults.uploadFailures?.get(id) || 0;
      if (failCount > 0) { faults.uploadFailures.set(id, failCount - 1); return send(500, { message: 'temporary' }); }
      if (req.headers['x-upsert'] !== 'true') return send(400, { message: 'The resource already exists' });
      let record = newFiles.get(id);
      if (!record) {
        if (!buckets.some(bucket => bucket.id === rest[1])) return send(400, { message: 'Bucket missing' });
        record = { bucket: rest[1], path: rest.slice(2).join('/'), size: body.length, mime: req.headers['content-type'], cache: req.headers['cache-control'] };
        newFiles.set(id, record);
      }
      record.bytes = body;
      record.size = body.length;
      record.user_metadata = faults.dropReceipt ? null : JSON.parse(Buffer.from(req.headers['x-metadata'], 'base64').toString());
      return send(200, { Key: id });
    }
    return send(404, { message: 'unknown route' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(input);
      let local;
      if (url.origin === SOURCE_URL) local = `${base}/old/x${url.pathname}${url.search}`;
      else if (url.origin === TARGET_URL) local = `${base}/new/x${url.pathname}${url.search}`;
      else if (url.origin === EXTERNAL_URL && url.pathname.startsWith('/storage/v1/object/public/')) {
        assert.equal(new Headers(init.headers).has('apikey'), false, 'third-party reads must not receive API keys');
        assert.equal(new Headers(init.headers).has('authorization'), false, 'third-party reads must not receive bearer tokens');
        assert.equal(init.redirect, 'error', 'media reads must not follow redirects');
        local = `${base}/external/${url.pathname.slice('/storage/v1/object/public/'.length)}${url.search}`;
      } else return rejectNetwork(input);
      // The only real fetch in this suite is to this test's loopback server.
      return fetch(local, { ...init, redirect: 'error' });
    };
    resolve({ server, uploads, requests, fetchImpl, oldUrl: SOURCE_URL, newUrl: TARGET_URL });
  }));
}

function fixture() {
  const buckets = [{ id: 'announcement-images', public: true }, { id: 'chat-images', public: true }, { id: 'content-audit-evidence', public: false }];
  const oldFiles = new Map();
  const newFiles = new Map();
  const add = (bucket, path, { inOld = true, inNew = false, mime = 'image/jpeg', cache = 'max-age=3600' } = {}) => {
    const bytes = Buffer.from(`${bucket}:${path}:${'x'.repeat(path.length)}`);
    if (inOld) oldFiles.set(`${bucket}/${path}`, bytes);
    newFiles.set(`${bucket}/${path}`, { bucket, path, size: bytes.length, mime, cache, bytes: inNew ? bytes : null,
      user_metadata: inNew ? { storageMigration: { target: TARGET_URL, bytes: bytes.length, sha256: sha256(bytes), version: 3 } } : undefined });
  };
  for (let i = 0; i < 230; i += 1) add('announcement-images', `e169/${String(i).padStart(4, '0')}-a.jpg`);
  add('announcement-images', 'messages/deep/one.mp4', { mime: 'video/mp4', cache: 'no-cache' });
  add('announcement-images', 'top level 空格.png', { mime: 'image/png' });
  add('chat-images', 'chat-images/template_1.jpg', { inNew: true });
  add('chat-images', 'gone.jpg', { inOld: false });
  // Deliberately opt each bulk fixture file into announcements; startStorage never invents references.
  const rows = announcementRows(SOURCE_URL, [...newFiles.keys()]);
  return { buckets, oldFiles, newFiles, sourceRows: { announcements: rows }, targetRows: { announcements: rows } };
}

test('file discovery and SQL switching use the same current media field catalog', () => {
  const sql = readFileSync(new URL('../migration-check/04_switch_storage_origin.sql', import.meta.url), 'utf8');
  const sqlFields = [...sql.matchAll(/\('public', '([^']+)', '([^']+)'\)/g)].map(match => `${match[1]}.${match[2]}`).sort();
  assert.deepEqual(CONTENT_TABLES.flatMap(([table, columns]) => columns.map(column => `${table}.${column}`)).sort(), sqlFields);
  assert.deepEqual(sqlFields, ['announcements.content']);
  assert.equal(sqlFields.length, 1);
});

test('HTML media paths preserve parentheses and decode entities without accepting unsafe hosts or traversal', () => {
  const base = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co/storage/v1/object/public/announcement-images/';
  assert.equal(parsePublicMediaUrl(`${base}a&amp;b(1).jpg`).path, 'a&b(1).jpg');
  assert.equal(parsePublicMediaUrl(`${base}a%26amp%3Bb.jpg`).path, 'a&amp;b.jpg');
  assert.equal(parsePublicMediaUrl(`${base}%2e%2e%2fsecret.jpg`), null);
  assert.equal(parsePublicMediaUrl('https://example.com/image.jpg'), null);
});

test('media scanning separates Markdown and CSS delimiters from real filename parentheses', () => {
  const base = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co/storage/v1/object/public/announcement-images/';
  const cases = [
    [`![Image](${base}image.jpg)`, [`${base}image.jpg`]],
    [`[photo](${base}photo(1).jpg)`, [`${base}photo(1).jpg`]],
    [`![photo]( ${base}nested(a(b)).jpg "title")`, [`${base}nested(a(b)).jpg`]],
    [`background: url(${base}bg.jpg)no-repeat`, [`${base}bg.jpg`]],
    [`url(${base}a.jpg),url(${base}b.jpg)`, [`${base}a.jpg`, `${base}b.jpg`]],
    [`<img src="${base}literal).jpg">`, [`${base}literal).jpg`]],
    [`url('${base}trailing.jpg)')`, [`${base}trailing.jpg)`]],
    [`![x](<${base}angle.jpg>)`, [`${base}angle.jpg`]],
    [JSON.stringify({ content: `![x](${base}json.jpg)` }), [`${base}json.jpg`]],
    [`${base}literal.jpg)`, [`${base}literal.jpg)`]],
    [`![x](${base}encoded%29.jpg)`, [`${base}encoded%29.jpg`]],
  ];
  for (const [content, expected] of cases) assert.deepEqual(extractStorageUrls(content), expected, content);
});

test('Markdown announcement images do not create phantom files ending in a closing parenthesis', async () => {
  const origin = 'https://ssssssssssssssssssss.supabase.co';
  const paths = ['notice.jpg', 'notice(1).jpg', 'notice%29.jpg'];
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map(paths.map(path => [`announcement-images/${decodeURIComponent(path)}`, Buffer.from('image bytes')])), newFiles: new Map(),
    sourceRows: { announcements: [{ id: 'markdown-notice', content: paths.map(path => `![Image](${origin}/storage/v1/object/public/announcement-images/${path})`).join('\n') }] },
  };
  const storage = await startStorage(data);

  try {
    const options = { oldUrl: origin, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl };
    const checked = await runStorageCopy({ ...options, checkOnly: true });
    assert.equal(checked.total, 3);
    assert.equal(checked.missing, 3);
    assert.equal(checked.failed.length, 0);
    assert.equal(storage.uploads.length, 0);
    const copied = await runStorageCopy(options);
    assert.equal(copied.copied, 3);
    assert.equal(copied.failed.length, 0);
    assert.equal((await runStorageCopy({ ...options, checkOnly: true })).present, 3);
    assert(!storage.requests.some(request => /notice\.jpg\)|notice\(1\)\.jpg\)/.test(decodeURIComponent(request.path))));
  } finally { storage.server.close(); }
});

test('progress labels separate destination files that already exist from successful transfers this run', () => {
  for (const [mode, action] of [['copy', '复制'], ['download', '下载'], ['upload', '上传']]) {
    const check = transferLabels(mode, true);
    assert.equal(check.issue, '检查异常');
    assert.equal(check.pending, `待${action}`);
    assert.equal(check.present, mode === 'download' ? '电脑已有并核对' : '目标已有并核对');
    assert.equal(check.copied, '本次未执行');
    assert(!Object.values(check).some(label => label.includes('失败')));
    const run = transferLabels(mode, false);
    assert.equal(run.present, mode === 'download' ? '电脑中已存在' : '目标已存在');
    assert.equal(run.copied, `本次${action}成功`);
    assert.equal(run.issue, `${action}失败`);
  }
  assert.match(html, /id="sPresent"/);
  assert.match(html, /id="sCopied"/);
  assert.match(html, /\$\('sPresent'\)\.textContent = r\.present/);
  assert.match(html, /\$\('sCopied'\)\.textContent = r\.copied/);
  assert.doesNotMatch(html, /id="sDone"/);
  const report = transferReport({ mode: 'copy', checkOnly: true, result: {
    total: 2, present: 0, copied: 0, missing: 1, missingFiles: [{ bucket: 'announcement-images', path: 'pending.jpg' }],
    failed: [{ bucket: 'announcement-images', path: 'unknown.jpg', reason: 'cannot read' }], stopped: false,
  } });
  assert.equal(report.scope, 'announcements');
  assert.equal(report.labels.issue, '检查异常');
  assert.equal(report.labels.pending, '待复制');
  assert.equal(report.summary.missing, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.readyForLinkSwitch, false);
});

test('key checks reject anon keys, foreign projects and publishable keys', () => {
  const jwt = payload => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
  assert.equal(projectRef('https://ashxnuadjvhqucoobmyp.supabase.co'), 'ashxnuadjvhqucoobmyp');
  assert.equal(projectRef('https://ashxnuadjvhqucoobmyp.supabase.co/'), null);
  assert.match(keyProblem(jwt({ role: 'anon', ref: 'ashxnuadjvhqucoobmyp' }), 'ashxnuadjvhqucoobmyp'), /anon/);
  assert.match(keyProblem(jwt({ role: 'service_role', ref: 'hxpbpqoqkoiiplvdwmld' }), 'ashxnuadjvhqucoobmyp'), /不是新项目/);
  assert.equal(keyProblem(jwt({ role: 'service_role', ref: 'ashxnuadjvhqucoobmyp' }), 'ashxnuadjvhqucoobmyp'), null);
  assert.match(keyProblem('sb_publishable_abc', 'ashxnuadjvhqucoobmyp'), /公开密钥/);
  assert.equal(keyProblem('sb_secret_abc', 'ashxnuadjvhqucoobmyp'), null);
  assert.match(keyProblem('', 'ashxnuadjvhqucoobmyp'), /请填写/);
  assert.match(keyProblem('not-a-key', 'ashxnuadjvhqucoobmyp'), /格式不对/);
});

test('copies missing files with headers, skips existing ones, reports files absent from the old project, and is rerunnable', async () => {
  const data = fixture();
  const storage = await startStorage(data);
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(result.total, 234);
    assert.equal(result.present, 1);
    assert.equal(result.copied, 232);
    assert.deepEqual(result.failed.map(f => [f.bucket, f.path]), [['chat-images', 'gone.jpg']]);
    assert.match(result.failed[0].reason, /来源返回文件不存在/);
    assert.equal(result.failed[0].failureType, 'source_not_found');
    assert.equal(storage.uploads.filter(u => u.id === 'chat-images/gone.jpg').length, 0);
    for (const [id, record] of data.newFiles) if (data.oldFiles.has(id)) assert.deepEqual(record.bytes, data.oldFiles.get(id), id);
    const video = storage.uploads.find(u => u.id === 'announcement-images/messages/deep/one.mp4');
    assert.equal(video.headers['content-type'], 'video/mp4');
    assert.equal(video.headers['cache-control'], 'no-cache');
    assert.ok(storage.uploads.some(u => u.id === 'announcement-images/top level 空格.png'));

    const again = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(again.present, 233);
    assert.equal(again.copied, 0);
    assert.equal(again.failed.length, 1);
  } finally {
    storage.server.close();
  }
});

test('check-only mode uploads nothing and counts missing files', async () => {
  const storage = await startStorage(fixture());
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, checkOnly: true });
    assert.equal(result.present, 1);
    assert.equal(result.missing, 232);
    assert.deepEqual(result.failed.map(file => file.path), ['gone.jpg']);
    assert.equal(storage.uploads.length, 0);
  } finally {
    storage.server.close();
  }
});

test('retries temporary upload errors and rejects downloads with the wrong size', async () => {
  const data = fixture();
  const shortDownload = new Set(['announcement-images/e169/0001-a.jpg']);
  const uploadFailures = new Map([['announcement-images/e169/0002-a.jpg', 2]]);
  const storage = await startStorage({ ...data, faults: { shortDownload, uploadFailures } });
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    const failed = Object.fromEntries(result.failed.map(f => [`${f.bucket}/${f.path}`, f.reason]));
    assert.match(failed['announcement-images/e169/0001-a.jpg'], /大小不对/);
    assert.equal(failed['announcement-images/e169/0002-a.jpg'], undefined);
    assert.equal(storage.uploads.filter(u => u.id === 'announcement-images/e169/0002-a.jpg').length, 3);
    assert.equal(storage.uploads.filter(u => u.id === 'announcement-images/e169/0001-a.jpg').length, 0);
    assert.equal(data.newFiles.get('announcement-images/e169/0001-a.jpg').bytes, null);
  } finally {
    storage.server.close();
  }
});

test('a listing that keeps repeating the same page stops with an error instead of spinning', async () => {
  const storage = await startStorage({ ...fixture(), faults: { ignoreOffset: true } });
  try {
    const progress = [];
    await assert.rejects(
      runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, onEvent: e => { if (e.type === 'listing') progress.push(e); } }),
      /重复内容/,
    );
    assert.ok(progress.length > 0);
    assert.equal(storage.uploads.length, 0);
  } finally {
    storage.server.close();
  }
});

test('a rejected key stops before listing or copying anything', async () => {
  const storage = await startStorage(fixture());
  try {
    await assert.rejects(runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: 'wrong', fetchImpl: storage.fetchImpl }), /读取媒体引用失败（announcements，HTTP 403）：Invalid key/);
    assert(!storage.requests.some(request => request.path.includes('/storage/')));
    storage.requests.length = 0;
    await assert.rejects(runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: 'wrong', newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl }), /读取媒体引用失败（announcements，HTTP 403）：Invalid key/);
    assert(!storage.requests.some(request => request.path.includes('/storage/')));
    assert.equal(storage.uploads.length, 0);
  } finally {
    storage.server.close();
  }
});

function sourceProject() {
  const data = fixture();
  for (const record of data.newFiles.values()) record.bytes = data.oldFiles.get(`${record.bucket}/${record.path}`) ?? null;
  const secret = Buffer.from('private evidence');
  data.newFiles.set('content-audit-evidence/job/1.json', { bucket: 'content-audit-evidence', path: 'job/1.json', size: secret.length, mime: 'application/json', cache: 'no-cache', bytes: secret });
  data.targetRows.announcements = announcementRows(TARGET_URL, [...data.newFiles.keys()].filter(id => !id.startsWith('content-audit-evidence/')));
  return data;
}

test('download saves only referenced media in the original layout, excludes private evidence and only fetches newly referenced files', async () => {
  const data = sourceProject();
  const storage = await startStorage(data);
  try {
    const folder = memoryFolder();
    const result = await runStorageDownload({ url: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.equal(result.total, 234);
    assert.equal(result.copied, 233);
    assert.deepEqual(result.failed.map(f => `${f.bucket}/${f.path}`), ['chat-images/gone.jpg']);
    assert.match(result.failed[0].reason, /来源返回文件不存在/);
    for (const [id, record] of data.newFiles) {
      if (record.bytes && !id.startsWith('content-audit-evidence/')) assert.deepEqual(await bytesOf(folder.files.get(`files/${id}`)), record.bytes, id);
    }
    assert.equal(folder.files.has('files/content-audit-evidence/job/1.json'), false);
    assert(!storage.requests.some(request => request.path.includes('/content-audit-evidence')));
    const manifest = JSON.parse((await bytesOf(folder.files.get('storage-manifest.json'))).toString());
    assert.equal(manifest.format, 'supabase-storage-backup');
    assert.equal(manifest.scope, 'announcements');
    assert.equal(manifest.files.length, 234);
    assert(!manifest.buckets.some(bucket => bucket.id === 'content-audit-evidence'));
    assert(manifest.files.filter(file => file.downloaded).every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.equal(manifest.complete, false);

    const extra = Buffer.from('new upload after backup');
    data.newFiles.set('chat-images/later.jpg', { bucket: 'chat-images', path: 'later.jpg', size: extra.length, mime: 'image/jpeg', cache: 'max-age=3600', bytes: extra });
    data.targetRows.announcements.push({ id: 'later', content: `<img src="${mediaUrl(TARGET_URL, 'chat-images/later.jpg')}">` });
    data.newFiles.set('chat-images/later-orphan.jpg', { bucket: 'chat-images', path: 'later-orphan.jpg', size: extra.length, bytes: extra });
    folder.writes.length = 0;
    const again = await runStorageDownload({ url: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.equal(again.present, 233);
    assert.equal(again.copied, 1);
    assert.deepEqual(folder.writes, ['files/chat-images/later.jpg', 'storage-manifest.json']);
    assert(!storage.requests.some(request => request.path.includes('later-orphan')));
    const laterManifest = JSON.parse(await folder.files.get('storage-manifest.json').text());
    assert.equal(laterManifest.files.length, 235);
    assert(!laterManifest.files.some(file => file.path === 'later-orphan.jpg'));
  } finally {
    storage.server.close();
  }
});

test('download re-fetches a local file whose size is wrong, rejects short downloads, and check-only writes nothing', async () => {
  const data = sourceProject();
  const storage = await startStorage({ ...data, faults: { shortDownload: new Set(['announcement-images/e169/0003-a.jpg']) } });
  try {
    const folder = memoryFolder({ 'files/announcement-images/e169/0001-a.jpg': 'truncated' });
    const check = await runStorageDownload({ url: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder, checkOnly: true });
    assert.equal(check.missing, 232);
    assert.deepEqual(check.failed.map(file => file.path).sort(), ['e169/0003-a.jpg', 'gone.jpg']);
    assert.equal(folder.writes.length, 0);
    const result = await runStorageDownload({ url: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.deepEqual(await bytesOf(folder.files.get('files/announcement-images/e169/0001-a.jpg')), data.newFiles.get('announcement-images/e169/0001-a.jpg').bytes);
    const failed = Object.fromEntries(result.failed.map(f => [`${f.bucket}/${f.path}`, f.reason]));
    assert.match(failed['announcement-images/e169/0003-a.jpg'], /大小不对/);
    assert.equal(folder.files.has('files/announcement-images/e169/0003-a.jpg'), false);
  } finally {
    storage.server.close();
  }
});

test('upload restores files from a downloaded folder into a fresh project and is rerunnable', async () => {
  const source = sourceProject();
  const src = await startStorage(source);
  const folder = memoryFolder();
  try { await runStorageDownload({ url: src.newUrl, key: KEY, fetchImpl: src.fetchImpl, folder }); } finally { src.server.close(); }
  folder.files.set('files/chat-images/deleted-on-site.jpg', new Blob(['stale']));
  folder.files.set('files/announcement-images/e169/0005-a.jpg', new Blob(['tampered']));
  folder.files.delete('files/announcement-images/e169/0006-a.jpg');

  const target = sourceProject();
  for (const record of target.newFiles.values()) record.bytes = null;
  target.newFiles.get('chat-images/chat-images/template_1.jpg').bytes = source.newFiles.get('chat-images/chat-images/template_1.jpg').bytes;
  const storage = await startStorage(target);
  try {
    const check = await runStorageUpload({ newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder, checkOnly: true });
    assert.equal(check.present, 1);
    assert.equal(check.missing, 233);
    assert.equal(storage.uploads.length, 0);

    const result = await runStorageUpload({ newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.equal(result.manifest.format, 'supabase-storage-backup');
    assert.equal(result.present, 1);
    assert.equal(result.copied, 230);
    const failed = Object.fromEntries(result.failed.map(f => [`${f.bucket}/${f.path}`, f.reason]));
    assert.deepEqual(Object.keys(failed).sort(), ['announcement-images/e169/0005-a.jpg', 'announcement-images/e169/0006-a.jpg', 'chat-images/gone.jpg']);
    assert.match(failed['announcement-images/e169/0005-a.jpg'], /不一致/);
    assert.match(failed['announcement-images/e169/0006-a.jpg'], /电脑文件夹里没有/);
    assert.ok(!storage.uploads.some(u => u.id === 'chat-images/deleted-on-site.jpg'));
    assert(!storage.uploads.some(u => u.id === 'content-audit-evidence/job/1.json'));
    assert(!storage.requests.some(request => request.path.includes('/content-audit-evidence')));
    for (const [id, record] of target.newFiles) {
      if (record.bytes) assert.deepEqual(record.bytes, source.newFiles.get(id).bytes, id);
    }

    storage.uploads.length = 0;
    const again = await runStorageUpload({ newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.equal(again.present, 231);
    assert.equal(again.copied, 0);
    assert.equal(storage.uploads.length, 0);
  } finally {
    storage.server.close();
  }
});

test('fresh announcement references are discovered on every copy run while new unreferenced objects stay ignored', async () => {
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map(), newFiles: new Map(), sourceRows: { announcements: [] }, targetRows: { announcements: [] } };
  const storage = await startStorage(data);
  try {
    data.oldFiles.set('announcement-images/late/new.jpg', Buffer.from('new announcement image'));
    data.oldFiles.set('announcement-images/late/orphan.jpg', Buffer.from('not in an announcement'));
    data.sourceRows.announcements.push(...announcementRows(SOURCE_URL, ['announcement-images/late/new.jpg']));
    const options = { oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl };
    const check = await runStorageCopy({ ...options, checkOnly: true });
    assert.equal(check.total, 1);
    assert.equal(check.missing, 1);
    assert.equal(storage.uploads.length, 0);
    assert.equal((await runStorageCopy(options)).copied, 1);
    data.oldFiles.set('announcement-images/late/next.mp4', Buffer.from('later video'));
    data.oldFiles.set('announcement-images/late/orphan.mp4', Buffer.from('unreferenced later video'));
    data.targetRows.announcements.push({ id: 'target-later', content: `<video src="${mediaUrl(SOURCE_URL, 'announcement-images/late/next.mp4')}"></video>` });
    const next = await runStorageCopy(options);
    assert.equal(next.total, 2);
    assert.equal(next.failed.length, 0);
    assert.equal(next.present, 1);
    assert(!storage.requests.some(request => request.path.includes('orphan')));
    assert(!storage.uploads.some(upload => upload.id.includes('orphan')));
    assert.equal(next.copied, 1);
    const metadata = JSON.parse(Buffer.from(storage.uploads.at(-1).headers['x-metadata'], 'base64').toString());
    assert.equal(metadata.storageMigration.target, storage.newUrl);
    assert.deepEqual(data.newFiles.get('announcement-images/late/next.mp4').bytes, data.oldFiles.get('announcement-images/late/next.mp4'));
  } finally { storage.server.close(); }
});

test('cross-project announcement images, videos and posters are copied, backed up and restored while notification media is ignored', async () => {
  const origin = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
  const url = path => `${origin}/storage/v1/object/public/announcement-images/${path}`;
  const rows = {
    announcements: [{ id: '1', content: `<img src="${url('later/%E5%9B%BE%E7%89%87.jpg')}"><video src="${url('later/video.mp4')}" poster="${url('later/poster.jpg')}"></video><img src="${url('later/picture(1).jpg')}">` }],
    messages: [{ id: '2', content: `<img src="${url('notifications/new.jpg')}">` }],
  };
  const externalFiles = new Map(['later/图片.jpg', 'later/video.mp4', 'later/poster.jpg', 'later/picture(1).jpg', 'notifications/new.jpg'].map(path => [`announcement-images/${path}`, Buffer.from(`contents:${path}`)]));
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map(), newFiles: new Map(), sourceRows: rows, targetRows: rows, externalFiles };
  const storage = await startStorage(data);
  try {
    const options = { oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl };
    const copied = await runStorageCopy(options);
    assert.equal(copied.copied, 4);
    assert.equal(copied.failed.length, 0);
    assert.equal((await runStorageCopy(options)).present, 4);
    const folder = memoryFolder();
    const downloaded = await runStorageDownload({ url: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.equal(downloaded.copied, 4);
    assert(folder.files.has('files/announcement-images/later/图片.jpg'));
    const manifest = JSON.parse(await folder.files.get('storage-manifest.json').text());
    assert.equal(manifest.version, 2);
    assert.equal(manifest.scope, 'announcements');
    assert.equal(manifest.files.length, 4);
    data.newFiles.clear();
    const repeated = await runStorageDownload({ url: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder, checkOnly: true });
    assert.equal(repeated.present, 4, 'manifest-only media must be recognized in an incremental backup');
    assert.equal(repeated.missing, 0);
    const restored = await runStorageUpload({ newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.equal(restored.copied, 4, 'manifest-only media must upload even when target has no object records');
    assert.equal(restored.failed.length, 0);
    assert(!storage.requests.some(request => request.path.includes('notifications')));
    assert(!folder.files.has('files/announcement-images/notifications/new.jpg'));
  } finally { storage.server.close(); }
});

test('a failed referenced-media backup cannot restore a stale local file', async () => {
  const origin = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map(), newFiles: new Map(), targetRows: { announcements: [{ id: '1', content: `<img src="${origin}/storage/v1/object/public/announcement-images/missing.jpg">` }] } };
  const storage = await startStorage(data);
  const folder = memoryFolder({ 'files/announcement-images/missing.jpg': 'stale local file' });
  try {
    assert.equal((await runStorageDownload({ url: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder })).failed.length, 1);
    const result = await runStorageUpload({ newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.equal(result.copied, 0);
    assert.match(result.failed[0].reason, /没有成功下载/);
    assert.equal(storage.uploads.length, 0);
  } finally { storage.server.close(); }
});

test('same-size but different destination content is never overwritten', async () => {
  const origin = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map(), newFiles: new Map([
    ['announcement-images/same.jpg', { bucket: 'announcement-images', path: 'same.jpg', size: 3, mime: 'image/jpeg', bytes: Buffer.from('old') }],
  ]), sourceRows: { announcements: [{ id: '1', content: `<img src="${origin}/storage/v1/object/public/announcement-images/same.jpg">` }] }, externalFiles: new Map([['announcement-images/same.jpg', Buffer.from('new')]]) };
  const storage = await startStorage(data);
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(result.copied, 0);
    assert.match(result.failed[0].reason, /内容不同.*拒绝覆盖/);
    assert.equal(storage.uploads.length, 0);
    assert.equal(data.newFiles.get('announcement-images/same.jpg').bytes.toString(), 'old');
  } finally { storage.server.close(); }
});

test('native backups and old receipts never hide same-size changed target bytes', async () => {
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([['announcement-images/native.jpg', Buffer.from('new')]]), newFiles: new Map([
    ['announcement-images/native.jpg', { bucket: 'announcement-images', path: 'native.jpg', size: 3, mime: 'image/jpeg', bytes: Buffer.from('new') }],
  ]), sourceRows: { announcements: announcementRows(SOURCE_URL, ['announcement-images/native.jpg']) },
    targetRows: { announcements: announcementRows(TARGET_URL, ['announcement-images/native.jpg']) } };
  const storage = await startStorage(data);
  try {
    const folder = memoryFolder();
    await runStorageDownload({ url: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    const record = data.newFiles.get('announcement-images/native.jpg');
    record.bytes = Buffer.from('old');
    record.user_metadata = { storageMigration: { target: storage.newUrl, bytes: 3, version: 2 } };
    const restored = await runStorageUpload({ newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.match(restored.failed[0].reason, /内容不同.*拒绝覆盖/);
    const copied = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.match(copied.failed[0].reason, /文件内容不同.*停止|内容不同.*拒绝覆盖/);
    assert.equal(storage.uploads.length, 0);
    assert.equal(record.bytes.toString(), 'old');
  } finally { storage.server.close(); }
});

test('upload refuses a folder that is not a downloaded backup', async () => {
  const storage = await startStorage(fixture());
  try {
    await assert.rejects(runStorageUpload({ newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder: memoryFolder({ 'files/a/b.jpg': 'x' }) }), /storage-manifest\.json/);
    await assert.rejects(runStorageUpload({ newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder: memoryFolder({ 'storage-manifest.json': '{"format":"other"}' }) }), /不是用本工具下载/);
    assert.equal(storage.uploads.length, 0);
  } finally {
    storage.server.close();
  }
});

test('a public file is copied and backed up when authenticated reads return HTTP400', async () => {
  const id = 'announcement-images/recover.jpg';
  const bytes = Buffer.from('public file is still readable');
  const authError = { status: 400, body: { code: 'InvalidRequest', message: 'Authenticated endpoint rejected this request' } };
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, bytes]]), newFiles: new Map([[id, {
    bucket: 'announcement-images', path: 'recover.jpg', size: bytes.length, bytes,
  }]]), sourceRows: { announcements: announcementRows(SOURCE_URL, [id]) }, faults: {
      sourceAuthenticatedErrors: new Map([[id, authError]]), targetAuthenticatedErrors: new Map([[id, authError]]),
    } };
  const storage = await startStorage(data);
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(result.copied, 1);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(data.newFiles.get(id).bytes, bytes);
    assert(storage.requests.some(request => request.path.includes('/old/x/storage/v1/object/public/')));
    assert(storage.requests.some(request => request.path.includes('/new/x/storage/v1/object/authenticated/')));
    assert(storage.requests.some(request => request.path.includes('/new/x/storage/v1/object/public/')));
    const folder = memoryFolder();
    const downloaded = await runStorageDownload({ url: storage.oldUrl, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.equal(downloaded.copied, 1);
    assert.deepEqual(await bytesOf(folder.files.get(`files/${id}`)), bytes);
  } finally { storage.server.close(); }
});

test('same-project content URLs fall back from public to authorized reads and preserve reference locations', async () => {
  const origin = 'https://ssssssssssssssssssss.supabase.co';
  const id = 'announcement-images/protected.jpg';
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, Buffer.from('authorized content')]]), newFiles: new Map(),
    sourceRows: { announcements: [{ id: 'announcement-1', content: `<img src="${origin}/storage/v1/object/public/${id}">` }] },
    faults: { sourcePublicErrors: new Map([[id, { status: 400, body: { code: 'InvalidRequest', message: 'Public endpoint rejected this request' } }]]) },
  };
  const storage = await startStorage(data);

  try {
    const result = await runStorageCopy({ oldUrl: origin, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(result.copied, 1);
    assert.equal(result.failed.length, 0);
    const readRequests = storage.requests.filter(request => request.path.startsWith('/old/x/storage/v1/object/') && !request.path.includes('/list/'));
    assert(readRequests.some(request => request.path.includes('/public/') && !request.headers.apikey));
    assert(readRequests.some(request => request.path.includes('/authenticated/') && request.headers.apikey === KEY));
  } finally { storage.server.close(); }
});

test('HTTP400 invalid requests remain failures with real diagnostics, never assumed missing or silently accepted', async () => {
  const origin = 'https://ssssssssssssssssssss.supabase.co';
  const id = 'announcement-images/error.jpg';
  const fault = { status: 400, body: { code: 'InvalidRequest', message: `Invalid request ${KEY}` } };
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, Buffer.from('bytes')]]), newFiles: new Map(),
    sourceRows: { announcements: [{ id: 'announcement-1', content: `<img src="${origin}/storage/v1/object/public/${id}">` }] },
    faults: { sourceAuthenticatedErrors: new Map([[id, fault]]), sourcePublicErrors: new Map([[id, fault]]) },
  };
  const storage = await startStorage(data);

  try {
    const result = await runStorageCopy({ oldUrl: origin, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].failureType, 'source_download_error');
    assert.match(result.failed[0].reason, /不能判定为文件丢失.*HTTP 400.*InvalidRequest/);
    assert.equal(result.failed[0].diagnostics.length, 2);
    assert.equal(storage.uploads.length, 0);
    const report = transferReport({ result, mode: 'copy', source: origin, target: storage.newUrl, checkOnly: false });
    assert.equal(report.readyForLinkSwitch, false);
    assert.equal(report.failures[0].targetReadable, false);
    assert.deepEqual(report.failures[0].references, [{ project: origin, table: 'announcements', column: 'content', rowId: 'announcement-1' }]);
    assert.equal(JSON.stringify(report).includes(KEY), false);
    assert(!JSON.stringify(report).includes('v_allow_missing'), 'report must not generate a SQL bypass');
  } finally { storage.server.close(); }
});

test('explicit NoSuchKey failures for referenced announcement media remain blocking with both endpoint diagnostics', async () => {
  const id = 'announcement-images/missing.jpg';
  const notFound = { status: 400, body: { code: 'NoSuchKey', message: 'Object not found' } };
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, Buffer.from('missing media')]]), newFiles: new Map(),
    sourceRows: { announcements: announcementRows(SOURCE_URL, [id]) }, faults: {
      sourceAuthenticatedErrors: new Map([[id, notFound]]), sourcePublicErrors: new Map([[id, notFound]]),
    } };
  const storage = await startStorage(data);
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(result.failed[0].failureType, 'source_not_found');
    assert.equal(result.total, 1);
    assert.equal(result.failed[0].diagnostics.length, 2);
    assert(result.failed[0].diagnostics.every(diagnostic => diagnostic.code === 'NoSuchKey'));
    assert.equal(storage.uploads.length, 0);
    assert.equal(transferReport({ result, mode: 'copy' }).readyForLinkSwitch, false);
  } finally { storage.server.close(); }
});

test('a readable destination with an unreadable source is reported accurately without overriding content', async () => {
  const id = 'announcement-images/existing.jpg';
  const bytes = Buffer.from('keep existing file');
  const fault = { status: 400, body: { code: 'InvalidRequest', message: 'Cannot read source' } };
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, bytes]]), newFiles: new Map([[id, {
    bucket: 'announcement-images', path: 'existing.jpg', size: bytes.length, bytes,
  }]]), sourceRows: { announcements: announcementRows(SOURCE_URL, [id]) },
    faults: { sourceAuthenticatedErrors: new Map([[id, fault]]), sourcePublicErrors: new Map([[id, fault]]) } };
  const storage = await startStorage(data);
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(result.failed[0].targetReadable, true);
    assert.equal(result.present, 0);
    assert.equal(storage.uploads.length, 0);
    assert.deepEqual(data.newFiles.get(id).bytes, bytes);
  } finally { storage.server.close(); }
});

test('check-only reports exact missing paths and never declares the link switch ready', async () => {
  const storage = await startStorage({ buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([['announcement-images/new.jpg', Buffer.from('new')]]), newFiles: new Map(),
    sourceRows: { announcements: announcementRows(SOURCE_URL, ['announcement-images/new.jpg']) } });
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, checkOnly: true });
    const report = transferReport({ result, mode: 'copy', checkOnly: true });
    assert.equal(report.readyForLinkSwitch, false);
    assert.equal(report.missingFiles[0].path, 'new.jpg');
    assert.equal(storage.uploads.length, 0);
  } finally { storage.server.close(); }
});

test('target authenticated HTTP400 falls back to public reads but still rejects different bytes', async () => {
  const id = 'announcement-images/conflict.jpg';
  const fault = { status: 400, body: { code: 'InvalidRequest', message: 'Authenticated read failed' } };
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, Buffer.from('new')]]), newFiles: new Map([[id, {
    bucket: 'announcement-images', path: 'conflict.jpg', size: 3, bytes: Buffer.from('old'),
  }]]), sourceRows: { announcements: announcementRows(SOURCE_URL, [id]) },
    faults: { sourceAuthenticatedErrors: new Map([[id, fault]]), targetAuthenticatedErrors: new Map([[id, fault]]) } };
  const storage = await startStorage(data);
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.match(result.failed[0].reason, /内容不同.*拒绝覆盖/);
    assert.equal(storage.uploads.length, 0);
    assert.equal(data.newFiles.get(id).bytes.toString(), 'old');
  } finally { storage.server.close(); }
});

test('an unreadable target is not treated as missing and is never overwritten', async () => {
  const id = 'announcement-images/unreadable.jpg';
  const fault = { status: 400, body: { code: 'InvalidRequest', message: 'Cannot inspect destination' } };
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, Buffer.from('new')]]), newFiles: new Map([[id, {
    bucket: 'announcement-images', path: 'unreadable.jpg', size: 3, bytes: Buffer.from('old'),
  }]]), sourceRows: { announcements: announcementRows(SOURCE_URL, [id]) },
    faults: { targetAuthenticatedErrors: new Map([[id, fault]]), targetPublicErrors: new Map([[id, fault]]) } };
  const storage = await startStorage(data);
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(result.failed[0].failureType, 'target_download_error');
    assert.equal(storage.uploads.length, 0);
    assert.equal(data.newFiles.get(id).bytes.toString(), 'old');
  } finally { storage.server.close(); }
});

test('v1 backups supply verified receipts for target content references instead of reporting false readiness', async () => {
  const file = { bucket: 'announcement-images', path: 'legacy.jpg', size: 3, mime: 'image/jpeg' };
  const origin = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
  const data = { buckets: [{ id: file.bucket, public: true }], oldFiles: new Map(), newFiles: new Map([[`${file.bucket}/${file.path}`, { ...file, bytes: Buffer.from('old') }]]),
    targetRows: { announcements: [{ id: '1', content: `<img src="${origin}/storage/v1/object/public/${file.bucket}/${file.path}">` }] },
  };
  const folder = memoryFolder({ 'files/announcement-images/legacy.jpg': 'old', 'storage-manifest.json': JSON.stringify({ format: 'supabase-storage-backup', version: 1, project: origin, files: [file] }) });
  const storage = await startStorage(data);
  try {
    const options = { newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, folder };
    const check = await runStorageUpload({ ...options, checkOnly: true });
    assert.equal(check.present, 0);
    assert.equal(check.missing, 1);
    assert.equal(storage.uploads.length, 0);
    assert.equal(transferReport({ result: check, mode: 'upload' }).readyForLinkSwitch, false);
    const result = await runStorageUpload(options);
    assert.equal(result.copied, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(data.newFiles.get('announcement-images/legacy.jpg').user_metadata.storageMigration.target, storage.newUrl);
    assert.equal((await runStorageUpload(options)).present, 1);
    data.newFiles.get('announcement-images/legacy.jpg').bytes = Buffer.from('bad');
    const conflict = await runStorageUpload(options);
    assert.equal(conflict.copied, 0);
    assert.match(conflict.failed[0].reason, /内容不同.*拒绝覆盖/);
    assert.equal(storage.uploads.length, 1, 'a valid old receipt cannot hide conflicting v1 target bytes');
  } finally { storage.server.close(); }
});

test('native target media absent from an old backup does not require a migration receipt', async () => {
  const origin = 'https://tttttttttttttttttttt.supabase.co';
  const id = 'announcement-images/target-native.jpg';
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map(), newFiles: new Map([[id, {
    bucket: 'announcement-images', path: 'target-native.jpg', size: 6, bytes: Buffer.from('native'),
  }]]), targetRows: { announcements: [{ id: '1', content: `<img src="${origin}/storage/v1/object/public/${id}">` }] } };
  const folder = memoryFolder({ 'storage-manifest.json': JSON.stringify({ format: 'supabase-storage-backup', version: 1, files: [] }) });
  const storage = await startStorage(data);
  try {
    const result = await runStorageUpload({ newUrl: origin, key: KEY, fetchImpl: storage.fetchImpl, folder });
    assert.equal(result.present, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(storage.uploads.length, 0);
  } finally { storage.server.close(); }
});

test('an upload without a readable correct receipt cannot authorize link switching', async () => {
  const id = 'announcement-images/no-receipt.jpg';
  const origin = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
  const data = { buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, Buffer.from('image')]]), newFiles: new Map(),
    sourceRows: { announcements: [{ id: '1', content: `<img src="${origin}/storage/v1/object/public/${id}">` }] },
    externalFiles: new Map([[id, Buffer.from('image')]]), faults: { dropReceipt: true },
  };
  const storage = await startStorage(data);
  try {
    const result = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.match(result.failed[0].reason, /未读回正确的目标迁移凭据/);
    assert.equal(storage.uploads.length, 1);
    assert.equal(transferReport({ result, mode: 'copy' }).readyForLinkSwitch, false);
  } finally { storage.server.close(); }
});

test('the mock fetch maps fake HTTPS projects locally and rejects every unmapped origin', async () => {
  const storage = await startStorage({ buckets: [], oldFiles: new Map(), newFiles: new Map() });
  try {
    for (const url of ['https://example.com/file.jpg', `${SOURCE_URL}.evil.test/rest/v1/announcements`,
      'https://hxpbpqoqkoiiplvdwmld.supabase.co/storage/v1/bucket', 'http://127.0.0.1:1/storage/v1/bucket']) {
      await assert.rejects(storage.fetchImpl(url), /Unmocked network request/);
    }
    await assert.rejects(storage.fetchImpl(`${EXTERNAL_URL}/rest/v1/announcements`), /Unmocked network request/);
    assert.equal(storage.requests.length, 0);
    const response = await storage.fetchImpl(`${SOURCE_URL}/rest/v1/announcements`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    assert.deepEqual(await response.json(), []);
    assert.equal(storage.requests[0].path, '/old/x/rest/v1/announcements');
  } finally { storage.server.close(); }
});

test('only announcement images, videos and posters are processed; 11 broken rich-card images, chats, orphans and private evidence do not block any mode', async () => {
  const referenced = ['announcement-images/notice/image.jpg', 'announcement-images/notice/video.mp4', 'announcement-images/notice/poster.jpg'];
  const brokenRichCards = Array.from({ length: 11 }, (_, i) => `template-images/report-broken/${i + 1}.jpg`);
  const ignored = ['announcement-images/orphans/image.jpg', 'announcement-images/orphans/video.mp4',
    'announcement-images/orphans/poster.jpg', 'chat-images/chat/missing.jpg', 'content-audit-evidence/job/private.json', ...brokenRichCards];
  const oldFiles = new Map();
  const newFiles = new Map();
  for (const id of [...referenced, ...ignored]) {
    const slash = id.indexOf('/');
    const bytes = Buffer.from(`contents:${id}`);
    const missing = brokenRichCards.includes(id) || id === 'chat-images/chat/missing.jpg';
    if (!missing) oldFiles.set(id, bytes);
    newFiles.set(id, { bucket: id.slice(0, slash), path: id.slice(slash + 1), size: bytes.length,
      mime: id.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', bytes: !missing && !referenced.includes(id) ? bytes : null });
  }
  const rows = origin => ({
    announcements: [{ id: 'notice', content: `<img src="${mediaUrl(SOURCE_URL, referenced[0])}"><video src="${mediaUrl(SOURCE_URL, referenced[1])}" poster="${mediaUrl(SOURCE_URL, referenced[2])}"></video>`,
      title: mediaUrl(origin, 'announcement-images/title-only.jpg') }],
    customer_employee_conversations: [{ id: 'chat', message: `<img src="${mediaUrl(origin, 'chat-images/chat/missing.jpg')}">` }],
    rich_card_contents: brokenRichCards.map((id, index) => ({ id: `card-${index}`, content: { html: `<img src="${mediaUrl(origin, id)}">` } })),
    messages: [{ id: 'notification', content: `<img src="${mediaUrl(origin, 'announcement-images/notification-missing.jpg')}">` }],
  });
  const storage = await startStorage({ buckets: [{ id: 'announcement-images', public: true }, { id: 'chat-images', public: true },
    { id: 'template-images', public: true }, { id: 'content-audit-evidence', public: false }], oldFiles, newFiles,
    sourceRows: rows(SOURCE_URL), targetRows: rows(TARGET_URL) });
  const events = [];
  const options = { oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, onEvent: event => events.push(event) };
  try {
    const checked = await runStorageCopy({ ...options, checkOnly: true });
    assert.equal(checked.total, 3);
    assert.equal(checked.missing, 3);
    assert.deepEqual(checked.failed, []);
    assert.equal(storage.uploads.length, 0);
    assert.deepEqual(checked.missingFiles.map(file => `${file.bucket}/${file.path}`).sort(), [...referenced].sort());
    const copied = await runStorageCopy(options);
    assert.equal(copied.copied, 3);
    assert.deepEqual(copied.failed, []);
    assert.equal(transferReport({ result: copied, mode: 'copy' }).readyForLinkSwitch, true);
    const folder = memoryFolder();
    const downloaded = await runStorageDownload({ url: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl });
    assert.equal(downloaded.total, 3);
    assert.equal(downloaded.copied, 3);
    assert.deepEqual(downloaded.failed, []);
    const manifest = JSON.parse(await folder.files.get('storage-manifest.json').text());
    assert.equal(manifest.scope, 'announcements');
    assert.equal(manifest.complete, true);
    assert.deepEqual(manifest.files.map(file => `${file.bucket}/${file.path}`).sort(), [...referenced].sort());
    for (const id of referenced) newFiles.delete(id);
    storage.uploads.length = 0;
    const restored = await runStorageUpload({ newUrl: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl });
    assert.equal(restored.total, 3);
    assert.equal(restored.copied, 3);
    assert.deepEqual(restored.failed, []);
    assert.deepEqual(storage.uploads.map(upload => upload.id).sort(), [...referenced].sort());
    assert.deepEqual([...new Set(events.filter(event => event.type === 'file').map(event => `${event.file.bucket}/${event.file.path}`))].sort(), [...referenced].sort());
    for (const id of ignored) {
      assert(!folder.files.has(`files/${id}`), id);
      assert(!storage.requests.some(request => decodeURIComponent(request.path).endsWith(`/${id}`)), `must not read or upload ${id}`);
    }
    const listings = storage.requests.filter(request => request.path.includes('/object/list/'));
    assert(listings.length > 0);
    assert(listings.every(request => request.path.endsWith('/announcement-images') && ['', 'notice'].includes(request.body.prefix)), 'only descend into referenced buckets/directories');
    const contentRequests = storage.requests.filter(request => request.path.includes('/rest/v1/'));
    assert(contentRequests.every(request => request.path.endsWith('/announcements') && new URLSearchParams(request.search).get('select') === 'id,content'));
    const firstStorage = storage.requests.findIndex(request => request.path.includes('/storage/'));
    assert(storage.requests.slice(0, firstStorage).some(request => request.path.startsWith('/old/x/rest/')));
    assert(storage.requests.slice(0, firstStorage).some(request => request.path.startsWith('/new/x/rest/')));
  } finally { storage.server.close(); }
});

test('announcement references in chat-images and template-images migrate in all modes regardless of bucket names', async () => {
  const ids = ['chat-images/notice/from-chat.jpg', 'template-images/notice/from-template.jpg'];
  const bytes = new Map(ids.map(id => [id, Buffer.from(`announcement:${id}`)]));
  const data = { buckets: [{ id: 'chat-images', public: true }, { id: 'template-images', public: true }], oldFiles: bytes, newFiles: new Map(),
    sourceRows: { announcements: announcementRows(SOURCE_URL, ids) }, targetRows: { announcements: announcementRows(SOURCE_URL, ids) } };
  const storage = await startStorage(data);
  try {
    const options = { oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl };
    const copied = await runStorageCopy(options);
    assert.equal(copied.copied, 2);
    assert.deepEqual(copied.failed, []);
    const folder = memoryFolder();
    const downloaded = await runStorageDownload({ url: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl });
    assert.equal(downloaded.copied, 2);
    assert.deepEqual(downloaded.failed, []);
    for (const id of ids) assert.deepEqual(await bytesOf(folder.files.get(`files/${id}`)), bytes.get(id));
    data.newFiles.clear();
    storage.uploads.length = 0;
    const restored = await runStorageUpload({ newUrl: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl });
    assert.equal(restored.copied, 2);
    assert.deepEqual(restored.failed, []);
    assert.deepEqual(storage.uploads.map(upload => upload.id).sort(), [...ids].sort());
  } finally { storage.server.close(); }
});

for (const version of [1, 2]) {
  test(`legacy whole-site v${version} backups upload only the target's current announcement subset`, async () => {
    const selected = ['announcement-images/current/image.jpg', 'template-images/current/poster.jpg'];
    const excluded = ['announcement-images/current/orphan.jpg', 'announcement-images/removed-notice.jpg',
      'chat-images/chat/only.jpg', 'template-images/cards/only.jpg', 'content-audit-evidence/job/private.json'];
    const contents = new Map([...selected, ...excluded].map(id => [id, Buffer.from(`backup:${id}`)]));
    const files = [...contents].map(([id, bytes]) => ({ bucket: id.slice(0, id.indexOf('/')), path: id.slice(id.indexOf('/') + 1),
      size: bytes.length, mime: 'image/jpeg', ...(version === 2 ? { downloaded: selected.includes(id), sha256: selected.includes(id) ? sha256(bytes) : null } : {}) }));
    const manifest = { format: 'supabase-storage-backup', version, project: SOURCE_URL, files };
    const folder = memoryFolder(Object.fromEntries([['storage-manifest.json', JSON.stringify(manifest)], ...[...contents].map(([id, bytes]) => [`files/${id}`, bytes])]));
    const newFiles = new Map(files.filter(file => excluded.includes(`${file.bucket}/${file.path}`)).map(file => [`${file.bucket}/${file.path}`, { ...file, bytes: contents.get(`${file.bucket}/${file.path}`) }]));
    const storage = await startStorage({ buckets: [...new Set(files.map(file => file.bucket))].map(id => ({ id, public: id !== 'content-audit-evidence' })),
      oldFiles: new Map(), newFiles, sourceRows: { announcements: announcementRows(SOURCE_URL, [...selected, ...excluded.filter(id => !id.startsWith('content-audit-evidence/'))]) },
      targetRows: { announcements: announcementRows(SOURCE_URL, selected),
        customer_employee_conversations: [{ id: 'chat', message: mediaUrl(SOURCE_URL, excluded[2]) }],
        rich_card_contents: [{ id: 'card', content: { html: mediaUrl(SOURCE_URL, excluded[3]) } }] } });
    try {
      const options = { newUrl: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl };
      const checked = await runStorageUpload({ ...options, checkOnly: true });
      assert.equal(checked.total, 2);
      assert.equal(checked.missing, 2);
      assert.deepEqual(checked.failed, []);
      assert.equal(storage.uploads.length, 0);
      assert.deepEqual(folder.reads, ['storage-manifest.json']);
      const restored = await runStorageUpload(options);
      assert.equal(restored.total, 2);
      assert.equal(restored.copied, 2);
      assert.deepEqual(restored.failed, []);
      assert.deepEqual(storage.uploads.map(upload => upload.id).sort(), [...selected].sort());
      for (const id of selected) {
        assert.deepEqual(newFiles.get(id).bytes, contents.get(id));
        assert.equal(newFiles.get(id).user_metadata.storageMigration.target, TARGET_URL);
      }
      for (const id of excluded) {
        assert(!folder.reads.includes(`files/${id}`), `must not read excluded backup ${id}`);
        assert(!storage.requests.some(request => decodeURIComponent(request.path).endsWith(`/${id}`)), `must not touch excluded target ${id}`);
        assert.deepEqual(newFiles.get(id).bytes, contents.get(id));
      }
      assert.equal((await runStorageUpload(options)).present, 2);
      assert.equal(storage.uploads.length, 2, 'rerunning does not overwrite identical files');
    } finally { storage.server.close(); }
  });
}

test('zero announcements produce successful zero-file copy, download and legacy v1/v2 upload results, never falling back to all Storage files', async () => {
  const data = sourceProject();
  data.sourceRows = { announcements: [], rich_card_contents: [{ id: 'broken-card', content: mediaUrl(SOURCE_URL, 'template-images/missing.jpg') }] };
  data.targetRows = { announcements: [], messages: [{ id: 'broken-message', content: mediaUrl(TARGET_URL, 'chat-images/missing.jpg') }] };
  const storage = await startStorage(data);
  const assertEmpty = result => {
    assert.equal(result.total, 0);
    assert.equal(result.present, 0);
    assert.equal(result.copied, 0);
    assert.equal(result.missing, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(result.stopped, false);
  };
  try {
    const copyOptions = { oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl };
    assertEmpty(await runStorageCopy(copyOptions));
    assertEmpty(await runStorageCopy({ ...copyOptions, checkOnly: true }));
    const folder = memoryFolder();
    assertEmpty(await runStorageDownload({ url: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl, checkOnly: true }));
    assert.deepEqual(folder.writes, []);
    assertEmpty(await runStorageDownload({ url: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl }));
    const manifest = JSON.parse(await folder.files.get('storage-manifest.json').text());
    assert.equal(manifest.scope, 'announcements');
    assert.equal(manifest.complete, true);
    assert.deepEqual(manifest.files, []);
    assert.deepEqual(manifest.buckets, []);
    const legacyFiles = [...data.newFiles.values()].map(({ bucket, path, size }) => ({ bucket, path, size }));
    for (const version of [1, 2]) {
      const legacyFolder = memoryFolder({ 'storage-manifest.json': JSON.stringify({ format: 'supabase-storage-backup', version, files: legacyFiles }) });
      const options = { newUrl: storage.newUrl, key: KEY, folder: legacyFolder, fetchImpl: storage.fetchImpl };
      assertEmpty(await runStorageUpload({ ...options, checkOnly: true }));
      const uploaded = await runStorageUpload(options);
      assertEmpty(uploaded);
      assert.deepEqual(legacyFolder.reads, ['storage-manifest.json', 'storage-manifest.json']);
      const report = transferReport({ result: uploaded, mode: 'upload' });
      assert.equal(report.scope, 'announcements');
      assert.equal(report.readyForLinkSwitch, true);
    }
    assert.equal(storage.uploads.length, 0);
    assert(!storage.requests.some(request => request.path.includes('/object/')));
    assert(storage.requests.filter(request => request.path.includes('/rest/v1/')).every(request => request.path.endsWith('/announcements')));
  } finally { storage.server.close(); }
});

test('same-path origins with identical bytes are accepted while divergent files are blocked individually', async () => {
  const sameId = 'announcement-images/mixed/same.jpg';
  const conflictId = 'announcement-images/mixed/conflict.jpg';
  const sameBytes = Buffer.from('same object from both origins');
  const sourceConflictBytes = Buffer.from('source version');
  const externalConflictBytes = Buffer.from('different external version');
  const sourceRows = { announcements: announcementRows(SOURCE_URL, [sameId, conflictId]) };
  const targetRows = { announcements: [
    { id: 'target-same', content: `<img src="${mediaUrl(EXTERNAL_URL, sameId)}">` },
    { id: 'target-conflict', content: `<img src="${mediaUrl(EXTERNAL_URL, conflictId)}">` },
  ] };
  const data = { buckets: [{ id: 'announcement-images', public: true }],
    oldFiles: new Map([[sameId, sameBytes], [conflictId, sourceConflictBytes]]), newFiles: new Map(), sourceRows, targetRows,
    externalFiles: new Map([[sameId, sameBytes], [conflictId, externalConflictBytes]]) };
  const storage = await startStorage(data);
  try {
    const options = { oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl };
    const checked = await runStorageCopy({ ...options, checkOnly: true });
    assert.equal(checked.total, 2);
    assert.equal(checked.missing, 1);
    assert.equal(checked.failed.length, 1);
    assert.equal(checked.failed[0].failureType, 'source_content_conflict');
    assert.match(checked.failed[0].reason, /公告 ID：/);
    assert.equal(storage.uploads.length, 0);

    const copied = await runStorageCopy(options);
    assert.equal(copied.copied, 1);
    assert.equal(copied.failed.length, 1);
    assert.equal(copied.failed[0].failureType, 'source_content_conflict');
    assert.deepEqual(storage.uploads.map(upload => upload.id), [sameId]);
    assert.deepEqual(data.newFiles.get(sameId).bytes, sameBytes);
    assert.equal(data.newFiles.has(conflictId), false);
    assert.equal((await runStorageCopy({ ...options, checkOnly: true })).present, 1);
  } finally { storage.server.close(); }
});

test('a missing candidate source blocks a multi-origin file instead of choosing another copy', async () => {
  const id = 'announcement-images/mixed/unavailable.jpg';
  const bytes = Buffer.from('available copy');
  const sourceRows = { announcements: announcementRows(SOURCE_URL, [id]) };
  const targetRows = { announcements: announcementRows(EXTERNAL_URL, [id]) };
  const storage = await startStorage({ buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, bytes]]), newFiles: new Map(),
    sourceRows, targetRows });
  try {
    const checked = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY,
      fetchImpl: storage.fetchImpl, checkOnly: true });
    assert.equal(checked.missing, 0);
    assert.equal(checked.failed.length, 1);
    assert.equal(checked.failed[0].failureType, 'source_download_error');
    assert.match(checked.failed[0].reason, /来源无法完整核实/);
    assert.equal(storage.uploads.length, 0);
  } finally { storage.server.close(); }
});

test('duplicate origins within one project are compared as files instead of aborting discovery', async () => {
  const id = 'announcement-images/mixed/duplicate.jpg';
  const bytes = Buffer.from('identical duplicate references');
  const storage = await startStorage({ buckets: [{ id: 'announcement-images', public: true }], oldFiles: new Map([[id, bytes]]), newFiles: new Map(),
    sourceRows: { announcements: [
      { id: 'same-origin-1', content: `<img src="${mediaUrl(SOURCE_URL, id)}">` },
      { id: 'same-origin-2', content: `<img src="${mediaUrl(SOURCE_URL, id)}">` },
    ] } });
  try {
    const checked = await runStorageDownload({ url: storage.oldUrl, key: KEY, folder: memoryFolder(), fetchImpl: storage.fetchImpl, checkOnly: true });
    assert.equal(checked.total, 1);
    assert.equal(checked.missing, 1);
    assert.deepEqual(checked.failed, []);
  } finally { storage.server.close(); }
});

for (const version of [1, 2]) {
  for (const provenance of ['wrong sourceUrl origin', 'wrong sourceUrl path', 'wrong manifest project', 'missing manifest project']) {
    test(`v${version} backup source mismatch (${provenance}) blocks a foreign announcement reference without uploading`, async () => {
      const file = { bucket: 'announcement-images', path: 'origin/shared.jpg' };
      const id = `${file.bucket}/${file.path}`;
      const bytes = Buffer.from('unrelated backup at the same bucket and path');
      const referenceUrl = mediaUrl(EXTERNAL_URL, id);
      const sourceUrl = provenance === 'wrong sourceUrl origin' ? mediaUrl(SOURCE_URL, id)
        : provenance === 'wrong sourceUrl path' ? mediaUrl(EXTERNAL_URL, 'announcement-images/origin/other.jpg') : undefined;
      // A matching manifest.project must not override a conflicting per-file sourceUrl.
      const project = sourceUrl ? EXTERNAL_URL : provenance === 'missing manifest project' ? undefined : SOURCE_URL;
      const folder = singleFileBackup({ version, project, file: { ...file, sourceUrl }, bytes });
      const newFiles = new Map();
      const storage = await startStorage({ buckets: [{ id: file.bucket, public: true }], oldFiles: new Map(), newFiles,
        targetRows: { announcements: [{ id: 'foreign-notice', content: `<img src="${referenceUrl}">` }] } });
      try {
        const options = { newUrl: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl };
        const checked = await runStorageUpload({ ...options, checkOnly: true });
        const uploaded = await runStorageUpload(options);
        assert.equal(storage.uploads.length, 0, 'a foreign same-path backup must never be uploaded');
        assert.equal(newFiles.has(id), false);
        for (const result of [checked, uploaded]) {
          assert.equal(result.total, 1);
          assert.equal(result.present, 0);
          assert.equal(result.copied, 0);
          assert.equal(result.missing, 0, 'source mismatch is a blocking issue, not pending work');
          assert.equal(result.failed.length, 1);
          assert.equal(result.failed[0].failureType, 'backup_source_mismatch');
          assert.match(result.failed[0].reason, /来源.*不一致/);
          const report = transferReport({ result, mode: 'upload', source: project, target: storage.newUrl });
          assert.equal(report.readyForLinkSwitch, false);
          assert.equal(report.failures[0].failureType, 'backup_source_mismatch');
        }
      } finally { storage.server.close(); }
    });
  }

  for (const provenance of ['matching manifest origin', 'normalized per-file sourceUrl']) {
    test(`v${version} backup restores foreign announcement media with ${provenance}`, async () => {
      const file = { bucket: 'announcement-images', path: 'origin/图片 one.jpg' };
      const id = `${file.bucket}/${file.path}`;
      const bytes = Buffer.from('verified bytes from the referenced media origin');
      const referenceUrl = mediaUrl(EXTERNAL_URL, id);
      // Equivalent path encodings are the same source; a cross-site backup belongs to the
      // project whose announcements were backed up, not necessarily the media's origin.
      const sourceUrl = provenance === 'normalized per-file sourceUrl'
        ? `${EXTERNAL_URL}/storage/v1/object/public/announcement-images/origin/图片%20%6fne.jpg` : undefined;
      const project = sourceUrl ? SOURCE_URL : EXTERNAL_URL;
      const folder = singleFileBackup({ version, project, file: { ...file, sourceUrl }, bytes });
      const newFiles = new Map();
      const storage = await startStorage({ buckets: [{ id: file.bucket, public: true }], oldFiles: new Map(), newFiles,
        targetRows: { announcements: [{ id: 'foreign-notice', content: `<img src="${referenceUrl}">` }] } });
      try {
        const options = { newUrl: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl };
        const checked = await runStorageUpload({ ...options, checkOnly: true });
        assert.equal(checked.total, 1);
        assert.equal(checked.missing, 1);
        assert.deepEqual(checked.failed, []);
        assert.equal(storage.uploads.length, 0);
        const restored = await runStorageUpload(options);
        assert.equal(restored.copied, 1);
        assert.deepEqual(restored.failed, []);
        assert.deepEqual(newFiles.get(id).bytes, bytes);
        assert.equal(newFiles.get(id).user_metadata.storageMigration.target, TARGET_URL);
        assert.equal(transferReport({ result: restored, mode: 'upload' }).readyForLinkSwitch, true);
        assert.equal((await runStorageUpload(options)).present, 1);
        assert.equal(storage.uploads.length, 1, 'identical bytes and a valid receipt are not overwritten');
      } finally { storage.server.close(); }
    });
  }

  test(`v${version} old-origin backup still restores target-native links after migration and compares existing hashes`, async () => {
    const file = { bucket: 'announcement-images', path: 'origin/migrated.jpg' };
    const id = `${file.bucket}/${file.path}`;
    const bytes = Buffer.from('old');
    const folder = singleFileBackup({ version, project: SOURCE_URL, file: { ...file, sourceUrl: mediaUrl(EXTERNAL_URL, id) }, bytes });
    const newFiles = new Map();
    const storage = await startStorage({ buckets: [{ id: file.bucket, public: true }], oldFiles: new Map(), newFiles,
      targetRows: { announcements: announcementRows(TARGET_URL, [id]) } });
    try {
      const options = { newUrl: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl };
      const restored = await runStorageUpload(options);
      assert.equal(restored.copied, 1, 'target-native links may restore an older same-path backup');
      assert.deepEqual(restored.failed, []);
      assert.deepEqual(newFiles.get(id).bytes, bytes);
      const same = await runStorageUpload(options);
      assert.equal(same.present, 1);
      assert.deepEqual(same.failed, []);
      assert.equal(storage.uploads.length, 1);
      newFiles.get(id).bytes = Buffer.from('bad');
      const conflict = await runStorageUpload(options);
      assert.equal(conflict.copied, 0);
      assert.equal(conflict.failed.length, 1);
      assert.match(conflict.failed[0].reason, /内容不同.*拒绝覆盖/);
      assert.equal(storage.uploads.length, 1, 'the native-link exception must not bypass content hashes');
      assert.equal(newFiles.get(id).bytes.toString(), 'bad');
    } finally { storage.server.close(); }
  });
}

for (const targetPresent of [false, true]) {
  test(`cross-project announcement copy ignores unrelated source metadata at the same path (target ${targetPresent ? 'present' : 'absent'})`, async () => {
    const file = { bucket: 'announcement-images', path: 'collision/external.jpg' };
    const id = `${file.bucket}/${file.path}`;
    const externalBytes = Buffer.from('external announcement image');
    const localBytes = Buffer.from('unrelated local object with a different and much larger file size');
    assert.notEqual(localBytes.length, externalBytes.length);
    const newFiles = new Map([[id, { ...file, size: externalBytes.length, mime: 'application/pdf', cache: 'no-cache',
      bytes: targetPresent ? externalBytes : null,
      user_metadata: { storageMigration: { target: TARGET_URL, bytes: externalBytes.length, sha256: sha256(externalBytes), version: 3 } } }]]);
    const storage = await startStorage({ buckets: [{ id: file.bucket, public: true }], oldFiles: new Map([[id, localBytes]]), newFiles,
      sourceRows: { announcements: announcementRows(EXTERNAL_URL, [id]) }, externalFiles: new Map([[id, externalBytes]]) });
    try {
      const options = { oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl };
      const checked = await runStorageCopy({ ...options, checkOnly: true });
      const copied = await runStorageCopy(options);
      assert.deepEqual(checked.failed, []);
      assert.deepEqual(copied.failed, []);
      assert.equal(checked.total, 1);
      assert.equal(checked.present, targetPresent ? 1 : 0);
      assert.equal(checked.missing, targetPresent ? 0 : 1);
      assert.equal(copied.present, targetPresent ? 1 : 0);
      assert.equal(copied.copied, targetPresent ? 0 : 1);
      assert.deepEqual(newFiles.get(id).bytes, externalBytes);
      assert.equal(storage.uploads.length, targetPresent ? 0 : 1);
      if (!targetPresent) assert.equal(storage.uploads[0].headers['content-type'], 'image/jpeg', 'unrelated source MIME must not leak into the copied file');
      assert(!storage.requests.some(request => request.path.startsWith('/old/x/storage/v1/object/')
        && /\/object\/(public|authenticated|info)\//.test(request.path)), 'never read the unrelated local same-path file');
      assert(storage.requests.some(request => request.path === `/external/${id}`));
    } finally { storage.server.close(); }
  });
}

for (const project of ['source', 'target']) {
  test(`cross-project announcement download ignores ${project} project same-path size and MIME`, async () => {
    const file = { bucket: 'announcement-images', path: 'collision/external.jpg' };
    const id = `${file.bucket}/${file.path}`;
    const externalBytes = Buffer.from('external announcement image');
    const localBytes = Buffer.from('unrelated local file, deliberately a different size');
    const newFiles = new Map([[id, { ...file, size: localBytes.length, mime: 'application/pdf', cache: 'no-cache', bytes: localBytes }]]);
    const storage = await startStorage({ buckets: [{ id: file.bucket, public: true }], oldFiles: new Map([[id, localBytes]]), newFiles,
      sourceRows: { announcements: announcementRows(EXTERNAL_URL, [id]) }, targetRows: { announcements: announcementRows(EXTERNAL_URL, [id]) },
      externalFiles: new Map([[id, externalBytes]]) });
    const folder = memoryFolder();
    try {
      const url = project === 'source' ? storage.oldUrl : storage.newUrl;
      const options = { url, key: KEY, folder, fetchImpl: storage.fetchImpl };
      const checked = await runStorageDownload({ ...options, checkOnly: true });
      assert.equal(checked.total, 1);
      assert.equal(checked.missing, 1);
      assert.deepEqual(checked.failed, []);
      assert.deepEqual(folder.writes, []);
      const downloaded = await runStorageDownload(options);
      assert.equal(downloaded.total, 1);
      assert.equal(downloaded.copied, 1);
      assert.deepEqual(downloaded.failed, []);
      assert.deepEqual(await bytesOf(folder.files.get(`files/${id}`)), externalBytes);
      const manifest = JSON.parse(await folder.files.get('storage-manifest.json').text());
      assert.equal(manifest.complete, true);
      assert.equal(manifest.files.length, 1);
      assert.equal(manifest.files[0].sourceUrl, mediaUrl(EXTERNAL_URL, id));
      assert.equal(manifest.files[0].size, externalBytes.length);
      assert.equal(manifest.files[0].mime, 'image/jpeg');
      assert.equal(manifest.files[0].sha256, sha256(externalBytes));
      assert.equal((await runStorageDownload(options)).present, 1);
      assert(!storage.requests.some(request => /\/(old|new)\/x\/storage\/v1\/object\/(public|authenticated|info)\//.test(request.path)), 'only the external media origin may supply these bytes');
      assert.equal(storage.uploads.length, 0);
      assert.deepEqual(newFiles.get(id).bytes, localBytes);
    } finally { storage.server.close(); }
  });
}

for (const mode of ['copy', 'upload', 'transfer']) {
  test(`${mode} must invalidate a stale target receipt after POST when missing bytes are restored but the server drops the new receipt`, async () => {
    const file = { bucket: 'announcement-images', path: 'receipt/stale.jpg' };
    const id = `${file.bucket}/${file.path}`;
    const bytes = Buffer.from('restored announcement bytes');
    const newFiles = new Map([[id, { ...file, size: bytes.length, mime: 'image/jpeg', bytes: null,
      user_metadata: { storageMigration: { target: TARGET_URL, bytes: bytes.length, version: 2 } } }]]);
    const faults = { dropReceipt: true };
    // The target has an old valid receipt but no bytes. Upload still references the
    // foreign origin (and needs a receipt); direct transfer explicitly seeds that cache.
    const storage = await startStorage({ buckets: [{ id: file.bucket, public: true }], oldFiles: new Map([[id, bytes]]), newFiles,
      sourceRows: { announcements: announcementRows(SOURCE_URL, [id]) },
      targetRows: { announcements: announcementRows(mode === 'upload' ? SOURCE_URL : TARGET_URL, [id]) }, faults });
    const folder = singleFileBackup({ version: 2, project: SOURCE_URL, file: { ...file, sourceUrl: mediaUrl(SOURCE_URL, id) }, bytes });
    const transfer = () => mode === 'copy'
      ? runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl })
      : mode === 'upload'
        ? runStorageUpload({ newUrl: storage.newUrl, key: KEY, folder, fetchImpl: storage.fetchImpl })
        : runTransfer({ newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl,
          files: [{ ...file, size: bytes.length, mime: 'image/jpeg', bucketPublic: true, requiresReceipt: true, targetVerified: true }],
          getBlob: async () => new Blob([bytes], { type: 'image/jpeg' }) });
    try {
      const result = await transfer();
      assert.equal(storage.uploads.length, 1);
      assert.deepEqual(newFiles.get(id).bytes, bytes);
      assert.equal(newFiles.get(id).user_metadata, null, 'the server really discarded the post-upload receipt');
      assert.equal(result.total, 1);
      assert.equal(result.copied, 0, 'restoring the bytes alone must not count as successful migration');
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0].reason, /未读回正确的目标迁移凭据/);
      assert.equal(result.failed[0].targetVerified, false);
      assert.equal(transferReport({ result, mode: mode === 'transfer' ? 'copy' : mode }).readyForLinkSwitch, false);
      const uploadIndex = storage.requests.findIndex(request => request.method === 'POST' && request.path === `/new/x/storage/v1/object/${id}`);
      assert(uploadIndex >= 0);
      assert(storage.requests.slice(uploadIndex + 1).some(request => request.path === `/new/x/storage/v1/object/info/${id}`), 'read back fresh metadata after POST, never trust the old in-memory receipt');
    } finally { storage.server.close(); }
  });
}

test('stopping halts further copies and the rest can be finished by rerunning', async () => {
  const data = fixture();
  const storage = await startStorage(data);
  try {
    const controller = new AbortController();
    let copied = 0;
    const result = await runStorageCopy({
      oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl, signal: controller.signal,
      onEvent(event) { if (event.outcome === 'copied' && ++copied === 10) controller.abort(); },
    });
    assert.equal(result.stopped, true);
    assert.ok(result.copied >= 10 && result.copied < 232, `copied ${result.copied}`);
    const resumed = await runStorageCopy({ oldUrl: storage.oldUrl, sourceKey: KEY, newUrl: storage.newUrl, key: KEY, fetchImpl: storage.fetchImpl });
    assert.equal(resumed.present + resumed.copied, 233);
    assert.equal(resumed.failed.length, 1);
  } finally {
    storage.server.close();
  }
});
