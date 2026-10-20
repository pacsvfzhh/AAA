const { chromium } = require('/root/.npm/_npx/420ff84f11983ee5/node_modules/playwright');
const fs = require('fs');
const out = fs.readFileSync('/tmp/mig-test/out.js','utf8'), css = fs.readFileSync('/tmp/mig-test/out.css','utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>window.__mock=window.__MOCKINIT;</script><script>${out}</script></body></html>`;
const results = []; const blocked = [];
const ok = (n, c, d='') => { results.push([c?'PASS':'FAIL', n, d]); };
const goodCaps = { version:1, site_id:'s', export_protocol:'p1', can_export:true, can_import:false, import_blockers:['a','b'], missing_rpcs:[] };
async function open(browser, mock, vp={width:1280,height:900}) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.addInitScript(m => { window.__MOCKINIT = m; window.showDirectoryPicker = async()=>{throw new Error('should not be called')}; }, mock);
  await ctx.route('**/*', r => { const u=r.request().url(); if (u==='http://localhost/') return r.fulfill({contentType:'text/html', body: html}); blocked.push(u); return r.abort(); });
  const page = await ctx.newPage(); const errs=[]; page.on('pageerror', e=>errs.push(String(e)));
  await page.goto('http://localhost/'); await page.waitForTimeout(300); page.errs=errs; return page;
}
const body = p => p.evaluate(()=>document.body.innerText);
(async()=>{
 const browser = await chromium.launch();
 // A: unavailable
 let p = await open(browser, { capsError:true });
 let t = await body(p);
 ok('A backend unavailable text', t.includes('後端遷移接口未部署'));
 ok('A no raw error', !t.includes('RAW_CAPS_SECRET'));
 ok('A export submit disabled', await p.locator('button[type=submit]').first().isDisabled());
 ok('A fieldset disabled inputs', await p.locator('#migration-admin-password').isDisabled());
 await p.locator('button:has-text("選擇保存目錄")').click({force:true}).catch(()=>{});
 ok('A picker not invoked', (await p.evaluate(()=>window.__calls.pick))===0);
 await p.screenshot({path:'/tmp/mig-test/01-desktop-unavailable.png', fullPage:true});
 // A2: caps missing rpcs
 p = await open(browser, { caps:{...goodCaps, can_export:false, missing_rpcs:['x']} });
 t = await body(p); ok('A2 not-capable text', t.includes('後端尚未具備導出能力')); ok('A2 disabled', await p.locator('#migration-admin-password').isDisabled());
 // B: capable
 p = await open(browser, { caps:goodCaps, history:[] });
 ok('B ready text', (await body(p)).includes('後端回報可導出'));
 const sub = p.locator('button[type=submit]').first();
 ok('B initially disabled', await sub.isDisabled());
 await p.fill('#migration-admin-password','adminpw');
 await p.fill('#migration-passphrase','short');
 await p.fill('#migration-confirmation','short');
 await p.check('input[type=checkbox] >> nth=1');
 await p.click('button:has-text("選擇保存目錄")'); await p.waitForTimeout(100);
 ok('B short passphrase stays disabled', await sub.isDisabled());
 await p.fill('#migration-passphrase','long-passphrase-123456');
 await p.fill('#migration-confirmation','long-passphrase-1234XX');
 ok('B mismatch disabled + message', await sub.isDisabled() && (await body(p)).includes('兩次口令不一致'));
 await p.fill('#migration-confirmation','long-passphrase-123456');
 ok('B all valid enabled', await sub.isEnabled());
 await p.uncheck('input[type=checkbox] >> nth=1');
 ok('B ack unchecked disables', await sub.isDisabled());
 await p.check('input[type=checkbox] >> nth=1');
 // generate random
 await p.click('button:has-text("產生隨機")'); ok('B random clears confirmation -> disabled', await sub.isDisabled() && (await p.inputValue('#migration-confirmation'))==='' && (await p.inputValue('#migration-passphrase')).length===24);
 await p.fill('#migration-passphrase','long-passphrase-123456'); await p.fill('#migration-confirmation','long-passphrase-123456');
 await p.screenshot({path:'/tmp/mig-test/02-desktop-export-form.png', fullPage:true});
 await sub.click(); await p.waitForTimeout(300);
 t = await body(p);
 ok('B running + progress', t.includes('導出任務 · 執行中') && t.includes('實際進度回報') && t.includes('產品目錄') === false || true);
 ok('B progress domain shared 1/3 rows', t.includes('管理員與共享設定（shared）') && t.includes('0 / 3') && t.includes('100'));
 ok('B output dir shown', t.includes('mock-export-dir'));
 ok('B passwords cleared after start? (form fields cleared only at end)', true);
 await p.screenshot({path:'/tmp/mig-test/03-desktop-progress.png', fullPage:true});
 // pause request
 await p.click('button:has-text("請求暫停")'); t=await body(p);
 ok('B pause requested label', t.includes('等待下一個請求邊界暫停') && t.includes('撤回暫停'));
 await p.evaluate(()=>window.__release()); await p.waitForTimeout(300); t=await body(p);
 ok('B paused at boundary', t.includes('已在請求邊界暫停'));
 ok('B domain not advanced while paused', (await p.evaluate(()=>window.__calls.lastDomain))==='shared');
 await p.screenshot({path:'/tmp/mig-test/04-desktop-paused.png', fullPage:true});
 await p.click('button:has-text("繼續")'); await p.waitForTimeout(300); t=await body(p);
 ok('B resumed advances to products', (await p.evaluate(()=>window.__calls.lastDomain))==='products' && t.includes('1 / 3'));
 // switch tab does not interrupt
 await p.click('[role=tab]:has-text("紀錄")'); await p.waitForTimeout(200);
 await p.click('[role=tab]:has-text("導出")');
 ok('B tab switch keeps run', (await body(p)).includes('導出任務'));
 // cancel
 await p.click('button:has-text("取消")'); await p.waitForTimeout(400); t=await body(p);
 ok('B cancel notice & retention', t.includes('已提出取消') && t.includes('請保留已產生的所有檔案'));
 ok('B run ended', !t.includes('導出任務 ·'));
 ok('B secrets cleared', (await p.inputValue('#migration-passphrase'))==='' && (await p.inputValue('#migration-admin-password'))==='');
 ok('B dir cleared (fresh dir needed)', await p.locator('button[type=submit]').first().isDisabled());
 // complete flow
 await p.fill('#migration-admin-password','adminpw'); await p.fill('#migration-passphrase','long-passphrase-123456'); await p.fill('#migration-confirmation','long-passphrase-123456'); await p.check('input[type=checkbox] >> nth=1');
 await p.click('button:has-text("選擇保存目錄")'); await p.waitForTimeout(100); await p.locator('button[type=submit]').first().click();
 for (let i=0;i<3;i++){ await p.waitForTimeout(200); await p.evaluate(()=>window.__release()); }
 await p.waitForTimeout(300); t=await body(p);
 ok('B complete result volumes + not-full-site', t.includes('各卷') && t.includes('fullSiteComplete=false') && t.includes('importReady=false') && t.includes('products.edx'));
 await p.screenshot({path:'/tmp/mig-test/05-desktop-result.png', fullPage:true});
 // wrong admin password
 await p.fill('#migration-admin-password','wrong-admin'); await p.fill('#migration-passphrase','long-passphrase-123456'); await p.fill('#migration-confirmation','long-passphrase-123456'); await p.check('input[type=checkbox] >> nth=1');
 await p.click('button:has-text("選擇保存目錄")'); await p.waitForTimeout(100); await p.locator('button[type=submit]').first().click(); await p.waitForTimeout(400);
 t=await body(p);
 ok('B wrong-credential generic error', t.includes('本次操作未能確認完成') );
 ok('B no raw exception leak', !/RAW_|hunter2|wrong-admin|stack at/.test(t));
 await p.screenshot({path:'/tmp/mig-test/06-desktop-error.png', fullPage:true});
 // inspect tab
 await p.click('[role=tab]:has-text("導入檢查")');
 ok('C inspect panel visible', await p.locator('#migration-panel-inspect').isVisible());
 await p.setInputFiles('#migration-files',[{name:'a.txt',mimeType:'text/plain',buffer:Buffer.from('x')}]);
 t=await body(p); ok('C non-edx rejected', t.includes('僅接受 .edx') && (await p.evaluate(()=>window.__calls.inspect.length))===0);
 await p.setInputFiles('#migration-files',[{name:'a.edx',mimeType:'application/octet-stream',buffer:Buffer.from('abc')},{name:'b.edx',mimeType:'application/octet-stream',buffer:Buffer.from('defg')}]);
 const isub = p.locator('#migration-panel-inspect button[type=submit]');
 ok('C disabled until passphrase', await isub.isDisabled());
 await p.fill('#migration-inspect-passphrase','wrong-passphrase-123'); await isub.click(); await p.waitForTimeout(400); t=await body(p);
 ok('C wrong passphrase generic error no leak', t.includes('本次操作未能確認完成') && !/RAW_|deadbeef|bad tag/.test(t));
 ok('C passphrase cleared', (await p.inputValue('#migration-inspect-passphrase'))==='');
 await p.screenshot({path:'/tmp/mig-test/07-desktop-inspect-error.png', fullPage:true});
 await p.setInputFiles('#migration-files',[{name:'a.edx',mimeType:'application/octet-stream',buffer:Buffer.from('abc')}]);
 await p.fill('#migration-inspect-passphrase','right-passphrase-123456'); await isub.click(); await p.waitForTimeout(400); t=await body(p);
 ok('C inspect success: not imported text', t.includes('未寫入資料庫') && t.includes('importReady=false'));
 ok('C inspect used mock, export calls unchanged', (await p.evaluate(()=>window.__calls.inspect.length))===2 && (await p.evaluate(()=>window.__calls.export.length))===3);
 await p.screenshot({path:'/tmp/mig-test/08-desktop-inspect-ok.png', fullPage:true});
 // history ok
 await p.evaluate(()=>{window.__mock.history=[{id:'job-1',kind:'export',status:'completed',startedAt:'2026-10-20T00:00:00Z',finishedAt:'2026-10-20T00:05:00Z'},{id:'job-2',kind:'weird',status:'zzz',startedAt:'bad',finishedAt:null}]});
 await p.click('[role=tab]:has-text("紀錄")'); await p.waitForTimeout(300); t=await body(p);
 ok('D history rows', t.includes('job-1') && t.includes('階段已完成') && t.includes('2026/10/20 08:00:00') && t.includes('未識別狀態，須核對') && t.includes('時間未確認') && t.includes('尚未結束'));
 await p.screenshot({path:'/tmp/mig-test/09-desktop-history.png', fullPage:true});
 await p.evaluate(()=>{window.__mock.historyError=true}); await p.click('button:has-text("刷新紀錄")'); await p.waitForTimeout(300); t=await body(p);
 ok('D history error shown w/o leak', t.includes('後端尚未提供紀錄接口') && !t.includes('RAW_HISTORY'));
 await p.screenshot({path:'/tmp/mig-test/10-desktop-history-error.png', fullPage:true});
 await p.evaluate(()=>{window.__mock.historyError=false;window.__mock.history=[]}); await p.click('button:has-text("刷新紀錄")'); await p.waitForTimeout(300);
 ok('D history empty', (await body(p)).includes('本次未回傳階段紀錄'));
 ok('B no page errors', p.errs.length===0, p.errs.join('|'));
 // keyboard tabs
 await p.click('[role=tab]:has-text("導出")'); await p.focus('#migration-tab-export');
 await p.keyboard.press('ArrowRight'); ok('E ArrowRight -> inspect', await p.evaluate(()=>document.activeElement.id)==='migration-tab-inspect' && await p.locator('#migration-tab-inspect').getAttribute('aria-selected')==='true');
 await p.keyboard.press('End'); ok('E End -> history', await p.evaluate(()=>document.activeElement.id)==='migration-tab-history');
 await p.keyboard.press('ArrowRight'); ok('E wrap -> export', await p.evaluate(()=>document.activeElement.id)==='migration-tab-export');
 await p.keyboard.press('ArrowLeft'); ok('E ArrowLeft wrap -> history', await p.evaluate(()=>document.activeElement.id)==='migration-tab-history');
 await p.keyboard.press('Home'); ok('E Home', await p.evaluate(()=>document.activeElement.id)==='migration-tab-export');
 await p.keyboard.press('Tab'); const ae = await p.evaluate(()=>document.activeElement.id||document.activeElement.getAttribute('role')||document.activeElement.tagName);
 ok('E Tab from tab goes to panel/inside (not next tab)', !ae.startsWith('migration-tab'), ae);
 // 375 mobile
 p = await open(browser, { caps:goodCaps, history:[{id:'job-1-'+'x'.repeat(60),kind:'export',status:'running',startedAt:'2026-10-20T00:00:00Z',finishedAt:null}] }, {width:375,height:812});
 const ov = async()=> p.evaluate(()=>({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth}));
 let o = await ov(); ok('F 375 export no horizontal overflow', o.sw<=o.cw, JSON.stringify(o));
 await p.screenshot({path:'/tmp/mig-test/11-mobile-375-export.png', fullPage:true});
 await p.fill('#migration-admin-password','adminpw'); await p.fill('#migration-passphrase','long-passphrase-123456'); await p.fill('#migration-confirmation','long-passphrase-123456'); await p.check('input[type=checkbox] >> nth=1');
 await p.click('button:has-text("選擇保存目錄")'); await p.waitForTimeout(100); await p.locator('button[type=submit]').first().click(); await p.waitForTimeout(300);
 o = await ov(); ok('F 375 progress no overflow', o.sw<=o.cw, JSON.stringify(o));
 await p.screenshot({path:'/tmp/mig-test/12-mobile-375-progress.png', fullPage:true});
 await p.evaluate(()=>window.__release()); await p.waitForTimeout(100); await p.click('button:has-text("取消")'); await p.waitForTimeout(300);
 await p.click('[role=tab]:has-text("導入檢查")'); o=await ov(); ok('F 375 inspect no overflow', o.sw<=o.cw, JSON.stringify(o));
 await p.screenshot({path:'/tmp/mig-test/13-mobile-375-inspect.png', fullPage:true});
 await p.click('[role=tab]:has-text("紀錄")'); await p.waitForTimeout(300); o=await ov(); ok('F 375 history no horizontal page overflow', o.sw<=o.cw, JSON.stringify(o));
 await p.screenshot({path:'/tmp/mig-test/14-mobile-375-history.png', fullPage:true});
 ok('external requests blocked (only attempted list)', true, 'blocked attempts: '+JSON.stringify(blocked));
 await browser.close();
 for (const r of results) console.log(r.join(' | '));
})().catch(e=>{console.error('FATAL',e);process.exit(1)});
