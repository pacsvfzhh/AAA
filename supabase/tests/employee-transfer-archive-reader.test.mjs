import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TRANSFER_PRODUCTION_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const TABLES = ['content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications',
  'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals'];
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(1), PACKAGE = id(2), SESSION = id(3), PRECISE = '12345678901234567890.12345678901234567890';
const sha = raw => createHash('sha256').update(raw).digest('hex');
const counts = () => Object.fromEntries(TABLES.map(key => [key, 1]));
const source = (n = 1) => ({ source_site_id: id(n), package_id: PACKAGE,
  imported_at: '2024-02-29T23:34:56.123456+00:00', counts: counts(), media_pending: true });
const namespaces = (items = [source()], next_after = null) => ({ items, next_after });
function row(key, n = 10) {
  if (key === TABLES[4]) return { id: id(n), employee_id: id(9), source_present: false, is_verified: null,
    total_income: 0, available_balance: null, frozen_balance: 0, total_orders: '9223372036854775807' };
  if (key === TABLES[5]) return { id: `${id(9)}:${id(n)}`, record_id: id(9), withdrawal_id: id(n), employee_id: id(9),
    amount: 0, status: 'approved', created_at: '2024-02-29T23:34:56.123456Z' };
  const columns = TRANSFER_PRODUCTION_COVERAGE_INVENTORY.find(t => t.schema === 'private' && t.name === key).columns;
  const result = Object.fromEntries(columns.map(c => [c.name, c.nullable ? null : ({ uuid: id(n), text: '<img src=x onerror=alert(1)>',
    jsonb: { text: '<script>alert(1)</script>', precise: 0 }, 'timestamp with time zone': '2024-02-29T23:34:56.123456Z' })[c.type]]));
  if (key === TABLES[0]) Object.assign(result, { before_data_sql_null: true, after_data_sql_null: true });
  if (key === TABLES[2]) Object.assign(result, { message_data_sql_null: true, recipient_data_sql_null: true });
  if (key === TABLES[3]) result.id = `${result.message_id}:${result.recipient_id}`;
  return result;
}
const line = (key, n = 10) => JSON.stringify(row(key, n)).replaceAll('"precise":0', `"precise":${PRECISE}`)
  .replaceAll('"amount":0', `"amount":${PRECISE}`).replaceAll('"total_income":0', `"total_income":${PRECISE}`) + '\n';
const page = (key, raw = line(key), next_after = null) => ({ table_key: key, count: raw ? raw.split('\n').length - 1 : 0,
  ndjson: raw, next_after, sha256: sha(raw) });
