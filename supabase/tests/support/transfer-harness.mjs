import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { EXPECTED_REPLAY_FAILURES, assertExpectedReplayFailures, replayMigrations } from './replay-migrations.mjs';

const extensions = { pgcrypto, pg_trgm, uuid_ossp };
const signatures = new WeakMap();

// 仅为旧诊断调用保留文件名索引；严格校验绝不使用这个可变 Set 作白名单。
export const KNOWN_REPLAY_FAILURES = new Set(EXPECTED_REPLAY_FAILURES.map(item => item.file));

// 始终严格验证后才 dump/克隆；诊断请直接调用 replayMigrations。第二参数仅用于
// 隔离测试资源释放。两份克隆的 site_id 必然相同，测试必须显式模拟新站身份，
// 本助手不改身份、触发器审核、同站拒绝或任何正式 SQL 校验。
export async function createSites(
  options = {},
  { replay = replayMigrations, createDatabase = config => new PGlite(config) } = {},
) {
  const result = await replay({ ...options, strict: true });
  const { db: base, failures, files } = result;
  const opened = new Set([base]);
  try {
    const validation = assertExpectedReplayFailures(result, { upTo: options.upTo });
    const dump = await base.dumpDataDir('none');
    await base.close();
    opened.delete(base);
    const oldSite = createDatabase({ loadDataDir: dump, extensions });
    opened.add(oldSite);
    await oldSite.waitReady;
    const newSite = createDatabase({ loadDataDir: dump, extensions });
    opened.add(newSite);
    await newSite.waitReady;
    // 成功交付后由调用方关闭两站。
    return { failures, files, validation, oldSite, newSite };
  } catch (error) {
    const closed = await Promise.allSettled([...opened].map(async db => db.close()));
    const closeErrors = closed.filter(item => item.status === 'rejected').map(item => item.reason);
    if (closeErrors.length) {
      throw new AggregateError([error, ...closeErrors], `${error.message}; site cleanup failed`, { cause: error });
    }
    throw error;
  }
}

