import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSites, adminLogin, rpc as baseRpc, scalar, rows } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, OLD, PASSWORDS } from './support/transfer-fixtures.mjs';

// Local PGlite + real migrations/public anon RPCs + real saved/authenticated ciphertext.
// No network, fabricated jobs/receipts, public apply substitutes, or trigger bypasses in the
// success path. Privileged corruption below is confined to explicitly negative transactions.
const migration = '20261102000016_restore_dispatch_dependencies.sql';
const root = fileURLToPath(new URL('../../', import.meta.url));
const SHARED = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const CONFIG = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders'];
const DISPATCH = [...CONFIG, 'dispatch_group_members', 'valid_order_data', 'used_order_data'];
const IDENTITY = ['accounts','credentials','orders'];
const id = n => `12000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = { default: id(10), match: id(20), fresh: id(40), base: id(110), matchBase: id(120), freshBase: id(140),
  normalBase: id(150), extra: id(160), employee: id(301), valid: id(310), used: id(311), order: id(312) };
const T = { default: id(60), match: id(30), only: id(80), base: id(210), matchBase: id(220), onlyBase: id(230),
  extra: id(240), employee: id(401), employee2: id(402), valid: id(410), otherRoot: id(900), branch: id(901) };
const hash = value => createHash('sha256').update(value).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
const rowHashes = text => hash(lines(text).map(line => hash(line)).join(''));
const ENTER = '確認暫停業務並導入派單資料';
const LEAVE = '確認取消尚未寫入的遷移';
const PAUSED = 'Business writes are paused for employee transfer maintenance.';
const PASSPHRASE = 'local-only-configuration-backup-authentication-passphrase';
let source, db, replay, session, sourceSession, branch, emergency, otherSession;
let modules, sharedPackage, dispatchPackage, identityPackage, sharedJob, sharedReceipt, job, preparation, backup;
let originalGroup, guarded, sequence = 0;

async function isolated(site, fn, role = null) {
  const point = `dispatch_configuration_${++sequence}`;
  await site.exec(`SAVEPOINT ${point}`);
  try {
    if (role) await site.exec(`SET LOCAL ROLE ${role}`);
    const value = await fn();
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
    return value;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
    throw error;
  }
}
async function transaction(fn, site = db, commit = false) {
  await site.exec('BEGIN');
  try {
    const value = await fn();
    await site.exec(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) { await site.exec('ROLLBACK'); throw error; }
}
const on = (site, name, args) => isolated(site, () => baseRpc(site, name, args, { role: null }), 'anon');
const rpc = (name, args) => on(db, name, args);
const auth = (task = job, token = session) => ({ p_admin_session_token: token, p_job_token: task.job_token });
const cancel = task => rpc('employee_transfer_cancel', auth(task));
const status = () => rpc('get_employee_transfer_maintenance', { p_admin_session_token: session });
const active = (task = job, dirty = false) => ({ active: true, job_id: task.job_id, dirty, full_site_complete: false });
const inactive = () => ({ active: false, job_id: null, dirty: false, full_site_complete: false });
const permitCount = () => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits');
const enter = (task = job, dry = preparation, extra = {}) => rpc('employee_import_dispatch_enter_maintenance', {
  ...auth(task), p_plan_hash: dry.plan_hash, p_confirmation: ENTER, p_admin_password: PASSWORDS.root, ...extra,
});
const leave = (task = job) => rpc('employee_transfer_leave_maintenance', {
  p_admin_session_token: session, p_job_id: task.job_id, p_admin_password: PASSWORDS.root, p_confirmation: LEAVE,
});
const configPlan = (task = job, extra = {}) => rpc('get_employee_import_dispatch_configuration_plan', { ...auth(task), ...extra });
const apply = (plan, task = job, extra = {}) => rpc('employee_import_dispatch_apply_configuration', {
  ...auth(task), p_plan_hash: plan.plan_hash, ...extra,
});
async function blocked(sql, role = null) {
  await assert.rejects(isolated(db, () => db.exec(sql), role), error => {
    assert.equal(error.message, PAUSED); assert.equal(error.code, '55000'); return true;
  });
}
async function businessState(tables = guarded, site = db) {
  return rows(site, tables.map(name => `SELECT '${name}' AS name,count(*)::int AS count,
    md5(COALESCE(string_agg(to_jsonb(r)::text,E'\n' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
}
const unaffected = () => businessState(guarded.filter(name => ![...CONFIG, 'dispatch_group_members'].map(key => `public.${key}`).includes(name)));
const triggerState = () => rows(db, `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','private') AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname`);
const taskState = task => scalar(db, `SELECT jsonb_build_object('summary',summary,'group_map',group_map,'admin_map',admin_map,'status',status)
  FROM private.employee_transfer_jobs WHERE id=$1`, [task.job_id]);

function chunks(text) {
  const result = []; let part = '', count = 0;
  for (const line of lines(text)) {
    if (count === 200 || Buffer.byteLength(part + line) > 262144) { result.push(part); part = ''; count = 0; }
    part += line; count++;
  }
  if (part || !result.length) result.push(part);
  return result;
}
async function capture(kind, packageId, token = sourceSession) {
  const keys = kind === 'shared' ? SHARED : kind === 'identity' ? IDENTITY : DISPATCH;
  const task = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: token, p_admin_password: PASSWORDS.root,
    ...(kind === 'identity' ? {p_package_id:packageId} : {}) });
  assert.equal(task.success, true);
  const texts = {};
  for (const key of keys) {
    let text = '', after = null;
    do {
      const page = await on(source, `get_employee_export_${kind}_page`, {
        ...auth(task, token), p_table_key: key, p_after: after, p_limit: 200,
      });
      assert.equal(page.sha256, hash(page.ndjson)); text += page.ndjson; after = page.next_after;
    } while (after !== null);
    texts[key] = text;
    const table = task.catalog.tables.find(t => t.key === key);
    assert.equal(table.rows, lines(text).length); assert.equal(table.bytes, Buffer.byteLength(text));
    assert.equal(kind === 'shared' ? table.sha256 : table.row_hashes_sha256, kind === 'shared' ? hash(text) : rowHashes(text));
  }
  assert.equal((await on(source, `employee_export_${kind}_verify`, auth(task, token))).verified, true);
  if (kind === 'shared') await on(source, 'employee_transfer_cancel', auth(task, token));
  else await on(source, `employee_export_${kind}_close`, auth(task, token));
  return { catalog: task.catalog, texts, packageId };
}
async function prepare(kind = 'dispatch', input = dispatchPackage) {
  const task = await rpc(kind === 'shared' ? 'employee_import_shared_replace_begin' : 'employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: input.packageId, p_catalog: input.catalog,
  });
  assert.equal(task.success, true);
  for (const key of kind === 'shared' ? SHARED : DISPATCH) {
    for (const [no, text] of chunks(input.texts[key]).entries()) {
      const ack = await rpc(`employee_import_${kind}_stage`, {
        ...auth(task), p_table_key: key, p_chunk_no: no, p_ndjson: text,
      });
      assert.equal(ack.success, true); assert.equal(ack.rows, lines(text).length); assert.equal(ack.sha256, hash(text));
    }
  }
  const dry = await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(task));
  assert.equal(dry.full_site_complete, false);
  if (kind === 'shared') assert.equal(dry.can_apply, true, JSON.stringify(dry.conflicts));
  else { assert.equal(dry.preparation_ready, true); assert.equal(dry.can_apply, false); assert.equal(dry.replacement_ready, false); }
  return { task, dry };
}
async function* diskSource(path) {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(65521);
    for (;;) { const result = await file.read(bytes); if (!result.bytesRead) return; yield bytes.subarray(0, result.bytesRead); }
  } finally { await file.close(); }
}
async function sealBackup(kind, task, dry) {
  const descriptor = await rpc(`get_employee_import_${kind}_backup`, auth(task));
  const keys = kind === 'shared' ? SHARED : DISPATCH;
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-configuration-'));
  const files = new Map(keys.map((key, index) => [`data/${kind}-${key}.ndjson`, join(directory, `plain-${index}`)]));
  const path = join(directory, 'independent-target.edx');
  const expected = new Map(); let opens = 0, eof = 0;
  try {
    const result = await (kind === 'shared' ? modules.createReplacementBackup : modules.createDispatchBackup)(descriptor, {
      async catalog() { return (await rpc(`get_employee_import_${kind}_backup`, auth(task))).catalog; },
      async page(key, after) {
        const page = await rpc(`get_employee_import_${kind}_backup_page`, {
          ...auth(task), p_table_key: key, p_after: after, p_limit: 200,
        });
        expected.set(key, (expected.get(key) ?? '') + page.ndjson); return page;
      },
      async verify() {
        assert.deepEqual(await rpc(`get_employee_import_${kind}_backup`, auth(task)), descriptor);
        assert.deepEqual(await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(task)), dry);
        return { verified: true, scope: kind === 'shared' ? 'shared-settings' : 'dispatch-submission', full_site_complete: false };
      },
    }, {
      async append(name, bytes) {
        assert.ok(files.has(name)); const file = await open(files.get(name), 'a');
        try { await file.writeFile(bytes); } finally { await file.close(); }
      },
      open(name) { assert.ok(files.has(name)); return diskSource(files.get(name)); },
      async abort() { await Promise.all([...files.values()].map(name => rm(name, { force: true }))); },
    }, {
      async write(stream) {
        const file = await open(path, 'wx');
        try { for await (const bytes of stream) await file.writeFile(bytes); await file.sync(); }
        finally { await file.close(); }
      },
      open() { opens++; return (async function* () { yield* diskSource(path); eof++; })(); },
    }, {
      append(no, hex) {
        assert.equal(opens, 2); assert.ok(eof >= 1, 'saved independent file must authenticate through EOF before upload');
        return rpc(`employee_import_${kind}_backup_append`, { ...auth(task), p_plan_hash: dry.plan_hash, p_chunk_no: no, p_hex: hex });
      },
      seal(sha256, bytes) {
        return rpc(`employee_import_${kind}_backup_seal`, { ...auth(task), p_plan_hash: dry.plan_hash, p_sha256: sha256, p_bytes: bytes });
      },
    }, PASSPHRASE);
    assert.equal(opens, 2); assert.equal(eof, 2);
    for (const file of files.values()) await assert.rejects(stat(file), { code: 'ENOENT' });
    const disk = await readFile(path), saved = [];
    assert.equal(disk.subarray(0, 8).toString(), 'EDXSTRM1'); assert.equal(hash(disk), result.cipherSha256);
    assert.equal(disk.length, result.bytes); assert.equal(result.sealReceipt.full_site_complete, false);
    for (let no = 0; no < result.chunks; no++) {
      const chunk = await rpc(`get_employee_${kind}_saved_backup_chunk`, {
        p_admin_session_token: session, p_backup_id: task.job_id, p_chunk_no: no,
      });
      assert.equal(chunk.sha256, hash(disk)); assert.equal(chunk.bytes, disk.length); saved.push(Buffer.from(chunk.hex, 'hex'));
    }
    assert.deepEqual(Buffer.concat(saved), disk);
    const plain = new Map();
    const manifest = await modules.verifyEncryptedVolume(diskSource(path), PASSPHRASE, {
      async append(name, bytes) { plain.set(name, [...(plain.get(name) ?? []), Buffer.from(bytes)]); },
      async abort() { assert.fail('real saved backup must authenticate'); },
    }, { expectedMetadata: { exportId: task.job_id, volumeId: task.job_id } });
    assert.equal(manifest.scope, 'replacement-backup'); assert.equal(manifest.entries.length, 7);
    for (const key of keys) assert.equal(Buffer.concat(plain.get(`data/${kind}-${key}.ndjson`)).toString(), expected.get(key));
    // The server itself has no passphrase: its seal proves ciphertext storage/hash only.
    return { descriptor, bytes: disk, result, texts: Object.fromEntries(expected) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function addEmployee(site, user, owner) {
  await site.query(`INSERT INTO public.users(id,username,password_hash,employee_id,created_by,is_active)
    VALUES($1,$2,extensions.crypt('identity-fixture-password',extensions.gen_salt('bf',4)),$3,$4,false)`, [user, `configuration-${user}`, `CFG-${user}`, owner]);
}
async function addGroup(site, group, name, owner, baseId, baseName, isDefault = false) {
  await site.query(`INSERT INTO public.dispatch_groups(id,group_name,created_by,is_default) VALUES($1,$2,$3,$4)`, [group, name, owner, isDefault]);
  await site.query(`UPDATE public.dispatch_order_pools SET id=$2,pool_name=$3 WHERE group_id=$1 AND is_base`, [group, baseId, baseName]);
}
async function addContent(site, group, pool, number, text, owner) {
  await site.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by,is_active,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,true,'2024-03-04T05:06:07.123456Z','2024-04-05T06:07:08.654321Z')`, [id(number), group, pool, text, owner]);
}

before(async () => {
  // Deny every accidental fetch before starting any data flow; PGlite uses local files only.
  mock.method(globalThis, 'fetch', () => assert.fail('configuration DB tests prohibit all network requests'));
  replay = await createSites({ upTo: migration }); source = replay.oldSite; db = replay.newSite;
  await db.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await buildNewSite(db);
  for (const [site, admin, name, role, password] of [
    [source, OLD.root, 'root', 'super_admin', PASSWORDS.root], [source, OLD.branch, 'branch', 'secondary_admin', PASSWORDS.branch],
    [source, OLD.emergency, 'emergency', 'emergency_admin', PASSWORDS.emergency],
    [db, T.otherRoot, 'configuration-other-root', 'super_admin', PASSWORDS.root],
    [db, T.branch, 'configuration-target-branch', 'secondary_admin', PASSWORDS.branch],
  ]) {
    await site.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4,true)`, [admin, name, password, role]);
    await site.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [admin]);
  }
  originalGroup = await scalar(source, 'SELECT id FROM public.dispatch_groups WHERE is_default');
  for (const [site, owner, label] of [[source, OLD.root, '來源'], [db, NEW.root, '目標']]) {
    await site.query(`UPDATE public.dispatch_groups SET is_default=false,group_name=$2,created_by=$3 WHERE id=$1`, [originalGroup, `${label}原始非默認組`, owner]);
    await site.query('UPDATE public.dispatch_order_pools SET created_by=$1 WHERE group_id=$2', [owner, originalGroup]);
  }
  await addGroup(source, S.default, '來源真正默認組', OLD.root, S.base, '來源改名Base', true);
  await addGroup(source, S.match, '同名應覆蓋組', OLD.branch, S.matchBase, '來源空內容Base');
  await addGroup(source, S.fresh, '來源全新組', OLD.branch, S.freshBase, '來源全新改名Base');
  await addGroup(db, T.default, '目標初始化默認組', NEW.root, T.base, '目標初始化Base', true);
  await db.query(`UPDATE public.dispatch_order_pools SET pool_name='目標舊Base' WHERE group_id=$1 AND is_base`, [NEW.groupA]);
  await db.query('UPDATE public.dispatch_groups SET group_name=$2 WHERE id=$1', [NEW.groupA, '目標獨有Group A']);
  await addGroup(db, T.match, '同名應覆蓋組', NEW.branch, T.matchBase, '目標同名組舊Base');
  await addGroup(db, T.only, '目標獨有組', NEW.root, T.onlyBase, 'Base');
  await source.query(`INSERT INTO public.dispatch_order_pools(id,group_id,pool_name,is_base,trigger_probability,created_by)
    VALUES($1,$2,'Base',false,30,$3),($4,$2,'來源普通池',false,10,$3)`, [S.normalBase, S.default, OLD.branch, S.extra]);
  await source.query(`UPDATE public.dispatch_order_pools SET trigger_probability=60 WHERE id=$1`, [S.base]);
  await source.query(`UPDATE public.dispatch_groups SET description='來源完整配置 é é 𠮷',dispatch_interval_min=7,
    dispatch_interval_max=19,session_timeout_minutes=3,dispatch_order_mode='sequential',dispatch_success_rate=37,
    pool_selection_mode='weighted',submit_wait_min_seconds=11,submit_wait_max_seconds=18,commission_rate=0.12345678,
    withdrawal_amount_threshold=123.45,withdrawal_orders_threshold=17,withdrawal_condition_mode='AND',grab_success_rate=63,
    created_at='2024-03-04T05:06:07.123456Z',updated_at='2024-04-05T06:07:08.654321Z' WHERE id=$1`, [S.default]);
  await source.query(`UPDATE public.dispatch_order_pools SET dispatch_interval_min=13,dispatch_interval_max=23,
    session_timeout_minutes=2,dispatch_order_mode='sequential',dispatch_success_rate=29,created_by=$2,
    created_at='2023-01-02T03:04:05.123456Z',updated_at='2023-02-03T04:05:06.654321Z' WHERE id=ANY($1::uuid[])`,
  [[S.base, S.matchBase, S.freshBase, S.normalBase], OLD.branch]);
  await db.query(`UPDATE public.dispatch_groups SET description='目標不能保留',commission_rate=0.00001001,
    dispatch_order_mode='random',dispatch_success_rate=91 WHERE id=$1`, [T.default]);
  await db.query(`UPDATE public.dispatch_order_pools SET dispatch_interval_min=61,dispatch_interval_max=89,dispatch_success_rate=97 WHERE id=$1`, [T.base]);
  await db.query(`INSERT INTO public.dispatch_order_pools(id,group_id,pool_name,created_by) VALUES($1,$2,'目標獨有普通池',$3)`, [T.extra, T.default, NEW.root]);
  await addContent(source, S.default, S.base, 501, '來源默認原文\n含換行 é é 𠮷', OLD.branch);
  await addContent(source, S.default, S.normalBase, 502, '普通池叫Base，不是默認池', OLD.root);
  await addContent(source, S.fresh, S.freshBase, 503, '新組自動Base必須完整覆蓋', OLD.branch);
  await addContent(db, T.default, T.base, 601, '目標舊默認內容必須清除', NEW.root);
  await addContent(db, T.match, T.matchBase, 602, '來源此池空，不能留下此內容', NEW.branch);
  await addContent(db, T.only, T.onlyBase, 603, '目標獨有組內容也不保留可用', NEW.root);
  await addContent(db, T.default, T.extra, 604, '目標獨有池內容', NEW.root);
  await addEmployee(source, S.employee, OLD.branch); await addEmployee(db, T.employee, NEW.root); await addEmployee(db, T.employee2, NEW.branch);
  for (const [site, group, user, owner] of [[source, S.default, S.employee, OLD.branch],
    [db, T.default, T.employee, NEW.root], [db, T.only, T.employee2, NEW.branch]])
    await site.query(`INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by,assigned_at)
      VALUES($1,$2,$3,'2024-05-06T07:08:09.123456Z')`, [group, user, owner]);
  await source.query(`INSERT INTO public.product_types(id,name) VALUES($1,'Configuration source product')`, [OLD.product]);
  await source.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status)
    VALUES($1,$2,$3,$4,1,'source-dependency','source-dependency-tx','failure')`, [S.order, S.employee, `configuration-${S.employee}`, OLD.product]);
  await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by,usage_count,tags)
    VALUES($1,12345678901234567890.1234567890123456789,'來源已用依賴-é-𠮷',$2,6,ARRAY['來源','已用'])`, [S.valid, OLD.root]);
  await source.query(`INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at)
    VALUES($1,$2,$3,$4,'2024-05-06T07:08:09.123456Z')`, [S.used, S.employee, S.valid, S.order]);
  await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,is_active,created_by,
      created_at,updated_at,usage_count,last_used_at,deactivated_at,deactivation_reason,priority,tags)
    SELECT ('12000000-0000-4000-8000-'||lpad(to_hex(1000+n),12,'0'))::uuid,
      98765432109876543210.9876543210987654321,'來源多批原文 '||n||E'\\n𠮷 é é',
      CASE WHEN n%3=0 THEN NULL ELSE n%3=1 END,CASE WHEN n%2=0 THEN $1::uuid ELSE $2::uuid END,
      '2022-03-04T05:06:07.123456Z'::timestamptz,'2023-04-05T06:07:08.654321Z'::timestamptz,
      CASE WHEN n%2=0 THEN 2147483647 ELSE NULL END,
      CASE WHEN n%2=0 THEN '2023-03-04T05:06:07.123456Z'::timestamptz ELSE NULL END,
      CASE WHEN n%3=2 THEN '2023-03-04T05:06:07.123456Z'::timestamptz ELSE NULL END,
      CASE WHEN n%3=2 THEN 'manual' ELSE NULL END,NULL,
      CASE WHEN n%2=0 THEN ARRAY['來源',NULL,'標籤'] ELSE NULL END
    FROM generate_series(1,402) AS x(n)`, [OLD.root,OLD.branch]);
  await db.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by)
    VALUES($1,98765432109876543210.9876543210987654321,'目標未使用原文',$2)`, [T.valid, NEW.root]);
  await source.exec(`UPDATE public.dispatch_config SET config_value=CASE config_key WHEN 'dispatch_interval_min' THEN '7'
    WHEN 'dispatch_interval_max' THEN '19' WHEN 'session_timeout_minutes' THEN '3' ELSE 'sequential' END,
    description=NULL,updated_at='2024-03-04T05:06:07.123456Z'`);
  await source.query(`INSERT INTO public.financial_employee_credentials(user_id,password_hash,created_at,updated_at)
    VALUES($1,extensions.crypt('identity-financial-password',extensions.gen_salt('bf',4)),
      '2021-02-03T04:05:06.123456Z','2022-03-04T05:06:07.654321Z')`,[S.employee]);
  await source.query(`UPDATE public.users SET is_active=true,is_verified=true,is_pinned=true,remarks=E'來源員工備註\\n𠮷 é é',
    tags=ARRAY['標籤',NULL,'篩選'],created_at='2021-02-03T04:05:06.123456Z',updated_at='2022-03-04T05:06:07.654321Z',
    current_session_token=$2,session_created_at=now(),last_heartbeat_at=now(),current_tab_id='must-not-transfer' WHERE id=$1`,[S.employee,randomUUID()]);
  await source.query(`INSERT INTO public.users(id,username,password_hash,employee_id,created_by,is_active,is_pinned,remarks,tags)
    SELECT ('12000000-0000-4000-8000-'||lpad(to_hex(2000+n),12,'0'))::uuid,'identity-source-'||n,
      extensions.crypt('identity-fixture-password',extensions.gen_salt('bf',4)),'IDS-'||n,
      CASE WHEN n%2=0 THEN $1::uuid ELSE $2::uuid END,CASE WHEN n%3=0 THEN NULL ELSE n%3=1 END,
      NULL,NULL,CASE WHEN n%2=0 THEN ARRAY[]::text[] ELSE NULL END FROM generate_series(1,202) AS x(n)`,[OLD.root,OLD.branch]);
  await source.query(`INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by)
    SELECT $1,id,$2 FROM public.users WHERE username LIKE 'identity-source-%'`,[S.default,OLD.root]);
  await transaction(async()=>{
    const disabled=await scalar(source,"SELECT private.employee_transfer_bypass_triggers(ARRAY['orders'])");
    await source.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,
      status,commission_amount,commission_rate,created_at,processed_at)
    SELECT ('12000000-0000-4000-8000-'||lpad(to_hex(3000+2*n+k),12,'0'))::uuid,
      ('12000000-0000-4000-8000-'||lpad(to_hex(2000+n),12,'0'))::uuid,'identity-source-'||n,$1,999.99,
      'source-detail-must-not-transfer-'||n||'-'||k,'source-transaction-must-not-transfer-'||n||'-'||k,
      CASE WHEN k=0 THEN 'success' ELSE 'failure' END,CASE WHEN k=0 THEN 3.1234567890123456789 ELSE NULL END,
      0.1234567890123456789,'2023-02-03T04:05:06.123456Z','2023-02-04T05:06:07.654321Z'
    FROM generate_series(1,202) AS x(n) CROSS JOIN generate_series(0,1) AS y(k)`,[OLD.product]);
    await source.query('SELECT private.employee_transfer_restore_triggers($1::jsonb)',[JSON.stringify(disabled)]);
  },source,true);
  // Announcement-only material is deliberately unrelated to all transfer protocols.
  await db.query(`INSERT INTO public.announcement_categories(name,display_order) VALUES('配置測試保留分類',10)`);
  await db.query(`INSERT INTO public.announcements(title,content,created_by) VALUES('配置測試保留公告','<p>不得更動</p>',$1)`, [NEW.root]);
  guarded = await scalar(db, 'SELECT private.employee_transfer_guarded_tables()');
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'configuration-target-branch', PASSWORDS.branch);
  emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  otherSession = await adminLogin(db, 'configuration-other-root', PASSWORDS.root);
  const compiled = await build({ stdin: { contents: `export { createReplacementBackup } from './src/lib/employeeTransfer/replacementBackup.ts';
    export { createDispatchBackup } from './src/lib/employeeTransfer/dispatchBackup.ts';
    export { verifyEncryptedVolume } from './src/lib/employeeTransfer/container.ts';`, resolveDir: root, sourcefile: 'dispatch-configuration-backup-entry.mjs' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020' });
  modules = { ...await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`) };
  const identityBuild = await build({stdin:{contents:`export * from './src/lib/employeeTransfer/identityApi.ts';
    export * from './src/lib/employeeTransfer/identityTransfer.ts';
    export * from './src/lib/employeeTransfer/dependencyApi.ts'; export { setHarness } from 'identity-db:state';`,resolveDir:root},
    bundle:true,write:false,format:'esm',platform:'browser',target:'es2020',plugins:[{name:'identity-local-sql',setup(builder){
      builder.onResolve({filter:/^\.\.\/(auth|supabase)$/},args=>({path:args.path.slice(3),namespace:'identity-db'}));
      builder.onResolve({filter:/^identity-db:state$/},()=>({path:'state',namespace:'identity-db'}));
      builder.onLoad({filter:/.*/,namespace:'identity-db'},({path})=>({contents:path==='state'
        ? 'let h; export const setHarness=x=>{h=x}; export const current=()=>h;'
        : path==='auth' ? 'import{current}from"identity-db:state";export const getAdminFinancialSessionToken=()=>current().token;'
        : 'import{current}from"identity-db:state";export const supabase={rpc:(name,args)=>current().rpc(name,args)};'}));
    }}]});
  modules.identity = await import(`data:text/javascript;base64,${Buffer.from(identityBuild.outputFiles[0].text).toString('base64')}`);
  const packageId = randomUUID();
  sharedPackage = await transaction(() => capture('shared', packageId), source, true);
  await transaction(async () => {
    const prepared = await prepare('shared', sharedPackage); sharedJob = prepared.task;
    await sealBackup('shared', sharedJob, prepared.dry);
    sharedReceipt = await rpc('employee_import_shared_replace_apply', { ...auth(sharedJob), p_plan_hash: prepared.dry.plan_hash });
    assert.equal(sharedReceipt.success, true); assert.equal(sharedReceipt.full_site_complete, false);
    assert.equal(sharedReceipt.admin_map[OLD.root], NEW.root); assert.equal(sharedReceipt.admin_map[OLD.branch], NEW.branch);
    await cancel(sharedJob);
  }, db, true);
  // Export AFTER the real shared apply/cancel, with precisely the same package/source site.
  dispatchPackage = await transaction(() => capture('dispatch', packageId), source, true);
  assert.equal(dispatchPackage.catalog.site_id, sharedPackage.catalog.site_id);
  identityPackage = await transaction(() => capture('identity', packageId),source,true);
  await transaction(async () => {
    const prepared = await prepare(); job = prepared.task; preparation = prepared.dry;
    backup = await sealBackup('dispatch', job, preparation);
  }, db, true);
}, { timeout: 180000 });
after(async () => { mock.restoreAll(); await Promise.all([source?.close(), db?.close()]); });

