// 复现：node /root/app/code/supabase/tests/login-maintenance.tmp.mjs
// 只替换 src/lib/supabase.ts；Login、auth.login、限流、登录纪录、会话、多语言和 CSS 均使用真实源码。
// 不读取 Supabase 环境变量、不连接正式服务。浏览器外部请求全部阻止，IP 查询在 fetch 层本地返回。
// 需要已有 Playwright/Chromium；可用 PLAYWRIGHT_MODULE 指定 Playwright 模块路径，无需改项目依赖。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import configLoader from 'tailwindcss/lib/lib/load-config.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const project = resolve(scriptDirectory, '../..');
const screenshots = {
  phone: join(scriptDirectory, 'login-maintenance-phone.tmp.png'),
  desktop: join(scriptDirectory, 'login-maintenance-desktop.tmp.png'),
};
const sourcePaths = [
  'src/pages/Login.tsx', 'src/lib/auth.ts', 'src/lib/rateLimitService.ts',
  'src/lib/loginHistoryService.ts', 'src/lib/TabSessionManager.ts',
  'src/components/EmployeeMaintenanceDialog.tsx', 'src/index.css',
];
const hashSources = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [
  path, createHash('sha256').update(await readFile(join(project, path))).digest('hex'),
])));
const originalSourceHashes = await hashSources();

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '@playwright/test'].filter(Boolean);
  const cacheDirectory = join(homedir(), '.npm/_npx');
  for (const entry of await readdir(cacheDirectory).catch(() => [])) {
    candidates.push(join(cacheDirectory, entry, 'node_modules/playwright/index.mjs'));
  }
  for (const candidate of candidates) {
    try {
      const loaded = await import(candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate);
      if (loaded.chromium) return loaded;
    } catch { /* Try the next already-installed browser package. */ }
  }
  throw new Error('找不到已有 Playwright，请设置 PLAYWRIGHT_MODULE 指向其 index.mjs。');
}

