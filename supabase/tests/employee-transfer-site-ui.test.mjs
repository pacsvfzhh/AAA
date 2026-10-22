import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
let playwright;
if (process.env.EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE) playwright = await import(pathToFileURL(process.env.EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE).href);
else {
  try { playwright = await import('playwright'); } catch { /* Optional isolated browser runner, not a production dependency. */ }
}
const domains = ['shared', 'products', 'dispatch', 'identity', 'finance', 'activity', 'verification', 'notifications', 'chat', 'archives'];
const id = n => `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PASS = 'local-only-long-passphrase';
const PASSWORD = 'local-password-canary';
const planHash = 'a'.repeat(64);
const pendingAmount = '9007199254740993.1234567890123456789000';
const serverVerification = {
  version: 1, success: true, scope: 'site-restore-verification', job_id: id(6), source_site_id: id(3), package_id: id(2),
  verification_hash: 'c'.repeat(64), verified_domains: domains,
  counts: { employees: 7, pending_withdrawals: 3, pending_withdrawal_amount: pendingAmount },
  maintenance: true, accounts_active: false, automation_resumed: false, can_release: false, full_site_complete: false,
};
const mocks = `
export const SITE_DOMAINS=${JSON.stringify(domains)};
const id=n=>'72000000-0000-4000-8000-'+String(n).padStart(12,'0');
const h=()=>window.__h;
export const getSiteTransferCapabilities=async()=>({version:1,site_id:id(1),can_export:true,can_import:false,missing_rpcs:[],import_blockers:[],export_protocol:'local'});
export const getSiteTransferHistory=async()=>[];
export const stopSiteExportTask=async()=>{h().forbidden.push('stop-export');throw Error('forbidden')};
export class EmployeeSafetyBackupError extends Error {}
export const createEmployeeSafetyBackupSession=()=>{h().forbidden.push('employee-backup');throw Error('forbidden')};
export const exportEmployeeSafetyBackup=async()=>{h().forbidden.push('employee-backup-export');throw Error('forbidden')};
export const stopOwnedEmployeeSafetyBackup=async()=>{h().forbidden.push('employee-backup-stop');throw Error('forbidden')};
export class EmployeeSafetyMediaError extends Error {}
export const createEmployeeSafetyMediaSource=()=>{h().forbidden.push('employee-media-source');throw Error('forbidden')};
export const exportEmployeeSafetyMediaBackup=async()=>{h().forbidden.push('employee-media-export');throw Error('forbidden')};
export const withAuthenticatedEmployeeSafetyMediaBackup=async()=>{h().forbidden.push('employee-media-reader');throw Error('forbidden')};
export const exportSiteBundleSet=async()=>{h().forbidden.push('export');throw Error('forbidden')};
const bundle=()=>({packageId:id(2),sourceSiteId:id(3),volumes:SITE_DOMAINS.map((domain,i)=>({domain,filename:domain+'.edx',cipherBytes:128,cipherSha256:'a'.repeat(64),rows:i+1,files:0})),fullSiteComplete:false,importReady:false});
export async function inspectSiteBundleSet(files,pass,factory,{onProgress}){
 h().calls.push('inspect');
 if(files.length!==11||pass!=='${PASS}'||h().badInput)throw Error('local rejected');
 onProgress({domain:'site',phase:'authenticate',completedDomains:0,totalDomains:10,rows:0,files:11,bytes:1408});
 return bundle();
}
export const createBrowserWorkspaceFactory=async()=>()=>({open(){},append(){},abort(){}});
export const pickTransferDirectory=async()=>{
 h().calls.push('picker'); if(h().pickerFail)throw Error('denied');
 return {name:'isolated-backup-directory',createFile(){throw Error('UI mock must never upload')},writeText:async(name,text)=>{h().reports.push({name,text});if(h().reportFail)throw Error('disk')}};
};
export async function getSiteImportPreflight(source){
 h().calls.push('preflight');if(h().preflightFail)throw Error('expired');
 return {version:1,protocol:'site-maintenance-restore-v3',site_id:id(1),source_site_id:source,can_restore_to_maintenance:!h().blocker,blockers:h().blocker?[h().blocker]:[],missing_rpcs:[],full_site_complete:false,can_release:false};
}
const role=(n,match,target)=>({source_id:id(n),source_name:n===20?'<img src=x onerror=window.__xss=true>':'角色'+n,source_number:'CUS-'+n,target_admin_id:id(4),source_type:'aaa_service',match,target_id:target,candidates:[{id:id(30),name:'現有角色',number:'CUS-30'},{id:id(31),name:'另一角色',number:'CUS-31'}],needs_confirmation:match==='ambiguous',number_occupied:false,visibility_employee_ids:[],multi_source_target:false});
export async function importSiteBundleSetToMaintenance(o){
 h().calls.push('import');h().imports++;h().importSignal=o.signal;
 if(o.confirmation!=='確認導入員工資料'||o.adminPassword!=='${PASSWORD}'||o.passphrase!=='${PASS}')throw Error('wrong explicit input');
 const verified=[];
 for(const domain of SITE_DOMAINS){
   await o.beforeDomain();o.signal.throwIfAborted();
   o.onProgress({domain,phase:'stage',completedDomains:verified.length,totalDomains:10,rows:17,files:2,bytes:256});
   if(h().failDomain===domain)throw Error('lost response with secret ${PASSWORD}');
   if(domain==='chat'){
     h().decisions=await o.chooseChatRoles({roles:[role(20,'ambiguous',null),role(21,'name',id(30))]});
     o.signal.throwIfAborted();
   }
   const plan={scope:domain,plan_hash:'${planHash}',counts:{orders:2},employees:1};
   if(domain==='shared')plan.admins=[{username:'舊管理員',source_id:id(4),target_id:id(5),action:'replace',password_hash:'DO_NOT_RENDER_CANARY'}];
   if(domain==='finance')plan.pending_withdrawals={count:1,amount:'12.340000000000000001'};
   if(domain==='chat')plan.roles=h().decisions.map(d=>({...d,action:d.target_id?'merge':'create',visibility_employee_ids:[id(8)],multi_source_target:true}));
   const allowed=await o.approvePlan(domain,plan);o.signal.throwIfAborted();
   h().approvals.push({domain,allowed});if(allowed!==true)throw Error('not approved');
   if(domain==='dispatch'){
     if(!await o.approvePlan('dispatch',{scope:'dispatch-configuration',plan_hash:'b'.repeat(64),group_map:{[id(9)]:id(10)}}))throw Error('not approved');
   }
   verified.push(domain);
   o.onProgress({domain,phase:'verified',completedDomains:verified.length,totalDomains:10,rows:19,files:2,bytes:512});
 }
 o.signal.throwIfAborted();
 const serverVerification=${JSON.stringify(serverVerification)};
 if(h().emptySite)serverVerification.counts={employees:0,pending_withdrawals:0,pending_withdrawal_amount:'0.0000'};
 if(h().pendingAmount!==undefined)serverVerification.counts.pending_withdrawal_amount=h().pendingAmount;
 return {jobId:id(6),verifiedDomains:verified,maintenance:true,fullSiteComplete:false,importReady:false,serverVerification};
}
`;
let server, base, script, css = '';
before(async () => {
  if (!playwright) return;
  const compiled = await build({
    stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import Page from './src/components/admin/EmployeeDataMigration';
      window.__h={calls:[],forbidden:[],reports:[],approvals:[],imports:0};const r=createRoot(document.getElementById('root'));window.__unmount=()=>r.unmount();r.render(<Page/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic', metafile: true,
    plugins: [{ name: 'isolated-ui-boundaries', setup(builder) {
      builder.onResolve({ filter: /employeeTransfer\/(siteTransfer|siteImport|browserStorage|employeeSafetyBackup|employeeSafetyMedia)$/ }, () => ({ path: 'transfer-ui-mocks', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mocks }));
    } }],
  });
  assert.ok(!Object.keys(compiled.metafile.inputs).some(path => /node_modules\/@supabase|src\/lib\/(?:auth|supabase)\.ts|employeeTransfer\/employeeSafety(?:Backup|Media)\.ts/.test(path)), 'import UI must isolate employee backup and production access');
  script = compiled.outputFiles[0].text;
  try {
    const assets = await readdir(root + 'dist/assets');
    const filename = assets.find(name => /^index-.*\.css$/.test(name));
    if (filename) css = await readFile(root + 'dist/assets/' + filename, 'utf8');
  } catch { /* Interaction tests can run without a prior production build. */ }
  server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); }
    else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<html lang="zh-Hant"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="margin:0;background:#0f172a"><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function scenario(browser, fn, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const foreign = [], errors = [];
  await context.route('**/*', route => {
    if (route.request().url().startsWith(base + '/')) return route.continue();
    foreign.push(route.request().url()); return route.abort();
  });
  await context.addInitScript(() => { window.showDirectoryPicker = async () => {}; });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await page.getByRole('tab', { name: '導入', exact: true }).click();
    await fn(page);
    assert.deepEqual(foreign, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__h.forbidden), []);
  } finally { await context.close(); }
}
const startButton = page => page.getByRole('button', { name: '開始實際導入（保持維護）', exact: true });
async function inspect(page) {
  await page.locator('#migration-files').setInputFiles(Array.from({ length: 11 }, (_, i) => ({ name: `local-${i}.edx`, mimeType: 'application/octet-stream', buffer: Buffer.from('synthetic-only') })));
  await page.locator('#migration-inspect-passphrase').fill(PASS);
  await page.getByRole('button', { name: '僅解密與核驗，不導入', exact: true }).click();
  await page.getByText('輸入檔案各卷解密核驗結果', { exact: true }).waitFor();
}
async function prepare(page) {
  await inspect(page);
  await page.getByRole('button', { name: '查詢目標准入（只讀）', exact: true }).click();
  await page.locator('#migration-import-passphrase').fill(PASS);
  await page.locator('#migration-import-password').fill(PASSWORD);
  await page.getByRole('button', { name: '選擇獨立備份保存目錄', exact: true }).click();
  await page.locator('#migration-import-confirmation').fill('確認導入員工資料');
  await page.getByRole('checkbox', { name: /^我確認這是隔離/ }).check();
  assert.equal(await startButton(page).isEnabled(), true);
}
async function approve(page) {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: '確認本階段並繼續', exact: true }).isDisabled(), true, 'every new plan requires fresh acknowledgment');
  await dialog.getByRole('checkbox', { name: /^我已核對/ }).check();
  await dialog.getByRole('button', { name: '確認本階段並繼續', exact: true }).click();
}

async function completeImport(page) {
  await startButton(page).click();
  for (let i = 0; i < 9; i++) await approve(page);
  const roles = page.getByRole('dialog', { name: '確認聊天角色對應', exact: true });
  await roles.getByRole('combobox').first().selectOption('new');
  await approve(page);
  await approve(page);
  await approve(page);
  await page.getByRole('heading', { name: '十領域維護態核驗已通過，仍不可恢復營業', exact: true }).waitFor();
}
async function assertServerSummary(page, counts = serverVerification.counts) {
  const summary = page.getByRole('region', { name: '服務端總核對摘要', exact: true });
  await summary.getByRole('heading', { name: '服務端總核對已通過', exact: true }).waitFor();
  assert.deepEqual(await summary.locator('dt').allTextContents(), ['員工數', '待處理提款筆數', '待處理提款金額']);
  assert.deepEqual(await summary.locator('dd').allTextContents(), [String(counts.employees), String(counts.pending_withdrawals), counts.pending_withdrawal_amount]);
  await summary.getByText(/同一次原子核對中重新驗證實際資料；此回執不是營業放行/).waitFor();
  await summary.getByText(serverVerification.verification_hash, { exact: true }).waitFor();
  await page.getByText(/帳號仍停用、自動化仍暫停、維護保護仍持續，尚未放行/).waitFor();
  return summary;
}
function assertReportReceipt(saved, expected = serverVerification) {
  assert.equal(saved.name, 'site-import-report.json');
  const report = JSON.parse(saved.text);
  assert.equal(report.status, 'verified-to-maintenance-only');
  assert.deepEqual(report.serverVerification, expected, 'save the complete redacted server receipt without rounding or dropping fields');
  assert.equal(report.jobId, report.serverVerification.job_id);
  assert.equal(report.sourceSiteId, report.serverVerification.source_site_id);
  assert.equal(report.packageId, report.serverVerification.package_id);
  assert.equal(report.targetSiteId, id(1));
  assert.deepEqual(report.verifiedDomains, domains);
  assert.equal(report.maintenance, true);
  for (const key of ['canRelease', 'fullSiteComplete', 'accountActivationPerformed', 'automationResumed', 'rollbackConfirmed']) assert.equal(report[key], false);
  for (const secret of [PASSWORD, PASS, 'DO_NOT_RENDER_CANARY', '<img', 'password_hash', 'job_token', 'session_token']) assert.equal(saved.text.includes(secret), false, 'report must not include secrets or raw plan content');
}

for (const engine of ['chromium', 'webkit']) {
  test(`isolated ${engine} migration UI: approvals, failures, cancellation and maintenance-only result`, { skip: !playwright, timeout: 180000 }, async t => {
    const executablePath = process.env[`EMPLOYEE_TRANSFER_${engine.toUpperCase()}_EXECUTABLE`];
    const browser = await playwright[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      await t.test('local input check never starts database restore; target conflicts fail closed', () => scenario(browser, async page => {
        assert.equal(await startButton(page).isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: '查詢目標准入（只讀）', exact: true }).isDisabled(), true);
        await inspect(page);
        assert.deepEqual(await page.evaluate(() => window.__h.calls), ['inspect']);
        assert.equal(await startButton(page).isDisabled(), true);
        await page.evaluate(() => { window.__h.blocker = 'target_has_business'; });
        await page.getByRole('button', { name: '查詢目標准入（只讀）', exact: true }).click();
        await page.getByText(/空站模式不允許覆蓋/).waitFor();
        assert.equal(await startButton(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.imports), 0);
      }));
      await t.test('unsupported protocol/session query failure has no write side effects', () => scenario(browser, async page => {
        await inspect(page);
        await page.evaluate(() => { window.__h.preflightFail = true; });
        await page.getByRole('button', { name: '查詢目標准入（只讀）', exact: true }).click();
        await page.getByText(/無法確認目標是否支援維護態導入第 3 版協議/).waitFor();
        assert.equal(await startButton(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.imports), 0);
      }));
      const chromiumUA = { userAgent: 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36' };
      await t.test('all stages need approval; ambiguity, visibility, exact money, report and no business release', () => scenario(browser, async page => {
        await prepare(page);
        await page.locator('#migration-import-confirmation').fill('wrong');
        assert.equal(await startButton(page).isDisabled(), true);
        await page.locator('#migration-import-confirmation').fill('確認導入員工資料');
        await startButton(page).click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        assert.equal(await page.locator('#migration-files').isDisabled(), true);
        assert.equal(await page.locator('#migration-panel-export button[type="submit"]').isDisabled(), true);
        assert.equal((await page.locator('body').innerText()).includes('DO_NOT_RENDER_CANARY'), false);
        await page.getByRole('tab', { name: '紀錄', exact: true }).dispatchEvent('click');
        assert.equal(await dialog.isVisible(), true, 'navigation must not remount pending approval');
        await page.getByRole('tab', { name: '導入', exact: true }).dispatchEvent('click');
        for (let i = 0; i < 9; i++) {
          if (i === 5) await dialog.getByText(/12\.340000000000000001/).waitFor();
          await approve(page);
        }
        await page.getByRole('dialog', { name: '確認聊天角色對應', exact: true }).waitFor();
        const selects = dialog.getByRole('combobox');
        assert.equal(await selects.nth(0).inputValue(), '');
        await dialog.getByRole('checkbox', { name: /^我已核對/ }).check();
        assert.equal(await dialog.getByRole('button', { name: '確認本階段並繼續', exact: true }).isDisabled(), true);
        await selects.nth(0).selectOption(id(30));
        assert.equal(await dialog.getByRole('checkbox', { name: /^我已核對/ }).isChecked(), false);
        await dialog.getByText(/多個舊角色將合併到同一/).waitFor();
        const visibility = dialog.getByRole('checkbox', { name: /^允許把匯入員工加入/ });
        assert.equal(await visibility.count(), 2, 'manual target selection must show visibility choice even if prior diff was empty');
        await visibility.first().uncheck();
        await dialog.getByRole('checkbox', { name: /^我已核對/ }).check();
        await dialog.getByRole('button', { name: '確認本階段並繼續', exact: true }).click();
        await page.getByRole('dialog', { name: '確認聊天計畫', exact: true }).waitFor();
        await dialog.getByText('涉及可見性差集：1 名；不追加', { exact: true }).waitFor();
        await approve(page);
        await approve(page);
        await page.getByText('十領域維護態核驗已通過，仍不可恢復營業', { exact: true }).waitFor();
        await assertServerSummary(page);
        assert.equal(await startButton(page).isDisabled(), true);
        assert.equal(await page.locator('#migration-import-password').inputValue(), '');
        assert.equal(await page.locator('#migration-import-passphrase').inputValue(), '');
        assert.equal(await page.evaluate(() => window.__xss === true), false);
        assert.notEqual(await page.locator('section[aria-label="各卷核驗結果"] td').first().evaluate(element => getComputedStyle(element).color), 'rgb(0, 0, 0)', 'dark theme result table must remain readable');
        const state = await page.evaluate(() => ({ imports: window.__h.imports, decisions: window.__h.decisions, reports: window.__h.reports }));
        assert.equal(state.imports, 1); assert.equal(state.decisions[0].allow_visibility, false);
        assert.equal(state.reports.length, 1);
        assertReportReceipt(state.reports[0]);
        if (process.env.EMPLOYEE_TRANSFER_UI_SCREENSHOT && engine === 'chromium') await page.screenshot({ path: process.env.EMPLOYEE_TRANSFER_UI_SCREENSHOT, fullPage: true });
      }, chromiumUA));
      await t.test('zero employees and pending withdrawals keep the original zero amount and full receipt', () => scenario(browser, async page => {
        await prepare(page);
        await page.evaluate(() => { window.__h.emptySite = true; });
        await completeImport(page);
        const expected = { ...serverVerification, counts: { employees: 0, pending_withdrawals: 0, pending_withdrawal_amount: '0.0000' } };
        await assertServerSummary(page, expected.counts);
        const saved = await page.evaluate(() => window.__h.reports);
        assert.equal(saved.length, 1);
        assertReportReceipt(saved[0], expected);
        assert.equal(await startButton(page).isDisabled(), true);
      }, chromiumUA));
      await t.test('375px successful server summary wraps long exact money and hash without horizontal overflow', () => scenario(browser, async page => {
        const amount = '123456789012345678901234567890123456789012345678901234567890.1234567890123456789000';
        await prepare(page);
        await page.evaluate(value => { window.__h.pendingAmount = value; }, amount);
        await completeImport(page);
        const expected = { ...serverVerification, counts: { ...serverVerification.counts, pending_withdrawal_amount: amount } };
        const summary = await assertServerSummary(page, expected.counts);
        await summary.scrollIntoViewIfNeeded();
        const bounds = await summary.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375, 'server summary stays inside the narrow viewport');
        assert.ok(await summary.evaluate(element => element.scrollWidth <= element.clientWidth), 'server summary content does not overflow its box');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'success result has no document-level horizontal overflow');
        const saved = await page.evaluate(() => window.__h.reports);
        assert.equal(saved.length, 1);
        assertReportReceipt(saved[0], expected);
        assert.equal(await startButton(page).isDisabled(), true);
        if (process.env.EMPLOYEE_TRANSFER_UI_SCREENSHOT && engine === 'chromium') await page.screenshot({ path: process.env.EMPLOYEE_TRANSFER_UI_SCREENSHOT + '.narrow.png', fullPage: true });
      }, { ...chromiumUA, viewport: { width: 375, height: 812 } }));
      await t.test('Escape rejects approval; uncertain outcome locks rerun and saves only safe report', () => scenario(browser, async page => {
        await prepare(page); await startButton(page).click(); await page.getByRole('dialog').waitFor();
        await page.keyboard.press('Escape');
        await page.getByText(/本次導入未能確認完成/).waitFor();
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.equal(await startButton(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.imports), 1);
        const report = await page.evaluate(() => JSON.parse(window.__h.reports[0].text));
        assert.equal(report.status, 'unconfirmed'); assert.equal(report.maintenance, 'unconfirmed');
        assert.equal(report.serverVerification, null, 'a cancelled import must not manufacture a server receipt');
        assert.equal(await page.getByRole('region', { name: '服務端總核對摘要', exact: true }).count(), 0);
        assert.equal(await page.locator('#migration-import-password').inputValue(), '');
      }, chromiumUA));
      await t.test('domain-boundary pause, resume and explicit stop preserve pending outcome', () => scenario(browser, async page => {
        await prepare(page); await startButton(page).click(); await page.getByRole('dialog').waitFor();
        await page.getByRole('button', { name: '請求邊界暫停', exact: true }).dispatchEvent('click');
        await approve(page);
        await page.getByText('已在領域邊界暫停', { exact: true }).waitFor();
        assert.equal(await page.getByRole('dialog').count(), 0);
        await page.getByRole('button', { name: '繼續', exact: true }).click();
        await page.getByRole('dialog').waitFor();
        await page.getByRole('button', { name: '停止後續操作', exact: true }).dispatchEvent('click');
        await page.getByText(/本次導入未能確認完成/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.importSignal.aborted), true);
        assert.equal(await startButton(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.imports), 1);
      }, chromiumUA));
      await t.test('write response loss does not retry and never leaks raw failure', () => scenario(browser, async page => {
        await prepare(page); await page.evaluate(() => { window.__h.failDomain = 'products'; });
        await startButton(page).click(); await approve(page);
        await page.getByText(/本次導入未能確認完成/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.imports), 1);
        assert.equal((await page.locator('body').innerText()).includes(PASSWORD), false);
        await page.getByText(/停止前最後確認的領域：產品目錄/).waitFor();
      }, chromiumUA));
      await t.test('unmount aborts pending approval without issuing recovery actions', () => scenario(browser, async page => {
        await prepare(page); await startButton(page).click(); await page.getByRole('dialog').waitFor();
        await page.evaluate(() => window.__unmount());
        await page.waitForFunction(() => window.__h.importSignal.aborted && window.__h.reports.length === 1);
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.equal(await page.evaluate(() => window.__h.imports), 1);
      }, chromiumUA));
      await t.test('changing authenticated inputs invalidates target admission and clears credentials', () => scenario(browser, async page => {
        await prepare(page);
        await page.locator('#migration-files').setInputFiles({ name: 'changed.edx', mimeType: 'application/octet-stream', buffer: Buffer.from('changed') });
        assert.equal(await startButton(page).isDisabled(), true);
        assert.equal(await page.locator('#migration-import-password').inputValue(), '');
        assert.equal(await page.locator('#migration-import-passphrase').inputValue(), '');
        assert.equal(await page.getByRole('button', { name: '查詢目標准入（只讀）', exact: true }).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.imports), 0);
      }, chromiumUA));
      await t.test('picker denial and report failure never imply rollback or allow automatic rerun', () => scenario(browser, async page => {
        await inspect(page);
        await page.getByRole('button', { name: '查詢目標准入（只讀）', exact: true }).click();
        await page.evaluate(() => { window.__h.pickerFail = true; });
        await page.getByRole('button', { name: '選擇獨立備份保存目錄', exact: true }).click();
        await page.getByText(/未取得備份目錄寫入權限/).waitFor();
        assert.equal(await page.evaluate(() => window.__h.imports), 0);
        await page.evaluate(() => { window.__h.pickerFail = false; });
        await prepare(page);
        await page.evaluate(() => { window.__h.reportFail = true; });
        await startButton(page).click();
        await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
        await page.getByText(/本機報告未能確認保存/).waitFor();
        assert.equal(await startButton(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.imports), 1);
      }, chromiumUA));
      await t.test('375px approval stays within viewport and native dialog traps keyboard focus', () => scenario(browser, async page => {
        await prepare(page); await startButton(page).click();
        const dialog = page.getByRole('dialog'); await dialog.waitFor();
        const box = await dialog.boundingBox();
        assert.ok(box.width <= 375 && box.x >= 0 && box.y >= 0 && box.y + box.height <= 812);
        for (let index = 0; index < 7; index++) {
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog') !== null), true);
        }
        await page.keyboard.press('Escape');
        await page.getByText(/本次導入未能確認完成/).waitFor();
      }, { ...chromiumUA, viewport: { width: 375, height: 812 } }));
      await t.test('375px layout and native unsupported browser cannot begin real import', () => scenario(browser, async page => {
        await inspect(page);
        if (engine === 'webkit') {
          await page.getByText(/目前瀏覽器不支援/).waitFor();
          assert.equal(await startButton(page).isDisabled(), true);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no document-level horizontal overflow');
      }, { viewport: { width: 375, height: 812 } }));
    } finally { await browser.close(); }
  });
}