test('543 real migrations through 16 retain exactly 12 known old failures, never a fresh native PostgreSQL claim', () => {
  assert.equal(replay.files.length, 543); assert.equal(replay.files.at(-1), migration);
  assert.equal(replay.failures.length, 12); assert.equal(replay.validation.matched.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.ok(!replay.failures.some(f => f.file >= '20261102000011'));
});

test('real shared receipt, source site/package and independent sealed backups form the prerequisite chain', () => transaction(async () => {
  assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [sharedJob.job_id]), 'cancelled');
  const shared = await scalar(db, 'SELECT to_jsonb(r) FROM private.employee_transfer_jobs AS r WHERE id=$1', [sharedJob.job_id]);
  assert.equal(shared.summary?.shared_applied, true, 'real apply -> cancel must retain the server shared_applied proof for migration 12');
  assert.deepEqual(shared.summary.shared_receipt, sharedReceipt, 'cancel must not discard the server receipt needed by the next phase');
  assert.deepEqual(shared.admin_map, sharedReceipt.admin_map);
  assert.equal(sharedPackage.packageId, dispatchPackage.packageId);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE id=ANY($1::uuid[]) AND sealed_at IS NOT NULL', [[sharedJob.job_id, job.job_id]]), 2);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.used_order_data'), 0);
  assert.equal(preparation.dependencies.employees, 203); assert.equal(preparation.dependencies.orders, 1);
  assert.match(dispatchPackage.texts.valid_order_data, /12345678901234567890\.1234567890123456789/);
  assert.match(backup.texts.valid_order_data, /98765432109876543210\.9876543210987654321/);
  assert.equal(lines(dispatchPackage.texts.used_order_data).length, 1);
  assert.equal(await permitCount(), 0); assert.deepEqual(await status(), inactive());
}));