// These are deliberately local test accounts, credentials and session identifiers only.
const supabaseDouble = `
const correctPassword = 'Local-test-password-42';
const maintainedOwner = 'local-team-maintained';
const maintainedEmployee = { id:'local-employee-maintained', username:'qa-maintained', employee_id:'LOCAL-001', is_active:true, created_by:maintainedOwner };
const otherEmployee = { id:'local-employee-other', username:'qa-other', employee_id:'LOCAL-002', is_active:true, created_by:'local-team-other' };
const admin = { id:'local-admin', username:'qa-admin', is_active:true, role:'super_admin' };
// A colliding employee name must still choose the administrator branch first.
const collidingEmployee = { ...maintainedEmployee, id:'local-collision', username:admin.username };
const employees = [maintainedEmployee, otherEmployee, collidingEmployee];
const clone = value => JSON.parse(JSON.stringify(value));
window.__maintenanceMock = {
  enabled:true, queries:[], rpcs:[], unexpected:[],
  rate:{allowed:true,locked:false,warning:'local warning',failed_attempts:4},
  credentialsValidated:[],
};
function result(data) { return {data,error:null}; }
class Query {
  constructor(table){this.table=table;this.filters=[];this.columns='*';}
  select(columns){this.columns=columns;return this;}
  eq(key,value){this.filters.push({kind:'eq',key,value});return this;}
  is(key,value){this.filters.push({kind:'eq',key,value});return this;}
  in(key,value){this.filters.push({kind:'in',key,value});return this;}
  maybeSingle(){return this.execute(true);}
  then(yes,no){return this.execute(false).then(yes,no);}
  async execute(single){
    let rows;
    switch(this.table){
      case 'admins':rows=[admin];break;
      case 'users':rows=employees;break;
      case 'admin_configs':case 'system_configs':rows=[];break;
      default:window.__maintenanceMock.unexpected.push('table:'+this.table);throw new Error('Unexpected local table '+this.table);
    }
    rows=rows.filter(row=>this.filters.every(filter=>filter.kind==='in'?filter.value.includes(row[filter.key]):row[filter.key]===filter.value));
    const response=result(single?(rows[0]||null):rows);
    window.__maintenanceMock.queries.push(clone({table:this.table,columns:this.columns,filters:this.filters,response}));
    return response;
  }
}
async function rpc(name,args){
  const mock=window.__maintenanceMock;
  let response;
  switch(name){
    case 'check_login_rate_limit':response=result(mock.rate);break;
    case 'create_employee_financial_session':{
      const user=employees.find(user=>user.username===args.p_username);
      if(!user||args.p_password!==correctPassword){response=result({success:false,error:'Invalid credentials'});break;}
      mock.credentialsValidated.push({role:'employee',username:args.p_username,tabId:args.p_tab_id});
      if(mock.enabled&&user.created_by===maintainedOwner){response=result({success:false,code:'employee_login_maintenance'});break;}
      response=result({success:true,session_token:'local-employee-financial-token',session_marker:'local-employee-session-marker',user});
      break;
    }
    case 'create_admin_financial_session':{
      if(args.p_username!==admin.username||args.p_password!==correctPassword){response=result({success:false,error:'Invalid credentials'});break;}
      mock.credentialsValidated.push({role:'admin',username:args.p_username});
      response=result({success:true,session_token:'local-admin-session-token',user:admin});
      break;
    }
    case 'record_login_attempt':response=result({success:args.p_success,locked:false,failed_attempts:args.p_success?0:1});break;
    case 'log_employee_login_with_device_info':response=result(null);break;
    default:mock.unexpected.push('rpc:'+name);throw new Error('Unexpected local RPC '+name);
  }
  mock.rpcs.push(clone({name,args,response}));
  return response;
}
export const supabase={
  from:table=>new Query(table),rpc,
  channel:()=>{const channel={on:()=>channel,subscribe:()=>channel};return channel;},
  removeChannel:async()=>({status:'ok'}),
};
export const supabaseConfigurationError=null;
export const formatSupabaseError=error=>error?.message||String(error);
export const isSupabaseAbortError=error=>error?.name==='AbortError';
export const isSupabaseTransientError=error=>error?.message==='NetworkError';
export const isEmployeeSessionEndedError=()=>false;
export const isFinancialAdminSessionError=()=>false;
`;

