import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSites, adminLogin, rpc as baseRpc, scalar, rows } from './support/transfer-harness.mjs';
import { NEW, OLD, PASSWORDS, buildNewSite } from './support/transfer-fixtures.mjs';

const migration='20261102000018_restore_employee_finance.sql';
const SHARED=['admins','financial_admin_credentials','admin_groups','admin_group_members','admin_configs','system_configs','history_cleanup_config'];
const DISPATCH=['dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders','dispatch_group_members','valid_order_data','used_order_data'];
const IDENTITY=['accounts','credentials','orders'];
const FINANCE=['wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'];
const id=n=>`71000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const F={e1:id(1),e2:id(2),e3:id(3),o:id(10),tx:id(20),withdraw:id(30),pending2:id(31),audit:'9007199254740999',ledger1:'1',cursor:'9007199254740993',ledger2:'9007199254740994'};
const hash=text=>createHash('sha256').update(text).digest('hex');
const lines=text=>text.match(/[^\n]*\n/g)??[];
const chunks=text=>{const out=[];let part='',n=0;for(const line of lines(text)){if(n===200||Buffer.byteLength(part+line)>262144){out.push(part);part='';n=0;}part+=line;n++;}if(part||!out.length)out.push(part);return out;};
let source,db,replay,sourceSession,session,branch,emergency,other,modules,packageId,shared,dispatch,identity,finance,task,prepared,guarded;
let sequence=0;
async function transaction(fn,site=db,commit=false){await site.exec('BEGIN');try{const value=await fn();await site.exec(commit?'COMMIT':'ROLLBACK');return value;}catch(e){await site.exec('ROLLBACK');throw e;}}
async function isolated(site,fn){const point=`finance_${++sequence}`;await site.exec(`SAVEPOINT ${point}`);try{const value=await fn();await site.exec(`RESET ROLE;RELEASE SAVEPOINT ${point}`);return value;}catch(e){await site.exec(`ROLLBACK TO SAVEPOINT ${point};RELEASE SAVEPOINT ${point}`);throw e;}}
const on=(site,name,args)=>isolated(site,()=>baseRpc(site,name,args));
const auth=(job=task,token=session)=>({p_admin_session_token:token,p_job_token:job.job_token});
const rpc=(name,args)=>on(db,name,args);
const permits=()=>scalar(db,'SELECT count(*)::int FROM private.employee_transfer_write_permits');
const state=()=>scalar(db,'SELECT summary FROM private.employee_transfer_jobs WHERE id=$1',[task.job_id]);
const business=()=>rows(db,guarded.map(name=>`SELECT '${name}' AS name,count(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
const triggers=()=>rows(db,`SELECT c.relname,t.tgname,t.tgenabled,private.employee_transfer_trigger_digest(t.oid) AS digest FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
async function capture(kind){
  const keys=kind==='shared'?SHARED:kind==='dispatch'?DISPATCH:kind==='identity'?IDENTITY:FINANCE;
  const job=await on(source,`employee_export_${kind}_begin`,{p_admin_session_token:sourceSession,p_admin_password:PASSWORDS.root,...(['identity','finance'].includes(kind)?{p_package_id:packageId}:{})});
  const texts={};for(const key of keys){let text='',after=null;do{const page=await on(source,`get_employee_export_${kind}_page`,{...auth(job,sourceSession),p_table_key:key,p_after:after,p_limit:200});assert.equal(page.sha256,hash(page.ndjson));text+=page.ndjson;after=page.next_after;}while(after!==null);texts[key]=text;}
  assert.equal((await on(source,`employee_export_${kind}_verify`,auth(job,sourceSession))).verified,true);
  await on(source,kind==='shared'?'employee_transfer_cancel':`employee_export_${kind}_close`,auth(job,sourceSession));
  return {catalog:job.catalog,texts};
}
async function prepare(kind,input){
  const job=await rpc(kind==='shared'?'employee_import_shared_replace_begin':'employee_import_dispatch_begin',{p_admin_session_token:session,p_admin_password:PASSWORDS.root,p_package_id:packageId,p_catalog:input.catalog});
  for(const key of kind==='shared'?SHARED:DISPATCH)for(const [no,text]of chunks(input.texts[key]).entries())await rpc(`employee_import_${kind}_stage`,{...auth(job),p_table_key:key,p_chunk_no:no,p_ndjson:text});
  const plan=await rpc(kind==='shared'?'get_employee_import_shared_replace_dry_run':'get_employee_import_dispatch_dry_run',auth(job));
  return {job,plan};
}
async function* disk(path){const file=await open(path,'r');try{const bytes=Buffer.alloc(65521);for(;;){const r=await file.read(bytes);if(!r.bytesRead)return;yield bytes.subarray(0,r.bytesRead);}}finally{await file.close();}}
async function seal(kind,job,plan){
  const descriptor=await rpc(`get_employee_import_${kind}_backup`,auth(job));
  const keys=kind==='shared'?SHARED:DISPATCH,dir=await mkdtemp(join(tmpdir(),'finance-backup-')),plain=new Map();let opens=0;
  const path=join(dir,'independent.edx');
  try{await (kind==='shared'?modules.createReplacementBackup:modules.createDispatchBackup)(descriptor,{
    async catalog(){return (await rpc(`get_employee_import_${kind}_backup`,auth(job))).catalog;},
    page(key,after){return rpc(`get_employee_import_${kind}_backup_page`,{...auth(job),p_table_key:key,p_after:after,p_limit:200});},
    async verify(){return {verified:true,scope:kind==='shared'?'shared-settings':'dispatch-submission',full_site_complete:false};},
  },{
    async append(name,bytes){assert.ok(keys.some(key=>name.endsWith(`-${key}.ndjson`)));plain.set(name,[...(plain.get(name)??[]),Buffer.from(bytes)]);},
    open(name){return (async function*(){yield* plain.get(name)??[];})();},async abort(){plain.clear();},
  },{
    async write(stream){const file=await open(path,'wx');try{for await(const bytes of stream)await file.writeFile(bytes);await file.sync();}finally{await file.close();}},
    open(){opens++;return disk(path);},
  },{
    append(no,hex){assert.equal(opens,2);return rpc(`employee_import_${kind}_backup_append`,{...auth(job),p_plan_hash:plan.plan_hash,p_chunk_no:no,p_hex:hex});},
    seal(sha256,bytes){return rpc(`employee_import_${kind}_backup_seal`,{...auth(job),p_plan_hash:plan.plan_hash,p_sha256:sha256,p_bytes:bytes});},
  },'local-finance-independent-backup-passphrase');assert.equal(opens,2);assert.equal(plain.size,0);
  }finally{await rm(dir,{recursive:true,force:true});}
}
function transport(site=db,token=session){modules.setHarness({token,rpc(name,args){const q={abortSignal(){return q;},then(resolve,reject){return on(site,name,args).then(data=>({data,error:null})).then(resolve,reject);}};return q;}});}
async function ready(){
  await rpc('employee_import_dispatch_enter_maintenance',{...auth(),p_plan_hash:prepared.plan_hash,p_confirmation:'確認暫停業務並導入派單資料',p_admin_password:PASSWORDS.root});
  const config=await rpc('get_employee_import_dispatch_configuration_plan',auth());await rpc('employee_import_dispatch_apply_configuration',{...auth(),p_plan_hash:config.plan_hash});
  const valid=await rpc('employee_import_dispatch_valid_begin',{...auth(),p_plan_hash:config.plan_hash});for(let n=0;n<valid.chunks;n++)await rpc('employee_import_dispatch_valid_chunk',{...auth(),p_chunk_no:n});await rpc('employee_import_dispatch_valid_verify',auth());
  await rpc('employee_import_identity_bind',{...auth(),p_catalog:identity.catalog});
  for(const key of IDENTITY)for(const[n,text]of chunks(identity.texts[key]).entries())await rpc('employee_import_identity_stage',{...auth(),p_table_key:key,p_chunk_no:n,p_ndjson:text});
  const ip=await rpc('get_employee_import_identity_plan',auth());assert.equal(ip.can_restore,true);const begun=await rpc('employee_import_identity_begin',{...auth(),p_plan_hash:ip.plan_hash});
  for(const key of IDENTITY)for(let n=0;n<begun.chunks[key];n++)await rpc('employee_import_identity_chunk',{...auth(),p_table_key:key,p_chunk_no:n});await rpc('employee_import_identity_verify',auth());
  const dp=await rpc('get_employee_import_dispatch_dependency_plan',auth());assert.equal(dp.can_restore,true);const ds=await rpc('employee_import_dispatch_dependency_begin',{...auth(),p_plan_hash:dp.plan_hash});
  for(const key of ['dispatch_group_members','used_order_data'])for(let n=0;n<ds.chunks[key];n++)await rpc('employee_import_dispatch_dependency_chunk',{...auth(),p_table_key:key,p_chunk_no:n});await rpc('employee_import_dispatch_dependency_verify',auth());
}
const bind=(input=finance,extra={})=>rpc('employee_import_finance_bind',{...auth(),p_catalog:input.catalog,...extra});
const plan=(extra={})=>rpc('get_employee_import_finance_plan',{...auth(),...extra});
const apply=(p,employee=F.e1,extra={})=>rpc('employee_import_finance_apply',{...auth(),p_employee_id:employee,p_plan_hash:p.plan_hash,...extra});
const verify=(extra={})=>rpc('employee_import_finance_verify',{...auth(),...extra});
async function stage(input=finance){await bind(input);for(const key of FINANCE)for(const[n,text]of chunks(input.texts[key]).entries())await rpc('employee_import_finance_stage',{...auth(),p_table_key:key,p_chunk_no:n,p_ndjson:text});return plan();}
async function restore(p){for(const employee of [F.e1,F.e2,F.e3])await apply(p,employee);return verify();}
async function corrupt(table,sql,args=[]){await db.exec(`ALTER TABLE public.${table} DISABLE TRIGGER zz_employee_transfer_maintenance`);await db.query(sql,args);await db.exec(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance`);}

