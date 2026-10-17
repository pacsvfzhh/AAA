import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createSites, adminLogin, rpc as baseRpc, scalar, rows } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, OLD, PASSWORDS } from './support/transfer-fixtures.mjs';

const keys = ['admins','financial_admin_credentials','admin_groups','admin_group_members','admin_configs','system_configs','history_cleanup_config'];
const hash = text => createHash('sha256').update(text).digest('hex');
const groupId = randomUUID();
const memberId = randomUUID();
let oldSite;
let db;
let session;
let branchSession;
let pkg;
let stream;

before(async () => {
  ({ oldSite, newSite: db } = await createSites());
  await db.query('UPDATE private.employee_transfer_site SET site_id = $1', [randomUUID()]);
  await buildNewSite(db);
  for (const [id,name,role] of [[OLD.root,'source-root','super_admin'],[OLD.branch,'source-branch','secondary_admin'],[OLD.emergency,'source-emergency','emergency_admin']]) {
    await oldSite.query(`INSERT INTO public.admins (id,username,password_hash,role,parent_id)
      VALUES ($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4,$5)`,
    [id,name,PASSWORDS.root,role,id === OLD.root ? null : OLD.root]);
    await oldSite.query(`INSERT INTO public.financial_admin_credentials (admin_id,password_hash)
      VALUES ($1,extensions.crypt($2,extensions.gen_salt('bf',4)))`, [id,PASSWORDS.root]);
  }
  await oldSite.query('INSERT INTO public.admin_groups (id,name,created_by) VALUES ($1,$2,$3)', [groupId,'source-group',OLD.root]);
  await oldSite.query('INSERT INTO public.admin_group_members (id,group_id,admin_id) VALUES ($1,$2,$3)', [memberId,groupId,OLD.branch]);
  await oldSite.query(`INSERT INTO public.admin_configs (admin_id,config_type,config_value) VALUES ($1,'company_name','source brand')`, [OLD.branch]);
  session = await adminLogin(db,'root',PASSWORDS.root);
  branchSession = await adminLogin(db,'branch',PASSWORDS.branch);
  const oldSession = await adminLogin(oldSite,'source-root',PASSWORDS.root);
  const exported = await baseRpc(oldSite,'employee_export_shared_begin',{p_admin_session_token:oldSession,p_admin_password:PASSWORDS.root});
  const texts = {};
  for (const key of keys) {
    texts[key] = '';
    let after = null;
    do {
      const page = await baseRpc(oldSite,'get_employee_export_shared_page',{p_admin_session_token:oldSession,
        p_job_token:exported.job_token,p_table_key:key,p_after:after,p_limit:2});
      texts[key] += page.ndjson;
      after = page.next_after;
    } while (after !== null);
  }
  await baseRpc(oldSite,'employee_export_shared_verify',{p_admin_session_token:oldSession,p_job_token:exported.job_token});
  pkg = { catalog:exported.catalog,texts,packageId:randomUUID() };
  const compiled = await build({ entryPoints:[fileURLToPath(new URL('../../src/lib/employeeTransfer/sharedImport.ts',import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'browser',target:'es2020' });
  stream = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
}, { timeout:180000 });
after(async () => { await Promise.all([oldSite?.close(),db?.close()]); });

async function transaction(fn) {
  await db.exec('BEGIN');
  try { await fn(); } finally { await db.exec('ROLLBACK'); }
}
async function rpc(name,args) {
  await db.exec('SAVEPOINT import_rpc');
  try {
    await db.exec('SET LOCAL ROLE anon');
    const value = await baseRpc(db,name,args,{role:null});
    await db.exec('RESET ROLE; RELEASE SAVEPOINT import_rpc');
    return value;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT import_rpc; RELEASE SAVEPOINT import_rpc');
    throw error;
  }
}
const auth = job => ({p_admin_session_token:session,p_job_token:job.job_token});
async function begin(input = pkg, token = session, password = PASSWORDS.root) {
  return rpc('employee_import_shared_begin',{p_admin_session_token:token,p_admin_password:password,
    p_package_id:input.packageId,p_catalog:input.catalog});
}
const stage = (job,key,chunkNo,text) => rpc('employee_import_shared_stage',{
  ...auth(job),p_table_key:key,p_chunk_no:chunkNo,p_ndjson:text,
});
const dryRun = job => rpc('get_employee_import_shared_dry_run',auth(job));
const apply = (job,plan) => rpc('employee_import_shared_apply',{...auth(job),p_plan_hash:plan.plan_hash});
async function stageAll(job,input = pkg) {
  for (const key of keys) await stage(job,key,0,input.texts[key]);
}
function changed(key,mutate) {
  const result = structuredClone(pkg);
  let values = result.texts[key].trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
  values = mutate(values) ?? values;
  result.texts[key] = values.map(row => JSON.stringify(row)+'\n').join('');
  const entry = result.catalog.tables.find(item => item.key === key);
  entry.rows = values.length;
  entry.bytes = Buffer.byteLength(result.texts[key]);
  entry.sha256 = hash(result.texts[key]);
  return result;
}
async function prepared(input = pkg) {
  const job = await begin(input);
  assert.equal(job.success,true);
  await stageAll(job,input);
  return {job,plan:await dryRun(job)};
}

test('real old-site export imports non-root identities and shared settings atomically without changing target root', async () => transaction(async () => {
  const root = await scalar(db,'SELECT to_jsonb(admin) FROM public.admins AS admin WHERE id=$1',[NEW.root]);
  const rootCredential = await scalar(db,'SELECT to_jsonb(credential) FROM public.financial_admin_credentials AS credential WHERE admin_id=$1',[NEW.root]);
  const retention = await rows(db,'SELECT * FROM public.history_cleanup_config ORDER BY table_name');
  const {job,plan} = await prepared();
  assert.equal(plan.scope,'shared-settings');
  assert.equal(plan.full_site_complete,false);
  assert.equal(plan.can_apply,true,JSON.stringify(plan.conflicts));
  assert.equal(plan.admins.find(row => row.source_id===OLD.root).target_id,NEW.root);
  assert.doesNotMatch(JSON.stringify(plan),/password_hash|\$2[aby]\$/);
  const receipt = await apply(job,plan);
  assert.equal(receipt.success,true);
  assert.equal(receipt.created_admins,2);
  assert.equal(receipt.admin_map[OLD.root],NEW.root);
  assert.equal(receipt.full_site_complete,false);
  for (const id of [OLD.branch,OLD.emergency]) {
    const result = await rows(db,'SELECT * FROM public.admins WHERE id=$1',[id]);
    assert.equal(result[0].is_active,false);
    assert.equal(result[0].parent_id,NEW.root);
    assert.equal(result[0].role,id===OLD.branch?'secondary_admin':'emergency_admin');
    assert.equal(result[0].password_hash,await scalar(oldSite,'SELECT password_hash FROM public.admins WHERE id=$1',[id]));
    assert.equal(await scalar(db,'SELECT password_hash FROM public.financial_admin_credentials WHERE admin_id=$1',[id]),
      await scalar(oldSite,'SELECT password_hash FROM public.financial_admin_credentials WHERE admin_id=$1',[id]));
  }
  assert.deepEqual(await scalar(db,'SELECT to_jsonb(admin) FROM public.admins AS admin WHERE id=$1',[NEW.root]),root);
  assert.deepEqual(await scalar(db,'SELECT to_jsonb(credential) FROM public.financial_admin_credentials AS credential WHERE admin_id=$1',[NEW.root]),rootCredential);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admins WHERE id=$1',[OLD.root]),0);
  assert.equal(await scalar(db,'SELECT created_by FROM public.admin_groups WHERE id=$1',[groupId]),NEW.root);
  assert.equal(await scalar(db,'SELECT admin_id FROM public.admin_group_members WHERE id=$1',[memberId]),OLD.branch);
  assert.equal(await scalar(db,"SELECT config_value FROM public.admin_configs WHERE admin_id=$1 AND config_type='company_name'",[OLD.branch]),'source brand');
  assert.deepEqual(await rows(db,'SELECT * FROM public.history_cleanup_config ORDER BY table_name'),retention);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admin_financial_sessions WHERE admin_id IN ($1,$2)',[OLD.branch,OLD.emergency]),0);
  const count = await scalar(db,'SELECT count(*)::int FROM public.admins');
  assert.equal((await apply(job,plan)).repeated,true);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admins'),count);
  const login = await rpc('create_admin_financial_session',{p_username:'source-branch',p_password:PASSWORDS.root});
  assert.equal(login.success,false,'imported administrators must remain unable to operate before full verification');
}));

test('two-pass streaming import sends actual chunks and stops at dry-run without creating any business rows', async () => transaction(async () => {
  let job;
  const files = { async *open(key) {
    const bytes = Buffer.from(pkg.texts[key]);
    for (let at=0;at<bytes.length;at+=7) yield bytes.subarray(at,at+7);
  } };
  const target = {
    async begin(catalog) {
      job = await begin({...pkg,catalog});
      return {success:true,scope:'shared-settings',full_site_complete:false};
    },
    stage:(key,no,text) => stage(job,key,no,text),
    dryRun:() => dryRun(job),
  };
  const result = await stream.stageSharedSettingsImport(pkg.catalog,files,target);
  assert.equal(result.dryRun.can_apply,true);
  assert.equal(result.fullSiteComplete,false);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admins WHERE id=$1',[OLD.branch]),0);
}));

test('wrong passwords, same-site imports, non-super sessions and malformed catalogs cannot start a task', async () => transaction(async () => {
  for (const token of [randomUUID(),branchSession]) await assert.rejects(begin(pkg,token),/permission|session/i);
  assert.equal((await begin(pkg,session,'wrong-password')).success,false);
  const same = structuredClone(pkg);
  same.catalog.site_id=await scalar(db,'SELECT site_id FROM private.employee_transfer_site');
  await assert.rejects(begin(same),/same site/);
  for (const mutate of [
    c=>{c.full_site_complete=true;}, c=>{c.tables.pop();}, c=>{c.tables[0].key='admin_financial_sessions';},
    c=>{c.tables[1]={...c.tables[0]};}, c=>{c.tables[0].bytes=8388609;}, c=>{c.tables[0].sha256='bad';},
    c=>{c.excluded_system_keys=['unknown'];}, c=>{c.token='untrusted';},
  ]) {
    const input=structuredClone(pkg); mutate(input.catalog);
    await assert.rejects(begin(input),/catalog|descriptor|excluded|limits/i);
  }
  assert.equal(await scalar(db,"SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'"),0);
}));

test('staged chunk receipts are content-bound and repeated chunks do not inflate progress or totals', async () => transaction(async () => {
  const job=await begin();
  const original=await stage(job,'admins',0,pkg.texts.admins);
  assert.equal(original.repeated,false);
  assert.equal(original.sha256,hash(pkg.texts.admins));
  assert.equal(original.bytes,Buffer.byteLength(pkg.texts.admins));
  const repeated=await stage(job,'admins',0,pkg.texts.admins);
  assert.equal(repeated.repeated,true);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1',[job.job_id]),1);
  await assert.rejects(stage(job,'admins',0,pkg.texts.admins.replace('source-branch','source-branch2')),/different contents/);
  await assert.rejects(stage(job,'admins',1,pkg.texts.admins),/catalog totals/);
  await assert.rejects(dryRun(job),/incomplete/);
}));

test('missing chunks, changed table hash, reordered rows and duplicate JSON keys cannot pass input verification', async () => transaction(async () => {
  const job=await begin();
  for (const text of ['{"a":1,"a":2}\n','{"a":{"x":1,"x":2}}\n','not-json\n','[]\n']) {
    await assert.rejects(stage(job,'admins',0,text),/JSON row/);
  }
  await assert.rejects(stage(job,'admins',0,'{}'),/chunk/);
  await assert.rejects(stage(job,'admins',10001,'{}\n'),/chunk/);
  await assert.rejects(stage(job,'admin_financial_sessions',0,''),/chunk/);
  await stage(job,'admins',1,pkg.texts.admins);
  for (const key of keys.slice(1)) await stage(job,key,0,pkg.texts[key]);
  await assert.rejects(dryRun(job),/incomplete/);
}));

for (const [name,change] of [
  ['source super credentials', input=>changed('admins',items=>{items.find(i=>i.role==='super_admin').password_hash='forbidden';})],
  ['unknown account field', input=>changed('admins',items=>{items[0].session_token='forbidden';})],
  ['missing credential', input=>changed('financial_admin_credentials',items=>items.slice(1))],
  ['invalid role', input=>changed('admins',items=>{items.find(i=>i.id===OLD.branch).role='owner';})],
  ['relative timestamp', input=>changed('admins',items=>{items[0].created_at='today';})],
  ['parent cycle', input=>changed('admins',items=>{items.find(i=>i.id===OLD.branch).parent_id=OLD.emergency;items.find(i=>i.id===OLD.emergency).parent_id=OLD.branch;})],
  ['missing parent', input=>changed('admins',items=>{items.find(i=>i.id===OLD.branch).parent_id=randomUUID();})],
  ['duplicate identity', input=>changed('admins',items=>[...items,items[0]])],
  ['extra credential owner', input=>changed('financial_admin_credentials',items=>{items[0].admin_id=OLD.root;})],
  ['unknown setting key', input=>changed('system_configs',items=>[...items,{key:'endpoint',value:{secret:'local-sensitive'}}])],
  ['foreign group owner', input=>changed('admin_groups',items=>{items[0].created_by=randomUUID();})],
  ['foreign group member', input=>changed('admin_group_members',items=>{items[0].group_id=randomUUID();})],
  ['invalid admin setting', input=>changed('admin_configs',items=>{items[0].config_type='endpoint';})],
]) {
  test(`invalid source ${name} is rejected without writing accounts or leaking credentials`,async()=>transaction(async()=>{
    const input=change(pkg);
    const job=await begin(input);
    await stageAll(job,input);
    await assert.rejects(dryRun(job),error=>{
      assert.match(error.message,/Invalid|missing|credentials|cycle|Duplicate|relationship|identities/i);
      assert.doesNotMatch(error.message,/\$2[aby]\$|local-sensitive|forbidden/);
      return true;
    });
    assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admins WHERE id=$1',[OLD.branch]),0);
  }));
}

test('existing administrator names and IDs block instead of changing credentials, roles, activity or existing automation',async()=>transaction(async()=>{
  const input=changed('admins',items=>{items.find(i=>i.id===OLD.branch).username='branch';});
  const {job,plan}=await prepared(input);
  assert.equal(plan.can_apply,false);
  assert.ok(plan.conflicts.some(i=>i.reason==='administrator_identity_conflict'));
  const before=await scalar(db,'SELECT to_jsonb(admin) FROM public.admins AS admin WHERE id=$1',[NEW.branch]);
  await assert.rejects(apply(job,plan),/conflicts/);
  assert.deepEqual(await scalar(db,'SELECT to_jsonb(admin) FROM public.admins AS admin WHERE id=$1',[NEW.branch]),before);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admins WHERE id=$1',[OLD.branch]),0);
}));

test('target employees with the incoming administrator username are not deleted or renamed',async()=>transaction(async()=>{
  await db.query(`INSERT INTO public.users (username,password_hash,employee_id,created_by) VALUES ('source-branch','fixture-hash','TEST-MIGRATION-USER',$1)`,[NEW.root]);
  const {job,plan}=await prepared();
  assert.ok(plan.conflicts.some(i=>i.reason==='username_matches_employee'));
  await assert.rejects(apply(job,plan),/conflicts/);
  assert.equal(await scalar(db,"SELECT count(*)::int FROM public.users WHERE username='source-branch'"),1);
}));

test('changed global settings and retention policies block rather than overwriting target values or enabling cleanup',async()=>transaction(async()=>{
  const input=changed('system_configs',items=>{items.find(i=>i.key==='login_title').value='A different source title';});
  const {job,plan}=await prepared(input);
  assert.ok(plan.conflicts.some(i=>i.table_key==='system_configs' && i.reason==='target_content_conflict'));
  await assert.rejects(apply(job,plan),/conflicts/);
  await rpc('employee_transfer_cancel',auth(job));
  const retention=changed('history_cleanup_config',items=>{items[0].retention_days+=100;items[0].auto_cleanup_enabled=!items[0].auto_cleanup_enabled;});
  const second=await prepared(retention);
  assert.ok(second.plan.conflicts.some(i=>i.table_key==='history_cleanup_config'));
  await assert.rejects(apply(second.job,second.plan),/conflicts/);
}));

test('unmapped media cannot be silently reused',async()=>transaction(async()=>{
  const input=changed('admin_configs',items=>{items[0].icon_custom_url='https://source.invalid/storage/v1/object/public/website-icons/a.png';});
  const {job,plan}=await prepared(input);
  assert.ok(plan.conflicts.some(i=>i.reason==='media_rewrite_required'));
  await assert.rejects(apply(job,plan),/conflicts/);
}));

test('natural-key reuse never hides an incoming setting ID occupied by another setting',async()=>transaction(async()=>{
  const occupied=randomUUID();
  await db.query(`INSERT INTO public.admin_configs (id,admin_id,config_type,config_value) VALUES ($1,$2,'company_name','target brand')
    ON CONFLICT (admin_id,config_type) DO UPDATE SET id=EXCLUDED.id,config_value=EXCLUDED.config_value`,[occupied,NEW.root]);
  await db.query(`INSERT INTO public.admin_configs (admin_id,config_type,config_value) VALUES ($1,'theme','dark')
    ON CONFLICT (admin_id,config_type) DO UPDATE SET config_value=EXCLUDED.config_value`,[NEW.root]);
  const input=changed('admin_configs',items=>{items[0].id=occupied;items[0].admin_id=OLD.root;items[0].config_type='theme';items[0].config_value='dark';});
  const {job,plan}=await prepared(input);
  assert.equal(plan.can_apply,false);
  assert.ok(plan.conflicts.some(item=>item.reason==='setting_id_conflict'));
  await assert.rejects(apply(job,plan),/conflicts/);
}));

test('changed or disabled approved media guards block import instead of silently weakening protection',async()=>transaction(async()=>{
  const {job,plan}=await prepared();
  await db.exec('ALTER TABLE public.admin_configs DISABLE TRIGGER guard_employee_chat_image_reference');
  await assert.rejects(apply(job,plan),/unreviewed INSERT trigger/);
  await db.exec('ALTER TABLE public.admin_configs ENABLE TRIGGER guard_employee_chat_image_reference');
  await db.exec(`CREATE OR REPLACE FUNCTION private.guard_employee_chat_image_reference() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,public,private,pg_temp AS $$ BEGIN RETURN NEW; END; $$`);
  await assert.rejects(apply(job,plan),/unreviewed INSERT trigger/);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admins WHERE id=$1',[OLD.branch]),0);
}));

test('apply requires the server-recorded dry run and rechecks changed target contents under table locks',async()=>transaction(async()=>{
  const job=await begin(); await stageAll(job);
  await assert.rejects(apply(job,{plan_hash:'a'.repeat(64)}),/dry run/);
  const plan=await dryRun(job);
  await assert.rejects(apply(job,{plan_hash:'b'.repeat(64)}),/dry run/);
  await db.query(`INSERT INTO public.admins (username,password_hash,role) VALUES ('source-branch','fixture-hash','secondary_admin')`);
  await assert.rejects(apply(job,plan),/target changed/);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admins WHERE id=$1',[OLD.emergency]),0);
}));

test('unknown INSERT triggers are rejected, and a database constraint failure rolls back all new accounts',async()=>transaction(async()=>{
  const {job,plan}=await prepared();
  await db.exec(`CREATE FUNCTION public.fixture_shared_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
    CREATE TRIGGER fixture_shared_insert BEFORE INSERT ON public.admin_configs FOR EACH ROW EXECUTE FUNCTION public.fixture_shared_insert();`);
  await assert.rejects(apply(job,plan),/unreviewed INSERT trigger/);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admins WHERE id=$1',[OLD.branch]),0);
  await db.exec('DROP TRIGGER fixture_shared_insert ON public.admin_configs');
  await db.exec(`ALTER TABLE public.admin_configs ADD CONSTRAINT fixture_import_failure CHECK (config_value <> 'source brand')`);
  await assert.rejects(apply(job,plan),error=>{
    assert.match(error.message,/rolled back by a target constraint/);
    assert.doesNotMatch(JSON.stringify(error),/\$2[aby]\$|source brand|fixture_import_failure/);
    return true;
  });
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.admins WHERE id=$1',[OLD.branch]),0);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.financial_admin_credentials WHERE admin_id=$1',[OLD.branch]),0);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM private.employee_transfer_events WHERE job_id=$1 AND action=\'shared_applied\'',[job.job_id]),0);
}));

