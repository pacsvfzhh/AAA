import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSites, adminLogin, rpc as baseRpc, scalar, rows } from './support/transfer-harness.mjs';
import { buildNewSite, OLD, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

const migration = '20261102000007_replace_shared_site_settings.sql';
const keys = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = Object.fromEntries(['sourceGroup', 'sourceEmpty', 'sourceNew', 'targetGroup', 'targetEmpty',
  'foreignGroup', 'keepGroup', 'keepAdmin', 'otherRoot', 'sourceMember', 'sourceRootMember', 'sourceNewMember']
  .map(key => [key, randomUUID()]));
const sourceTime = '2024-03-04T05:06:07Z';
let oldSite;
let db;
let session;
let branchSession;
let otherSession;
let pkg;
let backupModule;
let containerModule;
let targetOnlySetting;

async function compile(name) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../../src/lib/employeeTransfer/${name}.ts`, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020',
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

async function putSetting(site, adminId, type, value) {
  const existing = await rows(site, `SELECT id FROM public.admin_configs
    WHERE admin_id IS NOT DISTINCT FROM $1::uuid AND config_type=$2 ORDER BY id`, [adminId, type]);
  assert.ok(existing.length <= 1, `fixture setting ${type} must be unambiguous`);
  const id = existing[0]?.id ?? randomUUID();
  await site.query(`INSERT INTO public.admin_configs
    (id,admin_id,config_type,config_value,icon_type,icon_custom_url,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'default',NULL,$5,$5)
    ON CONFLICT(id) DO UPDATE SET config_value=EXCLUDED.config_value,icon_type=EXCLUDED.icon_type,
      icon_custom_url=NULL,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at`,
  [id, adminId, type, value, sourceTime]);
  return id;
}

before(async () => {
  const sites = await createSites({ upTo: migration });
  oldSite = sites.oldSite;
  db = sites.newSite;
  assert.ok(sites.files.includes(migration), 'the replacement migration must actually replay');
  assert.equal(sites.validation.freshDatabaseVerified, false, 'known historical replay gaps remain explicit');
  // dump clones share the original site identity; model two independent sites explicitly.
  await db.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  for (const [id, name, role, password] of [[OLD.root, 'root', 'super_admin', PASSWORDS.root],
    [OLD.branch, 'branch', 'secondary_admin', PASSWORDS.branch],
    [OLD.emergency, 'emergency', 'emergency_admin', PASSWORDS.emergency]]) {
    await oldSite.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES ($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4,true)`, [id, name, password, role]);
    await oldSite.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
      VALUES ($1,extensions.crypt($2,extensions.gen_salt('bf',4)))`, [id, password]);
  }
  await buildNewSite(db);
  await oldSite.query(`UPDATE public.admins SET role='emergency_admin',parent_id=$2,is_pinned=true,
    created_at=$3,updated_at=$3 WHERE id=$1`, [OLD.branch, OLD.root, sourceTime]);
  await oldSite.query(`UPDATE public.admins SET role='secondary_admin',parent_id=$2,is_active=NULL,
    is_pinned=NULL,created_at=NULL,updated_at=NULL WHERE id=$1`, [OLD.emergency, OLD.branch]);
  await oldSite.query(`UPDATE public.financial_admin_credentials SET
    password_hash=extensions.crypt($2,extensions.gen_salt('bf',4)),created_at=$3,updated_at=$3
    WHERE admin_id IN ($1,$4)`, [OLD.branch, PASSWORDS.root, sourceTime, OLD.emergency]);
  for (const [id, name, role] of [[ids.keepAdmin, 'target-only', 'secondary_admin'], [ids.otherRoot, 'other-root', 'super_admin']]) {
    await db.query(`INSERT INTO public.admins(id,username,password_hash,role,parent_id)
      VALUES ($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4,$5)`,
    [id, name, PASSWORDS.root, role, role === 'super_admin' ? null : NEW.root]);
    await db.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
      VALUES ($1,extensions.crypt($2,extensions.gen_salt('bf',4)))`, [id, PASSWORDS.root]);
  }
  await db.query(`INSERT INTO public.users(username,password_hash,employee_id,created_by)
    VALUES ('target-only-employee','fixture-only-hash','REPLACE-KEEP',$1)`, [NEW.branch]);
  for (const [site, groups] of [
    [oldSite, [[ids.sourceGroup, 'shared group', OLD.branch], [ids.sourceEmpty, 'empty group', OLD.root],
      [ids.sourceNew, 'new source group', OLD.root]]],
    [db, [[ids.targetGroup, 'shared group', NEW.branch], [ids.targetEmpty, 'empty group', NEW.root],
      [ids.foreignGroup, 'shared group', NEW.root], [ids.keepGroup, 'target-only group', NEW.root]]],
  ]) {
    for (const [id, name, owner] of groups) await site.query(`INSERT INTO public.admin_groups
      (id,name,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)`, [id, name, owner, sourceTime]);
  }
  for (const [id, group, admin] of [[ids.sourceMember, ids.sourceGroup, OLD.branch],
    [ids.sourceRootMember, ids.sourceGroup, OLD.root], [ids.sourceNewMember, ids.sourceNew, OLD.emergency]]) {
    await oldSite.query(`INSERT INTO public.admin_group_members(id,group_id,admin_id,created_at)
      VALUES ($1,$2,$3,$4)`, [id, group, admin, sourceTime]);
  }
  for (const [group, admins] of [[ids.targetGroup, [NEW.branch, NEW.emergency, ids.keepAdmin]],
    [ids.targetEmpty, [NEW.branch, NEW.emergency]], [ids.foreignGroup, [ids.keepAdmin]],
    [ids.keepGroup, [NEW.root, NEW.emergency]]]) {
    for (const admin of admins) await db.query(`INSERT INTO public.admin_group_members(group_id,admin_id)
      VALUES ($1,$2)`, [group, admin]);
  }
  for (const [sourceOwner, targetOwner, type, source, target] of [
    [OLD.branch, NEW.branch, 'company_name', 'source brand', 'target brand'],
    [OLD.root, NEW.root, 'theme', 'source_theme', 'target_theme'],
    [null, null, 'company_name', 'source global brand', 'target global brand'],
  ]) {
    await putSetting(oldSite, sourceOwner, type, source);
    await putSetting(db, targetOwner, type, target);
  }
  targetOnlySetting = await putSetting(db, ids.keepAdmin, 'company_name', 'keep target brand');
  await oldSite.query(`INSERT INTO public.system_configs(key,value) VALUES ('login_title','"Source title"')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
  await db.query(`INSERT INTO public.system_configs(key,value) VALUES ('login_title','"Target title"')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
  session = await adminLogin(db, 'root', PASSWORDS.root);
  branchSession = await adminLogin(db, 'branch', PASSWORDS.branch);
  await adminLogin(db, 'emergency', PASSWORDS.emergency);
  await adminLogin(db, 'target-only', PASSWORDS.root);
  otherSession = await adminLogin(db, 'other-root', PASSWORDS.root);
  // A previously revoked session must retain its original revocation timestamp.
  await db.query(`INSERT INTO public.admin_financial_sessions(admin_id,token_hash,expires_at,revoked_at)
    VALUES ($1,$2,now()+interval '1 day','2025-01-02T00:00:00Z')`, [NEW.branch, hash(randomUUID())]);
  const sourceSession = await adminLogin(oldSite, 'root', PASSWORDS.root);
  const exported = await baseRpc(oldSite, 'employee_export_shared_begin', {
    p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
  });
  assert.equal(exported.success, true);
  const texts = {};
  for (const key of keys) {
    texts[key] = '';
    let after = null;
    do {
      const page = await baseRpc(oldSite, 'get_employee_export_shared_page', {
        p_admin_session_token: sourceSession, p_job_token: exported.job_token,
        p_table_key: key, p_after: after, p_limit: 2,
      });
      assert.equal(page.sha256, hash(page.ndjson));
      texts[key] += page.ndjson;
      after = page.next_after;
    } while (after !== null);
    const table = exported.catalog.tables.find(item => item.key === key);
    assert.equal(hash(texts[key]), table.sha256);
    assert.equal(Buffer.byteLength(texts[key]), table.bytes);
  }
  const verified = await baseRpc(oldSite, 'employee_export_shared_verify', {
    p_admin_session_token: sourceSession, p_job_token: exported.job_token,
  });
  assert.equal(verified.verified, true);
  pkg = { catalog: exported.catalog, texts, packageId: randomUUID() };
  [backupModule, containerModule] = await Promise.all([compile('replacementBackup'), compile('container')]);
}, { timeout: 180000 });
after(async () => { await Promise.all([oldSite?.close(), db?.close()]); });