const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Login from './src/pages/Login';
import {LanguageProvider} from './src/lib/i18n';
import {LANGUAGES} from './src/lib/i18n/types';
import en from './src/lib/i18n/locales/en';
import zh from './src/lib/i18n/locales/zh';
import es from './src/lib/i18n/locales/es';
import fr from './src/lib/i18n/locales/fr';
import de from './src/lib/i18n/locales/de';
import pt from './src/lib/i18n/locales/pt';
import ja from './src/lib/i18n/locales/ja';
import ko from './src/lib/i18n/locales/ko';
import it from './src/lib/i18n/locales/it';
import hi from './src/lib/i18n/locales/hi';
window.__maintenanceTest={successCalls:0,LANGUAGES,translations:{en,zh,es,fr,de,pt,ja,ko,it,hi}};
createRoot(document.getElementById('root')).render(
  <React.StrictMode><LanguageProvider><Login onLoginSuccess={()=>{window.__maintenanceTest.successCalls++;}}/></LanguageProvider></React.StrictMode>
);
`;
const javascript = await build({
  absWorkingDir: project,
  stdin: { contents:harness, resolveDir:project, loader:'tsx' },
  bundle:true, write:false, format:'esm', jsx:'automatic', metafile:true,
  plugins: [{
    name:'supabase-only-local-double',
    setup(bundler) {
      bundler.onResolve({filter:/supabase(?:\.ts)?$/}, args => {
        if (resolve(args.resolveDir, args.path).replace(/\.ts$/, '') === join(project, 'src/lib/supabase')) {
          return {path:'local-supabase',namespace:'maintenance-isolation'};
        }
      });
      bundler.onLoad({filter:/.*/,namespace:'maintenance-isolation'}, () => ({contents:supabaseDouble,loader:'js'}));
    },
  }],
});
for (const path of sourcePaths.filter(path => !path.endsWith('.css'))) {
  assert(javascript.metafile.inputs[path], `必须打包真实源码：${path}`);
}
assert(!javascript.metafile.inputs['src/lib/supabase.ts'], '真实 Supabase 模块不得进入隔离测试包');
assert.equal(Object.keys(javascript.metafile.inputs).filter(path => path.startsWith('maintenance-isolation:')).length, 1);
const config = configLoader.loadConfig(join(project, 'tailwind.config.js'));
const stylesheet = await postcss([tailwindcss({...config,content:[join(project,'src/**/*.{js,ts,jsx,tsx}')]})])
  .process(await readFile(join(project,'src/index.css'),'utf8'), {from:join(project,'src/index.css')});
const html = '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>';
const server = createServer((request,response) => {
  if (request.url === '/test.js') {
    response.setHeader('Content-Type','text/javascript');response.end(javascript.outputFiles[0].text);
  } else if (request.url === '/test.css') {
    response.setHeader('Content-Type','text/css');response.end(stylesheet.css);
  } else if (request.url === '/' || request.url === '/favicon.ico') {
    response.setHeader('Content-Type','text/html');response.end(html);
  } else {response.statusCode=404;response.end('Not found');}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const {chromium} = await loadPlaywright();
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const pageErrors = [];
const unexpectedConsoleErrors = [];
const externalRequests = [];
const summaries = [];
const authKeys = ['work_platform_auth','work_platform_remembered_auth','work_platform_remembered_username'];
const password = 'Local-test-password-42';
const layouts = [
  {name:'phone',width:375,height:812,touch:true},
  {name:'tablet',width:768,height:1024,touch:true},
  {name:'desktop',width:1440,height:900,touch:false},
];
const dialog = page => page.getByRole('dialog');
const getState = page => page.evaluate(() => ({
  successCalls:window.__maintenanceTest.successCalls,
  rpcs:window.__maintenanceMock.rpcs,
  credentialsValidated:window.__maintenanceMock.credentialsValidated,
  unexpected:window.__maintenanceMock.unexpected,
  storage:window.__storageOperations,
  ipLookups:window.__localIpLookups,
  auth:sessionStorage.getItem('work_platform_auth'),
  remembered:localStorage.getItem('work_platform_remembered_auth'),
  rememberedUsername:localStorage.getItem('work_platform_remembered_username'),
}));

async function openPage(layout, seeded=false) {
  const context = await browser.newContext({
    viewport:{width:layout.width,height:layout.height},
    hasTouch:layout.touch,isMobile:layout.touch,
  });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());return route.abort();
    }
    return route.continue();
  });
  await context.addInitScript(({seeded}) => {
    localStorage.setItem('employee_language','zh');
    if (seeded) {
      const oldAuth = {user:{id:'old-local-employee',username:'old-local-employee'},userType:'employee',sessionToken:'old-local-marker',financialSessionToken:'old-local-token',tabId:'old-local-tab',expiresAt:Date.now()+86400000};
      sessionStorage.setItem('work_platform_auth',JSON.stringify(oldAuth));
      localStorage.setItem('work_platform_remembered_auth',JSON.stringify(oldAuth));
      localStorage.setItem('work_platform_remembered_username','old-local-employee');
    }
    window.__storageOperations = [];
    for (const operation of ['setItem','removeItem','clear']) {
      const original = Storage.prototype[operation];
      Storage.prototype[operation] = function (...args) {
        window.__storageOperations.push({operation,kind:this===localStorage?'local':'session',key:args[0],value:args[1],stack:new Error().stack});
        return original.apply(this,args);
      };
    }
    const nativeFetch = window.fetch.bind(window);
    window.__localIpLookups = 0;
    window.fetch = (input,init) => {
      const url = typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if (url.startsWith('https://api.ipify.org/')) {
        window.__localIpLookups++;
        return Promise.resolve(new Response(JSON.stringify({ip:'192.0.2.42'}),{headers:{'Content-Type':'application/json'}}));
      }
      if (new URL(url,location.href).origin !== location.origin) throw new Error('禁止外部 fetch：'+url);
      return nativeFetch(input,init);
    };
  },{seeded});
  const page = await context.newPage();
  page.on('pageerror',error => pageErrors.push(error.message));
  page.on('console',message => {
    if (message.type()==='error') unexpectedConsoleErrors.push(message.text());
  });
  await page.goto(origin);
  await page.waitForSelector('#username');
  await page.waitForFunction(() => window.__maintenanceTest && document.querySelector('button[type="submit"]').textContent.includes('登录'));
  // Verify the actual responsive branch, not a stubbed breakpoint hook.
  assert.equal(await page.locator('.login-page').evaluate((element,name) => {
    const phone=element.classList.contains('flex-col');
    const tablet=!phone&&element.classList.contains('flex');
    return name==='phone'?phone:name==='tablet'?tablet:!phone&&!tablet;
  },layout.name),true);
  return {context,page};
}

async function submit(page, username='qa-maintained', remember=true, submittedPassword=password) {
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(submittedPassword);
  const checkbox = page.getByRole('checkbox');
  if (await checkbox.isChecked() !== remember) await page.locator('label').filter({has:checkbox}).click();
  await page.evaluate(() => {window.__storageOperations=[];});
  const before = await getState(page);
  await page.locator('button[type="submit"]').click();
  return before;
}

function assertBlockedState(actual,before) {
  assert.equal(actual.successCalls,0,'维护拦截不得触发 onLoginSuccess');
  assert.deepEqual(actual.rpcs.filter(call=>call.name==='record_login_attempt'),[], '维护拦截不得记录成功或失败登录');
  assert.deepEqual(actual.storage.filter(event=>authKeys.includes(event.key)||event.operation==='clear'),[], '不得调用 storeAuth 或修改记住我数据');
  assert.equal(actual.auth,before.auth);
  assert.equal(actual.remembered,before.remembered);
  assert.equal(actual.rememberedUsername,before.rememberedUsername);
  assert.equal(actual.ipLookups,0,'维护拦截不得进入失败路径获取 IP 或写登录纪录');
  assert.deepEqual(actual.unexpected,[]);
}

async function assertMaintenanceFlow(layout) {
  const {context,page} = await openPage(layout);
  const before = await submit(page);
  await dialog(page).waitFor();
  const initial = await getState(page);
  assertBlockedState(initial,before);
  assert.deepEqual(initial.credentialsValidated,[{role:'employee',username:'qa-maintained',tabId:await page.evaluate(()=>sessionStorage.getItem('tabId'))}]);
  const financialCalls = initial.rpcs.filter(call=>call.name==='create_employee_financial_session');
  assert.equal(financialCalls.length,1);
  assert.equal(financialCalls[0].args.p_password,password);
  assert.deepEqual(financialCalls[0].response,{data:{success:false,code:'employee_login_maintenance'},error:null});
  assert.equal(initial.rpcs.some(call=>call.name==='log_employee_login_with_device_info'),false);
  assert.equal(await page.getByRole('alert').count(),0,'旧 warning/error 不应与维护提示同时出现');
  assert.equal(await dialog(page).getAttribute('aria-modal'),'true');
  assert.equal(await page.locator('#root').getAttribute('inert'),'');
  assert.equal(await dialog(page).evaluate(element=>element.parentElement.parentElement===document.body),true);
  assert.equal(await dialog(page).evaluate(element=>document.activeElement===element),true);
  assert.equal(await page.evaluate(()=>document.body.style.position),'fixed');

  await page.mouse.click(2,2);
  assert.equal(await dialog(page).count(),1,'点击背景不得关闭');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'关闭维护提示');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'回到登录');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SELECT');
  const codes = await page.evaluate(()=>window.__maintenanceTest.LANGUAGES.map(option=>option.code));
  for (const code of codes) {
    await dialog(page).locator('select').selectOption(code);
    await page.waitForFunction(code=>document.querySelector('[role="dialog"] h2').textContent===window.__maintenanceTest.translations[code].login.maintenanceTitle,code);
    assert.deepEqual(await dialog(page).locator('p').allTextContents(),await page.evaluate(code=>[
      window.__maintenanceTest.translations[code].login.maintenanceMessage,
      window.__maintenanceTest.translations[code].login.maintenanceContact,
    ],code));
    assert.equal(await dialog(page).count(),1);
    assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SELECT','语言切换不能重置焦点');
    assert.equal(await dialog(page).locator('option').count(),10);
    assert.equal(await dialog(page).locator('select').evaluate(element=>getComputedStyle(element).fontSize),'16px');
    const bounds = await dialog(page).evaluate(element=>({width:element.clientWidth,scrollWidth:element.scrollWidth,rect:element.getBoundingClientRect().toJSON()}));
    assert(bounds.scrollWidth<=bounds.width+1,'弹窗不得横向溢出');
    assert(bounds.rect.x>=15&&bounds.rect.y>=15,'弹窗须保留边缘安全距离');
    assert(bounds.rect.bottom<=layout.height-15);
    for (const button of await dialog(page).locator('button').all()) {
      const rect=await button.boundingBox();
      assert(rect.width>=44&&rect.height>=44,'按钮点击区须至少44px');
    }
    assertBlockedState(await getState(page),before);
  }
  await dialog(page).locator('select').selectOption('zh');
  await page.waitForFunction(()=>document.querySelector('[role="dialog"] h2').textContent==='系统维护与升级');
  await dialog(page).evaluate(element=>{element.scrollTop=0;});
  if (screenshots[layout.name]) await page.screenshot({path:screenshots[layout.name]});
  await page.getByRole('button',{name:'回到登录',exact:true}).click();
  await dialog(page).waitFor({state:'detached'});
  assert.equal(await page.locator('#root').getAttribute('inert'),null);
  assert.equal(await page.evaluate(()=>document.body.style.position),'');
  assert.equal(await page.locator('button[type="submit"]').isEnabled(),true);
  assertBlockedState(await getState(page),before);
  await page.waitForTimeout(200);
  assert.equal((await getState(page)).rpcs.filter(call=>call.name==='create_employee_financial_session').length,1,'返回按钮不得自动重试');

  const secondBefore = await submit(page);
  await dialog(page).waitFor();
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({state:'detached'});
  assertBlockedState(await getState(page),secondBefore);
  assert.equal((await getState(page)).rpcs.filter(call=>call.name==='create_employee_financial_session').length,2,'Esc 关闭不得自动重试');
  summaries.push(`${layout.name}: real Login/auth/RPC维护拦截、10语言、背景、焦点循环、返回及Esc均通过`);
  await context.close();
}

async function assertSuccessFlow(layout, role, disableMaintenance=false) {
  const {context,page} = await openPage(layout);
  if (disableMaintenance) await page.evaluate(()=>{window.__maintenanceMock.enabled=false;});
  const username = role==='admin'?'qa-admin':disableMaintenance?'qa-maintained':'qa-other';
  await submit(page,username,true);
  await page.waitForFunction(()=>window.__maintenanceTest.successCalls===1);
  if (role==='employee') await page.waitForFunction(()=>window.__maintenanceMock.rpcs.some(call=>call.name==='log_employee_login_with_device_info'));
  const state = await getState(page);
  assert.equal(await dialog(page).count(),0);
  assert.equal(state.successCalls,1);
  assert.deepEqual(state.unexpected,[]);
  assert.equal(state.rpcs.filter(call=>call.name==='record_login_attempt').length,1);
  assert.equal(state.rpcs.find(call=>call.name==='record_login_attempt').args.p_success,true);
  const stored=JSON.parse(state.auth);
  assert.equal(stored.userType,role);
  assert.equal(stored.user.username,username);
  assert.equal(state.rememberedUsername,username);
  const sessionWrites=state.storage.filter(event=>event.kind==='session'&&event.operation==='setItem'&&event.key==='work_platform_auth');
  assert.equal(sessionWrites.length,role==='employee'?2:1,'以真实存储副作用确认 storeAuth 被实际执行');
  if (role==='admin') {
    assert.equal(stored.adminSessionToken,'local-admin-session-token');
    assert.equal(state.remembered,null,'管理员不能保存员工会话副本');
    assert.equal(state.rpcs.filter(call=>call.name==='create_admin_financial_session').length,1);
    assert.equal(state.rpcs.filter(call=>call.name==='create_employee_financial_session').length,0,'同名管理员必须优先，维护不能影响管理员');
  } else {
    assert.equal(stored.financialSessionToken,'local-employee-financial-token');
    assert.equal(stored.sessionToken,'local-employee-session-marker');
    assert.equal(stored.tabId,await page.evaluate(()=>sessionStorage.getItem('tabId')));
    assert(stored.expiresAt>Date.now());
    assert.deepEqual(JSON.parse(state.remembered),stored);
    assert.equal(state.rpcs.filter(call=>call.name==='create_employee_financial_session').length,1);
  }
  summaries.push(`${layout.name}: ${role==='admin'?'同名管理员优先且维护开启时正常登录':disableMaintenance?'原受维护员工在关闭维护后正常登录':'其他部门员工在维护开启时正常登录'}、实际会话/记住我/成功记录均通过`);
  await context.close();
}

try {
  for (const layout of layouts) {
    await assertMaintenanceFlow(layout);
    await assertSuccessFlow(layout,'admin');
    await assertSuccessFlow(layout,'employee');
  }
  await assertSuccessFlow(layouts[2],'employee',true);

  // Existing authentication/remember-me must not even be rewritten or removed by a blocked login.
  const preserved = await openPage(layouts[2],true);
  const preservedBefore = await submit(preserved.page,'qa-maintained',false);
  await dialog(preserved.page).waitFor();
  assertBlockedState(await getState(preserved.page),preservedBefore);
  await preserved.page.keyboard.press('Escape');
  await dialog(preserved.page).waitFor({state:'detached'});
  assertBlockedState(await getState(preserved.page),preservedBefore);
  await preserved.context.close();
  summaries.push('维护阻挡时，已有会话与记住我原样保留，未发生任何覆写/删除');

  // The RPC double validates the password before deciding maintenance; real auth/Login retain normal failure behavior.
  const invalid = await openPage(layouts[2]);
  await submit(invalid.page,'qa-maintained',true,'deliberately-wrong-local-password');
  await invalid.page.getByRole('alert').waitFor();
  assert.match(await invalid.page.getByRole('alert').textContent(),/用户名或密码不正确/);
  const invalidState = await getState(invalid.page);
  assert.equal(await dialog(invalid.page).count(),0);
  assert.equal(invalidState.successCalls,0);
  assert.equal(invalidState.rpcs.filter(call=>call.name==='record_login_attempt'&&call.args.p_success===false).length,1);
  assert.deepEqual(invalidState.credentialsValidated,[]);
  assert.equal(invalidState.auth,null);
  await invalid.context.close();
  summaries.push('维护开启时错误密码仍进入原失败提示/失败计数，不误弹维护');

  assert.deepEqual(externalRequests,[],'不得发出外部网络请求');
  assert.deepEqual(pageErrors,[],'浏览器不能发生未捕获错误');
  assert.deepEqual(unexpectedConsoleErrors,[],'浏览器不能出现错误日志');
  assert.deepEqual(await hashSources(),originalSourceHashes,'测试不能修改产品源码');
  console.log(JSON.stringify({
    passed:true,realModules:sourcePaths,substitutedModule:'src/lib/supabase.ts only',
    externalRequests:externalRequests.length,pageErrors:pageErrors.length,
    cases:summaries,screenshots,script:fileURLToPath(import.meta.url),
  },null,2));
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