before(async()=>{
  mock.method(globalThis,'fetch',()=>assert.fail('financial tests prohibit network and production access'));
  replay=await createSites({upTo:migration});source=replay.oldSite;db=replay.newSite;await db.query('UPDATE private.employee_transfer_site SET site_id=$1',[randomUUID()]);await buildNewSite(db);
  for(const [admin,name,role,password]of [[OLD.root,'root','super_admin',PASSWORDS.root],[OLD.branch,'branch','secondary_admin',PASSWORDS.branch]]){
    await source.query('INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,$2,extensions.crypt($3,extensions.gen_salt(\'bf\',4)),$4,true)',[admin,name,password,role]);
    await source.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1',[admin]);
  }
  await source.query('UPDATE public.dispatch_groups SET created_by=$1',[OLD.root]);await source.query('UPDATE public.dispatch_order_pools SET created_by=$1',[OLD.root]);
  await source.query("INSERT INTO public.product_types(id,name) VALUES($1,'Finance source product')",[OLD.product]);
  for(const [employee,name,income]of [[F.e1,'finance-one',32],[F.e2,'finance-legacy',0],[F.e3,'finance-empty',0]]){
    await source.query('INSERT INTO public.users(id,username,password_hash,employee_id,created_by,total_income,is_active) VALUES($1,$2,extensions.crypt($3,extensions.gen_salt(\'bf\',4)),$2,$4,$5,true)',[employee,name,PASSWORDS.employee,OLD.branch,income]);
    await source.query('INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by) SELECT id,$1,$2 FROM public.dispatch_groups WHERE is_default',[employee,OLD.root]);
  }
  await transaction(async()=>{
    const disabled=await scalar(source,"SELECT private.employee_transfer_bypass_triggers(ARRAY['orders','wallets','wallet_transactions','withdrawals'])");
    await source.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,commission_amount,commission_rate,created_at,processed_at)
      VALUES($1,$2,'finance-one',$3,987.65,'must-not-export-order-number','must-not-export-transaction','success',32,0.01234567890123456789,'2023-01-02T03:04:05.123456Z','2023-02-03T04:05:06.654321Z')`,[F.o,F.e1,OLD.product]);
    await source.query(`INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after,reference_id,remarks,created_by,created_at,operation_id)
      VALUES($1,$2,'commission',32,0,32,$3,NULL,$4,'2023-02-03T04:05:06.654321Z',$5),($6,$2,'manual_adjustment',1.1234567890123456789,32,33.1234567890123456789,NULL,E'來源備註\\n𠮷 é é',NULL,NULL,NULL)`,[F.tx,F.e1,F.o,OLD.branch,id(201),id(21)]);
    for(const [n,status,amount]of [[30,'pending',3],[32,'approved',2],[33,'rejected',4],[34,'cancelled',5]])await source.query(`INSERT INTO public.withdrawals(id,user_id,amount,status,audit_remark,audited_by,audited_at,created_at,last_operation_id)
      VALUES($1,$2,$3,$4,NULL,$5,NULL,'2023-02-03T04:05:06.654321Z',$6)`,[id(n),F.e1,amount,status,status==='pending'?null:OLD.branch,id(300+n)]);
    await source.query("INSERT INTO public.withdrawals(id,user_id,amount,status) VALUES($1,$2,7,'pending')",[F.pending2,F.e2]);
    await source.query(`UPDATE public.wallets SET available_balance=CASE user_id WHEN $1 THEN 102 WHEN $2 THEN 40 ELSE 0 END,
      frozen_balance=CASE user_id WHEN $1 THEN 3 WHEN $2 THEN 7 ELSE 0 END,created_at='2021-01-02T03:04:05.123456Z',updated_at=NULL`,[F.e1,F.e2]);
    await source.exec('DELETE FROM public.wallet_balance_baselines;DELETE FROM public.wallet_ledger_entries');
    await source.query(`INSERT INTO public.wallet_ledger_entries(id,user_id,operation_id,source_type,source_id,event_type,available_delta,frozen_delta,income_delta,created_at)
      VALUES(1,$1,$3,'wallet_transaction',$4,'before',100,0,30,'2020-01-02T03:04:05.123456Z'),(3,$2,$5,'withdrawal',$6,'zero',0,0,0,'2020-01-02T03:04:05.123456Z'),
      (9007199254740993,$1,$7,'wallet_transaction',$4,'at',0,0,0,'2021-01-02T03:04:05.123456Z'),
      (9007199254740994,$1,$8,'wallet_transaction',$4,'after',5,0,2,'2022-01-02T03:04:05.123456Z')`,[F.e1,F.e3,id(401),F.tx,id(402),F.withdraw,id(403),id(404)]);
    await source.query(`INSERT INTO public.wallet_balance_baselines(user_id,available_balance,frozen_balance,total_income,last_ledger_id,established_at)
      VALUES($1,100,0,30,9007199254740993,'2022-01-02T03:04:05.123456Z'),($2,0,0,0,0,'2022-01-02T03:04:05.123456Z')`,[F.e1,F.e3]);
    await source.query(`INSERT INTO public.wallet_reconciliation_audit(id,user_id,available_before,available_after,frozen_before,frozen_after,income_before,income_after,pending_amount,ledger_total,reason,repaired_at)
      VALUES(9007199254740999,$1,103,102,2,3,31,32,3,105,'來源對賬原因','2023-03-04T05:06:07.123456Z')`,[F.e1]);
    await source.query('SELECT private.employee_transfer_restore_triggers($1::jsonb)',[JSON.stringify(disabled)]);
  },source,true);
  await db.query("INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,'finance-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)",[id(900),PASSWORDS.root]);
  session=await adminLogin(db,'root',PASSWORDS.root);sourceSession=await adminLogin(source,'root',PASSWORDS.root);branch=await adminLogin(db,'branch',PASSWORDS.branch);emergency=await adminLogin(db,'emergency',PASSWORDS.emergency);other=await adminLogin(db,'finance-other-root',PASSWORDS.root);
  guarded=await scalar(db,'SELECT private.employee_transfer_guarded_tables()');packageId=randomUUID();
  const root=fileURLToPath(new URL('../../',import.meta.url)),compiled=await build({stdin:{contents:`export {createReplacementBackup}from './src/lib/employeeTransfer/replacementBackup.ts';export {createDispatchBackup}from './src/lib/employeeTransfer/dispatchBackup.ts';export * from './src/lib/employeeTransfer/financeApi.ts';export * from './src/lib/employeeTransfer/financeTransfer.ts';export {setHarness}from'finance-db:state';`,resolveDir:root},bundle:true,write:false,platform:'browser',format:'esm',target:'es2020',plugins:[{name:'local-finance-sql',setup(builder){
    builder.onResolve({filter:/^(?:finance-db:state|\.\.\/(?:auth|supabase))$/},args=>({path:args.path,namespace:'finance-db'}));
    builder.onLoad({filter:/.*/,namespace:'finance-db'},({path})=>({contents:path==='finance-db:state'?'let h;export const setHarness=x=>{h=x};export const current=()=>h;':path==='../auth'?'import{current}from"finance-db:state";export const getAdminFinancialSessionToken=()=>current().token;':'import{current}from"finance-db:state";export const supabase={rpc:(...args)=>current().rpc(...args)};'}));
  }}]});modules=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  shared=await transaction(()=>capture('shared'),source,true);
  await transaction(async()=>{const r=await prepare('shared',shared);await seal('shared',r.job,r.plan);assert.equal((await rpc('employee_import_shared_replace_apply',{...auth(r.job),p_plan_hash:r.plan.plan_hash})).success,true);await rpc('employee_transfer_cancel',auth(r.job));},db,true);
  dispatch=await transaction(()=>capture('dispatch'),source,true);identity=await transaction(()=>capture('identity'),source,true);finance=await transaction(()=>capture('finance'),source,true);
  assert.deepEqual(finance.catalog.identity_catalog,identity.catalog);
  await transaction(async()=>{const r=await prepare('dispatch',dispatch);task=r.job;prepared=r.plan;await seal('dispatch',task,prepared);},db,true);
},{timeout:180000});
after(async()=>{mock.restoreAll();await Promise.all([source?.close(),db?.close()]);});

test('545 real migrations retain exactly the original 12 historical failures; finance stages install without skipping',()=>{
  assert.equal(replay.files.length,545);assert.equal(replay.failures.length,12);assert.equal(replay.validation.freshDatabaseVerified,false);assert.equal(replay.files.at(-1),migration);
});
for(const [name,args]of [
  ['employee_export_finance_begin',['p_admin_session_token','p_admin_password','p_package_id']],['get_employee_export_finance_page',['p_admin_session_token','p_job_token','p_table_key','p_after','p_limit']],
  ['employee_export_finance_verify',['p_admin_session_token','p_job_token']],['employee_export_finance_close',['p_admin_session_token','p_job_token']],
  ['employee_import_finance_bind',['p_admin_session_token','p_job_token','p_catalog']],['employee_import_finance_stage',['p_admin_session_token','p_job_token','p_table_key','p_chunk_no','p_ndjson']],
  ['get_employee_import_finance_plan',['p_admin_session_token','p_job_token']],['employee_import_finance_apply',['p_admin_session_token','p_job_token','p_employee_id','p_plan_hash']],['employee_import_finance_verify',['p_admin_session_token','p_job_token']],
])test(`${name} uses fixed arguments, explicit anon grants and definer search path`,()=>transaction(async()=>{
  const fn=(await rows(db,`SELECT proargnames,prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') AS anon,has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS everyone FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1`,[name]))[0];
  assert.deepEqual(fn.proargnames,args);assert.equal(fn.prosecdef,true);assert.equal(fn.anon,true);assert.equal(fn.authenticated,true);assert.equal(fn.everyone,false);assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
}));

