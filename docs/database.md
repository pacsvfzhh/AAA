# 数据库、服务端与运维

正式环境：Supabase 项目 `hxpbpqoqkoiiplvdwmld`。本文中「正式环境」的内容于 2026-10-09 只读核对。

## 核心表（public）
| 领域 | 表 |
|---|---|
| 账号与会话 | `users`（员工）、`admins`（`role`、`parent_id`）、`admin_financial_sessions`、`employee_financial_sessions`、`financial_admin_credentials`、`financial_employee_credentials`、`financial_login_attempts`、`login_attempts`、`account_locks`、`account_lock_events`、`employee_login_history`、`employee_login_history_events`、`employee_presence_events`、`work_sessions` |
| 配置 | `system_configs`（全局 JSON 配置）、`admin_configs`（各管理员品牌等）、`group_configs`、`admin_groups`、`admin_group_members` |
| 钱包与财务 | `wallets`、`wallet_transactions`、`withdrawals`、`withdrawal_events`、`financial_operations`、`wallet_ledger_entries`、`wallet_balance_baselines`、`wallet_reconciliation_queue`、`wallet_reconciliation_audit`、`commission_audit_log`、`money_data_protection_audit` |
| 订单与派单 | `orders`（及 `orders_history*`）、`product_types`、`valid_order_data`（及 `_archive` 与统计/日志表）、`used_order_data`、`dispatch_groups`、`dispatch_group_members`、`dispatch_group_orders`、`dispatch_order_pools`、`dispatch_pool_selections`、`dispatch_orders`、`dispatch_assignments`、`dispatch_sessions`、`dispatch_config`、`dispatch_rate_limits`、`dispatch_performance_metrics`、`dispatch_system_logs`、`submit_time_groups`、`employee_submit_time_settings` |
| 通知 | `messages`（`audit_origin`、`automation_execution_id`）、`message_recipients`、`message_templates`、`notification_automation_*`（plans、plan_members、tasks、task_recipients、progress、queue、executions）、`broadcast_messages`、`broadcast_recipients` |
| 公告 | `announcements`、`announcement_categories` |
| 聊天 | `simulated_customers`、`customer_employee_conversations`、`customer_service_sessions`、`rich_card_contents`、`cs_message_templates`、`customer_auto_messages`、`customer_auto_message_logs`、`rating_requests`、`service_ratings`、`ccc_conversation_annotations` |
| 身份验证 | `verification_requests` |
| 历史清理 | `history_cleanup_config`、`history_cleanup_log`、`data_retention_policies`、`bulk_import_log` |

`private` schema：内容稽核与已删员工相关表（见 `docs/content-audit.md`）及 `notification_delivery_operations`；`anon` / `authenticated` 没有该 schema 的使用权限。

## RPC 与安全约定
- 浏览器以 `anon` 角色执行（不用 Supabase Auth），身份在 RPC 内验证：管理员 `private.get_financial_admin_context(token)`，员工 `private.get_financial_employee_id(user_id, token, tab_id)`。
- 新 RPC 写法：

```sql
CREATE FUNCTION public.example_admin_action(p_admin_session_token uuid, p_target_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Super administrator permission is required.';
  END IF;
  -- 业务逻辑
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.example_admin_action(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.example_admin_action(uuid, uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
```

- 只给 Edge Function 调用的 RPC 只授权 `service_role`。
- 财务：`users`、`admins`、`wallets`、`wallet_transactions`、`withdrawals` 已撤销直接写权限，只能走 RPC（`20260914221000_harden_financial_permissions.sql`）。
- 通知/聊天正文的修改与稽核删除由仅限 `service_role` 的 RPC 执行（经 Edge Function `content-audit`）。

