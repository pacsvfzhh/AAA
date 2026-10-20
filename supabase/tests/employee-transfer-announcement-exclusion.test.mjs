import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { replayMigrations, EXPECTED_REPLAY_FAILURES } from './support/replay-migrations.mjs';
import { createSites, adminLogin, rpc as baseRpc, scalar, rows } from './support/transfer-harness.mjs';
import { buildNewSite, OLD, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

const migration = '20261102000043_preserve_transfer_announcements.sql';
const previous = '20261102000042_stop_owned_export.sql';
const keys = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const carousel = ['announcement_carousel_enabled', 'announcement_carousel_speed'];
const settings = ['admin_navigation_preferences', 'login_subtitle', 'login_title'];
const changedFunctions = [
  'private.employee_transfer_shared_setting_valid(text,jsonb)',
  'private.employee_transfer_shared_validate()',
  'private.employee_transfer_shared_rows(text)',
].sort();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parsed = text => text.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
const transactionSites = new Set();
let source;
let target;
let session;
let sourceSession;
let legacyPackage;
let currentPackage;
let replay;
let upgrade;
let backupModule;
let containerModule;

// Expected failures must not abort the surrounding fixture transaction. Calls in
// the final disk/apply test deliberately run in separate committed transactions.
async function call(db, name, args) {
  if (!transactionSites.has(db)) return baseRpc(db, name, args);
  await db.exec('SAVEPOINT announcement_rpc');
  try {
    await db.exec('SET LOCAL ROLE anon');
    const result = await baseRpc(db, name, args, { role: null });
    await db.exec('RESET ROLE; RELEASE SAVEPOINT announcement_rpc');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT announcement_rpc; RELEASE SAVEPOINT announcement_rpc');
    throw error;
  }
}
async function transaction(db, fn) {
  await db.exec('BEGIN');
  transactionSites.add(db);
  try { return await fn(); } finally {
    transactionSites.delete(db);
    await db.exec('ROLLBACK');
  }
}
const auth = job => ({ p_admin_session_token: session, p_job_token: job.job_token });
const beginImport = (input, replacement = true) => call(target,
  replacement ? 'employee_import_shared_replace_begin' : 'employee_import_shared_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root,
    p_package_id: input.packageId, p_catalog: input.catalog,
  });
const dryRun = job => call(target, 'get_employee_import_shared_replace_dry_run', auth(job));
const descriptor = job => call(target, 'get_employee_import_shared_backup', auth(job));
const apply = (job, planHash) => call(target, 'employee_import_shared_replace_apply', {
  ...auth(job), p_plan_hash: planHash,
});
async function stageAll(job, input) {
  for (const key of keys) {
    const result = await call(target, 'employee_import_shared_stage', {
      ...auth(job), p_table_key: key, p_chunk_no: 0, p_ndjson: input.texts[key],
    });
    assert.equal(result.sha256, hash(input.texts[key]));
  }
}
const tableState = (db, table) => scalar(db, `SELECT COALESCE(
  jsonb_agg(to_jsonb(item) ORDER BY to_jsonb(item)::text), '[]'::jsonb)::text FROM public.${table} item`);
async function announcementState(db) {
  return {
    announcements: await tableState(db, 'announcements'),
    categories: await tableState(db, 'announcement_categories'),
    carousel: await scalar(db, `SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.key), '[]')::text
      FROM public.system_configs c WHERE key=ANY($1::text[])`, [carousel]),
  };
}
async function businessState(db) {
  const state = await announcementState(db);
  for (const key of keys) state[key] = await tableState(db, key);
  return state;
}
const routineState = db => rows(db, `SELECT p.oid::regprocedure::text AS signature,
  p.prosecdef, p.provolatile, p.proparallel, p.proconfig, p.proacl::text AS acl,
  pg_get_userbyid(p.proowner) AS owner,
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid), 'UTF8'), 'sha256'), 'hex') AS hash
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','private') AND p.prokind='f' ORDER BY signature`);