test('two public RPCs have fixed security/grants and no client administrator/employee maps; all new helpers remain private', () => transaction(async () => {
  const result = await rows(db, `SELECT proname,proargnames,prosecdef,proconfig,
    has_function_privilege('anon',oid,'EXECUTE') AS anon,has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`,
  [['get_employee_import_dispatch_configuration_plan', 'employee_import_dispatch_apply_configuration']]);
  assert.equal(result.length, 2);
  for (const fn of result) {
    assert.equal(fn.prosecdef, true); assert.equal(fn.anon, true); assert.equal(fn.authenticated, true); assert.equal(fn.public_execute, false);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    assert.deepEqual(fn.proargnames, ['p_admin_session_token', 'p_job_token', ...(fn.proname.includes('apply') ? ['p_plan_hash'] : [])]);
  }
  for (const name of ['employee_transfer_dispatch_admin_map', 'employee_transfer_dispatch_config_plan',
    'employee_transfer_write_dispatch_config_row', 'employee_transfer_assert_dispatch_config_triggers']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar(db, `SELECT has_function_privilege($1,oid,'EXECUTE')
      FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname=$2`, [role, name]), false);
  }
  await assert.rejects(isolated(db, () => db.query('SELECT private.employee_transfer_allow_config_write($1)', [job.job_id]), 'anon'), /permission denied/);
}));

function checkPlan(plan, task = job, dry = preparation) {
  assert.deepEqual(Object.keys(plan).sort(), ['scope', 'can_apply_configuration', 'full_site_complete', 'replacement_ready',
    'conflicts', 'group_map', 'pool_map', 'preparation_plan_hash', 'plan_hash'].sort());
  assert.equal(plan.scope, 'dispatch-configuration'); assert.equal(plan.can_apply_configuration, true, JSON.stringify(plan.conflicts));
  assert.equal(plan.full_site_complete, false); assert.equal(plan.replacement_ready, false); assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.preparation_plan_hash, dry.plan_hash); assert.match(plan.plan_hash, /^[0-9a-f]{64}$/);
  assert.equal(plan.group_map[S.default], T.default); assert.equal(plan.group_map[S.match], T.match);
  assert.equal(plan.group_map[S.fresh], S.fresh); assert.equal(plan.pool_map[S.base], T.base);
  assert.equal(plan.pool_map[S.matchBase], T.matchBase); assert.equal(plan.pool_map[S.freshBase], S.freshBase);
  assert.equal(plan.pool_map[S.normalBase], S.normalBase); assert.ok(task.job_token);
}
async function verifyConfiguration(plan, task = job) {
  // Compare actual JSONB in SQL, including every declared column, numeric scale, NULL and
  // microseconds. JS JSON.parse is not allowed to round numeric fields into a false match.
  for (const key of CONFIG) {
    const query = await scalar(db, 'SELECT private.employee_transfer_dispatch_query($1)', [key]);
    const mismatches = await rows(db, `WITH input AS (
      SELECT id,body FROM private.employee_transfer_dispatch_input($1,$2)
    ), expected AS (SELECT CASE $2
      WHEN 'dispatch_groups' THEN body||jsonb_build_object('id',$3::jsonb->'group_map'->id::text,'created_by',$4::jsonb->(body->>'created_by'))
      WHEN 'dispatch_order_pools' THEN body||jsonb_build_object('id',$3::jsonb->'pool_map'->id::text,'group_id',$3::jsonb->'group_map'->(body->>'group_id'),'created_by',$4::jsonb->(body->>'created_by'))
      WHEN 'dispatch_group_orders' THEN body||jsonb_build_object('group_id',$3::jsonb->'group_map'->(body->>'group_id'),'pool_id',$3::jsonb->'pool_map'->(body->>'pool_id'),'created_by',$4::jsonb->(body->>'created_by'))
      ELSE body END AS body FROM input)
      SELECT expected.body->>'id' AS missing_or_changed FROM expected LEFT JOIN (${query}) AS actual
        ON actual.id=(expected.body->>'id')::uuid AND actual.body=expected.body WHERE actual.id IS NULL`,
    [task.job_id, key, JSON.stringify(plan), JSON.stringify(sharedReceipt.admin_map)]);
    assert.deepEqual(mismatches, [], `${key}: every source column must match after explicit identity/creator/reference mapping`);
  }
  for (const key of ['dispatch_config', 'dispatch_group_orders']) assert.equal(await scalar(db, `SELECT count(*)::int FROM public.${key}`),
    lines(dispatchPackage.texts[key]).length, `${key}: no target-only rows may survive`);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_group_members'), 0, 'source members are NOT restored in this stage');
  assert.equal(await scalar(db, 'SELECT id FROM public.dispatch_groups WHERE is_default'), T.default);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_order_pools WHERE group_id=$1 AND is_base', [S.fresh]), 1);
  assert.equal(await scalar(db, 'SELECT pool_name FROM public.dispatch_order_pools WHERE id=$1', [S.normalBase]), 'Base');
  assert.equal(await scalar(db, 'SELECT is_base FROM public.dispatch_order_pools WHERE id=$1', [S.normalBase]), false);
  assert.equal(await scalar(db, 'SELECT pool_name FROM public.dispatch_order_pools WHERE id=$1', [T.base]), '來源改名Base');
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_group_orders WHERE pool_id=$1', [T.matchBase]), 0);
  assert.deepEqual(await rows(db, `SELECT is_active,is_default,archived_at IS NOT NULL AS archived FROM public.dispatch_groups WHERE id=$1`, [T.only]),
    [{ is_active: false, is_default: false, archived: true }]);
  assert.deepEqual(await rows(db, `SELECT is_active,is_base,archived_at IS NULL AS not_archived FROM public.dispatch_order_pools WHERE id=$1`, [T.onlyBase]),
    [{ is_active: false, is_base: true, not_archived: true }]);
  assert.deepEqual(await rows(db, `SELECT is_active,archived_at IS NOT NULL AS archived,trigger_probability FROM public.dispatch_order_pools WHERE id=$1`, [T.extra]),
    [{ is_active: false, archived: true, trigger_probability: 0 }]);
  assert.equal(await scalar(db, `SELECT count(*)::int FROM public.dispatch_group_orders WHERE id=ANY($1::uuid[])`, [[id(601), id(602), id(603), id(604)]]), 0);
}

test('lightweight plan uses only the server shared receipt; no maintenance/backup is claimed as full-site completion', () => transaction(async () => {
  await enter(); const before = await businessState(); const plan = await configPlan(); checkPlan(plan);
  assert.deepEqual(await configPlan(), plan); assert.deepEqual(await businessState(), before);
  assert.deepEqual(await status(), active()); assert.equal(await permitCount(), 0);
  assert.notEqual(S.default, T.default); assert.notEqual(S.base, T.base);
  assert.doesNotMatch(JSON.stringify(plan), /admin_map|password_hash|ndjson|order_content|catalog/);
}));

test('real four-table configuration restore covers source defaults, renamed/ordinary Base, new auto-Base, exact fields and retired residuals', () => transaction(async () => {
  await enter(); const plan = await configPlan(); checkPlan(plan);
  const keep = await unaffected(), triggers = await triggerState();
  const receipt = await apply(plan);
  assert.deepEqual(receipt, { success: true, scope: 'dispatch-configuration', configuration_applied: true,
    maintenance: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false,
    repeated: false, group_map: plan.group_map, pool_map: plan.pool_map });
  await verifyConfiguration(plan);
  assert.deepEqual(await unaffected(), keep, 'all other guarded tables, financial/audit/health logs, users/orders, valid/used and announcements are untouched');
  assert.deepEqual(await triggerState(), triggers); assert.equal(await permitCount(), 0);
  await db.exec('SELECT private.employee_transfer_assert_maintenance_guards(),private.employee_transfer_assert_dispatch_config_triggers()');
  assert.deepEqual(await status(), active(job, true));
  for (const table of ['public.dispatch_config', 'public.dispatch_group_orders', 'public.valid_order_data', 'public.used_order_data',
    'public.orders', 'public.users', 'public.wallets', 'public.announcements']) await blocked(`DELETE FROM ${table} WHERE false`);
  await assert.rejects(leave(), /committed writes/);
}));

test('idempotent apply returns original receipt with repeated=true and creates no extra pool/content/member/audit/event rows', () => transaction(async () => {
  await enter(); const plan = await configPlan(), receipt = await apply(plan);
  const before = await businessState(), state = await taskState(job);
  const events = await rows(db, 'SELECT action,details FROM private.employee_transfer_events WHERE job_id=$1 ORDER BY id', [job.job_id]);
  assert.deepEqual(await apply(plan), { ...receipt, repeated: true });
  assert.deepEqual(await businessState(), before); assert.deepEqual(await taskState(job), state);
  assert.deepEqual(await rows(db, 'SELECT action,details FROM private.employee_transfer_events WHERE job_id=$1 ORDER BY id', [job.job_id]), events);
  assert.deepEqual(await status(), active(job, true)); assert.equal(await permitCount(), 0);
  await assert.rejects(apply({ plan_hash: hash('wrong repeat') }), /confirmation/);
  await assert.rejects(configPlan(), /Clean owner maintenance/);
}));

test('source used dependencies remain pending, target valid/used and all employee/order/financial records stay exactly unchanged', () => transaction(async () => {
  assert.equal(preparation.dependencies.orders, 1); assert.equal(preparation.dependencies.employees, 203);
  await enter(); const plan = await configPlan(), before = await unaffected();
  assert.equal((await apply(plan)).dependencies_pending, true);
  assert.deepEqual(await unaffected(), before);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.users WHERE id=$1', [S.employee]), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.orders WHERE id=$1', [S.order]), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.valid_order_data WHERE id=$1', [S.valid]), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.used_order_data'), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_group_members'), 0);
  assert.equal(lines(dispatchPackage.texts.dispatch_group_members).length, 203);
}));

test('source with no content clears all target content rather than preserving target Base defaults', () => transaction(async () => {
  await cancel(job);
  const input = await transaction(async () => {
    await source.exec('DELETE FROM public.dispatch_group_orders');
    return capture('dispatch', sharedPackage.packageId);
  }, source);
  const { task, dry } = await prepare('dispatch', input); await sealBackup('dispatch', task, dry);
  await enter(task, dry); const plan = await configPlan(task); const keep = await unaffected();
  assert.equal((await apply(plan, task)).configuration_applied, true);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_group_orders'), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_group_members'), 0);
  assert.deepEqual(await unaffected(), keep); assert.deepEqual(await status(), active(task, true)); assert.equal(await permitCount(), 0);
}));

for (const [label, extra] of [
  ['secondary administrator', () => ({ p_admin_session_token: branch })],
  ['emergency administrator', () => ({ p_admin_session_token: emergency })],
  ['other super administrator', () => ({ p_admin_session_token: otherSession })],
  ['unknown session', () => ({ p_admin_session_token: randomUUID() })],
  ['null session', () => ({ p_admin_session_token: null })],
  ['unknown task token', () => ({ p_job_token: randomUUID() })],
  ['null task token', () => ({ p_job_token: null })],
]) test(`plan/apply reject ${label} without writes or leaked permits`, () => transaction(async () => {
  await enter(); const plan = await configPlan(), before = await businessState();
  await assert.rejects(configPlan(job, extra()), /Super administrator|invalid or expired/i);
  await assert.rejects(apply(plan, job, extra()), /Super administrator|invalid or expired/i);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await status(), active()); assert.equal(await permitCount(), 0);
}));

for (const field of ['revoked session', 'expired session', 'idle task', 'absolute task']) test(`configuration refuses ${field}`, () => transaction(async () => {
  await enter(); const plan = await configPlan(), before = await businessState();
  if (field === 'revoked session') await db.query('UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1', [NEW.root]);
  if (field === 'expired session') await db.query("UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1", [NEW.root]);
  if (field === 'idle task') await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", [job.job_id]);
  if (field === 'absolute task') await db.query("UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", [job.job_id]);
  await assert.rejects(configPlan(), /invalid or expired/i); await assert.rejects(apply(plan), /invalid or expired/i);
  assert.deepEqual(await businessState(), before); assert.equal(await permitCount(), 0);
  assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), false);
}));

test('no maintenance, no confirmed plan, old preparation hash, null/wrong configuration hash never authorize apply', () => transaction(async () => {
  const before = await businessState();
  await assert.rejects(configPlan(), /Clean owner maintenance/); await assert.rejects(apply(preparation), /Owner maintenance/);
  await enter(); await assert.rejects(apply(preparation), /configuration plan/);
  const plan = await configPlan();
  for (const value of [preparation.plan_hash, hash('wrong'), null]) await assert.rejects(apply(plan, job, { p_plan_hash: value }), /configuration plan/);
  assert.deepEqual(await businessState(), before); assert.equal(await permitCount(), 0); assert.deepEqual(await status(), active());
}));

test('genuinely unsealed preparation cannot enter maintenance or obtain/apply a configuration plan', () => transaction(async () => {
  await cancel(job); const { task, dry } = await prepare(); const before = await businessState();
  await assert.rejects(enter(task, dry), /saved and sealed/);
  await assert.rejects(configPlan(task), /Clean owner maintenance/);
  await assert.rejects(apply({ plan_hash: dry.plan_hash }, task), /Owner maintenance/);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await status(), inactive()); assert.equal(await permitCount(), 0);
}));

// New real dispatch tasks exercise package/site binding, not edits to private job options.
for (const variant of ['wrong package', 'wrong source site']) test(`${variant} cannot borrow a different shared receipt`, () => transaction(async () => {
  await cancel(job);
  let input = dispatchPackage;
  if (variant === 'wrong package') input = { ...input, packageId: randomUUID() };
  else input = await transaction(async () => {
    await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
    return capture('dispatch', sharedPackage.packageId);
  }, source);
  const { task, dry } = await prepare('dispatch', input); await sealBackup('dispatch', task, dry); await enter(task, dry);
  const before = await businessState();
  await assert.rejects(configPlan(task), /matching server-verified shared administrator import receipt/);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await status(), active(task)); assert.equal(await permitCount(), 0);
}));