async function signature(db, name) {
  let cache = signatures.get(db);
  if (!cache) signatures.set(db, cache = new Map());
  if (!cache.has(name)) {
    const { rows } = await db.query(`SELECT p.proargnames AS names,
      (SELECT array_agg(format_type(item.type, NULL) ORDER BY item.position)
       FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS item(type, position)) AS types
      FROM pg_proc AS p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [name]);
    if (rows.length !== 1) throw new Error(`Function ${name} has ${rows.length} overloads`);
    cache.set(name, Object.fromEntries(rows[0].names.map((arg, index) => [arg, rows[0].types[index]])));
  }
  return cache.get(name);
}

const serialize = (value, type) => {
  if (value === undefined) return undefined;
  if (type === 'jsonb' || type === 'json') return JSON.stringify(value);
  return value;
}

// Calls a public RPC with named arguments exactly like PostgREST does, as the anon role.
export async function rpc(db, name, args = {}, { role = 'anon' } = {}) {
  const types = await signature(db, name);
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  for (const [arg] of entries) if (!(arg in types)) throw new Error(`${name} has no argument ${arg}`);
  const placeholders = entries.map(([arg], index) => `${arg} => $${index + 1}::${types[arg]}`).join(', ');
  const sql = `SELECT public.${name}(${placeholders}) AS value`;
  const params = entries.map(([arg, value]) => serialize(value, types[arg]));
  if (role) await db.exec(`SET ROLE ${role}`);
  try {
    const { rows } = await db.query(sql, params);
    return rows[0].value;
  } finally {
    if (role) await db.exec('RESET ROLE');
  }
}

export async function rows(db, sql, params = []) {
  return (await db.query(sql, params)).rows;
}
export async function one(db, sql, params = []) {
  return (await rows(db, sql, params))[0];
}
export async function scalar(db, sql, params = []) {
  const row = await one(db, sql, params);
  return row ? Object.values(row)[0] : undefined;
}

export async function expectRejects(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    if (!pattern.test(error.message)) throw new Error(`Expected /${pattern.source}/ but got: ${error.message}`);
    return error;
  }
  throw new Error(`Expected a rejection matching /${pattern.source}/`);
}

export async function adminLogin(db, username, password) {
  const result = await rpc(db, 'create_admin_financial_session', { p_username: username, p_password: password });
  if (!result.success) throw new Error(`Admin login failed for ${username}: ${JSON.stringify(result)}`);
  return result.session_token;
}

// ---------------------------------------------------------------------------------------------
// Export driver (mirrors what the browser exporter does, without encryption or media).
// ---------------------------------------------------------------------------------------------

export const EXPORT_TABLE_KEYS = [
  'wallet_ledger_entries', 'wallet_transactions', 'wallet_reconciliation_audit', 'orders',
  'messages', 'message_recipients', 'employee_login_history', 'work_sessions',
  'chat_customers', 'chat_rich_cards', 'chat_messages', 'chat_sessions', 'chat_annotations', 'chat_auto_logs',
];

export async function pagedRows(db, session, job, employeeId, key, limit = 1000) {
  const all = [];
  let after = null;
  for (;;) {
    const page = await rpc(db, 'get_employee_export_rows', {
      p_admin_session_token: session, p_job_token: job, p_employee_id: employeeId, p_table_key: key,
      p_after: after, p_limit: limit,
    });
    all.push(...page.rows);
    if (page.next_after === null || page.next_after === undefined) return all;
    after = page.next_after;
  }
}

export async function exportEmployees(db, { username, password, adminIds = null, employeeIds = null, limit = 1000 } = {}) {
  const session = await adminLogin(db, username, password);
  const begin = await rpc(db, 'employee_export_begin', { p_admin_session_token: session, p_admin_password: password });
  if (!begin.success) throw new Error(`export begin failed: ${JSON.stringify(begin)}`);
  const job = begin.job_token;
  const directory = await rpc(db, 'get_employee_export_directory', { p_admin_session_token: session, p_job_token: job });
  const preflight = await rpc(db, 'get_employee_export_preflight', {
    p_admin_session_token: session, p_job_token: job, p_admin_ids: adminIds, p_employee_ids: employeeIds,
  });
  const employees = [];
  let after = null;
  for (;;) {
    const page = await rpc(db, 'get_employee_export_employee_list', {
      p_admin_session_token: session, p_job_token: job, p_after: after, p_limit: 2,
      p_admin_ids: adminIds, p_employee_ids: employeeIds,
    });
    employees.push(...page.employees);
    if (!page.next_after) break;
    after = page.next_after;
  }
  const exported = [];
  for (const employee of employees) {
    const before = await rpc(db, 'get_employee_export_fingerprint', {
      p_admin_session_token: session, p_job_token: job, p_employee_id: employee.id });
    const core = await rpc(db, 'get_employee_export_core', {
      p_admin_session_token: session, p_job_token: job, p_employee_id: employee.id });
    const tables = {};
    for (const key of EXPORT_TABLE_KEYS) tables[key] = await pagedRows(db, session, job, employee.id, key, limit);
    const fingerprint = await rpc(db, 'get_employee_export_fingerprint', {
      p_admin_session_token: session, p_job_token: job, p_employee_id: employee.id });
    if (JSON.stringify(before) !== JSON.stringify(fingerprint)) throw new Error(`Employee ${employee.username} changed during the export`);
    exported.push({ employee, core, tables, fingerprint });
  }
  await rpc(db, 'employee_export_finish', { p_admin_session_token: session, p_job_token: job, p_summary: { employees: exported.length } });
  return { site_id: begin.site_id, directory, preflight, employees: exported };
}

// ---------------------------------------------------------------------------------------------
// Import driver.
// ---------------------------------------------------------------------------------------------

const chunk = (list, size) => {
  const parts = [];
  for (let index = 0; index < list.length; index += size) parts.push(list.slice(index, index + size));
  return parts.length ? parts : [];
};

export function manifestFor(pkg) {
  const customers = new Map();
  for (const item of pkg.employees) for (const customer of item.tables.chat_customers) customers.set(customer.id, customer);
  return {
    source_site_id: pkg.site_id,
    employees: pkg.employees.map(({ employee, core }) => ({
      id: employee.id, username: employee.username, employee_id: employee.employee_id,
      created_by: employee.created_by, created_by_username: employee.created_by_username,
      group_id: core.group?.id ?? null, group_name: core.group?.name ?? null, is_active: employee.is_active,
    })),
    customers: [...customers.values()],
  };
}

export function expectedCounts(item, roleMap) {
  const fp = item.fingerprint;
  const sessions = new Set(item.tables.chat_sessions.map(row => `${roleMap[row.customer_id]?.new_id}|${row.status}`));
  const annotations = new Set(item.tables.chat_annotations.map(row => roleMap[row.customer_id]?.new_id));
  return {
    ledger: fp.ledger.count, transactions: fp.wallet_transactions.count, withdrawals: fp.withdrawals.count,
    reconciliation_audit: fp.wallet_reconciliation_audit, verification: fp.verification_requests,
    message_recipients: fp.message_recipients, employee_login_history: fp.employee_login_history,
    work_sessions: fp.work_sessions.count, chat_messages: fp.chat_messages,
    chat_sessions: sessions.size, chat_annotations: annotations.size,
    orders: { count: fp.orders.count, success_commission: fp.orders.success_commission },
    pending_withdrawals: { count: fp.withdrawals.pending_count, amount: fp.withdrawals.pending_amount },
    wallet: fp.wallet, total_income: fp.total_income,
  };
}

export async function importPackage(db, pkg, {
  username, password, decisions = {}, roleDecision = null, only = null, stopAfterCore = false, batch = 1000,
} = {}) {
  const session = await adminLogin(db, username, password);
  const manifest = manifestFor(pkg);
  const dry = await rpc(db, 'get_employee_import_dry_run', {
    p_admin_session_token: session, p_manifest: manifest, p_decisions: decisions });
  const begin = await rpc(db, 'employee_import_begin', {
    p_admin_session_token: session, p_admin_password: password, p_decisions: decisions,
    p_summary: { source_site_id: pkg.site_id, employees: manifest.employees.length } });
  if (!begin.success) throw new Error(`import begin failed: ${JSON.stringify(begin)}`);
  const job = begin.job_token;
  const results = { dry, employees: {}, roles: [] };

  const customers = new Map();
  for (const item of pkg.employees) for (const customer of item.tables.chat_customers) customers.set(customer.id, customer);
  const roleDecisions = dry.roles.map(proposal => {
    const picked = roleDecision ? roleDecision(proposal) : null;
    const action = picked?.action ?? (proposal.action === 'merge' ? 'merge' : 'new');
    return { old_id: proposal.old_id, action, target_id: picked?.target_id ?? proposal.target_id,
      make_visible: picked?.make_visible ?? true, role: customers.get(proposal.old_id) };
  });
  if (roleDecisions.length) {
    const applied = await rpc(db, 'employee_import_apply_roles', {
      p_admin_session_token: session, p_job_token: job, p_decisions: roleDecisions });
    results.roles = applied.roles;
  }
  const roleMap = Object.fromEntries(results.roles.map(role => [role.old_id, role]));

  for (const item of pkg.employees) {
    const verdict = dry.employees.find(entry => entry.id === item.employee.id);
    if (only && !only.includes(item.employee.username)) continue;
    if (!(verdict.action === 'new' || verdict.resumable)) { results.employees[item.employee.username] = { skipped: verdict.reason }; continue; }
    const { core, tables } = item;
    const stage = async (key, list) => {
      let number = 0;
      for (const part of chunk(list, 2000)) {
        await rpc(db, 'employee_import_stage_chunk', {
          p_admin_session_token: session, p_job_token: job, p_employee_id: item.employee.id,
          p_table_key: key, p_chunk_no: number++, p_rows: part });
      }
    };
    await stage('account', [{ ...core.account, credential_password_hash: core.credential?.password_hash ?? null,
      credential_created_at: core.credential?.created_at ?? null, credential_updated_at: core.credential?.updated_at ?? null,
      group_id: core.group?.id ?? null, group_name: core.group?.name ?? null }]);
    await stage('wallet', core.wallet ? [core.wallet] : []);
    await stage('baseline', core.baseline ? [core.baseline] : []);
    await stage('ledger', tables.wallet_ledger_entries);
    await stage('transactions', tables.wallet_transactions);
    await stage('withdrawals', core.withdrawals);
    await stage('reconciliation_audit', tables.wallet_reconciliation_audit);
    await stage('verification', core.verification);
    const expected = expectedCounts(item, roleMap);
    const core_result = await rpc(db, 'employee_import_apply_core', {
      p_admin_session_token: session, p_job_token: job, p_employee_id: item.employee.id,
      p_expected: { account: 1, wallet: core.wallet ? 1 : 0, baseline: core.baseline ? 1 : 0, ledger: expected.ledger,
        transactions: expected.transactions, withdrawals: expected.withdrawals,
        reconciliation_audit: expected.reconciliation_audit, verification: expected.verification } });
    results.employees[item.employee.username] = { core: core_result };
    if (stopAfterCore) continue;

    const send = async (fn, key, list) => {
      for (const part of chunk(list, batch)) {
        await rpc(db, fn, { p_admin_session_token: session, p_job_token: job, p_employee_id: item.employee.id,
          p_table_key: key, p_rows: part });
      }
    };
    await send('employee_import_rows_batch', 'orders', tables.orders);
    await send('employee_import_rows_batch', 'messages', tables.messages);
    await send('employee_import_rows_batch', 'message_recipients', tables.message_recipients);
    await send('employee_import_rows_batch', 'employee_login_history', tables.employee_login_history);
    await send('employee_import_rows_batch', 'work_sessions', tables.work_sessions);
    await send('employee_import_chat_batch', 'chat_rich_cards', tables.chat_rich_cards);
    await send('employee_import_chat_batch', 'chat_messages', tables.chat_messages);
    await send('employee_import_chat_batch', 'chat_sessions', tables.chat_sessions);
    await send('employee_import_chat_batch', 'chat_annotations', tables.chat_annotations);
    await send('employee_import_chat_batch', 'chat_auto_logs', tables.chat_auto_logs);
    results.employees[item.employee.username].finalize = await rpc(db, 'employee_import_finalize_employee', {
      p_admin_session_token: session, p_job_token: job, p_employee_id: item.employee.id, p_expected: expected });
  }
  results.job = job;
  results.session = session;
  if (!stopAfterCore) {
    await rpc(db, 'employee_import_finish', { p_admin_session_token: session, p_job_token: job, p_summary: {} });
  }
  return results;
}