mock.method(globalThis, 'fetch', () => assert.fail('All network/production/Storage access is prohibited'));
after(() => mock.restoreAll());
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/archiveReader.ts';
  export {default as Panel, TestRowSummary, TestSourceIdentity, TestPager, TestArchiveRow, TestArchiveAttachment} from './src/components/admin/TransferredArchivesPanel.tsx';
  export {setHarness} from 'reader-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2020', jsx: 'automatic', metafile: true,
  plugins: [{ name: 'isolated-reader', setup(builder) {
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|lucide-react)$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    builder.onResolve({ filter: /\/archiveMedia$/ }, () => ({ path: 'reader-test:media', namespace: 'reader-test' }));
    builder.onResolve({ filter: /^(reader-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'reader-test' }));
    builder.onLoad({ filter: /TransferredArchivesPanel\.tsx$/ }, async args => ({ loader: 'tsx', contents:
      await readFile(args.path, 'utf8') + '\nexport {RowSummary as TestRowSummary, SourceIdentity as TestSourceIdentity, Pager as TestPager, ArchiveRow as TestArchiveRow, ArchiveAttachment as TestArchiveAttachment};' }));
    builder.onLoad({ filter: /.*/, namespace: 'reader-test' }, ({ path }) => {
      if (path === 'reader-test:state') return { contents: 'let h;export const setHarness=v=>{h=v};export const current=()=>h;' };
      if (path === 'reader-test:media') return { contents: `import{current}from'reader-test:state';export function readArchiveMedia(...args){return current().mediaLoader(...args);}` };
      if (path === '../auth') return { contents: `import{current}from'reader-test:state';export function getAdminFinancialSessionToken(){const h=current();h.reads++;return h.session;}` };
      return { contents: `import{current}from'reader-test:state';export const supabase={rpc:(...args)=>current().rpc(...args)};` };
    });
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness() {
  const h = { session: SESSION, reads: 0, calls: [], mediaLoader: () => assert.fail('No implicit media read'), reply: namespaces(), error: null, wait: null, rpc(name, args) {
    assert.ok(['get_employee_transferred_archive_namespaces', 'get_employee_transferred_archive_page'].includes(name));
    const call = { name, args, signal: null }; h.calls.push(call);
    const q = { abortSignal(s) { call.signal = s; return q; }, then(resolve, reject) {
      return (h.wait ?? Promise.resolve({ data: h.reply, error: h.error })).then(resolve, reject);
    } }; return q;
  } }; api.setHarness(h); return h;
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('reader bundles no real authentication, Supabase client or media transport', () => {
  assert.equal(Object.keys(compiled.metafile.inputs).some(p => /src\/lib\/(?:auth|supabase)\.ts/.test(p)), false);
  assert.deepEqual(Object.keys(api.createTransferredArchivesReader()).sort(), ['namespaces', 'page']);
});
test('namespace RPC reads a fresh session for each request and passes cursor, limit and abort signal', async () => {
  const h = harness(), reader = api.createTransferredArchivesReader(), controller = new AbortController();
  assert.deepEqual(await reader.namespaces(null, 30, controller.signal), namespaces());
  assert.equal(h.calls[0].name, 'get_employee_transferred_archive_namespaces');
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_after: null, p_limit: 30 });
  assert.equal(h.calls[0].signal, controller.signal);
  h.session = id(4); h.reply = namespaces([]); await reader.namespaces(`${SITE}:${PACKAGE}`, 1);
  assert.equal(h.calls[1].args.p_admin_session_token, id(4)); assert.equal(h.reads, 2);
});
for (const key of TABLES) test(`${key}: validates real six-table shape and preserves original bytes, ID and NDJSON`, async () => {
  const h = harness(), reader = api.createTransferredArchivesReader(), raw = line(key); h.reply = page(key, raw);
  const result = await reader.page(SITE, PACKAGE, key);
  assert.equal(result.ndjson, raw); assert.equal(result.rows[0].sourceLine, raw);
  assert.equal(result.rows[0].sourceId, row(key).id); assert.equal(result.sha256, sha(raw));
  assert.equal(Object.isFrozen(result.rows[0]), true);
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_source_site_id: SITE,
    p_package_id: PACKAGE, p_table_key: key, p_after: null, p_limit: 100 });
});
for (const mutate of [p => { p.sha256 = 'a'.repeat(64); }, p => { p.count++; }, p => { p.next_after = id(99); },
  p => { p.table_key = TABLES[1]; }, p => { p.ndjson = p.ndjson.trim(); p.sha256 = sha(p.ndjson); },
  p => { p.ndjson += p.ndjson; p.sha256 = sha(p.ndjson); p.count = 2; }]) {
  test(`row receipt rejects corrupted hash/count/cursor/order/line contract ${mutate.toString()}`, () => {
    const p = page(TABLES[0]); mutate(p); assert.throws(() => api.validateTransferredArchivePage(p, TABLES[0]));
  });
}
test('row pages enforce requested limit, nonrepeating after and next cursor with byte-limited short pages', () => {
  const key = TABLES[4], raw = line(key), p = page(key, raw, id(10));
  assert.equal(api.validateTransferredArchivePage(p, key, null, 100).next_after, id(10));
  assert.throws(() => api.validateTransferredArchivePage(p, key, id(10)));
  const two = page(key, raw + line(key, 11)); assert.throws(() => api.validateTransferredArchivePage(two, key, null, 1));
  assert.equal(api.validateTransferredArchivePage(page(key, ''), key).count, 0);
});
for (const mutate of [p => { p.items[0].source_site_id = 'not-a-uuid'; }, p => { p.items[0].media_pending = 'false'; },
  p => { p.items[0].counts.content_audit_events = 9007199254740992; }, p => { delete p.items[0].counts.deleted_employee_summaries; },
  p => { p.items[0].imported_at = '2024-01-01'; }, p => { p.next_after = `${id(99)}:${PACKAGE}`; },
  p => { p.items.push(p.items[0]); }, p => { p.secret = 'unexpected'; }]) {
  test(`namespace contract rejects malformed receipt ${mutate.toString()}`, () => {
    const p = namespaces(); mutate(p); assert.throws(() => api.validateTransferredArchiveNamespaces(p));
  });
}
test('namespace pages enforce C ordering, canonical cursor, next cursor and exact requested page size', () => {
  const items = [source(1), source(2)], after = `${id(2)}:${PACKAGE}`;
  assert.deepEqual(api.validateTransferredArchiveNamespaces(namespaces(items, after), null, 2).items, items);
  assert.throws(() => api.validateTransferredArchiveNamespaces(namespaces(items.reverse()), null, 2));
  assert.throws(() => api.validateTransferredArchiveNamespaces(namespaces([source()]), `${SITE}:${PACKAGE}`));
  assert.throws(() => api.validateTransferredArchiveNamespaces(namespaces(), null, 0));
  assert.throws(() => api.validateTransferredArchiveNamespaces(namespaces(), null, 101));
});
test('invalid inputs cannot dispatch RPCs; backend errors are redacted without retry', async () => {
  const h = harness(), reader = api.createTransferredArchivesReader();
  for (const action of [() => reader.namespaces('broken'), () => reader.namespaces(null, 0),
    () => reader.page(SITE, PACKAGE, 'users'), () => reader.page(SITE, PACKAGE, TABLES[0], 'broken')]) await assert.rejects(action());
  assert.equal(h.calls.length, 0);
  h.error = { message: 'secret-backend-raw-token' };
  await assert.rejects(reader.namespaces(), error => !String(error).includes('secret-backend-raw-token') && !('cause' in error));
  assert.equal(h.calls.length, 1);
});
test('pre-abort and mid-read cancellation discard responses without automatic retry or cancel-job call', async () => {
  const h = harness(), reader = api.createTransferredArchivesReader(); const before = new AbortController(); before.abort();
  await assert.rejects(reader.namespaces(null, 30, before.signal), { name: 'AbortError' }); assert.equal(h.calls.length, 0);
  let resolve; h.wait = new Promise(yes => { resolve = yes; }); const during = new AbortController();
  const pending = reader.namespaces(null, 30, during.signal); await new Promise(yes => setImmediate(yes)); during.abort();
  await assert.rejects(pending, { name: 'AbortError' }); resolve({ data: namespaces(), error: null });
  assert.equal(h.calls.length, 1);
});
test('UI initial contract is read-only and does not fetch on SSR or expose old attachment links', () => {
  const h = harness(); const html = render(api.Panel);
  for (const text of ['超級管理員唯讀', '來源站', '來源包', '附件待核驗', '不與新站在職帳戶或財務資料串聯', '來源上一頁', '來源下一頁']) assert.ok(html.includes(text), text);
  assert.equal(h.calls.length, 0); assert.doesNotMatch(html, /<(?:a|iframe|video)\b|dangerouslySetInnerHTML/);
});
test('UI identifies site/package and formats import and historical time as UTC+8', () => {
  const html = render(api.TestSourceIdentity, { source: source() });
  assert.ok(html.includes(SITE)); assert.ok(html.includes(PACKAGE)); assert.match(html, /2024\/03\/01\s+07:34:56 \(UTC\+8\)/);
  const summary = render(api.TestRowSummary, { row: { sourceId: row(TABLES[5]).id, sourceLine: line(TABLES[5]) }, tableKey: TABLES[5] });
  assert.ok(summary.includes('UTC+8')); assert.equal(summary.includes('1234567890'), false, 'no rounded financial summary');
});
test('UI summaries escape hostile HTML; original precision, SQL-null markers and source line remain untouched', () => {
  const raw = line(TABLES[0]); const checked = api.validateTransferredArchivePage(page(TABLES[0], raw), TABLES[0]);
  const html = render(api.TestRowSummary, { row: checked.rows[0], tableKey: TABLES[0] });
  assert.ok(html.includes('&lt;img')); assert.doesNotMatch(html, /<img|<script/);
  assert.equal(checked.rows[0].sourceLine, raw); assert.ok(raw.includes('"before_data_sql_null":true'));
  for (const key of [TABLES[4], TABLES[5]]) assert.ok(api.validateTransferredArchivePage(page(key), key).rows[0].sourceLine.includes(PRECISE));
});
for (const key of TABLES) test(`${key}: actual expandable row renders ORIGINAL text safely without amount/ID reserialization`, () => {
  const raw = line(key), checked = api.validateTransferredArchivePage(page(key, raw), key);
  const html = render(api.TestArchiveRow, { row: checked.rows[0], tableKey: key });
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1];
  const decoded = pre.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  assert.equal(decoded, raw);
  assert.doesNotMatch(html, /<(?:script|img|iframe|a)\b/);
  assert.match(html, /<details/); assert.match(html, /來源原始行/);
});
test('numeric values outside JS float range are retained as raw numeric tokens, not Infinity or null', () => {
  const key = TABLES[5], raw = line(key).replace(PRECISE, '1e400');
  const checked = api.validateTransferredArchivePage(page(key, raw), key);
  const html = render(api.TestArchiveRow, { row: checked.rows[0], tableKey: key });
  assert.ok(html.includes('1e400')); assert.equal(html.includes('Infinity'), false); assert.equal(checked.ndjson, raw);
});
test('UI pager preserves confirmed page on error, exposes explicit retry, and wires previous/next actions', () => {
  let previous = 0, next = 0, retry = 0;
  const state = { loaded: { data: { next_after: id(20) }, navigation: { after: id(10), history: [null] } },
    loading: false, error: true, previous: () => previous++, next: () => next++, retry: () => retry++ };
  const html = render(api.TestPager, { page: state, label: '檔案記錄' });
  assert.match(html, /第 2 頁/); assert.match(html, /保留目前確認的頁面/); assert.match(html, /重試檔案記錄/);
  const tree = api.TestPager({ page: { ...state, error: false }, label: '檔案記錄' });
  tree.props.children[0].props.onClick(); tree.props.children[2].props.onClick();
  api.TestPager({ page: state, label: '檔案記錄' }).props.children[4].props.children[1].props.onClick();
  assert.deepEqual([previous, next, retry], [1, 1, 1]);
});
// Deterministic Hook lifecycle harness using the installed React dispatcher. This
// exercises component closures/effects and native toggle handlers without a browser,
// DOM library, package changes or real network. It is not a browser layout/media test.
function hookDriver(Component, initialProps) {
  const dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const slots = []; let props = initialProps, index = 0, effects = [], dirty = true, disposed = false, tree, lateWrites = 0;
  const hooks = {
    useState(initial) {
      const n = index++;
      if (!(n in slots)) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.set = update => {
          if (disposed) { lateWrites++; return; }
          const next = typeof update === 'function' ? update(slot.value) : update;
          if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
        }; slots[n] = slot;
      }
      return [slots[n].value, slots[n].set];
    },
    useEffect(effect, deps) {
      const n = index++, old = slots[n];
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps?.[i]))) {
        const slot = { deps, effect, cleanup: old?.cleanup }; slots[n] = slot; effects.push(slot);
      }
    },
    useCallback(callback, deps) {
      const n = index++, old = slots[n];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[n] = { value: callback, deps };
      return slots[n].value;
    },
  };
  const driver = {
    render(nextProps) {
      if (nextProps) { props = nextProps; dirty = true; }
      for (let pass = 0; dirty; pass++) {
        assert.ok(pass < 30, 'Hook render must settle'); dirty = false; index = 0; effects = [];
        const previous = dispatcher.current; dispatcher.current = hooks;
        try { tree = Component(props); } finally { dispatcher.current = previous; }
        for (const slot of effects) { slot.cleanup?.(); slot.cleanup = slot.effect(); }
      }
      return tree;
    },
    replayEffects() { for (const slot of slots) if (slot.effect) { slot.cleanup?.(); slot.cleanup = slot.effect(); } return driver.render(); },
    unmount() { disposed = true; for (const slot of slots) slot.cleanup?.(); },
    get lateWrites() { return lateWrites; },
  };
  driver.render(); return driver;
}
function elements(node, matches) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, matches));
  if (!React.isValidElement(node)) return [];
  return [...(matches(node) ? [node] : []), ...elements(node.props.children, matches)];
}
const find = (driver, type) => elements(driver.render(), node => node.type === type);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function objectUrls(onCreate) {
  const created = [], revoked = [], active = new Set();
  const make = mock.method(URL, 'createObjectURL', blob => { const url = `blob:archive-test-${created.length}`;
    created.push({ url, blob }); active.add(url); onCreate?.(); return url; });
  const remove = mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); active.delete(url); });
  return { created, revoked, active, restore() { make.mock.restore(); remove.mock.restore(); } };
}
const attachmentProps = mediaLoader => ({ sourceSiteId: SITE, packageId: PACKAGE, eventId: id(10),
  refKey: 'https://old.invalid/original.png?opaque-key-only', number: 1, mediaLoader });
