import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createSites, adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Real historical replay through SQL37, then SQL39 directly (no dependency on SQL38).
// Genuine shared/dispatch independently encrypted prerequisites + actual SQL14 bind/stage.
// No fabricated owner receipt, production client, Storage, or claim of a complete employee backup.
const BASE = '20261102000037_plan_employee_replacement.sql';
const MIGRATION = '20261102000039_export_employee_replacement_backup.sql';
const CATALOG = 'get_employee_import_replacement_backup';
const PAGE = 'get_employee_import_replacement_backup_page';
const VERIFY = 'employee_import_replacement_backup_verify';
const KEYS = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'],
};
const TABLES = [...KEYS.identity, 'wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals',
  'wallet_reconciliation_audit', 'employee_login_history', 'work_sessions', 'work_stop_markers', 'verification_requests',
  'dispatch_group_members', 'employee_submit_time_settings'];
const MISSING = ['chat', 'notifications', 'media', 'dispatch_configuration', 'used_order_data', 'orders_history', 'archive_evidence'];
const id = n => `39000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = { same: id(1), sameId: id(2), empty: id(3), case: id(4), fresh: id(5) };
const T = { same: id(101), empty: id(103), case: id(104), other: id(105), root: id(201), product: id(202) };
const PRECISE = '12345678901234567890.12345678901234567890';
const TINY = '0.00000000000000000001';
const TIME = '2024-02-29T03:04:05.123456+00:00';
const SECRET = id(9999);
const DEVICE_SECRET_KEYS = ['currentsessiontoken', 'currenttabid', 'sessionid', 'sessiontoken', 'tokenhash', 'accesstoken',
  'refreshtoken', 'servicerolekey', 'anonkey', 'password', 'passwordhash', 'token', 'authorization', 'apikey', 'clientsecret', 'secret'];
const DEVICE_SECRET_VALUE = 'LOCAL-ONLY-VALID-SESSION-CANARY-DO-NOT-LEAK';
const SAFE_DEVICE = { marker: 'ordinary device text', browser: { session_created_at: TIME, last_heartbeat_at: TIME,
  token_count: 2, password_policy: 'ordinary policy', notes: 'session_id is a historical field name' },
  devices: [{ browser: 'Chromium' }, null, false] };
const sha = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
let replay, source, db, session, sourceSession, branch, emergency, other, task, pkg, identity, modules, schemaBefore;
let sequence = 0;
const auth = (job = task, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
async function transaction(fn, site = db, commit = false) {
  await site.exec('BEGIN');
  try { const result = await fn(); await site.exec(commit ? 'COMMIT' : 'ROLLBACK'); return result; }
  catch (error) { await site.exec('ROLLBACK'); throw error; }
}
async function on(site, name, args, role = 'anon') {
  const point = `employee_backup_${++sequence}`;
  await site.exec(`SAVEPOINT ${point}`);
  try {
    assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
    await site.exec(`SET LOCAL ROLE ${role}`);
    const result = await baseRpc(site, name, args, { role: null });
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
    return result;
  } catch (error) { await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); throw error; }
}
const rpc = (name, args, role) => on(db, name, args, role);
const catalog = (extra = {}) => rpc(CATALOG, { ...auth(), p_source_employee_id: S.same, ...extra });
const page = (c, key, extra = {}) => rpc(PAGE, { ...auth(), p_source_employee_id: c.source_employee_id,
  p_catalog_fingerprint: c.fingerprint, p_table_key: key, ...extra });
const verify = (c, extra = {}) => rpc(VERIFY, { ...auth(), p_source_employee_id: c.source_employee_id,
  p_catalog_fingerprint: c.fingerprint, ...extra });
function flags(result) {
  assert.equal(result.media_included, false); assert.equal(result.can_archive, false);
  assert.equal(result.can_replace, false); assert.equal(result.full_site_complete, false);
  assert.equal(result.records_only, true);
}
async function employee(site, employeeId, username, number) {
  await site.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
    VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5)`, [employeeId, username, number, PASSWORDS.employee, NEW.root]);
}
async function capture(kind) {
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
    ...(kind === 'identity' ? { p_package_id: pkg } : {}) });
  const texts = {};
  for (const key of KEYS[kind]) {
    texts[key] = ''; let after = null;
    do {
      const p = await on(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: 200 });
      assert.equal(p.sha256, sha(p.ndjson)); texts[key] += p.ndjson; after = p.next_after;
    } while (after !== null);
  }
  assert.equal((await on(source, `employee_export_${kind}_verify`, auth(job, sourceSession))).verified, true);
  await on(source, kind === 'shared' ? 'employee_transfer_cancel' : `employee_export_${kind}_close`, auth(job, sourceSession));
  return { catalog: job.catalog, texts };
}
async function* disk(path) {
  const handle = await open(path, 'r');
  try { const bytes = Buffer.alloc(65521); for (;;) { const r = await handle.read(bytes); if (!r.bytesRead) return; yield bytes.subarray(0, r.bytesRead); } }
  finally { await handle.close(); }
}
async function prepare(kind, input) {
  const job = await rpc(kind === 'shared' ? 'employee_import_shared_replace_begin' : 'employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: pkg, p_catalog: input.catalog,
  });
  for (const key of KEYS[kind]) await rpc(`employee_import_${kind}_stage`, { ...auth(job), p_table_key: key, p_chunk_no: 0, p_ndjson: input.texts[key] });
  const plan = await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(job));
  const descriptor = await rpc(`get_employee_import_${kind}_backup`, auth(job));
  const dir = await mkdtemp(join(tmpdir(), 'employee-backup-prerequisite-')), path = join(dir, 'independent.edx'), plain = new Map();
  let opens = 0;
  try {
    await (kind === 'shared' ? modules.createReplacementBackup : modules.createDispatchBackup)(descriptor, {
      async catalog() { return (await rpc(`get_employee_import_${kind}_backup`, auth(job))).catalog; },
      page(key, after) { return rpc(`get_employee_import_${kind}_backup_page`, { ...auth(job), p_table_key: key, p_after: after, p_limit: 200 }); },
      async verify() {
        assert.deepEqual(await rpc(`get_employee_import_${kind}_backup`, auth(job)), descriptor);
        return { verified: true, scope: kind === 'shared' ? 'shared-settings' : 'dispatch-submission', full_site_complete: false };
      },
    }, {
      async append(name, bytes) { plain.set(name, [...plain.get(name) ?? [], Buffer.from(bytes)]); },
      open(name) { return (async function* () { yield* plain.get(name) ?? []; })(); }, async abort() { plain.clear(); },
    }, {
      async write(stream) { const handle = await open(path, 'wx'); try { for await (const bytes of stream) await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } },
      open() { opens++; return disk(path); },
    }, {
      append(no, hex) { assert.equal(opens, 2); return rpc(`employee_import_${kind}_backup_append`, { ...auth(job), p_plan_hash: plan.plan_hash, p_chunk_no: no, p_hex: hex }); },
      seal(hash, bytes) { return rpc(`employee_import_${kind}_backup_seal`, { ...auth(job), p_plan_hash: plan.plan_hash, p_sha256: hash, p_bytes: bytes }); },
    }, 'local-independent-prerequisite-not-an-employee-backup');
    assert.equal(opens, 2); assert.equal(plain.size, 0);
    assert.equal(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), true);
    return { job, plan };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