## 正式环境安全现状（2026-10-09 核对，未修改）
- `anon` 不能写入：`users`、`admins`、`wallets`、`wallet_transactions`、`withdrawals`、`messages`、`system_configs`、`dispatch_assignments`。
- `message_recipients`：`anon` 只能读取与新增，不能直接更新；已读与投递状态只能经 `mark_employee_notification_read`、`complete_notification_delivery` 等验证会话的 RPC 更新。2026-10-09 迁移 `20261101000001_lock_notification_recipient_status.sql`（正式库版本 `20261009104257`）撤销了原先可改任何人已读状态的列级更新权限、条件为 `true` 的「Allow updating message recipients」策略，以及旧 RPC `mark_message_as_read`、`mark_login_popup_as_shown` 的浏览器权限（前端 9 月 20 日起已不用）。
- `customer_employee_conversations`：`anon` 可 INSERT，只能更新 `is_read`、`read_at`；`simulated_customers`：`anon` 可 INSERT，并可更新 `customer_name`、`customer_avatar`、`is_active`、`customer_id`、`is_super`、`remarks`、`target_employee_id(s)`、`auto_messages_enabled` 等展示与指派栏位（策略条件为 `true`）。两表都不能直接 DELETE（删除走 `content-audit`）。
- **`anon` 可读取全部**（SELECT 策略条件为 `true`，2026-10-10 核实）：`customer_employee_conversations`（全部聊天内容）、`simulated_customers`、`messages`（通知内容）、`message_recipients`、`wallets`（余额，只限未归档员工）；`users` 中除 `password_hash`、`archived_at` 外的栏位（只限未归档员工）。客服聊天 RPC `get_employee_conversation_summaries(p_employee_id)` 也不验证员工会话。因此持有公开 anon key 的人不登录也能读这些资料、以任何员工或客户名义插入聊天消息。收紧需要把读写改为验证会话的 RPC 并同步修改员工端与后台——尚待用户决定。
- **仍对 `anon` 开放增删改**（RLS 策略条件为 `true`）：`orders`、`announcements`、`product_types`、`verification_requests`、`admin_configs`。因为不用 Supabase Auth，理论上任何拿到公开 anon key 的人都能改这些表。要收紧，需要把相关写入改成验证会话的 RPC 并同步修改前端——尚待用户决定。
- 全库范围（2026-10-10 核实）：public 86 张表中 `anon` 可读 48 张、可写 26 张，其中 15 张可删除（`admin_configs`、`admin_group_members`、`admin_groups`、`announcements`、`customer_auto_message_logs`、`customer_service_sessions`、`dispatch_config`、`dispatch_orders`、`group_configs`、`message_templates`、`product_types`、`rating_requests`、`service_ratings`、`valid_order_data`、`verification_requests`）。
- **可凭 anon key 伪造佣金（2026-10-10 只读核实，未实际测试）**：`orders` 的 INSERT/UPDATE 策略为 `true`，`anon` 可写全部栏位（含 `status`、`product_value`、`commission_amount`）。订单校验（`valid_order_data` / `used_order_data`）只在前端 `OrderSubmission.tsx` 做；数据库只要求员工属于启用中的派单组（`snapshot_order_dispatch_rates`，佣金率取该组）。之后 `process_pending_orders()`（每分钟）按成功率把 `processing` 订单结算并入账；另外 `auto_create_commission_and_update_wallet()`（SECURITY DEFINER）在订单变成 `success` 时按 `commission_amount` 直接给钱包入账，所以直接 UPDATE 某订单的 `status`/`commission_amount` 也会加钱。`admin_configs`（成功率等设置）同样可被 anon 改。核对时未见滥用迹象：5 月以来 61 笔成功订单金额与费率一致；3–4 月约 1.8 万笔成功订单与费率只差四舍五入。订单写入只在 `OrderSubmission.tsx`（员工端）与 `ValidOrderDataManagement.tsx`（后台）。修复方向：订单提交改为验证员工会话并在数据库内校验订单资料的 RPC，撤销 `anon` 对 `orders` 的写入——尚待用户决定。撤销前必须一并处理（否则会直接坏掉）：`used_order_data` 的 AFTER INSERT 触发器 `trigger_update_valid_data_usage` → `update_valid_data_usage_stats()` 以调用者权限 UPDATE `valid_order_data`（员工提交订单时触发）；后台「有效订单资料」批量删除调用的 `batch_delete_valid_order_data(integer)` 也是调用者权限。`valid_order_data`（订单校验用的「答案」）与 `used_order_data` 也可被 anon 读取，应一并收回。另有 28 个 anon 可执行、前端没用的旧函数涉及订单或订单资料（`archive_old_orders`、`stress_test_order_submissions` 会写订单；`find_available_valid_data`、`get_optimal_valid_data` 会返回有效订单资料；其余多为早期压测与维护函数，可用 `prosrc ~* 'valid_order_data|used_order_data'` 查出），应撤销执行权限；前端唯一使用的是 `batch_delete_valid_order_data`（后台「删除全部」），需先换成验证管理员会话的版本。订单的读取与 Realtime（`OrderList.tsx`、`EmployeeManagement.tsx`）只需 SELECT，结算 `process_pending_orders()` 由 pg_cron 以 postgres 执行，入账触发器为 SECURITY DEFINER，都不受撤销写入影响。
- `verification-documents` 存储桶为公开桶（身份证件可凭 URL 访问）。
- Supabase advisor 提示 `private.*` 表未启用 RLS：已核实 `anon` / `authenticated` 对 private schema 没有使用权限，实际无法访问。另有大量 public `SECURITY DEFINER` 函数可被 anon 执行的提示，属于整库的既有状况。