async function transaction(fn) {
  await db.exec('BEGIN');
  try { await fn(); } finally { await db.exec('ROLLBACK'); }
}
// SAVEPOINT keeps expected RPC failures from aborting the fixture transaction.
async function asRole(role, fn) {
  await db.exec('SAVEPOINT replace_rpc');
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    const result = await fn();
    await db.exec('RESET ROLE; RELEASE SAVEPOINT replace_rpc');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT replace_rpc; RELEASE SAVEPOINT replace_rpc');
    throw error;
  }
}
const rpc = (name, args) => asRole('anon', () => baseRpc(db, name, args, { role: null }));
const auth = (job, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
const begin = (input = pkg, token = session, password = PASSWORDS.root, name = 'employee_import_shared_replace_begin') =>
  rpc(name, { p_admin_session_token: token, p_admin_password: password, p_package_id: input.packageId, p_catalog: input.catalog });
const stage = (job, key, text, chunk = 0) => rpc('employee_import_shared_stage', {
  ...auth(job), p_table_key: key, p_chunk_no: chunk, p_ndjson: text,
});
const dryRun = job => rpc('get_employee_import_shared_replace_dry_run', auth(job));
const descriptor = job => rpc('get_employee_import_shared_backup', auth(job));
const page = (job, key, after = null, limit = 2) => rpc('get_employee_import_shared_backup_page', {
  ...auth(job), p_table_key: key, p_after: after, p_limit: limit,
});
const append = (job, plan, no, bytes) => rpc('employee_import_shared_backup_append', {
  ...auth(job), p_plan_hash: plan.plan_hash, p_chunk_no: no, p_hex: bytes.toString('hex'),
});
const seal = (job, plan, bytes, sha256 = hash(bytes), length = bytes.length) => rpc('employee_import_shared_backup_seal', {
  ...auth(job), p_plan_hash: plan.plan_hash, p_sha256: sha256, p_bytes: length,
});
const apply = (job, plan) => rpc('employee_import_shared_replace_apply', { ...auth(job), p_plan_hash: plan.plan_hash });
const cancel = (job, token = session) => rpc('employee_transfer_cancel', auth(job, token));
const saved = (backupId, no = 0, token = session) => rpc('get_employee_shared_saved_backup_chunk', {
  p_admin_session_token: token, p_backup_id: backupId, p_chunk_no: no,
});
const values = (input, key) => input.texts[key].trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
function changed(key, mutate, base = pkg) {
  const input = structuredClone(base);
  let items = values(input, key);
  items = mutate(items) ?? items;
  input.texts[key] = items.map(item => JSON.stringify(item) + '\n').join('');
  Object.assign(input.catalog.tables.find(item => item.key === key), {
    rows: items.length, bytes: Buffer.byteLength(input.texts[key]), sha256: hash(input.texts[key]),
  });
  return input;
}
function remapSourceAdmin(input, sourceId, replacementId, username) {
  let result = changed('admins', items => {
    const admin = items.find(item => item.id === sourceId);
    admin.id = replacementId;
    if (username !== undefined) admin.username = username;
    for (const item of items) if (item.parent_id === sourceId) item.parent_id = replacementId;
  }, input);
  for (const [key, field] of [['financial_admin_credentials', 'admin_id'], ['admin_groups', 'created_by'],
    ['admin_group_members', 'admin_id'], ['admin_configs', 'admin_id']]) {
    result = changed(key, items => { for (const item of items) if (item[field] === sourceId) item[field] = replacementId; }, result);
  }
  return result;
}
function remapSourceGroup(input, sourceId, replacementId, name) {
  const result = changed('admin_groups', items => {
    const group = items.find(item => item.id === sourceId);
    group.id = replacementId;
    if (name !== undefined) group.name = name;
  }, input);
  return changed('admin_group_members', items => {
    for (const item of items) if (item.group_id === sourceId) item.group_id = replacementId;
  }, result);
}
async function stageAll(job, input = pkg) {
  for (const key of keys) await stage(job, key, input.texts[key]);
}
async function prepared(input = pkg) {
  const job = await begin(input);
  assert.equal(job.success, true);
  await stageAll(job, input);
  return { job, plan: await dryRun(job) };
}
function applicable(plan) {
  assert.equal(plan.can_apply, true, JSON.stringify(plan.conflicts));
}
// Invalid ciphertext tests only server hash gates; the disk test verifies real encryption.
const gateCipher = () => Buffer.concat([Buffer.from('EDXSTRM1'), Buffer.alloc(88, 0xa5)]);
async function gateBackup(job, plan) {
  applicable(plan);
  const bytes = gateCipher();
  await append(job, plan, 0, bytes);
  const receipt = await seal(job, plan, bytes);
  assert.equal(receipt.success, true);
  return bytes;
}
async function businessState() {
  const result = {};
  for (const table of [...keys, 'admin_financial_sessions', 'users', 'notification_automation_plans']) {
    result[table] = await scalar(db, `SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY to_jsonb(item)::text),'[]')
      FROM public.${table} AS item`);
  }
  return result;
}
const jobState = job => scalar(db, `SELECT jsonb_build_object('summary',summary,'admin_map',admin_map,
  'default_admin_id',default_admin_id,'status',status) FROM private.employee_transfer_jobs WHERE id=$1`, [job.job_id]);
const events = job => rows(db, 'SELECT action,details FROM private.employee_transfer_events WHERE job_id=$1 ORDER BY id', [job.job_id]);
const backupState = job => scalar(db, 'SELECT to_jsonb(backup) FROM private.employee_transfer_shared_backups AS backup WHERE id=$1', [job.job_id]);
const backupCount = job => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]);
const stagingState = job => rows(db, 'SELECT to_jsonb(staged) AS value FROM private.employee_transfer_staging AS staged WHERE job_id=$1 ORDER BY table_key,chunk_no', [job.job_id]);
// Public dry-run deliberately hides records; inspect the real STABLE SQL plan without granting browser access.
async function readonlyReplacementPlan(job) {
  await db.exec('SAVEPOINT readonly_replace_plan; SET LOCAL transaction_read_only=on');
  try {
    return await scalar(db, `SELECT private.employee_transfer_shared_replace_plan(task,
      private.employee_transfer_shared_import_data(task)) FROM private.employee_transfer_jobs AS task WHERE id=$1`, [job.job_id]);
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT readonly_replace_plan; RELEASE SAVEPOINT readonly_replace_plan');
  }
}
async function uploadGateChunks(job, plan, sealed) {
  const bytes = gateCipher();
  await append(job, plan, 0, bytes.subarray(0, 47));
  await append(job, plan, 1, bytes.subarray(47));
  if (sealed) await seal(job, plan, bytes);
  return bytes;
}
async function failTransferEvent(action) {
  await db.exec(`CREATE FUNCTION public.fixture_shared_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action='${action}' THEN RAISE EXCEPTION 'fixture transfer event failure'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER fixture_shared_event_failure BEFORE INSERT ON private.employee_transfer_events
    FOR EACH ROW EXECUTE FUNCTION public.fixture_shared_event_failure()`);
}
const triggerState = () => rows(db, `SELECT relation.relname,trigger.tgname,trigger.tgenabled,pg_get_triggerdef(trigger.oid) AS definition
  FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid=trigger.tgrelid
  WHERE relation.relnamespace='public'::regnamespace AND NOT trigger.tgisinternal ORDER BY relation.relname,trigger.tgname`);

async function* diskSource(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(65521);
    while (true) {
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      yield buffer.subarray(0, bytesRead);
    }
  } finally { await handle.close(); }
}