test('raw finance pages preserve all six tables, high precision, bigint IDs, all withdrawal states and exclude detailed orders',()=>transaction(async()=>{
  assert.match(finance.texts.wallet_ledger_entries,/"id": "9007199254740994"/);assert.match(finance.texts.wallet_balance_baselines,/"last_ledger_id": "9007199254740993"/);
  assert.match(finance.texts.wallet_transactions,/1\.1234567890123456789/);assert.doesNotMatch(Object.values(finance.texts).join(''),/must-not-export-order-number|must-not-export-transaction|product_value|password_hash/);
  assert.deepEqual(new Set(lines(finance.texts.withdrawals).map(line=>JSON.parse(line).status)),new Set(['pending','approved','rejected','cancelled']));
  assert.deepEqual(finance.catalog.identity_catalog,identity.catalog);assert.equal((await on(source,'get_employee_transfer_log',{p_admin_session_token:sourceSession})).last_export_at,null);
},source));

test('real finance roundtrip restores all fields, renumbers ledger/audit and translates the baseline without money side effects',()=>transaction(async()=>{
  await ready();const before=await triggers(),p=await stage();assert.equal(p.can_restore,true,JSON.stringify(p.conflicts));assert.equal(p.employees,3);assert.deepEqual(p.pending_withdrawals,{count:2,amount:'10'});
  assert.equal(p.counts.wallet_ledger_entries,4);await assert.rejects(verify(),/incomplete/);
  for(const employee of [F.e1,F.e2,F.e3]){const receipt=await apply(p,employee);assert.equal(receipt.verified,true);assert.equal(receipt.maintenance,true);assert.equal(receipt.financial_data_pending,true);assert.equal(receipt.full_site_complete,false);assert.deepEqual(await apply(p,employee),{...receipt,repeated:true});assert.equal(await permits(),0);}
  const result=await verify();assert.equal(result.completed_employees,3);assert.deepEqual(result.counts,p.counts);assert.deepEqual(await verify(),{...result,repeated:true});assert.deepEqual(await plan(),p);
  assert.equal(await scalar(db,'SELECT available_balance::text FROM public.wallets WHERE user_id=$1',[F.e1]),'102');assert.equal(await scalar(db,'SELECT frozen_balance::text FROM public.wallets WHERE user_id=$1',[F.e1]),'3');
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.wallet_balance_baselines WHERE user_id=$1',[F.e2]),0);
  const mapped=await rows(db,"SELECT item.value->>'old_id' AS old_id,item.value->>'new_id' AS new_id FROM private.employee_transfer_staging AS s CROSS JOIN LATERAL jsonb_array_elements(s.payload) AS item(value) WHERE job_id=$1 AND employee_id=$2 AND table_key='finance-map:wallet_ledger_entries' ORDER BY (item.value->>'old_id')::bigint",[task.job_id,F.e1]);
  assert.deepEqual(mapped.map(row=>row.old_id),['1',F.cursor,F.ledger2]);assert.ok(mapped.every((row,n)=>n===0||BigInt(row.new_id)>BigInt(mapped[n-1].new_id)));
  assert.equal(await scalar(db,'SELECT last_ledger_id::text FROM public.wallet_balance_baselines WHERE user_id=$1',[F.e1]),mapped[1].new_id);
  assert.equal(await scalar(db,'SELECT last_ledger_id::text FROM public.wallet_balance_baselines WHERE user_id=$1',[F.e3]),'0');assert.ok(!mapped.some(row=>row.new_id===F.ledger2));
  for(const table of ['commission_audit_log','withdrawal_events','wallet_reconciliation_queue','notification_automation_queue'])assert.equal(await scalar(db,`SELECT count(*)::int FROM public.${table}`),0,table);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.users WHERE is_active AND id=ANY($1::uuid[])',[[F.e1,F.e2,F.e3]]),0);assert.deepEqual(await triggers(),before);
  assert.deepEqual(await rpc('get_employee_transfer_maintenance',{p_admin_session_token:session}),{active:true,job_id:task.job_id,dirty:true,full_site_complete:false});
}));

