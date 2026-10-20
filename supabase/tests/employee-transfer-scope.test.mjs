import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import {
  EXPECTED_REPLAY_FAILURES, assertExpectedReplayFailures, replayMigrations,
} from './support/replay-migrations.mjs';
import {
  TRANSFER_SCOPE_COVERAGE_INVENTORY as inventory,
  TRANSFER_SCOPE_COVERAGE_NOTICE,
  assertTransferScopeCoverage,
} from './support/transfer-scope.mjs';

const keyOf = table => `${table.schema}.${table.name}`;
const snapshot = () => inventory.map(({ schema, name, columns }) => ({ schema, name, columns: structuredClone(columns) }));
const descriptor = key => {
  const table = inventory.find(table => keyOf(table) === key);
  assert.ok(table, `missing inventory entry ${key}`);
  return table;
};
const columnsOf = key => descriptor(key).columns.map(column => column.name);

function expectMismatch(actual, expectedIssues) {
  const before = structuredClone(actual);
  assert.throws(() => assertTransferScopeCoverage(actual), error => {
    assert.match(error.message, /Transfer scope coverage inventory mismatch/);
    for (const expected of expectedIssues) {
      assert.ok(error.issues.some(issue => Object.entries(expected).every(([key, value]) => issue[key] === value)),
        `missing issue ${JSON.stringify(expected)} in ${error.message}`);
    }
    return true;
  });
  assert.deepEqual(actual, before, 'rejection must not mutate catalog input');
}

function assertIntent(key, mode, patterns) {
  const table = descriptor(key);
  assert.equal(table.mode, mode, `${key} classification is only a review intent`);
  for (const pattern of patterns) assert.match(table.reason, pattern, key);
}

