import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const migrationDir = new URL('../../migrations/', import.meta.url);
const supportDir = new URL('./', import.meta.url);

// 本地逐项核对的历史缺口，不是跳过清单：每份 SQL 仍实际执行。
// blocksFreshDatabase 表示按现有历史从空库顺序建库的阻断风险，不能据此声称正式
// PostgreSQL 已验证。platform.sql 模拟 Storage/Auth/cron；baseline.sql 还含历史对象
// 和函数替身。严格匹配只证明这些已知失败没有变化，不证明全迁移通过或可正式建库。
export const EXPECTED_REPLAY_FAILURES = Object.freeze([
  {
    file: '20251031230000_add_admins_update_policy.sql',
    message: 'policy "Admins can update own info" for table "admins" already exists',
    reason: '较早的 20251031225405 已创建同名策略，本文件再次 CREATE POLICY。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库顺序执行也会遇到重复策略；不是 PGlite 专属问题。',
  },
  {
    file: '20251114230000_add_admin_scope_to_account_locks.sql',
    message: 'column "admin_id" does not exist',
    reason: '账户锁定策略查询 users.admin_id，但员工归属字段实际为 created_by。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库缺少该列时同样阻断；较早的修正版未使本文件可执行。',
  },
  {
    file: '20251114235000_fix_account_locks_rls_policies.sql',
    message: 'policy "Allow function access to account locks" for table "account_locks" already exists',
    reason: '20251114214731 的修正版已创建同名账户锁定策略，本文件没有先删除它。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库也有策略重名冲突，不能作为环境差异忽略。',
  },
  {
    file: '20251129073341_fix_all_function_search_paths.sql',
    message: 'function public.test_concurrent_dispatch(uuid, integer) does not exist',
    reason: '批量 ALTER FUNCTION 引用了此前历史没有创建的函数签名。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库需要补齐历史对象；现有 baseline 替身在更晚的阶段才创建。',
  },
  {
    file: '20260411213553_insert_bart_members_simulation_data.sql',
    message: 'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"',
    reason: '演示订单依赖固定的旧站员工 UUID，空测试库中没有这些员工。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '缺少相同前置资料的真实空库也会违反外键；不能靠伪造员工消除失败。',
  },
  {
    file: '20260411213832_fix_bart_commission_amounts_and_wallet_balances.sql',
    message: 'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"',
    reason: '演示佣金修正再次给固定旧站员工写订单，仍依赖不存在的员工资料。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库缺少前置员工时同样阻断，并非资金修正已经通过验证。',
  },
  {
    file: '20260706000801_revoke_unused_security_definer_functions.sql',
    message: 'function public.cleanup_old_dispatch_assignments() does not exist',
    reason: 'REVOKE 引用了历史中缺失的无参清理函数；现有 baseline 未定义此签名。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库没有该函数时 REVOKE 也失败，不能证明历史权限收紧已完整执行。',
  },
  {
    file: '20260706001347_fix_security_definer_revoke_from_public.sql',
    message: 'function public.set_employee_session(uuid, uuid) does not exist',
    reason: '重新授权引用了缺失的双 UUID 会话函数；现有替身不包含该函数。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库仍缺失被授权对象；不能把继续回放当成全部授权成功。',
  },
  {
    file: '20260706002034_convert_client_functions_to_security_invoker.sql',
    message: 'function public.set_employee_session(uuid, uuid) does not exist',
    reason: '客户端函数权限模式转换也依赖同一个缺失的会话函数签名。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库对不存在的签名执行 ALTER FUNCTION 同样阻断。',
  },
  {
    file: '20260706002123_convert_internal_functions_to_security_invoker.sql',
    message: 'function public.cleanup_old_dispatch_assignments() does not exist',
    reason: '内部函数权限模式转换依赖缺失的无参派单清理函数。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库仍有函数历史缺口；相关权限模式不能视为已验证。',
  },
  {
    file: '20260928080144_align_weighted_dispatch_assignment.sql',
    message: 'Secure dispatch pool validation changed; cannot apply weighted pool patch.',
    reason: '实际回放得到的安全派单函数定义不符合补丁要求的唯一文本锚点，保护检查拒绝修改。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '相同定义的真实库也会被保护检查阻断；尚未在真实 PostgreSQL 核对定义差异。',
  },
  {
    file: '20261026000000_archive_legacy_empty_notifications.sql',
    message: 'Historical notification inventory changed; inspect before cleanup.',
    reason: '一次性历史清理要求通知数量恰为 167/21/140/6，空库不满足该旧站清单。',
    blocksFreshDatabase: true,
    realDatabaseImpact: '真实空库也不满足固定资料数量；不能伪造通知或绕过清理保护来放行建库。',
  },
].map(item => Object.freeze(item)));