test('real finance client streams source raw files into anon staging and explicitly applies/continues each employee',()=>transaction(async()=>{
  await ready();const captured=await transaction(async()=>{transport(source,sourceSession);const exp=modules.createFinanceExportSession(packageId,PASSWORDS.root),catalog=await exp.begin(),files=new Map();
    await modules.exportFinanceData(exp.source,{async append(path,bytes){files.set(path,[...(files.get(path)??[]),Buffer.from(bytes)]);},async abort(){files.clear();}});await exp.close();return {catalog,files:new Map([...files].map(([key,parts])=>[key,Buffer.concat(parts)]))};},source);
  transport();const imp=modules.createFinanceImportSession(task.job_token);let discarded=0,progress=0;
  const result=await modules.stageFinanceImport(captured.catalog,{open(path){return(async function*(){const bytes=captured.files.get(path);for(let n=0;n<bytes.length;n+=37)yield bytes.subarray(n,n+37);})();},async abort(){discarded++;}},imp.target,{onProgress(p){if(p.phase==='stage')progress=p.rows;}});
  assert.equal(discarded,1);assert.equal(progress,lines(Object.values(finance.texts).join('')).length);assert.equal(result.plan.can_restore,true);
  await imp.apply(F.e1,result.plan.plan_hash);const resume=modules.createFinanceImportSession(task.job_token);await resume.target.bind(finance.catalog);const rp=await resume.plan();assert.deepEqual(rp,result.plan);
  assert.equal((await resume.apply(F.e1,rp.plan_hash)).repeated,true);await resume.apply(F.e2,rp.plan_hash);await resume.apply(F.e3,rp.plan_hash);assert.equal((await resume.verify()).completed_employees,3);
}));