async function seedSource(db) {
  for (const [id, username, role, password] of [
    [OLD.root, 'root', 'super_admin', PASSWORDS.root],
    [OLD.branch, 'branch', 'secondary_admin', PASSWORDS.branch],
    [OLD.emergency, 'emergency', 'emergency_admin', PASSWORDS.emergency],
  ]) {
    await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES ($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4,true)`, [id, username, password, role]);
    await db.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
      VALUES ($1,extensions.crypt($2,extensions.gen_salt('bf',4)))`, [id, password]);
  }
  await seedSettings(db, 'Source', false, 4.8);
  await seedAnnouncements(db, OLD, 'Source');
}
async function seedSettings(db, label, enabled, speed) {
  for (const [key, value] of [
    ['login_title', `${label} title`], ['login_subtitle', `${label} subtitle`],
    ['admin_navigation_preferences', { order: ['announcements', 'employees'], labels: { announcements: label } }],
    ['announcement_carousel_enabled', enabled], ['announcement_carousel_speed', speed],
  ]) await db.query(`INSERT INTO public.system_configs(key,value,description,created_at,updated_at)
    VALUES ($1,$2::jsonb,$3,'2023-02-03T04:05:06.123456Z','2023-04-05T06:07:08.654321Z')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,description=EXCLUDED.description`,
  [key, JSON.stringify(value), `${label} local setting`]);
}
async function seedAnnouncements(db, admins, label) {
  // Existing category names/order are fixture data too; alter them only here,
  // before snapshots. Comparison below covers every column and microsecond.
  await db.query(`UPDATE public.announcement_categories SET icon_name=$1,color_scheme='violet',
    is_active=false,created_at='2022-01-02T03:04:05.123456Z',updated_at='2022-02-03T04:05:06.654321Z'`, [label]);
  const category = await scalar(db, 'SELECT name FROM public.announcement_categories ORDER BY display_order LIMIT 1');
  for (const [index, owner] of [admins.root, admins.branch, admins.emergency].entries()) {
    await db.query(`INSERT INTO public.announcements(title,content,created_by,category,is_pinned,pin_order,
      is_hidden,is_global,publish_at,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'2021-02-03T04:05:06.123456Z','2021-04-05T06:07:08.654321Z')`,
    [`${label} announcement ${index}`, `<p>${label} only <img src="/announcement-only-${index}.png"></p>`,
      owner, category, index === 0, index + 1, index === 1, index === 2,
      index === 0 ? '2020-01-02T03:04:05.123456Z' : index === 1 ? '2099-02-03T04:05:06.654321Z' : null]);
  }
}
async function exportPackage(db, token) {
  const job = await call(db, 'employee_export_shared_begin', {
    p_admin_session_token: token, p_admin_password: PASSWORDS.root,
  });
  assert.equal(job.success, true);
  const texts = {};
  for (const key of keys) {
    let after = null;
    texts[key] = '';
    do {
      const page = await call(db, 'get_employee_export_shared_page', {
        p_admin_session_token: token, p_job_token: job.job_token,
        p_table_key: key, p_after: after, p_limit: 2,
      });
      assert.equal(page.sha256, hash(page.ndjson));
      texts[key] += page.ndjson;
      after = page.next_after;
    } while (after !== null);
    const item = job.catalog.tables.find(item => item.key === key);
    assert.equal(item.sha256, hash(texts[key]));
    assert.equal(item.bytes, Buffer.byteLength(texts[key]));
    assert.equal(item.rows, parsed(texts[key]).length);
  }
  assert.equal((await call(db, 'employee_export_shared_verify', {
    p_admin_session_token: token, p_job_token: job.job_token,
  })).verified, true);
  await call(db, 'employee_export_shared_close', { p_admin_session_token: token, p_job_token: job.job_token });
  return { packageId: randomUUID(), catalog: job.catalog, texts };
}
async function compile(name) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../../src/lib/employeeTransfer/${name}.ts`, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020',
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

before(async () => {
  // Genuine SQL05/06/07/41/42 source, not a mocked legacy catalog or downgraded
  // runtime function. Upgrade seeded business data separately from full replay.
  const legacy = await replayMigrations({ upTo: previous, strict: true });
  try {
    await seedSource(legacy.db);
    const token = await adminLogin(legacy.db, 'root', PASSWORDS.root);
    legacyPackage = await exportPackage(legacy.db, token);
    const beforeData = await businessState(legacy.db);
    const beforeFunctions = await routineState(legacy.db);
    await legacy.db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    upgrade = { beforeData, afterData: await businessState(legacy.db), beforeFunctions,
      afterFunctions: await routineState(legacy.db) };
  } finally { await legacy.db.close(); }

  replay = await createSites(); // Strictly execute ALL real migrations, including SQL43.
  source = replay.oldSite;
  target = replay.newSite;
  await target.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await seedSource(source);
  await buildNewSite(target);
  await seedSettings(target, 'Target', true, 0.2);
  await seedAnnouncements(target, NEW, 'Target');
  session = await adminLogin(target, 'root', PASSWORDS.root);
  sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  currentPackage = await exportPackage(source, sourceSession);
  [backupModule, containerModule] = await Promise.all([compile('replacementBackup'), compile('container')]);
}, { timeout: 240000 });
after(async () => { await Promise.all([source?.close(), target?.close()]); });

test('full real replay includes SQL43 and retains exactly the twelve historical failures', async () => {
  assert.deepEqual(replay.files, (await readdir(new URL('../migrations/', import.meta.url)))
    .filter(file => file.endsWith('.sql')).sort());
  assert.ok(replay.files.includes(migration));
  assert.equal(EXPECTED_REPLAY_FAILURES.length, 12);
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  assert.equal(replay.validation.freshDatabaseVerified, false);
});
test('seeded SQL42 to SQL43 upgrade changes no business row and only three existing private function bodies', () => {
  assert.deepEqual(upgrade.afterData, upgrade.beforeData);
  assert.deepEqual(upgrade.afterFunctions.map(item => item.signature), upgrade.beforeFunctions.map(item => item.signature));
  const changed = upgrade.afterFunctions.filter((item, index) => item.hash !== upgrade.beforeFunctions[index].hash);
  assert.deepEqual(changed.map(item => item.signature).sort(), changedFunctions);
  for (const [index, item] of upgrade.afterFunctions.entries()) {
    const { hash: oldHash, ...oldMetadata } = upgrade.beforeFunctions[index];
    const { hash: newHash, ...newMetadata } = item;
    assert.deepEqual(newMetadata, oldMetadata, `${item.signature} retains volatility/security/path/ACL/owner`);
    if (!changedFunctions.includes(item.signature)) assert.equal(newHash, oldHash);
  }
});
test('replaced private helpers stay inaccessible to browser roles with original immutable/stable attributes', async () => {
  for (const signature of changedFunctions) {
    const metadata = upgrade.afterFunctions.find(item => item.signature === signature);
    assert.equal(metadata.provolatile, signature.includes('setting_valid') ? 'i' : 's');
    assert.equal(metadata.prosecdef, !signature.includes('setting_valid'));
    assert.ok(metadata.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar(target,
      'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role, signature]), false);
  }
});
test('shared helpers retain genuine read-only transaction behavior', async () => {
  await source.exec('BEGIN READ ONLY');
  try {
    await source.query('SELECT private.employee_transfer_shared_validate()');
    assert.deepEqual(await scalar(source, `SELECT jsonb_agg(body ORDER BY cursor COLLATE "C")
      FROM private.employee_transfer_shared_rows('system_configs')`), parsed(currentPackage.texts.system_configs));
    assert.equal(await scalar(source, `SELECT private.employee_transfer_shared_setting_valid('login_title','"Title"'::jsonb)`), true);
  } finally { await source.exec('ROLLBACK'); }
});
test('real new export has all seven unchanged table descriptors but no announcement, category or carousel data', async () => {
  assert.deepEqual(currentPackage.catalog.tables.map(item => item.key), keys);
  assert.deepEqual(parsed(currentPackage.texts.system_configs).map(item => item.key), settings);
  assert.deepEqual(parsed(legacyPackage.texts.system_configs).map(item => item.key), [...settings, ...carousel].sort());
  assert.equal(currentPackage.catalog.full_site_complete, false);
  assert.deepEqual(currentPackage.catalog.excluded_system_keys, legacyPackage.catalog.excluded_system_keys,
    'do not rewrite the existing catalog protocol/obsolete-key list');
  for (const text of Object.values(currentPackage.texts)) assert.doesNotMatch(text, /announcement_carousel_|Source announcement|announcement-only-/);
  const snapshot = await call(source, 'get_employee_export_site_snapshot', {
    p_admin_session_token: sourceSession, p_package_id: currentPackage.packageId,
  });
  assert.deepEqual(snapshot.catalogs.shared, currentPackage.catalog, 'SQL41 and SQL05 still produce the identical shared catalog');
});

for (const key of carousel) {
  for (const value of [true, 0.2, 'not-a-setting', null, { secret: 'local-only-value' }]) {
    test(`import whitelist always rejects excluded ${key} ${JSON.stringify(value)}`, async () => {
      assert.equal(await scalar(target, 'SELECT private.employee_transfer_shared_setting_valid($1,$2::jsonb)',
        [key, JSON.stringify(value)]), false);
    });
  }
}
test('carousel/announcement-only source changes do not enter export verification or SQL41 fingerprints', async () => transaction(source, async () => {
  const before = await call(source, 'get_employee_export_site_snapshot', {
    p_admin_session_token: sourceSession, p_package_id: currentPackage.packageId,
  });
  const job = await call(source, 'employee_export_shared_begin', {
    p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
  });
  await source.query(`UPDATE public.system_configs SET value='{"local":"arbitrary JSON"}'::jsonb WHERE key=ANY($1::text[])`, [carousel]);
  await source.query("UPDATE public.announcements SET title='Changed local announcement',is_hidden=NOT is_hidden");
  await source.query("UPDATE public.announcement_categories SET icon_name='local-category'");
  assert.equal((await call(source, 'employee_export_shared_verify', {
    p_admin_session_token: sourceSession, p_job_token: job.job_token,
  })).verified, true);
  assert.deepEqual(await call(source, 'get_employee_export_site_snapshot', {
    p_admin_session_token: sourceSession, p_package_id: currentPackage.packageId,
  }), before);
  await call(source, 'employee_export_shared_close', { p_admin_session_token: sourceSession, p_job_token: job.job_token });
  assert.deepEqual((await exportPackage(source, sourceSession)).catalog, currentPackage.catalog,
    'malformed values in excluded local keys cannot block a new export');
}));

for (const [key, value, pattern] of [
  ['unreviewed_setting', { secret: 'fixture-secret' }, /Unreviewed shared setting key/],
  ['login_title', { secret: 'fixture-secret' }, /Invalid shared setting value/],
  ['login_subtitle', '', /Invalid shared setting value/],
  ['admin_navigation_preferences', { order: ['unknown-tab'], labels: {} }, /Invalid shared setting value/],
]) test(`unchanged shared validation still blocks ${key}`, async () => transaction(source, async () => {
  await source.query(`INSERT INTO public.system_configs(key,value) VALUES ($1,$2::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [key, JSON.stringify(value)]);
  await assert.rejects(call(source, 'employee_export_shared_begin', {
    p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
  }), error => pattern.test(error.message) && !error.message.includes('fixture-secret'));
}));