// Privileged local fixture editing ONLY, exact original trigger modes restored. SQL39 cannot do this.
async function change(relation, sql, args = []) {
  const point = `fixture_${++sequence}`;
  await db.exec(`SAVEPOINT ${point}`);
  try {
    const modes = await rows(db, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
    for (const t of modes) await db.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
    await db.query(sql, args);
    for (const t of modes) await db.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`);
    await db.exec(`RELEASE SAVEPOINT ${point}`);
  } catch (error) { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); throw error; }
}
async function snapshot() {
  const names = (await rows(db, `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY 1`)).map(r => r.name);
  return rows(db, names.map(name => `SELECT '${name}' AS name,count(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
}
const schema = () => rows(db, `SELECT n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,a.attnum`);
const triggers = () => rows(db, `SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
  FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2`);
async function collect(c, key, limit = 2) {
  let text = '', after = null;
  do {
    const p = await page(c, key, { p_after: after, p_limit: limit }); flags(p);
    assert.equal(p.fingerprint, c.fingerprint); assert.equal(p.target_employee_id, c.target_employee_id);
    assert.equal(p.sha256, sha(p.ndjson)); assert.equal(p.bytes, Buffer.byteLength(p.ndjson)); assert.equal(p.count, lines(p.ndjson).length);
    assert.ok(p.count <= limit); assert.ok(p.bytes <= 262144); text += p.ndjson; after = p.next_after;
  } while (after !== null);
  const table = c.tables.find(t => t.key === key);
  assert.equal(table.rows, lines(text).length); assert.equal(table.bytes, Buffer.byteLength(text));
  assert.equal(table.row_hashes_sha256, sha(lines(text).map(sha).join('')));
  return text;
}
async function clientBackupDisk(t, token = session) {
  const dir = await mkdtemp(join(tmpdir(), 'employee-backup-real-sql39-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = { token, tokenReads: 0, calls: [], workspaces: [], events: [], fileWrites: 0, fileOpens: 0, afterWrite: null,
    filePath: join(dir, 'independent-employee-records.edx') };
  h.rpc = (name, args) => {
    assert.ok([CATALOG, PAGE, VERIFY].includes(name));
    assert.equal(args.p_job_token, task.job_token); assert.equal(args.p_source_employee_id, S.same);
    assert.equal(args.p_admin_session_token, h.token);
    const query = { signal: null, abortSignal(signal) { query.signal = signal; return query; }, then(resolve, reject) {
      return Promise.resolve().then(async () => {
        assert.notEqual(query.signal?.aborted, true);
        const call = { name, args: structuredClone(args), readOnly: await scalar(db, "SELECT current_setting('transaction_read_only')") };
        h.calls.push(call); h.events.push(name);
        // Real anon SQL execution, with the existing negative-test savepoint. Never fabricate responses.
        try { call.data = await rpc(name, args); return { data: call.data, error: null }; }
        catch (error) { call.error = error.message; throw error; }
      }).then(resolve, reject);
    } }; return query;
  };
  h.createWorkspace = () => {
    const base = join(dir, `plaintext-${h.workspaces.length}`);
    const w = { base, cleaned: false, cleanups: 0,
      async append(path, raw, signal) {
        assert.equal(w.cleaned, false); assert.notEqual(signal?.aborted, true);
        assert.ok(path === modules.EMPLOYEE_BACKUP_CATALOG_PATH || TABLES.some(key => path === modules.employeeBackupEntryPath(key)));
        await mkdir(dirname(join(base, path)), { recursive: true });
        assert.equal(w.cleaned, false); await appendFile(join(base, path), raw);
      },
      open(path) { assert.equal(w.cleaned, false); return disk(join(base, path)); },
      async abort() {
        w.cleaned = true; w.cleanups++; h.events.push(`cleanup-${h.workspaces.indexOf(w)}`);
        await rm(base, { recursive: true, force: true });
      },
    }; h.workspaces.push(w); return w;
  };
  h.file = {
    async write(stream, signal) {
      h.fileWrites++; h.events.push('file-write');
      const handle = await open(h.filePath, 'wx');
      try { for await (const raw of stream) { assert.equal(signal.aborted, false); await handle.writeFile(raw); } await handle.sync(); }
      finally { await handle.close(); }
      h.events.push('file-saved'); if (h.afterWrite) await h.afterWrite();
    },
    open() { h.fileOpens++; h.events.push('file-open'); return (async function* () { yield* disk(h.filePath); h.events.push('file-eof'); })(); },
  };
  h.export = (c, client) => {
    modules.setHarness(h);
    h.info = { scope: 'replacement-backup', sourceSiteId: c.target_site_id, exportId: randomUUID(), volumeId: randomUUID(),
      volumeIndex: 1, volumeCount: 1, createdAt: new Date().toISOString() };
    return modules.exportEmployeeBackup(client ?? modules.createEmployeeBackupSession(task.job_token, S.same, task.job_id),
      h.file, h.createWorkspace, 'real-sql39-independent-employee-backup', h.info);
  };
  h.decrypt = async () => {
    const paths = new Set(), w = h.createWorkspace();
    try {
      const manifest = await modules.verifyEncryptedVolume(h.file.open(), 'real-sql39-independent-employee-backup', {
        async append(path, raw, signal) { paths.add(path); await w.append(path, raw, signal); }, abort: reason => w.abort(reason),
      }, { expectedMetadata: { exportId: h.info.exportId, volumeId: h.info.volumeId } });
      const files = new Map(); for (const path of paths) files.set(path, await readFile(join(w.base, path)));
      return { manifest, files };
    } finally { await w.abort(new Error('Independent SQL39 backup readback discarded.')); }
  };
  return h;
}
function assertClientWorkspacesClean(h) {
  assert.ok(h.workspaces.length >= 2);
  for (const w of h.workspaces) { assert.equal(w.cleaned, true); assert.equal(w.cleanups, 1); }
}
async function seedCore(user, base, foreign = false) {
  const marker = foreign ? 'FOREIGN-EMPLOYEE-ONLY' : '原始後台備註\n𠮷 é é';
  await change('public.users', `UPDATE public.users SET total_income=$2::numeric,remarks=$3,tags=ARRAY['標籤',NULL,E'含,逗號\n'],is_pinned=true,
    current_session_token=$4,current_tab_id='secret-active-tab',session_created_at=$5,last_heartbeat_at=$5,created_at=$5,updated_at=NULL WHERE id=$1`, [user, PRECISE, marker, SECRET, TIME]);
  await change('public.financial_employee_credentials', `INSERT INTO public.financial_employee_credentials(user_id,password_hash,created_at,updated_at)
    SELECT id,password_hash,$2,$2 FROM public.users WHERE id=$1`, [user, TIME]);
  await change('public.wallets', 'UPDATE public.wallets SET available_balance=$2::numeric,frozen_balance=$3::numeric,created_at=$4,updated_at=NULL WHERE user_id=$1', [user, PRECISE, TINY, TIME]);
  await change('public.wallet_balance_baselines', `INSERT INTO public.wallet_balance_baselines(user_id,available_balance,frozen_balance,total_income,last_ledger_id,established_at)
    VALUES($1,$2::numeric,$3::numeric,$2::numeric,9007199254740993,$4) ON CONFLICT(user_id) DO UPDATE SET available_balance=EXCLUDED.available_balance,
    frozen_balance=EXCLUDED.frozen_balance,total_income=EXCLUDED.total_income,last_ledger_id=EXCLUDED.last_ledger_id,established_at=EXCLUDED.established_at`, [user, PRECISE, TINY, TIME]);
  await change('public.wallet_ledger_entries', `INSERT INTO public.wallet_ledger_entries(id,user_id,operation_id,source_type,source_id,event_type,available_delta,frozen_delta,income_delta,created_at)
    VALUES($1::bigint,$2,$3,'wallet_transaction',$4,$5,$6::numeric,$7::numeric,$6::numeric,$8)`, [foreign ? '9007199254741993' : '9007199254740993', user, id(base + 10), id(base + 11), marker, PRECISE, TINY, TIME]);
  await change('public.wallet_transactions', `INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after,remarks,created_by,created_at)
    VALUES($1,$2,'manual_adjustment',$3::numeric,0,$3::numeric,$4,$5,$6)`, [id(base + 11), user, PRECISE, marker, NEW.root, TIME]);
  for (const [index, status] of ['pending', 'approved', 'rejected', 'cancelled'].entries()) {
    await change('public.withdrawals', `INSERT INTO public.withdrawals(id,user_id,amount,status,audit_remark,created_at)
      VALUES($1,$2,$3::numeric,$4,$5,$6)`, [id(base + 20 + index), user, PRECISE, status, marker, TIME]);
  }
  await change('public.wallet_reconciliation_audit', `INSERT INTO public.wallet_reconciliation_audit(id,user_id,available_before,available_after,frozen_before,frozen_after,income_before,income_after,pending_amount,ledger_total,reason,repaired_at)
    VALUES($1::bigint,$2,0,$3::numeric,0,$4::numeric,0,$3::numeric,$4::numeric,$3::numeric,$5,$6)`, [foreign ? '9007199254741999' : '9007199254740999', user, PRECISE, TINY, marker, TIME]);
  for (const [index, status] of ['success', 'failure', 'processing'].entries()) {
    await change('public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,commission_amount,commission_rate,created_at,processed_at,assignment_id)
      SELECT $1,id,username,$3,987654321,'SECRET-DETAILED-ORDER-'||$4::text,'SECRET-TRANSACTION-'||$4::text,$5,CASE WHEN $5='success' THEN $6::numeric ELSE NULL END,0.01234567890123456789,$7,$7,'SECRET-ASSIGNMENT-'||$4::text FROM public.users WHERE id=$2`,
    [id(base + 30 + index), user, T.product, base + index, status, PRECISE, TIME]);
  }
  for (const index of [0, 1, 2]) {
    await change('public.employee_login_history', `INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,session_id,created_at,device_info,user_agent)
      SELECT $1,id,username,employee_id,'login',$3,$4,${index === 0 ? 'NULL' : index === 1 ? "'null'::jsonb" : `'${JSON.stringify({ ...SAFE_DEVICE, marker })}'::jsonb || jsonb_build_object('precise',${PRECISE},'tiny',${TINY})`},$5 FROM public.users WHERE id=$2`,
    [id(base + 40 + index), user, SECRET, TIME, marker]);
  }
  await change('public.work_sessions', `INSERT INTO public.work_sessions(id,user_id,start_time,end_time,duration_minutes,last_heartbeat_at,created_at)
    VALUES($1,$2,$3,NULL,NULL,$3,$3),($4,$2,$3,$3,321,$3,NULL)`, [id(base + 50), user, TIME, id(base + 51)]);
  await change('private.employee_work_stop_markers', 'INSERT INTO private.employee_work_stop_markers(user_id,stopped_at) VALUES($1,$2)', [user, TIME]);
  await change('public.verification_requests', `INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status,audit_remark,id_front_url,created_at,updated_at)
    VALUES($1,$2,$3,'ID-DOCUMENT','555','原始地址','approved',NULL,'https://fixture.supabase.co/storage/v1/object/public/verification-documents/front/raw.png',$4,NULL)`, [id(base + 60), user, marker, TIME]);
  await change('public.dispatch_group_members', `INSERT INTO public.dispatch_group_members(id,user_id,group_id,assigned_by,assigned_at)
    SELECT $1,$2,id,$3,$4 FROM public.dispatch_groups WHERE is_default`, [id(base + 70), user, NEW.root, TIME]);
  await change('public.employee_submit_time_settings', `INSERT INTO public.employee_submit_time_settings(id,user_id,group_id,min_seconds,max_seconds,created_at)
    VALUES($1,$2,NULL,3,299,$3)`, [id(base + 80), user, TIME]);
}

before(async () => {
  for (const [module, name] of [[globalThis, 'fetch'], [http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']]) {
    mock.method(module, name, () => assert.fail('network and production services forbidden'));
  }
  replay = await createSites({ upTo: BASE }); source = replay.oldSite; db = replay.newSite;
  schemaBefore = await schema();
  const beforeFunctions = await scalar(db, "SELECT count(*)::int FROM pg_proc WHERE pronamespace IN ('public'::regnamespace,'private'::regnamespace)");
  const beforeTriggers = await triggers();
  await db.exec(await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8'));
  assert.equal(await scalar(db, "SELECT count(*)::int FROM pg_proc WHERE pronamespace IN ('public'::regnamespace,'private'::regnamespace)"), beforeFunctions + 9);
  assert.deepEqual(await schema(), schemaBefore); assert.deepEqual(await triggers(), beforeTriggers);
  await buildNewSite(source); await buildNewSite(db);
  await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  for (const [key, username] of [['same', 'backup-same'], ['sameId', 'backup-same-id'], ['empty', 'backup-empty'], ['case', 'CaseBackup'], ['fresh', 'backup-fresh']]) {
    await employee(source, S[key], username, `SOURCE-${key}`);
  }
  for (const [target, username, number] of [[T.same, 'backup-same', 'TARGET-1'], [S.sameId, 'backup-same-id', 'TARGET-2'],
    [T.empty, 'backup-empty', 'TARGET-3'], [T.case, 'casebackup', 'TARGET-4'], [T.other, 'backup-unrelated', 'TARGET-5']]) {
    await employee(db, target, username, number);
  }
  await db.query(`INSERT INTO public.product_types(id,name) VALUES($1,'target secret product')`, [T.product]);
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    VALUES($1,'backup-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [T.root, PASSWORDS.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [T.root]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  other = await adminLogin(db, 'backup-other-root', PASSWORDS.root); pkg = randomUUID();
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';
    export * from './src/lib/employeeTransfer/employeeBackup.ts';
    export {verifyEncryptedVolume} from './src/lib/employeeTransfer/container.ts';
    export {setHarness} from 'employee-backup-db:state';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true,
  plugins: [{ name: 'local-sql39-only', setup(builder) {
    builder.onResolve({ filter: /^(?:employee-backup-db:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'employee-backup-db' }));
    builder.onLoad({ filter: /.*/, namespace: 'employee-backup-db' }, ({ path }) => ({ contents: path === 'employee-backup-db:state'
      ? 'let h;export const setHarness=value=>{h=value};export const current=()=>h;'
      : path === '../auth' ? 'import{current}from"employee-backup-db:state";export const getAdminFinancialSessionToken=()=>{const h=current();h.tokenReads++;return h.token;};'
        : 'import{current}from"employee-backup-db:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }] });
  assert.ok(!Object.keys(compiled.metafile.inputs).some(path => /node_modules\/@supabase|src\/lib\/(?:supabase|auth)\.ts/.test(path)));
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const captured = await transaction(async () => ({ shared: await capture('shared'), dispatch: await capture('dispatch'), identity: await capture('identity') }), source, true);
  identity = captured.identity;
  await transaction(async () => {
    const shared = await prepare('shared', captured.shared);
    assert.equal((await rpc('employee_import_shared_replace_apply', { ...auth(shared.job), p_plan_hash: shared.plan.plan_hash })).success, true);
    await rpc('employee_transfer_cancel', auth(shared.job));
    const dispatch = await prepare('dispatch', captured.dispatch); task = dispatch.job;
    await rpc('employee_import_dispatch_enter_maintenance', { ...auth(), p_plan_hash: dispatch.plan.plan_hash,
      p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root });
    const config = await rpc('get_employee_import_dispatch_configuration_plan', auth());
    await rpc('employee_import_dispatch_apply_configuration', { ...auth(), p_plan_hash: config.plan_hash });
    await rpc('employee_import_identity_bind', { ...auth(), p_catalog: identity.catalog });
    for (const key of KEYS.identity) await rpc('employee_import_identity_stage', { ...auth(), p_table_key: key, p_chunk_no: 0, p_ndjson: identity.texts[key] });
    // Real records added only AFTER genuine setup; not a claim that dirty maintenance permits ordinary writes.
    await seedCore(T.same, 1000); await seedCore(T.other, 2000, true);
    await change('public.employee_financial_sessions', `INSERT INTO public.employee_financial_sessions(user_id,token_hash,session_marker,expires_at,tab_id)
      VALUES($1,'SECRET-FINANCIAL-SESSION-HASH',$2,now()+interval '1 day','SECRET-FINANCIAL-TAB')`, [T.same, SECRET]);
    await change('public.financial_operations', `INSERT INTO public.financial_operations(operation_id,operation_type,actor_type,actor_id,request_data,result)
      VALUES($1,'backup-secret','employee',$2,'{"secret":"SECRET-REQUEST-DATA"}','{}')`, [id(998), T.same]);
  }, db, true);
}, { timeout: 600000 });
after(async () => { await Promise.allSettled([source?.close(), db?.close()]); mock.restoreAll(); });

test('strict replay retains exactly the 12 original failures; SQL39 adds functions only, independently of SQL38', async () => {
  assert.equal(replay.files.at(-1), BASE); assert.equal(replay.failures.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false); assert.deepEqual(await schema(), schemaBefore);
});
for (const [name, args] of [[CATALOG, ['p_admin_session_token', 'p_job_token', 'p_source_employee_id']],
  [PAGE, ['p_admin_session_token', 'p_job_token', 'p_source_employee_id', 'p_catalog_fingerprint', 'p_table_key', 'p_after', 'p_limit']],
  [VERIFY, ['p_admin_session_token', 'p_job_token', 'p_source_employee_id', 'p_catalog_fingerprint']]]) {
  test(`${name} has fixed arguments, STABLE definer, exact search path and explicit browser-only grants`, () => transaction(async () => {
    const fn = (await rows(db, `SELECT oid,proargnames,provolatile,prosecdef,proconfig,
      EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS everyone
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1`, [name]))[0];
    assert.deepEqual(fn.proargnames, args); assert.equal(fn.provolatile, 's'); assert.equal(fn.prosecdef, true); assert.equal(fn.everyone, false);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2::oid,\'EXECUTE\')', [role, fn.oid]), role !== 'service_role');
  }));
}
test('all six helpers are denied to public/browser/service roles and are read-only', () => transaction(async () => {
  const functions = await rows(db, `SELECT oid,proname,provolatile,prosecdef,proconfig,pronargdefaults FROM pg_proc WHERE pronamespace='private'::regnamespace
    AND (proname LIKE 'employee_transfer_replacement_backup_%' OR proname='employee_transfer_replacement_device_check')`);
  assert.equal(functions.length, 6);
  const device = functions.find(fn => fn.proname === 'employee_transfer_replacement_device_check');
  assert.equal(device.provolatile, 'i'); assert.equal(device.pronargdefaults, 1);
  for (const fn of functions) {
    assert.ok(['s', 'i'].includes(fn.provolatile)); assert.equal(fn.prosecdef, true);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2::oid,\'EXECUTE\')', [role, fn.oid]), false);
  }
}));
test('catalog/page/verify run in READ ONLY without changing any table, job heartbeat, permits, triggers or SQL37 gates', () => transaction(async () => {
  const before = await snapshot(), modes = await triggers();
  await db.exec('SET TRANSACTION READ ONLY');
  const c = await catalog(); flags(c); assert.deepEqual(await catalog(), c);
  for (const key of TABLES) await page(c, key);
  const result = await verify(c); flags(result); assert.equal(result.verified, true); assert.equal(result.backup_sealed, false);
  const p = await rpc('employee_import_replacement_plan', auth()); assert.equal(p.can_archive, false); assert.equal(p.can_replace, false);
  assert.equal(p.complete_employee_backup_missing, true); assert.ok(p.rows.find(r => r.source_id === S.same).blockers.includes('complete_employee_backup_missing'));
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await triggers(), modes);
}));
test('actual raw pages cover all 15 core tables, independently recompute catalog hashes, and expose missing domains honestly', () => transaction(async () => {
  const c = await catalog(); flags(c);
  assert.equal(c.protocol, 'replacement-records-v1'); assert.equal(c.complete_employee_backup, false); assert.equal(c.backup_sealed, false);
  assert.equal(c.source_employee_id, S.same); assert.equal(c.target_employee_id, T.same); assert.equal(c.job_id, task.job_id);
  assert.deepEqual(c.missing_domains, MISSING); assert.deepEqual(c.tables.map(t => t.key), TABLES);
  const fingerprint = await scalar(db, `SELECT encode(extensions.digest(convert_to(($1::jsonb-'fingerprint')::text,'UTF8'),'sha256'),'hex')`, [JSON.stringify(c)]);
  assert.equal(c.fingerprint, fingerprint);
  const texts = {};
  for (const key of TABLES) {
    texts[key] = await collect(c, key); assert.ok(lines(texts[key]).length > 0, key);
    const projected = Object.keys(c.projections[key]).sort();
    for (const line of lines(texts[key])) {
      const row = JSON.parse(line); assert.deepEqual(Object.keys(row).sort(), projected, key);
      assert.equal(['accounts', 'credentials'].includes(key) ? row.id : row.user_id, T.same, key);
    }
  }
  const all = Object.values(texts).join('');
  assert.doesNotMatch(all, /FOREIGN-EMPLOYEE-ONLY|SECRET-DETAILED-ORDER|SECRET-TRANSACTION|SECRET-ASSIGNMENT|SECRET-REQUEST-DATA|SECRET-FINANCIAL|secret-active-tab/);
  assert.doesNotMatch(all, /current_session_token|current_tab_id|archived_at|token_hash|product_value|product_type_id|order_number|transaction_id|scheduled_process_at|assignment_id/);
  assert.equal(Object.hasOwn(JSON.parse(texts.accounts), 'session_created_at'), false);
  assert.doesNotMatch(all, new RegExp(SECRET));
  const accountHash = await scalar(db, 'SELECT password_hash FROM public.users WHERE id=$1', [T.same]);
  const credentialHash = await scalar(db, 'SELECT password_hash FROM public.financial_employee_credentials WHERE user_id=$1', [T.same]);
  assert.equal(JSON.parse(texts.accounts).password_hash, accountHash); assert.equal(JSON.parse(texts.credentials).password_hash, credentialHash);
  assert.match(texts.accounts, /原始後台備註/); assert.deepEqual(JSON.parse(texts.accounts).tags, ['標籤', null, '含,逗號\n']);
  assert.equal(lines(texts.orders).length, 2); assert.equal(Object.keys(JSON.parse(lines(texts.orders)[0])).length, 7);
  assert.deepEqual(new Set(lines(texts.withdrawals).map(line => JSON.parse(line).status)), new Set(['pending', 'approved', 'rejected', 'cancelled']));
  for (const key of ['accounts', 'orders', 'wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']) assert.match(texts[key], new RegExp(PRECISE.replace('.', '\\.')), key);
  assert.match(texts.wallet_ledger_entries, /"id": "9007199254740993"/); assert.match(texts.wallet_reconciliation_audit, /"id": "9007199254740999"/);
  assert.match(texts.wallet_balance_baselines, /"last_ledger_id": "9007199254740993"/);
  assert.match(texts.accounts, /"updated_at": null/); assert.match(texts.wallet_transactions, /\.123456\+00:00/);
  const login = lines(texts.employee_login_history).map(JSON.parse);
  assert.equal(login[0].device_info, null); assert.equal(login[0].device_info_is_sql_null, true);
  assert.equal(login[1].device_info, null); assert.equal(login[1].device_info_is_sql_null, false);
  assert.match(texts.employee_login_history, new RegExp(PRECISE.replace('.', '\\.'))); assert.match(texts.employee_login_history, new RegExp(TINY.replace('.', '\\.')));
  assert.ok(login.every(row => /^history-[0-9a-f]{64}$/.test(row.session_id)));
  assert.equal(JSON.parse(lines(texts.work_sessions)[0]).end_time, null); assert.equal(JSON.parse(lines(texts.work_sessions)[1]).duration_minutes, 321);
  assert.equal(JSON.parse(texts.verification_requests).id_front_url.includes('verification-documents'), true); // URL only, NOT media bytes.
  assert.equal((await verify(c)).verified, true);
}));
test('same-name different UUID and same-ID target can both be backed up, without authorizing replacement', () => transaction(async () => {
  const distinct = await catalog(); assert.equal(distinct.target_employee_id, T.same); assert.notEqual(distinct.target_employee_id, distinct.source_employee_id);
  const same = await catalog({ p_source_employee_id: S.sameId }); assert.equal(same.target_employee_id, S.sameId);
  assert.equal(JSON.parse((await page(same, 'accounts')).ndjson).id, S.sameId); flags(await verify(same));
  const plan = await rpc('employee_import_replacement_plan', auth()); assert.ok(plan.rows.find(r => r.source_id === S.sameId).blockers.includes('source_uuid_occupied'));
}));
test('renaming or replacing the unique same-name holder invalidates the old target binding', () => transaction(async () => {
  const c = await catalog();
  await change('public.users', "UPDATE public.users SET username='backup-renamed' WHERE id=$1", [T.same]);
  await assert.rejects(page(c, 'accounts'), /exactly one/); await assert.rejects(verify(c), /exactly one/);
  await change('public.users', "UPDATE public.users SET username='backup-same' WHERE id=$1", [T.other]);
  const next = await catalog(); assert.equal(next.target_employee_id, T.other); assert.notEqual(next.fingerprint, c.fingerprint);
  await assert.rejects(page(c, 'accounts'), /changed/); await assert.rejects(verify(c), /changed/);
}));
test('empty domains produce true zero-row pages and empty-content hashes rather than synthetic rows', () => transaction(async () => {
  await change('public.wallet_balance_baselines', 'DELETE FROM public.wallet_balance_baselines WHERE user_id=$1', [T.empty]);
  const c = await catalog({ p_source_employee_id: S.empty });
  for (const key of TABLES.filter(k => !['accounts', 'wallets'].includes(k))) {
    const p = await page(c, key); assert.equal(p.ndjson, ''); assert.equal(p.count, 0); assert.equal(p.next_after, null);
    assert.equal(c.tables.find(t => t.key === key).row_hashes_sha256, sha(''));
  }
}));

const DEVICE_KEY_ALIASES = ['Current_Session_Token', 'CURRENT-TAB-ID', 'Session/ID', 'Session:Token', 'TOKEN-HASH', 'Access_Token',
  'REFRESH/TOKEN', 'Service-Role-Key', 'ANON_KEY', 'Password', 'PASSWORD_HASH', 'ToKeN', 'Authorization', 'API-Key', 'client_secret', 'Secret'];
for (const [index, alias] of DEVICE_KEY_ALIASES.entries()) test(`SQL39 rejects normalized structured device key ${DEVICE_SECRET_KEYS[index]} in real catalog/page/verify and client before writing`, async t => {
  assert.equal(alias.toLowerCase().replaceAll('_', '').replaceAll('/', '').replaceAll('-', '').replaceAll(':', ''), DEVICE_SECRET_KEYS[index]);
  const h = await clientBackupDisk(t);
  await transaction(async () => {
    const c = await catalog();
    const leaf = { [alias]: index % 2 === 0 ? session : DEVICE_SECRET_VALUE };
    const device = index % 3 === 0 ? { browser: leaf } : index % 3 === 1 ? [{ ua: 'ordinary' }, null, { devices: [leaf] }]
      : { browser: { devices: [null, [leaf]] } };
    await change('public.employee_login_history', 'UPDATE public.employee_login_history SET device_info=$2::jsonb WHERE id=$1', [id(1042), JSON.stringify(device)]);
    const before = await snapshot(), modes = await triggers();
    await db.exec('SET TRANSACTION READ ONLY');
    const redacted = error => {
      assert.equal(error.code, '22023'); assert.equal(error.message, 'Replacement backup device information contains a structured secret.');
      const details = [error.message, error.detail, error.hint, error.where].filter(Boolean).join('\n');
      assert.equal(details.includes(DEVICE_SECRET_VALUE), false); assert.equal(details.includes(session), false);
      assert.equal(details.includes(alias), false); return true;
    };
    await assert.rejects(catalog(), redacted);
    // The bad device is in the LAST login row, outside this first one-row page.
    await assert.rejects(page(c, 'employee_login_history', { p_limit: 1 }), redacted);
    await assert.rejects(page(c, 'accounts'), redacted); await assert.rejects(verify(c), redacted);
    await assert.rejects(h.export(c), error => {
      assert.ok(error instanceof modules.EmployeeBackupError); assert.equal(error.encryptedFileState, 'not-written');
      assert.equal(error.phase, 'records-export'); assert.equal(error.message.includes(DEVICE_SECRET_VALUE), false);
      assert.equal(error.message.includes(session), false); assert.equal('cause' in error, false); return true;
    });
    assert.equal(h.fileWrites, 0); assert.equal(h.fileOpens, 0); assert.equal(h.workspaces.length, 0);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, CATALOG); assert.equal(h.calls[0].readOnly, 'on');
    assert.equal(h.calls[0].data, undefined); assert.equal(h.calls[0].error.includes(DEVICE_SECRET_VALUE), false);
    await assert.rejects(readFile(h.filePath), { code: 'ENOENT' });
    assert.deepEqual(await snapshot(), before); assert.deepEqual(await triggers(), modes);
    assert.deepEqual(await scalar(db, 'SELECT device_info FROM public.employee_login_history WHERE id=$1', [id(1042)]), device);
  });
});
test('device check permits scalars, SQL NULL and JSON null, checks keys even with null values, and bounds every child at depth 64', () => transaction(async () => {
  const check = async (value, depth = 0) => {
    const point = `device_check_${++sequence}`; await db.exec(`SAVEPOINT ${point}`);
    try {
      await db.query('SELECT private.employee_transfer_replacement_device_check($1::jsonb,$2::integer)', [value, depth]);
      await db.exec(`RELEASE SAVEPOINT ${point}`);
    } catch (error) { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); throw error; }
  };
  const before = await snapshot(); await db.exec('SET TRANSACTION READ ONLY');
  for (const value of [null, 'null', 'true', '12345678901234567890.12345678901234567890', '"ordinary current_session_token text"', '[]', '{}']) await check(value);
  let nested = null;
  for (let i = 0; i < 64; i++) nested = i % 2 ? { device: nested } : [nested];
  await check(JSON.stringify(nested));
  await assert.rejects(check(JSON.stringify([nested])), /reviewed depth/);
  for (const depth of [null, -1, 65]) await assert.rejects(check('{}', depth), /reviewed depth/);
  await assert.rejects(check('{"browser":[{"token":null}]}'), /structured secret/);
  await assert.rejects(check('{"browser":{"\\u0074oken":"hidden"}}'), /structured secret/);
  assert.deepEqual(await snapshot(), before);
}));
for (const kind of ['object', 'array', 'mixed']) test(`real SQL39 to employeeBackup accepts 64 ${kind} device levels ending in null and rejects 65`, async t => {
  const nestedDevice = levels => {
    let value = null;
    for (let i = 0; i < levels; i++) value = kind === 'object' || (kind === 'mixed' && i % 2) ? { device: value } : [value];
    return value;
  };
  const accepted = nestedDevice(64), h = await clientBackupDisk(t);
  await transaction(async () => {
    await change('public.employee_login_history', 'UPDATE public.employee_login_history SET device_info=$2::jsonb WHERE id=$1', [id(1042), JSON.stringify(accepted)]);
    const before = await snapshot(), modes = await triggers(); await db.exec('SET TRANSACTION READ ONLY');
    const c = await catalog(), p = await page(c, 'employee_login_history', { p_limit: 200 });
    const checked = modules.validateEmployeeBackupPage(p, modules.validateEmployeeBackupCatalog(c), 'employee_login_history', null);
    assert.deepEqual(Buffer.from(checked.raw), Buffer.from(p.ndjson)); assert.equal(checked.count, 3);
    assert.deepEqual(lines(p.ndjson).map(JSON.parse)[2].device_info, accepted);
    const result = await h.export(c);
    assert.equal(result.recordsVerified, true); assert.equal(result.completeEmployeeBackup, false); assert.equal(result.fullSiteComplete, false);
    const checks = h.calls.filter(call => call.name === VERIFY);
    assert.equal(checks.length, 2); for (const call of checks) { assert.equal(call.data.verified, true); flags(call.data); }
    assert.ok(h.calls.every(call => call.readOnly === 'on')); assert.equal(h.fileWrites, 1);
    const restored = await h.decrypt(), raw = restored.files.get(modules.employeeBackupEntryPath('employee_login_history'));
    assert.deepEqual(raw, Buffer.from(p.ndjson));
    const login = lines(raw.toString()).map(JSON.parse);
    assert.equal(login[0].device_info, null); assert.equal(login[0].device_info_is_sql_null, true);
    assert.equal(login[1].device_info, null); assert.equal(login[1].device_info_is_sql_null, false);
    assert.deepEqual(login[2].device_info, accepted); assert.equal(login[2].device_info_is_sql_null, false);
    assert.ok(restored.files.get(modules.employeeBackupEntryPath('wallet_transactions')).toString().includes(PRECISE));
    assert.match(raw.toString(), /\.123456\+00:00/); assertClientWorkspacesClean(h);
    assert.deepEqual(await snapshot(), before); assert.deepEqual(await triggers(), modes);
  });
  const rejected = nestedDevice(65), bad = await clientBackupDisk(t);
  await transaction(async () => {
    const c = await catalog();
    await change('public.employee_login_history', 'UPDATE public.employee_login_history SET device_info=$2::jsonb WHERE id=$1', [id(1042), JSON.stringify(rejected)]);
    const before = await snapshot(); await db.exec('SET TRANSACTION READ ONLY');
    const depthError = error => { assert.equal(error.code, '22023'); assert.match(error.message, /reviewed depth/); return true; };
    await assert.rejects(catalog(), depthError); await assert.rejects(page(c, 'employee_login_history'), depthError); await assert.rejects(verify(c), depthError);
    await assert.rejects(bad.export(c), error => error instanceof modules.EmployeeBackupError && error.encryptedFileState === 'not-written');
    assert.equal(bad.fileWrites, 0); assert.equal(bad.workspaces.length, 0);
    assert.equal(bad.calls.length, 1); assert.equal(bad.calls[0].name, CATALOG); assert.match(bad.calls[0].error, /reviewed depth/);
    assert.equal(bad.calls[0].data, undefined); await assert.rejects(readFile(bad.filePath), { code: 'ENOENT' });
    assert.deepEqual(await snapshot(), before);
  });
});
test('directory and real client reject excessive target device depth without writes, but foreign employee unsafe devices do not block', async t => {
  await transaction(async () => {
    const c = await catalog(), h = await clientBackupDisk(t); let nested = null;
    for (let i = 0; i < 65; i++) nested = i % 2 ? { device: nested } : [nested];
    await change('public.employee_login_history', 'UPDATE public.employee_login_history SET device_info=$2::jsonb WHERE id=$1', [id(1042), JSON.stringify(nested)]);
    const before = await snapshot(); await db.exec('SET TRANSACTION READ ONLY');
    await assert.rejects(catalog(), /reviewed depth/); await assert.rejects(page(c, 'accounts'), /reviewed depth/); await assert.rejects(verify(c), /reviewed depth/);
    await assert.rejects(h.export(c), error => error instanceof modules.EmployeeBackupError && error.encryptedFileState === 'not-written');
    assert.equal(h.fileWrites, 0); assert.deepEqual(await snapshot(), before);
  });
  await transaction(async () => {
    const c = await catalog(), h = await clientBackupDisk(t);
    await change('public.employee_login_history', 'UPDATE public.employee_login_history SET device_info=$2::jsonb WHERE user_id=$1',
      [T.other, JSON.stringify({ browser: [{ 'CURRENT-SESSION-TOKEN': DEVICE_SECRET_VALUE }] })]);
    const before = await snapshot(); await db.exec('SET TRANSACTION READ ONLY');
    assert.deepEqual(await catalog(), c); flags(await verify(c));
    const result = await h.export(c); assert.equal(result.recordsVerified, true); assert.equal(result.completeEmployeeBackup, false);
    const restored = await h.decrypt();
    for (const raw of restored.files.values()) assert.equal(raw.includes(Buffer.from(DEVICE_SECRET_VALUE)), false);
    assertClientWorkspacesClean(h); assert.deepEqual(await snapshot(), before);
  });
});
const DRIFT = [
  ['account remarks', 'public.users', "UPDATE public.users SET remarks='same-count drift' WHERE id=$1"],
  ['credential password', 'public.financial_employee_credentials', "UPDATE public.financial_employee_credentials SET password_hash='changed-password-hash' WHERE user_id=$1"],
  ['completed order commission', 'public.orders', 'UPDATE public.orders SET commission_amount=commission_amount+1 WHERE user_id=$1 AND status=\'success\''],
  ['wallet', 'public.wallets', 'UPDATE public.wallets SET available_balance=available_balance+1 WHERE user_id=$1'],
  ['baseline', 'public.wallet_balance_baselines', 'UPDATE public.wallet_balance_baselines SET last_ledger_id=0 WHERE user_id=$1'],
  ['ledger', 'public.wallet_ledger_entries', "UPDATE public.wallet_ledger_entries SET event_type='same-count drift' WHERE user_id=$1"],
  ['transaction', 'public.wallet_transactions', "UPDATE public.wallet_transactions SET remarks='same-count drift' WHERE user_id=$1"],
  ['withdrawal', 'public.withdrawals', "UPDATE public.withdrawals SET audit_remark='same-count drift' WHERE user_id=$1"],
  ['reconciliation', 'public.wallet_reconciliation_audit', "UPDATE public.wallet_reconciliation_audit SET reason='same-count drift' WHERE user_id=$1"],
  ['login nested JSON', 'public.employee_login_history', "UPDATE public.employee_login_history SET device_info=jsonb_build_object('changed',true) WHERE user_id=$1"],
  ['work session', 'public.work_sessions', 'UPDATE public.work_sessions SET duration_minutes=7 WHERE user_id=$1'],
  ['stop marker', 'private.employee_work_stop_markers', "UPDATE private.employee_work_stop_markers SET stopped_at=stopped_at+interval '1 microsecond' WHERE user_id=$1"],
  ['verification', 'public.verification_requests', "UPDATE public.verification_requests SET audit_remark='same-count drift' WHERE user_id=$1"],
  ['group membership', 'public.dispatch_group_members', "UPDATE public.dispatch_group_members SET assigned_at=assigned_at+interval '1 microsecond' WHERE user_id=$1"],
  ['personal submit setting', 'public.employee_submit_time_settings', 'UPDATE public.employee_submit_time_settings SET max_seconds=298 WHERE user_id=$1'],
];
for (const [label, relation, sql] of DRIFT) test(`same-count ${label} edit rejects page and verify using the catalog checkpoint`, () => transaction(async () => {
  const c = await catalog(); await change(relation, sql, [T.same]);
  await assert.rejects(page(c, 'accounts'), /source or target changed/); await assert.rejects(verify(c), /source or target changed/);
  const next = await catalog(); assert.notEqual(next.fingerprint, c.fingerprint); assert.equal((await verify(next)).verified, true);
}));
test('insertion/deletion, and SQL NULL to JSON null with unchanged visible JSON, invalidate the full selected checkpoint', async () => {
  for (const mutate of [
    () => change('public.employee_login_history', 'DELETE FROM public.employee_login_history WHERE id=$1', [id(1040)]),
    () => change('public.employee_login_history', `INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type)
      VALUES($1,$2,'backup-same','TARGET-1','logout')`, [id(1043), T.same]),
    () => change('public.employee_login_history', `UPDATE public.employee_login_history SET device_info='null'::jsonb WHERE id=$1`, [id(1040)]),
  ]) await transaction(async () => { const c = await catalog(); await mutate(); await assert.rejects(page(c, 'accounts'), /changed/); await assert.rejects(verify(c), /changed/); });
});
test('all foreign employee core edits are outside the selected fingerprint; active sessions and detailed order fields are deliberately excluded', () => transaction(async () => {
  const c = await catalog();
  for (const [, relation, sql] of DRIFT) await change(relation, sql, [T.other]);
  await change('public.users', "UPDATE public.users SET current_session_token=$2,current_tab_id='different' WHERE id=$1", [T.same, randomUUID()]);
  await change('public.orders', "UPDATE public.orders SET product_value=1,order_number='other secret detail' WHERE user_id=$1", [T.same]);
  assert.deepEqual(await catalog(), c); assert.equal((await verify(c)).verified, true);
}));

test('pages are capped by byte size with complete continuation; numeric bigint cursor order is not lexicographic', () => transaction(async () => {
  for (const [index, length] of [50000, 50000, 50000, 50000, 50000, 50000].entries()) await change('public.wallet_transactions', `INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after,remarks)
    VALUES($1,$2,'manual_adjustment',1,0,1,repeat('x',$3))`, [id(3000 + index), T.same, length]);
  const c = await catalog(); const first = await page(c, 'wallet_transactions', { p_limit: 200 });
  assert.ok(first.count < 7); assert.ok(first.bytes <= 262144); assert.ok(first.next_after);
  assert.equal(lines(await collect(c, 'wallet_transactions', 200)).length, 7);
  for (const n of [2, 10]) await change('public.wallet_ledger_entries', `INSERT INTO public.wallet_ledger_entries(id,user_id,operation_id,source_type,source_id,event_type)
    VALUES($1,$2,$3,'wallet_transaction',$4,'cursor')`, [n, T.same, id(4000 + n), id(1011)]);
  const next = await catalog(), ledger = lines(await collect(next, 'wallet_ledger_entries', 1)).map(JSON.parse);
  assert.deepEqual(ledger.map(r => r.id), ['2', '10', '9007199254740993']);
}));
test('unknown tables, foreign/noncanonical cursors, arbitrary target IDs, invalid limits and missing fingerprints fail closed', () => transaction(async () => {
  const c = await catalog();
  for (const key of ['users', 'messages', 'chat', 'public.users', "accounts;DROP TABLE public.users", null]) await assert.rejects(page(c, key), /Unsupported/);
  for (const limit of [0, 201, null]) await assert.rejects(page(c, 'accounts', { p_limit: limit }), /page size/);
  for (const cursor of [T.other, `{${T.same}}`, id(999), 'not-a-uuid']) await assert.rejects(page(c, 'accounts', { p_after: cursor }));
  await assert.rejects(page(c, 'wallet_ledger_entries', { p_after: '09007199254740993' }), /canonical/);
  await assert.rejects(page(c, 'wallet_ledger_entries', { p_after: '9007199254741993' }), /another employee/);
  for (const fingerprint of [null, '', 'A'.repeat(64), '0'.repeat(64)]) {
    await assert.rejects(page(c, 'accounts', { p_catalog_fingerprint: fingerprint }), /fingerprint|changed/);
    await assert.rejects(verify(c, { p_catalog_fingerprint: fingerprint }), /fingerprint|changed/);
  }
  await assert.rejects(catalog({ p_target_employee_id: T.same }), /no argument/);
  await assert.rejects(page(c, 'accounts', { p_target_employee_id: T.other }), /no argument/);
  await assert.rejects(verify(c, { p_backup_verified: true }), /no argument/);
  await assert.rejects(verify(c, { p_source_employee_id: S.empty }), /changed/);
}));
test('unknown source, case-only username, and absent same-name target are rejected without leaking another employee', () => transaction(async () => {
  for (const employeeId of [null, T.same, id(998), S.case, S.fresh]) await assert.rejects(catalog({ p_source_employee_id: employeeId }), /not bound|exactly one/);
}));
test('oversize row and unreviewed additional column fail explicitly rather than silently truncating coverage', async () => {
  await transaction(async () => {
    await change('public.users', "UPDATE public.users SET remarks=repeat('x',65536) WHERE id=$1", [T.same]);
    await assert.rejects(catalog(), /no records were truncated/);
  });
  await transaction(async () => {
    await db.exec('ALTER TABLE public.employee_submit_time_settings ADD COLUMN unexpected_secret text');
    await assert.rejects(catalog(), /Unreviewed replacement backup schema/);
  });
});

test('catalog checkpoint binds exact raw source catalog; parsed/raw tampering cannot be normalized into a fresh target', async () => {
  for (const mutate of [
    () => db.query(`UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{rows,0,username}','"changed"') WHERE job_id=$1 AND table_key='identity-in:accounts'`, [task.job_id]),
    () => db.query(`UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{ndjson}',to_jsonb(replace(payload->>'ndjson','backup-same','changed-raw'))) WHERE job_id=$1 AND table_key='identity-in:accounts'`, [task.job_id]),
    () => db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{identity_catalog,site_id}',to_jsonb($2::text)) WHERE id=$1`, [task.job_id, randomUUID()]),
  ]) await transaction(async () => { const c = await catalog(); await mutate(); await assert.rejects(page(c, 'accounts')); await assert.rejects(verify(c)); });
});
test('even a coherently updated source account projection/catalog invalidates the old checkpoint', () => transaction(async () => {
  const c = await catalog(); const text = identity.texts.accounts.replace('"remarks": ""', '"remarks": "source changed"');
  assert.notEqual(text, identity.texts.accounts);
  const parsed = lines(text).map(JSON.parse), hashes = lines(text).map(sha).join('');
  await db.query(`UPDATE private.employee_transfer_staging SET payload=jsonb_build_object('ndjson',$2::text,'rows',$3::jsonb,'bytes',octet_length($2::text),
    'row_hashes',$4::text,'last_id',$5::text) WHERE job_id=$1 AND table_key='identity-in:accounts'`, [task.job_id, text, JSON.stringify(parsed), hashes, parsed.at(-1).id]);
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(jsonb_set(summary,'{identity_catalog,tables,0,row_hashes_sha256}',to_jsonb($2::text)),
    '{identity_catalog,tables,0,bytes}',to_jsonb($3::integer)) WHERE id=$1`, [task.job_id, sha(hashes), Buffer.byteLength(text)]);
  const next = await catalog(); assert.notEqual(next.source_fingerprint, c.source_fingerprint); assert.notEqual(next.fingerprint, c.fingerprint);
  await assert.rejects(page(c, 'accounts'), /changed/); await assert.rejects(verify(c), /changed/);
}));

for (const [label, token] of [['missing', () => null], ['random', randomUUID], ['secondary', () => branch], ['emergency', () => emergency], ['other super-admin owner', () => other]]) {
  test(`all three RPCs reject ${label} session`, () => transaction(async () => {
    const c = await catalog(), extra = { p_admin_session_token: token() };
    await assert.rejects(catalog(extra)); await assert.rejects(page(c, 'accounts', extra)); await assert.rejects(verify(c, extra));
  }));
}
for (const [label, sql] of [
  ['idle expiry', "UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1"],
  ['absolute expiry', "UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1"],
  ['cancelled task', "UPDATE private.employee_transfer_jobs SET status='cancelled' WHERE id=$1"],
  ['wrong protocol', "UPDATE private.employee_transfer_jobs SET options=options||'{\"import_protocol\":\"shared-import-v1\"}' WHERE id=$1"],
  ['wrong task kind', "UPDATE private.employee_transfer_jobs SET kind='export' WHERE id=$1"],
]) test(`all three RPCs reject ${label}`, () => transaction(async () => {
  const c = await catalog(); await db.query(sql, [task.job_id]);
  await assert.rejects(catalog()); await assert.rejects(page(c, 'accounts')); await assert.rejects(verify(c));
}));
test('revoked or disabled/demoted admin, missing dirty maintenance/sealed prerequisite and wrong tokens all fail closed', async () => {
  for (const mutate of [
    () => db.query('UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE token_hash=private.hash_financial_token($1)', [session]),
    () => change('public.admins', 'UPDATE public.admins SET is_active=false WHERE id=$1', [NEW.root]),
    () => change('public.admins', "UPDATE public.admins SET role='secondary_admin' WHERE id=$1", [NEW.root]),
    () => db.exec('DELETE FROM private.employee_transfer_maintenance'),
    () => db.exec('UPDATE private.employee_transfer_maintenance SET dirty=false'),
    () => db.query('UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1', [task.job_id]),
  ]) await transaction(async () => { const c = await catalog(); await mutate(); await assert.rejects(catalog()); await assert.rejects(page(c, 'accounts')); await assert.rejects(verify(c)); });
  await transaction(async () => {
    const c = await catalog();
    for (const token of [null, randomUUID()]) { const extra = { p_job_token: token }; await assert.rejects(catalog(extra)); await assert.rejects(page(c, 'accounts', extra)); await assert.rejects(verify(c, extra)); }
    await assert.rejects(rpc(CATALOG, { ...auth(), p_source_employee_id: S.same }, 'service_role'), /permission denied/);
    assert.deepEqual(await rpc(CATALOG, { ...auth(), p_source_employee_id: S.same }, 'authenticated'), c);
  });
});
test('checkpoint survives a genuine committed boundary and owner re-login without writing or renewing the original job', async () => {
  const c = await transaction(() => catalog(), db, true);
  const heartbeat = await scalar(db, 'SELECT last_activity_at::text FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]);
  const newSession = await adminLogin(db, 'root', PASSWORDS.root);
  await transaction(async () => {
    assert.equal((await page(c, 'accounts', { p_admin_session_token: newSession })).fingerprint, c.fingerprint);
    assert.equal((await verify(c, { p_admin_session_token: newSession })).verified, true);
    assert.equal(await scalar(db, 'SELECT last_activity_at::text FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]), heartbeat);
  });
});
test('real SQL39 and employeeBackup client export all 15 raw tables to an independently encrypted disk file in READ ONLY after re-login', async t => {
  const h = await clientBackupDisk(t);
  await transaction(async () => {
    modules.setHarness(h);
    const client = modules.createEmployeeBackupSession(task.job_token, S.same, task.job_id);
    const bound = await client.catalog();
    assert.equal(h.calls[0].args.p_admin_session_token, session);
    const renewed = await adminLogin(db, 'root', PASSWORDS.root);
    assert.notEqual(renewed, session); h.token = renewed;
    const before = await snapshot(), modes = await triggers();
    await db.exec('SET TRANSACTION READ ONLY');
    const c = await catalog({ p_admin_session_token: renewed }), original = new Map();
    assert.deepEqual(c, bound);
    for (const key of TABLES) original.set(modules.employeeBackupEntryPath(key), Buffer.from(await collect(c, key)));
    const result = await h.export(c, client);
    assert.equal(result.recordsVerified, true);
    for (const key of ['completeEmployeeBackup', 'mediaIncluded', 'canArchive', 'canReplace', 'fullSiteComplete']) assert.equal(result[key], false, key);
    assert.deepEqual(result.missingDomains, MISSING); assert.equal(h.fileWrites, 1); assert.equal(h.fileOpens, 1);
    assertClientWorkspacesClean(h);
    const ciphertext = await readFile(h.filePath);
    assert.equal(result.cipherBytes, ciphertext.length); assert.equal(result.cipherSha256, sha(ciphertext));
    assert.equal(ciphertext.includes(Buffer.from(PRECISE)), false);
    const restored = await h.decrypt();
    assert.deepEqual(restored.manifest, result.manifest); assert.equal(restored.manifest.sourceSiteId, c.target_site_id);
    assert.equal(restored.manifest.scope, 'replacement-backup'); assert.equal(restored.manifest.exportId, h.info.exportId);
    assert.notEqual(restored.manifest.exportId, pkg); assert.notEqual(restored.manifest.exportId, task.job_id);
    assert.deepEqual([...restored.files.keys()], [...TABLES.map(modules.employeeBackupEntryPath), modules.EMPLOYEE_BACKUP_CATALOG_PATH]);
    for (const table of c.tables) {
      const path = modules.employeeBackupEntryPath(table.key), raw = restored.files.get(path);
      assert.deepEqual(raw, original.get(path), table.key); assert.equal(raw.length, table.bytes);
      assert.equal(sha(lines(raw.toString()).map(sha).join('')), table.row_hashes_sha256);
      assert.equal(restored.manifest.entries.find(entry => entry.path === path).sha256, sha(raw));
    }
    const metadata = JSON.parse(restored.files.get(modules.EMPLOYEE_BACKUP_CATALOG_PATH).toString());
    assert.deepEqual(metadata, result.catalog); assert.equal(metadata.package_id, pkg); assert.equal(metadata.job_id, task.job_id);
    assert.equal(metadata.source_employee_id, S.same); assert.equal(metadata.target_employee_id, T.same);
    flags(metadata); assert.equal(metadata.complete_employee_backup, false); assert.equal(metadata.backup_sealed, false); assert.deepEqual(metadata.missing_domains, MISSING);
    const raw = key => restored.files.get(modules.employeeBackupEntryPath(key)).toString();
    assert.ok(raw('wallet_transactions').includes(PRECISE)); assert.match(raw('wallet_transactions'), /\.123456\+00:00/);
    assert.match(raw('wallet_ledger_entries'), /"id": "9007199254740993"/);
    assert.match(raw('wallet_reconciliation_audit'), /"id": "9007199254740999"/);
    assert.match(raw('accounts'), /"updated_at": null/);
    const logins = lines(raw('employee_login_history')).map(JSON.parse);
    assert.equal(logins[0].device_info, null); assert.equal(logins[0].device_info_is_sql_null, true);
    assert.equal(logins[1].device_info, null); assert.equal(logins[1].device_info_is_sql_null, false);
    assert.ok(raw('employee_login_history').includes(PRECISE)); assert.ok(raw('employee_login_history').includes(TINY));
    assert.deepEqual(logins[2].device_info.browser, SAFE_DEVICE.browser);
    assert.deepEqual(logins[2].device_info.devices, SAFE_DEVICE.devices);
    assert.equal(logins[2].device_info_is_sql_null, false);
    assert.doesNotMatch([...original.values()].join(''), /SECRET-FINANCIAL|SECRET-DETAILED-ORDER|secret-active-tab|current_session_token/);
    const reads = h.calls.slice(1), checks = reads.filter(call => call.name === VERIFY);
    assert.ok(reads.every(call => call.args.p_admin_session_token === renewed && call.readOnly === 'on'));
    assert.equal(h.tokenReads, h.calls.length); assert.equal(checks.length, 2);
    assert.deepEqual(reads.filter(call => call.name === PAGE).map(call => call.args.p_table_key), TABLES);
    for (const check of checks) { assert.equal(check.data.verified, true); flags(check.data); }
    assert.ok(h.events.indexOf(VERIFY) < h.events.indexOf('file-write'));
    assert.ok(h.events.indexOf('cleanup-0') < h.events.indexOf('file-open'));
    assert.ok(h.events.indexOf('file-eof') < h.events.lastIndexOf(VERIFY));
    assert.deepEqual(await snapshot(), before); assert.deepEqual(await triggers(), modes); assertClientWorkspacesClean(h);
  });
});
test('real SQL39 final verify rejects post-file-write target drift instead of returning a client backup success', async t => {
  const h = await clientBackupDisk(t);
  await transaction(async () => {
    const c = await catalog(), original = Buffer.from(await collect(c, 'wallet_transactions'));
    const before = await snapshot(), modes = await triggers(); let changed;
    h.afterWrite = async () => {
      h.events.push('intentional-target-drift');
      await change('public.wallet_transactions', "UPDATE public.wallet_transactions SET remarks='local post-save target drift' WHERE id=$1", [id(1011)]);
      changed = await snapshot();
    };
    await assert.rejects(h.export(c), error => {
      assert.ok(error instanceof modules.EmployeeBackupError); assert.equal(error.phase, 'target-recheck');
      assert.equal(error.encryptedFileState, 'verified'); assert.equal(error.cleanupRequired, false); assert.equal(error.outcomeUnknown, false);
      assert.equal(error.cancelled, false); assert.equal(error.recordsVerified, undefined); return true;
    });
    assert.equal(h.fileWrites, 1); assert.equal(h.fileOpens, 1); assertClientWorkspacesClean(h);
    const checks = h.calls.filter(call => call.name === VERIFY);
    assert.equal(checks.length, 2); assert.equal(checks[0].data.verified, true);
    assert.equal(checks[1].data, undefined); assert.match(checks[1].error, /source or target changed/);
    assert.ok(h.events.indexOf('file-saved') < h.events.indexOf('intentional-target-drift'));
    assert.ok(h.events.indexOf('file-eof') < h.events.lastIndexOf(VERIFY));
    assert.deepEqual(await snapshot(), changed); assert.deepEqual(await triggers(), modes);
    assert.deepEqual(changed.filter((row, index) => row.digest !== before[index].digest).map(row => row.name), ['public.wallet_transactions']);
    assert.deepEqual(changed.map(row => row.n), before.map(row => row.n));
    const restored = await h.decrypt();
    assert.deepEqual(restored.files.get(modules.employeeBackupEntryPath('wallet_transactions')), original);
    const stored = JSON.parse(restored.files.get(modules.EMPLOYEE_BACKUP_CATALOG_PATH).toString());
    assert.equal(stored.fingerprint, c.fingerprint); flags(stored); assertClientWorkspacesClean(h);
    const fresh = await catalog(); assert.notEqual(fresh.fingerprint, c.fingerprint);
    assert.notDeepEqual(Buffer.from(await collect(fresh, 'wallet_transactions')), original);
  });
});
test('SQL39 cannot bypass archive maintenance; archived-only, multiple historical candidates and live identity with archive evidence all reject', () => transaction(async () => {
  const c = await catalog();
  await assert.rejects(rpc('archive_employee_without_media', { p_admin_session_token: session, p_user_id: T.same }), /paused/);
  // Only a postgres fixture opens this window to generate genuine existing archive evidence.
  // No SQL39 RPC has a permit, archive call or way to open this maintenance window.
  const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  await db.exec('DELETE FROM private.employee_transfer_maintenance');
  assert.equal((await rpc('archive_employee_without_media', { p_admin_session_token: session, p_user_id: T.same })).success, true);
  await db.query('INSERT INTO private.employee_transfer_maintenance SELECT * FROM jsonb_populate_record(NULL::private.employee_transfer_maintenance,$1::jsonb)', [JSON.stringify(maintenance)]);
  await assert.rejects(catalog(), /archived/); await assert.rejects(page(c, 'accounts'), /archived/); await assert.rejects(verify(c), /archived/);
  await change('public.users', "UPDATE public.users SET username='backup-same' WHERE id=$1", [T.other]);
  await assert.rejects(catalog(), /exactly one unambiguous/);
  await change('public.users', "UPDATE public.users SET username='backup-unrelated' WHERE id=$1", [T.other]);
  await change('public.users', "UPDATE public.users SET username='backup-same',archived_at=NULL WHERE id=$1", [T.same]);
  await assert.rejects(catalog(), /archive evidence/);
}));