for(const [label,table,sql,args]of [
  ['wallet','wallets','UPDATE public.wallets SET available_balance=available_balance+1 WHERE user_id=$1',()=>[F.e1]],
  ['baseline cursor','wallet_balance_baselines','UPDATE public.wallet_balance_baselines SET last_ledger_id=0 WHERE user_id=$1',()=>[F.e1]],
  ['ledger content','wallet_ledger_entries',"UPDATE public.wallet_ledger_entries SET event_type='negative-drift' WHERE user_id=$1",()=>[F.e1]],
  ['transaction memo','wallet_transactions',"UPDATE public.wallet_transactions SET remarks='negative-drift' WHERE id=$1",()=>[F.tx]],
  ['withdrawal status','withdrawals',"UPDATE public.withdrawals SET audit_remark='negative-drift' WHERE id=$1",()=>[F.withdraw]],
  ['audit history','wallet_reconciliation_audit',"UPDATE public.wallet_reconciliation_audit SET reason='negative-drift' WHERE user_id=$1",()=>[F.e1]],
])test(`same-count ${label} drift invalidates plan/repeated apply/verification after success`,()=>transaction(async()=>{
  await ready();const p=await stage();await restore(p);await corrupt(table,sql,args());const before=await business(),saved=await state();
  for(const action of [()=>plan(),()=>apply(p),()=>verify()])await assert.rejects(action(),/post-write|committed|reconciliation/);
  assert.deepEqual(await business(),before);assert.deepEqual(await state(),saved);assert.equal(await permits(),0);
}));