## 迁移
- 本地：`supabase/migrations/<时间戳>_<名称>.sql`，按文件名排序。部分文件名时间戳超前于实际日期，只用于排序；新文件的时间戳必须大于目前最新的文件。
- 部署到正式库：用 Supabase MCP `apply_migration`（`name` 用与本地文件名后半段相同的 snake_case）。正式库按实际执行时间记录版本，例如本地 `20261030000000_reclaim_audit_deletion_confirmations.sql` 在正式库的版本是 `20261008181146`。部署前必须取得用户确认。
- 主要阶段：
  - 2025-10 初始：`20251029151618_create_quantum_trader_schema.sql`（admins、users、orders、wallets、wallet_transactions、withdrawals、admin_configs）、`20251029172427_add_verification_requests.sql`。
  - 2025-11：通知 `20251101000000_create_messages_system.sql`；派单 `20251101185326_create_order_dispatch_system.sql`、`20251102171543_create_dispatch_groups_system.sql`；工时 `20251101202559_create_work_sessions_tracking.sql`；聊天 `20251103221511_recreate_customer_simulation_system.sql`；历史资料 `20251113191637_create_history_data_management_system.sql`；函数 search_path 修复 `20251129073341_fix_all_function_search_paths.sql`。
  - 2026-05：订单处理改为 RPC `20260502173156_create_process_pending_orders_rpc.sql`、`20260502183725_add_process_pending_orders_cron_job.sql`。
  - 2026-09：财务系统 `20260914220000_add_atomic_wallet_financial_system.sql` 与权限收紧 `20260914221000_harden_financial_permissions.sql`；全局员工搜索 `20260918021342_add_global_employee_search_rpc.sql`；派单生命周期 `20260918215530_server_authoritative_dispatch_lifecycle.sql`；通知自动化 `20260918231458`、`20260922001942`、`20260922185616`。
  - 2026-10：历史清理排程 `20261001043534_unify_history_cleanup_schedule.sql`；内容稽核与已删员工 `20261002000000` 至 `20261030000000`（见 `docs/content-audit.md`）；通知自动化扩容与通知状态权限 `20261101000000`、`20261101000001`（正式库版本 `20261009104010`、`20261009104257`，见 `docs/notifications.md`）；聊天扩容 `20261101000002_scale_service_chat_queries.sql`（正式库版本 `20261009173803`，见 `docs/service-chat.md`）；主动停工后刷新不再恢复 `20261101000003_keep_user_stopped_work_sessions_stopped.sql`（正式库版本 `20261013183142`，见 `docs/employee-portal.md`）。
- 本地有但正式库从未执行：`20260905015900_fix_workspace_summary_counts.sql`（正式库没有 `sync_conversation_source_type` 触发器）。正式的 `get_ccc_conversation_summaries` 来自 `20260901220357_enforce_ccc_group_isolation.sql`（超管工作区的摘要也包含其他非紧急组员工，前端再按本组员工过滤），`get_admin_groups_for_customer_service` 来自 `20260930081803_align_service_conversation_sources.sql`；消息与客户的 `source_type` 一致由该迁移的 `(customer_id, source_type)` 复合外键保证。改写这些函数时以正式库实际定义为准。

## 资料迁移实施前只读复核（2026-10-17）

