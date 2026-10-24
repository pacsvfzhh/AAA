import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { chromium } from '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import EmployeeManagement from './src/components/admin/EmployeeManagement';
const params = new URLSearchParams(location.search);
const admin = { id: 'admin-test', username: '管理群組', role: params.get('role') || 'super_admin', is_active: true };
const regions = ['巴西', '美國', '加拿大', '墨西哥', '印度', '澳大利亞', '紐西蘭', '日本', '韓國', '未知'].map((name, i) => ({ id: 'r' + i, name, admin_id: admin.id, is_pinned: i === 7 }));
const longDescription = '服務美洲地區的員工，依照當地工作時段安排派單；每日依序處理訂單，分組說明可以包含更詳細的規則與注意事項。'.repeat(10);
const groups = [{ id: 'g0', group_name: 'Default Group', description: '一般訂單', is_default: true }, { id: 'g1', group_name: '美洲專屬分組', description: longDescription, is_default: false }, ...Array.from({ length: 24 }, (_, i) => ({ id: 'extra' + i, group_name: '派單分組 ' + (i + 1), description: '日常派單', is_default: false }))];
window.createdArgs = [];
window.backend = {
  regions, groups,
  async rpc(name, args) {
    if (name === 'get_employee_management_snapshot') return { data: { admins: [admin], regions: params.has('emptyregions') ? [] : this.regions, employees: [{ id: 'existing', username: '範例員工', employee_id: 'E001', created_by: admin.id, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', is_active: true, is_verified: false, remarks: '', tags: [], region_id: 'r3' }] }, error: null };
    if (name === 'get_notification_automation_plan_assignments') return { data: { plans: params.has('emptyplans') ? [] : [{ id: 'plan1', owner_admin_id: admin.id, name: '新人入職方案', description: '完成指定任務後推送歡迎通知', status: 'active', selected_task_count: 3 }, { id: 'other-plan', owner_admin_id: 'other-admin', name: '其他管理員方案', description: '', status: 'active', selected_task_count: 8 }], assignments: [] }, error: null };
    if (name === 'get_withdrawals_for_admin') return { data: [], error: null };
    if (name === 'admin_create_employee_region') { const region = { id: 'new-region', name: args.p_name, admin_id: admin.id, is_pinned: false }; this.regions = [...this.regions, region]; return { data: { ...region, created: true }, error: null }; }
    if (name === 'admin_set_employee_region_pinned') { const region = { ...this.regions.find(r => r.id === args.p_region_id), is_pinned: args.p_is_pinned }; this.regions = this.regions.map(r => r.id === region.id ? region : r); return { data: region, error: null }; }
    if (name === 'admin_create_employee_account_with_automation_plan') { window.createdArgs.push(args); if (window.failCreate) { window.failCreate = false; return { data: null, error: { code: '23505', message: 'users_username_key' } }; } return { data: { success: true }, error: null }; }
    throw new Error('Unexpected RPC: ' + name);
  },
  query() {
    const result = { data: params.has('emptygroups') ? [] : this.groups, error: params.has('grouperror') ? { message: 'Test load failed' } : null };
    const chain = new Proxy({}, { get(target, key) { if (key === 'then') return resolve => resolve(result); return () => chain; } });
    return chain;
  }
};
createRoot(document.getElementById('root')).render(<EmployeeManagement admin={admin} />);
`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'employee-setup-harness.tsx', loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'isolated-backend', setup(build) {
  build.onLoad({ filter: /src\/lib\/supabase\.ts$/ }, () => ({ loader: 'js', contents: `const channel = new Proxy({}, { get() { return () => channel; } }); export const supabase = { rpc: (name, args) => window.backend.rpc(name, args), from: () => window.backend.query(), channel: () => channel, removeChannel() {} }; export const formatSupabaseError = e => e?.message || String(e); export const isFinancialAdminSessionError = () => false; export const isSupabaseAbortError = () => false; export const isSupabaseTransientError = () => false;` }));
  build.onLoad({ filter: /src\/lib\/auth\.ts$/ }, () => ({ loader: 'js', contents: `export const getAdminFinancialSessionToken = () => 'isolated-test-token'; export const createFinancialOperationId = () => crypto.randomUUID(); export const logout = async () => {};` }));
  build.onLoad({ filter: /src\/lib\/contentAudit\.ts$/ }, () => ({ loader: 'js', contents: `export const mutateAuditedContent = async () => { throw new Error('Unexpected destructive operation'); };` }));
  build.onLoad({ filter: /src\/components\/admin\/(EmployeeDetailModal|LoginDeviceSummary)\.tsx$/ }, () => ({ loader: 'js', contents: 'export default function Stub() { return null; }' }));
} }] });
const cssFile = fs.readdirSync('dist/assets').find(name => /^index-.*\.css$/.test(name));
const css = fs.readFileSync('dist/assets/' + cssFile, 'utf8');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== 'http://localhost:5173') throw new Error('External request blocked: ' + url.origin);
  if (url.pathname === '/__employee-setup-test') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/__employee-setup-test.css"></head><body style="margin:0;background:#020617"><div id="root"></div><script src="/__employee-setup-test.js"></script></body></html>' });
  if (url.pathname === '/__employee-setup-test.js') return route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles[0].text });
  if (url.pathname === '/__employee-setup-test.css') return route.fulfill({ contentType: 'text/css', body: css });
  return route.abort();
});
const createDialog = page.getByRole('dialog', { name: '新增員工帳戶' });
const regionButton = () => createDialog.getByRole('button', { name: '所在地區', exact: true });
const dispatchButton = () => createDialog.getByRole('button', { name: '派單分組', exact: true });
const planButton = () => createDialog.getByRole('button', { name: '自動化通知方案', exact: true });
const list = name => page.getByRole('listbox', { name, exact: true });
async function openForm(query = '') {
  await page.goto('http://localhost:5173/__employee-setup-test' + query);
  await page.getByText('範例員工', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: query.includes('secondary_admin') ? '建立員工' : '新增', exact: true }).click();
  await createDialog.waitFor();
}
async function checkRight(button, name) {
  const bounds = await button.boundingBox();
  const menu = await list(name).locator('..').locator('..').boundingBox();
  assert.ok(menu.x >= bounds.x + bounds.width + 8, name + ' should open right');
  assert.ok(menu.x + menu.width <= 1536 - 11);
  assert.equal(await list(name).locator('..').evaluate(n => getComputedStyle(n).animationName), 'employee-setup-expand');
}
try {
  await openForm();
  await createDialog.getByRole('button', { name: '關閉新增員工', exact: true }).click();
  await page.getByRole('button', { name: '地區', exact: true }).click();
  assert.match(await page.getByRole('menu', { name: '所在地區' }).getByRole('menuitemradio').first().innerText(), /日本/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '新增', exact: true }).click();
  const basic = await createDialog.locator('section[aria-labelledby="create-basic-title"]').boundingBox();
  const region = await createDialog.locator('section[aria-labelledby="create-region-title"]').boundingBox();
  const dispatch = await createDialog.locator('section[aria-labelledby="create-dispatch-title"]').boundingBox();
  const automation = await createDialog.locator('section[aria-labelledby="create-automation-title"]').boundingBox();
  assert.ok(region.x > basic.x + basic.width);
  assert.ok(region.y + region.height < dispatch.y && dispatch.y + dispatch.height < automation.y);
  assert.equal(await createDialog.getByRole('button', { name: '建立員工', exact: true }).isDisabled(), true);
  await page.screenshot({ path: 'employee-setup-form.tmp.png' });
  await regionButton().click();
  await checkRight(regionButton(), '所在地區');
  assert.match(await list('所在地區').getByRole('option').first().innerText(), /日本/);
  await list('所在地區').getByRole('option').filter({ hasText: '美國' }).click();
  await dispatchButton().click();
  await checkRight(dispatchButton(), '派單分組');
  assert.equal(await list('派單分組').getByText('（預設分組）', { exact: true }).count(), 0);
  assert.match(await list('派單分組').getByRole('option').first().innerText(), /Default Group（一般訂單）/);
  const longOption = list('派單分組').getByRole('option').filter({ hasText: '美洲專屬分組' });
  await longOption.hover();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /每日依序處理訂單/);
  await tooltip.hover();
  await page.waitForTimeout(200);
  assert.equal(await tooltip.isVisible(), true);
  await page.screenshot({ path: 'employee-setup-dispatch.tmp.png' });
  await longOption.click();
  assert.equal(await list('派單分組').count(), 0);
  await dispatchButton().hover();
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /每日依序處理訂單/);
  await page.mouse.move(200, 100);
  await tooltip.waitFor({ state: 'hidden' });
  await planButton().click();
  await checkRight(planButton(), '自動化通知方案');
  assert.equal(await list('自動化通知方案').getByRole('option').count(), 2);
  await list('自動化通知方案').getByRole('option').filter({ hasText: '新人入職方案' }).click();
  await regionButton().click();
  await page.keyboard.press('Escape');
  assert.equal(await list('所在地區').count(), 0);
  assert.equal(await createDialog.isVisible(), true);
  assert.equal(await regionButton().evaluate(n => n === document.activeElement), true);
  await dispatchButton().click();
  await page.keyboard.press('End');
  assert.match(await page.locator(':focus').innerText(), /派單分組 24/);
  await page.keyboard.press('Home');
  assert.match(await page.locator(':focus').innerText(), /Default Group/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.match(await dispatchButton().innerText(), /美洲專屬分組/);
  await regionButton().click();
  await page.getByRole('button', { name: '地區設定', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '地區設定', exact: true });
  await settings.getByRole('textbox', { name: '新地區名稱' }).fill('泰國');
  await settings.getByRole('button', { name: '新增', exact: true }).click();
  await settings.getByRole('button', { name: '置頂「泰國」', exact: true }).waitFor();
  await settings.getByRole('button', { name: '置頂「泰國」', exact: true }).click();
  await settings.getByRole('button', { name: '取消置頂「泰國」', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await createDialog.isVisible(), true);
  assert.equal(await regionButton().evaluate(n => n === document.activeElement), true);
  await createDialog.locator('#create-employee-username').fill('new-employee');
  await createDialog.locator('#create-employee-password').fill('strongPass123');
  await createDialog.locator('#create-employee-id').fill('NEW100');
  await createDialog.getByRole('button', { name: '顯示密碼', exact: true }).click();
  assert.equal(await createDialog.locator('#create-employee-password').getAttribute('type'), 'text');
  await createDialog.getByRole('button', { name: '產生高強度密碼', exact: true }).click();
  assert.equal((await createDialog.locator('#create-employee-password').inputValue()).length, 16);
  await createDialog.locator('#create-employee-password').fill('strongPass123');
  await createDialog.locator('#create-employee-remarks').fill('新員工備註');
  await page.evaluate(() => { window.failCreate = true; });
  await createDialog.getByRole('button', { name: '建立員工', exact: true }).click();
  await createDialog.getByRole('alert').filter({ hasText: '已存在' }).waitFor();
  assert.equal(await createDialog.locator('#create-employee-username').inputValue(), 'new-employee');
  await createDialog.getByRole('button', { name: '建立員工', exact: true }).click();
  await createDialog.waitFor({ state: 'hidden' });
  const args = await page.evaluate(() => window.createdArgs);
  assert.equal(args.length, 2);
  assert.equal(args[1].p_region_id, 'r1');
  assert.equal(args[1].p_dispatch_group_id, 'g1');
  assert.equal(args[1].p_automation_plan_id, 'plan1');
  assert.equal(args[1].p_remarks, '新員工備註');
  console.log('PASS desktop layout, color menus, right expansion, hover details, scrolling, keyboard/Escape, region management, create failure/retry and exact RPC arguments.');

  for (const [width, height] of [[1280, 800], [1024, 800], [768, 800], [375, 800], [320, 800], [900, 480], [320, 480]]) {
    await page.setViewportSize({ width, height });
    await openForm('?role=secondary_admin');
    for (const [button, name] of [[regionButton, '所在地區'], [dispatchButton, '派單分組'], [planButton, '自動化通知方案']]) {
      console.log('Checking viewport', width, name);
      await button().click();
      const bounds = await list(name).boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, width + ' menu clipped: ' + name);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, width + ' menu height clipped: ' + name);
      await page.keyboard.press('Escape');
      assert.equal(await createDialog.isVisible(), true);
    }
    assert.equal(await createDialog.evaluate(n => n.scrollWidth <= n.clientWidth), true);
    if (width === 320 && height === 800) await page.screenshot({ path: 'employee-setup-mobile.tmp.png' });
    await createDialog.getByRole('button', { name: '取消', exact: true }).click();
  }
  console.log('PASS secondary-admin menus, viewport bounds at 1280/1024/768/375/320px and cancel.');
  await page.setViewportSize({ width: 1536, height: 960 });
  await openForm('?emptygroups&emptyplans');
  assert.equal(await dispatchButton().isDisabled(), true);
  await planButton().click();
  assert.equal(await list('自動化通知方案').getByRole('option').count(), 1);
  await page.keyboard.press('Escape');
  await openForm('?grouperror');
  await createDialog.getByRole('alert').filter({ hasText: '無法載入派單分組' }).waitFor();
  assert.equal(await dispatchButton().isDisabled(), true);
  await openForm();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dispatchButton().click();
  assert.equal(await list('派單分組').locator('..').evaluate(n => getComputedStyle(n).animationName), 'none');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await dispatchButton().click();
  await page.setViewportSize({ width: 1400, height: 900 });
  await list('派單分組').waitFor({ state: 'hidden' });
  assert.equal(await list('派單分組').count(), 0);
  await openForm('?emptyregions');
  await regionButton().click();
  await list('所在地區').getByText('尚未建立地區，請點右上角齒輪新增。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '地區設定', exact: true }).click();
  const emptySettings = page.getByRole('dialog', { name: '地區設定', exact: true });
  await emptySettings.getByRole('textbox', { name: '新地區名稱' }).fill('新地區');
  await emptySettings.getByRole('button', { name: '新增', exact: true }).click();
  await emptySettings.getByRole('button', { name: '置頂「新地區」', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.match(await regionButton().innerText(), /新地區/);
  await dispatchButton().click();
  await createDialog.locator('#create-employee-username').click();
  assert.equal(await list('派單分組').count(), 0);
  assert.equal(await createDialog.isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('PASS empty/error states, reduced motion, resize dismissal; no runtime errors or external database requests.');
} finally { await browser.close(); }