test('real replacementBackup disk encryption, authenticated rereads, server append/seal and saved-cipher decrypt round trip with independent duplicate globals',
  { timeout: 60000 }, async () => transaction(async () => {
    const fixture = await independentCurrencyFixture([{ config_value: 'USDC' }, { config_value: 'USDC' }]);
    const sourceBefore = await settingState(oldSite);
    const before = await businessState();
    const targetTuples = await rows(db, `SELECT id,ctid::text AS tuple FROM public.admin_configs
      WHERE admin_id IS NULL AND config_type='currency_unit' ORDER BY id`);
    const { job, plan } = await prepared(currencyInput(fixture.source));
    applicable(plan);
    assertCurrencyReuse(await readonlyReplacementPlan(job), fixture);
    const frozen = await descriptor(job);
    assert.equal(frozen.backup_id, job.job_id);
    assert.equal(frozen.plan_hash, plan.plan_hash);
    assert.match(frozen.target_hash, /^[0-9a-f]{64}$/);
    const directory = await mkdtemp(join(tmpdir(), 'shared-replace-db-'));
    try {
      const paths = new Map(keys.map((key, index) => [`data/shared-${key}.ndjson`, join(directory, `plain-${index}`)]));
      const cipherPath = join(directory, 'independent.edx');
      const expected = {};
      let cleanups = 0;
      let opens = 0;
      let verified = false;
      const uploaded = [];
      const phases = [];
      const result = await backupModule.createReplacementBackup(frozen, {
        async catalog() { return (await descriptor(job)).catalog; },
        async page(key, after) {
          const value = await page(job, key, after);
          expected[key] = (expected[key] ?? '') + value.ndjson;
          return value;
        },
        async verify() {
          assert.deepEqual(await descriptor(job), frozen);
          assert.deepEqual(await dryRun(job), plan);
          verified = true;
          return { verified: true, scope: 'shared-settings', full_site_complete: false };
        },
      }, {
        async append(path, chunk) {
          const handle = await open(paths.get(path), 'a');
          try { await handle.writeFile(chunk); } finally { await handle.close(); }
        },
        open(path) { return diskSource(paths.get(path)); },
        async abort() { cleanups++; await Promise.all([...paths.values()].map(path => rm(path, { force: true }))); },
      }, {
        async write(source) {
          const handle = await open(cipherPath, 'wx');
          try { for await (const chunk of source) await handle.writeFile(chunk); await handle.sync(); }
          finally { await handle.close(); }
        },
        open() { opens++; return diskSource(cipherPath); },
      }, {
        async append(no, hex) {
          assert.equal(verified, true);
          assert.equal(opens, 2, 'authenticate saved disk bytes before the independent upload reread');
          uploaded.push(Buffer.from(hex, 'hex'));
          return append(job, plan, no, uploaded.at(-1));
        },
        async seal(sha256, bytes) {
          return rpc('employee_import_shared_backup_seal', { ...auth(job), p_plan_hash: plan.plan_hash,
            p_sha256: sha256, p_bytes: bytes });
        },
      }, 'local-db-replacement-backup-passphrase', { onProgress: progress => phases.push(progress.phase) });
      assert.equal(cleanups, 1);
      assert.equal(opens, 2);
      assert.deepEqual([...new Set(phases)], ['snapshot', 'save', 'verify', 'upload', 'seal']);
      const disk = await readFile(cipherPath);
      assert.equal(disk.subarray(0, 8).toString(), 'EDXSTRM1');
      assert.equal(result.cipherSha256, hash(disk));
      assert.equal(result.bytes, disk.length);
      assert.deepEqual(Buffer.concat(uploaded), disk);
      assert.equal(result.sealReceipt.backup_id, frozen.backup_id);
      assert.equal(result.sealReceipt.sha256, hash(disk));
      assert.equal(result.sealReceipt.full_site_complete, false);
      for (const path of paths.values()) await assert.rejects(stat(path), { code: 'ENOENT' });
      const recovered = [];
      for (let no = 0; no < result.chunks; no++) {
        const chunk = await saved(frozen.backup_id, no);
        assert.equal(chunk.chunks, result.chunks);
        assert.equal(chunk.sha256, hash(disk));
        assert.equal(chunk.bytes, disk.length);
        recovered.push(Buffer.from(chunk.hex, 'hex'));
      }
      const serverCipher = Buffer.concat(recovered);
      assert.deepEqual(serverCipher, disk);
      const plain = new Map();
      const manifest = await containerModule.verifyEncryptedVolume((async function* () { yield serverCipher; })(),
        'local-db-replacement-backup-passphrase', {
          async append(path, chunk) { plain.set(path, [...(plain.get(path) ?? []), Buffer.from(chunk)]); },
          async abort() { assert.fail('server-saved real ciphertext must authenticate'); },
        }, { expectedMetadata: { exportId: frozen.backup_id, volumeId: frozen.backup_id } });
      assert.equal(manifest.scope, 'replacement-backup');
      assert.equal(manifest.sourceSiteId, frozen.catalog.site_id);
      assert.equal(manifest.entries.length, 7);
      for (const key of keys) {
        const text = Buffer.concat(plain.get(`data/shared-${key}.ndjson`)).toString();
        assert.equal(text, expected[key]);
        const table = frozen.catalog.tables.find(item => item.key === key);
        assert.equal(hash(text), table.sha256);
        assert.equal(Buffer.byteLength(text), table.bytes);
      }
      assert.equal(values({ texts: expected }, 'admins').find(item => item.id === NEW.branch).password_hash,
        before.admins.find(item => item.id === NEW.branch).password_hash, 'backup contains pre-replacement target fields');
      assert.deepEqual(await businessState(), before, 'backup itself must not apply business changes');
      await db.exec('SAVEPOINT independent_currency_drift');
      try {
        await db.query(`UPDATE public.admin_configs SET config_value='USDT' WHERE id=$1`, [fixture.target[0].id]);
        const drifted = await businessState();
        const task = await jobState(job);
        const audit = await events(job);
        await assert.rejects(apply(job, plan), /target changed/i);
        await assert.rejects(dryRun(job), /target changed/i);
        assert.deepEqual(await businessState(), drifted, 'real sealed backup must not authorize a drifted duplicate set');
        assert.deepEqual(await jobState(job), task);
        assert.deepEqual(await events(job), audit);
        assert.deepEqual(await descriptor(job), frozen);
      } finally {
        await db.exec('ROLLBACK TO SAVEPOINT independent_currency_drift; RELEASE SAVEPOINT independent_currency_drift');
      }
      assert.equal((await apply(job, plan)).success, true, 'real persisted backup unlocks replacement');
      const applied = await businessState();
      assert.deepEqual(applied.admin_configs.filter(isGlobalCurrency), before.admin_configs.filter(isGlobalCurrency),
        'reuse skips both target duplicate rows, including their original timestamps');
      assert.deepEqual(await rows(db, `SELECT id,ctid::text AS tuple FROM public.admin_configs
        WHERE admin_id IS NULL AND config_type='currency_unit' ORDER BY id`), targetTuples,
      'no no-op UPDATE or delete/reinsert of reused target settings');
      assert.deepEqual(await settingState(oldSite), sourceBefore, 'the source database remains read-only');
      await cancel(job);
      assert.deepEqual(await businessState(), applied, 'cancel must not pretend to undo already committed replacement');
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [job.job_id]), 0);
      assert.equal((await saved(frozen.backup_id)).hex, recovered[0].toString('hex'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }));

test('same-name administrators map target IDs and replace both hashes, roles, parents and nulls; super identities/sessions and unrelated rows stay unchanged',
  async () => transaction(async () => {
    const before = await businessState();
    const triggers = await triggerState();
    const { job, plan } = await prepared();
    applicable(plan);
    assert.equal(plan.scope, 'shared-settings');
    assert.equal(plan.full_site_complete, false);
    assert.doesNotMatch(JSON.stringify(plan), /password_hash|\$2[aby]\$|target_hash|source_catalog/);
    for (const [source, target] of [[OLD.root, NEW.root], [OLD.branch, NEW.branch], [OLD.emergency, NEW.emergency]]) {
      assert.equal(plan.admins.find(item => item.source_id === source).target_id, target);
    }
    await gateBackup(job, plan);
    const receipt = await apply(job, plan);
    assert.equal(receipt.success, true);
    assert.equal(receipt.replaced_admins, 2);
    assert.equal(receipt.created_admins, 0);
    assert.equal(receipt.full_site_complete, false);
    assert.deepEqual(receipt.admin_map, { [OLD.root]: NEW.root, [OLD.branch]: NEW.branch, [OLD.emergency]: NEW.emergency });
    for (const [source, target, parent] of [[OLD.branch, NEW.branch, NEW.root], [OLD.emergency, NEW.emergency, NEW.branch]]) {
      const sourceAdmin = await scalar(oldSite, 'SELECT to_jsonb(item) FROM public.admins AS item WHERE id=$1', [source]);
      const targetAdmin = await scalar(db, 'SELECT to_jsonb(item) FROM public.admins AS item WHERE id=$1', [target]);
      assert.deepEqual(targetAdmin, { ...sourceAdmin, id: target, parent_id: parent, is_active: false });
      const sourceCredential = await scalar(oldSite, 'SELECT to_jsonb(item) FROM public.financial_admin_credentials AS item WHERE admin_id=$1', [source]);
      assert.deepEqual(await scalar(db, 'SELECT to_jsonb(item) FROM public.financial_admin_credentials AS item WHERE admin_id=$1', [target]),
        { ...sourceCredential, admin_id: target });
      assert.notEqual(targetAdmin.password_hash, sourceCredential.password_hash, 'two distinct source hashes must not be conflated');
      assert.notEqual(targetAdmin.password_hash, before.admins.find(item => item.id === target).password_hash);
    }
    const after = await businessState();
    for (const id of [NEW.root, ids.otherRoot, ids.keepAdmin]) {
      assert.deepEqual(after.admins.find(item => item.id === id), before.admins.find(item => item.id === id));
      assert.deepEqual(after.financial_admin_credentials.find(item => item.admin_id === id), before.financial_admin_credentials.find(item => item.admin_id === id));
      assert.deepEqual(after.admin_financial_sessions.filter(item => item.admin_id === id), before.admin_financial_sessions.filter(item => item.admin_id === id));
    }
    for (const item of before.admin_financial_sessions.filter(item => [NEW.branch, NEW.emergency].includes(item.admin_id))) {
      const revoked = after.admin_financial_sessions.find(row => row.id === item.id);
      assert.ok(revoked.revoked_at);
      assert.deepEqual({ ...revoked, revoked_at: item.revoked_at }, item);
      if (item.revoked_at) assert.equal(revoked.revoked_at, item.revoked_at);
    }
    assert.deepEqual(after.users, before.users, 'no administrator deletion or cascading employee deletion');
    assert.deepEqual(after.history_cleanup_config, before.history_cleanup_config);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.admins WHERE id=ANY($1::uuid[])', [[OLD.root, OLD.branch, OLD.emergency]]), 0);
    assert.deepEqual(await triggerState(), triggers);
    assert.equal((await rpc('create_admin_financial_session', { p_username: 'branch', p_password: PASSWORDS.root })).success, false);
    await assert.rejects(rpc('get_employee_import_shared_replace_dry_run', auth(job, branchSession)), /permission|session/i);
  }));

test('group natural keys include mapped owner, reuse target IDs and replace exact/empty membership sets without deleting unrelated groups',
  async () => transaction(async () => {
    const before = await businessState();
    const { job, plan } = await prepared();
    await gateBackup(job, plan);
    const receipt = await apply(job, plan);
    assert.deepEqual(receipt.admin_group_map, { [ids.sourceGroup]: ids.targetGroup,
      [ids.sourceEmpty]: ids.targetEmpty, [ids.sourceNew]: ids.sourceNew });
    const after = await businessState();
    assert.equal(after.admin_groups.some(item => [ids.sourceGroup, ids.sourceEmpty].includes(item.id)), false);
    assert.equal(after.admin_groups.find(item => item.id === ids.targetGroup).created_by, NEW.branch);
    const expected = values(pkg, 'admin_group_members').map(item => ({ ...item,
      group_id: receipt.admin_group_map[item.group_id], admin_id: receipt.admin_map[item.admin_id] }));
    const affected = Object.values(receipt.admin_group_map);
    const actual = after.admin_group_members.filter(item => affected.includes(item.group_id));
    assert.deepEqual(actual.sort((a, b) => a.id.localeCompare(b.id)), expected.sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(actual.filter(item => item.group_id === ids.targetEmpty).length, 0);
    assert.equal(actual.some(item => item.admin_id === ids.keepAdmin || item.admin_id === NEW.emergency && item.group_id === ids.targetGroup), false);
    for (const id of [ids.foreignGroup, ids.keepGroup]) {
      assert.deepEqual(after.admin_groups.find(item => item.id === id), before.admin_groups.find(item => item.id === id));
      assert.deepEqual(after.admin_group_members.filter(item => item.group_id === id), before.admin_group_members.filter(item => item.group_id === id));
    }
  }));

test('an entirely empty source membership table clears all mapped groups, not unrelated groups or administrator accounts',
  async () => transaction(async () => {
    const input = changed('admin_group_members', () => []);
    const before = await businessState();
    const { job, plan } = await prepared(input);
    await gateBackup(job, plan);
    const receipt = await apply(job, plan);
    const after = await businessState();
    const mapped = Object.values(receipt.admin_group_map);
    assert.equal(after.admin_group_members.filter(item => mapped.includes(item.group_id)).length, 0);
    assert.deepEqual(after.admin_group_members, before.admin_group_members.filter(item => !mapped.includes(item.group_id)));
    assert.deepEqual(after.admins.map(item => item.id).sort(), before.admins.map(item => item.id).sort());
  }));

test('system keys and administrator/global settings use source values and mapped ownership while preserving target setting IDs and unrelated settings',
  async () => transaction(async () => {
    let input = changed('admin_configs', items => {
      const item = items.find(row => row.admin_id === OLD.branch && row.config_type === 'company_name');
      item.icon_type = null; item.icon_custom_url = null; item.created_at = null; item.updated_at = null;
      const global = items.find(row => row.admin_id === null && row.config_type === 'company_name');
      global.id = randomUUID();
    });
    input = changed('system_configs', items => {
      items.find(item => item.key === 'login_title').value = 'Source replacement title';
    }, input);
    const before = await businessState();
    const { job, plan } = await prepared(input);
    await gateBackup(job, plan);
    const receipt = await apply(job, plan);
    const after = await businessState();
    for (const source of values(input, 'admin_configs')) {
      const owner = source.admin_id === null ? null : receipt.admin_map[source.admin_id];
      const prior = before.admin_configs.find(item => item.id === source.id) ??
        before.admin_configs.find(item => item.admin_id === owner && item.config_type === source.config_type);
      const target = after.admin_configs.find(item => item.id === prior.id);
      assert.deepEqual(target, { ...source, id: prior.id, admin_id: owner });
    }
    for (const source of values(input, 'system_configs')) {
      assert.deepEqual(after.system_configs.find(item => item.key === source.key).value, source.value);
    }
    for (const prior of before.admin_configs.filter(item => item.admin_id === ids.keepAdmin)) {
      assert.deepEqual(after.admin_configs.find(item => item.id === prior.id), prior);
    }
    for (const prior of before.system_configs.filter(item => !values(input, 'system_configs').some(row => row.key === item.key))) {
      assert.deepEqual(after.system_configs.find(item => item.key === prior.key), prior);
    }
  }));

const isGlobalCurrency = item => item.admin_id === null && item.config_type === 'currency_unit';
const settingState = site => rows(site, 'SELECT to_jsonb(item) AS value FROM public.admin_configs AS item ORDER BY id');
const settingContent = item => Object.fromEntries(Object.keys(item).sort()
  .filter(key => !['id', 'created_at', 'updated_at'].includes(key)).map(key => [key, item[key]]));
const currencyInput = source => changed('admin_configs', items => [...items.filter(item => !isGlobalCurrency(item)), ...source]
  .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
async function independentCurrencyFixture(sourceBodies, targetBodies = sourceBodies) {
  const seeded = (await settingState(db)).map(item => item.value).filter(isGlobalCurrency);
  assert.equal(seeded.length, 2, 'retain the real historical duplicate-global seed');
  const target = [];
  for (const [index, body] of targetBodies.entries()) {
    const item = { ...seeded[0], config_value: 'USDC', icon_type: 'default', icon_custom_url: null,
      ...body, id: seeded[index]?.id ?? randomUUID(), created_at: sourceTime, updated_at: sourceTime };
    await db.query(`INSERT INTO public.admin_configs
      (id,admin_id,config_type,config_value,icon_type,icon_custom_url,created_at,updated_at)
      VALUES ($1,NULL,'currency_unit',$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET
        config_value=EXCLUDED.config_value,icon_type=EXCLUDED.icon_type,icon_custom_url=EXCLUDED.icon_custom_url,
        created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at`,
    [item.id, item.config_value, item.icon_type, item.icon_custom_url, item.created_at, item.updated_at]);
    target.push(item);
  }
  const source = sourceBodies.map((body, index) => ({ ...seeded[0], config_value: 'USDC',
    icon_type: 'default', icon_custom_url: null, ...body, id: randomUUID(),
    created_at: index % 2 ? '2023-01-02T03:04:05.123456Z' : null, updated_at: null }));
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.admin_configs WHERE id=ANY($1::uuid[])',
    [source.map(item => item.id)]), 0, 'model independent installs, not clone-preserved UUIDs');
  return { source, target };
}
function assertCurrencyReuse(plan, { source, target }) {
  applicable(plan);
  assert.deepEqual(plan.conflicts, []);
  const records = plan.records.filter(item => item.table_key === 'admin_configs' && source.some(row => row.id === item.source_id));
  assert.equal(records.length, source.length);
  assert.equal(new Set(records.map(item => item.target_id)).size, target.length, 'reuse must be one-to-one, not many-to-one');
  assert.deepEqual(records.map(item => item.target_id).sort(), target.map(item => item.id).sort());
  for (const row of source) {
    const sameContent = item => JSON.stringify(settingContent(item)) === JSON.stringify(settingContent(row));
    const ordinal = source.filter(sameContent).map(item => item.id).sort().indexOf(row.id);
    const targetId = target.filter(sameContent).map(item => item.id).sort()[ordinal];
    assert.deepEqual(records.find(item => item.source_id === row.id), {
      table_key: 'admin_configs', source_id: row.id, target_id: targetId, action: 'reuse',
    }, 'each complete-content group pairs UUIDs in C order');
  }
}

for (const [name, sourceBodies, targetBodies] of [
  ['two identical USDC defaults', [{ config_value: 'USDC' }, { config_value: 'USDC' }]],
  ['mixed content with equal per-content frequencies', [
    { config_value: 'USDC' }, { config_value: 'EUR', icon_type: 'preset_1' },
    { config_value: 'USDC' }, { config_value: 'EUR', icon_type: 'preset_1' },
  ], [
    { config_value: 'EUR', icon_type: 'preset_1' }, { config_value: 'USDC' },
    { config_value: 'EUR', icon_type: 'preset_1' }, { config_value: 'USDC' },
  ]],
]) {
  test(`independent-UUID duplicate global settings reuse distinct C-ordered targets: ${name}`, async () => transaction(async () => {
    const fixture = await independentCurrencyFixture(sourceBodies, targetBodies);
    const sourceBefore = await settingState(oldSite);
    const before = await businessState();
    const input = currencyInput(fixture.source);
    const inputBefore = structuredClone(input);
    const { job, plan } = await prepared(input);
    applicable(plan);
    const staged = await stagingState(job);
    const task = await jobState(job);
    const audit = await events(job);
    const backup = await backupState(job);
    assert.equal(backup.sealed_at, null);
    assert.deepEqual(backup.chunks, []);
    const full = await readonlyReplacementPlan(job);
    assertCurrencyReuse(full, fixture);
    assert.equal(full.plan_hash, plan.plan_hash);
    assert.deepEqual(await readonlyReplacementPlan(job), full);
    assert.deepEqual(await dryRun(job), plan);
    assert.deepEqual(await backupState(job), backup, 'stable planning does not rewrite the frozen backup');
    assert.deepEqual(await stagingState(job), staged);
    assert.deepEqual(await jobState(job), task);
    assert.deepEqual(await events(job), audit);
    await assert.rejects(apply(job, plan), /saved and sealed/, 'reuse is not permission to skip the independent backup');
    assert.deepEqual(await businessState(), before);
    assert.deepEqual(await settingState(oldSite), sourceBefore);
    assert.deepEqual(input, inputBefore);
  }));
}

for (const [name, sourceBodies, targetBodies, mutate, reason = 'ambiguous_target_setting'] of [
  ['unequal content frequencies despite equal total/set',
    [{ config_value: 'USDC' }, { config_value: 'USDC' }, { config_value: 'EUR' }],
    [{ config_value: 'USDC' }, { config_value: 'EUR' }, { config_value: 'EUR' }]],
  ['fewer source rows', [{ config_value: 'USDC' }], [{}, {}]],
  ['more source rows', [{}, {}, {}], [{}, {}]],
  ['different literal value', [{}, { config_value: 'USDC ' }], [{}, {}]],
  ['different icon type', [{}, { icon_type: 'preset_1' }], [{}, {}]],
  ['NULL icon is not default icon', [{}, { icon_type: null }], [{}, {}]],
  ['empty icon URL is not NULL', [{}, { icon_custom_url: '' }], [{}, {}]],
  ['one UUID overlaps the target set', [{}, {}], [{}, {}], fixture => { fixture.source[0].id = fixture.target[0].id; }],
  ['source UUID occupies another natural key', [{}, {}], [{}, {}], async fixture => {
    const occupied = (await settingState(db)).map(item => item.value).find(item => item.admin_id === null && item.config_type === 'company_name');
    assert.ok(occupied);
    fixture.source[0].id = occupied.id;
  }],
  ['non-global source duplicates', [{}, {}], [{}, {}], async fixture => {
    await putSetting(db, NEW.root, 'currency_unit', 'USDC');
    for (const item of fixture.source) item.admin_id = OLD.root;
  }, 'mapped_source_identity_collision'],
  ['matching custom media remains blocked', [{ icon_custom_url: 'https://source.invalid/icon.png' },
    { icon_custom_url: 'https://source.invalid/icon.png' }], undefined, undefined, 'media_backup_and_rewrite_required'],
  ['same IDs with a swapped content multiset', [{ config_value: 'EUR' }, { config_value: 'USDC' }],
    [{ config_value: 'USDC' }, { config_value: 'EUR' }], fixture => {
      fixture.source.forEach((item, index) => { item.id = fixture.target[index].id; });
    }],
  ['same IDs with one changed value', [{}, { config_value: 'EUR' }], [{}, {}], fixture => {
    fixture.source.forEach((item, index) => { item.id = fixture.target[index].id; });
  }],
  ['same IDs with one changed icon', [{}, { icon_type: 'preset_1' }], [{}, {}], fixture => {
    fixture.source.forEach((item, index) => { item.id = fixture.target[index].id; });
  }],
]) {
  test(`duplicate global multiset exception stays restricted: ${name}`, async () => transaction(async () => {
    const fixture = await independentCurrencyFixture(sourceBodies, targetBodies);
    await mutate?.(fixture);
    const sourceBefore = await settingState(oldSite);
    const before = await businessState();
    const { job, plan } = await prepared(currencyInput(fixture.source));
    assert.equal(plan.can_apply, false, JSON.stringify(plan.conflicts));
    assert.ok(plan.conflicts.some(item => item.table_key === 'admin_configs' && item.reason === reason &&
      fixture.source.some(row => row.id === item.source_id)), JSON.stringify(plan.conflicts));
    const staged = await stagingState(job);
    assert.deepEqual(await dryRun(job), plan, 'refusal is deterministic');
    assert.equal((await readonlyReplacementPlan(job)).plan_hash, plan.plan_hash);
    await assert.rejects(descriptor(job), /conflict-free/);
    await assert.rejects(apply(job, plan), /saved and sealed|conflicts/);
    assert.equal(await backupCount(job), 0);
    assert.deepEqual(await stagingState(job), staged);
    assert.deepEqual(await businessState(), before);
    assert.deepEqual(await settingState(oldSite), sourceBefore);
  }));
}

for (const [name, mutate] of [
  ['content', id => db.query(`UPDATE public.admin_configs SET config_value='USDT' WHERE id=$1`, [id])],
  ['UUID', id => db.query('UPDATE public.admin_configs SET id=$2 WHERE id=$1', [id, randomUUID()])],
  ['timestamp excluded only from content matching', id => db.query(`UPDATE public.admin_configs SET updated_at=$2 WHERE id=$1`, [id, '2025-02-03T04:05:06Z'])],
]) {
  test(`independent-UUID reuse plan refuses target drift: ${name}`, async () => transaction(async () => {
    const fixture = await independentCurrencyFixture([{}, {}]);
    const { job, plan } = await prepared(currencyInput(fixture.source));
    assertCurrencyReuse(await readonlyReplacementPlan(job), fixture);
    const frozen = await descriptor(job);
    const frozenPage = await page(job, 'admin_configs');
    const staged = await stagingState(job);
    const backup = await backupState(job);
    await mutate(fixture.target[0].id);
    const drifted = await businessState();
    const task = await jobState(job);
    const audit = await events(job);
    assert.notEqual((await readonlyReplacementPlan(job)).plan_hash, plan.plan_hash);
    await assert.rejects(dryRun(job), /target changed/i);
    assert.deepEqual(await descriptor(job), frozen);
    assert.deepEqual(await page(job, 'admin_configs'), frozenPage);
    assert.deepEqual(await backupState(job), backup);
    assert.deepEqual(await stagingState(job), staged);
    assert.deepEqual(await jobState(job), task);
    assert.deepEqual(await events(job), audit);
    assert.deepEqual(await businessState(), drifted, 'drift refusal must not repair or overwrite target rows');
  }));
}

for (const retainedIndex of [0, 1]) {
  test(`one exact-ID source currency replacement cannot choose between two target globals (retained row ${retainedIndex + 1})`,
    async () => transaction(async () => {
      const sourceGlobals = values(pkg, 'admin_configs').filter(item => item.admin_id === null && item.config_type === 'currency_unit');
      const targetGlobals = await rows(db, `SELECT id,config_value FROM public.admin_configs
        WHERE admin_id IS NULL AND config_type='currency_unit' ORDER BY id`);
      assert.equal(sourceGlobals.length, 2, 'exercise the real historical duplicate-global fixture');
      assert.equal(targetGlobals.length, 2);
      assert.deepEqual(sourceGlobals.map(item => item.id).sort(), targetGlobals.map(item => item.id).sort());
      const retained = sourceGlobals[retainedIndex];
      const input = changed('admin_configs', items => items.filter(item => item.admin_id !== null ||
        item.config_type !== 'currency_unit' || item.id === retained.id).map(item => item.id === retained.id
        ? { ...item, config_value: item.config_value === 'EUR' ? 'USD' : 'EUR' } : item));
      assert.equal(values(input, 'admin_configs').filter(item => item.admin_id === null && item.config_type === 'currency_unit').length, 1);
      const before = await businessState();
      const { job, plan } = await prepared(input);
      assert.equal(plan.can_apply, false, 'an exact ID must not bypass an ambiguous target natural key');
      assert.ok(plan.conflicts.some(item => item.table_key === 'admin_configs' && item.source_id === retained.id &&
        item.reason === 'ambiguous_target_setting'), JSON.stringify(plan.conflicts));
      await assert.rejects(descriptor(job), /conflict-free/);
      await assert.rejects(apply(job, plan), /saved and sealed|conflicts/);
      assert.equal(await backupCount(job), 0);
      assert.deepEqual(await businessState(), before);
    }));
}

test('the full exact-ID exact-content duplicate global currency set remains reusable without changing either target row',
  async () => transaction(async () => {
    const input = changed('admin_configs', items => items.filter(item => item.admin_id === null && item.config_type === 'currency_unit'));
    assert.equal(values(input, 'admin_configs').length, 2);
    const before = await rows(db, 'SELECT to_jsonb(item) AS value FROM public.admin_configs AS item ORDER BY id');
    const { job, plan } = await prepared(input);
    applicable(plan);
    assert.deepEqual(plan.conflicts, []);
    assertCurrencyReuse(await readonlyReplacementPlan(job), {
      source: values(input, 'admin_configs'), target: before.map(item => item.value).filter(isGlobalCurrency),
    });
    assert.deepEqual(await dryRun(job), plan);
    await gateBackup(job, plan);
    assert.equal((await apply(job, plan)).success, true);
    assert.deepEqual(await rows(db, 'SELECT to_jsonb(item) AS value FROM public.admin_configs AS item ORDER BY id'), before,
      'neither the duplicate set nor settings outside the source selection should be rewritten');
  }));

test('new non-root identities can be created alongside same-name replacements and retain nullable parent fields while disabled',
  async () => transaction(async () => {
    const newId = randomUUID();
    let input = changed('admins', items => [...items, { ...items.find(item => item.id === OLD.branch),
      id: newId, username: 'source-only-new-admin', parent_id: null, is_active: null, is_pinned: null, created_at: null, updated_at: null }]);
    input = changed('financial_admin_credentials', items => [...items, { ...items[0], admin_id: newId }], input);
    const { job, plan } = await prepared(input);
    await gateBackup(job, plan);
    const receipt = await apply(job, plan);
    assert.equal(receipt.created_admins, 1);
    assert.equal(receipt.admin_map[newId], newId);
    assert.deepEqual((await rows(db, 'SELECT parent_id,is_active,is_pinned,created_at,updated_at FROM public.admins WHERE id=$1', [newId]))[0],
      { parent_id: null, is_active: false, is_pinned: null, created_at: null, updated_at: null });
  }));

test('apply requires server-recorded replacement dry run, saved ciphertext and a matching seal; old dry run/apply cannot bypass them',
  async () => transaction(async () => {
    const before = await businessState();
    const job = await begin();
    await stageAll(job);
    await assert.rejects(descriptor(job), /dry run/);
    await assert.rejects(page(job, 'admins'), /missing/);
    await assert.rejects(apply(job, { plan_hash: hash('unconfirmed') }), /dry run/);
    const oldPlan = await rpc('get_employee_import_shared_dry_run', auth(job));
    await assert.rejects(apply(job, oldPlan), /dry run/);
    await assert.rejects(rpc('employee_import_shared_apply', { ...auth(job), p_plan_hash: oldPlan.plan_hash }), /cannot use the create-only/);
    const plan = await dryRun(job);
    applicable(plan);
    await assert.rejects(apply(job, { plan_hash: null }), /dry run/);
    await assert.rejects(apply(job, { plan_hash: hash('different') }), /dry run/);
    await assert.rejects(apply(job, plan), /saved and sealed/);
    await assert.rejects(saved(job.job_id), /unavailable/);
    const bytes = gateCipher();
    await append(job, plan, 0, bytes);
    await assert.rejects(apply(job, plan), /saved and sealed/);
    await assert.rejects(seal(job, plan, bytes, hash('wrong')), /does not match/);
    await assert.rejects(seal(job, plan, bytes, hash(bytes), bytes.length + 1), /does not match/);
    await assert.rejects(saved(job.job_id), /unavailable/);
    await assert.rejects(rpc('employee_import_shared_apply', { ...auth(job), p_plan_hash: plan.plan_hash }), /cannot use the create-only/);
    assert.deepEqual(await businessState(), before);
    await seal(job, plan, bytes);
    assert.equal((await apply(job, plan)).success, true);
    await assert.rejects(rpc('employee_import_shared_apply', { ...auth(job), p_plan_hash: plan.plan_hash }), /cannot use the create-only/);
  }));

test('an ordinary create-only task cannot call replacement backup or apply RPCs', async () => transaction(async () => {
  const job = await begin(pkg, session, PASSWORDS.root, 'employee_import_shared_begin');
  await stageAll(job);
  for (const call of [() => dryRun(job), () => descriptor(job), () => page(job, 'admins'),
    () => append(job, { plan_hash: hash('plan') }, 0, gateCipher()),
    () => seal(job, { plan_hash: hash('plan') }, gateCipher()), () => apply(job, { plan_hash: hash('plan') })]) {
    await assert.rejects(call(), /does not permit shared replacement/);
  }
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups'), 0);
}));

test('server sealing explicitly authenticates only ciphertext hash/length/magic, not AES-GCM plaintext or the frozen catalog',
  async () => transaction(async () => {
    const { job, plan } = await prepared();
    const bytes = await gateBackup(job, plan);
    await assert.rejects(containerModule.verifyEncryptedVolume((async function* () { yield bytes; })(),
      'local-db-replacement-backup-passphrase', { async append() {}, async abort() {} }));
    const chunk = await saved(job.job_id);
    assert.equal(chunk.hex, bytes.toString('hex'));
    assert.equal(chunk.sha256, hash(bytes));
    assert.equal((await apply(job, plan)).success, true, 'this is only the documented server integrity gate, not decryption proof');
  }));

test('repeated chunks, dry runs, descriptor, seal and apply are content-bound and do not duplicate writes, revoke times or audit events',
  async () => transaction(async () => {
    const { job, plan } = await prepared();
    const frozen = await descriptor(job);
    const staging = await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [job.job_id]);
    assert.deepEqual(await dryRun(job), plan);
    assert.deepEqual(await descriptor(job), frozen);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [job.job_id]), staging);
    assert.equal((await stage(job, 'admins', pkg.texts.admins)).repeated, true);
    await assert.rejects(stage(job, 'admins', pkg.texts.admins.replace('branch', 'branch2')), /different contents|catalog totals/);
    const bytes = gateCipher();
    const first = await append(job, plan, 0, bytes);
    assert.equal(first.repeated, false);
    assert.equal(first.sha256, hash(bytes));
    assert.equal(first.bytes, bytes.length);
    assert.deepEqual(await append(job, plan, 0, bytes), { ...first, repeated: true });
    await assert.rejects(append(job, plan, 0, Buffer.from('different')), /different contents/);
    const sealed = await seal(job, plan, bytes);
    const sealedAt = await scalar(db, 'SELECT sealed_at FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]);
    assert.deepEqual(await seal(job, plan, bytes), { ...sealed, repeated: true });
    assert.deepEqual(await scalar(db, 'SELECT sealed_at FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), sealedAt);
    await assert.rejects(append(job, plan, 1, Buffer.from('late')), /does not accept/);
    const receipt = await apply(job, plan);
    const state = await businessState();
    const audit = await events(job);
    assert.deepEqual(await apply(job, plan), { ...receipt, repeated: true });
    assert.deepEqual(await businessState(), state);
    assert.deepEqual(await events(job), audit);
    assert.equal(audit.filter(item => item.action === 'shared_replaced').length, 1);
    assert.doesNotMatch(JSON.stringify(audit), /password_hash|RootPass|job_token|\$2[aby]\$/);
    await assert.rejects(apply(job, { plan_hash: hash('wrong confirmation') }), /does not match/);
    await assert.rejects(stage(job, 'admins', pkg.texts.admins), /already been applied/);
    await assert.rejects(dryRun(job), /already been applied/);
    assert.equal((await jobState(job)).status, 'running', 'shared stage is not a completed full-site import');
  }));

for (const [name, mutate] of [
  ['admins', () => db.query('UPDATE public.admins SET is_pinned=NOT COALESCE(is_pinned,false) WHERE id=$1', [ids.keepAdmin])],
  ['financial_admin_credentials', () => db.query(`UPDATE public.financial_admin_credentials SET password_hash=extensions.crypt($2,extensions.gen_salt('bf',4)) WHERE admin_id=$1`, [ids.keepAdmin, PASSWORDS.branch])],
  ['admin_groups', () => db.query('UPDATE public.admin_groups SET name=$2 WHERE id=$1', [ids.keepGroup, 'target-only changed group'])],
  ['admin_group_members', () => db.query('UPDATE public.admin_group_members SET created_at=$2 WHERE group_id=$1', [ids.keepGroup, sourceTime])],
  ['admin_configs', () => db.query(`UPDATE public.admin_configs SET config_value='target-only changed brand' WHERE admin_id=$1`, [ids.keepAdmin])],
  ['system_configs', () => db.query(`UPDATE public.system_configs SET value='"Changed target subtitle"' WHERE key='login_subtitle'`)],
  ['history_cleanup_config', () => db.exec('UPDATE public.history_cleanup_config SET retention_days=retention_days+1')],
]) {
  test(`complete seven-table target hash detects drift in ${name}, including unrelated target rows`, async () => transaction(async () => {
    const { job, plan } = await prepared();
    await gateBackup(job, plan);
    const frozen = await descriptor(job);
    await mutate();
    const state = await businessState();
    const task = await jobState(job);
    const audit = await events(job);
    await assert.rejects(apply(job, plan), /target changed/i);
    await assert.rejects(dryRun(job), /target changed/i);
    assert.deepEqual(await descriptor(job), frozen);
    assert.deepEqual(await businessState(), state);
    assert.deepEqual(await jobState(job), task);
    assert.deepEqual(await events(job), audit);
    assert.ok((await saved(job.job_id)).hex, 'frozen sealed backup survives drift refusal');
  }));
}

test('backup pages are frozen, paginated/hash verified and reject invalid keys, cursors and limits', async () => transaction(async () => {
  const { job } = await prepared();
  const frozen = await descriptor(job);
  for (const key of keys) {
    let text = '';
    let count = 0;
    let after = null;
    do {
      const value = await page(job, key, after, 1);
      assert.equal(value.table_key, key);
      assert.ok(value.count <= 1);
      assert.equal(value.sha256, hash(value.ndjson));
      text += value.ndjson; count += value.count; after = value.next_after;
    } while (after !== null);
    const table = frozen.catalog.tables.find(item => item.key === key);
    assert.equal(count, table.rows);
    assert.equal(Buffer.byteLength(text), table.bytes);
    assert.equal(hash(text), table.sha256);
  }
  const original = await page(job, 'admins');
  await db.query('UPDATE public.admins SET is_pinned=true WHERE id=$1', [ids.keepAdmin]);
  assert.deepEqual(await page(job, 'admins'), original);
  for (const [key, after, limit] of [['admin_financial_sessions', null, 1], [null, null, 1],
    ['admins', 'unknown-cursor', 1], ['admins', null, 0], ['admins', null, 201], ['admins', null, null]]) {
    await assert.rejects(page(job, key, after, limit), /Invalid backup/);
  }
}));

test('append rejects gaps, invalid encodings/indices and wrong plan; seal rejects missing/truncated/bad magic ciphertext',
  async () => transaction(async () => {
    const { job, plan } = await prepared();
    const bytes = gateCipher();
    await assert.rejects(append(job, plan, 1, bytes), /contiguous/);
    await assert.rejects(append(job, { plan_hash: hash('other-plan') }, 0, bytes), /does not accept/);
    for (const [no, hex] of [[-1, 'aa'], [1024, 'aa'], [null, 'aa'], [0, ''], [0, 'a'], [0, 'GG'],
      [0, 'AA'], [0, null], [0, 'aa'.repeat(131073)]]) {
      await assert.rejects(rpc('employee_import_shared_backup_append', { ...auth(job), p_plan_hash: plan.plan_hash,
        p_chunk_no: no, p_hex: hex }), /Invalid encrypted backup chunk/);
    }
    await assert.rejects(seal(job, plan, bytes), /does not match/);
    const badMagic = Buffer.alloc(96, 0x61);
    await append(job, plan, 0, badMagic);
    await assert.rejects(seal(job, plan, badMagic), /does not match/);
    await assert.rejects(seal(job, { plan_hash: hash('other-plan') }, badMagic), /Invalid backup seal/);
    await assert.rejects(seal(job, plan, badMagic, 'bad'), /Invalid backup seal/);
    await assert.rejects(saved(job.job_id), /unavailable/);
    await assert.rejects(apply(job, plan), /saved and sealed/);
  }));

test('contiguous ciphertext chunks persist exactly; aggregate seal rejects truncation and invalid saved chunk indices',
  async () => transaction(async () => {
    const { job, plan } = await prepared();
    const bytes = gateCipher();
    const split = 47;
    await append(job, plan, 0, bytes.subarray(0, split));
    await assert.rejects(seal(job, plan, bytes.subarray(0, split)), /does not match/);
    await assert.rejects(seal(job, plan, bytes), /does not match/);
    await append(job, plan, 1, bytes.subarray(split));
    await seal(job, plan, bytes);
    assert.deepEqual(Buffer.concat([Buffer.from((await saved(job.job_id, 0)).hex, 'hex'),
      Buffer.from((await saved(job.job_id, 1)).hex, 'hex')]), bytes);
    for (const no of [-1, 2, null]) await assert.rejects(saved(job.job_id, no), /unavailable/);
  }));

test('sealed backup is task-owned: an old backup cannot satisfy a new identical-plan task or cross-plan append/seal/apply',
  async () => transaction(async () => {
    const first = await prepared();
    const cipher = await gateBackup(first.job, first.plan);
    await cancel(first.job);
    const second = await prepared();
    assert.equal(second.plan.plan_hash, first.plan.plan_hash, 'same plan hash does not make backup IDs interchangeable');
    assert.notEqual(second.job.job_id, first.job.job_id);
    assert.equal((await descriptor(second.job)).backup_id, second.job.job_id);
    await assert.rejects(apply(second.job, first.plan), /saved and sealed/);
    await assert.rejects(append(first.job, first.plan, 1, cipher), /invalid or expired/);
    assert.equal((await saved(first.job.job_id)).hex, cipher.toString('hex'));
    await cancel(second.job);
    const input = changed('system_configs', items => { items.find(item => item.key === 'login_title').value = 'Another source title'; });
    const third = await prepared(input);
    assert.notEqual(third.plan.plan_hash, first.plan.plan_hash);
    await assert.rejects(append(third.job, first.plan, 0, cipher), /does not accept/);
    await assert.rejects(seal(third.job, first.plan, cipher), /Invalid backup seal/);
    await assert.rejects(apply(third.job, first.plan), /dry run/);
    assert.equal((await saved(first.job.job_id)).sha256, hash(cipher));
  }));

test('cancel clears plaintext staging and task access but keeps sealed private ciphertext readable only by its owning super administrator',
  async () => transaction(async () => {
    const { job, plan } = await prepared();
    const bytes = await gateBackup(job, plan);
    const backup = await backupState(job);
    const before = await businessState();
    await cancel(job);
    assert.deepEqual(await backupState(job), backup, 'successful cancellation must preserve the whole sealed backup');
    assert.equal((await jobState(job)).status, 'cancelled');
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [job.job_id]), 0);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE id=$1 AND sealed_at IS NOT NULL', [job.job_id]), 1);
    for (const call of [() => descriptor(job), () => page(job, 'admins'), () => dryRun(job),
      () => stage(job, 'admins', pkg.texts.admins), () => append(job, plan, 1, bytes),
      () => seal(job, plan, bytes), () => apply(job, plan)]) await assert.rejects(call(), /invalid or expired/);
    assert.equal((await saved(job.job_id)).hex, bytes.toString('hex'));
    await assert.rejects(saved(job.job_id, 0, otherSession), /unavailable/);
    await assert.rejects(saved(job.job_id, 0, branchSession), /permission/i);
    assert.deepEqual(await businessState(), before, 'cancel before apply does not overwrite business data');
  }));