- 用户重新授权后连接恢复；正式仍无 `employee_transfer/export/import` 接口及六张迁移私有表。没有部署迁移、Edge Function 或修改 Storage/cron/业务资料。
- 正式为 96 张 public/private 根表、871 列，另有 `orders_history_2025`、`orders_history_2026` 两个分区。本地 103 张根表包含六张未部署的迁移表和正式不存在的 `notification_automation_date_runs`，不能直接当成正式基线。
- 共同的 96 张表列名/类型一致，八处可空性不同：正式 `users.created_by`、`private.content_audit_events.actor_admin_id` 可空；`bulk_import_log` 的 `table_name/import_type/total_records` 和 `group_configs` 的 `group_id/config_type/config_value` 正式必填，与本地覆盖库存相反。已将差异固化为独立 `production-2026-10-17` 校验配置并与正式整体 SHA-256 比对；本地回放配置仍严格独立，不改正式结构来迁就测试。
- 正式执行表有 `(task_id, task_version, user_id, period_key, stage)` 唯一约束；现有函数未引用本地多出的 `notification_automation_date_runs`。迁移必须按实际自动化定义验证续接，不能擅自补表。
- 根表上 100 个非内部触发器均 `O`，表属主 postgres；仅取定义指纹，未试关触发器。真实 PostgreSQL 锁、事务恢复及 PostgREST 缓存行为尚未验收。
- 当前 MCP postgres 查询超时为 2 分钟，但浏览器用的 anon 角色为 **3 秒**；authenticated/authenticator 为 8 秒，authenticator 锁超时 8 秒。前端请求等待设成 120 秒不会提高这个数据库上限；批次和资金原子提交须按真实路径测试，不直接全局放宽。
- 七个桶和策略已核对；私有 `content-audit-evidence` 没有浏览器读写策略。现有留证服务不是迁移上传通道，需另做任务绑定的受控服务端接口；未上传、下载或测试 CORS，也未放宽桶权限。
- 九个 cron 仍启用，`content-audit` 仍为 v14、`verify_jwt=false`。本轮未重验本文件全部历史安全结论；完整检查范围与未通过门槛见 `docs/employee-data-transfer-plan.md` 第 16 节。

## pg_cron 定时任务（时间为 UTC；2026-10-09 最近一次运行均成功）
| 正式任务名 | 频率 | 调用 | 用途 | 定义迁移 |
|---|---|---|---|---|
| `auto_cleanup_due_history_data_every_minute` | 每分钟 | `auto_cleanup_due_history_data()` | 历史资料到期清理 | `20261001043534` |
| `collect-audit-deletion-confirmations` | 每分钟 | `private.collect_audit_deletion_confirmations()` | 回收失效的删除确认 | `20261030000000` |
| `enqueue-daily-wallet-reconciliation` | 每天 03:17 | `enqueue_all_wallets_for_reconciliation()` | 钱包对账入队 | `20260914220000` |
| `process-wallet-reconciliation-queue` | 每分钟 | `process_wallet_reconciliation_queue(100)` | 执行钱包对账 | `20260914220000` |
| `process_notification_automation_queue_every_five_seconds` | 每 5 秒 | `CALL private.run_notification_automation_queue(200, false)` | 自动通知快队列 | `20261101000000` |
| `process_notification_automation_queue_every_minute` | 每分钟 | `CALL private.run_notification_automation_queue(200, true)` | 自动通知（另安排年度日期任务） | `20261101000000` |
| `process_pending_orders_every_minute` | 每分钟 | `process_pending_orders()` | 处理 processing 满 3 分钟的订单 | `20260502173156` |
| `reconcile_dispatch_lifecycle_every_minute` | 每分钟 | `auto_cleanup_dispatch_system()` | 派单生命周期协调与清理 | `20260918215530` |
| `weekly_cleanup_practice_data` | 每周日 02:00 | `cleanup_all_practice_data()` | 清理练习数据（函数存在于正式库，仓库没有定义，含义待确认） | `20260502201643` |

## Storage 存储桶（正式环境）
| 存储桶 | 公开 | 用途 |
|---|---|---|
| `announcement-images` | 是（上限 100MB） | 公告图片、视频、封面 |
| `chat-images` | 是 | 聊天图片、Word 导入图片 |
| `template-images` | 是 | 范本与正文中压缩后的图片 |
| `super-customer-avatars` | 是（上限 5MB） | 聊天角色自定义头像 |
| `website-icons` | 是（上限 5MB） | 网站图标 |
| `verification-documents` | 是 | 员工身份证件 |
| `content-audit-evidence` | 否 | 稽核证据（只经 Edge Function 读取） |