test('stage A inventory is deeply frozen schema metadata, not export permission or implemented transforms', () => {
  assert.equal(inventory.length, 109, 'new roots require explicit inventory review');
  assert.equal(inventory.reduce((count, table) => count + table.columns.length, 0), 967);
  assert.equal(new Set(inventory.map(keyOf)).size, 109);
  assert.equal(inventory.filter(table => table.schema === 'private').length, 24);
  assert.equal(inventory.filter(table => table.schema === 'public').length, 85);
  assert.match(TRANSFER_SCOPE_COVERAGE_NOTICE, /阶段A覆盖库存/);
  assert.match(TRANSFER_SCOPE_COVERAGE_NOTICE, /不是导出授权白名单/);
  assert.match(TRANSFER_SCOPE_COVERAGE_NOTICE, /transform尚未逐字段实现/);
  assert.match(TRANSFER_SCOPE_COVERAGE_NOTICE, /不代表已支持全站迁移/);
  assert.ok(Object.isFrozen(inventory));
  for (const table of inventory) {
    assert.deepEqual(Object.keys(table).sort(), ['columns', 'mode', 'name', 'reason', 'schema']);
    assert.ok(Object.isFrozen(table));
    assert.ok(Object.isFrozen(table.columns));
    assert.ok(['transfer', 'transform', 'rebuild', 'exclude'].includes(table.mode));
    assert.ok(['public', 'private'].includes(table.schema));
    assert.match(table.name, /^[a-z_]+$/);
    assert.ok(table.reason.length >= 20, keyOf(table));
    assert.doesNotMatch(table.reason, /REVIEW|https?:\/\/|[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    assert.ok(table.columns.length > 0);
    assert.equal(new Set(table.columns.map(column => column.name)).size, table.columns.length);
    for (const column of table.columns) {
      assert.deepEqual(Object.keys(column).sort(), ['name', 'nullable', 'type']);
      assert.ok(Object.isFrozen(column));
      assert.equal(typeof column.name, 'string');
      assert.equal(typeof column.type, 'string');
      assert.equal(typeof column.nullable, 'boolean');
      assert.ok(column.name && column.type);
    }
  }
  assert.throws(() => { inventory.push({}); }, TypeError);
  assert.throws(() => { inventory[0].mode = 'transfer'; }, TypeError);
  assert.throws(() => { inventory[0].columns.push({}); }, TypeError);
  assert.throws(() => { inventory[0].columns[0].nullable = true; }, TypeError);
});

test('pure validator accepts the explicit snapshot irrespective of catalog row ordering, without mutation', () => {
  const actual = snapshot().reverse();
  for (const table of actual) table.columns.reverse();
  const before = structuredClone(actual);
  assert.deepEqual(assertTransferScopeCoverage(actual), { tableCount: 109, columnCount: 967, exportAuthorized: false });
  assert.deepEqual(actual, before);
  assertTransferScopeCoverage(inventory);
});

test('pure validator rejects extra roots in either schema and never learns them on a second call', () => {
  for (const schema of ['public', 'private', 'unreviewed']) {
    const actual = snapshot();
    actual.push({ schema, name: 'unreviewed_business_state', columns: [{ name: 'id', type: 'uuid', nullable: false }] });
    const expected = [{ kind: 'unknown-table', table: `${schema}.unreviewed_business_state` }];
    expectMismatch(actual, expected);
    expectMismatch(actual, expected);
    actual.at(-1).columns = [];
    expectMismatch(actual, expected);
  }
  assertTransferScopeCoverage(snapshot());
});

test('pure validator requires every root, including sensitive, rebuild and exclude entries', () => {
  for (const missing of inventory) {
    expectMismatch(snapshot().filter(table => keyOf(table) !== keyOf(missing)),
      [{ kind: 'missing-table', table: keyOf(missing) }]);
  }
});

test('pure validator rejects added, removed and renamed columns on every root', () => {
  for (const original of inventory) {
    const actual = snapshot();
    const table = actual.find(table => keyOf(table) === keyOf(original));
    const name = table.columns[0].name;
    table.columns.push({ name: 'unreviewed_secret', type: 'text', nullable: true });
    expectMismatch(actual, [{ kind: 'unknown-column', table: keyOf(table), column: 'unreviewed_secret' }]);
    table.columns.pop();
    table.columns.shift();
    expectMismatch(actual, [{ kind: 'missing-column', table: keyOf(table), column: name }]);
    table.columns.unshift({ ...original.columns[0], name: 'renamed_column' });
    expectMismatch(actual, [
      { kind: 'missing-column', table: keyOf(table), column: name },
      { kind: 'unknown-column', table: keyOf(table), column: 'renamed_column' },
    ]);
  }
});

test('pure validator detects type and nullable changes for all 967 columns', () => {
  const actual = snapshot();
  for (const table of actual) {
    for (const column of table.columns) {
      const { type, nullable } = column;
      column.type = type === 'text' ? 'uuid' : 'text';
      expectMismatch(actual, [{ kind: 'type-changed', table: keyOf(table), column: column.name, expected: type, actual: column.type }]);
      column.type = type;
      column.nullable = !nullable;
      expectMismatch(actual, [{ kind: 'nullable-changed', table: keyOf(table), column: column.name, expected: nullable, actual: !nullable }]);
      column.nullable = nullable;
    }
  }
  assertTransferScopeCoverage(actual);
});

test('pure validator does not normalize away numeric precision, timestamp zones, arrays or nullable booleans', () => {
  const actual = snapshot();
  const group = actual.find(table => keyOf(table) === 'public.dispatch_groups');
  group.columns.find(column => column.name === 'commission_rate').type = 'numeric(12,7)';
  const users = actual.find(table => keyOf(table) === 'public.users');
  users.columns.find(column => column.name === 'tags').type = 'text';
  users.columns.find(column => column.name === 'created_at').type = 'timestamp without time zone';
  users.columns.find(column => column.name === 'is_active').nullable = 'true';
  expectMismatch(actual, [
    { kind: 'type-changed', table: 'public.dispatch_groups', column: 'commission_rate' },
    { kind: 'type-changed', table: 'public.users', column: 'tags' },
    { kind: 'type-changed', table: 'public.users', column: 'created_at' },
    { kind: 'nullable-changed', table: 'public.users', column: 'is_active' },
  ]);
});

test('pure validator rejects duplicate or malformed descriptors instead of silently deduplicating', () => {
  for (const invalid of [null, {}, 'public.users']) assert.throws(() => assertTransferScopeCoverage(invalid), TypeError);
  const actual = snapshot();
  actual.push(structuredClone(actual[0]));
  expectMismatch(actual, [{ kind: 'duplicate-table', table: keyOf(actual[0]) }]);
  actual.pop();
  actual[0].columns.push(structuredClone(actual[0].columns[0]));
  expectMismatch(actual, [{ kind: 'duplicate-column', table: keyOf(actual[0]), column: actual[0].columns[0].name }]);
  actual[0].columns.pop();
  actual[0].columns.push(null);
  expectMismatch(actual, [{ kind: 'invalid-column', table: keyOf(actual[0]) }]);
  actual[0].columns = null;
  expectMismatch(actual, [{ kind: 'invalid-columns', table: keyOf(actual[0]) }]);
  actual[0] = null;
  expectMismatch(actual, [{ kind: 'invalid-table', index: 0 }, { kind: 'missing-table', table: keyOf(inventory[0]) }]);
});

test('inventory reserves target super-admin identity and requires non-root credential and employee session transforms', () => {
  for (const key of ['public.admins', 'public.financial_admin_credentials']) {
    assertIntent(key, 'transform', [/仅迁非超管/, /保留目标超管/, /旧超管/]);
  }
  assertIntent('public.admins', 'transform', [/禁止提权/, /密码/, /登录身份/]);
  assertIntent('public.financial_admin_credentials', 'transform', [/password_hash不得导入/, /映射admin_id/]);
  assertIntent('public.users', 'transform', [/完整业务属性/, /空值语义/, /清空/, /current_session_token/, /session_created_at/, /last_heartbeat_at/, /current_tab_id/, /映射created_by/]);
  assertIntent('public.financial_employee_credentials', 'transform', [/原密码校验资料/, /映射user_id/, /清空源会话/, /不迁明文密码/]);
  assertIntent('private.employee_transfer_site', 'rebuild', [/不迁源站identity/, /保留目标站点独立身份/, /同站导入保护/]);
  for (const name of ['tags', 'remarks', 'is_pinned', 'is_active', 'created_by', 'employee_id', 'password_hash']) {
    assert.ok(columnsOf('public.users').includes(name), name);
  }
});

test('inventory requires configuration-key review and mapped redacted financial deduplication, not request copying', () => {
  for (const key of ['public.system_configs', 'public.group_configs', 'public.admin_configs']) {
    assertIntent(key, 'transform', [/配置键/, /秘密/, /未知键阻断/]);
  }
  assertIntent('public.financial_operations', 'transform', [/幂等去重/, /审计/, /映射/, /request_data\/result/, /脱敏/, /不原样复制请求/, /不重放入账/]);
  for (const key of ['public.commission_audit_log', 'public.money_data_protection_audit', 'public.orders_history']) {
    assertIntent(key, 'transform', [/历史订单原文/, /映射/]);
  }
  assertIntent('public.orders', 'transform', [/已完成精简订单/, /佣金率/, /排除真实订单金额/, /订单号\/交易号/, /产品和详情/, /processing只报告不导入/]);
  for (const key of ['public.wallet_transactions', 'public.wallet_reconciliation_audit']) {
    assertIntent(key, 'transform', [/脱敏/, /历史订单原文/]);
  }
});

test('inventory includes user-confirmed continuing-business originals and anti-reuse state, but not historical detail by default', () => {
  for (const key of ['public.valid_order_data', 'public.used_order_data', 'public.dispatch_group_orders', 'public.dispatch_order_pools']) {
    assertIntent(key, 'transform', [/用户已确认/, /继续营业/, /原文/, /映射/]);
  }
  assertIntent('public.valid_order_data', 'transform', [/防重复状态/, /usage_count/, /启停/]);
  assertIntent('public.used_order_data', 'transform', [/防重复使用状态/, /不恢复已完成订单详情/]);
  assertIntent('public.valid_order_data_archive', 'transform', [/人工审核/, /业务计数/, /纯历史详细/, /原文排除/, /不能自动套用/]);
  for (const key of ['public.valid_data_audit_log', 'public.valid_data_error_log', 'public.valid_data_monthly_stats']) {
    assertIntent(key, 'transform', [/审核/, /计数/, /纯历史详细原文/]);
  }
  assertIntent('public.valid_data_query_performance', 'exclude', [/历史详细原文/, /不自动纳入/]);
  assertIntent('public.dispatch_orders', 'transform', [/人工审核/, /继续营业/, /原文/, /排除已完成历史详情/]);
});

test('inventory keeps read-only archives and reviews media purpose without copying source paths or purge authority', () => {
  for (const key of ['private.content_audit_events', 'private.deleted_employee_accounts', 'private.deleted_employee_notifications', 'private.content_audit_recipient_versions']) {
    assertIntent(key, 'transform', [/来源namespace/, /档案/, /旧.*身份/, /媒体URL关系/, /私有附件实际搬迁待完成/]);
    assert.doesNotMatch(descriptor(key).reason, /映射管理员|映射归属|映射message_id|转换.*身份/, key);
  }
  assertIntent('private.deleted_employee_accounts', 'transform', [/不恢复在职账号/]);
  assertIntent('private.content_audit_recipient_versions', 'transform', [/清除投递领取令牌/]);
  for (const key of ['private.content_audit_public_media_claims', 'private.employee_chat_image_deletion_claims']) {
    assertIntent(key, 'transform', [/逐用途人工审核/, /永久防复用标记/, /映射/, /不重放删除|不.*重放删除/]);
  }
  assertIntent('private.content_audit_storage_origins', 'rebuild', [/信任域/, /目标Storage/, /不迁源站origin/]);
  assertIntent('private.content_audit_purge_windows', 'rebuild', [/短期授权窗口/, /token_hash/, /重新验证密码授权/]);
  assertIntent('private.employee_work_stop_markers', 'transform', [/主动停工语义/, /映射user_id/, /不能丢弃/, /自动复工/]);
  assertIntent('public.work_sessions', 'transform', [/最后心跳结束/, /主动停工/, /不能伪造在线/]);
});

test('inventory treats transferred archive records as namespaced business history, not disposable job bookkeeping', () => {
  const key = 'private.employee_transfer_archive_records';
  assertIntent(key, 'transform', [
    /source_site_id/, /package_id/, /独立来源namespace/, /只读业务档案/, /旧身份/, /原文/, /媒体URL关系/,
    /不是目标活账号、任务回执或仅技术备份/, /不按任务记录排除/, /未来再次迁站不可静默遗漏/, /私有附件实际搬迁待完成/,
  ]);
  assert.deepEqual(descriptor(key).columns, [
    { name: 'source_site_id', type: 'uuid', nullable: false },
    { name: 'package_id', type: 'uuid', nullable: false },
    { name: 'table_key', type: 'text', nullable: false },
    { name: 'source_id', type: 'text', nullable: false },
    { name: 'body', type: 'jsonb', nullable: false },
    { name: 'source_line', type: 'text', nullable: false },
    { name: 'job_id', type: 'uuid', nullable: false },
    { name: 'imported_at', type: 'timestamp with time zone', nullable: false },
  ]);
  // 即使带job_id且使用employee_transfer_前缀，也不能和技术任务/独立备份一同排除。
  for (const name of ['jobs', 'events', 'staging', 'shared_backups', 'notification_backups', 'chat_backups']) {
    assert.equal(descriptor(`private.employee_transfer_${name}`).mode, 'exclude');
  }
  expectMismatch(snapshot().filter(table => keyOf(table) !== key), [{ kind: 'missing-table', table: key }]);
});

test('inventory retains business settings, content, financial state, login history and automation execution progress', () => {
  const businessRoots = [
    'private.notification_delivery_operations', 'private.employee_transfer_archive_records',
    ...[
      'admin_group_members', 'admin_groups', 'broadcast_messages',
      'broadcast_recipients', 'ccc_conversation_annotations', 'cs_message_templates', 'customer_auto_message_logs',
      'customer_auto_messages', 'customer_employee_conversations', 'customer_service_sessions', 'data_retention_policies',
      'dispatch_config', 'dispatch_group_members', 'dispatch_groups', 'employee_login_history',
      'employee_submit_time_settings', 'history_cleanup_config', 'history_cleanup_log', 'message_recipients',
      'message_templates', 'messages', 'notification_automation_date_runs', 'notification_automation_executions',
      'notification_automation_failures', 'notification_automation_plan_members', 'notification_automation_plans',
      'notification_automation_progress', 'notification_automation_task_recipients', 'notification_automation_tasks',
      'product_types', 'rating_requests', 'rich_card_contents', 'service_ratings', 'simulated_customers',
      'submit_time_groups', 'verification_requests', 'wallet_balance_baselines', 'wallet_ledger_entries',
      'wallet_reconciliation_audit', 'wallet_transactions', 'wallets', 'withdrawals', 'work_sessions',
    ].map(name => `public.${name}`),
  ];
  for (const key of businessRoots) assert.ok(['transfer', 'transform'].includes(descriptor(key).mode), key);
  assertIntent('public.employee_login_history', 'transform', [/真实登录历史/, /设备\/IP/, /session_id仅作历史脱敏映射/, /新登录继续追加/]);
  assertIntent('public.customer_auto_message_logs', 'transform', [/已发标记/, /防止登录补发/]);
  assertIntent('public.notification_automation_progress', 'transform', [/基线/, /周期进度/, /不得重置/]);
  assertIntent('public.notification_automation_executions', 'transform', [/执行唯一标记/, /奖励流水关联/, /禁止重放发奖/]);
  assertIntent('public.notification_automation_date_runs', 'transform', [/已执行标记/, /不重置基线/]);
  for (const key of ['private.notification_delivery_operations', 'public.notification_automation_failures', 'public.rating_requests', 'public.history_cleanup_log']) {
    assertIntent(key, 'transform', [/人工审核/, /映射/]);
  }
  assertIntent('public.message_recipients', 'transform', [/保留通知已读/, /清除delivery_claim_token/, /delivery_completed_claim_token/, /不复用源领取租约/]);
});

test('inventory excludes announcements without excluding notifications or broadcast delivery', () => {
  for (const key of ['public.announcements', 'public.announcement_categories']) {
    assertIntent(key, 'exclude', [/用户明确不迁移公告/, /不导出、不导入、不覆盖/, /保留新站现有/]);
  }
  assertIntent('public.announcements', 'exclude', [/created_by/, /轮播和素材/, /仅供公告使用的文件排除/, /仍被通知\/聊天引用/]);
  for (const name of ['broadcast_messages', 'broadcast_recipients', 'messages', 'message_recipients', 'notification_automation_plans']) {
    assert.equal(descriptor(`public.${name}`).mode, 'transform');
  }
});

test('inventory requires global product-name matching and source replacement without rebuilding target history', () => {
  assertIntent('public.product_types', 'transform', [
    /全站唯一名称/, /同名复用目标ID/, /来源覆盖排序、启停和业务时间/, /重写来源引用/,
    /不删除重建/, /目标既有订单历史/, /无同名新增/, /目标不同名保留/, /同ID异名称冲突阻断/, /覆盖前备份校验/,
  ]);
});

test('inventory rebuilds or excludes sessions, security locks, tooling, cron queues, realtime and live dispatch leases', () => {
  const runtimeRoots = [
    ...[
      'content_audit_delete_jobs', 'content_audit_purge_windows', 'content_audit_storage_origins',
      'deleted_employee_delete_jobs', 'employee_transfer_events', 'employee_transfer_excluded_columns',
      'employee_transfer_jobs', 'employee_transfer_site', 'employee_transfer_staging', 'employee_transfer_trigger_policy',
    ].map(name => `private.${name}`),
    ...[
      'account_lock_events', 'account_locks', 'admin_financial_sessions', 'bulk_import_log', 'dispatch_assignments',
      'dispatch_performance_metrics', 'dispatch_pool_selections', 'dispatch_rate_limits', 'dispatch_sessions',
      'dispatch_system_logs', 'employee_financial_sessions', 'employee_login_history_events', 'employee_presence_events',
      'financial_login_attempts', 'login_attempts', 'notification_automation_queue', 'valid_data_query_performance',
      'wallet_reconciliation_queue', 'withdrawal_events',
    ].map(name => `public.${name}`),
  ];
  for (const key of runtimeRoots) assert.ok(['rebuild', 'exclude'].includes(descriptor(key).mode), key);
  assertIntent('public.notification_automation_queue', 'rebuild', [/已保留成员/, /进度/, /执行\/失败标记/, /截止点/, /不重新发旧奖励/]);
  assertIntent('public.wallet_reconciliation_queue', 'rebuild', [/先验证已迁钱包/, /基准/, /账本/, /pending提款/]);
});

test('strict local replay attempts all migrations once and matches the fixed 109-root coverage inventory', { timeout: 180_000 }, async t => {
  const diskFiles = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  const result = await replayMigrations({ strict: true });
  try {
    assert.deepEqual(result.files, diskFiles, 'no skipped, truncated or selected migration replay');
    assert.equal(result.files.length, 572, 'migration baseline changed: review before updating the inventory');
    assert.equal(EXPECTED_REPLAY_FAILURES.length, 12);
    assert.deepEqual(result.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
    assert.equal(result.validation.matched.length, 12);
    assert.equal(result.validation.freshDatabaseVerified, false, 'known failures and platform substitutes do not prove a clean build');
    for (const file of [
      '20261102000000_employee_data_transfer_foundation.sql',
      '20261102000001_employee_data_export.sql',
      '20261102000002_employee_data_import_prepare.sql',
      '20261102000003_employee_data_import_write.sql',
      '20261102000004_harden_employee_transfer_triggers.sql',
      '20261102000005_export_shared_site_settings.sql',
      '20261102000006_import_shared_site_settings.sql',
      '20261102000007_replace_shared_site_settings.sql',
      '20261102000008_transfer_product_catalog.sql',
      '20261102000009_export_dispatch_submission_data.sql',
      '20261102000010_prepare_dispatch_submission_import.sql',
      '20261102000011_guard_transfer_maintenance.sql',
      '20261102000012_restore_dispatch_configuration.sql',
      '20261102000013_restore_valid_submission_data.sql',
      '20261102000014_export_stage_employee_identities.sql',
      '20261102000015_restore_employee_identities.sql',
      '20261102000016_restore_dispatch_dependencies.sql',
      '20261102000017_export_stage_employee_finance.sql',
      '20261102000018_restore_employee_finance.sql',
      '20261102000019_export_stage_employee_activity.sql',
      '20261102000020_restore_employee_activity.sql',
      '20261102000021_export_stage_employee_verification.sql',
      '20261102000022_restore_employee_verification_media.sql',
      '20261102000023_export_stage_site_notifications.sql',
      '20261102000024_check_site_notification_links.sql',
      '20261102000025_prepare_notification_configuration.sql',
      '20261102000026_transfer_notification_media.sql',
      '20261102000027_restore_site_notifications.sql',
      '20261102000028_export_stage_site_chat.sql',
      '20261102000029_plan_site_chat_merge.sql',
      '20261102000030_prepare_chat_merge.sql',
      '20261102000031_transfer_chat_media.sql',
      '20261102000032_restore_site_chat.sql',
      '20261102000033_transfer_readonly_archives.sql',
      '20261102000034_restore_readonly_archives.sql',
      '20261102000035_transfer_archive_evidence.sql',
      '20261102000036_list_transferred_archives.sql',
      '20261102000037_plan_employee_replacement.sql',
      '20261102000038_reexport_archive_namespaces.sql',
      '20261102000039_export_employee_replacement_backup.sql',
      '20261102000040_close_shared_export.sql',
      '20261102000041_snapshot_site_export.sql',
      '20261102000042_stop_owned_export.sql',
      '20261102000043_preserve_transfer_announcements.sql',
      '20261102000044_preflight_site_restore.sql',
      '20261102000045_verify_site_prerequisites.sql',
    ]) {
      assert.ok(result.files.includes(file));
      assert.ok(!result.failures.some(failure => failure.file === file), `${file} must succeed`);
    }
    const { rows: actualTables } = await result.db.query(`
      SELECT namespace.nspname AS schema, relation.relname AS name,
        COALESCE(jsonb_agg(jsonb_build_object(
          'name', attribute.attname,
          'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
          'nullable', NOT attribute.attnotnull
        ) ORDER BY attribute.attnum) FILTER (WHERE attribute.attnum IS NOT NULL), '[]'::jsonb) AS columns
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      WHERE namespace.nspname IN ('public', 'private')
        AND relation.relkind IN ('r', 'p') AND NOT relation.relispartition
      GROUP BY namespace.nspname, relation.relname
      ORDER BY namespace.nspname, relation.relname
    `);
    assert.equal(actualTables.length, 109);
    assert.deepEqual(assertTransferScopeCoverage(actualTables), { tableCount: 109, columnCount: 967, exportAuthorized: false });
    const { rows: partitions } = await result.db.query(`
      SELECT relation.relname FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('public', 'private') AND relation.relispartition
    `);
    assert.ok(partitions.length > 0, 'partition children exist but must not count as roots');
    assert.ok(!inventory.some(table => partitions.some(partition => partition.relname === table.name)));
    t.diagnostic(`${result.files.length} migrations attempted; ${result.failures.length} exact known failures retained; 109 roots / 967 columns match. Coverage inventory only, NOT a clean build or implemented full-site transfer.`);
  } finally {
    await result.db.close();
  }
});

test('the replay failure gate remains exact for missing, extra and changed failures without another database replay', () => {
  const expected = EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message }));
  const report = () => ({ files: EXPECTED_REPLAY_FAILURES.map(item => item.file), failures: structuredClone(expected) });
  const missing = report();
  missing.failures.pop();
  assert.throws(() => assertExpectedReplayFailures(missing), /Replay baseline mismatch/);
  const extra = report();
  extra.files.push('20990101000000_unreviewed.sql');
  extra.failures.push({ file: '20990101000000_unreviewed.sql', message: 'unreviewed failure' });
  assert.throws(() => assertExpectedReplayFailures(extra), /Replay baseline mismatch/);
  const changed = report();
  changed.failures[0].message += '\nunreviewed error detail';
  assert.throws(() => assertExpectedReplayFailures(changed), /Replay baseline mismatch/);
});