// Single-key variants retain honest legacy bytes/row counts/hashes. The production
// code must reject them, never remove the rows or silently repair the bound catalog.
for (const included of [carousel, [carousel[0]], [carousel[1]]]) {
  for (const replacement of [false, true]) {
    test(`${replacement ? 'replacement' : 'create-only'} explicitly rejects genuine old-package rows ${included.join('+')}`,
      async () => transaction(target, async () => {
        const input = structuredClone(legacyPackage);
        if (included.length !== carousel.length) {
          input.texts.system_configs = parsed(input.texts.system_configs)
            .filter(item => !carousel.includes(item.key) || included.includes(item.key))
            .map(item => JSON.stringify(item) + '\n').join('');
          Object.assign(input.catalog.tables.find(item => item.key === 'system_configs'), {
            rows: parsed(input.texts.system_configs).length,
            bytes: Buffer.byteLength(input.texts.system_configs), sha256: hash(input.texts.system_configs),
          });
        }
        const before = await businessState(target);
        const job = await beginImport(input, replacement);
        assert.equal(job.success, true, 'catalog alone cannot reveal row keys; validate unchanged original rows at plan/apply');
        await stageAll(job, input);
        const request = replacement ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_shared_dry_run';
        await assert.rejects(call(target, request, auth(job)), error => error.code === '22023' && /Invalid shared import record/.test(error.message));
        const jobBefore = await scalar(target, 'SELECT to_jsonb(j)::text FROM private.employee_transfer_jobs j WHERE id=$1', [job.job_id]);
        if (replacement) await assert.rejects(apply(job, hash('unconfirmed')), /dry run/);
        else await assert.rejects(call(target, 'employee_import_shared_apply', { ...auth(job), p_plan_hash: hash('unconfirmed') }), /dry run|confirmed/);
        assert.equal(await scalar(target, 'SELECT to_jsonb(j)::text FROM private.employee_transfer_jobs j WHERE id=$1', [job.job_id]), jobBefore);
        assert.deepEqual(await scalar(target, 'SELECT options->\'catalog\' FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), input.catalog);
        assert.equal(await scalar(target, `SELECT payload->>'ndjson' FROM private.employee_transfer_staging
          WHERE job_id=$1 AND table_key='shared-import:system_configs' AND chunk_no=0`, [job.job_id]), input.texts.system_configs);
        assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), 0);
        assert.deepEqual(await businessState(target), before);
      }));
  }
}