for (const uploaded of [false, true]) {
  test(`cancel deletes the unsealed backup row and its ciphertext chunks (${uploaded ? 'two uploaded chunks' : 'empty frozen backup'})`,
    async () => transaction(async () => {
      const { job, plan } = await prepared();
      applicable(plan);
      if (uploaded) await uploadGateChunks(job, plan, false);
      const backup = await backupState(job);
      assert.equal(backup.sealed_at, null);
      assert.equal(backup.chunks.length, uploaded ? 2 : 0);
      assert.equal(backup.byte_count, uploaded ? gateCipher().length : 0);
      const before = await businessState();
      assert.equal((await cancel(job)).cancelled, true);
      assert.equal((await jobState(job)).status, 'cancelled');
      assert.equal(await backupCount(job), 0, 'unsealed ciphertext must be deleted, not merely hidden by the read RPC');
      assert.deepEqual(await stagingState(job), []);
      await assert.rejects(saved(job.job_id), /unavailable/);
      assert.equal((await cancel(job)).cancelled, false);
      assert.deepEqual(await businessState(), before);
    }));
}

for (const sealed of [false, true]) {
  for (const owner of ['same', 'different']) {
    test(`begin abandons a stale ${sealed ? 'sealed' : 'unsealed'} task owned by ${owner} admin and ${sealed ? 'retains' : 'deletes'} its ciphertext`,
      async () => transaction(async () => {
        const { job, plan } = await prepared();
        applicable(plan);
        const bytes = await uploadGateChunks(job, plan, sealed);
        const backup = await backupState(job);
        const before = await businessState();
        // Same-owner reclamation is two minutes; cross-owner expiry is three hours.
        await db.query(`UPDATE private.employee_transfer_jobs SET last_activity_at=now()-$2::interval WHERE id=$1`,
          [job.job_id, owner === 'same' ? '3 minutes' : '4 hours']);
        const next = await begin(pkg, owner === 'same' ? session : otherSession);
        assert.equal(next.success, true);
        assert.notEqual(next.job_id, job.job_id);
        assert.equal((await jobState(job)).status, 'abandoned');
        assert.equal((await jobState(next)).status, 'running');
        assert.deepEqual(await stagingState(job), []);
        if (sealed) {
          assert.deepEqual(await backupState(job), backup, 'sealed backup metadata and both chunks survive task abandonment');
          for (const [no, chunk] of [bytes.subarray(0, 47), bytes.subarray(47)].entries()) {
            const recovered = await saved(job.job_id, no);
            assert.equal(recovered.hex, chunk.toString('hex'));
            assert.equal(recovered.sha256, hash(bytes));
            assert.equal(recovered.chunks, 2);
          }
        } else {
          assert.equal(await backupCount(job), 0, 'begin-triggered abandonment must delete the unsealed backup and chunks');
          await assert.rejects(saved(job.job_id), /unavailable/);
        }
        await assert.rejects(append(job, plan, 2, Buffer.from('late')), /invalid or expired/);
        assert.deepEqual(await businessState(), before);
        assert.equal((await cancel(next, owner === 'same' ? session : otherSession)).cancelled, true);
        if (sealed) assert.deepEqual(await backupState(job), backup, 'cancelling a different task cannot delete an older sealed backup');
      }));
  }

  for (const action of ['cancel', 'abandon-on-begin']) {
    test(`failed ${action} transaction restores a ${sealed ? 'sealed' : 'unsealed'} backup, chunks, staging and task status`,
      async () => transaction(async () => {
        const { job, plan } = await prepared();
        applicable(plan);
        await uploadGateChunks(job, plan, sealed);
        if (action === 'abandon-on-begin') {
          await db.query(`UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '3 minutes' WHERE id=$1`, [job.job_id]);
        }
        const backup = await backupState(job);
        const staged = await stagingState(job);
        const tasks = await rows(db, 'SELECT to_jsonb(item) AS value FROM private.employee_transfer_jobs AS item ORDER BY id');
        const audit = await events(job);
        const before = await businessState();
        // Audit insertion fails after cleanup, so rollback must restore backup and staging.
        await failTransferEvent(action === 'cancel' ? 'import_cancelled' : 'import_begin');
        await assert.rejects(action === 'cancel' ? cancel(job) : begin(), /fixture transfer event failure/);
        assert.deepEqual(await backupState(job), backup, 'a failed terminal transition cannot leave ciphertext deleted');
        assert.deepEqual(await stagingState(job), staged);
        assert.deepEqual(await rows(db, 'SELECT to_jsonb(item) AS value FROM private.employee_transfer_jobs AS item ORDER BY id'), tasks);
        assert.deepEqual(await events(job), audit);
        assert.deepEqual(await businessState(), before);
        if (sealed) {
          const recovered = await saved(job.job_id);
          assert.equal(recovered.sha256, hash(gateCipher()));
          assert.equal(recovered.chunks, 2);
        }
      }));
  }
}

