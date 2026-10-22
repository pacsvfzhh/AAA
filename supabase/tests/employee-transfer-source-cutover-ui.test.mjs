import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import loadTailwindConfig from 'tailwindcss/loadConfig.js';

// Actual Panel + actual sourceCutover; only auth/RPC and unrelated migration boundaries are mocked.
// This is not a real database, native picker, Storage or full cutover acceptance test.
const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `ba000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(1), CUTOFF = id(2), AUTH = id(3), PASSWORD = 'isolated-cutover-password-CANARY';
const PASS = 'isolated-export-passphrase-CANARY';
const FREEZE = '確認暫停舊站業務並導出', RESUME = '確認恢復舊站業務並放棄切站';
const STATUS_RPC = 'get_employee_export_cutover_status', FREEZE_RPC = 'employee_export_cutover_freeze', RESUME_RPC = 'employee_export_cutover_resume';
const FROZEN_AT = '2026-10-22T20:13:14.123456Z';
const CUTOFF_HASH = createHash('sha256').update(`{"policy": "drained-queue-v1", "site_id": "${SITE}", "version": 1, "cutoff_id": "${CUTOFF}", "frozen_at": "${FROZEN_AT}"}`, 'ascii').digest('hex');
assert.equal(CUTOFF_HASH, '002fce9a885100f44bbd72bafab823be5f700dbca61d38146394a0cf1ac9b4e5');
const constants = { SITE, CUTOFF, AUTH, PASSWORD, FREEZE, RESUME, STATUS_RPC, FREEZE_RPC, RESUME_RPC, FROZEN_AT, CUTOFF_HASH };

async function loadPlaywright() {
  if (process.env.EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE) return import(pathToFileURL(process.env.EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE).href);
  try { return await import('playwright'); } catch { /* Use an already installed runner; never install or fetch. */ }
  const candidates = ['/root/.cache/employee-transfer-playwright/node_modules/playwright/index.mjs'];
  try {
    for (const name of (await readdir('/root/.npm/_npx')).sort()) candidates.push(`/root/.npm/_npx/${name}/node_modules/playwright/index.mjs`);
  } catch { /* Fail explicitly below, do not count missing browsers as successful skip. */ }
  for (const path of candidates) { try { return await import(pathToFileURL(path).href); } catch { /* Next local candidate. */ } }
  throw Error('Local Playwright is required. Set EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE to an existing index.mjs; no network install is allowed.');
}
const playwright = await loadPlaywright();
function installHarness(c) {
  const { SITE, CUTOFF, AUTH, PASSWORD, FREEZE, RESUME, STATUS_RPC, FREEZE_RPC, RESUME_RPC, FROZEN_AT, CUTOFF_HASH } = c;
  const initial = new URLSearchParams(location.search).get('state');
  const fresh = frozen => ({ version: 1, success: true, scope: 'source-cutover', site_id: SITE, frozen,
    cutoff: frozen ? { version: 1, policy: 'drained-queue-v1', site_id: SITE, cutoff_id: CUTOFF,
      frozen_at: FROZEN_AT, cutoff_hash: CUTOFF_HASH } : null,
    blockers: [], counts: { pending_automation: 0, failed_automation: 0, processing_orders: 0 }, full_site_complete: false });
  const h = window.__h = { state: fresh(initial === 'frozen'), calls: [], signals: [], events: [], busy: false, uncertain: false,
    violations: [], forbidden: [], siteCalls: [], next: null, waiting: null, release: null, gates: Object.create(null), authReads: 0, fresh };
  if (initial === 'pending') { h.state.counts.pending_automation = 2; h.state.blockers = ['pending_automation']; }
  if (initial === 'unavailable') h.next = { name: STATUS_RPC, error: true };
  if (initial === 'hold-read') h.next = { name: STATUS_RPC, hold: true };
  const check = (ok, why) => { if (!ok) { h.violations.push(why); throw Error(why); } };
  h.rpc = (name, args) => {
    let signal, pending;
    const q = { abortSignal(value) { signal = value; h.signals.push({ name, signal: value }); return q; },
      then(resolve, reject) {
        pending ??= Promise.resolve().then(async () => {
          check([STATUS_RPC, FREEZE_RPC, RESUME_RPC].includes(name), 'unexpected RPC ' + name);
          const fields = name === STATUS_RPC ? ['p_admin_session_token'] : ['p_admin_session_token', 'p_admin_password', 'p_confirmation', ...(name === RESUME_RPC ? ['p_cutoff_id'] : [])];
          check(JSON.stringify(Object.keys(args).sort()) === JSON.stringify(fields.sort()), 'wrong argument fields');
          check(args.p_admin_session_token === AUTH, 'wrong admin session');
          if (name !== STATUS_RPC) check(args.p_admin_password === PASSWORD && args.p_confirmation === (name === FREEZE_RPC ? FREEZE : RESUME), 'incorrect credentials/confirmation');
          if (name === RESUME_RPC) check(args.p_cutoff_id === CUTOFF, 'wrong cutoff id');
          h.calls.push({ name, args: structuredClone(args) });
          const fault = h.next?.name === name ? h.next : {};
          if (fault === h.next) h.next = null;
          if (name === FREEZE_RPC && !fault.error) h.state = fresh(true);
          if (name === RESUME_RPC && !fault.error) h.state = fresh(false);
          // Deliberately ignore AbortSignal while held: abort cannot undo server commit.
          if (fault.hold) await new Promise(done => {
            if (fault.gate) {
              check(!h.gates[fault.gate], 'duplicate held request gate');
              h.gates[fault.gate] = { name, release: () => { delete h.gates[fault.gate]; done(); } };
            } else { h.waiting = name; h.release = () => { h.waiting = null; h.release = null; done(); }; }
          });
          if (fault.lost) throw Error(PASSWORD + AUTH + ' PRIVATE-BACKEND-ERROR');
          if (fault.error) return { data: null, error: { message: PASSWORD + ' PRIVATE-BACKEND-ERROR' } };
          return { data: Object.hasOwn(fault, 'data') ? fault.data : structuredClone(h.state), error: null };
        });
        return pending.then(resolve, reject);
      } };
    return q;
  };
  // Any accidental browser fetch is failed locally, not delegated to the native network.
  window.fetch = async () => { h.forbidden.push('browser-fetch'); throw Error('No browser service requests allowed'); };
  window.showDirectoryPicker = async () => { h.forbidden.push('native-picker'); throw Error('Native picker forbidden'); };
}
const migrationMocks = `
const h=()=>window.__h;
export const getSiteTransferCapabilities=async()=>({version:1,site_id:'${SITE}',export_protocol:'local',can_export:true,can_import:false,missing_rpcs:[],import_blockers:[]});
export const getSiteTransferHistory=async()=>[];
export const stopSiteExportTask=async()=>{h().forbidden.push('stop-export');throw Error('forbidden')};
export const exportSiteBundleSet=async()=>{h().siteCalls.push('export');return bundle()};
const bundle=()=>({packageId:'${id(4)}',sourceSiteId:'${id(5)}',volumes:[],fullSiteComplete:false,importReady:false});
export const inspectSiteBundleSet=async()=>{h().siteCalls.push('inspect');return bundle()};
export const createBrowserWorkspaceFactory=async()=>()=>({});
export const pickTransferDirectory=async()=>{h().siteCalls.push('picker');return {name:'local-mocked-directory'}};
`;
const backupMock = `import React from 'react';
export default function SafetyBoundary({disabled,supported}){
return <section aria-label="isolated-backup-boundary"><button type="button" disabled={disabled||!supported}
 onClick={()=>window.__h.siteCalls.push('employee-backup')}>隔離員工備份邊界</button><output>{String(disabled)}</output></section>;
}`;
const childMock = `import React from 'react';
export default function Boundary({disabled,supported,inspection}){
return <section aria-label="isolated-import-boundary"><button type="button" disabled={disabled||!supported||!inspection}
 onClick={()=>window.__h.siteCalls.push('database-import')}>隔離實際導入邊界</button><output>{String(disabled)}</output></section>;
}`;
let server, base, workspace, screenshotDir, foreignRequests = 0;
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'source-cutover-ui-entry-'));
  screenshotDir = await mkdtemp(join(tmpdir(), 'source-cutover-ui-screenshots-'));
  const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import Panel from './src/components/admin/SourceCutoverPanel';import Parent from './src/components/admin/EmployeeDataMigration';
    import * as CutoverApi from './src/lib/employeeTransfer/sourceCutover';
    (${installHarness.toString()})(${JSON.stringify(constants)});window.__cutoverApi=CutoverApi;
    function App(){const[disabled,setDisabled]=useState(false);window.__setDisabled=setDisabled;
      return new URLSearchParams(location.search).get('view')==='parent'?<Parent/>:<main style={{padding:12,maxWidth:1100,margin:'auto'}}>
      <Panel disabled={disabled} onBusyChange={v=>{window.__h.busy=v;window.__h.events.push(['busy',v])}}
       onUncertainChange={v=>{window.__h.uncertain=v;window.__h.events.push(['uncertain',v])}}/></main>}
    const r=createRoot(document.getElementById('root'));window.__unmount=()=>r.unmount();r.render(<App/>);`;
  const compiled = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, write: false, platform: 'browser',
    format: 'esm', jsx: 'automatic', metafile: true, plugins: [{ name: 'isolated-cutover-ui-boundaries', setup(b) {
      b.onResolve({ filter: /^\.\.\/(?:auth|supabase)$/ }, a => ({ path: a.path, namespace: 'cutover-ui-rpc' }));
      b.onLoad({ filter: /.*/, namespace: 'cutover-ui-rpc' }, ({ path }) => ({ contents: path === '../auth'
        ? `export function getAdminFinancialSessionToken(){window.__h.authReads++;return '${AUTH}';}`
        : 'export const supabase={rpc:(...a)=>window.__h.rpc(...a)};' }));
      b.onResolve({ filter: /employeeTransfer\/(?:siteTransfer|browserStorage)$/ }, () => ({ path: 'migration', namespace: 'cutover-ui-migration' }));
      b.onLoad({ filter: /.*/, namespace: 'cutover-ui-migration' }, () => ({ contents: migrationMocks }));
      b.onResolve({ filter: /^\.\/EmployeeSiteImport$/ }, () => ({ path: 'import', namespace: 'cutover-ui-child' }));
      b.onResolve({ filter: /^\.\/EmployeeSafetyBackupPanel$/ }, () => ({ path: 'backup', namespace: 'cutover-ui-child' }));
      b.onLoad({ filter: /.*/, namespace: 'cutover-ui-child' }, ({ path }) => ({ contents: path === 'import' ? childMock : backupMock, loader: 'tsx', resolveDir: root }));
    } }] });
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const name of ['SourceCutoverPanel.tsx', 'EmployeeDataMigration.tsx', 'sourceCutover.ts', 'dispatchTransfer.ts', 'sha256.ts']) assert.ok(inputs.some(p => p.endsWith('/' + name)), `actual ${name} must be rendered/loaded`);
  assert.equal(inputs.some(p => /node_modules\/@supabase|src\/lib\/(?:auth|supabase)\.ts|\/(?:siteImport|siteTransfer|browserStorage|employeeSafetyBackup)\.ts$/.test(p)), false, 'production boundaries must not enter UI bundle');
  const config = loadTailwindConfig(root + 'tailwind.config.js');
  const css = await postcss([tailwindcss({ ...config, content: [root + 'src/components/admin/SourceCutoverPanel.tsx', root + 'src/components/admin/EmployeeDataMigration.tsx'] })])
    .process(await readFile(root + 'src/index.css', 'utf8'), { from: undefined });
  await writeFile(join(workspace, 'app.js'), compiled.outputFiles[0].text);
  await writeFile(join(workspace, 'style.css'), css.css);
  await writeFile(join(workspace, 'index.html'), '<!doctype html><html lang="zh-Hant"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="margin:0;background:#0f172a"><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (!Object.hasOwn(files, path)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', files[path][1]);
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; object-src 'none'");
    try { response.end(await readFile(join(workspace, files[path][0]))); } catch { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  console.log(`cutover UI local entry: ${workspace}; screenshots: ${screenshotDir}`);
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (workspace) await rm(workspace, { recursive: true, force: true });
  assert.equal(foreignRequests, 0, 'no non-loopback requests attempted');
  console.log(`cutover UI temporary HTML/JS/CSS removed: ${workspace}; retained screenshots: ${screenshotDir}; external requests: ${foreignRequests}`);
});
const panel = page => page.getByRole('region', { name: '舊站停站切換', exact: true });
const freezeButton = page => panel(page).getByRole('button', { name: '確認暫停舊站業務', exact: true });
const resumeButton = page => panel(page).getByRole('button', { name: '確認恢復舊站並放棄切站', exact: true });
const refreshButton = page => panel(page).getByRole('button', { name: '刷新狀態', exact: true });
const passwordInput = page => panel(page).getByLabel('目前超級管理員密碼', { exact: true });
const confirmationInput = page => panel(page).locator('input[type="text"]');
async function fill(page, confirmation = FREEZE) { await passwordInput(page).fill(PASSWORD); await confirmationInput(page).fill(confirmation); }
async function ready(page) { await page.waitForFunction(() => window.__h.calls.length > 0 && !window.__h.waiting && document.querySelector('section[aria-labelledby][aria-busy]')?.getAttribute('aria-busy') === 'false'); }
async function setFault(page, fault) { await page.evaluate(value => { window.__h.next = value; }, fault); }
async function screenshot(page, engine, label) { const path = join(screenshotDir, `${engine}-${label}.png`); await page.screenshot({ path, fullPage: true }); console.log(`cutover UI screenshot: ${path}`); }
async function scenario(browser, engine, label, fn, options = {}) {
  const { query = '', viewport = { width: 1280, height: 900 }, ...contextOptions } = options;
  const context = await browser.newContext({ viewport, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block', ...contextOptions });
  const foreign = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    foreignRequests++; foreign.push(route.request().url()); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base + '/' + (query ? '?' + query : '')); await fn(page);
  } catch (error) {
    await screenshot(page, engine, 'failure-' + label).catch(() => {}); throw error;
  } finally {
    const h = await page.evaluate(() => ({ violations: window.__h?.violations, forbidden: window.__h?.forbidden }));
    await context.close(); assert.deepEqual(foreign, []); assert.deepEqual(errors, []); assert.deepEqual(h.violations, []); assert.deepEqual(h.forbidden, []);
  }
}
async function noCredentialStorage(page) {
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  assert.equal(stored.includes(PASSWORD), false); assert.equal(stored.includes(AUTH), false);
  assert.equal((await page.locator('body').innerText()).includes(PASSWORD), false);
}
const exportButton = page => page.getByRole('button', { name: '開始目前十個領域加密導出', exact: true });
const inspectButton = page => page.getByRole('button', { name: '僅解密與核驗，不導入', exact: true });
const importBoundary = page => page.getByRole('button', { name: '隔離實際導入邊界', exact: true });
const backupBoundary = page => page.getByRole('button', { name: '隔離員工備份邊界', exact: true });
async function moduleWritesBlocked(page) {
  const observed = await page.evaluate(async ({ PASSWORD, FREEZE, RESUME, CUTOFF }) => {
    const h = window.__h, before = { calls: h.calls.length, authReads: h.authReads }, rejected = [];
    for (const write of [() => window.__cutoverApi.freezeSourceCutover(PASSWORD, FREEZE), () => window.__cutoverApi.resumeSourceCutover(PASSWORD, RESUME, CUTOFF)]) {
      try { await write(); rejected.push(false); } catch { rejected.push(true); }
    }
    return { before, after: { calls: h.calls.length, authReads: h.authReads }, rejected };
  }, { PASSWORD, FREEZE, RESUME, CUTOFF });
  assert.deepEqual(observed.rejected, [true, true]);
  assert.deepEqual(observed.after, observed.before, 'module interlock must reject both writes before authentication/RPC');
}
async function prepareParent(page) {
  await ready(page);
  await page.getByRole('tab', { name: '導入', exact: true }).click();
  await page.locator('#migration-files').setInputFiles({ name: 'synthetic.edx', mimeType: 'application/octet-stream', buffer: Buffer.from('local-only') });
  await page.locator('#migration-inspect-passphrase').fill(PASS); await inspectButton(page).click();
  await page.getByText('輸入檔案各卷解密核驗結果', { exact: true }).waitFor();
  assert.equal(await importBoundary(page).isEnabled(), true, 'import baseline must otherwise be ready');
  assert.equal(await backupBoundary(page).isEnabled(), true, 'independent backup baseline must otherwise be ready');
  await page.getByRole('tab', { name: '導出', exact: true }).click();
  await page.locator('#migration-admin-password').fill(PASSWORD); await page.locator('#migration-passphrase').fill(PASS); await page.locator('#migration-confirmation').fill(PASS);
  await page.getByRole('button', { name: '選擇保存目錄', exact: true }).click();
  await page.getByRole('checkbox', { name: /^我了解這是本地驗證版/ }).check();
  assert.equal(await exportButton(page).isEnabled(), true, 'export baseline must otherwise be ready');
}
const parentOptions = { query: 'view=parent', userAgent: 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36' };
for (const engine of ['chromium', 'webkit']) {
  test(`isolated ${engine} SourceCutoverPanel and parent cutover gates`, { timeout: 180000 }, async t => {
    const executablePath = process.env[`EMPLOYEE_TRANSFER_${engine.toUpperCase()}_EXECUTABLE`];
    const browser = await playwright[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const run = (label, fn, options) => t.test(label, () => scenario(browser, engine, label, fn, options));
    try {
      await run('pending-blocks-freeze', async page => {
        await ready(page); assert.deepEqual(await panel(page).locator('dd').allTextContents(), ['2', '0', '0', SITE, '無切站截止點']);
        assert.equal(await freezeButton(page).isDisabled(), true); assert.equal(await passwordInput(page).isDisabled(), true);
        await panel(page).getByText('自動化佇列尚未清空，請先處理完畢。', { exact: true }).waitFor();
        await panel(page).locator('form').dispatchEvent('submit'); assert.deepEqual(await page.evaluate(() => window.__h.calls.map(c => c.name)), [STATUS_RPC]);
        await screenshot(page, engine, 'pending');
      }, { query: 'state=pending' });
      await run('initial-read-unavailable-is-not-zero', async page => {
        await ready(page); assert.deepEqual(await panel(page).locator('dd').allTextContents(), ['未確認', '未確認', '未確認']);
        assert.equal(await freezeButton(page).isDisabled(), true); assert.equal(await refreshButton(page).isEnabled(), true);
        assert.equal(await page.evaluate(() => window.__h.uncertain), false);
      }, { query: 'state=unavailable' });
      await run('initial-pending-read-blocks-writes-and-duplicate-refresh', async page => {
        await page.waitForFunction(() => window.__h.waiting !== null);
        assert.equal(await freezeButton(page).isDisabled(), true); assert.equal(await refreshButton(page).isDisabled(), true);
        assert.deepEqual(await panel(page).locator('dd').allTextContents(), ['未確認', '未確認', '未確認']);
        assert.equal(await page.evaluate(() => window.__h.busy), true);
        await panel(page).locator('form').dispatchEvent('submit'); assert.equal(await page.evaluate(() => window.__h.calls.length), 1);
        await page.evaluate(() => window.__h.release()); await ready(page);
        assert.equal(await passwordInput(page).isEnabled(), true); assert.equal(await page.evaluate(() => window.__h.busy), false);
      }, { query: 'state=hold-read' });
      await run('normal-freeze-resume-exact-confirmation-and-password-clearing', async page => {
        await ready(page);
        // HTML single-line inputs strip newlines before React sees them; raw-newline rejection is covered by the client test.
        for (const text of ['wrong', ' ' + FREEZE, FREEZE + ' ', '\u00a0' + FREEZE]) {
          await fill(page, text); assert.equal(await freezeButton(page).isDisabled(), true);
          await panel(page).locator('form').dispatchEvent('submit');
        }
        assert.equal(await page.evaluate(() => window.__h.calls.length), 1);
        await fill(page); await setFault(page, { name: FREEZE_RPC, hold: true }); await freezeButton(page).click();
        await page.waitForFunction(() => window.__h.waiting !== null);
        assert.equal(await passwordInput(page).inputValue(), ''); assert.equal(await refreshButton(page).isDisabled(), true);
        await panel(page).locator('form').dispatchEvent('submit'); assert.equal(await page.evaluate(() => window.__h.calls.length), 2);
        await page.evaluate(() => window.__h.release()); await panel(page).getByText(/服務端已確認建立持久維護屏障/).waitFor();
        assert.equal(await passwordInput(page).inputValue(), ''); assert.equal(await confirmationInput(page).inputValue(), '');
        assert.equal(await resumeButton(page).isDisabled(), true);
        await fill(page, FREEZE); assert.equal(await resumeButton(page).isDisabled(), true);
        await fill(page, RESUME); await setFault(page, { name: RESUME_RPC, hold: true }); await resumeButton(page).click();
        await page.waitForFunction(() => window.__h.waiting !== null); assert.equal(await passwordInput(page).inputValue(), '');
        await page.evaluate(() => window.__h.release()); await panel(page).getByText(/服務端已確認恢復舊站業務並放棄本次切站/).waitFor();
        assert.equal(await passwordInput(page).inputValue(), ''); assert.equal(await confirmationInput(page).inputValue(), '');
        const calls = await page.evaluate(() => window.__h.calls);
        assert.deepEqual(calls.map(c => c.name), [STATUS_RPC, FREEZE_RPC, RESUME_RPC]);
        assert.deepEqual(calls[2].args, { p_admin_session_token: AUTH, p_admin_password: PASSWORD, p_confirmation: RESUME, p_cutoff_id: CUTOFF });
        assert.equal(await page.evaluate(() => window.__h.uncertain), false);
        assert.deepEqual(await page.evaluate(() => window.__h.events.filter(e => e[0] === 'busy').map(e => e[1])), [true, false, true, false, true, false]);
        await noCredentialStorage(page);
      });
      for (const op of ['freeze', 'resume']) await run(op + '-lost-response-interlock-refresh-recovery', async page => {
        await ready(page); await fill(page, op === 'freeze' ? FREEZE : RESUME);
        await setFault(page, { name: op === 'freeze' ? FREEZE_RPC : RESUME_RPC, lost: true });
        await (op === 'freeze' ? freezeButton(page) : resumeButton(page)).click();
        await panel(page).getByText(/本次操作結果未知/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), true); assert.equal(await passwordInput(page).inputValue(), '');
        await moduleWritesBlocked(page);
        await panel(page).locator('form').dispatchEvent('submit');
        await setFault(page, { name: STATUS_RPC, error: true }); await refreshButton(page).click();
        await panel(page).getByText(/無法確認舊站狀態/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), true); assert.equal(await passwordInput(page).isDisabled(), true);
        await moduleWritesBlocked(page);
        assert.equal(await refreshButton(page).isEnabled(), true);
        await refreshButton(page).click(); await panel(page).getByText(/已重新讀取並核對服務端狀態/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), false); assert.equal(await passwordInput(page).isEnabled(), true);
        assert.equal(await confirmationInput(page).inputValue(), ''); assert.equal(await passwordInput(page).inputValue(), '');
        const calls = await page.evaluate(() => window.__h.calls.map(c => c.name));
        assert.deepEqual(calls, [STATUS_RPC, op === 'freeze' ? FREEZE_RPC : RESUME_RPC, STATUS_RPC, STATUS_RPC]);
        await noCredentialStorage(page); await screenshot(page, engine, op + '-reconciled');
        // Prove the real module gate (not only form state) is released by this explicit valid refresh.
        await fill(page, op === 'freeze' ? RESUME : FREEZE);
        await (op === 'freeze' ? resumeButton(page) : freezeButton(page)).click();
        await panel(page).getByText(op === 'freeze' ? /服務端已確認恢復舊站業務並放棄本次切站/ : /服務端已確認建立持久維護屏障/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.calls.length), 5);
        assert.equal(await passwordInput(page).inputValue(), '');
      }, op === 'resume' ? { query: 'state=frozen' } : {});
      // The panel deliberately serializes its own operations. Use a second real API caller
      // for the earlier read while submitting the write through the actually rendered panel.
      for (const outcome of ['lost', 'success']) for (const returnAt of ['after-write', 'during-write']) {
        await run('old-status-generation-' + outcome + '-' + returnAt, async page => {
          await ready(page); await fill(page);
          await page.evaluate(name => {
            const h = window.__h; h.oldStatusPayload = h.fresh(false); h.oldReadOutcome = null;
            h.next = { name, hold: true, gate: 'old-status', data: structuredClone(h.oldStatusPayload) };
            h.oldRead = window.__cutoverApi.getSourceCutoverStatus().then(
              value => { h.oldReadOutcome = { rejected: false, value }; },
              error => { h.oldReadOutcome = { rejected: true, name: error.name, message: error.message }; },
            );
          }, STATUS_RPC);
          await page.waitForFunction(() => Boolean(window.__h.gates['old-status']));
          assert.deepEqual(await page.evaluate(() => window.__h.calls.map(c => c.name)), [STATUS_RPC, STATUS_RPC]);
          await setFault(page, { name: FREEZE_RPC, hold: true, gate: 'freeze-write', lost: outcome === 'lost' });
          await freezeButton(page).click();
          await page.waitForFunction(() => Boolean(window.__h.gates['freeze-write']));
          try {
            assert.deepEqual(await page.evaluate(() => window.__h.calls.map(c => c.name)), [STATUS_RPC, STATUS_RPC, FREEZE_RPC]);
            assert.equal(await page.evaluate(() => window.__h.oldReadOutcome), null);
            assert.equal(await passwordInput(page).inputValue(), '');
            assert.equal(await refreshButton(page).isDisabled(), true);
            const rejectOldRead = async () => {
              await page.evaluate(() => window.__h.gates['old-status'].release());
              await page.waitForFunction(() => window.__h.oldReadOutcome !== null);
              const result = await page.evaluate(() => window.__h.oldReadOutcome);
              assert.equal(result.rejected, true, 'late valid false status must be rejected by the real generation guard');
              assert.equal(result.name, 'Error', 'this is not an abort-based rejection');
              assert.equal(result.message.includes(PASSWORD), false); assert.equal(result.message.includes(AUTH), false);
              assert.deepEqual(await page.evaluate(() => window.__h.oldStatusPayload), {
                version: 1, success: true, scope: 'source-cutover', site_id: SITE, frozen: false, cutoff: null,
                blockers: [], counts: { pending_automation: 0, failed_automation: 0, processing_orders: 0 }, full_site_complete: false,
              }, 'the old response must be genuinely valid and unfrozen');
            };
            if (returnAt === 'during-write') {
              await rejectOldRead();
              assert.equal(await page.evaluate(() => Boolean(window.__h.gates['freeze-write'])), true, 'old read settles before the underlying write');
              assert.equal(await panel(page).getAttribute('aria-busy'), 'true');
              await moduleWritesBlocked(page);
            }
            await page.evaluate(() => window.__h.gates['freeze-write'].release());
            if (outcome === 'lost') {
              await panel(page).getByText(/本次操作結果未知/).waitFor(); await moduleWritesBlocked(page);
            } else {
              await panel(page).getByText(/服務端已確認建立持久維護屏障/).waitFor();
              await panel(page).getByText(CUTOFF_HASH, { exact: true }).waitFor();
            }
            if (returnAt === 'after-write') await rejectOldRead();
            assert.deepEqual(await page.evaluate(() => window.__h.calls.map(c => c.name)), [STATUS_RPC, STATUS_RPC, FREEZE_RPC], 'no automatic retry or reconciliation');
            if (outcome === 'lost') {
              assert.equal(await page.evaluate(() => window.__h.uncertain), true);
              assert.equal(await passwordInput(page).isDisabled(), true); await moduleWritesBlocked(page);
              await screenshot(page, engine, 'old-status-' + outcome + '-' + returnAt);
              await refreshButton(page).click(); await panel(page).getByText(/已重新讀取並核對服務端狀態/).waitFor();
              assert.equal(await page.evaluate(() => window.__h.uncertain), false);
            } else {
              assert.equal(await page.evaluate(() => window.__h.uncertain), false);
              await panel(page).getByText('舊站已暫停：持久維護屏障生效', { exact: true }).waitFor();
              assert.equal(await panel(page).getByText('舊站未套用本切站屏障（不代表沒有其他維護限制）', { exact: true }).count(), 0);
              await screenshot(page, engine, 'old-status-' + outcome + '-' + returnAt);
            }
            await panel(page).getByText(CUTOFF_HASH, { exact: true }).waitFor();
            assert.equal(await passwordInput(page).isEnabled(), true);
            await fill(page, RESUME); await resumeButton(page).click();
            await panel(page).getByText(/服務端已確認恢復舊站業務並放棄本次切站/).waitFor();
            assert.deepEqual(await page.evaluate(() => window.__h.calls.map(c => c.name)), [STATUS_RPC, STATUS_RPC, FREEZE_RPC, ...(outcome === 'lost' ? [STATUS_RPC] : []), RESUME_RPC]);
            assert.equal(await passwordInput(page).inputValue(), ''); await noCredentialStorage(page);
          } finally {
            await page.evaluate(async () => {
              const h = window.__h;
              h.gates['old-status']?.release(); h.gates['freeze-write']?.release();
              await h.oldRead;
            });
          }
        });
      }
      for (const change of ['hash', 'site', 'cutoff', 'microsecond']) await run('valid-format-cutoff-drift-rejected-' + change, async page => {
        await ready(page); await fill(page);
        await page.evaluate(({ change, name }) => {
          const data = window.__h.fresh(true);
          if (change === 'hash') data.cutoff.cutoff_hash = 'a'.repeat(64);
          if (change === 'site') { data.site_id = 'ba000000-0000-4000-8000-000000000099'; data.cutoff.site_id = data.site_id; }
          if (change === 'cutoff') data.cutoff.cutoff_id = 'ba000000-0000-4000-8000-000000000098';
          if (change === 'microsecond') data.cutoff.frozen_at = '2026-10-22T20:13:14.123457Z';
          window.__h.tampered = data; window.__h.next = { name, data };
        }, { change, name: FREEZE_RPC });
        await freezeButton(page).click(); await panel(page).getByText(/本次操作結果未知/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), true); await moduleWritesBlocked(page);
        assert.equal(await panel(page).getByText(/服務端已確認建立持久維護屏障/).count(), 0);
        await page.evaluate(name => { window.__h.next = { name, data: window.__h.tampered }; }, STATUS_RPC);
        await refreshButton(page).click(); await panel(page).getByText(/無法確認舊站狀態/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), true); assert.equal(await passwordInput(page).isDisabled(), true);
        await moduleWritesBlocked(page); await screenshot(page, engine, 'rejected-cutoff-' + change);
        await refreshButton(page).click(); await panel(page).getByText(/已重新讀取並核對服務端狀態/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), false); assert.equal(await passwordInput(page).isEnabled(), true);
        await panel(page).getByText(CUTOFF_HASH, { exact: true }).waitFor();
        await fill(page, RESUME); await resumeButton(page).click();
        await panel(page).getByText(/服務端已確認恢復舊站業務並放棄本次切站/).waitFor();
        assert.deepEqual(await page.evaluate(() => window.__h.calls.map(c => c.name)), [STATUS_RPC, FREEZE_RPC, STATUS_RPC, STATUS_RPC, RESUME_RPC]);
        assert.equal(await passwordInput(page).inputValue(), ''); await noCredentialStorage(page);
      });
      await run('wrong-site-refresh-does-not-unlock-unknown-write', async page => {
        await ready(page); await fill(page); await setFault(page, { name: FREEZE_RPC, lost: true }); await freezeButton(page).click();
        await panel(page).getByText(/本次操作結果未知/).waitFor();
        await page.evaluate(name => { const data = window.__h.fresh(false); data.site_id = 'ba000000-0000-4000-8000-000000000099'; window.__h.next = { name, data }; }, STATUS_RPC);
        await refreshButton(page).click(); await panel(page).getByText(/無法確認舊站狀態/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), true);
        await refreshButton(page).click(); await panel(page).getByText(/已重新讀取並核對服務端狀態/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), false);
      });
      await run('unfrozen-freeze-receipt-is-not-panel-success', async page => {
        await ready(page); await fill(page);
        await page.evaluate(name => { window.__h.next = { name, data: window.__h.fresh(false) }; }, FREEZE_RPC);
        await freezeButton(page).click(); await panel(page).getByText(/本次操作結果未知/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), true);
        assert.equal(await freezeButton(page).isDisabled(), true);
        assert.equal(await panel(page).getByText(/服務端已確認建立持久維護屏障/).count(), 0);
      });
      await run('malformed-freeze-receipt-remains-unknown', async page => {
        await ready(page); await fill(page);
        await page.evaluate(name => { const data = window.__h.fresh(true); data.full_site_complete = true; window.__h.next = { name, data }; }, FREEZE_RPC);
        await freezeButton(page).click(); await panel(page).getByText(/本次操作結果未知/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.uncertain), true); assert.equal(await freezeButton(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.calls.length), 2);
      });
      for (const frozen of [false, true]) await run('disabled-write-forbidden-read-allowed-' + frozen, async page => {
        await ready(page); await fill(page, frozen ? RESUME : FREEZE);
        await page.evaluate(() => window.__setDisabled(true));
        await panel(page).getByText(/目前不可提交；仍可唯讀刷新狀態/).waitFor();
        assert.equal(await passwordInput(page).isDisabled(), true); assert.equal(await (frozen ? resumeButton(page) : freezeButton(page)).isDisabled(), true);
        await panel(page).locator('form').dispatchEvent('submit'); assert.equal(await page.evaluate(() => window.__h.calls.length), 1);
        await refreshButton(page).click(); await panel(page).getByText(/已重新讀取並核對服務端狀態/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.calls.length), 2); assert.equal(await passwordInput(page).inputValue(), '');
        assert.equal(await passwordInput(page).isDisabled(), true); assert.equal(await refreshButton(page).isEnabled(), true);
      }, frozen ? { query: 'state=frozen' } : {});
      await run('unmount-aborts-browser-request-not-server-commit', async page => {
        await ready(page); await fill(page); await setFault(page, { name: FREEZE_RPC, hold: true }); await freezeButton(page).click();
        await page.waitForFunction(() => window.__h.waiting !== null); await page.evaluate(() => window.__unmount());
        assert.deepEqual(await page.evaluate(() => ({ aborted: window.__h.signals.at(-1).signal.aborted, uncertain: window.__h.uncertain, busy: window.__h.busy,
          frozen: window.__h.state.frozen, calls: window.__h.calls.map(c => c.name) })), { aborted: true, uncertain: true, busy: false, frozen: true, calls: [STATUS_RPC, FREEZE_RPC] });
        await page.evaluate(() => window.__h.release()); assert.equal(await page.locator('#root').innerText(), '');
        assert.equal(await page.evaluate(() => window.__h.calls.length), 2);
      });
      await run('375px-wrap-and-explicit-UTC8', async page => {
        await ready(page); await panel(page).getByText('2026/10/23 04:13:14（UTC+8）', { exact: true }).waitFor();
        const box = await panel(page).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 375);
        assert.ok(await panel(page).evaluate(e => e.scrollWidth <= e.clientWidth));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const fields = await panel(page).locator('fieldset input').evaluateAll(elements => elements.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, right: r.right, top: r.top }; }));
        assert.ok(fields.every(r => r.x >= 0 && r.right <= 375)); assert.ok(fields[1].top > fields[0].top, 'narrow form fields stack');
        await screenshot(page, engine, '375px-utc8');
      }, { query: 'state=frozen', viewport: { width: 375, height: 812 } });
      for (const state of ['busy', 'uncertain']) {
        await run('parent-export-inspect-interlock-' + state, async page => {
          await prepareParent(page); await fill(page); await setFault(page, { name: FREEZE_RPC, ...(state === 'busy' ? { hold: true } : { lost: true }) });
          await freezeButton(page).click();
          if (state === 'busy') await page.waitForFunction(() => window.__h.waiting !== null); else await panel(page).getByText(/本次操作結果未知/).waitFor();
          assert.equal(await exportButton(page).isDisabled(), true); await page.locator('#migration-panel-export > form').dispatchEvent('submit');
          await page.getByRole('tab', { name: '導入', exact: true }).click(); assert.equal(await inspectButton(page).isDisabled(), true);
          await page.locator('#migration-panel-inspect > form').dispatchEvent('submit');
          assert.deepEqual(await page.evaluate(() => window.__h.siteCalls), ['inspect', 'picker']);
          await page.getByRole('tab', { name: '導出', exact: true }).click();
          if (state === 'busy') { await page.evaluate(() => window.__h.release()); await panel(page).getByText(/服務端已確認建立持久維護屏障/).waitFor(); }
          else { await refreshButton(page).click(); await panel(page).getByText(/已重新讀取並核對服務端狀態/).waitFor(); }
          assert.equal(await exportButton(page).isEnabled(), true);
        }, parentOptions);
        // Test actual disabled props for BOTH independent backup and database-import boundaries.
        await run('parent-database-import-interlock-' + state, async page => {
          await prepareParent(page); await fill(page); await setFault(page, { name: FREEZE_RPC, ...(state === 'busy' ? { hold: true } : { lost: true }) });
          await freezeButton(page).click();
          if (state === 'busy') await page.waitForFunction(() => window.__h.waiting !== null); else await panel(page).getByText(/本次操作結果未知/).waitFor();
          await page.getByRole('tab', { name: '導入', exact: true }).click();
          assert.equal(await importBoundary(page).isDisabled(), true, `actual EmployeeSiteImport boundary must receive disabled=true while cutover is ${state}`);
          assert.equal(await backupBoundary(page).isDisabled(), true, `actual EmployeeSafetyBackupPanel boundary must receive disabled=true while cutover is ${state}`);
          assert.deepEqual(await page.evaluate(() => window.__h.siteCalls), ['inspect', 'picker']);
          await page.getByRole('tab', { name: '導出', exact: true }).click();
          if (state === 'busy') { await page.evaluate(() => window.__h.release()); await panel(page).getByText(/服務端已確認建立持久維護屏障/).waitFor(); }
          else {
            await setFault(page, { name: STATUS_RPC, error: true }); await refreshButton(page).click();
            await panel(page).getByText(/無法確認舊站狀態/).waitFor(); await moduleWritesBlocked(page);
            await page.getByRole('tab', { name: '導入', exact: true }).click();
            assert.equal(await importBoundary(page).isDisabled(), true); assert.equal(await backupBoundary(page).isDisabled(), true);
            await page.getByRole('tab', { name: '導出', exact: true }).click(); await refreshButton(page).click();
            await panel(page).getByText(/已重新讀取並核對服務端狀態/).waitFor();
          }
          await page.getByRole('tab', { name: '導入', exact: true }).click();
          assert.equal(await importBoundary(page).isEnabled(), true); assert.equal(await backupBoundary(page).isEnabled(), true);
          assert.deepEqual(await page.evaluate(() => window.__h.siteCalls), ['inspect', 'picker']);
        }, parentOptions);
      }
    } finally { await browser.close(); }
  });
}
