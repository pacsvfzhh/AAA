import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import loadTailwindConfig from 'tailwindcss/loadConfig.js';

// Real release panel + import component + migration parent; all API/file boundaries are synthetic.
// No production login, database, Storage, native picker or service network is used.
const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `bc000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOB = id(1), SOURCE = id(2), PACKAGE = id(3), TARGET = id(4), CUTOFF = id(5);
const PASSWORD = 'local-release-password-CANARY', PASS = 'local-release-long-passphrase-CANARY';
const TOKEN = 'DO_NOT_SERIALIZE_SESSION_TOKEN_CANARY', CONFIRM = '確認啟用新站';
const FROZEN = '2026-10-22T20:13:14.123456Z', RELEASED = '2026-10-22T21:23:24.654321Z';
const cutoff = { version: 1, policy: 'drained-queue-v1', site_id: SOURCE, cutoff_id: CUTOFF, frozen_at: FROZEN, cutoff_hash: 'a'.repeat(64) };
const domains = ['shared', 'products', 'dispatch', 'identity', 'finance', 'activity', 'verification', 'notifications', 'chat', 'archives'];
const receipt = { version: 1, success: true, scope: 'site-release', job_id: JOB, source_site_id: SOURCE, package_id: PACKAGE,
  cutoff_id: CUTOFF, cutoff_hash: cutoff.cutoff_hash, verification_hash: 'b'.repeat(64), released_at: RELEASED,
  counts: { employees: 7, active_employees: 3, active_admins: 2, active_plans: 1, active_tasks: 2, queued_employees: 3 },
  released: true, maintenance: false, accounts_restored: true, automation_resumed: true, source_shutdown: 'operator-managed', full_site_complete: false };
const constants = { JOB, SOURCE, PACKAGE, TARGET, PASSWORD, PASS, TOKEN, CONFIRM, cutoff, receipt, domains };
async function loadPlaywright() {
  if (process.env.EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE) return import(pathToFileURL(process.env.EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE).href);
  try { return await import('playwright'); } catch { /* Never install into the project. */ }
  const candidates = ['/root/.cache/employee-transfer-playwright/node_modules/playwright/index.mjs'];
  try { for (const name of (await readdir('/root/.npm/_npx')).sort()) candidates.push(`/root/.npm/_npx/${name}/node_modules/playwright/index.mjs`); } catch { /* Explicit failure below. */ }
  for (const path of candidates) { try { return await import(pathToFileURL(path).href); } catch { /* Try already-local runner. */ } }
  throw Error('Local Playwright required: set EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE. Missing browsers are not passing skips.');
}
const playwright = await loadPlaywright();
function installHarness(c) {
  const { JOB, SOURCE, PACKAGE, TARGET, PASSWORD, PASS, TOKEN, CONFIRM, cutoff, receipt, domains } = c;
  const mode = new URLSearchParams(location.search).get('state');
  const h = window.__h = { calls: [], events: [], signals: [], receipts: [], reports: [], gates: {}, forbidden: [], violations: [],
    busy: false, disabled: false, nextStatus: null, nextRelease: null, reportFail: false, reportHold: false,
    receiptFail: false, receiptExtra: {}, daily: mode === 'daily', legacy: mode === 'legacy', imports: 0,
    cutoff: mode === 'missing' ? null : cutoff };
  h.state = { version: 1, success: true, scope: 'site-release-status', job_id: JOB, source_site_id: SOURCE, package_id: PACKAGE,
    cutoff: h.cutoff, verification_hash: 'b'.repeat(64), released: false, receipt: null, maintenance: true,
    blockers: h.cutoff ? [] : ['missing_cutoff'], can_release: !!h.cutoff, full_site_complete: false };
  h.markReleased = () => { h.state = { ...h.state, released: true, receipt: structuredClone(receipt), maintenance: false, blockers: [], can_release: false }; };
  if (mode === 'released') h.markReleased();
  h.hold = key => new Promise(resolve => { h.gates[key] = () => { delete h.gates[key]; resolve(); }; });
  h.session = {
    token: TOKEN,
    toJSON() { h.violations.push('serialized session'); throw Error('Never serialize session'); },
    async status(signal) {
      h.calls.push('status'); h.signals.push(signal);
      const fault = h.nextStatus || {}; h.nextStatus = null;
      const value = structuredClone(fault.data || h.state);
      if (fault.hold) await h.hold('status');
      if (fault.lost) throw Error(PASSWORD + TOKEN + ' PRIVATE-STATUS-ERROR');
      return value;
    },
    async release(password, confirmation, signal) {
      h.calls.push('release'); h.signals.push(signal);
      if (password !== PASSWORD || confirmation !== CONFIRM) { h.violations.push('wrong credentials'); throw Error('wrong explicit input'); }
      const fault = h.nextRelease || {}; h.nextRelease = null;
      if (!fault.noCommit) h.markReleased();
      if (fault.hold) await h.hold('release');
      if (fault.lost) throw Error(PASSWORD + TOKEN + ' PRIVATE-RELEASE-ERROR');
      return { ...structuredClone(fault.data || receipt), ...h.receiptExtra };
    },
  };
  h.bundle = () => ({ packageId: PACKAGE, sourceSiteId: SOURCE, volumes: [], fullSiteComplete: false, importReady: false });
  h.import = async o => {
    h.calls.push('import'); h.imports++;
    if (o.confirmation !== '確認導入員工資料' || o.adminPassword !== PASSWORD || o.passphrase !== PASS) {
      h.violations.push('wrong import input'); throw Error('wrong import');
    }
    o.signal.throwIfAborted();
    const outcome = { jobId: JOB, verifiedDomains: domains, maintenance: true, fullSiteComplete: false, importReady: false,
      serverVerification: { version: 1, success: true, scope: 'site-restore-verification', job_id: JOB, source_site_id: SOURCE,
        package_id: PACKAGE, verification_hash: 'b'.repeat(64), verified_domains: domains,
        counts: { employees: 7, pending_withdrawals: 1, pending_withdrawal_amount: '12.340000000000000001' },
        maintenance: true, accounts_active: false, automation_resumed: false, can_release: false, full_site_complete: false } };
    if (!h.legacy) { outcome.releaseSession = h.daily ? null : h.session; outcome.sourceCutover = h.daily ? null : h.cutoff; }
    return outcome;
  };
  h.pick = async () => {
    h.calls.push('picker');
    return { name: 'isolated-release-backup-directory', writeText: async (name, text) => {
      h.reports.push({ name, text });
      if (name === 'site-release-report.json') {
        if (h.reportHold) await h.hold('report');
        if (h.reportFail) throw Error(TOKEN + ' local disk failed');
      }
    } };
  };
  h.preflight = source => ({ version: 1, protocol: 'site-maintenance-restore-v3', site_id: TARGET, source_site_id: source,
    can_restore_to_maintenance: true, blockers: [], missing_rpcs: [], full_site_complete: false, can_release: false });
  window.fetch = async () => { h.forbidden.push('browser-fetch'); throw Error('Service network forbidden'); };
  window.showDirectoryPicker = async () => { h.forbidden.push('native-picker'); throw Error('Native picker forbidden'); };
}
const apiMock = `const h=()=>window.__h;
export const SITE_DOMAINS=${JSON.stringify(domains)};
export const getSiteTransferCapabilities=async()=>({version:1,site_id:'${TARGET}',export_protocol:'local',can_export:true,can_import:false,missing_rpcs:[],import_blockers:[]});
export const getSiteTransferHistory=async()=>[];
export const stopSiteExportTask=async()=>{h().forbidden.push('stop-export');throw Error('forbidden')};
export const exportSiteBundleSet=async()=>{h().forbidden.push('export');throw Error('forbidden')};
export const inspectSiteBundleSet=async()=>h().bundle();
export const createBrowserWorkspaceFactory=async()=>()=>({});
export const pickTransferDirectory=async()=>h().pick();
export const getSiteImportPreflight=async source=>h().preflight(source);
export const importSiteBundleSetToMaintenance=async o=>h().import(o);
`;
const siblingMock = `import React from 'react';export default function Boundary({disabled}){
return <button type="button" disabled={disabled} onClick={()=>window.__h.forbidden.push('sibling-write')}>隔離兄弟操作邊界</button>;
}`;
let server, base, workspace, screenshotDir, foreignRequests = 0;
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'site-release-ui-entry-'));
  screenshotDir = await mkdtemp(join(tmpdir(), 'site-release-ui-screenshots-'));
  const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import Panel from './src/components/admin/SiteReleasePanel';import Parent from './src/components/admin/EmployeeDataMigration';
    (${installHarness.toString()})(${JSON.stringify(constants)});
    function App(){const[disabled,setDisabled]=useState(false);window.__setDisabled=setDisabled;
      return new URLSearchParams(location.search).get('view')==='parent'?<Parent/>:<main style={{padding:12,maxWidth:1100,margin:'auto'}}>
      <Panel session={window.__h.session} jobId='${JOB}' cutoff={window.__h.cutoff} disabled={disabled}
        onBusyChange={v=>{window.__h.busy=v;window.__h.events.push(v)}}
        onReceipt={async r=>{window.__h.receipts.push(r);if(window.__h.receiptFail)throw Error('${TOKEN}')}}/></main>}
    const root=createRoot(document.getElementById('root'));window.__unmount=()=>root.unmount();root.render(<App/>);`;
  const compiled = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, write: false,
    platform: 'browser', format: 'esm', jsx: 'automatic', metafile: true, plugins: [{ name: 'site-release-ui-isolation', setup(b) {
      b.onResolve({ filter: /employeeTransfer\/(siteTransfer|siteImport|browserStorage)$/ }, () => ({ path: 'api', namespace: 'release-mock' }));
      b.onLoad({ filter: /.*/, namespace: 'release-mock' }, () => ({ contents: apiMock }));
      b.onResolve({ filter: /^\.\/(SourceCutoverPanel|EmployeeSafetyBackupPanel)$/ }, () => ({ path: 'sibling', namespace: 'release-sibling' }));
      b.onLoad({ filter: /.*/, namespace: 'release-sibling' }, () => ({ contents: siblingMock, loader: 'tsx', resolveDir: root }));
    } }] });
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const file of ['SiteReleasePanel.tsx', 'EmployeeSiteImport.tsx', 'EmployeeDataMigration.tsx']) assert.ok(inputs.some(path => path.endsWith('/' + file)), 'actual component required: ' + file);
  assert.equal(inputs.some(path => /node_modules\/@supabase|src\/lib\/(?:auth|supabase)\.ts|employeeTransfer\/(?:siteRelease|siteImport|sourceCutover)\.ts$/.test(path)), false, 'no production API/auth code in isolated UI');
  const config = loadTailwindConfig(root + 'tailwind.config.js');
  const css = await postcss([tailwindcss({ ...config, content: [root + 'src/components/admin/{SiteReleasePanel,EmployeeSiteImport,EmployeeDataMigration}.tsx'] })])
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
  console.log(`site release UI local entry: ${workspace}; screenshots: ${screenshotDir}`);
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (workspace) await rm(workspace, { recursive: true, force: true });
  assert.equal(foreignRequests, 0, 'zero external requests');
  console.log(`site release UI temporary HTML/JS/CSS removed: ${workspace}; screenshots retained: ${screenshotDir}; external requests: ${foreignRequests}`);
});
const panel = page => page.getByRole('region', { name: '新站最終啟用', exact: true });
const queryButton = page => panel(page).getByRole('button', { name: '查詢啟用條件', exact: true });
const releaseButton = page => panel(page).getByRole('button', { name: '核對並啟用新站', exact: true });
const password = page => panel(page).getByLabel('新站超級管理員密碼', { exact: true });
const confirmation = page => panel(page).getByLabel('輸入「確認啟用新站」', { exact: true });
const released = page => panel(page).getByRole('region', { name: '新站啟用回執', exact: true });
async function query(page) { await queryButton(page).click(); await page.waitForFunction(() => document.querySelector('section[aria-busy]')?.getAttribute('aria-busy') === 'false'); }
async function fill(page, text = CONFIRM) { await password(page).fill(PASSWORD); await confirmation(page).fill(text); }
async function screenshot(page, engine, name) { const path = join(screenshotDir, `${engine}-${name}.png`); await page.screenshot({ path, fullPage: true }); console.log(`site release UI screenshot: ${path}`); }
async function noSecrets(page) {
  const text = await page.locator('body').innerText();
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  for (const secret of [PASSWORD, PASS, TOKEN, 'PRIVATE-RELEASE-ERROR', 'PRIVATE-STATUS-ERROR']) { assert.equal(text.includes(secret), false); assert.equal(storage.includes(secret), false); }
}
async function scenario(browser, engine, label, fn, options = {}) {
  const { query: search = '', viewport = { width: 1280, height: 900 }, ...contextOptions } = options;
  const context = await browser.newContext({ viewport, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block', ...contextOptions });
  const errors = [], foreign = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    foreignRequests++; foreign.push(route.request().url()); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  try { await page.goto(base + '/?' + search); await panel(page).waitFor({ state: search.includes('parent') ? 'hidden' : 'visible' }); await fn(page); await noSecrets(page); }
  catch (error) { await screenshot(page, engine, 'failure-' + label).catch(() => {}); throw error; }
  finally {
    const h = await page.evaluate(() => ({ forbidden: window.__h?.forbidden, violations: window.__h?.violations }));
    await context.close(); assert.deepEqual(errors, []); assert.deepEqual(foreign, []); assert.deepEqual(h.forbidden, []); assert.deepEqual(h.violations, []);
  }
}
const parentOptions = { query: 'view=parent', userAgent: 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36' };
async function prepareParent(page) {
  await page.getByRole('tab', { name: '導入', exact: true }).click();
  await page.locator('#migration-files').setInputFiles({ name: 'local.edx', mimeType: 'application/octet-stream', buffer: Buffer.from('synthetic') });
  await page.locator('#migration-inspect-passphrase').fill(PASS);
  await page.getByRole('button', { name: '僅解密與核驗，不導入', exact: true }).click();
  await page.getByRole('button', { name: '查詢目標准入（只讀）', exact: true }).click();
  await page.locator('#migration-import-passphrase').fill(PASS); await page.locator('#migration-import-password').fill(PASSWORD);
  await page.getByRole('button', { name: '選擇獨立備份保存目錄', exact: true }).click();
  await page.locator('#migration-import-confirmation').fill('確認導入員工資料');
  await page.getByRole('checkbox', { name: /^我確認這是隔離/ }).check();
  await page.getByRole('button', { name: '開始實際導入（保持維護）', exact: true }).click();
  await page.getByRole('heading', { name: '十領域維護態核驗已通過，仍不可恢復營業', exact: true }).waitFor();
  await page.waitForFunction(() => window.__h.reports.some(r => r.name === 'site-import-report.json'));
}
function assertReleaseReport(report) {
  assert.equal(report.name, 'site-release-report.json');
  assert.deepEqual(JSON.parse(report.text).receipt, receipt);
  assert.equal(JSON.parse(report.text).fullSiteComplete, false);
  for (const secret of [PASSWORD, PASS, TOKEN, 'session', 'password', 'job_token', 'session_token']) assert.equal(report.text.includes(secret), false, 'redacted report excludes ' + secret);
}
async function unloadBlocked(page) { return page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }); }
for (const engine of ['chromium', 'webkit']) {
  test(`isolated ${engine} new-site release UI`, { timeout: 180000 }, async t => {
    const executablePath = process.env[`EMPLOYEE_TRANSFER_${engine.toUpperCase()}_EXECUTABLE`];
    const browser = await playwright[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const run = (label, fn, options) => t.test(label, () => scenario(browser, engine, label, fn, options));
    try {
      await run('explicit-read-before-credentials-and-exact-confirmation', async page => {
        assert.deepEqual(await page.evaluate(() => window.__h.calls), []);
        assert.equal(await password(page).isDisabled(), true); assert.equal(await releaseButton(page).isDisabled(), true);
        await panel(page).locator('form').dispatchEvent('submit'); assert.deepEqual(await page.evaluate(() => window.__h.calls), []);
        await query(page); await panel(page).getByText(/候選條件通過，尚未啟用/).waitFor();
        assert.equal(await releaseButton(page).isDisabled(), true);
        for (const text of ['確認啟用新站 ', ' 確認啟用新站', '确认启用新站', '確認啟用']) { await fill(page, text); assert.equal(await releaseButton(page).isDisabled(), true); }
        await fill(page); await password(page).fill(''); assert.equal(await releaseButton(page).isDisabled(), true);
        await fill(page); assert.equal(await releaseButton(page).isEnabled(), true);
        assert.equal(await panel(page).getByRole('checkbox').count(), 0, 'no extra old-site checklist');
        await screenshot(page, engine, 'candidate');
      });
      await run('golden-status-password-confirm-release-receipt', async page => {
        await query(page); await fill(page); await releaseButton(page).click(); await released(page).waitFor();
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['status', 'release']);
        assert.equal(await password(page).inputValue(), ''); assert.equal(await confirmation(page).inputValue(), '');
        assert.equal(await releaseButton(page).isDisabled(), true); assert.equal(await page.evaluate(() => window.__h.busy), false);
        assert.deepEqual(await released(page).locator('dd').allTextContents(), ['7', '3', '2', '1', '2', '3']);
        await released(page).getByText(/已恢復來源帳號原啟用／停用狀態與自動化原狀態，新站維護已解除；不是全員啟用/).waitFor();
        await released(page).getByText(/full_site_complete=false/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.receipts.length), 1);
        await screenshot(page, engine, 'released');
      });
      await run('all-five-blockers-in-server-order-fail-closed', async page => {
        await page.evaluate(() => { window.__h.state.blockers = ['missing_cutoff', 'cutoff_expired', 'not_verified', 'task_not_running', 'maintenance_mismatch']; window.__h.state.can_release = false; });
        await query(page);
        assert.deepEqual(await panel(page).getByRole('list', { name: '啟用阻擋項目' }).locator('li').allTextContents(), [
          '沒有切站截止憑據；日常備份包不能啟用新站。', '切站截止憑據已超過同一 UTC 日，不能啟用。',
          '尚未取得本次十領域服務端總核對，不能啟用。', '導入任務已不在可啟用的執行狀態。', '目前新站維護狀態與本次任務不一致。',
        ]);
        assert.equal(await password(page).isDisabled(), true); assert.equal(await releaseButton(page).isDisabled(), true);
      });
      await run('freeze-and-UTC-day-deadline-displayed-in-UTC8', async page => {
        const dd = await panel(page).locator('dd').allTextContents();
        assert.match(dd[0], /2026\/10\/23.*04:13:14.*UTC\+8/);
        assert.match(dd[1], /2026\/10\/23.*08:00:00.*UTC\+8.*前/);
        await panel(page).getByText(/UTC 換日為 UTC\+8 每日 08:00/).waitFor();
      });
      await run('daily-cutoff-missing-no-release', async page => {
        await query(page); await panel(page).getByText(/僅有日常備份包，無切站憑據/).waitFor();
        assert.equal(await password(page).isDisabled(), true); assert.equal(await releaseButton(page).isDisabled(), true);
      }, { query: 'state=missing' });
      await run('parent-disabled-and-held-query-disable-duplicate-actions', async page => {
        await page.evaluate(() => window.__setDisabled(true));
        assert.equal(await queryButton(page).isDisabled(), true);
        await page.evaluate(() => { window.__setDisabled(false); window.__h.nextStatus = { hold: true }; });
        await queryButton(page).click(); await page.waitForFunction(() => !!window.__h.gates.status);
        assert.equal(await queryButton(page).isDisabled(), true); assert.equal(await releaseButton(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.busy), true);
        await panel(page).locator('form').dispatchEvent('submit');
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['status']);
        await page.evaluate(() => window.__h.gates.status());
        await page.waitForFunction(() => !window.__h.busy); assert.equal(await password(page).isEnabled(), true);
      });
      await run('pending-write-prevents-double-submit-and-read-until-settled', async page => {
        await query(page); await fill(page); await page.evaluate(() => { window.__h.nextRelease = { hold: true }; });
        await panel(page).locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await page.waitForFunction(() => !!window.__h.gates.release);
        assert.equal(await queryButton(page).isDisabled(), true); assert.equal(await releaseButton(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.busy), true); assert.equal(await released(page).count(), 0);
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['status', 'release']);
        await page.evaluate(() => window.__h.gates.release()); await released(page).waitFor();
      });
      await run('lost-write-failed-read-locks-until-fresh-released-status', async page => {
        await query(page); await fill(page); await page.evaluate(() => { window.__h.nextRelease = { lost: true }; });
        await releaseButton(page).click(); await panel(page).getByText(/本次啟用結果未知/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.busy), true); assert.equal(await queryButton(page).isEnabled(), true);
        assert.equal(await releaseButton(page).isDisabled(), true); assert.equal(await released(page).count(), 0);
        await page.evaluate(() => { window.__setDisabled(true); window.__h.nextStatus = { lost: true }; });
        await queryButton(page).click(); await panel(page).getByText(/未能確認啟用條件/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.busy), true); assert.equal(await queryButton(page).isEnabled(), true);
        await query(page); await released(page).waitFor();
        assert.equal(await page.evaluate(() => window.__h.busy), false);
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['status', 'release', 'status', 'status']);
      });
      await run('unknown-not-committed-fresh-status-requires-new-password', async page => {
        await query(page); await fill(page); await page.evaluate(() => { window.__h.nextRelease = { lost: true, noCommit: true }; });
        await releaseButton(page).click(); await panel(page).getByText(/本次啟用結果未知/).waitFor();
        await query(page); assert.equal(await page.evaluate(() => window.__h.busy), false);
        assert.equal(await releaseButton(page).isDisabled(), true); assert.equal(await password(page).inputValue(), '');
        await fill(page); await releaseButton(page).click(); await released(page).waitFor();
      });
      await run('already-released-status-restores-receipt-without-release-call', async page => {
        await query(page); await released(page).waitFor();
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['status']);
        assert.equal(await releaseButton(page).isDisabled(), true);
        await query(page); assert.equal(await page.evaluate(() => window.__h.receipts.length), 1);
      }, { query: 'state=released' });
      await run('historical-release-receipt-does-not-hide-new-maintenance', async page => {
        await page.evaluate(() => { window.__h.markReleased(); window.__h.state.maintenance = true; });
        await query(page); await released(page).waitFor();
        await panel(page).getByText(/目前另有維護保護；以下是先前啟用的回執/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.busy), false);
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['status']);
        assert.equal(await releaseButton(page).isDisabled(), true);
      });
      await run('read-failure-discards-stale-candidate-without-write', async page => {
        await query(page); await fill(page); await page.evaluate(() => { window.__h.nextStatus = { lost: true }; });
        await queryButton(page).click(); await panel(page).getByText(/未能確認啟用條件/).waitFor();
        assert.equal(await releaseButton(page).isDisabled(), true); assert.equal(await password(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.busy), false);
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['status', 'status']);
      });
      await run('mismatched-receipt-remains-unknown-until-fresh-status', async page => {
        await query(page); await fill(page);
        await page.evaluate(() => { window.__h.nextRelease = { data: { ...window.__h.state, scope: 'site-release', job_id: 'wrong' } }; });
        await releaseButton(page).click(); await panel(page).getByText(/本次啟用結果未知/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.busy), true); assert.equal(await released(page).count(), 0);
        await query(page); await released(page).waitFor();
      });
      await run('report-callback-failure-does-not-retry-or-hide-release', async page => {
        await query(page); await fill(page); await page.evaluate(() => { window.__h.receiptFail = true; });
        await releaseButton(page).click(); await released(page).waitFor();
        await panel(page).getByText(/本機報告未確認保存；不要因此重試啟用/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.busy), false);
        await panel(page).locator('form').dispatchEvent('submit'); await query(page);
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['status', 'release', 'status']);
        assert.equal(await page.evaluate(() => window.__h.receipts.length), 1);
      });
      await run('forced-unmount-does-not-abort-inflight-write-or-unlock', async page => {
        await query(page); await fill(page); await page.evaluate(() => { window.__h.nextRelease = { hold: true }; });
        await releaseButton(page).click(); await page.waitForFunction(() => !!window.__h.gates.release);
        await page.evaluate(() => window.__unmount());
        assert.equal(await page.evaluate(() => window.__h.busy), true);
        assert.equal(await page.evaluate(() => window.__h.signals.at(-1).aborted), false);
        await page.evaluate(() => window.__h.gates.release());
        assert.equal(await page.evaluate(() => window.__h.busy), true);
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['status', 'release']);
      });
      await run('375px-no-overflow-and-keyboard-form', async page => {
        await query(page); await fill(page); await confirmation(page).press('Enter'); await released(page).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await screenshot(page, engine, 'mobile-375');
      }, { viewport: { width: 375, height: 812 } });
      await run('parent-import-remains-maintenance-until-explicit-release-and-saves-two-reports', async page => {
        await prepareParent(page); assert.deepEqual(await page.evaluate(() => window.__h.calls), ['picker', 'import']);
        assert.equal(await releaseButton(page).isDisabled(), true); assert.equal(await unloadBlocked(page), false);
        await page.evaluate(({ TOKEN }) => { window.__h.receiptExtra = { session_token: TOKEN }; }, { TOKEN });
        await query(page); await fill(page); await releaseButton(page).click(); await released(page).waitFor();
        await page.getByText(/已另存不含密碼或會話令牌的 site-release-report.json/).waitFor();
        await page.getByRole('heading', { name: '先前導入至維護態的核驗紀錄（新站已另行啟用）', exact: true }).waitFor();
        const reports = await page.evaluate(() => window.__h.reports);
        assert.deepEqual(reports.map(r => r.name), ['site-import-report.json', 'site-release-report.json']);
        assert.equal(JSON.parse(reports[0].text).maintenance, true); assert.equal(JSON.parse(reports[0].text).accountActivationPerformed, false);
        assertReleaseReport(reports[1]); assert.equal(await unloadBlocked(page), false);
        await screenshot(page, engine, 'parent-released');
      }, parentOptions);
      await run('parent-unknown-write-keeps-siblings-locked-and-tab-instance-alive', async page => {
        await prepareParent(page); await query(page); await fill(page);
        await page.evaluate(() => { window.__h.nextRelease = { hold: true, lost: true }; });
        await releaseButton(page).click(); await page.waitForFunction(() => !!window.__h.gates.release);
        assert.equal(await page.locator('#migration-files').isDisabled(), true); assert.equal(await unloadBlocked(page), true);
        assert.equal(await page.getByRole('button', { name: '隔離兄弟操作邊界', exact: true }).isDisabled(), true);
        const exportButton = page.getByRole('button', { name: '開始目前十個領域加密導出', exact: true, includeHidden: true });
        assert.equal(await exportButton.isDisabled(), true);
        await page.getByRole('tab', { name: '紀錄', exact: true }).click();
        await page.getByRole('tab', { name: '導入', exact: true }).click();
        assert.equal(await queryButton(page).isDisabled(), true);
        await page.evaluate(() => window.__h.gates.release()); await panel(page).getByText(/本次啟用結果未知/).waitFor();
        assert.equal(await unloadBlocked(page), true); assert.equal(await page.locator('#migration-files').isDisabled(), true);
        await page.evaluate(() => { window.__h.nextStatus = { lost: true }; });
        await queryButton(page).click(); await panel(page).getByText(/未能確認啟用條件/).waitFor();
        assert.equal(await page.locator('#migration-files').isDisabled(), true); assert.equal(await queryButton(page).isEnabled(), true);
        await query(page); await released(page).waitFor();
        assert.equal(await page.locator('#migration-files').isEnabled(), true); assert.equal(await unloadBlocked(page), false);
        assert.equal(await page.getByRole('button', { name: '隔離兄弟操作邊界', exact: true }).isEnabled(), true);
        assert.equal(await page.evaluate(() => window.__h.calls.filter(c => c === 'release').length), 1);
      }, parentOptions);
      await run('parent-report-failure-retains-success-and-does-not-rerelease', async page => {
        await prepareParent(page); await query(page); await fill(page); await page.evaluate(() => { window.__h.reportFail = true; });
        await releaseButton(page).click(); await released(page).waitFor();
        await page.getByText(/site-release-report.json 未能確認保存/).waitFor();
        assert.equal(await releaseButton(page).isDisabled(), true); assert.equal(await unloadBlocked(page), false);
        await query(page); assert.equal(await page.evaluate(() => window.__h.calls.filter(c => c === 'release').length), 1);
        assert.equal(await page.evaluate(() => window.__h.reports.filter(r => r.name === 'site-release-report.json').length), 1);
      }, parentOptions);
      await run('parent-report-pending-keeps-interlock-without-hiding-confirmed-receipt', async page => {
        await prepareParent(page); await query(page); await fill(page); await page.evaluate(() => { window.__h.reportHold = true; });
        await releaseButton(page).click(); await page.waitForFunction(() => !!window.__h.gates.report);
        await released(page).waitFor(); assert.equal(await unloadBlocked(page), true);
        await panel(page).getByText(/服務端已確認本次啟用，正在保存本機回執/).waitFor();
        assert.equal((await panel(page).innerText()).includes('尚待服務端確認'), false);
        assert.equal(await page.locator('#migration-files').isDisabled(), true); assert.equal(await queryButton(page).isDisabled(), true);
        await page.evaluate(() => window.__h.gates.report()); await page.getByText(/已另存不含密碼或會話令牌/).waitFor();
        assert.equal(await page.locator('#migration-files').isEnabled(), true);
      }, parentOptions);
      await run('parent-already-released-status-saves-receipt-without-writing-release', async page => {
        await prepareParent(page); await page.evaluate(() => window.__h.markReleased());
        await query(page); await released(page).waitFor();
        await page.getByText(/已另存不含密碼或會話令牌的 site-release-report.json/).waitFor();
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['picker', 'import', 'status']);
        assertReleaseReport(await page.evaluate(() => window.__h.reports.at(-1)));
        assert.equal(await releaseButton(page).isDisabled(), true);
      }, parentOptions);
      await run('parent-daily-null-session-has-no-release-entry', async page => {
        await prepareParent(page); assert.equal(await panel(page).count(), 0);
        await page.getByText(/僅有日常備份包，無切站憑據，不能啟用新站；導入結果維持維護態/).waitFor();
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['picker', 'import']);
      }, { ...parentOptions, query: 'view=parent&state=daily' });
      await run('legacy-outcome-without-session-still-renders-maintenance-result', async page => {
        await prepareParent(page); assert.equal(await panel(page).count(), 0);
        assert.deepEqual(await page.evaluate(() => window.__h.reports.map(r => r.name)), ['site-import-report.json']);
      }, { ...parentOptions, query: 'view=parent&state=legacy' });
    } finally { await browser.close(); }
  });
}