test('new RPCs validate invalid/non-super/foreign-owner sessions, and private backups/helpers deny direct browser access',
  async () => transaction(async () => {
    for (const token of [null, randomUUID(), branchSession]) await assert.rejects(begin(pkg, token), /permission|session/i);
    assert.equal((await begin(pkg, session, 'wrong-local-password')).success, false);
    const sameSite = structuredClone(pkg);
    sameSite.catalog.site_id = await scalar(db, 'SELECT site_id FROM private.employee_transfer_site');
    await assert.rejects(begin(sameSite), /same site/);
    const { job, plan } = await prepared();
    const calls = [
      ['get_employee_import_shared_replace_dry_run', {}], ['get_employee_import_shared_backup', {}],
      ['get_employee_import_shared_backup_page', { p_table_key: 'admins', p_after: null, p_limit: 1 }],
      ['employee_import_shared_backup_append', { p_plan_hash: plan.plan_hash, p_chunk_no: 0, p_hex: gateCipher().toString('hex') }],
      ['employee_import_shared_backup_seal', { p_plan_hash: plan.plan_hash, p_sha256: hash(gateCipher()), p_bytes: gateCipher().length }],
      ['employee_import_shared_replace_apply', { p_plan_hash: plan.plan_hash }],
    ];
    for (const token of [null, randomUUID(), branchSession, otherSession]) {
      for (const [name, args] of calls) await assert.rejects(rpc(name, { ...auth(job, token), ...args }), /permission|session|invalid or expired/i);
    }
    await gateBackup(job, plan);
    for (const token of [null, randomUUID(), branchSession, otherSession]) {
      await assert.rejects(saved(job.job_id, 0, token), /permission|session|unavailable/i);
    }
    for (const role of ['anon', 'authenticated']) {
      for (const sql of ['SELECT * FROM private.employee_transfer_shared_backups',
        'UPDATE private.employee_transfer_shared_backups SET sealed_at=now()',
        'DELETE FROM private.employee_transfer_shared_backups',
        'INSERT INTO private.employee_transfer_shared_backups DEFAULT VALUES',
        'SELECT private.employee_transfer_assert_shared_replace_triggers()',
        `SELECT private.employee_transfer_shared_create_apply(NULL::uuid,NULL::uuid,NULL::text)`]) {
        await assert.rejects(asRole(role, () => db.exec(sql)), /permission denied/);
      }
    }
    const functions = await rows(db, `SELECT proname,prosecdef,proconfig,
      has_function_privilege('anon',oid,'EXECUTE') AS anon,
      has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
      EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`,
    [['employee_import_shared_replace_begin', ...calls.map(([name]) => name), 'get_employee_shared_saved_backup_chunk']]);
    assert.equal(functions.length, 8);
    for (const fn of functions) {
      assert.equal(fn.prosecdef, true);
      assert.equal(fn.anon, true); assert.equal(fn.authenticated, true); assert.equal(fn.public_execute, false);
      assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    }
  }));

