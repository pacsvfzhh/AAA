# 数据库、服务端与运维

正式环境：Supabase 项目 `hxpbpqoqkoiiplvdwmld`。本文中「正式环境」的内容于 2026-10-09 只读核对。

## 核心表（public）
| 领域 | 表 |
|---|---|
| 账号与会话 | `users`（员工；`region_id` 指向 `employee_regions`）、`employee_regions`（员工所在地区选项，所有管理员共用）、`admins`（`role`、`parent_id`）、`admin_financial_sessions`、`employee_financial_sessions`、`financial_admin_credentials`、`financial_employee_credentials`、`financial_login_attempts`、`login_attempts`、`account_locks`、`account_lock_events`、`employee_login_history`、`employee_login_history_events`、`employee_presence_events`、`work_sessions` |
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
  - 2026-10：历史清理排程 `20261001043534_unify_history_cleanup_schedule.sql`；内容稽核与已删员工 `20261002000000` 至 `20261030000000`（见 `docs/content-audit.md`）；通知自动化扩容与通知状态权限 `20261101000000`、`20261101000001`（正式库版本 `20261009104010`、`20261009104257`，见 `docs/notifications.md`）；聊天扩容 `20261101000002_scale_service_chat_queries.sql`（正式库版本 `20261009173803`，见 `docs/service-chat.md`）；主动停工后刷新不再恢复 `20261101000003_keep_user_stopped_work_sessions_stopped.sql`（正式库版本 `20261013183142`，见 `docs/employee-portal.md`）；员工所在地区 `20261102000000_add_employee_regions.sql`（正式库版本 `20261024001146`，见 `docs/admin-backend.md`「員工詳情數據」）。
- 员工地区迁移：新表 `employee_regions`（RLS 开启、无策略，`anon`/`authenticated` 无表权限，只经 RPC 读写；名称去首尾空白、1～30 字、不分大小写唯一）；`users.region_id`（可空，地区被删时置空），并给 `anon`/`authenticated` 补 `region_id` 列级读取权限（与 `users` 其他后台栏位一致，Realtime 才会带出地区变化）；新 RPC `admin_create_employee_region`；改写 `get_employee_management_snapshot`（返回 `regions` 与每位员工的 `region_id`）、`admin_create_employee_account_with_automation_plan`（末尾加 `p_region_id uuid DEFAULT NULL`，旧调用方式不受影响）、`admin_update_employee_account_unlocked`（允许 `region_id`）。回归测试 `npm run test:employee-regions`（PGlite 回放全部迁移，约 20 秒）。
- 本地有但正式库从未执行：`20260905015900_fix_workspace_summary_counts.sql`（正式库没有 `sync_conversation_source_type` 触发器）。正式的 `get_ccc_conversation_summaries` 来自 `20260901220357_enforce_ccc_group_isolation.sql`（超管工作区的摘要也包含其他非紧急组员工，前端再按本组员工过滤），`get_admin_groups_for_customer_service` 来自 `20260930081803_align_service_conversation_sources.sql`；消息与客户的 `source_type` 一致由该迁移的 `(customer_id, source_type)` 复合外键保证。改写这些函数时以正式库实际定义为准。

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