test('shared task tokens cannot call old employee writers or mark the whole import finished',async()=>transaction(async()=>{
  const {job,plan}=await prepared();
  for (const [name,args] of [
    ['employee_import_finish',{p_summary:{full_site_complete:true}}],
    ['employee_import_apply_roles',{p_decisions:[]}],
    ['employee_import_stage_chunk',{p_employee_id:randomUUID(),p_table_key:'account',p_chunk_no:0,p_rows:[]}],
    ['employee_import_apply_core',{p_employee_id:randomUUID(),p_expected:{}}],
    ['employee_import_rows_batch',{p_employee_id:randomUUID(),p_table_key:'orders',p_rows:[]}],
  ]) await assert.rejects(rpc(name,{...auth(job),...args}),/protocol/);
  await apply(job,plan);
  await assert.rejects(stage(job,'admins',0,pkg.texts.admins),/already been applied/);
  await assert.rejects(dryRun(job),/already been applied/);
  assert.equal(await scalar(db,'SELECT status FROM private.employee_transfer_jobs WHERE id=$1',[job.job_id]),'running');
  const events=await rows(db,'SELECT details FROM private.employee_transfer_events WHERE job_id=$1',[job.job_id]);
  assert.doesNotMatch(JSON.stringify(events),/password_hash|RootPass|job_token|\$2[aby]\$/);
}));

test('cancel leaves committed imported accounts disabled, clears private staging, and revokes task access',async()=>transaction(async()=>{
  const {job,plan}=await prepared(); await apply(job,plan);
  await rpc('employee_transfer_cancel',auth(job));
  assert.equal(await scalar(db,'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1',[job.job_id]),0);
  assert.equal(await scalar(db,'SELECT is_active FROM public.admins WHERE id=$1',[OLD.branch]),false);
  await assert.rejects(dryRun(job),/invalid or expired/);
}));