for (const mode of ['expired', 'revoked']) {
  test(`${mode} owner session cannot read even sealed durable ciphertext`, async () => transaction(async () => {
    const { job, plan } = await prepared();
    await gateBackup(job, plan);
    await db.query(`UPDATE public.admin_financial_sessions SET ${mode === 'expired' ? "expires_at=now()-interval '1 second'" : 'revoked_at=now()'}
      WHERE admin_id=$1 AND revoked_at IS NULL`, [NEW.root]);
    await assert.rejects(saved(job.job_id), /session/i);
    await assert.rejects(apply(job, plan), /session/i);
  }));
}

for (const [name, mutate, reason] of [
  ['source username matching target super', input => changed('admins', items => { items.find(item => item.id === OLD.branch).username = 'other-root'; }, input), 'target_super_identity_protected'],
  ['source username matching target employee', input => changed('admins', items => { items.find(item => item.id === OLD.branch).username = 'target-only-employee'; }, input), 'username_matches_employee'],
  ['same-name source ID occupied by a different target identity', input => remapSourceAdmin(input, OLD.branch, ids.keepAdmin), 'administrator_id_conflict'],
  ['new-name source ID occupied by an unrelated target identity', input => remapSourceAdmin(input, OLD.branch, ids.keepAdmin, 'source-new-name'), 'administrator_id_conflict'],
  ['new-name source ID occupied by target super', input => remapSourceAdmin(
    changed('admin_group_members', items => items.filter(item => item.admin_id !== OLD.root), input),
    OLD.branch, NEW.root, 'source-new-name'), ['administrator_id_conflict', 'target_super_identity_protected']],
  ['same-name group ID occupied by a different target group', input => remapSourceGroup(input, ids.sourceGroup, ids.keepGroup), 'group_id_conflict'],
  ['new-name group ID occupied by an unrelated target group', input => remapSourceGroup(input, ids.sourceGroup, ids.keepGroup, 'source-only group'), 'group_id_conflict'],
  ['source custom media', input => changed('admin_configs', items => { items.find(item => item.admin_id === OLD.branch).icon_custom_url = 'https://source.invalid/storage/icon.png'; }, input), 'media_backup_and_rewrite_required'],
  ['source retention difference', input => changed('history_cleanup_config', items => { items[0].retention_days += 1; }, input), 'retention_maintenance_required'],
  ['setting ID occupied by different owner/type', input => changed('admin_configs', items => { items.find(item => item.admin_id === OLD.branch).id = targetOnlySetting; }, input), 'setting_id_conflict'],
]) {
  test(`replacement conflict blocks without a backup or business writes: ${name}`, async () => transaction(async () => {
    const before = await businessState();
    const { job, plan } = await prepared(mutate(pkg));
    assert.equal(plan.can_apply, false, `must block ${reason}; got ${JSON.stringify(plan.conflicts)}`);
    assert.ok(plan.conflicts.some(item => (Array.isArray(reason) ? reason : [reason]).includes(item.reason)), JSON.stringify(plan.conflicts));
    assert.doesNotMatch(JSON.stringify(plan), /password_hash|\$2[aby]\$/);
    await assert.rejects(descriptor(job), /conflict-free/);
    await assert.rejects(apply(job, plan), /saved and sealed|conflicts/);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), 0);
    assert.deepEqual(await businessState(), before);
  }));
}