## Realtime publication（正式环境）
`account_lock_events`、`account_locks`、`admin_configs`、`admins`、`announcements`、`customer_employee_conversations`、`dispatch_group_members`、`dispatch_group_orders`、`dispatch_groups`、`dispatch_order_pools`、`dispatch_sessions`、`employee_login_history_events`、`employee_presence_events`、`message_recipients`、`orders`、`product_types`、`rating_requests`、`system_configs`、`users`、`verification_requests`、`wallet_transactions`、`wallets`、`withdrawal_events`、`work_sessions`。

不在清单中的表（如 `messages`、`simulated_customers`、`dispatch_assignments`）订阅后收不到事件。

## Edge Functions（正式环境）
| 名称 | 版本 | 源码 | 说明 |
|---|---|---|---|
| `content-audit` | v14 | `supabase/functions/content-audit/index.ts` | 稽核留证、永久删除、私有附件读取；`verify_jwt=false`，由 RPC 验证会话 |
| `process-orders` | v12 | 无 | 旧版订单处理，已改为 RPC，前端未调用 |
| `cleanup-dispatch` | v4 | 无 | 旧版派单清理，前端未调用 |

- 部署 `content-audit`：用 Supabase MCP `deploy_edge_function`，保持 `verify_jwt: false`；部署前必须取得用户确认。

## 迁移私有触发器恢复加固（本地，未部署）

- 新增 `20261102000004_harden_employee_transfer_triggers.sql`；保留四份旧草案，固定私有辅助函数中的表/触发器名单，事务回执绑定恢复参数，并精确恢复普通/ALWAYS 模式、保留原禁用/REPLICA 模式。
- 恢复前比较触发器及函数定义、属主/ACL 和属主安全属性；这不是全站定义预审批，表锁也不能阻止其他会话的函数 DDL，维护窗口仍须禁止并发结构修改。
- 迁移事件表新增延迟提交约束，旁路后没恢复不能提交，失败回滚整笔事务。没有修改现有业务表、业务触发器、浏览器权限或 cron，也没有新增公开 RPC。
- 本轮 PGlite 验证正常/异常/漏恢复/吞异常/提前约束/伪造回执等路径。真实 PostgreSQL 多连接锁和 PostgREST/超时仍待验证，正式迁移部署必须另行确认。

## 管理员/共享设置导出子阶段（2026-10-18，本地未部署）

- 新增 `20261102000005_export_shared_site_settings.sql`，不改业务表/触发器，不加新表，不改 Storage、cron 或现有账号。增加四个仅超管任务接口：`employee_export_shared_begin`、`get_employee_export_shared_catalog`、`get_employee_export_shared_page`、`employee_export_shared_verify`；私有 helper 全部撤销浏览器执行权限。
- 固定七个表键和字段，`admins` 中超管只带业务身份，不带密码，非超管两份密码校验资料保留；会话表不在范围。五个在用 `system_configs` 键按 JSON 形状验证，三个旧配置只列排除原因，未知键阻断。`admin_configs` 逐类型审核；保留期限不复制旧 cron/执行状态。
- 同一 STABLE/MVCC 捕获读取七表并冻结为原始 NDJSON；独立页/表 SHA-256、稳定游标、每页 200 行/256KiB、每行 64KiB、每表 10,000 行、总共享数据 8MiB。超限拒绝，不能静默截断。最终再次同快照捕获核对；跨表比较不是逐语句各读一次不同快照。
- 客户端 `sharedExport.ts` 只写隔离临时文件，实际写入后计进度；原子清理失败显式抛出 `SharedExportCleanupError`，工作区不能复用。浏览器磁盘适配仍待实现。
- 本子阶段永远不是完整站点备份（`full_site_complete=false`）；旧 `employee_export_finish` 拒绝此协议任务，验证不结束任务或更新完整导出时间。全站 finish、导入及其余业务仍未完成；可显式取消释放任务并清除快照。
- PGlite 真迁移/匿名角色 RPC 与 NDJSON 集成及流式边界共 150 项通过；无原生双连接、浏览器或真实 3 秒执行路径证明，未部署到正式环境。

## 管理员/共享配置受控导入（2026-10-18，本地未部署）

以下为原 create-only RPC 行为。同名来源覆盖与独立备份协议已另行实现，见下节；不能用旧接口绕过备份。派单员工分组/交单/自动化仍待实现，不把七表管理员分组替换当全站完成；细则见 `employee-data-transfer-plan.md` 第 2、5、6、20 节。