async function* diskSource(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(65521);
    for (;;) {
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally { await handle.close(); }
}

for (const localChange of [false, true]) {
  test(`committed real replacement disk backup/authentication/seal/apply preserves every target announcement/category/carousel column (${localChange ? 'local change after sealing' : 'original target values'})`,
    { timeout: 60000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'announcement-exclusion-'));
    const before = await announcementState(target);
    const rootBefore = await scalar(target, 'SELECT to_jsonb(a)::text FROM public.admins a WHERE id=$1', [NEW.root]);
    const job = await beginImport(currentPackage);
    try {
      await stageAll(job, currentPackage);
      const plan = await dryRun(job);
      assert.equal(plan.can_apply, true, JSON.stringify(plan.conflicts));
      await assert.rejects(apply(job, plan.plan_hash), /saved and sealed/);
      const frozen = await descriptor(job);
      const paths = new Map(keys.map((key, index) => [`data/shared-${key}.ndjson`, join(directory, `plain-${index}`)]));
      const cipherPath = join(directory, 'independent.edx');
      const expected = {};
      let cleaned = false;
      let opens = 0;
      const result = await backupModule.createReplacementBackup(frozen, {
        async catalog() { return (await descriptor(job)).catalog; },
        async page(key, after) {
          const page = await call(target, 'get_employee_import_shared_backup_page', {
            ...auth(job), p_table_key: key, p_after: after, p_limit: 2,
          });
          expected[key] = (expected[key] ?? '') + page.ndjson;
          return page;
        },
        async verify() {
          assert.deepEqual(await dryRun(job), plan);
          return { verified: true, scope: 'shared-settings', full_site_complete: false };
        },
      }, {
        async append(path, bytes) {
          const handle = await open(paths.get(path), 'a');
          try { await handle.writeFile(bytes); } finally { await handle.close(); }
        },
        open(path) { return diskSource(paths.get(path)); },
        async abort() { cleaned = true; await Promise.all([...paths.values()].map(path => rm(path, { force: true }))); },
      }, {
        async write(stream) {
          const handle = await open(cipherPath, 'wx');
          try { for await (const bytes of stream) await handle.writeFile(bytes); await handle.sync(); }
          finally { await handle.close(); }
        },
        open() { opens++; return diskSource(cipherPath); },
      }, {
        append: (no, hex) => call(target, 'employee_import_shared_backup_append', {
          ...auth(job), p_plan_hash: plan.plan_hash, p_chunk_no: no, p_hex: hex,
        }),
        seal: (sha256, bytes) => call(target, 'employee_import_shared_backup_seal', {
          ...auth(job), p_plan_hash: plan.plan_hash, p_sha256: sha256, p_bytes: bytes,
        }),
      }, 'local-only-announcement-backup-passphrase');
      assert.equal(cleaned, true);
      assert.equal(opens, 2, 'authenticate disk ciphertext then independently reread for upload');
      for (const path of paths.values()) await assert.rejects(stat(path), { code: 'ENOENT' });
      const disk = await readFile(cipherPath);
      assert.equal(hash(disk), result.cipherSha256);
      assert.equal(result.bytes, disk.length);
      assert.equal(result.sealReceipt.backup_id, job.job_id);
      const recovered = [];
      for (let no = 0; no < result.chunks; no++) {
        const chunk = await call(target, 'get_employee_shared_saved_backup_chunk', {
          p_admin_session_token: session, p_backup_id: job.job_id, p_chunk_no: no,
        });
        assert.equal(chunk.sha256, hash(disk));
        recovered.push(Buffer.from(chunk.hex, 'hex'));
      }
      assert.deepEqual(Buffer.concat(recovered), disk);
      const plain = new Map();
      const manifest = await containerModule.verifyEncryptedVolume(diskSource(cipherPath),
        'local-only-announcement-backup-passphrase', {
          async append(path, chunk) { plain.set(path, [...(plain.get(path) ?? []), Buffer.from(chunk)]); },
          async abort() { assert.fail('independent real backup must authenticate'); },
        }, { expectedMetadata: { exportId: frozen.backup_id, volumeId: frozen.backup_id } });
      assert.equal(manifest.scope, 'replacement-backup');
      assert.equal(manifest.entries.length, 7);
      for (const key of keys) {
        const text = Buffer.concat(plain.get(`data/shared-${key}.ndjson`)).toString('utf8');
        assert.equal(text, expected[key]);
        assert.equal(hash(text), frozen.catalog.tables.find(item => item.key === key).sha256);
      }
      assert.deepEqual(parsed(expected.system_configs).map(item => item.key), settings);
      assert.doesNotMatch(Object.values(expected).join(''), /announcement_carousel_|Target announcement|announcement-only-/);
      assert.deepEqual(await announcementState(target), before, 'preparation and real backup have no announcement side effects');
      // Excluded fields are not part of the shared target hash. Their local
      // changes after sealing must remain intact, not be reverted or copied.
      if (localChange) {
        await target.query(`UPDATE public.system_configs SET value='3.25'::jsonb,
          description='local change after backup' WHERE key='announcement_carousel_speed'`);
        await target.query("UPDATE public.announcements SET is_hidden=NOT is_hidden WHERE created_by=$1", [NEW.branch]);
      }
      const atApply = await announcementState(target);
      if (localChange) assert.notDeepEqual(atApply, before);
      else assert.deepEqual(atApply, before);
      assert.deepEqual(await dryRun(job), plan);
      const receipt = await apply(job, plan.plan_hash);
      assert.equal(receipt.success, true);
      assert.equal(receipt.replaced_admins, 2);
      assert.equal(receipt.full_site_complete, false);
      assert.equal(receipt.admin_map[OLD.root], NEW.root);
      assert.deepEqual(await announcementState(target), atApply);
      assert.equal(await scalar(target, 'SELECT to_jsonb(a)::text FROM public.admins a WHERE id=$1', [NEW.root]), rootBefore);
      for (const key of settings) assert.deepEqual(await scalar(target, 'SELECT value FROM public.system_configs WHERE key=$1', [key]),
        parsed(currentPackage.texts.system_configs).find(item => item.key === key).value);
      assert.deepEqual(await rows(target, 'SELECT id,is_active FROM public.admins WHERE id IN ($1,$2) ORDER BY id', [NEW.branch, NEW.emergency]),
        [{ id: NEW.branch, is_active: false }, { id: NEW.emergency, is_active: false }]);
      assert.equal((await apply(job, plan.plan_hash)).repeated, true);
      assert.deepEqual(await announcementState(target), atApply);
      await call(target, 'employee_transfer_cancel', auth(job));
      assert.deepEqual(await announcementState(target), atApply, 'cancel cannot undo committed business changes');
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [job.job_id]), 0);
      assert.equal((await call(target, 'get_employee_shared_saved_backup_chunk', {
        p_admin_session_token: session, p_backup_id: job.job_id, p_chunk_no: 0,
      })).hex, recovered[0].toString('hex'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