for (const [name, setup, reason] of [
  ['active target automation', () => db.query(`INSERT INTO public.notification_automation_plans(owner_admin_id,name,status) VALUES ($1,'local active fixture','active')`, [NEW.branch]), 'target_automation_maintenance_required'],
  ['target custom media', () => db.query(`UPDATE public.admin_configs SET icon_custom_url='https://target.invalid/icon.png' WHERE admin_id=$1`, [NEW.branch]), 'media_backup_and_rewrite_required'],
  ['ambiguous same-name/same-owner groups', () => db.query(`INSERT INTO public.admin_groups(name,created_by) VALUES ('shared group',$1)`, [NEW.branch]), 'ambiguous_target_group'],
]) {
  test(`unsupported target state remains a conflict: ${name}`, async () => transaction(async () => {
    await setup();
    const before = await businessState();
    const { job, plan } = await prepared();
    assert.equal(plan.can_apply, false);
    assert.ok(plan.conflicts.some(item => item.reason === reason), JSON.stringify(plan.conflicts));
    await assert.rejects(descriptor(job), /conflict-free/);
    await assert.rejects(apply(job, plan), /saved and sealed|conflicts/);
    assert.deepEqual(await businessState(), before);
  }));
}

for (const name of ['guard_content_audit_public_media_reference', 'guard_employee_chat_image_reference']) {
  test(`an admin_groups BEFORE UPDATE trigger named ${name} cannot impersonate an approved media guard`,
    async () => transaction(async () => {
      const input = changed('admin_groups', items => {
        items.find(item => item.id === ids.sourceGroup).updated_at = '2024-04-05T06:07:08Z';
      });
      const { job, plan } = await prepared(input);
      await gateBackup(job, plan);
      assert.equal(await scalar(db, `SELECT count(*)::int FROM pg_trigger
        WHERE tgrelid='public.admin_groups'::regclass AND tgname=$1`, [name]), 0);
      await db.exec(`CREATE SEQUENCE public.fixture_shared_guard_calls;
        CREATE FUNCTION public.fixture_shared_guard_spoof() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM nextval('public.fixture_shared_guard_calls');
          RAISE EXCEPTION 'fixture spoof media guard executed';
        END; $$;
        CREATE TRIGGER ${name} BEFORE UPDATE ON public.admin_groups
        FOR EACH ROW EXECUTE FUNCTION public.fixture_shared_guard_spoof()`);
      const before = await businessState();
      const task = await jobState(job);
      const audit = await events(job);
      const backup = await backupState(job);
      const triggers = await triggerState();
      await assert.rejects(apply(job, plan), error => {
        assert.match(error.message, /unreviewed write trigger/);
        assert.doesNotMatch(error.message, /fixture spoof media guard executed/);
        return true;
      });
      assert.equal(await scalar(db, 'SELECT is_called FROM public.fixture_shared_guard_calls'), false,
        'sequence calls survive subtransaction rollback, so a fired guard cannot hide behind rollback');
      assert.deepEqual(await businessState(), before);
      assert.deepEqual(await jobState(job), task);
      assert.deepEqual(await events(job), audit);
      assert.deepEqual(await backupState(job), backup);
      assert.deepEqual(await triggerState(), triggers);
    }));
}