- 迁移 `20261102000006_import_shared_site_settings.sql` 新增 `employee_import_shared_begin` / `employee_import_shared_stage` / `get_employee_import_shared_dry_run` / `employee_import_shared_apply`；私有 helper 撤销浏览器执行权限。复用六张迁移私有表，不加业务表或改变业务触发器，不改正式权限/Storage/cron。
- 按来源包 UUID、站点和七表清单绑定暂存，重复块只认相同内容；逐字段/JSON/身份/父级/关联校验后给出无密码的干跑。确认服务器计划哈希并重新加锁核对后，整笔新建非超管（停用）及不存在的分组/配置；目标超管身份、凭据和会话不改，旧会话不迁移。
- 同名或同 ID 管理员、员工交叉用户名、不同配置、模糊候选、映射后配置碰撞、未改写媒体均阻断；覆盖和独立备份流程尚未接入。历史重复全局币种配置只有所有源 ID/内容都精确复用才可保留，不删源/目标资料或静默任选。保留期限只核对复用，不写入或开启任务。
- 精确审核并保留设置表四个媒体保护的触发器/函数定义哈希、属主、安全模式和启用状态；不旁路保护，未知/缺失/变更拒绝。计划/约束失败整笔回滚，约束错误脱敏；重复 apply 回原回执，不重复新增。
- 修正迁移工具自身 `private.employee_transfer_job` 协议门禁及旧 `employee_import_begin` 保留字段检查；共享令牌不能借旧员工写入/finish 接管其他阶段或伪造整体完成。没有新增启用账号或完整迁移 finish，成功仍明确 `full_site_complete=false`；取消不撤销已提交业务行。
- `sharedImport.ts` 两遍只读文件校验后分块暂存，收到校验一致回执再计进度；出错停止、不自动重试/假回滚，保留待核对暂存标识。真正的整卷认证、磁盘文件适配、过期续接和全站协调由后续实现。
- 本地双库 SQL33项与流式169项通过；未做原生 PostgreSQL 并发/3秒角色超时/浏览器/正式资料验收，未部署。部署前必须复核固定媒体保护定义，不能假设本地哈希等同正式定义。

## 共享资料来源覆盖与独立备份（2026-10-18，本地未部署）

- 新增 `20261102000007_replace_shared_site_settings.sql`；新增私有RLS表 `employee_transfer_shared_backups`（浏览器无直接权限），追加八个超管RPC：`employee_import_shared_replace_begin`、`get_employee_import_shared_replace_dry_run`、`get_employee_import_shared_backup`、`get_employee_import_shared_backup_page`、`employee_import_shared_backup_append`、`employee_import_shared_backup_seal`、`get_employee_shared_saved_backup_chunk`、`employee_import_shared_replace_apply`。复用七表/任务身份及原暂存，旧apply拒绝replacement任务。
- 同名非超管沿用目标ID覆盖源凭据/角色/层级/空值、保持停用并撤销会话；管理员分组按名称及映射创建者覆盖，成员精确替换；白名单管理员/系统设置按来源覆盖。所有目标超管身份与会话不改，不删除管理员/员工或全库清空，来源ID被异身份占用及不唯一映射拒绝。
- 干跑冻结目标七表及计划/目标SHA；独立密文按128KiB分块持久保存、最大9MiB，完整哈希封存后才能apply。锁内重算目标指纹，漂移拒绝；不持口令的服务端不能证明密文明文，认证/清单对照由客户端保存后回读完成。取消/废弃清未封存记录，已封存记录保留且仅原超管会话可逐块读取，不新增普通浏览器表权限或Storage桶。
- 保留媒体保护并审核实际及间接写触发器，失败原子回滚；已封存备份独立保留。目标活跃自动化、媒体设置及历史保留差异仍阻断，等待全站维护/媒体实现；当前没有启用账号、同站恢复、全站finish或UI，`full_site_complete=false`。
- 本地覆盖66项、密文备份75项、API153项通过；私有表与新RPC权限纳入基础门禁，本地库存增至104根表/927列，正式96表基线不变。未部署、未访问/改变正式资料或Storage/权限/cron；原生PostgreSQL锁/3秒执行、真实浏览器与全站验收仍待完成。

## 产品目录迁移（2026-10-18，本地未部署）

