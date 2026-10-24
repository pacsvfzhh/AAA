import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';

const css = await (await fetch('http://localhost:5173/src/index.css?direct')).text();
const mock = `
window.calls = [];
window.failNext = '';
window.delayWrite = 0;
window.loadFailure = false;
const admin = window.fixture.admin;
const owner = admin.id;
const other = 'other';
const employee = (id, name, createdBy, tags, region) => ({id,username:name,employee_id:id,is_verified:true,is_active:true,total_income:0,first_success_order_date:null,created_by:createdBy,remarks:'原備註',tags,is_pinned:false,region_id:region,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'});
window.db = {
 admins:[admin, {id:other,username:'其他管理員',role:'secondary_admin',is_active:true}],
 employees:[employee('employee-1','測試員工',owner,['VIP'],'region-1'),employee('employee-2','同組員工',owner,['常用','VIP','vip'],'region-1'),employee('employee-3','別組員工',other,['別組標籤'],'region-other')],
 regions:[{id:'region-1',admin_id:owner,name:'美國',is_pinned:false},{id:'region-2',admin_id:owner,name:'日本',is_pinned:true},{id:'region-other',admin_id:other,name:'其他地區',is_pinned:false}],
 groups:[{id:'group-1',group_name:'原分組',description:'原說明',is_default:true},{id:'group-2',group_name:'新分組',description:'新的派單組說明',is_default:false}],
 membership:{group_id:'group-1',dispatch_groups:{group_name:'原分組'}},
 plans:[{id:'plan-1',owner_admin_id:owner,name:'原方案',description:'原方案說明',status:'active',selected_task_count:2},{id:'plan-2',owner_admin_id:owner,name:'新方案',description:'新方案說明',status:'active',selected_task_count:4},{id:'plan-other',owner_admin_id:other,name:'別組方案',status:'active'}],
 assignments:[{user_id:'employee-1',plan_id:'plan-1',plan_name:'原方案',plan_status:'active'}]
};
if(window.fixture.scenario==='paused'){
 window.db.membership={group_id:'inactive',dispatch_groups:{group_name:'已停用分組'}};
 window.db.plans.push({id:'paused',name:'暫停方案',owner_admin_id:owner,status:'paused'});
 window.db.assignments[0]={user_id:'employee-1',plan_id:'paused',plan_name:'暫停方案',plan_status:'paused'};
}
if(window.fixture.scenario==='ungrouped'){window.db.groups=[];window.db.membership=null;}
if(window.fixture.scenario==='load-error'){window.failNext='dispatch_group_members';}
const response = data => ({data:structuredClone(data),error:null});
export const formatSupabaseError = error => error?.message || String(error);
export const isFinancialAdminSessionError = error => error?.message === 'session expired';
export const isSupabaseAbortError = () => false;
export const isSupabaseTransientError = () => false;
export const supabase = {
 rpc:async (name,args) => {
  window.calls.push({name,args});
  if (!name.startsWith('get_') && window.delayWrite) await new Promise(resolve=>setTimeout(resolve,window.delayWrite));
  if(window.failNext===name){window.failNext='';return {data:null,error:{message:'模擬儲存失敗'}};}
  if(name==='get_employee_management_snapshot') return window.loadFailure ? {data:null,error:{message:'snapshot failed'}} : response({admins:window.db.admins,employees:window.db.employees,regions:window.db.regions});
  if(name==='get_notification_automation_plan_assignments')return response({plans:window.db.plans,assignments:window.db.assignments});
  if(name==='get_withdrawals_for_admin')return response([]);
  if(name==='get_today_commission_by_user')return response([]);
  if(name==='admin_update_employee_account'){Object.assign(window.db.employees.find(e=>e.id===args.p_user_id),args.p_updates);return response({success:true});}
  if(name==='admin_assign_dispatch_group_member'){
   const group=window.db.groups.find(g=>g.id===args.p_group_id);
   window.db.membership={group_id:group.id,dispatch_groups:{group_name:group.group_name}};
   return response({member:{user_id:args.p_user_id,group_id:group.id}});
  }
  if(name==='set_notification_automation_plan_for_employee'){
   window.db.assignments=window.db.assignments.filter(a=>a.user_id!==args.p_user_id);
   const plan=window.db.plans.find(p=>p.id===args.p_plan_id);
   if(plan)window.db.assignments.push({user_id:args.p_user_id,plan_id:plan.id,plan_name:plan.name,plan_status:plan.status});
   return response({success:true,user_id:args.p_user_id,plan_id:args.p_plan_id});
  }
  throw Error('Unexpected RPC '+name);
 },
 from:table=>{
  const q={select:()=>q,eq:()=>q,is:()=>q,order:()=>q,maybeSingle:()=>q,
   then:resolve=>{window.calls.push({name:'from:'+table});return Promise.resolve(resolve(window.failNext===table?(window.failNext='',{data:null,error:{message:'模擬載入失敗'}}):response(table==='dispatch_groups'?window.db.groups:window.db.membership)));}};
  return q;
 },
 channel:()=>{const c={on:()=>c,subscribe:()=>c};return c;},removeChannel:()=>Promise.resolve(),
};`;
const { outputFiles } = await build({
 stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import EmployeeManagement from './src/components/admin/EmployeeManagement';createRoot(document.getElementById('root')).render(<EmployeeManagement admin={window.fixture.admin}/>);`,loader:'tsx',resolveDir:process.cwd()},
 bundle:true,write:false,format:'iife',jsx:'automatic',plugins:[{name:'isolated-backend',setup(b){
  b.onResolve({filter:/\/lib\/supabase$/},()=>({path:'supabase',namespace:'mock'}));
  b.onResolve({filter:/\/lib\/auth$/},()=>({path:'auth',namespace:'mock'}));
  b.onResolve({filter:/\/lib\/contentAudit$/},()=>({path:'audit',namespace:'mock'}));
  b.onResolve({filter:/\.\/(EmployeeDetailModal|LoginDeviceSummary)$/},()=>({path:'component',namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='supabase'?mock:path==='auth'?`export const getAdminFinancialSessionToken=()=>'test-token';export const createFinancialOperationId=()=>crypto.randomUUID();export const logout=()=>{window.loggedOut=true;};`:path==='audit'?`export const mutateAuditedContent=()=>{throw Error('No audit mutations expected');};`:'export default function Stub(){return null;}',loader:'js'}));
 }}],
});
const browser = await chromium.launch({headless:true});
const errors = [];
const pages = [];
async function setup(role='super_admin', scenario='') {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 pages.push(page);page.on('pageerror',e=>errors.push(e.message));
 const admin={id:role==='super_admin'?'admin-super':'admin-secondary',username:'測試管理員',role,is_active:true,is_pinned:true,parent_id:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'};
 await page.route('**/*',route=>route.request().url()==='http://employee-edit.test/'?route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>${css}</style></head><body class="bg-slate-950"><div id="root" style="height:100vh;display:flex;flex-direction:column"></div><script>window.fixture=${JSON.stringify({admin,scenario})};${outputFiles[0].text.replaceAll('</script>','<\\/script>')}</script></body></html>`}):route.abort());
 await page.goto('http://employee-edit.test/');
 await page.getByRole('button',{name:'管理 測試員工 的標籤',exact:true}).waitFor();
 return page;
}
async function writes(page){return page.evaluate(()=>window.calls.filter(c=>!c.name.startsWith('get_')&&!c.name.startsWith('from:')));}
async function edit(page){
 await page.getByRole('button',{name:'開啟 測試員工 的操作選單',exact:true}).click();
 await page.getByRole('button',{name:'編輯員工',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#edit-employee-dispatch-group')&&!document.querySelector('#edit-employee-dispatch-group').disabled);
 return page.getByRole('dialog',{name:'編輯員工',exact:true});
}
async function choose(page,id,name){await page.locator('#'+id).click();await page.getByRole('option',{name:new RegExp('^'+name)}).click();}
async function closeSuccess(page){
 await page.getByText('員工資料已儲存',{exact:true}).waitFor();
 const buttons=page.getByRole('button',{name:/^(完成|關閉|確定)$/});
 if(await buttons.count())await buttons.last().click();
}
try {
 for(const role of ['super_admin','secondary_admin']){
  const page=await setup(role);
  await page.getByRole('button',{name:'管理 測試員工 的標籤',exact:true}).click();
  const tags=page.getByRole('dialog',{name:'員工標籤',exact:true});
  assert.ok(await tags.getByRole('button',{name:'關閉',exact:true}).isVisible());
  assert.equal(await tags.getByRole('button',{name:'套用 別組標籤',exact:true}).count(),0);
  await tags.getByRole('button',{name:'套用 常用',exact:true}).click();
  assert.equal((await writes(page)).length,0);
  await tags.locator('#new-employee-tag').fill(' 新標籤 ');
  await tags.getByRole('button',{name:'儲存',exact:true}).click();
  await tags.waitFor({state:'detached'});
  assert.deepEqual((await writes(page))[0].args.p_updates.tags,['VIP','常用','新標籤']);
  await page.getByRole('button',{name:'管理 測試員工 的標籤',exact:true}).click();
  await tags.getByRole('button',{name:'移除 常用',exact:true}).click();
  await page.evaluate(()=>{window.failNext='admin_update_employee_account';});
  await tags.getByRole('button',{name:'儲存',exact:true}).click();
  await tags.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(()=>window.db.employees[0].tags.includes('常用')),true);
  assert.equal(await tags.getByRole('button',{name:'移除 常用',exact:true}).count(),0);
  await page.evaluate(()=>{window.delayWrite=200;});
  await tags.getByRole('button',{name:'儲存',exact:true}).click();
  assert.ok(await tags.getByRole('button',{name:'關閉標籤管理',exact:true}).isDisabled());
  await tags.waitFor({state:'detached'});
  await page.evaluate(()=>{window.delayWrite=0;window.calls=[];});
  const dialog=await edit(page);
  assert.equal(await dialog.getAttribute('data-employee-create-theme'),role==='super_admin'?'warm':'cool');
  assert.match(await dialog.locator('#edit-employee-dispatch-group').innerText(),/原分組/);
  assert.match(await dialog.locator('#edit-employee-automation-plan').innerText(),/原方案/);
  await dialog.locator('#edit-employee-remarks').fill('更新備註');
  await choose(page,'edit-employee-region','日本');
  await choose(page,'edit-employee-dispatch-group','新分組');
  await page.locator('#edit-employee-automation-plan').click();
  assert.equal(await page.getByRole('option',{name:/別組方案/}).count(),0);
  await page.getByRole('option',{name:/^新方案/}).click();
  assert.equal((await writes(page)).length,0);
  await page.evaluate(()=>{window.delayWrite=100;});
  await dialog.getByRole('button',{name:'儲存變更',exact:true}).click();
  assert.ok(await dialog.locator('#edit-employee-username').isDisabled());
  await dialog.waitFor({state:'detached'});
  const calls=await writes(page);
  assert.deepEqual(calls.map(c=>c.name),['admin_update_employee_account','admin_assign_dispatch_group_member','set_notification_automation_plan_for_employee']);
  assert.deepEqual(calls[0].args.p_updates,{remarks:'更新備註',region_id:'region-2'});
  assert.equal(calls[1].args.p_group_id,'group-2');assert.equal(calls[2].args.p_plan_id,'plan-2');
  assert.ok(calls.every(c=>c.args.p_user_id==='employee-1'&&c.args.p_admin_session_token==='test-token'));
  await closeSuccess(page);
  await edit(page);
  assert.match(await page.locator('#edit-employee-dispatch-group').innerText(),/新分組/);
  assert.match(await page.locator('#edit-employee-automation-plan').innerText(),/新方案/);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  console.log(role,'tag draft/save/failure and employee profile/region/group/plan sync PASS');
 }
 const page=await setup();
 const dialog=await edit(page);
 await dialog.locator('#edit-employee-remarks').fill('部分成功');
 await choose(page,'edit-employee-dispatch-group','新分組');await choose(page,'edit-employee-automation-plan','新方案');
 await page.evaluate(()=>{window.failNext='set_notification_automation_plan_for_employee';});
 await dialog.getByRole('button',{name:'儲存變更',exact:true}).click();
 await dialog.getByRole('alert').waitFor();assert.match(await dialog.getByRole('alert').innerText(),/帳戶資料、派單分組已儲存/);
 assert.equal(await page.evaluate(()=>window.db.membership.group_id),'group-2');
 assert.equal(await page.evaluate(()=>window.db.assignments[0].plan_id),'plan-1');
 await dialog.getByRole('button',{name:'儲存變更',exact:true}).click();await dialog.waitFor({state:'detached'});
 let calls=await writes(page);assert.equal(calls.filter(c=>c.name==='admin_update_employee_account').length,1);assert.equal(calls.filter(c=>c.name==='admin_assign_dispatch_group_member').length,1);assert.equal(calls.filter(c=>c.name==='set_notification_automation_plan_for_employee').length,2);
 await closeSuccess(page);
 await edit(page);await choose(page,'edit-employee-automation-plan','不指定方案');
 await page.getByRole('button',{name:'儲存變更',exact:true}).click();await page.getByRole('dialog',{name:'編輯員工',exact:true}).waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>window.db.assignments.length),0);
 console.log('partial failure retry and clear automation PASS');
 const edge=await setup('super_admin','paused');
 await edit(edge);
 assert.match(await edge.locator('#edit-employee-dispatch-group').innerText(),/已停用分組/);
 assert.match(await edge.locator('#edit-employee-automation-plan').innerText(),/暫停方案/);
 await edge.locator('#edit-employee-automation-plan').click();
 assert.equal(await edge.getByRole('option',{name:/暫停方案/}).count(),0);
 await edge.keyboard.press('Escape');
 assert.equal(await edge.getByRole('dialog',{name:'編輯員工',exact:true}).count(),1);
 await edge.locator('#edit-employee-remarks').fill('保留暫停方案');
 await edge.getByRole('button',{name:'儲存變更',exact:true}).click();
 await edge.getByRole('dialog',{name:'編輯員工',exact:true}).waitFor({state:'detached'});
 assert.deepEqual((await writes(edge)).map(c=>c.name),['admin_update_employee_account']);
 assert.equal(await edge.evaluate(()=>window.db.assignments[0].plan_id),'paused');
 await closeSuccess(edge);await edit(edge);
 for(const width of [1280,1024,768,375]){
  await edge.setViewportSize({width,height:820});
  const dims=await edge.getByRole('dialog',{name:'編輯員工',exact:true}).evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:window.innerWidth,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth}));
  assert.ok(dims.left>=0&&dims.right<=dims.width&&dims.scrollWidth===dims.clientWidth,JSON.stringify(dims));
 }
 await edge.setViewportSize({width:1280,height:900});
 await edge.screenshot({path:'supabase/tests/employee-edit-preview.tmp.png'});
 await edge.getByRole('button',{name:'取消',exact:true}).click();
 await edge.getByRole('button',{name:'管理 測試員工 的標籤',exact:true}).click();
 await edge.getByRole('button',{name:'套用 常用',exact:true}).click();
 edge.once('dialog',dialog=>dialog.dismiss());
 await edge.getByRole('button',{name:'關閉標籤管理',exact:true}).click();
 assert.equal(await edge.getByRole('dialog',{name:'員工標籤',exact:true}).count(),1);
 edge.once('dialog',dialog=>dialog.accept());
 await edge.getByRole('button',{name:'關閉標籤管理',exact:true}).click();
 assert.equal(await edge.evaluate(()=>window.db.employees[0].tags.includes('常用')),false);
 const ungrouped=await setup('secondary_admin','ungrouped');
 await ungrouped.getByRole('button',{name:'開啟 測試員工 的操作選單',exact:true}).click();await ungrouped.getByRole('button',{name:'編輯員工',exact:true}).click();
 await ungrouped.waitForFunction(()=>!document.querySelector('[aria-labelledby=edit-employee-title] button:last-child').disabled);
 assert.match(await ungrouped.locator('#edit-employee-dispatch-group').innerText(),/未分組/);
 await ungrouped.locator('#edit-employee-remarks').fill('無分組更新');await ungrouped.getByRole('button',{name:'儲存變更',exact:true}).click();await ungrouped.getByRole('dialog',{name:'編輯員工',exact:true}).waitFor({state:'detached'});
 assert.deepEqual((await writes(ungrouped)).map(c=>c.name),['admin_update_employee_account']);
 const failedLoad=await setup('super_admin','load-error');
 await failedLoad.getByRole('button',{name:'開啟 測試員工 的操作選單',exact:true}).click();await failedLoad.getByRole('button',{name:'編輯員工',exact:true}).click();
 await failedLoad.getByRole('alert').waitFor();assert.ok(await failedLoad.getByRole('button',{name:'儲存變更',exact:true}).isDisabled());assert.equal((await writes(failedLoad)).length,0);
 const failedGroup=await setup();await edit(failedGroup);
 await failedGroup.locator('#edit-employee-remarks').fill('組失敗保留');await choose(failedGroup,'edit-employee-dispatch-group','新分組');await choose(failedGroup,'edit-employee-automation-plan','新方案');
 await failedGroup.evaluate(()=>{window.failNext='admin_assign_dispatch_group_member';});await failedGroup.getByRole('button',{name:'儲存變更',exact:true}).click();await failedGroup.getByRole('alert').waitFor();
 assert.equal((await writes(failedGroup)).filter(c=>c.name==='set_notification_automation_plan_for_employee').length,0);
 await failedGroup.getByRole('button',{name:'儲存變更',exact:true}).click();await failedGroup.getByRole('dialog',{name:'編輯員工',exact:true}).waitFor({state:'detached'});
 assert.equal((await writes(failedGroup)).filter(c=>c.name==='admin_update_employee_account').length,1);
 const failedRefresh=await setup();await edit(failedRefresh);await choose(failedRefresh,'edit-employee-automation-plan','新方案');
 await failedRefresh.evaluate(()=>{window.loadFailure=true;});await failedRefresh.getByRole('button',{name:'儲存變更',exact:true}).click();await failedRefresh.getByRole('alert').waitFor();
 await failedRefresh.evaluate(()=>{window.loadFailure=false;});await failedRefresh.getByRole('button',{name:'儲存變更',exact:true}).click();await failedRefresh.getByRole('dialog',{name:'編輯員工',exact:true}).waitFor({state:'detached'});
 assert.equal((await writes(failedRefresh)).filter(c=>c.name==='set_notification_automation_plan_for_employee').length,1);
 assert.deepEqual(errors,[]);
 console.log('inactive/paused preservation, draft cancel, no groups, load/group/refresh failure, responsive 1280/1024/768/375 PASS; no browser errors');
} finally { await Promise.all(pages.map(page=>page.close()));await browser.close(); }