for (const [label, sql] of [
  ['missing server shared receipt', "UPDATE private.employee_transfer_jobs SET summary=summary-'shared_receipt' WHERE id=$1"],
  ['unapplied shared import', "UPDATE private.employee_transfer_jobs SET summary=summary-'shared_applied' WHERE id=$1"],
  ['receipt map mismatch', "UPDATE private.employee_transfer_jobs SET admin_map='{}' WHERE id=$1"],
]) test(`configuration rejects ${label}, with corruption only in this negative fixture`, () => transaction(async () => {
  await db.query(sql, [sharedJob.job_id]);
  await enter(); const before = await businessState();
  await assert.rejects(configPlan(), /matching server-verified shared administrator import receipt/);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await status(), active()); assert.equal(await permitCount(), 0);
}));

test('creator absent from genuine shared source administrator IDs blocks planning (not supplied by a client map)', () => transaction(async () => {
  await cancel(job);
  const input = await transaction(async () => {
    await source.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES($1,'configuration-not-in-shared','local-only','secondary_admin',false)`, [id(999)]);
    await source.query('UPDATE public.dispatch_order_pools SET created_by=$1 WHERE id=$2', [id(999), S.base]);
    return capture('dispatch', sharedPackage.packageId);
  }, source);
  const { task, dry } = await prepare('dispatch', input); await sealBackup('dispatch', task, dry); await enter(task, dry);
  await assert.rejects(configPlan(task), /matching server-verified shared administrator import receipt/);
  assert.deepEqual(await status(), active(task)); assert.equal(await permitCount(), 0);
}));

for (const [label, change] of [
  ['cross-group source pool ID collision', async () => db.query(`INSERT INTO public.dispatch_order_pools(id,group_id,pool_name,created_by)
    VALUES($1,$2,'佔用來源普通池ID',$3)`, [S.normalBase, T.only, NEW.root])],
  ['base ID occupied by another group', async () => db.query(`INSERT INTO public.dispatch_order_pools(id,group_id,pool_name,created_by)
    VALUES($1,$2,'佔用新組來源BaseID',$3)`, [S.freshBase, T.only, NEW.root])],
]) test(`${label} is reported as a plan conflict and apply never retires any target state`, () => transaction(async () => {
  await cancel(job); await change(); const { task, dry } = await prepare(); await sealBackup('dispatch', task, dry); await enter(task, dry);
  const plan = await configPlan(task), before = await businessState();
  assert.equal(plan.can_apply_configuration, false); assert.ok(plan.conflicts.includes('pool_mapping_collision'));
  await assert.rejects(apply(plan, task), /contains conflicts/);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await status(), active(task)); assert.equal(await permitCount(), 0);
}));

for (const [table, occupied, owner, group] of [
  ['dispatch_groups', T.only, T.default, null],
  ['dispatch_order_pools', T.extra, T.base, T.default],
]) test(`legal target ${table} retirement-name collision is a plan conflict before any configuration write`, () => transaction(async () => {
  await cancel(job);
  const field = table === 'dispatch_groups' ? 'group_name' : 'pool_name';
  const reserved = `transfer-retired-${owner}`;
  // Legal target business rows, not forged source input or a private receipt. The pool
  // fixture must occupy the generated retirement name inside the SAME target group.
  await db.query(`UPDATE public.${table} SET ${field}=$1 WHERE id=$2`, [reserved, occupied]);
  assert.equal(await scalar(db, `SELECT ${field} FROM public.${table} WHERE id=$1`, [occupied]), reserved);
  assert.notEqual(occupied, owner);
  if (group) assert.equal(await scalar(db, `SELECT count(*)::int FROM public.dispatch_order_pools
    WHERE id=ANY($1::uuid[]) AND group_id=$2`, [[occupied, owner], group]), 2);
  const before = await businessState();
  const { task, dry } = await prepare(); await sealBackup('dispatch', task, dry); await enter(task, dry);
  const plan = await configPlan(task), state = await taskState(task);
  assert.equal(plan.can_apply_configuration, false);
  assert.deepEqual(plan.conflicts, ['reserved_retirement_name']);
  assert.equal(plan.replacement_ready, false); assert.equal(plan.full_site_complete, false);
  assert.deepEqual(await configPlan(task), plan);
  await assert.rejects(apply(plan, task), error => {
    assert.match(error.message, /contains conflicts/);
    assert.equal(error.code, 'P0001', 'reject the plan conflict, not a delayed SQL 23505 uniqueness violation');
    return true;
  });
  assert.deepEqual(await businessState(), before); assert.deepEqual(await taskState(task), state);
  assert.deepEqual(await status(), active(task)); assert.equal(await permitCount(), 0);
}));

for (const table of ['dispatch_groups', 'dispatch_order_pools']) test(`reserved retirement names in source ${table} block configuration restoration`, () => transaction(async () => {
  await cancel(job);
  const input = await transaction(async () => {
    await source.query(`UPDATE public.${table} SET ${table === 'dispatch_groups' ? 'group_name' : 'pool_name'}=$1 WHERE id=$2`,
      [`transfer-retired-${id(888)}`, table === 'dispatch_groups' ? S.default : S.base]);
    return capture('dispatch', sharedPackage.packageId);
  }, source);
  const { task, dry } = await prepare('dispatch', input); await sealBackup('dispatch', task, dry); await enter(task, dry);
  const plan = await configPlan(task), before = await businessState();
  assert.equal(plan.can_apply_configuration, false); assert.ok(plan.conflicts.includes('reserved_retirement_name'));
  await assert.rejects(apply(plan, task), /contains conflicts/);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await status(), active(task)); assert.equal(await permitCount(), 0);
}));

test('empty assignments with an unknown BEFORE UPDATE statement trigger reject plan/apply before its body executes', () => transaction(async () => {
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_assignments'), 0);
  await enter(); const plan = await configPlan(), before = await businessState(), state = await taskState(job);
  // nextval is deliberately non-transactional: rolling an RPC back to a savepoint cannot
  // hide an executed trigger body. An ordinary table counter could produce a false pass.
  await db.exec(`CREATE SEQUENCE public.configuration_assignment_trigger_probe;
    CREATE FUNCTION public.configuration_assignment_unreviewed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('public.configuration_assignment_trigger_probe'::regclass); RETURN NULL; END $$;
    CREATE TRIGGER aa_configuration_assignment_unreviewed BEFORE UPDATE ON public.dispatch_assignments
      FOR EACH STATEMENT EXECUTE FUNCTION public.configuration_assignment_unreviewed()`);
  const called = () => scalar(db, 'SELECT is_called FROM public.configuration_assignment_trigger_probe');
  assert.equal(await called(), false);
  await assert.rejects(configPlan(), /Unreviewed dispatch configuration triggers/);
  assert.equal(await called(), false, 'planning must reject the unknown trigger without executing its body');
  await assert.rejects(apply(plan), /Unreviewed dispatch configuration triggers/);
  assert.equal(await called(), false, 'apply must reject before an FK action can execute the empty-table statement trigger');
  assert.deepEqual(await businessState(), before); assert.deepEqual(await taskState(job), state);
  assert.deepEqual(await status(), active()); assert.equal(await permitCount(), 0);
}));

for (const [label, sql] of [
  ['disabled business trigger', 'ALTER TABLE public.dispatch_order_pools DISABLE TRIGGER guard_dispatch_pool_base'],
  ['missing business trigger', 'DROP TRIGGER create_dispatch_base_pool ON public.dispatch_groups'],
  ['replica business trigger', 'ALTER TABLE public.dispatch_group_orders ENABLE REPLICA TRIGGER trigger_check_pool_health_on_deactivate'],
  ['unknown business trigger', `CREATE TRIGGER configuration_unreviewed BEFORE INSERT ON public.dispatch_config FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()`],
  ['disabled maintenance guard', 'ALTER TABLE public.dispatch_groups DISABLE TRIGGER zz_employee_transfer_maintenance'],
  ['changed business function', 'ALTER FUNCTION private.create_dispatch_base_pool() SECURITY INVOKER'],
]) test(`plan/apply fail closed on ${label}`, () => transaction(async () => {
  await enter(); const plan = await configPlan(), before = await businessState(); await db.exec(sql);
  await assert.rejects(configPlan(), /Unreviewed.*(configuration triggers|maintenance)/);
  await assert.rejects(apply(plan), /Unreviewed.*(configuration triggers|maintenance)/);
  assert.deepEqual(await businessState(), before); assert.equal(await permitCount(), 0); assert.deepEqual(await status(), active());
}));

for (const [name, extra] of [
  ['employee_import_finish', { p_summary: { full_site_complete: true } }],
  ['employee_import_apply_core', { p_employee_id: S.employee, p_expected: {} }],
  ['employee_import_rows_batch', { p_employee_id: S.employee, p_table_key: 'orders', p_rows: [] }],
  ['employee_import_chat_batch', { p_employee_id: S.employee, p_table_key: 'chat_messages', p_rows: [] }],
  ['employee_import_shared_apply', { p_plan_hash: hash('old') }],
  ['employee_import_shared_replace_apply', { p_plan_hash: hash('old') }],
  ['employee_import_products_apply', { p_plan_hash: hash('old') }],
]) test(`dispatch task cannot bypass configuration/maintenance through ${name}`, () => transaction(async () => {
  await enter(); const before = await businessState();
  await assert.rejects(rpc(name, { ...auth(), ...extra }), /protocol/);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await status(), active()); assert.equal(await permitCount(), 0);
}));

test('non-dispatch shared and legacy tasks cannot call configuration RPCs, nor accept client maps', () => transaction(async () => {
  await cancel(job);
  const prepared = await prepare('shared', sharedPackage);
  await assert.rejects(configPlan(prepared.task), /protocol/);
  await assert.rejects(apply({ plan_hash: prepared.dry.plan_hash }, prepared.task), /protocol/);
  await cancel(prepared.task);
  // An old task is initialized by its real RPC, not a fabricated private job.
  await db.exec("INSERT INTO public.product_types(name,is_active) VALUES('舊站匯入（精簡訂單）',false) ON CONFLICT(name) DO NOTHING");
  const legacy = await rpc('employee_import_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_decisions: {} });
  await assert.rejects(configPlan(legacy), /protocol/);
  await assert.rejects(apply({ plan_hash: hash('legacy') }, legacy), /protocol/);
  await assert.rejects(configPlan(legacy, { p_admin_map: sharedReceipt.admin_map }), /has no argument p_admin_map/);
  await assert.rejects(apply({ plan_hash: hash('legacy') }, legacy, { p_group_map: {} }), /has no argument p_group_map/);
  assert.equal(await permitCount(), 0);
}));

for (const [label, sql] of [
  ['removed seal', 'UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1'],
  ['changed maintenance target hash', "UPDATE private.employee_transfer_maintenance SET target_hash=repeat('0',64) WHERE job_id=$1"],
]) test(`apply rechecks ${label} after planning and never grants a write permit`, () => transaction(async () => {
  await enter(); const plan = await configPlan(), before = await businessState();
  await db.query(sql, [job.job_id]);
  await assert.rejects(apply(plan), /sealed configuration target changed/);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await status(), active()); assert.equal(await permitCount(), 0);
}));

test('stale server plan after receipt removal cannot execute and rolls back to clean unchanged maintenance', () => transaction(async () => {
  await enter(); const plan = await configPlan(), before = await businessState();
  await db.query("UPDATE private.employee_transfer_jobs SET summary=summary-'shared_receipt' WHERE id=$1", [sharedJob.job_id]);
  await assert.rejects(apply(plan), /matching server-verified shared administrator import receipt/);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await status(), active()); assert.equal(await permitCount(), 0);
}));

test('failure AFTER real configuration writes rolls back target, receipt/event, dirty flag and private permit atomically', () => transaction(async () => {
  await enter(); const plan = await configPlan(), before = await businessState(), state = await taskState(job), triggers = await triggerState();
  // Failure injection on transfer bookkeeping ONLY, not an unreviewed business trigger or
  // private-job success substitute. The genuine apply must reach its final event insert.
  await db.exec(`CREATE FUNCTION public.configuration_fixture_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='dispatch_configuration_applied' THEN RAISE EXCEPTION 'configuration fixture final event failed'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER configuration_fixture_event_failure BEFORE INSERT ON private.employee_transfer_events
      FOR EACH ROW EXECUTE FUNCTION public.configuration_fixture_event_failure()`);
  await assert.rejects(apply(plan), /configuration fixture final event failed/);
  assert.deepEqual(await businessState(), before); assert.deepEqual(await taskState(job), state);
  assert.deepEqual(await status(), active()); assert.equal(await permitCount(), 0);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_events WHERE job_id=$1 AND action='dispatch_configuration_applied'", [job.job_id]), 0);
  await db.exec('DROP TRIGGER configuration_fixture_event_failure ON private.employee_transfer_events; DROP FUNCTION public.configuration_fixture_event_failure()');
  assert.deepEqual(await triggerState(), triggers);
  // A caller can still explicitly leave because no partial configuration write committed.
  assert.equal((await leave()).maintenance, false);
}));

const validBegin = (plan, task = job, extra = {}) => rpc('employee_import_dispatch_valid_begin', {
  ...auth(task), p_plan_hash: plan.plan_hash, ...extra,
});
const validChunk = (no, task = job, extra = {}) => rpc('employee_import_dispatch_valid_chunk', { ...auth(task), p_chunk_no: no, ...extra });
const validVerify = (task = job, extra = {}) => rpc('employee_import_dispatch_valid_verify', { ...auth(task), ...extra });
async function configured() { await enter(); const plan = await configPlan(); await apply(plan); return plan; }
const exceptValid = () => businessState(guarded.filter(key => key !== 'public.valid_order_data'));
async function restoreValid(plan) {
  const start = await validBegin(plan);
  for (let no = 0; no < start.chunks; no++) await validChunk(no);
  return validVerify();
}

for (const [name, parameters] of [
  ['employee_import_dispatch_valid_begin', ['p_admin_session_token','p_job_token','p_plan_hash']],
  ['employee_import_dispatch_valid_chunk', ['p_admin_session_token','p_job_token','p_chunk_no']],
  ['employee_import_dispatch_valid_verify', ['p_admin_session_token','p_job_token']],
]) test(`${name} has fixed authenticated super-admin RPC entry and no caller table/rows/maps`, () => transaction(async () => {
  const fn = (await rows(db, `SELECT proargnames,prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') AS anon,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS everyone
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1`, [name]))[0];
  assert.deepEqual(fn.proargnames, parameters); assert.equal(fn.prosecdef,true); assert.equal(fn.anon,true); assert.equal(fn.everyone,false);
  assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
}));

test('real source valid data is restored across three explicit batches with exact original counters, precision, NULLs and administrator mapping', () => transaction(async () => {
  const plan = await configured(), keep = await exceptValid(), triggers = await triggerState();
  const start = await validBegin(plan);
  assert.deepEqual(start,{success:true,scope:'dispatch-valid-data',rows:0,total_rows:403,next_chunk:0,chunks:3,
    verified:false,repeated:false,maintenance:true,dependencies_pending:true,replacement_ready:false,full_site_complete:false});
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.valid_order_data'),0);
  assert.deepEqual(await validBegin(plan),{...start,repeated:true});
  let progress = 0;
  for (let no = 0; no < start.chunks; no++) {
    const ack = await validChunk(no); progress += no < 2 ? 200 : 3;
    assert.equal(ack.rows,progress); assert.equal(ack.next_chunk,no+1); assert.equal(ack.verified,false);
    assert.equal(ack.maintenance,true); assert.equal(ack.full_site_complete,false); assert.equal(await permitCount(),0);
    assert.deepEqual(await validChunk(no),{...ack,repeated:true});
  }
  const verified = await validVerify(); assert.equal(verified.verified,true); assert.equal(verified.rows,403);
  assert.deepEqual(await validVerify(),{...verified,repeated:true});
  assert.deepEqual(await validChunk(0),{...verified,repeated:true});
  assert.deepEqual(await validBegin(plan),{...verified,repeated:true});
  const query = await scalar(db,"SELECT private.employee_transfer_dispatch_query('valid_order_data')");
  assert.equal(await scalar(db,`WITH expected AS (SELECT id,body||jsonb_build_object('created_by',$2::jsonb->(body->>'created_by')) AS body
    FROM private.employee_transfer_dispatch_input($1,'valid_order_data'))
    SELECT count(*)::int FROM expected FULL JOIN (${query}) AS actual USING(id) WHERE actual.body IS DISTINCT FROM expected.body`,
    [job.job_id,JSON.stringify(sharedReceipt.admin_map)]),0);
  assert.equal(await scalar(db,'SELECT usage_count FROM public.valid_order_data WHERE id=$1',[S.valid]),7);
  assert.equal(await scalar(db,'SELECT product_value::text FROM public.valid_order_data WHERE id=$1',[S.valid]),'12345678901234567890.1234567890123456789');
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.valid_order_data WHERE id=$1',[T.valid]),0);
  assert.deepEqual(await exceptValid(),keep); assert.deepEqual(await triggerState(),triggers);
  assert.deepEqual(await status(),active(job,true)); assert.equal(await permitCount(),0);
  await assert.rejects(leave(),/committed writes/);
  for (const name of ['users','orders','used_order_data','dispatch_group_members']) await blocked(`DELETE FROM public.${name} WHERE false`);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.used_order_data'),0);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.orders'),0);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.users WHERE id=$1',[S.employee]),0);
}));

test('valid-data begin/chunks/verify require actual committed configuration, matching plan and explicit cursor', () => transaction(async () => {
  const before = await businessState();
  await assert.rejects(validBegin(preparation),/Verified configuration/); await assert.rejects(validChunk(0),/Verified configuration/);
  await enter(); const plan = await configPlan(); await assert.rejects(validBegin(plan),/Verified configuration/); await apply(plan);
  const configuredState = await businessState();
  for (const bad of [null,preparation.plan_hash,hash('wrong')]) await assert.rejects(validBegin({plan_hash:bad}),/confirmation/);
  await assert.rejects(validChunk(0),/Begin a bound/); await assert.rejects(validVerify(),/incomplete/);
  assert.deepEqual(await businessState(),configuredState); assert.notDeepEqual(configuredState,before);
  await validBegin(plan); await assert.rejects(validVerify(),/incomplete/);
  for (const bad of [null,-1,1,3,500001]) await assert.rejects(validChunk(bad),/cursor/);
  await validChunk(0); await assert.rejects(validChunk(2),/cursor/); await assert.rejects(validVerify(),/incomplete/);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.valid_order_data'),200); assert.equal(await permitCount(),0);
}));

for (const [label, extra] of [
  ['secondary',()=>({p_admin_session_token:branch})],['emergency',()=>({p_admin_session_token:emergency})],
  ['other super-admin',()=>({p_admin_session_token:otherSession})],['unknown session',()=>({p_admin_session_token:randomUUID()})],
  ['unknown job',()=>({p_job_token:randomUUID()})],['null job',()=>({p_job_token:null})],
]) test(`all valid-data operations reject ${label} without writes`, () => transaction(async () => {
  const plan = await configured(); await validBegin(plan); const keep = await businessState(), state = await taskState(job);
  await assert.rejects(validBegin(plan,job,extra()),/Super administrator|invalid or expired/i);
  await assert.rejects(validChunk(0,job,extra()),/Super administrator|invalid or expired/i);
  await assert.rejects(validVerify(job,extra()),/Super administrator|invalid or expired/i);
  assert.deepEqual(await businessState(),keep); assert.deepEqual(await taskState(job),state); assert.equal(await permitCount(),0);
}));

for (const [label, sql] of [
  ['disabled manual marker','ALTER TABLE public.valid_order_data DISABLE TRIGGER mark_manual_valid_order_deactivation'],
  ['disabled used counter','ALTER TABLE public.used_order_data DISABLE TRIGGER trigger_update_valid_data_usage'],
  ['changed function','ALTER FUNCTION public.update_valid_data_usage_stats() SECURITY DEFINER'],
  ['unknown valid trigger','CREATE TRIGGER valid_unknown BEFORE DELETE ON public.valid_order_data FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['unknown used trigger','CREATE TRIGGER valid_unknown BEFORE DELETE ON public.used_order_data FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
]) test(`valid begin/chunk/verify refuse ${label} before changing target`, () => transaction(async () => {
  const plan = await configured(); await validBegin(plan); await db.exec(sql); const keep = await businessState(), state = await taskState(job);
  for (const action of [()=>validBegin(plan),()=>validChunk(0),()=>validVerify()]) await assert.rejects(action(),/Unreviewed submission/);
  assert.deepEqual(await businessState(),keep); assert.deepEqual(await taskState(job),state); assert.equal(await permitCount(),0);
}));

for (const [label,sql,params] of [
  ['idle task',"UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1",()=>[job.job_id]],
  ['absolute task',"UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1",()=>[job.job_id]],
  ['expired admin',"UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1",()=>[NEW.root]],
  ['revoked admin',"UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1",()=>[NEW.root]],
  ['removed backup seal','UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1',()=>[job.job_id]],
  ['removed shared mapping',"UPDATE private.employee_transfer_jobs SET summary=summary-'shared_receipt' WHERE id=$1",()=>[sharedJob.job_id]],
]) test(`valid restore rechecks ${label} on each explicit operation`,()=>transaction(async()=>{
  const plan=await configured(); await validBegin(plan); await validChunk(0); await db.query(sql,params());
  const keep=await businessState(), state=await taskState(job);
  for(const action of [()=>validBegin(plan),()=>validChunk(1),()=>validVerify()]) await assert.rejects(action(),/invalid or expired|Verified configuration|server-verified/i);
  assert.deepEqual(await businessState(),keep); assert.deepEqual(await taskState(job),state); assert.equal(await permitCount(),0);
  assert.equal(await scalar(db,'SELECT dirty FROM private.employee_transfer_maintenance'),true);
}));

test('changed target since sealed backup is refused, even after configuration committed', () => transaction(async () => {
  const plan = await configured();
  await db.exec('ALTER TABLE public.valid_order_data DISABLE TRIGGER zz_employee_transfer_maintenance');
  await db.query("UPDATE public.valid_order_data SET transaction_id='negative-fixture-target-drift' WHERE id=$1",[T.valid]);
  await db.exec('ALTER TABLE public.valid_order_data ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance');
  const before = await businessState(); await assert.rejects(validBegin(plan),/target changed/);
  assert.deepEqual(await businessState(),before); assert.equal(await permitCount(),0);
}));

for (const action of ['valid_restore_started','valid_restore_chunk','valid_restore_verified']) test(`failure at ${action} rolls back only that request, preserving prior progress and maintenance`, () => transaction(async () => {
  const plan = await configured();
  if (action !== 'valid_restore_started') await validBegin(plan);
  if (action === 'valid_restore_chunk') await validChunk(0);
  if (action === 'valid_restore_verified') for (let no=0;no<3;no++) await validChunk(no);
  const keep = await businessState(), state = await taskState(job);
  await db.exec(`CREATE FUNCTION public.valid_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='${action}' THEN RAISE EXCEPTION 'valid fixture event failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER valid_event_failure BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.valid_event_failure()`);
  await assert.rejects(action==='valid_restore_started'?validBegin(plan):action==='valid_restore_chunk'?validChunk(1):validVerify(),/valid fixture event failure/);
  assert.deepEqual(await businessState(),keep); assert.deepEqual(await taskState(job),state);
  assert.deepEqual(await status(),active(job,true)); assert.equal(await permitCount(),0);
}));

test('repeat chunks and final verify reject a changed committed row rather than accepting an ID-only duplicate', () => transaction(async () => {
  const plan = await configured(); await restoreValid(plan);
  await db.exec('ALTER TABLE public.valid_order_data DISABLE TRIGGER zz_employee_transfer_maintenance');
  await db.query('UPDATE public.valid_order_data SET usage_count=8 WHERE id=$1',[S.valid]);
  await db.exec('ALTER TABLE public.valid_order_data ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance');
  await assert.rejects(validChunk(0),/post-write verification/); await assert.rejects(validVerify(),/post-write verification/);
  await assert.rejects(validBegin(plan),/post-write verification/);
  await assert.rejects(validChunk(2),/post-write verification/);
  assert.equal(await permitCount(),0); assert.deepEqual(await status(),active(job,true));
}));

test('empty source valid data still requires one confirmed empty batch and removes target-only data', () => transaction(async () => {
  await cancel(job);
  const input = await transaction(async () => { await source.exec('DELETE FROM public.used_order_data; DELETE FROM public.valid_order_data'); return capture('dispatch',sharedPackage.packageId); },source);
  const {task,dry} = await prepare('dispatch',input); await sealBackup('dispatch',task,dry); await enter(task,dry);
  const plan = await configPlan(task); await apply(plan,task); const begin = await validBegin(plan,task);
  assert.equal(begin.total_rows,0); assert.equal(begin.chunks,1); assert.equal(begin.verified,false);
  await assert.rejects(validVerify(task),/incomplete/); assert.equal((await validChunk(0,task)).next_chunk,1);
  assert.equal((await validVerify(task)).verified,true); assert.equal(await scalar(db,'SELECT count(*)::int FROM public.valid_order_data'),0);
  assert.deepEqual(await status(),active(task,true)); assert.equal(await permitCount(),0);
}));

test('valid creator absent from actual same-package shared receipt blocks begin rather than trusting a client/default ID', () => transaction(async () => {
  await cancel(job);
  const input = await transaction(async () => {
    await source.query("INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,'valid-unmapped-source','local-only','secondary_admin',false)",[id(999)]);
    await source.query('UPDATE public.valid_order_data SET created_by=$1 WHERE id=$2',[id(999),S.valid]); return capture('dispatch',sharedPackage.packageId);
  },source);
  const {task,dry} = await prepare('dispatch',input); await sealBackup('dispatch',task,dry); await enter(task,dry);
  const plan = await configPlan(task); await apply(plan,task); const keep = await businessState();
  await assert.rejects(validBegin(plan,task),/submission administrator mapping/);
  assert.deepEqual(await businessState(),keep); assert.equal(await permitCount(),0);
}));

const identityBind = (input=identityPackage,extra={}) => rpc('employee_import_identity_bind',{...auth(),p_catalog:input.catalog,...extra});
const identityPlan = (extra={}) => rpc('get_employee_import_identity_plan',{...auth(),...extra});
const identityBegin = (plan,extra={}) => rpc('employee_import_identity_begin',{...auth(),p_plan_hash:plan.plan_hash,...extra});
const identityChunk = (key,no,extra={}) => rpc('employee_import_identity_chunk',{...auth(),p_table_key:key,p_chunk_no:no,...extra});
const identityVerify = (extra={}) => rpc('employee_import_identity_verify',{...auth(),...extra});
async function identityStage(input=identityPackage) {
  await identityBind(input);
  for (const key of IDENTITY) for (const [no,text] of chunks(input.texts[key]).entries())
    await rpc('employee_import_identity_stage',{...auth(),p_table_key:key,p_chunk_no:no,p_ndjson:text});
  return identityPlan();
}
async function identityRestore(plan) {
  const start=await identityBegin(plan);
  for(const key of IDENTITY) for(let no=0;no<start.chunks[key];no++) await identityChunk(key,no);
  return identityVerify();
}
function identityTransport(site,token) {
  modules.identity.setHarness({token,rpc(name,args){const query={abortSignal(){return query;},then(resolve,reject){
    return on(site,name,args).then(data=>({data,error:null})).then(resolve,reject);
  }};return query;}});
}
const identityUnaffected=()=>businessState(guarded.filter(key=>!['users','financial_employee_credentials','wallets','orders','product_types'].map(x=>'public.'+x).includes(key)));

for(const [name,args] of [
  ['employee_export_identity_begin',['p_admin_session_token','p_admin_password','p_package_id']],
  ['get_employee_export_identity_page',['p_admin_session_token','p_job_token','p_table_key','p_after','p_limit']],
  ['employee_export_identity_verify',['p_admin_session_token','p_job_token']],
  ['employee_export_identity_close',['p_admin_session_token','p_job_token']],
  ['employee_import_identity_bind',['p_admin_session_token','p_job_token','p_catalog']],
  ['employee_import_identity_stage',['p_admin_session_token','p_job_token','p_table_key','p_chunk_no','p_ndjson']],
  ['get_employee_import_identity_plan',['p_admin_session_token','p_job_token']],
  ['employee_import_identity_begin',['p_admin_session_token','p_job_token','p_plan_hash']],
  ['employee_import_identity_chunk',['p_admin_session_token','p_job_token','p_table_key','p_chunk_no']],
  ['employee_import_identity_verify',['p_admin_session_token','p_job_token']],
]) test(`${name} uses fixed arguments, definer search path and explicit anon grants`,()=>transaction(async()=>{
  const fn=(await rows(db,`SELECT proargnames,prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') AS anon,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS everyone FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname=$1`,[name]))[0];
  assert.deepEqual(fn.proargnames,args);assert.equal(fn.prosecdef,true);assert.equal(fn.anon,true);assert.equal(fn.everyone,false);
  assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
}));

test('real identity source exports every business account field and two distinct password hashes, but no session or historical details',()=>transaction(async()=>{
  assert.equal(identityPackage.catalog.package_id,dispatchPackage.packageId);
  assert.equal(identityPackage.catalog.site_id,dispatchPackage.catalog.site_id);
  assert.deepEqual(identityPackage.catalog.tables.map(t=>t.rows),[203,1,405]);
  assert.doesNotMatch(identityPackage.texts.accounts,/current_session_token|session_created_at|last_heartbeat_at|current_tab_id|must-not-transfer|archived_at/);
  assert.doesNotMatch(identityPackage.texts.orders,/product_value|product_type_id|username|order_number|transaction_id|source-detail-must-not-transfer|source-transaction-must-not-transfer|assignment_id/);
  const account=JSON.parse(lines(identityPackage.texts.accounts).find(line=>JSON.parse(line).id===S.employee));
  const credential=JSON.parse(identityPackage.texts.credentials);
  assert.notEqual(account.password_hash,credential.password_hash);
  assert.equal(account.is_active,true);assert.equal(account.remarks,'來源員工備註\n𠮷 é é');
  assert.match(identityPackage.texts.orders,/3\.1234567890123456789/);
}));

test('real bound account/credential/order writes preserve all business columns, remain stopped and mint only verified same-package server maps',()=>transaction(async()=>{
  await configured();const keep=await identityUnaffected(),triggers=await triggerState(),plan=await identityStage();
  assert.equal(plan.can_restore,true,JSON.stringify(plan.conflicts));assert.deepEqual(plan.counts,{accounts:203,credentials:1,orders:405});
  assert.doesNotMatch(JSON.stringify(plan),/password_hash|remarks|tags|commission_amount/);
  const start=await identityBegin(plan);assert.equal(start.verified,false);assert.deepEqual(start.chunks,{accounts:2,credentials:1,orders:3});
  await assert.rejects(identityVerify(),/incomplete/);
  await assert.rejects(identityChunk('orders',0),/before dependent orders/);
  await assert.rejects(isolated(db,()=>db.query(`SELECT * FROM private.employee_transfer_verified_identity_map(
    (SELECT j FROM private.employee_transfer_jobs AS j WHERE id=$1),'accounts')`,[job.job_id])),/server-verified/);
  for(const key of IDENTITY) for(let no=0;no<start.chunks[key];no++) {
    const ack=await identityChunk(key,no);assert.equal(ack.verified,false);assert.equal(ack.financial_data_pending,true);
    assert.deepEqual(await identityChunk(key,no),{...ack,repeated:true});assert.equal(await permitCount(),0);
  }
  const receipt=await identityVerify();assert.equal(receipt.verified,true);assert.equal(receipt.maintenance,true);
  assert.equal(receipt.financial_data_pending,true);assert.equal(receipt.dependencies_pending,true);assert.equal(receipt.full_site_complete,false);
  assert.deepEqual(await identityVerify(),{...receipt,repeated:true});assert.deepEqual(await identityBegin(plan),{...receipt,repeated:true});
  assert.deepEqual(await identityChunk('orders',0),{...receipt,repeated:true});
  const accounts=await rows(db,`SELECT * FROM private.employee_transfer_verified_identity_map(
    (SELECT j FROM private.employee_transfer_jobs AS j WHERE id=$1),'accounts')`,[job.job_id]);
  assert.equal(accounts.length,203);assert.ok(accounts.every(row=>row.source_id===row.target_id));
  assert.equal((await rows(db,`SELECT * FROM private.employee_transfer_verified_identity_map(
    (SELECT j FROM private.employee_transfer_jobs AS j WHERE id=$1),'orders')`,[job.job_id])).length,405);
  assert.equal(await scalar(db,`SELECT count(*)::int FROM public.users WHERE id=ANY($1::uuid[]) AND (is_active IS DISTINCT FROM false
    OR current_session_token IS NOT NULL OR current_tab_id IS NOT NULL OR last_heartbeat_at IS NOT NULL OR session_created_at IS NOT NULL)`,[accounts.map(a=>a.target_id)]),0);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.wallets WHERE user_id=ANY($1::uuid[]) AND (available_balance<>0 OR frozen_balance<>0)',[accounts.map(a=>a.target_id)]),0);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.wallet_balance_baselines WHERE user_id=ANY($1::uuid[])',[accounts.map(a=>a.target_id)]),0);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.used_order_data'),0);assert.equal(await scalar(db,'SELECT count(*)::int FROM public.dispatch_group_members'),0);
  assert.equal(await scalar(db,'SELECT is_active FROM public.product_types WHERE name=$1',['舊站匯入（精簡訂單）']),false);
  assert.deepEqual(await identityUnaffected(),keep);assert.deepEqual(await triggerState(),triggers);
  assert.equal(await permitCount(),0);assert.deepEqual(await status(),active(job,true));await assert.rejects(leave(),/committed writes/);
}));