const withinScope = (file, upTo) => !upTo || file <= upTo;

// 显式可调用的纯校验器。期望集合来自审核记录和截止范围，绝不从实际 failures/files
// 反推，因此删除文件、失败变成功或提前截断回放都不会悄悄缩小期望集合。
export function assertExpectedReplayFailures({ files, failures }, { upTo = null } = {}) {
  const expected = EXPECTED_REPLAY_FAILURES.filter(item => withinScope(item.file, upTo));
  const byFile = new Map(expected.map(item => [item.file, item]));
  const replayed = new Set(files);
  const seen = new Set();
  const matched = [];
  const issues = [];
  for (const file of files) {
    if (!withinScope(file, upTo)) issues.push({ kind: 'out-of-scope', file });
  }
  for (const failure of failures) {
    const item = byFile.get(failure.file);
    if (!withinScope(failure.file, upTo)) {
      issues.push({ kind: 'out-of-scope', ...failure });
    } else if (!replayed.has(failure.file)) {
      issues.push({ kind: 'not-replayed', ...failure });
    } else if (!item) {
      issues.push({ kind: 'unexpected', ...failure });
    } else if (seen.has(failure.file)) {
      issues.push({ kind: 'duplicate', ...failure });
    } else if (failure.message !== item.message) {
      issues.push({ kind: 'message-changed', ...failure, expectedMessage: item.message });
    } else {
      matched.push(failure);
    }
    seen.add(failure.file);
  }
  for (const item of expected) {
    if (!replayed.has(item.file)) issues.push({ kind: 'not-replayed', file: item.file });
    else if (!seen.has(item.file)) issues.push({ kind: 'missing', file: item.file, expectedMessage: item.message });
  }
  if (issues.length) {
    const error = new Error(`Replay baseline mismatch (${issues.length}):\n${issues.map(issue => JSON.stringify(issue)).join('\n')}`);
    error.issues = issues;
    error.files = files;
    error.failures = failures;
    throw error;
  }
  return { expected, matched, freshDatabaseVerified: false };
}

// baseline.sql is split on "-- @before <migration file prefix>" markers; the first segment runs
// right after the first migration, the others run immediately before the named migration.
function parseBaseline(text) {
  const segments = [{ before: null, sql: '' }];
  for (const line of text.split('\n')) {
    const marker = line.match(/^-- @before (\S+)/);
    if (marker) segments.push({ before: marker[1], sql: '' });
    else segments.at(-1).sql += `${line}\n`;
  }
  return segments;
}

// 默认仍收集失败供诊断；strict: true 才执行审核门槛。第二参数仅用于资源生命周期测试，
// 正常回放和集成测试始终用真实 PGlite / platform.sql / 历史 SQL，不扩充替身或跳过文件。
export async function replayMigrations(
  { log = () => {}, upTo = null, strict = false } = {},
  { createDatabase = options => new PGlite(options) } = {},
) {
  if (typeof strict !== 'boolean') throw new TypeError('strict must be a boolean');
  const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort()
    .filter(name => withinScope(name, upTo));
  const segments = parseBaseline(await readFile(new URL('baseline.sql', supportDir), 'utf8'));
  const db = createDatabase({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  const failures = [];
  const setup = async (sql, label) => {
    try {
      await db.exec(sql);
    } catch (cause) {
      throw new Error(`Replay setup failed (${label}): ${cause.message}`, { cause });
    }
  };
  try {
    await setup(await readFile(new URL('platform.sql', supportDir), 'utf8'), 'platform.sql');
    for (const [index, file] of files.entries()) {
      for (const segment of segments) {
        if (segment.before && file.startsWith(segment.before)) {
          await setup(segment.sql, `baseline.sql before ${file}`);
        }
      }
      let sql = await readFile(new URL(file, migrationDir), 'utf8');
      // 保留原平台兼容处理：cron 由 platform.sql 模拟，pg_trgm 已由扩展加载。
      sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron[^;]*;/gi, '')
        .replace(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/gi, '');
      try {
        await db.exec(sql);
      } catch (error) {
        failures.push({ file, message: String(error.message) });
        // ROLLBACK 在没有事务时只是警告；若连接/回滚本身失败，不能继续使用坏库。
        await db.exec('ROLLBACK');
      }
      if (index === 0) await setup(segments[0].sql, 'baseline.sql after first migration');
    }
    log(`replayed ${files.length} migrations, ${failures.length} failed (test substitutes; not a clean database build)`);
    const result = { db, failures, files };
    if (strict) result.validation = assertExpectedReplayFailures(result, { upTo });
    return result;
  } catch (error) {
    try {
      await db.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], `${error.message}; database close failed`, { cause: error });
    }
    throw error;
  }
}
