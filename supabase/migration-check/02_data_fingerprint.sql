-- =====================================================================
-- 数据库迁移检测（二）：数据指纹对比（只读，不会修改任何数据）
--
-- 作用：逐表计算「行数 + 内容指纹」，确认新库的数据和旧库完全一样。
-- 用法（两步）：
--   1. 在旧库（建议先让网站停用、等处理中订单结算完）运行本脚本，
--      复制结果第一行「说明」那一格（以 v1; 开头的一长串）。
--   2. 在新库打开本脚本，把复制的内容粘贴到下方两个 old 标记之间，
--      再运行；结果会逐表显示「一致 / 不同 / 缺少」。
--   * 「运行记录」类表格（登录会话、队列、日志等）迁移后会继续变化，
--     出现不同属正常；请重点看「核心业务」表格。
--   * 整体转移项目（项目 ID 不变）时不需要这个脚本，数据库本来就是同一个。
-- =====================================================================
set search_path = pg_catalog, pg_temp;
set time zone 'UTC';
set datestyle = 'ISO, YMD';
set intervalstyle = 'postgres';
set extra_float_digits = 1;
set bytea_output = 'hex';
set transaction read only;

with
old_raw as (
  select $old$

$old$::text as t
),
old_rows as (
  select split_part(p, '=', 1) as tbl,
         split_part(split_part(p, '=', 2), ':', 1)::bigint as n,
         split_part(split_part(p, '=', 2), ':', 2) as h
  from old_raw, regexp_split_to_table(regexp_replace(old_raw.t, '\s+', '', 'g'), ';') p
  where p like '%=%:%'
),
is_fp as (
  select not exists (select 1 from old_rows) as g
),
ops(tbl) as (
  values ('private.content_audit_delete_jobs'), ('private.deleted_employee_delete_jobs'),
         ('private.employee_login_maintenance_confirmations'), ('private.notification_delivery_operations'),
         ('public.account_lock_events'), ('public.admin_financial_sessions'), ('public.employee_financial_sessions'),
         ('public.login_attempts'), ('public.financial_login_attempts'), ('public.bulk_import_log'),
         ('public.commission_audit_log'), ('public.data_retention_policies'), ('public.dispatch_assignments'),
         ('public.dispatch_performance_metrics'), ('public.dispatch_pool_selections'), ('public.dispatch_rate_limits'),
         ('public.dispatch_sessions'), ('public.dispatch_system_logs'), ('public.employee_login_history_events'),
         ('public.employee_presence_events'), ('public.history_cleanup_config'), ('public.history_cleanup_log'),
         ('public.money_data_protection_audit'), ('public.notification_automation_failures'),
         ('public.notification_automation_progress'), ('public.notification_automation_queue'),
         ('public.valid_data_audit_log'), ('public.valid_data_error_log'), ('public.valid_data_query_performance'),
         ('public.wallet_balance_baselines'), ('public.wallet_reconciliation_audit'), ('public.wallet_reconciliation_queue'),
         ('public.withdrawal_events'), ('public.work_sessions')
),
targets as (
  select format('%I.%I', n.nspname, c.relname) as tbl,
         format('select md5(t::text) as h from %I.%I t', n.nspname, c.relname) as q
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind = 'r'
  union all
  select 'storage.buckets', $q$select md5(row(id, name, public, file_size_limit, allowed_mime_types)::text) as h from storage.buckets$q$
  where to_regclass('storage.buckets') is not null
  union all
  select 'storage.objects', $q$select md5(row(bucket_id, name, metadata ->> 'size', metadata ->> 'mimetype')::text) as h from storage.objects$q$
  where to_regclass('storage.objects') is not null
  union all
  select 'cron.job', $q$select md5(row(jobname, schedule, command, active)::text) as h from cron.job$q$
  where to_regclass('cron.job') is not null
),
cur_rows as (
  select t.tbl,
         (xpath('/row/n/text()', x))[1]::text::bigint as n,
         left(coalesce((xpath('/row/h/text()', x))[1]::text, '-'), 12) as h
  from targets t
  cross join lateral query_to_xml(
         format('select count(*) as n, md5(string_agg(h, %L order by h)) as h from (%s) s', '', t.q), false, true, '') x
),
merged as (
  select coalesce(c.tbl, o.tbl) as tbl, o.n as old_n, o.h as old_h, c.n as cur_n, c.h as cur_h,
         case when coalesce(c.tbl, o.tbl) in (select tbl from ops) then '运行记录' else '核心业务' end as kind
  from cur_rows c
  full join old_rows o on o.tbl = c.tbl
),
rows_out as (
  select case when old_h is null then '新库多出'
              when cur_h is null then '新库缺少'
              when old_n = cur_n and old_h = cur_h then '一致'
              when old_n <> cur_n then '行数不同'
              else '内容不同' end as result,
         kind, tbl, coalesce(old_n::text, '—') as old_n, coalesce(cur_n::text, '—') as cur_n,
         case when old_h is null then '旧库没有这张表'
              when cur_h is null then '新库没有这张表，或表名不同'
              when old_n = cur_n and old_h = cur_h then ''
              when kind = '运行记录' then '运行记录会随网站运行继续变化，属正常'
              else '核心业务数据不同：请确认复制时网站是否已停用，或是否被历史清理删除了旧记录' end as note
  from merged
),
summary as (
  select '总结' as result, '全部' as kind, '数据对比结果' as tbl,
         '' as old_n, '' as cur_n,
         case when count(*) filter (where kind = '核心业务' and result <> '一致') = 0
              then '核心业务数据全部一致'
              else '核心业务表有 ' || count(*) filter (where kind = '核心业务' and result <> '一致') || ' 张不一致，请查看下方' end
           || '（核心业务 ' || count(*) filter (where kind = '核心业务') || ' 张，运行记录 '
           || count(*) filter (where kind = '运行记录') || ' 张，其中 '
           || count(*) filter (where kind = '运行记录' and result <> '一致') || ' 张有变化）' as note
  from rows_out
),
fingerprint as (
  select 'v1;' || string_agg(tbl || '=' || n || ':' || h, ';' order by tbl) as fp from cur_rows
)
select result as "结果", kind as "分类", tbl as "表", old_n as "旧库行数", cur_n as "新库行数", note as "说明"
from (
  select 0 as grp, '本库指纹' as result, '复制「说明」这一格' as kind, '全部 ' || (select count(*) from cur_rows) || ' 张表' as tbl,
         '' as old_n, '' as cur_n, (select fp from fingerprint) as note
  union all
  select 1, '本库数据', case when tbl in (select tbl from ops) then '运行记录' else '核心业务' end, tbl, '', n::text, ''
  from cur_rows where (select g from is_fp)
  union all
  select 1, result, kind, tbl, old_n, cur_n, note from summary where not (select g from is_fp)
  union all
  select case when result = '一致' then 4 when kind = '运行记录' then 3 else 2 end, result, kind, tbl, old_n, cur_n, note
  from rows_out where not (select g from is_fp)
) z
order by grp, kind, tbl;