function startAttachment(driver) { find(driver, 'button')[0].props.onClick(); driver.render(); }
function eventRow(refs = { 'https://old.invalid/source.png': 'private/evidence.png' }) {
  const body = row(TABLES[0]); body.media_refs = refs;
  return { sourceId: body.id, sourceLine: JSON.stringify(body) + '\n' };
}

test('event attachments appear only for expanded, verified namespaces with nonempty media_refs; keys are never links', () => {
  const mediaLoader = () => assert.fail('No read before an explicit attachment click');
  for (const [name, props, expected] of [
    ['verified event', { source: { ...source(), media_pending: false }, tableKey: TABLES[0], row: eventRow() }, 1],
    ['pending namespace', { source: source(), tableKey: TABLES[0], row: eventRow() }, 0],
    ['empty refs', { source: { ...source(), media_pending: false }, tableKey: TABLES[0], row: eventRow({}) }, 0],
    ['different table', { source: { ...source(), media_pending: false }, tableKey: TABLES[1], row: eventRow() }, 0],
    ['page switching', { source: { ...source(), media_pending: false }, tableKey: TABLES[0], row: eventRow(), mediaActive: false }, 0],
  ]) {
    const driver = hookDriver(api.TestArchiveRow, { ...props, mediaLoader });
    assert.equal(find(driver, api.TestArchiveAttachment).length, 0, `${name}: closed rows have no attachment resources`);
    find(driver, 'details')[0].props.onToggle({ currentTarget: { open: true } });
    const attachments = find(driver, api.TestArchiveAttachment); assert.equal(attachments.length, expected, name);
    if (expected) {
      assert.equal(attachments[0].props.refKey, 'https://old.invalid/source.png');
      const html = render(api.TestArchiveAttachment, attachments[0].props);
      assert.ok(html.includes('載入附件')); assert.doesNotMatch(html, /href=|src=|https:\/\/old/);
    }
    find(driver, 'details')[0].props.onToggle({ currentTarget: { open: false } });
    assert.equal(find(driver, api.TestArchiveAttachment).length, 0); driver.unmount();
  }
});
test('explicit image preview uses exact namespace/event/ref binding, signal and a Blob URL; unmount aborts and revokes', async () => {
  const urls = objectUrls(), calls = [], response = deferred();
  const props = attachmentProps((binding, signal) => { calls.push({ binding, signal }); return response.promise; });
  const driver = hookDriver(api.TestArchiveAttachment, props);
  try {
    assert.equal(calls.length, 0); startAttachment(driver); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].binding, { source_site_id: SITE, package_id: PACKAGE, event_id: id(10), ref_key: props.refKey });
    assert.equal(calls[0].signal.aborted, false);
    response.resolve(new Blob(['synthetic image'], { type: 'image/png' })); await tick();
    const image = find(driver, 'img')[0]; assert.equal(image.props.src, urls.created[0].url);
    assert.equal(find(driver, 'a').length, 0); assert.equal(urls.active.size, 1);
    driver.unmount(); assert.equal(calls[0].signal.aborted, true); assert.deepEqual(urls.revoked, [image.props.src]);
    assert.equal(urls.active.size, 0); assert.equal(driver.lateWrites, 0);
  } finally { driver.unmount(); urls.restore(); }
});
test('video Blob preview has controls and no autoPlay or original URL', async () => {
  const urls = objectUrls(), driver = hookDriver(api.TestArchiveAttachment, attachmentProps(async () => new Blob(['synthetic video'], { type: 'video/mp4' })));
  try {
    startAttachment(driver); await tick(); const video = find(driver, 'video')[0];
    assert.equal(video.props.controls, true); assert.equal(video.props.autoPlay, undefined);
    assert.match(video.props.src, /^blob:/); assert.equal(find(driver, 'img').length, 0);
  } finally { driver.unmount(); assert.equal(urls.active.size, 0); urls.restore(); }
});
test('network or byte-validation failure is redacted and can be retried only by an explicit click', async () => {
  const urls = objectUrls(); let attempts = 0;
  const driver = hookDriver(api.TestArchiveAttachment, attachmentProps(async () => {
    if (++attempts === 1) throw Error('do-not-display-secret-url'); return new Blob(['verified image'], { type: 'image/jpeg' });
  }));
  try {
    startAttachment(driver); await tick(); const html = renderToStaticMarkup(driver.render());
    assert.ok(html.includes('重試附件')); assert.equal(html.includes('do-not-display-secret-url'), false);
    assert.equal(attempts, 1); assert.equal(urls.created.length, 0);
    startAttachment(driver); await tick(); assert.equal(attempts, 2); assert.equal(find(driver, 'img').length, 1);
  } finally { driver.unmount(); urls.restore(); }
});
for (const type of ['text/html', 'image/svg+xml', 'application/octet-stream', '']) test(`unsupported Blob type is not rendered or given an object URL: ${type}`, async () => {
  const urls = objectUrls(), driver = hookDriver(api.TestArchiveAttachment, attachmentProps(async () => new Blob(['untrusted'], { type })));
  try {
    startAttachment(driver); await tick(); assert.equal(find(driver, 'img').length + find(driver, 'video').length, 0);
    assert.equal(urls.created.length, 0); assert.ok(renderToStaticMarkup(driver.render()).includes('重試附件'));
  } finally { driver.unmount(); urls.restore(); }
});
function rowAttachmentDriver(props) {
  const row = hookDriver(api.TestArchiveRow, props), children = new Map();
  const driver = {
    row, children,
    sync(nextProps) {
      row.render(nextProps);
      const descriptors = find(row, api.TestArchiveAttachment), keys = new Set(descriptors.map(element => element.key));
      for (const [key, child] of children) if (!keys.has(key)) { child.unmount(); children.delete(key); }
      for (const element of descriptors) {
        const child = children.get(element.key);
        if (child) child.render(element.props); else children.set(element.key, hookDriver(api.TestArchiveAttachment, element.props));
      }
    },
    toggle(open) { find(row, 'details')[0].props.onToggle({ currentTarget: { open } }); driver.sync(); },
    unmount() { row.unmount(); for (const child of children.values()) child.unmount(); children.clear(); },
  };
  driver.sync(); return driver;
}
for (const reason of ['row collapse', 'namespace change', 'category change', 'page change', 'tab/unmount']) test(`actual row child removal after ${reason} aborts late media without object URL allocation`, async () => {
  const urls = objectUrls(), response = deferred(); let signal;
  const props = { row: eventRow(), source: { ...source(), media_pending: false }, tableKey: TABLES[0],
    mediaLoader: (_binding, input) => { signal = input; return response.promise; } };
  const parent = rowAttachmentDriver(props); parent.toggle(true);
  const child = [...parent.children.values()][0];
  try {
    startAttachment(child);
    if (reason === 'row collapse') parent.toggle(false);
    else if (reason === 'namespace change') parent.sync({ ...props, source: { ...props.source, source_site_id: id(99), package_id: id(98) } });
    else if (reason === 'category change') parent.sync({ ...props, tableKey: TABLES[1] });
    else if (reason === 'page change') parent.sync({ ...props, mediaActive: false });
    else parent.unmount();
    assert.equal(signal.aborted, true);
    response.resolve(new Blob(['late image'], { type: 'image/png' })); await tick();
    assert.equal(urls.created.length, 0); assert.equal(urls.active.size, 0); assert.equal(child.lateWrites, 0);
  } finally { parent.unmount(); urls.restore(); }
});
test('row collapse releases a loaded image, reopening is idle, and a now-pending namespace removes previews', async () => {
  const urls = objectUrls(); let calls = 0;
  const props = { row: eventRow(), source: { ...source(), media_pending: false }, tableKey: TABLES[0],
    mediaLoader: async () => { calls++; return new Blob(['image'], { type: 'image/png' }); } };
  const parent = rowAttachmentDriver(props);
  try {
    parent.toggle(true); startAttachment([...parent.children.values()][0]); await tick(); assert.equal(urls.active.size, 1);
    parent.toggle(false); assert.equal(urls.active.size, 0); assert.equal(urls.revoked.length, 1);
    parent.toggle(true); assert.equal(calls, 1, 'reopen does not automatically fetch');
    const next = [...parent.children.values()][0]; assert.equal(find(next, 'img').length, 0);
    startAttachment(next); await tick(); assert.equal(urls.active.size, 1);
    parent.sync({ ...props, source: { ...props.source, media_pending: true } });
    assert.equal(parent.children.size, 0); assert.equal(urls.active.size, 0);
  } finally { parent.unmount(); urls.restore(); }
});
test('row default loader delegates to readArchiveMedia with the exact binding, without a production request', async () => {
  const h = harness(), calls = [], urls = objectUrls();
  h.mediaLoader = async (binding, signal) => { calls.push({ binding, signal }); return new Blob(['image'], { type: 'image/png' }); };
  const parent = rowAttachmentDriver({ row: eventRow(), source: { ...source(), media_pending: false }, tableKey: TABLES[0] });
  try {
    parent.toggle(true); assert.equal(calls.length, 0); startAttachment([...parent.children.values()][0]); await tick();
    assert.deepEqual(calls[0].binding, { source_site_id: SITE, package_id: PACKAGE, event_id: id(10), ref_key: 'https://old.invalid/source.png' });
    assert.equal(urls.active.size, 1);
  } finally { parent.unmount(); assert.equal(urls.active.size, 0); urls.restore(); }
});
test('changing namespace/event/ref on the same preview aborts and releases old generation, ignoring its late response', async () => {
  const urls = objectUrls(), first = deferred(), second = deferred(), calls = [];
  const props = attachmentProps((binding, signal) => { calls.push({ binding, signal }); return calls.length === 1 ? first.promise : second.promise; });
  const driver = hookDriver(api.TestArchiveAttachment, props);
  try {
    startAttachment(driver);
    driver.render({ ...props, sourceSiteId: id(99), packageId: id(98), eventId: id(97), refKey: 'new-ref' });
    assert.equal(calls[0].signal.aborted, true); assert.equal(calls.length, 2);
    first.resolve(new Blob(['late first'], { type: 'image/png' })); await tick(); assert.equal(urls.created.length, 0);
    second.resolve(new Blob(['second'], { type: 'image/jpeg' })); await tick(); assert.equal(urls.created.length, 1);
    assert.equal(find(driver, 'img')[0].props.src, urls.created[0].url);
  } finally { driver.unmount(); assert.equal(urls.active.size, 0); urls.restore(); }
});
test('loaded object URL is revoked before replacement and rendering failure is retryable', async () => {
  const urls = objectUrls(), props = attachmentProps(async () => new Blob(['verified image'], { type: 'image/png' }));
  const driver = hookDriver(api.TestArchiveAttachment, props);
  try {
    startAttachment(driver); await tick(); const first = find(driver, 'img')[0];
    driver.render({ ...props, refKey: 'another-ref' }); assert.ok(urls.revoked.includes(first.props.src));
    await tick(); const second = find(driver, 'img')[0]; assert.notEqual(first.props.src, second.props.src);
    second.props.onError(); assert.equal(urls.active.size, 0); assert.ok(renderToStaticMarkup(driver.render()).includes('重試附件'));
    startAttachment(driver); await tick(); assert.equal(find(driver, 'img').length, 1);
  } finally { driver.unmount(); assert.equal(urls.active.size, 0); urls.restore(); }
});
test('abort during URL allocation still revokes the new URL exactly once', async () => {
  let driver; const urls = objectUrls(() => driver.unmount());
  driver = hookDriver(api.TestArchiveAttachment, attachmentProps(async () => new Blob(['image'], { type: 'image/png' })));
  try {
    startAttachment(driver); await tick(); assert.equal(urls.created.length, 1);
    assert.deepEqual(urls.revoked, [urls.created[0].url]); assert.equal(urls.active.size, 0); assert.equal(driver.lateWrites, 0);
  } finally { driver.unmount(); urls.restore(); }
});
test('StrictMode-style effect cleanup/replay cancels the superseded request without leaks', async () => {
  const urls = objectUrls(), requests = [];
  const driver = hookDriver(api.TestArchiveAttachment, attachmentProps((_binding, signal) => {
    const response = deferred(); requests.push({ response, signal }); return response.promise;
  }));
  try {
    startAttachment(driver); driver.replayEffects(); assert.equal(requests.length, 2); assert.equal(requests[0].signal.aborted, true);
    for (const request of requests) request.response.resolve(new Blob(['verified image'], { type: 'image/png' }));
    await tick(); assert.equal(urls.created.length, 1); assert.equal(find(driver, 'img').length, 1);
  } finally { driver.unmount(); assert.equal(urls.active.size, 0); urls.restore(); }
});
test('third tab is lazy-only; original two workflows remain separate and raw pre never executes HTML', async () => {
  const audit = await readFile(`${root}src/components/admin/ContentAuditPanel.tsx`, 'utf8');
  const panel = await readFile(`${root}src/components/admin/TransferredArchivesPanel.tsx`, 'utf8');
  assert.match(audit, /lazy\(\(\) => import\('\.\/TransferredArchivesPanel'\)\)/);
  assert.match(audit, /\['archives', '遷入檔案'\]/); assert.match(audit, /view === 'employees' &&/); assert.match(audit, /view === 'content' &&/);
  assert.match(panel, /<pre[^>]*[\s\S]*?\{row\.sourceLine\}<\/pre>/);
  assert.match(panel, /whitespace-pre-wrap/); assert.match(panel, /overflow-wrap:anywhere/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|JSON\.stringify|href=|\.from\(/);
});