for(const [label,sql]of [
  ['unreviewed wallet trigger','CREATE TRIGGER aa_finance_unknown BEFORE UPDATE ON public.wallets FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['unreviewed baseline trigger','CREATE TRIGGER aa_finance_unknown BEFORE INSERT ON public.wallet_balance_baselines FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['disabled ledger side effect','ALTER TABLE public.wallet_transactions DISABLE TRIGGER trigger_track_wallet_transaction_ledger'],
  ['replica withdrawal side effect','ALTER TABLE public.withdrawals ENABLE REPLICA TRIGGER trigger_track_withdrawal_ledger'],
  ['changed ledger function','ALTER FUNCTION public.track_wallet_transaction_in_ledger() SECURITY INVOKER'],
])test(`finance refuses ${label} without touching money`,()=>transaction(async()=>{
  await ready();const p=await stage();await db.exec(sql);const before=await business();await assert.rejects(apply(p),/Unreviewed employee finance triggers/);assert.deepEqual(await business(),before);assert.equal(await permits(),0);
}));

for(const [label,token]of [['secondary',()=>branch],['emergency',()=>emergency],['other super-admin',()=>other],['unknown',()=>randomUUID()]])test(`finance write and preparation reject ${label}`,()=>transaction(async()=>{
  await ready();const p=await stage(),before=await business(),extra={p_admin_session_token:token()};
  for(const action of [()=>bind(finance,extra),()=>plan(extra),()=>apply(p,F.e1,extra),()=>verify(extra)])await assert.rejects(action(),/Super administrator|invalid or expired/);
  assert.deepEqual(await business(),before);assert.equal(await permits(),0);
}));

test('late employee event failure rolls back wallet/ledger/mappings/receipts and restores triggers, preserving prior employee',()=>transaction(async()=>{
  await ready();const p=await stage();await apply(p,F.e2);const before=await business(),saved=await state(),original=await triggers();
  await db.exec(`CREATE FUNCTION public.finance_event_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='finance_employee_restored' THEN RAISE EXCEPTION 'late finance failure';END IF;RETURN NEW;END $$;
    CREATE TRIGGER finance_event_fail BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.finance_event_fail()`);
  await assert.rejects(apply(p,F.e1),/late finance failure/);assert.deepEqual(await business(),before);assert.deepEqual(await state(),saved);assert.equal(await permits(),0);
  assert.equal(await scalar(db,"SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND employee_id=$2 AND table_key LIKE 'finance-map:%'",[task.job_id,F.e1]),0);
  await db.exec('DROP TRIGGER finance_event_fail ON private.employee_transfer_events;DROP FUNCTION public.finance_event_fail()');assert.deepEqual(await triggers(),original);assert.equal((await apply(p,F.e2)).repeated,true);
}));

test('financial formula errors block the source rather than repairing snapshots or omitting pending withdrawals',()=>transaction(async()=>{
  await ready();const input=await transaction(async()=>{await source.query('UPDATE public.wallets SET frozen_balance=4 WHERE user_id=$1',[F.e1]);return capture('finance');},source);
  const before=await business(),p=await stage(input);assert.equal(p.can_restore,false);assert.ok(p.conflicts.includes('inconsistent_source_finance'));await assert.rejects(apply(p),/conflict-free/);assert.deepEqual(await business(),before);
}));

test('cross-package/identity catalog mismatch, non-member employee and forged plan cannot authorize finance',()=>transaction(async()=>{
  await ready();await assert.rejects(bind({catalog:{...finance.catalog,package_id:randomUUID()}}),/binding differs/);
  await assert.rejects(bind({catalog:{...finance.catalog,identity_catalog:{...identity.catalog,processing_orders:99}}}),/exact restored identity/);
  const p=await stage();await assert.rejects(apply({plan_hash:hash('forged')}),/conflict-free/);await assert.rejects(apply(p,id(999)),/verified member/);assert.equal(await permits(),0);
}));

test('source changes with unchanged counts invalidate finance export and protocol cannot call old import or advance full export time',()=>transaction(async()=>{
  await transaction(async()=>{const exp=await on(source,'employee_export_finance_begin',{p_admin_session_token:sourceSession,p_admin_password:PASSWORDS.root,p_package_id:packageId});
    await assert.rejects(on(source,'employee_export_finance_close',auth(exp,sourceSession)),/not been verified/);
    await source.query("UPDATE public.wallet_transactions SET remarks='source-changed' WHERE id=$1",[F.tx]);await assert.rejects(on(source,'employee_export_finance_verify',auth(exp,sourceSession)),/source changed/);
    await assert.rejects(on(source,'employee_export_identity_verify',auth(exp,sourceSession)),/protocol/);
  },source);
  await ready();const p=await stage();await apply(p);
  for(const name of ['employee_import_finish','employee_import_finalize_employee'])await assert.rejects(rpc(name,{...auth(),...(name.endsWith('finish')?{p_summary:{}}:{p_employee_id:F.e1,p_expected:{}})}),/protocol/);
}));

test('reconciliation after import performs zero money repairs and legacy accounts establish a baseline without changing balances',()=>transaction(async()=>{
  await ready();await restore(await stage());
  const before=await scalar(db,"SELECT jsonb_agg(jsonb_build_array(user_id,available_balance::text,frozen_balance::text) ORDER BY user_id) FROM public.wallets");
  const counts=await rows(db,'SELECT user_id,count(*)::int AS n FROM public.wallet_reconciliation_audit GROUP BY user_id');
  await db.query(`INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names) VALUES(pg_current_xact_id(),$1,ARRAY['public.wallet_balance_baselines','public.wallet_reconciliation_queue'])`,[task.job_id]);
  for(const employee of [F.e1,F.e2,F.e3]){const result=await scalar(db,'SELECT public.reconcile_wallet_from_ledger($1)',[employee]);if(employee===F.e2)assert.equal(result.baseline_created,true);else assert.equal(result.repaired,false);}
  await db.exec('SELECT private.employee_transfer_clear_write_permit()');assert.deepEqual(await scalar(db,"SELECT jsonb_agg(jsonb_build_array(user_id,available_balance::text,frozen_balance::text) ORDER BY user_id) FROM public.wallets"),before);
  assert.deepEqual(await rows(db,'SELECT user_id,count(*)::int AS n FROM public.wallet_reconciliation_audit GROUP BY user_id'),counts);
}));