test('real bundled identity client streams source pages through raw files, anon staging, plan and explicit actual apply',()=>transaction(async()=>{
  await configured();const keep=await identityUnaffected();
  const raw=await transaction(async()=>{
    identityTransport(source,sourceSession);const exp=modules.identity.createIdentityExportSession(dispatchPackage.packageId,PASSWORDS.root);
    const cat=await exp.begin(),files=new Map();
    const result=await modules.identity.exportIdentityData(exp.source,{async append(path,bytes){files.set(path,[...(files.get(path)??[]),Buffer.from(bytes)]);},
      async abort(){files.clear();}});
    assert.equal(result.catalog.package_id,cat.package_id);await exp.close();
    return {catalog:cat,files:new Map([...files].map(([key,parts])=>[key,Buffer.concat(parts)]))};
  },source);
  identityTransport(db,session);const imp=modules.identity.createIdentityImportSession(job.job_token);let discarded=0,stagedRows=0;
  const workspace={open(path){return(async function*(){const text=raw.files.get(path);for(let n=0;n<text.length;n+=65521) yield text.subarray(n,n+65521);})();},async abort(){discarded++;}};
  const staged=await modules.identity.stageIdentityImport(raw.catalog,workspace,imp.target,{onProgress(p){if(p.phase==='stage')stagedRows=p.rows;}});
  assert.equal(discarded,1);assert.equal(stagedRows,609);assert.equal(staged.plan.can_restore,true);
  const started=await imp.begin(staged.plan.plan_hash);
  for(const key of IDENTITY)for(let no=0;no<started.chunks[key];no++)await imp.chunk(key,no);
  assert.equal((await imp.verify()).verified,true);assert.deepEqual(await identityUnaffected(),keep);assert.equal(await permitCount(),0);
}));