- `20261102000008_transfer_product_catalog.sql` 新增13个产品专用RPC：导出begin/page/verify，导入begin/stage/dry-run、备份descriptor/page/append/seal、已保存密文读取、apply及阶段close。精确六列白名单与模式检查；独立 `products-v1` 协议，旧员工/七表接口不能接受其任务令牌。无新增表，复用私有RLS备份表及暂存；不改现有产品/订单表、业务触发器、Storage或cron。
- 名称全表精确匹配，同名沿用目标ID并覆盖来源启停/排序/时间及NULL，无同名则新增，目标不同名保留；来源ID被其他名称占用或映射碰撞阻断。锁内重核来源清单及目标指纹，独立密文封存后才可原子apply，返回产品ID映射而非改动目标既有订单。非正历史排序通过受控insert后update保留，不关闭自动排序触发器；未知/篡改/禁用触发器拒绝。
- 产品阶段close须先验证导出或完成apply；回执恒为 `full_site_complete=false`，不会推进全站 `last_export_at`。已封存密文在close/取消后保留，仅原操作者超管可取回；取消不撤销已提交产品行。服务端封存只核对密文长度/标识/哈希，不持口令独立证明明文，客户端保存回读完成认证与清单对照。
- 两站本地SQL、真实打包API转anon RPC、分页/独立密文落盘回读和客户端边界验证已覆盖。仍未接派单/交单、全站产品引用改写、同站备份恢复、浏览器磁盘/页面或统一续传，不把产品阶段结束当全站迁移成功；原生PostgreSQL并发锁、正式3秒执行及实际浏览器仍需验收。

## 类型与测试
- `src/types/database.ts` 手工维护（没有生成脚本）：新增 RPC 时补充 `Functions` 的 `Args` / `Returns`；改表时同步 `Row` / `Insert` / `Update`。
- `supabase/tests/audit-cleanup.test.mjs`：用 PGlite 加载缩减版 schema，再执行指定的真实迁移；每个测试在事务中执行后回滚。运行 `npm run test:audit-cleanup`。
- `supabase/tests/service-chat-scale.test.mjs`：先装入正式库现行的会话摘要与分组 RPC（取自旧迁移），在混合数据（跨组旧会话、已归档员工、停用/紧急组、富卡、空时间消息、空聊天表）上记录结果，再执行 `20261101000002` 并逐行对比；另验证 `get_admin_chat_unread_counts` 的范围、无效/停用会话拒绝与执行权限。运行 `npm run test:service-chat`。
- `supabase/tests/work-session-stop.test.mjs`：装入现行的开工/停工/恢复 RPC，先复现「主动停工后刷新被自动恢复」，再执行 `20261101000003` 验证主动停工不再恢复、刷新（beacon 停工）仍会恢复、停工后重新开工再刷新仍会恢复，以及权限。运行 `npm run test:work-session`。
- `supabase/tests/employee-transfer-foundation.test.mjs`：严格核对当前 535 份 SQL 回放中的 12 项已知历史失败（文件和完整错误必须一致），验证迁移辅助的双库资源释放、同站保护、匿名 RPC 和私有表权限；新增/变化/缺失失败阻断。测试使用 platform/baseline 替身，**不是全部迁移成功或真实空库建库证明**。
- `supabase/tests/support/transfer-scope.mjs` 与 `employee-transfer-scope.test.mjs`：固化本地 104 张根表、927 列及业务迁移意图，拒绝未知/缺失表列、类型/空值性漂移；不是导出授权清单，也不表示转换已实现。根表覆盖不含独立分区，实际目标库仍须重新核对。
- `employee-transfer-production-scope.test.mjs` 单独核对正式 96 根表/871 列及独立目录 SHA-256，与本地 104 表配置不可混用；`employee-transfer-triggers.test.mjs` 验证真实迁移 SQL 的精确状态恢复、回执和提交门禁（使用 PGlite，不是原生多连接测试）。
- `npm run test:employee-transfer` 运行加密、ZIP 清单/容器、增量 SHA-256、基础回放、双结构库存、触发器、共享设置导出/导入、来源覆盖与备份/API、产品专用数据库/客户端测试；全站往返、管理员/配置/自动化/实际媒体及界面验收尚未完成。专项命令为 `test:employee-transfer:crypto`、`:foundation`、`:scope`。
- `supabase/config.toml` 只配置了 `process-orders`、`cleanup-dispatch`；`supabase/health_check.sql` 是为新部署准备的只读检查，期望的定时任务与存储桶清单已过时。
