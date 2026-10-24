import { build } from 'esbuild';
import { chromium } from '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';

const mock = `
export const supabaseConfigurationError = null;
export const formatSupabaseError = e => e?.message || String(e);
export const isFinancialAdminSessionError = () => false;
export const isEmployeeSessionEndedError = () => false;
export const isSupabaseAbortError = () => false;
export const isSupabaseTransientError = () => false;
const list = (count, make) => Array.from({length: count}, (_, i) => make(i));
const regions = list(16, i => ({id:'region-'+i, name:['臺灣','香港','新加坡','馬來西亞'][i%4]+(i>3?' '+i:''), admin_id:'admin-1',is_pinned:i===0,created_at:'2026-01-01'}));
const dispatch = list(12, i => ({id:'dispatch-'+i,group_name: i===0?'標準派單組':'進階派單組 '+i, description:'每日訂單與佣金規則依此群組設定，這是一段較長的分組說明，可懸停查看完整內容。',is_default:i===0}));
const plans = list(8,i=>({id:'plan-'+i,name:'新員工成長方案 '+(i+1),description:'歡迎通知、入職提醒與階段性獎勵任務。',selected_task_count: i+2,status:'active',owner_admin_id:'admin-1'}));
window.__requests=[];
export const supabase={
 rpc: async(name,args)=>{window.__requests.push({name,args});
 if(name==='get_employee_management_snapshot')return {data:{admins:[window.__admin],employees:[],regions:window.__empty?[]:regions},error:null};
 if(name==='get_notification_automation_plan_assignments')return {data:{plans:window.__empty?[]:plans,assignments:[]},error:null};
 if(name==='get_withdrawals_for_admin')return {data:[],error:null};
 if(name==='admin_create_employee_account_with_automation_plan')return {data:{success:true},error:null};
 throw new Error('Unexpected RPC '+name);},
 from(table){const result={data:table==='dispatch_groups'?(window.__empty?[]:dispatch):[],error:null};const chain=new Proxy({}, {get:(_,key)=>key==='then'?Promise.resolve(result).then.bind(Promise.resolve(result)):(...args)=>chain});return chain;},
 channel(){const c={on:()=>c,subscribe:()=>c,unsubscribe:()=>{}};return c;},removeChannel:()=>{},
};`;
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import EmployeeManagement from './src/components/admin/EmployeeManagement';
window.__empty=new URLSearchParams(location.search).has('empty');
window.__admin={id:'admin-1',username:'測試管理員',role:new URLSearchParams(location.search).get('role')||'secondary_admin',is_active:true,is_pinned:false,created_at:'2026-01-01'};
sessionStorage.setItem('work_platform_auth',JSON.stringify({user:window.__admin,userType:'admin',adminSessionToken:'isolated-test-token'}));
createRoot(document.getElementById('root')).render(<div className='h-screen overflow-auto bg-slate-950 p-4 text-white'><EmployeeManagement admin={window.__admin}/></div>);`;
const bundle=await build({stdin:{contents:entry,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',define:{'import.meta.env':'{}','process.env.NODE_ENV':'"development"'},plugins:[{name:'mock-backend',setup(b){b.onLoad({filter:/\/src\/lib\/supabase\.ts$/},()=>({contents:mock,loader:'js'}));}}]});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];
const external=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*', async route=>{
 const url=new URL(route.request().url());
 if(url.hostname!=='localhost'){external.push(url.href);return route.abort();}
 if(url.pathname==='/__employee-style-qa')return route.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import "/src/index.css"; import "/__employee-style-qa.js";</script></body></html>'});
 if(url.pathname==='/__employee-style-qa.js')return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
 return route.continue();
});
const openForm=async(query='')=>{
 await page.goto('http://localhost:5173/__employee-style-qa'+query);
 await page.getByRole('button',{name:query.includes('super_admin')?'新增':'建立員工',exact:true}).first().click();
 await page.getByRole('dialog',{name:'新增員工帳戶'}).waitFor();
 await page.waitForTimeout(350);
};
const menuButton=label=>page.getByRole('button',{name:label,exact:true});
const openMenu=async(label)=>{
 await menuButton(label).click();
 await page.getByRole('listbox',{name:label}).waitFor();
 await page.locator('.employee-setup-menu').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
 const menu=page.locator('.employee-setup-menu');
 const rect=await menu.boundingBox();
 assert(rect.width<=297 && rect.height<=327,JSON.stringify(rect));
 const cards=await page.getByRole('option').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().height));
 assert(cards.every(h=>h>=38 && h<=(page.viewportSize().width<768?44:40)),JSON.stringify(cards));
 assert(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=page.viewportSize().width+1 && rect.y+rect.height<=page.viewportSize().height+1,JSON.stringify(rect));
 return rect;
};
try {
 await openForm();
 const fields=await page.locator('[aria-labelledby="create-basic-title"] input, [aria-labelledby="create-basic-title"] textarea').evaluateAll(els=>els.map(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color})));
 assert(fields.length===4);
 assert(fields.every(f=>f.background.includes('255, 255, 255')),JSON.stringify(fields));
 assert.equal(await menuButton('自動化通知方案').getAttribute('data-unassigned'),'true');
 await page.screenshot({path:'/tmp/employee-style-desktop.png'});
 for(const label of ['所在地區','派單分組','自動化通知方案']) {
   const rect=await openMenu(label);
   assert.equal(await page.locator('.employee-setup-menu').locator('..').getAttribute('data-side'),'right');
   if(label==='派單分組'){
     await page.getByRole('option').first().hover();
     await page.getByRole('tooltip').waitFor();
     await page.screenshot({path:'/tmp/employee-style-dispatch.png'});
     await page.getByRole('option').first().click();
   } else if(label==='所在地區'){
     await page.getByRole('option').first().click();
   } else {
     const none=page.getByRole('option').first();
     assert.equal(await none.getAttribute('data-unassigned'),'true');
     assert.equal(await none.evaluate(el=>getComputedStyle(el).borderTopStyle),'dashed');
     assert.equal(await page.getByRole('option').nth(1).evaluate(el=>getComputedStyle(el).borderTopStyle),'solid');
     await page.screenshot({path:'/tmp/employee-style-automation.png'});
     await page.getByRole('option').nth(1).click();
     assert.equal(await menuButton(label).getAttribute('data-unassigned'),null);
     await openMenu(label);
     await page.keyboard.press('Home');
     await page.keyboard.press('Enter');
     assert.equal(await menuButton(label).getAttribute('data-unassigned'),'true');
   }
   console.log('compact menu verified',label,rect);
 }
 await page.locator('#create-employee-username').fill('qa_employee');
 await page.locator('#create-employee-password').fill('Test123456');
 await page.locator('#create-employee-id').fill('QA001');
 await menuButton('顯示密碼').click();
 assert.equal(await page.locator('#create-employee-password').getAttribute('type'),'text');
 await page.getByRole('dialog').getByRole('button',{name:'建立員工',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});
 const call=await page.evaluate(()=>window.__requests.find(r=>r.name==='admin_create_employee_account_with_automation_plan'));
 assert.equal(call.args.p_automation_plan_id,null);
 assert.equal(call.args.p_region_id,'region-0');
 assert.equal(call.args.p_dispatch_group_id,'dispatch-0');
 console.log('golden path unchanged, no-plan submits null');
 for(const viewport of [{width:1024,height:768},{width:768,height:800},{width:375,height:812},{width:320,height:600},{width:900,height:480}]){
   await page.setViewportSize(viewport);
   await openForm();
   for(const label of ['所在地區','派單分組','自動化通知方案']){
     await openMenu(label);
     await page.keyboard.press('Escape');
     assert.equal(await page.getByRole('dialog',{name:'新增員工帳戶'}).count(),1);
   }
   const box=await page.getByRole('dialog').boundingBox();
   assert(box.x>=0 && box.x+box.width<=viewport.width+1);
   if(viewport.width===375)await page.screenshot({path:'/tmp/employee-style-mobile.png'});
   console.log('viewport verified',viewport);
 }
 await page.setViewportSize({width:1440,height:1000});
 await openForm('?role=super_admin');
 await openMenu('所在地區');
 await page.getByRole('button',{name:'地區設定',exact:true}).click();
 await page.getByRole('dialog',{name:/地區設定/}).waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('dialog',{name:'新增員工帳戶'}).count(),1);
 await openForm('?empty=1');
 assert(await menuButton('派單分組').isDisabled());
 await openMenu('自動化通知方案');
 assert.equal(await page.getByRole('option').count(),1);
 await page.keyboard.press('Escape');
 await openMenu('所在地區');
 await page.getByText('尚未建立地區，請點右上角齒輪新增。',{exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.emulateMedia({reducedMotion:'reduce'});
 await openMenu('自動化通知方案');
 assert.equal(await page.locator('.employee-setup-menu').evaluate(el=>getComputedStyle(el).animationName),'none');
 assert.deepEqual(errors,[]);
 assert.deepEqual(external,[]);
 console.log('PASS: desktop, compact menus, no-plan style, selection, keyboard, submit, super-admin, empty data, reduced motion, responsive layouts; no browser errors or external requests');
} finally {await browser.close();}