for(const [label,change,reason] of [
  ['same source ID as target',()=>addEmployee(source,T.employee,OLD.branch),'employee_id_conflict'],
  ['same username',()=>source.query('UPDATE public.users SET username=$1 WHERE id=$2',[`configuration-${T.employee}`,S.employee]),'username_requires_archive'],
  ['same employee number',()=>source.query('UPDATE public.users SET employee_id=$1 WHERE id=$2',[`CFG-${T.employee}`,S.employee]),'employee_number_conflict'],
  ['administrator username',()=>source.query("UPDATE public.users SET username='root' WHERE id=$1",[S.employee]),'administrator_username_conflict'],
]) test(`identity plan blocks ${label} without skipping, overwriting or enabling a target employee`,()=>transaction(async()=>{
  await configured();const input=await transaction(async()=>{await change();return capture('identity',dispatchPackage.packageId);},source);
  const keep=await businessState(),plan=await identityStage(input);assert.equal(plan.can_restore,false);
  assert.ok(plan.conflicts.some(c=>c.reason===reason));await assert.rejects(identityBegin(plan),/unresolved conflicts/);
  assert.deepEqual(await businessState(),keep);assert.equal(await permitCount(),0);
}));

for(const [label,catalog] of [
  ['wrong package',()=>({...identityPackage.catalog,package_id:randomUUID()})],
  ['wrong site',()=>({...identityPackage.catalog,site_id:randomUUID()})],
]) test(`identity binding refuses ${label} and cannot borrow another source receipt`,()=>transaction(async()=>{
  await configured();const keep=await businessState();await assert.rejects(identityBind({catalog:catalog()}),/match the dispatch site and package/);
  assert.deepEqual(await businessState(),keep);assert.equal(await permitCount(),0);
}));

test('identity binding is immutable, frozen staging cannot change and old employee APIs cannot enable the imported account',()=>transaction(async()=>{
  await configured();const plan=await identityStage();await identityBegin(plan);await identityChunk('accounts',0);
  await assert.rejects(identityBind({catalog:{...identityPackage.catalog,processing_orders:99}}),/immutable/);
  await assert.rejects(rpc('employee_import_identity_stage',{...auth(),p_table_key:'accounts',p_chunk_no:0,p_ndjson:identityPackage.texts.accounts.replace('identity-source-1','changed-identity-source-1')}),/chunk|row|order/);
  assert.equal((await rpc('employee_import_identity_stage',{...auth(),p_table_key:'accounts',p_chunk_no:0,p_ndjson:chunks(identityPackage.texts.accounts)[0]})).repeated,true);
  await assert.rejects(rpc('employee_import_finalize_employee',{...auth(),p_employee_id:S.employee,p_expected:{}}),/protocol/);
  await assert.rejects(rpc('employee_import_finish',{...auth(),p_summary:{full_site_complete:true}}),/protocol/);
  assert.equal(await scalar(db,'SELECT is_active FROM public.users WHERE id=$1',[S.employee]),false);assert.equal(await permitCount(),0);
}));

for(const [label,sql] of [
  ['unknown users trigger','CREATE TRIGGER aa_identity_unknown BEFORE INSERT ON public.users FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['changed wallet function','ALTER FUNCTION public.create_wallet_for_new_user() SECURITY INVOKER'],
  ['disabled order trigger','ALTER TABLE public.orders DISABLE TRIGGER trigger_sync_order_to_wallet'],
  ['replica snapshot trigger','ALTER TABLE public.orders ENABLE REPLICA TRIGGER snapshot_order_dispatch_rates'],
]) test(`identity restore rejects ${label} without leaving bypasses or write permits`,()=>transaction(async()=>{
  await configured();const plan=await identityStage();await identityBegin(plan);await db.exec(sql);const keep=await businessState(),state=await taskState(job);
  await assert.rejects(identityChunk('accounts',0),/Unreviewed employee identity/);
  assert.deepEqual(await businessState(),keep);assert.deepEqual(await taskState(job),state);assert.equal(await permitCount(),0);
}));

for(const action of ['identity_restore_started','identity_restore_chunk','identity_restore_verified'])test(`failure at ${action} rolls back request-local accounts/wallets/orders and restores trigger modes`,()=>transaction(async()=>{
  await configured();const plan=await identityStage();
  if(action!=='identity_restore_started')await identityBegin(plan);
  if(action==='identity_restore_verified') {const start=await identityBegin(plan);for(const key of IDENTITY)for(let no=0;no<start.chunks[key];no++)await identityChunk(key,no);}
  const keep=await businessState(),state=await taskState(job),triggers=await triggerState();
  await db.exec(`CREATE FUNCTION public.identity_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='${action}' THEN RAISE EXCEPTION 'identity fixture event failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER identity_event_failure BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.identity_event_failure()`);
  await assert.rejects(action==='identity_restore_started'?identityBegin(plan):action==='identity_restore_chunk'?identityChunk('accounts',0):identityVerify(),/identity fixture event failure/);
  assert.deepEqual(await businessState(),keep);assert.deepEqual(await taskState(job),state);
  await db.exec('DROP TRIGGER identity_event_failure ON private.employee_transfer_events; DROP FUNCTION public.identity_event_failure()');
  assert.deepEqual(await triggerState(),triggers);assert.equal(await permitCount(),0);assert.deepEqual(await status(),active(job,true));
}));

for(const [label,extra]of [
  ['secondary',()=>({p_admin_session_token:branch})],['emergency',()=>({p_admin_session_token:emergency})],
  ['other super-admin',()=>({p_admin_session_token:otherSession})],['unknown token',()=>({p_job_token:randomUUID()})],
])test(`identity operations reject ${label}`,()=>transaction(async()=>{
  await configured();const plan=await identityStage();const keep=await businessState();
  for(const action of [()=>identityBind(identityPackage,extra()),()=>identityPlan(extra()),()=>identityBegin(plan,extra()),()=>identityChunk('accounts',0,extra()),()=>identityVerify(extra())])
    await assert.rejects(action(),/Super administrator|invalid or expired/i);
  assert.deepEqual(await businessState(),keep);assert.equal(await permitCount(),0);
}));

for(const nullableTarget of [false,true]) test(`source NULL employee owner is ${nullableTarget?'preserved by nullable target':'blocked by strict target without assigning a default'}`,()=>transaction(async()=>{
  await configured();
  const input=await transaction(async()=>{
    await source.exec('ALTER TABLE public.users DROP CONSTRAINT users_created_by_required; ALTER TABLE public.users ALTER COLUMN created_by DROP NOT NULL');
    await source.query('UPDATE public.users SET created_by=NULL WHERE id=$1',[S.employee]);return capture('identity',dispatchPackage.packageId);
  },source);
  if(nullableTarget)await db.exec('ALTER TABLE public.users DROP CONSTRAINT users_created_by_required; ALTER TABLE public.users ALTER COLUMN created_by DROP NOT NULL');
  const plan=await identityStage(input);assert.equal(plan.can_restore,nullableTarget);
  if(nullableTarget){await identityRestore(plan);assert.equal(await scalar(db,'SELECT created_by FROM public.users WHERE id=$1',[S.employee]),null);}
  else {assert.ok(plan.conflicts.some(c=>c.reason==='unmapped_administrator'));await assert.rejects(identityBegin(plan),/unresolved conflicts/);}
  assert.equal(await permitCount(),0);
}));

test('nullable owner column with a retained required-owner CHECK blocks NULL source before inserts',()=>transaction(async()=>{
  await configured();const input=await transaction(async()=>{
    await source.exec('ALTER TABLE public.users DROP CONSTRAINT users_created_by_required; ALTER TABLE public.users ALTER COLUMN created_by DROP NOT NULL');
    await source.query('UPDATE public.users SET created_by=NULL WHERE id=$1',[S.employee]);return capture('identity',dispatchPackage.packageId);
  },source);
  await db.exec('ALTER TABLE public.users ALTER COLUMN created_by DROP NOT NULL');
  const keep=await businessState(),plan=await identityStage(input);assert.equal(plan.can_restore,false);
  assert.ok(plan.conflicts.some(c=>c.reason==='unmapped_administrator'));await assert.rejects(identityBegin(plan),/unresolved conflicts/);
  assert.deepEqual(await businessState(),keep);assert.equal(await permitCount(),0);
}));

test('same order UUID in target blocks identity plan without silently skipping historical content',()=>transaction(async()=>{
  await db.query("INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Identity conflict target fixture',false)",[NEW.product]);
  await configured();
  const disabled=await scalar(db,"SELECT private.employee_transfer_bypass_triggers(ARRAY['orders'])");
  await db.exec('ALTER TABLE public.orders DISABLE TRIGGER zz_employee_transfer_maintenance');
  await db.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status)
    VALUES($1,$2,$3,$4,1,'negative-existing-order','negative-existing-tx','failure')`,[S.order,T.employee,`configuration-${T.employee}`,NEW.product]);
  await db.exec('ALTER TABLE public.orders ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance');
  await db.query('SELECT private.employee_transfer_restore_triggers($1::jsonb)',[JSON.stringify(disabled)]);
  const keep=await businessState(),plan=await identityStage();assert.equal(plan.can_restore,false);assert.ok(plan.conflicts.some(c=>c.reason==='order_id_conflict'));
  await assert.rejects(identityBegin(plan),/unresolved conflicts/);assert.deepEqual(await businessState(),keep);
}));

for(const field of ['remarks','is_active','session','order_details'])test(`identity verify/repeated begin/repeated chunk reject changed ${field}, even after success`,()=>transaction(async()=>{
  await configured();const plan=await identityStage();await identityRestore(plan);
  const table=field==='order_details'?'orders':'users';await db.exec(`ALTER TABLE public.${table} DISABLE TRIGGER zz_employee_transfer_maintenance`);
  if(field==='remarks')await db.query("UPDATE public.users SET remarks='negative-drift' WHERE id=$1",[S.employee]);
  if(field==='is_active')await db.query('UPDATE public.users SET is_active=true WHERE id=$1',[S.employee]);
  if(field==='session')await db.query('UPDATE public.users SET current_session_token=$2 WHERE id=$1',[S.employee,randomUUID()]);
  if(field==='order_details')await db.query("UPDATE public.orders SET transaction_id='negative-unapproved-detail' WHERE id=$1",[S.order]);
  await db.exec(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance`);
  for(const action of [()=>identityVerify(),()=>identityBegin(plan),()=>identityChunk('credentials',0)])await assert.rejects(action(),/post-write|disabled|historical details/);
  await assert.rejects(isolated(db,()=>db.query(`SELECT * FROM private.employee_transfer_verified_identity_map(
    (SELECT j FROM private.employee_transfer_jobs AS j WHERE id=$1),'accounts')`,[job.job_id])),/post-write|disabled|historical details/);
  assert.equal(await permitCount(),0);
}));