for (const state of ['empty', 'paused']) {
  test(`automation AFTER UPDATE statement trigger is rejected before firing with zero active plans (${state} target)`,
    async () => transaction(async () => {
      if (state === 'paused') {
        await db.query(`INSERT INTO public.notification_automation_plans(owner_admin_id,name,status)
          VALUES ($1,'local paused statement-trigger fixture','paused')`, [NEW.branch]);
      }
      assert.equal(await scalar(db, "SELECT count(*)::int FROM public.notification_automation_plans WHERE status='active'"), 0);
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_plans'), state === 'empty' ? 0 : 1);
      const { job, plan } = await prepared();
      await gateBackup(job, plan);
      // Zero affected rows still invoke statement-level triggers.
      await db.exec(`CREATE SEQUENCE public.fixture_shared_automation_calls;
        CREATE FUNCTION public.fixture_shared_automation_statement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM nextval('public.fixture_shared_automation_calls');
          RAISE EXCEPTION 'fixture automation statement trigger executed';
        END; $$;
        CREATE TRIGGER fixture_shared_automation_statement AFTER UPDATE ON public.notification_automation_plans
        FOR EACH STATEMENT EXECUTE FUNCTION public.fixture_shared_automation_statement()`);
      const before = await businessState();
      const task = await jobState(job);
      const audit = await events(job);
      const backup = await backupState(job);
      const triggers = await triggerState();
      await assert.rejects(apply(job, plan), error => {
        assert.match(error.message, /unreviewed write trigger/);
        assert.doesNotMatch(error.message, /fixture automation statement trigger executed/);
        return true;
      });
      assert.equal(await scalar(db, 'SELECT is_called FROM public.fixture_shared_automation_calls'), false,
        'even an otherwise rolled-back statement trigger must not have run');
      assert.deepEqual(await businessState(), before);
      assert.deepEqual(await jobState(job), task);
      assert.deepEqual(await events(job), audit);
      assert.deepEqual(await backupState(job), backup);
      assert.deepEqual(await triggerState(), triggers);
    }));
}

for (const [table, operation] of [['admins', 'UPDATE'],
  ['financial_admin_credentials', 'UPDATE'], ['admin_financial_sessions', 'UPDATE'],
  ['admin_groups', 'UPDATE'], ['admin_group_members', 'UPDATE'], ['admin_group_members', 'DELETE'],
  ['admin_configs', 'UPDATE'], ['system_configs', 'UPDATE']]) {
  test(`unknown ${operation} trigger on ${table} blocks replacement before any business write`, async () => transaction(async () => {
    const { job, plan } = await prepared();
    await gateBackup(job, plan);
    await db.exec(`CREATE FUNCTION public.fixture_shared_replace_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture unknown trigger must never execute'; END; $$;
      CREATE TRIGGER fixture_shared_replace_trigger BEFORE ${operation} ON public.${table}
      FOR EACH ROW EXECUTE FUNCTION public.fixture_shared_replace_trigger()`);
    const before = await businessState();
    const task = await jobState(job);
    const audit = await events(job);
    const triggers = await triggerState();
    await assert.rejects(apply(job, plan), /unreviewed write trigger/);
    assert.deepEqual(await businessState(), before);
    assert.deepEqual(await jobState(job), task);
    assert.deepEqual(await events(job), audit);
    assert.deepEqual(await triggerState(), triggers);
  }));
}

test('late target constraint failure rolls back account/hash/role/session/group/member/setting writes and success receipt/events; sealed backup survives',
  async () => transaction(async () => {
    const { job, plan } = await prepared();
    const cipher = await gateBackup(job, plan);
    await db.exec(`ALTER TABLE public.admin_configs ADD CONSTRAINT fixture_shared_replace_failure CHECK (config_value <> 'source brand')`);
    const before = await businessState();
    const task = await jobState(job);
    const audit = await events(job);
    const triggers = await triggerState();
    await assert.rejects(apply(job, plan), error => {
      assert.match(error.message, /rolled back by target validation/);
      assert.equal(error.code, '22023');
      assert.doesNotMatch(error.message, /\$2[aby]\$|source brand|fixture_shared_replace_failure/);
      return true;
    });
    assert.deepEqual(await businessState(), before);
    assert.deepEqual(await jobState(job), task);
    assert.deepEqual(await events(job), audit);
    assert.deepEqual(await triggerState(), triggers);
    assert.equal((await saved(job.job_id)).hex, cipher.toString('hex'));
    await db.exec('ALTER TABLE public.admin_configs DROP CONSTRAINT fixture_shared_replace_failure');
    assert.equal((await apply(job, plan)).success, true, 'failed transaction leaves the original sealed task retryable');
  }));

test('membership insert failure after exact-set DELETE restores removed target members and all earlier administrator/settings writes',
  async () => transaction(async () => {
    const { job, plan } = await prepared();
    await gateBackup(job, plan);
    await db.exec(`ALTER TABLE public.admin_group_members ADD CONSTRAINT fixture_shared_member_failure
      CHECK (NOT (group_id='${ids.targetGroup}'::uuid AND admin_id='${NEW.root}'::uuid))`);
    const before = await businessState();
    const task = await jobState(job);
    const audit = await events(job);
    const triggers = await triggerState();
    await assert.rejects(apply(job, plan), /rolled back by target validation/);
    assert.deepEqual(await businessState(), before, 'restore deleted memberships, changed settings, both hashes, roles and sessions');
    assert.deepEqual(await jobState(job), task);
    assert.deepEqual(await events(job), audit);
    assert.deepEqual(await triggerState(), triggers);
    await db.exec('ALTER TABLE public.admin_group_members DROP CONSTRAINT fixture_shared_member_failure');
    assert.equal((await apply(job, plan)).success, true);
  }));

test('approved media guards still reject reserved content and atomically restore earlier replacements and revoked sessions',
  async () => transaction(async () => {
    const input = changed('admin_configs', items => { items.find(item => item.admin_id === OLD.branch).config_value = 'chat/replacement-reserved.png'; });
    const { job, plan } = await prepared(input);
    await gateBackup(job, plan);
    await db.query(`INSERT INTO private.employee_chat_image_deletion_claims(path) VALUES ('chat/replacement-reserved.png')`);
    const before = await businessState();
    const task = await jobState(job);
    const audit = await events(job);
    await assert.rejects(apply(job, plan), /image.*reserved for permanent deletion/i);
    assert.deepEqual(await businessState(), before);
    assert.deepEqual(await jobState(job), task);
    assert.deepEqual(await events(job), audit);
  }));