for(const [label,sql,parameters]of [
  ['expired session',"UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1",()=>[NEW.root]],
  ['idle job',"UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1",()=>[job.job_id]],
  ['absolute job',"UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1",()=>[job.job_id]],
  ['unsealed backup','UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1',()=>[job.job_id]],
  ['removed shared receipt',"UPDATE private.employee_transfer_jobs SET summary=summary-'shared_receipt' WHERE id=$1",()=>[sharedJob.job_id]],
])test(`identity restore rechecks ${label} between committed chunks`,()=>transaction(async()=>{
  await configured();const plan=await identityStage();await identityBegin(plan);await identityChunk('accounts',0);await db.query(sql,parameters());
  const keep=await businessState(),state=await taskState(job);
  for(const action of [()=>identityBegin(plan),()=>identityChunk('accounts',1),()=>identityVerify()])await assert.rejects(action(),/invalid or expired|running dispatch owner|server-verified/i);
  assert.deepEqual(await businessState(),keep);assert.deepEqual(await taskState(job),state);assert.equal(await permitCount(),0);
}));

test('identity source changes with identical row counts invalidate final export verification and never advance full-site export time',()=>transaction(async()=>{
  await transaction(async()=>{
    const task=await on(source,'employee_export_identity_begin',{p_admin_session_token:sourceSession,p_admin_password:PASSWORDS.root,p_package_id:dispatchPackage.packageId});
    await assert.rejects(on(source,'employee_export_identity_close',auth(task,sourceSession)),/not been verified/);
    await source.query("UPDATE public.users SET remarks='source-same-count-drift' WHERE id=$1",[S.employee]);
    await assert.rejects(on(source,'employee_export_identity_verify',auth(task,sourceSession)),/source changed/);
    for(const name of ['get_employee_export_core','employee_export_dispatch_verify'])await assert.rejects(on(source,name,{...auth(task,sourceSession),...(name.endsWith('_core')?{p_employee_id:S.employee}:{})}),/protocol/);
  },source);
  const log=await transaction(()=>on(source,'get_employee_transfer_log',{p_admin_session_token:sourceSession}),source);assert.equal(log.last_export_at,null);
}));

const DEPENDENCIES = ['dispatch_group_members', 'used_order_data'];
const dependencyPlan = (extra={}) => rpc('get_employee_import_dispatch_dependency_plan',{...auth(),...extra});
const dependencyBegin = (plan,extra={}) => rpc('employee_import_dispatch_dependency_begin',{...auth(),p_plan_hash:plan.plan_hash,...extra});
const dependencyChunk = (key,no,extra={}) => rpc('employee_import_dispatch_dependency_chunk',{...auth(),p_table_key:key,p_chunk_no:no,...extra});
const dependencyVerify = (extra={}) => rpc('employee_import_dispatch_dependency_verify',{...auth(),...extra});
async function dependencyReady() {
  const configuration=await configured();await restoreValid(configuration);await identityRestore(await identityStage());return configuration;
}
async function dependencyRestore(plan) {
  const start=await dependencyBegin(plan);
  for(const key of DEPENDENCIES)for(let no=0;no<start.chunks[key];no++)await dependencyChunk(key,no);
  return dependencyVerify();
}
const dependencyUnaffected = () => businessState(guarded.filter(name=>!DEPENDENCIES.map(key=>'public.'+key).includes(name)));

for(const [name,args]of [
  ['get_employee_import_dispatch_dependency_plan',['p_admin_session_token','p_job_token']],
  ['employee_import_dispatch_dependency_begin',['p_admin_session_token','p_job_token','p_plan_hash']],
  ['employee_import_dispatch_dependency_chunk',['p_admin_session_token','p_job_token','p_table_key','p_chunk_no']],
  ['employee_import_dispatch_dependency_verify',['p_admin_session_token','p_job_token']],
])test(`${name} has explicit grants and no client maps/rows`,()=>transaction(async()=>{
  const fn=(await rows(db,`SELECT proargnames,prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') AS anon,
    has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS everyone FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname=$1`,[name]))[0];
  assert.deepEqual(fn.proargnames,args);assert.equal(fn.prosecdef,true);assert.equal(fn.anon,true);assert.equal(fn.authenticated,true);
  assert.equal(fn.everyone,false);assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
}));

test('source members replace target membership exactly and used writes preserve all valid fields without double counting',()=>transaction(async()=>{
  await dependencyReady();const keep=await dependencyUnaffected(),triggers=await triggerState(),plan=await dependencyPlan();
  assert.equal(plan.can_restore,true);assert.deepEqual(plan.counts,{dispatch_group_members:203,used_order_data:1});
  assert.deepEqual(plan.conflicts,[]);assert.doesNotMatch(JSON.stringify(plan),/password|remarks|transaction_id|user_id/);
  const start=await dependencyBegin(plan);assert.equal(start.verified,false);assert.deepEqual(start.chunks,{dispatch_group_members:2,used_order_data:1});
  await assert.rejects(dependencyVerify(),/incomplete/);await assert.rejects(dependencyChunk('used_order_data',0),/before used submission/);
  await assert.rejects(dependencyChunk('dispatch_group_members',1),/committed cursor/);
  for(const key of DEPENDENCIES)for(let no=0;no<start.chunks[key];no++){
    const ack=await dependencyChunk(key,no);assert.equal(ack.verified,false);assert.equal(ack.financial_data_pending,true);
    assert.deepEqual(await dependencyChunk(key,no),{...ack,repeated:true});assert.deepEqual(await dependencyPlan(),plan);assert.equal(await permitCount(),0);
  }
  const result=await dependencyVerify();assert.equal(result.verified,true);assert.equal(result.full_site_complete,false);
  assert.equal(result.maintenance,true);assert.equal(result.dependencies_pending,true);assert.equal(result.financial_data_pending,true);
  assert.deepEqual(result.counts,plan.counts);assert.deepEqual(await dependencyVerify(),{...result,repeated:true});
  assert.deepEqual(await dependencyBegin(plan),{...result,repeated:true});assert.deepEqual(await dependencyChunk('used_order_data',0),{...result,repeated:true});
  for(const key of DEPENDENCIES){
    assert.equal(await scalar(db,`SELECT count(*)::int FROM public.${key}`),plan.counts[key]);
    for(const source of lines(dispatchPackage.texts[key])){
      const row=JSON.parse(source),actual=await scalar(db,`SELECT to_jsonb(r) FROM public.${key} AS r WHERE id=$1`,[row.id]);
      const expected=key==='dispatch_group_members'?{...row,group_id:row.group_id===S.default?T.default:row.group_id,assigned_by:sharedReceipt.admin_map[row.assigned_by]??null}:row;
      assert.equal(await scalar(db,`SELECT to_jsonb(r)=$2::jsonb FROM public.${key} AS r WHERE id=$1`,
        [row.id,JSON.stringify(expected)]),true,JSON.stringify(actual));
    }
  }
  assert.equal(await scalar(db,'SELECT usage_count FROM public.valid_order_data WHERE id=$1',[S.valid]),7);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.dispatch_group_members WHERE user_id=ANY($1::uuid[])',[[T.employee,T.employee2]]),0);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.dispatch_group_members WHERE group_id=$1',[T.match]),0);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.users WHERE is_active AND id IN(SELECT user_id FROM public.dispatch_group_members)'),0);
  assert.deepEqual(await dependencyUnaffected(),keep);assert.deepEqual(await triggerState(),triggers);assert.equal(await permitCount(),0);
  assert.deepEqual(await status(),active(job,true));await assert.rejects(leave(),/committed writes/);
  await blocked('UPDATE public.valid_order_data SET usage_count=usage_count+1 WHERE false');
}));

test('real lightweight dependency client performs explicit plan/begin/chunks/verify and fresh-factory resume against anon SQL',()=>transaction(async()=>{
  await dependencyReady();identityTransport(db,session);const imp=modules.identity.createDispatchDependencySession(job.job_token);
  const keep=await dependencyUnaffected(),plan=await imp.plan(),start=await imp.begin(plan.plan_hash);
  await imp.chunk('dispatch_group_members',0);
  const resumed=modules.identity.createDispatchDependencySession(job.job_token);assert.deepEqual(await resumed.plan(),plan);
  const progress=await resumed.begin(plan.plan_hash);assert.equal(progress.repeated,true);assert.equal(progress.counts.dispatch_group_members,200);
  await resumed.chunk('dispatch_group_members',1);await resumed.chunk('used_order_data',0);
  assert.equal((await resumed.verify()).verified,true);assert.equal(start.verified,false);assert.deepEqual(await dependencyUnaffected(),keep);
}));

for(const [label,prepareStage]of [
  ['no configuration',async()=>{}],['no identity receipt',async()=>{const plan=await configured();await restoreValid(plan);}],
  ['identity not verified',async()=>{const plan=await configured();await restoreValid(plan);const identity=await identityStage();await identityBegin(identity);}],
  ['valid not verified',async()=>{const plan=await configured();await identityRestore(await identityStage());await validBegin(plan);}],
])test(`dependency planning refuses ${label} without trusting old identity drafts`,()=>transaction(async()=>{
  await prepareStage();const keep=await businessState();await assert.rejects(dependencyPlan(),/running dispatch owner|server-verified|same-package/);
  assert.deepEqual(await businessState(),keep);assert.equal(await permitCount(),0);
}));

for(const [label,sql]of [
  ['unknown member trigger','CREATE TRIGGER aa_dependency_unknown BEFORE INSERT ON public.dispatch_group_members FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['unknown used trigger','CREATE TRIGGER aa_dependency_unknown BEFORE INSERT ON public.used_order_data FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['disabled usage trigger','ALTER TABLE public.used_order_data DISABLE TRIGGER trigger_update_valid_data_usage'],
  ['replica usage trigger','ALTER TABLE public.used_order_data ENABLE REPLICA TRIGGER trigger_update_valid_data_usage'],
  ['changed usage function','ALTER FUNCTION public.update_valid_data_usage_stats() SECURITY DEFINER'],
  ['disabled maintenance','ALTER TABLE public.used_order_data DISABLE TRIGGER zz_employee_transfer_maintenance'],
])test(`dependency stage rejects ${label} before issuing permits`,()=>transaction(async()=>{
  await dependencyReady();const plan=await dependencyPlan();await dependencyBegin(plan);await db.exec(sql);const keep=await businessState(),state=await taskState(job);
  for(const action of [()=>dependencyPlan(),()=>dependencyBegin(plan),()=>dependencyChunk('dispatch_group_members',0),()=>dependencyVerify()])
    await assert.rejects(action(),/Unreviewed|maintenance guard/);
  assert.deepEqual(await businessState(),keep);assert.deepEqual(await taskState(job),state);assert.equal(await permitCount(),0);
}));

for(const [label,table,sql,args]of [
  ['member group','dispatch_group_members','UPDATE public.dispatch_group_members SET group_id=$2 WHERE user_id=$1',()=>[S.employee,T.match]],
  ['member timestamp','dispatch_group_members',"UPDATE public.dispatch_group_members SET assigned_at=assigned_at+interval '1 microsecond' WHERE user_id=$1",()=>[S.employee]],
  ['used employee/order','used_order_data','UPDATE public.used_order_data SET user_id=$2 WHERE id=$1',()=>[S.used,T.employee]],
  ['valid usage','valid_order_data','UPDATE public.valid_order_data SET usage_count=usage_count+1 WHERE id=$1',()=>[S.valid]],
  ['valid last-used','valid_order_data',"UPDATE public.valid_order_data SET last_used_at=last_used_at+interval '1 microsecond' WHERE id=$1",()=>[S.valid]],
  ['valid content','valid_order_data',"UPDATE public.valid_order_data SET transaction_id='negative-drift' WHERE id=$1",()=>[S.valid]],
  ['group configuration','dispatch_groups',"UPDATE public.dispatch_groups SET description='negative-drift' WHERE id=$1",()=>[T.default]],
  ['employee identity','users',"UPDATE public.users SET remarks='negative-drift' WHERE id=$1",()=>[S.employee]],
])test(`even completed/repeated dependency calls reject same-count ${label} drift`,()=>transaction(async()=>{
  await dependencyReady();const plan=await dependencyPlan();await dependencyRestore(plan);
  await db.exec(`ALTER TABLE public.${table} DISABLE TRIGGER zz_employee_transfer_maintenance`);await db.query(sql,args());
  await db.exec(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance`);
  const keep=await businessState(),state=await taskState(job);
  for(const action of [()=>dependencyPlan(),()=>dependencyBegin(plan),()=>dependencyChunk('used_order_data',0),()=>dependencyVerify()])
    await assert.rejects(action(),/post-write|contents changed|verification failed/);
  assert.deepEqual(await businessState(),keep);assert.deepEqual(await taskState(job),state);assert.equal(await permitCount(),0);
}));

for(const action of ['dispatch_dependencies_started','dispatch_dependencies_chunk','dispatch_dependencies_verified'])test(`late ${action} failure rolls back only this request and restores the usage trigger`,()=>transaction(async()=>{
  await dependencyReady();const plan=await dependencyPlan();
  if(action!=='dispatch_dependencies_started'){const start=await dependencyBegin(plan);for(let no=0;no<start.chunks.dispatch_group_members;no++)await dependencyChunk('dispatch_group_members',no);}
  if(action==='dispatch_dependencies_verified')await dependencyChunk('used_order_data',0);
  const keep=await businessState(),state=await taskState(job),triggers=await triggerState();
  await db.exec(`CREATE FUNCTION public.dependency_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='${action}' THEN RAISE EXCEPTION 'dependency fixture final event failed'; END IF;RETURN NEW;END $$;
    CREATE TRIGGER dependency_event_failure BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.dependency_event_failure()`);
  await assert.rejects(action==='dispatch_dependencies_started'?dependencyBegin(plan):action==='dispatch_dependencies_chunk'?dependencyChunk('used_order_data',0):dependencyVerify(),/dependency fixture final event failed/);
  assert.deepEqual(await businessState(),keep);assert.deepEqual(await taskState(job),state);assert.equal(await permitCount(),0);
  await db.exec('DROP TRIGGER dependency_event_failure ON private.employee_transfer_events;DROP FUNCTION public.dependency_event_failure()');
  assert.deepEqual(await triggerState(),triggers);assert.deepEqual(await status(),active(job,true));
}));

for(const [label,extra]of [
  ['secondary',()=>({p_admin_session_token:branch})],['emergency',()=>({p_admin_session_token:emergency})],
  ['other super-admin',()=>({p_admin_session_token:otherSession})],['invalid task',()=>({p_job_token:randomUUID()})],
])test(`dependency operations reject ${label} and cannot accept client ID maps`,()=>transaction(async()=>{
  await dependencyReady();const plan=await dependencyPlan(),keep=await businessState();
  for(const action of [()=>dependencyPlan(extra()),()=>dependencyBegin(plan,extra()),()=>dependencyChunk('used_order_data',0,extra()),()=>dependencyVerify(extra())])
    await assert.rejects(action(),/Super administrator|invalid or expired/i);
  await assert.rejects(dependencyPlan({p_employee_map:{[S.employee]:S.employee}}),/has no argument/);
  assert.deepEqual(await businessState(),keep);assert.equal(await permitCount(),0);
}));

for(const [label,sql,args]of [
  ['expired session',"UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1",()=>[NEW.root]],
  ['expired task',"UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1",()=>[job.job_id]],
  ['lost seal','UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1',()=>[job.job_id]],
  ['lost shared receipt',"UPDATE private.employee_transfer_jobs SET summary=summary-'shared_receipt' WHERE id=$1",()=>[sharedJob.job_id]],
])test(`dependency continuation revalidates ${label} without releasing dirty maintenance`,()=>transaction(async()=>{
  await dependencyReady();const plan=await dependencyPlan();await dependencyBegin(plan);await dependencyChunk('dispatch_group_members',0);
  await db.query(sql,args());const keep=await businessState(),state=await taskState(job);
  for(const action of [()=>dependencyBegin(plan),()=>dependencyChunk('dispatch_group_members',1),()=>dependencyVerify()])
    await assert.rejects(action(),/invalid or expired|running dispatch owner|server-verified/);
  assert.deepEqual(await businessState(),keep);assert.deepEqual(await taskState(job),state);assert.equal(await permitCount(),0);
}));

test('extra target membership is reported, never deleted or unioned into the source membership',()=>transaction(async()=>{
  await dependencyReady();await db.exec('ALTER TABLE public.dispatch_group_members DISABLE TRIGGER zz_employee_transfer_maintenance');
  await db.query('INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by) VALUES($1,$2,$3)',[T.match,T.employee,NEW.root]);
  await db.exec('ALTER TABLE public.dispatch_group_members ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance');
  const keep=await businessState(),plan=await dependencyPlan();assert.equal(plan.can_restore,false);assert.deepEqual(plan.conflicts,['target_members_not_empty']);
  await assert.rejects(dependencyBegin(plan),/unresolved conflicts/);assert.deepEqual(await businessState(),keep);
}));

test('dependency keys/cursors/plan hashes and all private write helpers are guarded',()=>transaction(async()=>{
  await dependencyReady();const plan=await dependencyPlan();await assert.rejects(dependencyBegin({plan_hash:hash('wrong')}),/matching dispatch dependency plan/);
  await dependencyBegin(plan);const keep=await businessState();
  for(const key of [null,'orders','valid_order_data','dispatch_group_members;DROP TABLE users'])await assert.rejects(dependencyChunk(key,0),/Unsupported/);
  for(const no of [null,-1,2,500001])await assert.rejects(dependencyChunk('dispatch_group_members',no),/committed cursor/);
  const helpers=await rows(db,`SELECT oid,proname FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%dependency%'`);
  assert.ok(helpers.length>=7);for(const fn of helpers)for(const role of ['anon','authenticated','service_role'])
    assert.equal(await scalar(db,"SELECT has_function_privilege($1,$2::oid,'EXECUTE')",[role,fn.oid]),false,fn.proname);
  assert.deepEqual(await businessState(),keep);assert.equal(await permitCount(),0);
}));

async function withDependencyVariant(change,run) {
  const input=await transaction(async()=>{await change();return capture('dispatch',sharedPackage.packageId);},source);
  const savedJob=job,savedPreparation=preparation;
  await cancel(job);
  try {
    const prepared=await prepare('dispatch',input);job=prepared.task;preparation=prepared.dry;
    await sealBackup('dispatch',job,preparation);await dependencyReady();await run(input);
  } finally {job=savedJob;preparation=savedPreparation;}
}

test('203 used records restore in multiple committed chunks without recalculating NULL, maximum counts or last-used time',()=>transaction(()=>withDependencyVariant(async()=>{
  await source.exec('UPDATE public.valid_order_data SET usage_count=CASE WHEN usage_count IS NULL THEN NULL ELSE 6 END');
  await source.query(`INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at)
    SELECT ('12000000-0000-4000-8000-'||lpad(to_hex(8000+n),12,'0'))::uuid,
      ('12000000-0000-4000-8000-'||lpad(to_hex(2000+n),12,'0'))::uuid,
      ('12000000-0000-4000-8000-'||lpad(to_hex(1000+n),12,'0'))::uuid,
      ('12000000-0000-4000-8000-'||lpad(to_hex(3000+2*n),12,'0'))::uuid,
      '2021-03-04T05:06:07.123456Z' FROM generate_series(1,202) AS x(n)`);
  await source.query(`UPDATE public.valid_order_data SET usage_count=CASE WHEN usage_count IS NULL THEN NULL ELSE 2147483647 END,
    last_used_at=CASE WHEN usage_count IS NULL THEN NULL ELSE '2030-03-04T05:06:07.654321Z'::timestamptz END`);
},async()=>{
  const keep=await dependencyUnaffected(),plan=await dependencyPlan(),start=await dependencyBegin(plan);
  assert.equal(plan.counts.used_order_data,203);assert.equal(start.chunks.used_order_data,2);
  for(let no=0;no<start.chunks.dispatch_group_members;no++)await dependencyChunk('dispatch_group_members',no);
  assert.equal((await dependencyChunk('used_order_data',0)).counts.used_order_data,200);
  assert.equal((await dependencyChunk('used_order_data',0)).counts.used_order_data,200);
  assert.equal((await dependencyChunk('used_order_data',1)).counts.used_order_data,203);
  assert.equal((await dependencyVerify()).verified,true);assert.deepEqual(await dependencyUnaffected(),keep);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.used_order_data'),203);assert.equal(await permitCount(),0);
})));

test('empty source member and used sets complete only after explicit zero-row chunks and retain no target memberships',()=>transaction(()=>withDependencyVariant(async()=>{
  await source.exec('DELETE FROM public.used_order_data;DELETE FROM public.dispatch_group_members');
},async()=>{
  const plan=await dependencyPlan(),start=await dependencyBegin(plan);assert.deepEqual(plan.counts,{dispatch_group_members:0,used_order_data:0});
  assert.deepEqual(start.chunks,{dispatch_group_members:1,used_order_data:1});await assert.rejects(dependencyVerify(),/incomplete/);
  await dependencyChunk('dispatch_group_members',0);await dependencyChunk('used_order_data',0);assert.equal((await dependencyVerify()).verified,true);
  assert.equal(await scalar(db,'SELECT count(*)::int FROM public.dispatch_group_members'),0);assert.equal(await scalar(db,'SELECT count(*)::int FROM public.used_order_data'),0);
})));

test('NULL source assigner/member timestamp and used timestamp are not replaced with defaults',()=>transaction(()=>withDependencyVariant(async()=>{
  await source.query('UPDATE public.dispatch_group_members SET assigned_by=NULL,assigned_at=NULL WHERE user_id=$1',[S.employee]);
  await source.query('UPDATE public.used_order_data SET created_at=NULL WHERE id=$1',[S.used]);
},async()=>{
  await dependencyRestore(await dependencyPlan());assert.deepEqual((await rows(db,'SELECT assigned_by,assigned_at FROM public.dispatch_group_members WHERE user_id=$1',[S.employee]))[0],{assigned_by:null,assigned_at:null});
  assert.equal(await scalar(db,'SELECT created_at FROM public.used_order_data WHERE id=$1',[S.used]),null);
})));

test('unmapped source membership assigner blocks plan instead of substituting the root administrator',()=>transaction(()=>withDependencyVariant(async()=>{
  await source.query("INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,'dependency-unmapped-admin','local-only','secondary_admin',false)",[id(999)]);
  await source.query('UPDATE public.dispatch_group_members SET assigned_by=$1 WHERE user_id=$2',[id(999),S.employee]);
},async()=>{
  const keep=await businessState(),plan=await dependencyPlan();assert.equal(plan.can_restore,false);assert.deepEqual(plan.conflicts,['unmapped_assigner']);
  await assert.rejects(dependencyBegin(plan),/unresolved conflicts/);assert.deepEqual(await businessState(),keep);
})));

test('target used records are reported and never removed or silently accepted by matching UUID',()=>transaction(async()=>{
  await dependencyReady();
  const disabled=await scalar(db,"SELECT private.employee_transfer_bypass_triggers(ARRAY['used_order_data'])");
  await db.exec('ALTER TABLE public.used_order_data DISABLE TRIGGER zz_employee_transfer_maintenance');
  await db.query('INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id) VALUES($1,$2,$3,$4)',[S.used,S.employee,S.valid,S.order]);
  await db.exec('ALTER TABLE public.used_order_data ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance');
  await db.query('SELECT private.employee_transfer_restore_triggers($1::jsonb)',[JSON.stringify(disabled)]);
  const keep=await businessState(),plan=await dependencyPlan();assert.equal(plan.can_restore,false);assert.deepEqual(plan.conflicts,['target_used_not_empty']);
  await assert.rejects(dependencyBegin(plan),/unresolved conflicts/);assert.deepEqual(await businessState(),keep);assert.equal(await permitCount(),0);
}));

test('committed real configuration receipt survives separate requests; cancellation never releases dirty maintenance', async () => {
  let plan, receipt, before;
  await transaction(async () => { await enter(); plan = await configPlan(); checkPlan(plan); before = await unaffected(); }, db, true);
  await transaction(async () => { receipt = await apply(plan); await verifyConfiguration(plan); }, db, true);
  await transaction(async () => {
    assert.deepEqual(await status(), active(job, true)); assert.equal(await permitCount(), 0);
    assert.deepEqual(await unaffected(), before); assert.deepEqual(await apply(plan), { ...receipt, repeated: true });
    await blocked('DELETE FROM public.dispatch_config WHERE false'); await assert.rejects(leave(), /committed writes/);
  });
  await transaction(async () => { await validBegin(plan); },db,true);
  await transaction(async () => { assert.equal((await validChunk(0)).rows,200); },db,true);
  await transaction(async () => {
    assert.equal((await validChunk(0)).repeated,true);
    assert.equal((await validChunk(1)).rows,400);
  },db,true);
  await transaction(async () => { await validChunk(2); assert.equal((await validVerify()).verified,true); },db,true);
  await transaction(async () => { await identityRestore(await identityStage());plan=await dependencyPlan();await dependencyBegin(plan); },db,true);
  await transaction(async () => { await dependencyChunk('dispatch_group_members',0); },db,true);
  await transaction(async () => { assert.equal((await dependencyBegin(plan)).counts.dispatch_group_members,200);await dependencyChunk('dispatch_group_members',1); },db,true);
  await transaction(async () => { await dependencyChunk('used_order_data',0);assert.equal((await dependencyVerify()).verified,true); },db,true);
  await transaction(async () => { await cancel(job); }, db, true);
  await transaction(async () => {
    assert.deepEqual(await status(), active(job, true));
    await assert.rejects(validChunk(0),/invalid or expired/);
    await assert.rejects(dependencyPlan(),/invalid or expired/);await assert.rejects(dependencyVerify(),/invalid or expired/);
    await assert.rejects(dependencyChunk('used_order_data',0),/invalid or expired/);
    await assert.rejects(validVerify(),/invalid or expired/);
    await assert.rejects(validBegin(plan),/invalid or expired/);
    assert.equal(await scalar(db,'SELECT count(*)::int FROM public.valid_order_data'),403); assert.equal(await permitCount(), 0);
    await assert.rejects(leave(), /committed writes/); await assert.rejects(configPlan(), /invalid or expired/);
    await blocked('DELETE FROM public.valid_order_data WHERE false'); await blocked('DELETE FROM public.announcements WHERE false');
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE id=$1 AND sealed_at IS NOT NULL', [job.job_id]), 1);
    const chunk = await rpc('get_employee_dispatch_saved_backup_chunk', { p_admin_session_token: session, p_backup_id: job.job_id, p_chunk_no: 0 });
    assert.equal(chunk.sha256, hash(backup.bytes));
  });
  // The in-memory site intentionally closes with dirty maintenance still active.
});
