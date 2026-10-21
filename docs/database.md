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

## 资料迁移验证版新增接口（本地未部署）
- SQL40 `20261102000040_close_shared_export.sql`：`employee_export_shared_close` 只结束已核验且关闭时源未变的共享导出，清技术暂存并释放单活任务；`get_employee_transfer_capabilities` 只检查固定RPC存在性，不代表媒体Edge已部署、数据预检或全站导入许可。
- SQL41 `20261102000041_snapshot_site_export.sql`：`get_employee_export_site_snapshot` 为STABLE超管只读接口，在单次MVCC快照取十领域目录与JSONB文本SHA-256，返回无原文/密码/令牌的元数据。嵌套设备秘密键先拒绝；已有迁入档案时保留SQL33拒绝，不吞错、漏源或补空。开始/结束比较用于发现漂移，不冻结业务或Storage，也不是原子全站备份。
- SQL42 `20261102000042_stop_owned_export.sql`：超管密码和「確認停止導出任務」二次确认，仅能按ID停止本人白名单协议的running导出，行锁后清其技术暂存并审计；不能停止导入、改钱包、删除业务/已保存文件或解除维护。过期/终态不重复清理，结果不明先重新查核。
- 三份只新增迁移，不修改旧迁移、现有业务表/函数/触发器；本地完整回放569份仍精确保留原12项历史失败，109根表/967列不变，非干净建库证明。迁移/Edge/Storage/cron和前端均未部署正式环境。

## 维护态整站恢复（SQL43–45，本地未部署）
- SQL43 `20261102000043_preserve_transfer_announcements.sql`：最小替换三个共享设置helper，导出及目标备份排除公告轮播两键；旧包携入时明确拒绝。公告、分类、发布与轮播目标原值不变，不改其他共享设置规则。
- SQL44 `20261102000044_preflight_site_restore.sql`：超管STABLE只读 `get_employee_import_site_preflight(uuid,uuid)`，核对来源站、全局任务、跨过期维护、未营业目标及110个固定RPC签名；不创建任务/清过期/发写许可，不代表Edge/Storage可用。
- SQL45 `20261102000045_verify_site_prerequisites.sql`：原共享/产品apply移至private保留实现，public同签名包装在首次真实apply同事务记录目标摘要，重复apply不刷新。共享摘要绑定完整目标capture；产品按服务器映射核对六列，不把后续占位产品算漂移。private base/helper全撤权。
- `employee_import_site_verify_prerequisites(uuid,uuid)` 要求原超管、同包同来源唯一apply及匹配维护，进入维护后配置写前、十领域恢复后各重验一次；漂移/缺记录/多义拒绝，不启用账号或解除维护。回执仅表示前置配置已验证，不是完整业务恢复。
- SQL45的preflight包装将协议升为 `site-maintenance-restore-v2`，增加第111项复核RPC存在检查。新客户端拒绝44-only的v1成功结果，防写到一半才发现缺接口；`can_release/full_site_complete`恒false。SQL44原迁移未改。
- 网络层全部 `get_employee_import_*` POST不自动重试，含固化备份/计划的dry-run；真正只读导出仍可重试。新写入RPC为120秒单次请求，失败需明确核对原任务。
- 严格回放572份SQL，仍精确保留原12项历史失败，109根表/967列不变；不是干净建库或原生PG并发验收。没有正式库/Storage/Edge/cron/前端部署，完整切站仍禁止。

## 覆盖前独立员工记录备份（SQL46，本地未部署）
- `20261102000046_backup_employee_before_restore.sql`新增`employee_safety_backup_begin`及catalog/page/verify/close/stop_owned六个RPC，不依赖共享或派单配置恢复，不建立维护、不写业务资料。旧SQL39仍保留原协议及不完整门禁，不能作为配置改动前的独立备份。
- begin须超管会话和当前密码，按完整用户名绑定本站未封存员工；已有running迁移（即使过期）或任何维护均阻断，不自动放弃原任务。处理中订单/未清封存证据阻断。任务、目录、员工、站点与全内容指纹绑定；每页≤200行/256KiB、每行64KiB、单表50万行/256MiB、合计1GiB，超限拒绝不截断。只读catalog/page/verify不续心跳，可在READ ONLY事务执行。
- 固定48类记录：原核心15表、聊天10表、通知/广播/自动化13表、派单6表、员工关联稽核事件/收件版本、精简orders_history及管理员六列无密码身份元数据。个人聊天/收件/进度严格按员工，相关共享角色/范本/任务祖先/组池配置作为依赖快照；同归属不限员工的空角色也纳入。通知留证可能employee_id=NULL，通过消息或before/after收件快照关联；共享通知原始收件证据不裁剪。历史订单只取id/user/status/commission/created_at/completed_at，不虚构不存在的rate/processed列，不搬真实交易详情。
- 目录只含数量/字节/摘要，凭据及证件地址等仅进加密原文。任一相关记录或共享依赖变更均使页/verify/close拒绝；历史session不可逆脱敏，设备秘密键阻断，未结束工时保持备份原文，未伪造在线状态。
- 追加私有任务校验器的独立协议隔离，保留SQL17–33动态追加的finance/activity/verification/notifications/chat/archives映射和双向保护；不关业务触发器，不增表。`stop_owned`需密码及「確認停止員工備份任務」，可不传ID以找回本人唯一running独立备份，过期亦可显式结束；不返回令牌、不停止别人的任务或其他协议、不自动开始新任务、不删文件或解除维护。
- 客户端实际磁盘保存/重新认证/48表行摘要检查/最后源核对/清理后，才允许显式close；独立本机reader完整认证再开放只读回调，退出即失效。**SQL46记录包及页面仍为records_only，media_included:false；独立附件模块见下节SQL47，完整同站恢复、备份封存和跨域UUID替换仍未完成，complete_employee_backup/can_archive/can_replace始终false。** 第43节已接后台独立记录备份与本人停止入口，成功不会解锁原SQL45空站准入或员工覆盖；第43节本身没有新增/修改数据库接口。报告保存可独立取消，未知任务仍阻挡其他迁移。
- 573份SQL回放精确保留12项历史失败，109根表/967列不变，非干净建库证明。未访问或部署正式库、Edge、Storage、cron或前端；详见计划第42节。

## 覆盖前独立员工附件备份（SQL47，2026-10-21，本地未部署）
- `20261102000047_backup_employee_media.sql`仅新增函数，无新表、不修改既有函数/触发器。`get_employee_safety_backup_media`、`employee_safety_backup_media_verify`为STABLE，只授予anon/authenticated并在内部重验超管/本人同一SQL46独立任务与记录指纹，不续心跳；`employee_safety_backup_media_authorize/commit`仅授予service_role。固定SECURITY DEFINER/search_path，私有helper全部撤权；commit只写原任务`summary.employee_safety_media`技术回执，不建维护或发业务写许可。
- 新`employee-safety` Edge作用域只接受SQL46 `employee-safety-records-v1`原任务令牌及`download/recheck-export`，不接受全站/其他协议令牌，无upload/import/read/delete能力。媒体身份绑定site/job/employee/recordFP/rawrowSHA/refSHA/bucketpathSHA；引用摘要含表/行ID/字段/原引用，跨行或字段共用路径保留独立引用，同一行同一字段重复URL才去重。档案原`media_refs`键只是历史身份，不作网络地址；只用已校验私有桶路径，服务仅向固定本站Storage读取。
- verification固定`verification-documents`三目录及员工UUID；chat固定`announcement-images/chat-images/template-images/super-customer-avatars`；notifications为前三桶；archives仅`content-audit-evidence`。按实际引用而非桶全量备份，不扩大公告迁移；未知/编码/外部媒体或未识别引用阻断不省略。头像≤5MiB、文件≤50MiB、最多3000引用条目、记录加媒体≤1GiB；允许类型及魔数边界见计划第44节。
- `employeeSafetyMedia`先完整认证现有SQL46记录.edx，重扫48类原始NDJSON及所有行/文件摘要，重建精确引用并匹配inventory才下载。独立附件.edx绑定精确记录密文SHA-256/大小/卷元数据及完整catalog，保存后全部认证/字节魔数核对/清理，再实际源文件recheck/verify；本机成对reader认证两卷并同样重扫引用，拒绝目录/manifest同时删项或伪造row/ref身份。该独立复审问题已修复并有合法重加密包回归，不是未解决阻断。
- SQL46记录v1与`media_included:false`不变；**无UI改动，EmployeeSafetyBackupPanel仍仅备份记录，尚未接附件。** 附件库不自动stop/close，调用方须在附件完成后显式旧session.close；Abort/丢响应不重试、删除、回滚或假关闭，清理失败阻断成功。所有完整备份/封存/替换/全站完成标志仍false，不解锁SQL37/39/45或解除维护。
- 本地七媒体文件2225/2225、SQL47下全站维护态导入28/28、聊天6/稽核48及typecheck/lint/build/Edge语法/差异检查通过。SQL专用现26项（原24合成回执+2真实SQL46/47、handler、memoryStorage、磁盘成对读取/显式close和最终源漂移拒绝）；SQL47/基础/范围三文件最终完整117/117通过，已含上述26项，不重复累加。严格回放574份仍同12历史失败、109根表/967列不变，非干净建库。
- 未访问正式环境，无SQL迁移、Storage/权限/config/cron调整或Edge/前端部署；本轮无UI/浏览器功能测试。真实Storage/CORS、原生picker、原生PG并发/PostgREST性能、完整迁移及UUID恢复未验证，后续页面串联/全部引用恢复/安全封存窗口仍缺；详见计划第44节。

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

## 只读来源档案迁移（2026-10-20，本地未部署）

- 新增SQL33/34及私有RLS表 `employee_transfer_archive_records`（8列），PK为source_site_id/package_id/table_key/source_id。按来源命名空间持久保存四张旧档案表的审核投影和员工摘要/提款只读投影，不把来源UUID映射为目标活身份，不写现有content_audit/deleted_employee表或恢复已删账号。
- 六表原文导出begin/page/verify/close、同原任务bind/stage/plan、显式begin/chunk/verify/status与 `get_employee_transferred_archive_page` 共12个浏览器RPC，固定SECURITY DEFINER/search_path，均内部验证超管，导出另验密码，导入同时验证原任务及dirty维护。同表/包已有异内容拒绝，事务许可只限新表，不关触发器或改钱；新表ALWAYS维护守卫纳入固定库存，不按技术表豁免。
- plan/status/持久只读page为STABLE，部分暂存可查未恢复状态，完整恢复后独立核对原文/JSON/数量/摘要才读，取消/过期不删除核验档案。四表全部物理列及JSON空值标记固定；actor_admin_id只接受已审核的本地NOT NULL／正式可空两基线，不改真实表或历史回放基线。
- SQL35增加私有证据inventory/bind/status/verify与仅service_role的authorize/commit/read_authorize；sidecar只存原任务summary.archives_media，不新增表或改原文/media_refs。固定私有桶，目标服务端路径，来源站/包/事件/ref/原行摘要与文件字节摘要绑定，真实回读后核验；取消/过期后已核验附件可按超管来源绑定只读。原记录回执media_pending仍true，不启用账号/解除维护或宣称整站成功。
- SQL36新增STABLE来源命名空间索引，记录及媒体sidecar独立复核，接入只读「遷入檔案」页。已有迁入档案时原六表导出仍明确拒绝；SQL38专用多来源再次导出见下文。
- SQL37提供STABLE同任务员工替换计划/状态，不写数据或续heartbeat；绑定完整来源目录和原始暂存，列同名资金风险、同UUID/员工号/管理员名冲突、内容指纹与既有封存/账号释放。共享设置备份不当员工完整备份，维护不旁路，can_archive/can_replace恒false，完整员工备份/统一身份映射及串联仍待做。
- SQL38新增全量迁入命名空间inventory与单来源catalog/page/media/verify共五个STABLE超管只读RPC，快照绑定最新已核验任务、原catalog、记录摘要及完整sidecar；任何未核验来源阻断，空目录保留，旧任务过期/取消不影响已核验历史读取。没有新表或写许可，原生六表导出阻断不变；尚未提供多来源再次导入。
- SQL39新增原任务超管同名目标核心备份目录/page/verify三个STABLE RPC，不接任意target ID。固定15表原文与完整指纹、设备JSON明确秘密键拒绝；聊天/通知/媒体等缺项显式列出，完整备份/封存/替换权限均false。无新表、业务写入、心跳或维护许可，不修改旧activity协议。
- 本轮566份SQL严格保留原12项历史失败，109根表/967列（private24/public85）不变，非干净建库；详见计划第38节验证清单。未访问正式服务、未部署SQL/Edge/前端、无Storage策略/权限/cron变更；真实Storage/原生PG时限并发/整站验收未做。

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
- 仓库另有本地未部署源码`supabase/functions/employee-transfer-media/{index,handler}.ts`，因此不再是唯一Edge源码；上表仍只列正式环境。新服务用于实名证件、通知三桶、聊天四桶及私有档案媒体迁移，另有仅SQL46独立任务的employee-safety下载/源复核作用域（SQL47，见计划第44节）；内部由SQL验证session/job；尚未配置或部署，未来必须单独说明并确认以`verify_jwt=false`部署，不在本轮修改config或放宽桶权限。两份源码中只有`content-audit`已在正式；正式另两个旧服务仍无仓库源码。

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

## 派单/交单导出与未营业预检（2026-10-18，本地未部署）

- `20261102000009_export_dispatch_submission_data.sql` 新增五个超管RPC：`employee_export_dispatch_begin`、`get_employee_export_dispatch_page`、`employee_export_dispatch_verify`、`employee_export_dispatch_close`、`get_employee_import_dispatch_preflight`。业务表只读，不增加表、关闭触发器或改Storage/cron；只写迁移任务及审计记录。独立 `dispatch-submission-v1` 任务不得借旧员工/产品/共享接口或finish冒充完整备份；旧导出初始化拒绝保留协议字段。
- 固定七表和全部审核列：`dispatch_config`、`dispatch_groups`、`dispatch_order_pools`、`dispatch_group_orders`、`dispatch_group_members`、`valid_order_data`、`used_order_data`，未知列、类型/可空性变化拒绝。保留来源默认组、Base标记及全部池/费率/提款/等待设置、成员、原文和有效/已用状态；不导派单领取/选择/会话、详细历史订单或公告。旧版`dispatch_orders`有记录则阻断要求核对，不静默丢弃；已用数据引用processing或错属员工订单也阻断。其他processing只计数报告，正式切站仍需归零。
- 单次STABLE快照计算各表数量/原始NDJSON字节数及按UUID排序的逐行SHA-256十六进制串的SHA-256（每行含LF），避免把全部原文拼成巨型字符串。按主键游标每页≤200行/256KiB、单行含LF≤64KiB，每表≤500000行/256MiB、总量≤1GiB；超限拒绝、不截断。客户端逐页校验原始字节、递增ID/游标/固定字段，核对行哈希串与目录，并生成标准文件SHA-256；最后源前后核对一致才返回子阶段成功。高精度金额原文不重新序列化；真实anon 3秒下全表指纹性能尚未验收。
- 目标预检检查订单/历史订单、派单/使用/工时记录、资金/收入/基准/流水/账本/提款与对账审计等16类计数，有任何业务痕迹阻断空站模式；普通未用配置可通过。该预检不锁定目标、不证明维护隔离或允许替换，恒为`replacement_ready=false`；后续导入须绑定备份、维护和目标变化核验。显式cancel释放服务端任务；本地AbortSignal只取消传输并清临时区，不自动做服务端写操作。
- 本地新增客户端57项、真实双站SQL/API39项，共96项通过；含12001条交单资料分页、源默认池非默认值/原文/使用状态及高精度数值、源变化、权限/协议隔离、字节界限与取消，完整迁移1358项通过。严格尝试536份SQL仍有原12项已知历史失败，非干净建库证明。未部署/访问正式库，无UI；整批导入、默认池替换、员工/订单映射、浏览器/真实PostgreSQL/Storage及全站验收仍待做。

## 派单/交单导入准备与目标备份（2026-10-18，本地未部署）

- `20261102000010_prepare_dispatch_submission_import.sql` 新增八个超管RPC：`employee_import_dispatch_begin/stage`、`get_employee_import_dispatch_dry_run/backup/backup_page`、`employee_import_dispatch_backup_append/seal`、`get_employee_dispatch_saved_backup_chunk`。沿用私有任务、暂存和密文备份表，没有业务表写入、业务触发器/权限/cron变动；新导入协议与旧员工/共享/产品接口隔离，不能借旧finish标成功。
- 来源七表按包ID、目录、逐行原始字节摘要绑定；不可变有序分块（200行/256KiB，行含LF64KiB），明确空表块，重复仅允许同身份同内容。服务端固定全部列与精度/类型/约束核对，再验证默认组、每组唯一Base、概率、池与组/原文/成员/有效已用关系和业务唯一键；管理员、员工、精简订单仅清点依赖，尚未对应或验证外部来源身份，不能据此认为引用可写入。
- 干跑在事务表锁中重新核验空站、七表内容、身份和保留配置并冻结目标备份；计划绑定来源包/目录与目标指纹，封存时再次加锁核对。锁只覆盖单次RPC，不是跨请求维护屏障，不暂停历史清理或业务；干跑始终 `preparation_ready=true`、`replacement_ready=false`、`can_apply=false`、`full_site_complete=false`，无apply/成功close接口。显式取消清暂存与未封存密文，已封存独立保留且仅原操作者超管可取回。
- 来源暂存沿用每表50万行/256MiB、总1GiB；空站目标安全备份暂限明文8MiB/密文9MiB，超限阻断不截断，待多卷支持。客户端必须真正保存独立加密文件、回读整卷认证与逐行摘要/清单/文件哈希、再重读密文按128KiB上传核回执后封存；服务器只核密文及目标绑定，不持口令独立证明明文。备份可解密不代表已支持同站自动恢复。
- 新增客户端205项、双站SQL/真实打包API及密文落盘75项，共280项通过，含12001条交单资料及目标变化/权限/取消；独立复审未发现本范围可复现缺陷。未访问正式库、部署SQL/Edge Function或前端，未改Storage/权限/cron；无UI，未做浏览器/原生PostgreSQL并发与anon3秒验收。默认池实际替换、维护隔离、员工/订单映射、使用计数恢复和全站协调仍待实现。

## 持续维护屏障与派单配置实际恢复（2026-10-18，本地未部署）

- 新迁移 `20261102000011_guard_transfer_maintenance.sql` 新增私有RLS表 `employee_transfer_maintenance`、`employee_transfer_write_permits`（无浏览器/service_role直接权限），以及94个ALWAYS语句级守卫，覆盖固定92业务根表和两个历史订单叶分区的INSERT/UPDATE/DELETE/TRUNCATE。迁移私有表及管理员登录/锁定表不受拦截，超管仍可重新登录；员工登录与业务/资金/聊天/自动化/历史清理写入受拦。ALWAYS守卫不被replica模式跳过；为避免旧快照漏见维护行，受保护业务写事务要求Read Committed，即使尚未维护也不接受Repeatable Read/Serializable写入。
- 新接口 `employee_import_dispatch_enter_maintenance` 要求超管任务、已封存独立备份、原计划、再次验证密码及确认语；排序表锁后取advisory独占锁，重新核对目标指纹才进入。`get_employee_transfer_maintenance` 只返回非敏感状态。任务/会话过期、取消或浏览器关闭均不自动放行业务；`employee_transfer_leave_maintenance` 只允许原超管新会话+密码+确认语，在未写入且指纹不变时撤回。**已提交写入的dirty状态禁止撤回，目前没有全站核对后解除维护或自动恢复接口，完整恢复流程完成前不可正式部署使用。**
- 私有写许可绑定当前xid与维护任务，固定允许四配置表和目标成员清除；不信任客户端GUC、不授权TRUNCATE，成功与异常均清许可。删除旧池内容的外键会向空 `dispatch_assignments` 发零行UPDATE，额外仅允许该表为空时UPDATE；其他操作或已有行仍阻断。新守卫加入迁移私有keep审核，既有业务保护不关闭。表/守卫/函数身份、定义、权限及启用状态变化拒绝；新表或分区未经审核也拒绝。
- `20261102000012_restore_dispatch_configuration.sql` 新增 `get_employee_import_dispatch_configuration_plan`、`employee_import_dispatch_apply_configuration`。管理员映射只读同包/同来源站/同操作者、真实已提交共享覆盖回执；取消结束任务保留该服务器回执，不接受客户端映射。目标锁内再核验空站、备份/指纹、来源清单及计划后，原子恢复 `dispatch_config`、`dispatch_groups`、`dispatch_order_pools`、`dispatch_group_orders` 全部来源列；目标成员先清空，来源成员/有效已用资料/员工订单依赖尚未恢复。
- 来源默认组对应目标默认组；每组来源Base对应目标唯一Base，新建组自动产生的Base只作占位，随后全部字段/内容按来源覆入。内部ID经映射，不沿用初始化业务值；先Base后普通池，允许普通池名为Base。目标多余组改名停用归档，普通池停用归档、保护Base保留但停用，旧池内容和成员在备份后清除；不删除Base、不开保护旁路、不级联真实历史。退休名已被其他合法目标对象占用则计划提前报 `reserved_retirement_name`，不静默改名冲撞。固定审核包含外键间接更新的assignments表及四个业务触发器定义，未知/禁用/修改拒绝。
- 写入后逐字段核对全部来源配置和残留不可用，失败完整回滚目标/dirty/许可；重复apply回同一映射回执、不多建池。成功只标 `configuration_applied=true`、`dependencies_pending=true`、`maintenance=true`，`replacement_ready/full_site_complete`仍false，不解除维护或完成全站。配置计划接口虽以get开头但会保存计划，明确不自动重试；客户端仅显式enter/plan/apply/leave并严格核对回执。
- 新增维护154、配置数据库53、配置客户端297，共504项通过；完整迁移2145/2145、聊天6/稽核48/工时6及typecheck/lint/build通过。本地严格尝试539份SQL，仍有原12项历史失败，结构106根表/937列；正式96表/871列及指纹不变。未访问正式库、部署SQL/Edge Function/前端或调整Storage/权限/cron，无UI/浏览器验收。屏障只保护数据库DML，不会把cron设置为停用，也不保证Storage、外部副作用、未知正式weekly函数或恶意postgres DDL；正式停站/任务清单、原生PG多连接锁/超时及anon3秒性能仍须单独验收和确认。

## 交单原文和来源使用计数恢复（2026-10-18，本地未部署）

- `20261102000013_restore_valid_submission_data.sql` 新增 `employee_import_dispatch_valid_begin`、`employee_import_dispatch_valid_chunk`、`employee_import_dispatch_valid_verify`；仅超管、原任务与同包服务器共享管理员回执可用。必须已封存独立备份、处于同任务dirty维护且四配置表实际恢复完成；begin再核对valid目标与备份目录一致，拒绝已有used记录和缺失管理员映射，不接受客户端表名、数据、ID对照或成功摘要。
- begin清除目标未用valid残留；按原暂存块顺序每次最多200行，以全部13个审核列INSERT、精确保留numeric原文、NULL、标签、停用原因、来源usage_count及last_used_at，不按现存used行重算。固定审核valid/used业务及维护触发器，名称/定义/属主/权限/状态变化拒绝，不关闭任何触发器。事务许可只涉及valid和其外键零行DELETE会触及的空used；不写used行，成功和失败均清许可。
- 服务器持久化已提交行数/游标；重复块逐字段核对而非ID跳过，完整verify重核暂存摘要、数量和映射后全部字段。已核验状态的重复begin/块也重新验证内容，避免返回过期成功。失败回滚该请求，不撤销此前已提交块；空来源仍须确认一块空数据并核对。全部回执继续maintenance/dependencies_pending=true、replacement_ready/full_site_complete=false，不解除维护。
- **这不是已用交单防重复状态迁移完成。** 来源成员、员工/精简订单可信身份回执及used引用、used补写时防使用计数重复累加仍未实现；旧员工草案不可提供同包可信映射，finalize可省略计数等缺口须后续修正。不得现在恢复营业或正式部署。本轮无正式库访问、部署、Storage/权限/cron变化，无页面或浏览器整站验收；原生PostgreSQL多连接/超时与anon3秒执行仍未验。
- 本地实际双站配置/交单数据库82项和客户端634项通过（其中本轮分别新增29和337项），覆盖403行三批精度/NULL/使用计数/时间原值、独立备份链、失败回滚、跨请求续接、重复/漂移/权限/过期/取消与范围外数据不变。完整迁移2512项、聊天6/稽核48/工时6及typecheck/lint/build通过；540份SQL仍保留原12项历史回放失败，106表/937列和正式96表/871列基线不变，非干净建库证明。

## 同包员工身份、凭据与精简订单恢复（2026-10-18，本地未部署）

- 新迁移 `20261102000014_export_stage_employee_identities.sql` 固定导出未封存全员14个账号业务列、4个凭据列（user_id以id投影）及7个已完成订单列；清单绑定来源站/包/有序行摘要，页≤200行/256KiB、行≤64KiB，每表≤50万行/256MiB、总≤768MiB。保留NULL、密码原指纹和numeric原文，不包含会话或详细历史金额/产品/编号/交易内容，processing只报告。身份导出有专用协议/双向任务隔离，close须源核验且不推进全站导出时间。
- 身份bind/stage复用已完成配置且封存备份的dispatch dirty维护任务，不另开任务；来源站/包必须相同，目录不可变，固定字段/类型/密码/真实订单CHECK、顺序、大小与重复JSON键严格检查，整表行数/字节/摘要及账号/凭据/订单关系核验。支持来源没有凭据的真实缺省状态，不凭空补密码。
- `20261102000015_restore_employee_identities.sql` 提供保存计划的 `get_employee_import_identity_plan`（不得自动重试）、`employee_import_identity_begin/chunk/verify`。同包管理员服务器回执映射归属，冲突只报告并阻断：同ID、同名需封存、员工号、管理员同用户名、缺管理员、订单ID、启用占位产品或派单/used所需来源身份缺失。仅无冲突分支可实际写入，未新增删除能力，也未串联同名员工备份/现有封存替换；不把原员工草案回执当可信证明。
- 账号始终停用，会话显式清空，标签/备注/置顶/验证/业务时间等原样保留；凭据保留独立原哈希，不强迫两处哈希相同。目标结构确实允许无归属时保留NULL；NOT NULL或既有required-owner CHECK会提前阻断，不猜默认管理员。订单使用停用占位产品、0.01与IMPORTED-<id>，保留佣金/状态/时间，派单/排程/快照清空，按产品/金额的历史统计不得纳入；当天员工展示标注还未接。
- 固定审核17个业务触发器及ALWAYS守卫，未知/定义/权限/状态变化拒绝。当前事务仅旁路钱包enqueue（同时避免建零财务基准）及订单6个副作用；保留用户自动建零钱包、财务/封存/订单保护，精确恢复原触发器状态并受延迟提交门禁约束。成功回执只记已提交行数/游标，重复逐字段核验，已verified状态重放时重验全部内容；私有身份对应只取同任务、同包和重新核验后的实际行，不接受客户端ID图。
- **零钱包与停用身份不代表资金迁移完成。** 身份阶段本身不写来源钱包/基准/账本/提款，后续资金回填见下文新迁移17–18；其他员工资料待接，旧apply_core不能直接接替已建立身份；需后续以本任务已核验账号事务回填资金，不能删重建或调用旧finalize提前启用。成员、used和防双计数现已由后续迁移16接入；同名封存、全站核对/dirty解除及UI仍待接。回执financial_data_pending/dependencies_pending/maintenance恒true、replacement_ready/full_site_complete恒false，取消/过期不放行业务。
- 配置/交单/身份双站数据库127项（新增45）、新身份客户端263项通过，包含203账号/1独立凭据/405精简订单、真实打包API流式→anon SQL、重复与失败回滚、NULL/微秒/高精度、权限/过期/来源变化/目标漂移及服务器对应。来源历史夹具用既有审计旁路避开原commission_audit_log缺列，不改业务定义；这不验证原站常规发佣金或全站财务。完整迁移2822/2822、聊天6/稽核48/工时6及typecheck/lint/build通过；542份SQL仍保留原12历史回放失败，106表/937列不变。无正式库访问/部署/Storage/权限/cron操作，无UI/浏览器整站或原生PG并发/anon3秒验收。

## 派单成员与已用交单恢复（2026-10-18，本地未部署）

- `20261102000016_restore_dispatch_dependencies.sql` 新增 `get_employee_import_dispatch_dependency_plan`、`employee_import_dispatch_dependency_begin/chunk/verify` 四个超管RPC；复用原dispatch-import任务与同包/来源站目录、真实共享管理员回执、独立封存备份及dirty维护。计划会保存服务器状态，不自动重试；新客户端工厂可重取已开始的原计划，再用begin拿已提交游标，不建立第二任务。
- 每次请求重核员工/凭据/精简订单真实内容、四表配置/默认组Base映射及valid全部字段；缺身份或未verified的valid拒绝。成员仅恢复来源的5列（改写group_id、assigned_by及已核验user_id），每员工唯一分组；used恢复5列，只关联同包已核验员工及其完成订单。新出现的目标成员/used报告并阻断，不删除、不取并集、不凭UUID跳过；非NULL分配管理员缺映射阻断，NULL和微秒时间保留。
- 私有触发器名单新增used及唯一计数触发器的已审核旁路策略，沿用原状态/定义/权限指纹校验与延迟提交门禁；不改业务触发器定义。实际写许可只含成员/used两表，不包含valid；仅used INSERT计数触发器临时关闭并精确恢复，ALWAYS维护守卫和外键保留。每块最多200行，账号/valid/资金不写；因此usage_count、last_used_at、启停、原文等全字段原样保持，不按used存量重算。
- 每次请求核对真实行数和已提交块内容，同ID异内容不接受；收到服务器提交回执才计进度。失败回滚当前请求，已提交块受dirty维护保护，取消/过期不恢复营业。回执仍maintenance/financial_data_pending/dependencies_pending=true、replacement_ready/full_site_complete=false，成员/used核对完成不代表资金、自动化或员工全站迁移完成；13的valid接口在used非空时会安全拒绝，不应倒序调用。
- 双站数据库169项（新增42）、轻量客户端679项以及完整迁移3544/3544通过，覆盖203来源成员、203 used多批、NULL/最大计数/未来最后使用时间、空集合、逐字段同数量漂移、晚失败、权限/过期/取消、封存回执及真实API跨请求续接。聊天6/稽核48/工时6及typecheck/lint/build通过，独立只读复审未发现其他高置信问题。543份SQL严格回放仍保留原12历史失败、本地106表/937列不变，不是干净建库证明。
- 无正式库访问、资料修改或SQL/Edge Function/前端/Storage/权限/cron部署；没有UI或浏览器整站实测。原生PG锁/并发/DDL缓存、anon3秒上限与大规模重复全内容核验性能仍未验收；资金六表后续进展见下文；同名员工封存串联、其他历史、全站核对/任务恢复/dirty解除、多卷/媒体与页面仍待做，不能正式使用。

## 同包资金六表恢复（2026-10-19，本地未部署）

- `20261102000017_export_stage_employee_finance.sql` 增加employee-finance-v1固定六表：wallets、wallet_balance_baselines、wallet_ledger_entries、wallet_transactions、withdrawals、wallet_reconciliation_audit。导出/核验/关闭及导入bind/stage复用私有任务和暂存；无新增表。页≤200行/256KiB，行≤64KiB，每表≤50万行/256MiB，总≤1GiB；超限阻断，原文金额不经JS浮点重序列化。钱包/基准额外协议id=user_id，自增ID与last_ledger_id用十进制字符串保留bigint，排序和比较仍使用原生编号类型；分页record游标固定text，防连接复用时UUID/bigint缓存类型冲突。
- 财务目录绑定来源站/包、每表有序原文摘要，以及完整identity_catalog（包括账号/精简订单摘要）；任何阶段源数据变化拒绝核验，资金目录不匹配已恢复身份时拒绝绑定，不把同包名当同内容证明。只导未封存员工的六表；financial_operations请求原文/幂等技术记录及已排除订单详情不携带。可空备注、审核身份、时间原样保留，管理员只从同包真实共享回执映射，不猜用户名或默认归属。
- `20261102000018_restore_employee_finance.sql` 提供保存计划的get_employee_import_finance_plan、显式employee_import_finance_apply/verify。plan/apply/verify重核身份、派单/valid/成员/used和资金的真实内容及审核触发器；计划列全局数量/待处理提款笔数与十进制金额。金额公式、缺钱包/员工、管理员映射或目标UUID/部分唯一键冲突报告并阻断，不静默跳过或修平；缺钱包的阻断计划仍可显示，但不可执行。
- 每员工六表单一事务：只更新该任务已创建的零钱包，复制流水/所有提款状态，账本及对账审计按旧ID顺序从目标序列新编号；私有暂存保存每行old→new对应，基准last_ledger_id换成旧ID≤旧游标的最后一个新ID，无则0。目标已有其他员工账本不改；无基准老账号保持无基准，待业务恢复后由正常对账首次建立。用户总收入由已核验身份阶段保留，资金阶段不另写users，不重建账号或复制会话。
- 固定审核六表全部10个业务触发器与ALWAYS守卫，定义/属主/权限/原O或A状态变化拒绝。事务仅精确旁路6项发账本/佣金稽核/自动化/提款事件/对账入队副作用并恢复原状态，沿用延迟提交门禁；外键、删除保护和维护守卫保留。写许可只六张资金表，不许可users或运行队列。提交前逐字段/行数、冻结=pending合计、钱包总额=基准总额+游标后账本增量、收入=基准收入+收入增量核对，失败只回滚当前员工。
- 完成记录、实际行与映射绑定原任务/计划/目录；重复apply/plan/verify重新核验已提交内容和计数，不凭旧success跳过。新客户端可绑定同目录取得原计划后续接；取消/过期保留已提交资金且dirty维护不解除。所有子阶段仍financial_data_pending/dependencies_pending/maintenance=true、replacement_ready/full_site_complete=false；这不是整体员工完成或恢复营业许可。
- 新资金双站49/49、客户端520/520、完整迁移4115/4115及typecheck/lint/build、聊天6/稽核48/工时6通过，涵盖原文高精度/bigint/NULL/微秒、游标前中后、全部提款状态、单员工额外1001行账本与流水、其他员工账本不变、唯一键/权限/过期/取消、逐字段漂移及跨真实事务提交续接。实际对账无金额修正，legacy首次建基准不改钱；每日统计/累计数及旧佣金检查结果与来源相同，不自动修平既有差异。独立复审发现分页动态record类型缓存问题，已修复/回归并复核未发现其他高置信缺陷。545份SQL仍保留原12历史失败、106表/937列不变，非干净建库证明。
- 原生PostgreSQL/PostgREST多连接、anon3秒上限、大员工单事务时延和全站放行未验收；PGlite规模冒烟不证明真实执行上限。无正式库访问/资料修改/SQL、Edge Function或前端部署，无Storage/权限/cron调整，无UI或浏览器整站实测。同名员工备份/现有封存、聊天/通知/实名/活动/自动化与档案、全站协调/核对/任务恢复和dirty解除、媒体/多卷/公告轮播排除及迁移页面仍待完成。

## 同包登录与工时历史恢复（2026-10-19，本地未部署）

- 新迁移`20261102000019_export_stage_employee_activity.sql`固定employee-activity-v1三表：employee_login_history、work_sessions、private.employee_work_stop_markers（协议键work_stop_markers、额外id=user_id）。目录绑定来源站/包和完整identity_catalog，源前后核验；固定页200行/256KiB、行64KiB、表50万行/256MiB/总1GiB，超限不截断。导入复用原派单任务bind/stage，不创建第二活跃任务，不接受调用方映射。
- 登录协议含10个真实列及device_info_is_sql_null布尔投影，区分SQL NULL与JSON null；恢复device_info时直接使用原始JSONB，不经record把JSON null变成SQL NULL。嵌套设备JSON/原始数值、NULL/微秒、历史姓名/员工号、设备/IP原样保留；非空session_id导出为history-加SHA-256(来源站:员工:原会话)，相同员工旧登录/登出仍可关联，不携带有效会话。目标核验不再次散列。
- 新迁移`20261102000020_restore_employee_activity.sql`提供保存计划的get_employee_import_activity_plan和显式employee_import_activity_apply/verify，每次重核前置身份/配置/valid/成员/used/资金实际内容、独立封存备份与持续维护，不只信verified标记。源员工缺失、目标历史残留/跨员工UUID碰撞或派生工时分钟超int32会列冲突并阻断；计划后碰撞也拒绝，不覆盖/静默跳过。
- 单员工三表事务恢复：仅end_time=NULL的工时，结束时刻=GREATEST(start_time,COALESCE(last_heartbeat_at,start_time))，分钟=非负四舍五入；不按导入时间扩张，也不采用正常在线统计的一分钟宽限。已结束工时的end/duration/心跳/空值不改，停工标记原值恢复，不复制派单或登录会话。七个登录/工时副作用触发器严格审核、事务内精确旁路/原O或A模式恢复，保留外键/ALWAYS维护/延迟提交门禁；无自动化入队或实时信号，资金及其他业务表不写。
- 每员工提交前核对全字段/数量；逐员工完成记录绑定计划，重复apply/plan/verify重验实际内容，跨事务/新客户端显式续接。失败仅回滚该员工，已提交记录仍维护保护；本地取消不冒充服务器回滚，临时明文成功/失败均清理，清理期间取消仍携带stagingMayExist提示。账号仍停用、dirty维护不解除，所有pending标记/全站完成边界不变。
- 该活动阶段当时双站61/61、客户端456/456，完整29文件分组4634/4634、typecheck/lint/build、聊天6/稽核48/工时6及格式检查通过；后续实名与证件媒体及当前验证汇总见下一节和迁移计划第30节。修复并复审确认设备两种空值与清理期间取消边界；547份SQL严格保留12旧失败、106表/937列及正式独立基线不变。未访问或部署正式环境，无UI/浏览器整站/原生PG多连接、anon3秒和大员工事务性能验收；实名/通知/聊天、媒体/自动化、全站协调及放行仍待接，不可正式使用。

## 同包实名原文及实际证件媒体（2026-10-19，UTC+8，本地未部署）

- 新SQL为`20261102000021_export_stage_employee_verification.sql`、`20261102000022_restore_employee_verification_media.sql`，无新增表。`employee-verification-v1`固定`verification_requests`全部15列原始NDJSON，包含历史语义的wallet_address/证件号、email/地址，保留status、审阅、NULL和微秒；仅目标审阅人和非空媒体URL按已核验对应改写。目录绑定来源站/包及完整identity_catalog；页200行/256KiB、行64KiB、表50万行/256MiB，超限拒绝不截断。
- 浏览器RPC：`employee_export_verification_begin`、`get_employee_export_verification_page`、`employee_export_verification_verify/close`、`employee_import_verification_bind/stage`、`get_employee_import_verification_plan`、`employee_import_verification_apply/verify`，以及媒体库存`get_employee_transfer_verification_media`和不可变目录`employee_import_verification_media_bind`。均SECURITY DEFINER/固定search_path，撤销PUBLIC后授予anon/authenticated，内部验证超管会话/原任务；私有helper无浏览器权限。plan保存状态，不自动重试；导出verify/close要求实际媒体下载和复核，只结束子阶段、不更新全站成功时间。
- 导入沿用已封存独立备份的dispatch-import dirty维护任务，不新开任务；同包管理员共享服务器回执、已核验身份/配置/valid/成员/used/资金/活动及其真实内容都是前置。仅服务器同包admin map映射审阅人，非NULL缺映射、来源员工缺失、目标残留/UUID碰撞、计划后变化或字段漂移阻断。每员工一个事务，只给`verification_requests`写许可，保留外键/ALWAYS维护和所有保护，不关任何触发器、不更新`users.is_verified`（该标志与申请status独立）；重复和续接重验全部字段/数量，失败仅回滚本员工。
- 媒体`employee_transfer_verification_media_authorize/commit`仅service_role可执行，anon/authenticated/PUBLIC均无执行权限，Edge在授权和提交时重新校验session/job。浏览器无serviceKey、不直接Storage写入；复用私有暂存回执。只接受固定`verification-documents`桶的id-front/id-back/selfie三目录及所属员工UUID前缀，导出URL必须严格匹配服务端本站`https://<项目>.supabase.co/storage/v1/object/public/...`；外链、其他站点、签名参数、未知格式/穿越或错属文件全阻断，不漏文件。NULL链接保持NULL。
- 服务器生成`folder/employeeUUID-transfer-<SHA-256(job_id:key)前32位>.ext`目标路径，兼容既有员工证件删除留证/清理识别；`upsert=false`、不覆写/删除旧文件。同任务同tuple仅实际回读哈希/大小/MIME一致才可复用，路径异内容拒绝。上传后服务readback；全部员工apply完须显式`recheckImport`再SQL verify。generation绑定读前授权时已提交员工代次，期间apply使旧代次commit拒绝；最终还核对checked、代次和最后apply时间，不能以早先回读代替最终核验。
- Edge用固定环境origin的raw Storage fetch流式限量读取，避免SDK download先Blob缓冲；响应头/正文共用90秒超时与Abort，实际大小≤50MiB。JPEG/PNG/GIF/WebP/PDF魔数仅识别MIME，非完整解码/病毒扫描。最多3000文件、记录加媒体合计≤1GiB，单卷仍受manifest最多4096条目约束，不是无限全站媒体或多卷。客户端整卷认证后的隔离文件先全验证NDJSON/全部媒体再写，上传前二遍hash，真实一致回执后才计进度；错误脱敏，无自动写重试。SDK upload不可强制中止，失败/取消可能遗留对象，不能自动delete/假回滚；清理期间取消仍提示server数据可能存在。
- 最终完整activity-db文件147/147（原61+新增86），实名API123/客户端130/Edge328共581/581，其他28迁移文件分组4575/4575，32文件合计5303/5303；foundation47/47含新增2项，scope实际文件18/18。聊天6/稽核48/工时6另60项，typecheck/lint/build及格式检查通过。多次完整测试超时、早期失败和过滤局部通过不计；最终`/tmp/verification-db-complete.log`147项零失败/取消/skip，分组不是单次完整命令通过。严格549份SQL仍保留12旧失败，本地106表/937列未变，非干净建库或全站完成证明。
- 独立复审发现目录SQL语法/数组类型、回读代次竞态、SDK Blob缓冲、响应头取消及客户端续接门禁，已修复并回归复核。数据库层使用合成媒体回执，Edge/客户端使用fakeStorage与注入传输；未做原生PG/PostgREST并发、anon3秒/大员工性能、真实Storage/CORS/Edge限额、浏览器磁盘、完整加密归档往返、多卷或整站验收。
- **未访问/改变任何正式库数据，未部署SQL/Edge/前端，无Storage/权限/cron调整；仅调用Supabase文档搜索，非正式数据访问。** 新Edge未配置/部署，未来单独确认`verify_jwt=false`（内部验证session/job），本轮不改config或桶权限；无UI/导航，前端完整功能仍待用户部署，不能正式迁移。账号停用、dirty维护及全部pending标记不变，replacement_ready/full_site_complete仍false；通知奖励/自动化、聊天/档案、同名员工备份封存、全站协调核对/任务恢复放行、其他媒体/多卷/公告轮播排除和页面仍待实现。详见迁移计划第30节；第29节保留当时边界。

## 通知、奖励与自动化原文预检（2026-10-19，UTC+8，本地未部署）

- 新迁移`20261102000023_export_stage_site_notifications.sql`、`20261102000024_check_site_notification_links.sql`复用私有任务/暂存，无新增表、业务写许可、触发器旁路、Storage或cron变化。固定13表：`notification_automation_{plans,tasks,plan_members,task_recipients,progress,executions,date_runs,failures}`、`messages`、`message_recipients`、`message_templates`、`broadcast_messages`、`broadcast_recipients`。公告不在范围。
- 七个RPC：`employee_export_notifications_begin`、`get_employee_export_notifications_page`、`employee_export_notifications_verify/close`、`employee_import_notifications_bind/stage`、`get_employee_import_notifications_plan`。SECURITY DEFINER/固定search_path、撤销PUBLIC后授予anon/authenticated；内部重验超管与原任务，私有helper无浏览器/service-role执行权。隔离专用协议，旧finish不能旁路；导出close重新检查来源漂移，不推进全站成功时间，媒体仍pending。
- 目录绑定同包完整identity/finance清单，资金及身份须真实核验；沿用独立备份、服务器管理员映射、dirty维护。页200行/256KiB、行64KiB、表50万行/256MiB、总1GiB；原文不经JS重序列化，bigint十进制字符串、复合键虚拟id按C文本排序，NULL/微秒保留。四个收件租约字段不导出，错误原文固定脱敏，触发快照固定审核键；date_runs缺表只支持空能力，不创建表，也不解决既有维护守卫的缺表阻断。
- 暂存幂等只认同字节块，摘要/连续游标/计数完整核对后才关联预检。plan真正STABLE直接读有效任务，不续heartbeat、不保存计划；同一快照重验资金、员工、管理员、父级、归属、唯一键和奖励/执行/通知/收件/交易的双向关联。READ ONLY真实事务已验证；不调用发送、credit_performance_bonus或写财务幂等请求原文。
- 无任何通知业务apply。无冲突也固定can_restore=false、restore_pending/media_pending/automation_pending=true；账号停用及dirty维护不解除。通知媒体、同名方案/任务/范本独立备份覆盖、实际恢复及执行等价去重/任务续接仍待做；未访问或修改正式库、未部署SQL/Edge/前端，无UI/浏览器或真实Storage验收。测试覆盖见迁移计划第31节。

## 通知配置独立记录备份（SQL25，本地未部署）

- 新增RLS私有`employee_transfer_notification_backups`（11列），job_id唯一但backup id独立，不占用原派单shared_backups；撤销PUBLIC/anon/authenticated/service_role表权限。新技术表仅加入维护断言的精确排除项，未知其他表/缺失或禁用业务守卫仍阻断。新任务状态触发器清未sealed记录；sealed密文及原派单备份不随取消/废弃删除，冻结明文沿用现有任务暂存清理。
- 7个超管RPC：`get_employee_import_notification_configuration_plan`、`employee_import_notification_backup_prepare`、`get_employee_import_notification_backup_page`、`employee_import_notification_backup_verify/append/seal`、`get_employee_notification_saved_backup_chunk`。SD、固定search_path、浏览器授权且内部重验，private helper及service_role无调用权；计划/页/verify/取回STABLE不续心跳，prepare/seal锁内重算同包管理员对应/来源/目标哈希。120秒前端等待不改变数据库3秒执行上限，写接口不自动重试。
- 方案/任务/范本按对应归属/父级及名称匹配，预览精确成员移出和多余任务，不改业务；歧义、ID/唯一键/范围外成员或目标相关执行/通知/奖励/运行状态阻断。实际13表指纹涵盖租约及未脱敏错误，冻结记录投影仍不带这些敏感/运行字段；同数量漂移、快照原文及目录全部重验。
- 固定13表记录备份明文8MiB/密文9MiB；独立文件完整认证/行摘要核对后才传连续128KiB密文并封存，绑定计划/任务/站点/包；密文可由原超管的新会话跨任务过期/取消取回。media_included=false、media_pending/automation_pending=true、can_apply_configuration=false；无通知业务许可/发送/发奖/financial_operations重放/账号启用或dirty维护解除，不能将记录备份视为完整可恢复备份。详见计划第32节。
- 本轮7迁移测试文件分组1524项，双站236按46/44/60/86互斥组完整执行；没有访问正式库、部署SQL/Edge/前端或修改Storage/权限/cron，无UI/浏览器/真实Storage或原生PG并发性能验收。

## 通知媒体及实际恢复（SQL26/27，本地未部署）

- 新增8个RPC，不新增表：`get_employee_transfer_notification_media`、`employee_import_notification_media_bind`、仅service_role的`employee_transfer_notification_media_authorize/commit`，以及`employee_import_notifications_begin/chunk/verify`、STABLE的`get_employee_import_notifications_restore_status`；均固定search_path/超管与同包任务鉴权，类型及120秒客户端等待同步，不放宽数据库执行上限。
- 仅使用通知原文可证明的三桶引用，完整不可变文件目录、本站Edge读写/回读和读前代次绑定；来源媒体与目标链接映射保存在原任务/暂存。来源与目标漂移、外链或无法识别的编码媒体阻断，限制/类型见计划第33节；无Storage策略/cron改动。
- begin要求最新无冲突计划、原独立备份已封存、身份资金真实核验及完整媒体回执；来源覆盖三配置、精确成员、暂停多余任务且不删除目标文件/历史证据。任务记下来源启停状态，当前全部方案/任务暂停。逐块≤200行恢复其余历史；循环执行/消息外键分阶段链接，投递序列分配新号并保留来源顺序，租约清空，奖励只保留关联不重新入账。
- 每请求只授权固定表，保留ALWAYS守卫/外键/内容保护；只精确旁路审核过的规范化与快照副作用并恢复原状态。收件留证触发器不旁路，仅收件阶段附加`private.content_audit_recipient_versions`写许可；逐行核对人工收件快照，旧证据冲突拒绝覆盖。异常回滚当前批、已提交状态可用新API继续；verify须最终代次媒体回读，不启用员工或解除dirty维护。
- 四客户端/服务文件902项、新增SQL恢复8项分两组通过、foundation/scope70项及聊天6/稽核48项通过；554份迁移保持12项既有历史失败及107根表/948列。未访问/改动正式环境或部署SQL/Edge/前端，无UI/真实Storage/原生PG时限/全站验收；自动任务续接和全站协调仍待实现。

## 聊天原文与角色合并预检（SQL28/29，本地未部署）

- 新增`20261102000028_export_stage_site_chat.sql`与`20261102000029_plan_site_chat_merge.sql`，复用私有任务/暂存，不增加表或业务写许可。`site-chat-v1`固定聊天十表及列，含空角色、未引用模板/自动消息/富卡库与评分记录，目录精确绑定同包identity/finance及原派单导入任务。
- 七个超管RPC：`employee_export_chat_begin`、`get_employee_export_chat_page`、`employee_export_chat_verify/close`、`employee_import_chat_bind/stage`、STABLE的`get_employee_import_chat_plan`；固定search_path、私有helper撤权、内部验证会话/任务及服务器管理员图。仅原文stage写入私有暂存；不关保护触发器，不恢复聊天业务或媒体，不改变既有service_role媒体RPC授权。
- 所有原文行按C顺序分页/逐行摘要，SQL NULL/JSON null单独标记；复合备注游标为角色:员工。页200行/256KiB、行64KiB、每表100万行/512MiB、总1GiB、角色2000条，超限阻断。导出verify/close重算源，close不更新全站成功时间；前端120秒等待不放宽数据库3秒时限。
- 计划只读重核真实前置及引用/归属/唯一槽位，按映射管理员/工作区给角色exact/name/ambiguous/number_conflict/new/unmapped提案；列出多旧合一、显示编号占用及按target_employee_ids数组语义计算的可见性差集。目标内容指纹参与计划哈希，不保存计划或续心跳。无冲突仍can_restore=false、media_pending=true、full_site_complete=false，账号停用/dirty维护保持。
- 客户端/API67项、新增双站聊天12项及foundation/scope72项通过，严格556份SQL仍保留12项旧失败、107表/948列不变；不是干净建库。未访问或部署正式环境，无UI/浏览器/真实Storage或原生PG时限验收；实际角色/聊天/工单/快照/评分恢复、媒体与全站协调仍待做，详见计划第34节。

## 聊天独立备份、媒体与实际合并（SQL30–32，本地未部署）

- SQL30新增11列RLS私有`employee_transfer_chat_backups`，独立于派单/通知备份；仅精确豁免维护技术表库存，浏览器/service_role无直接表权限。新合并计划及备份七RPC，决定绑定同包服务器管理员图/全部角色/可见性；冻结十表记录、独立密文保存回读后才封存。8MiB明文/9MiB密文，sealed跨取消保留，目标NULL数组原文保真。
- SQL31新增库存/bind两个浏览器RPC及service-only `employee_transfer_chat_media_authorize/commit`，Edge独立chat作用域。generation为十进制字符串，commit参数bigint；四桶实际引用/路径严格受控，头像5MiB、普通50MiB、3000文件及总1GiB。真实回读才提交、最终generation后重检；源原文不改，服务端作固定URL改写，字段/格式边界见计划第35节。
- SQL32新增`employee_import_chat_begin/chunk/verify`与STABLE `get_employee_import_chat_restore_status`。begin需当前计划/封存独立备份/完整媒体且不写业务；十表固定次序分块恢复，角色属性保持、工单/富卡/备注/自动消息标记按规则复用，消息UUID异内容拒绝。完整映射/字段/NULL/进度重验，目标漂移阻断；不启用账号/解除dirty维护。
- 审核20个聊天触发器及外键/维护状态；只在消息块事务内精确旁路`freeze_service_rich_card_before_insert`并恢复原O/A模式，其余保护保持、提交门禁继续。写许可仅当前表，消息块额外富卡表；不写资金/奖励/通知/运行队列。begin/chunk/verify审计不带正文，写RPC无自动重试，120秒客户端等待不放宽数据库执行上限。
- 本轮十迁移文件分层1173项（聊天客户端/服务1065、foundation/scope75、数据库33唯一用例），未跑全274或全迁移总命令；另旧媒体706/聊天6/稽核48项。559份SQL仍12旧失败，本地108表/959列，正式独立基线不变。未访问/部署正式库/Edge/前端，无Storage/权限/cron或UI改动；真实Storage/原生PG/PostgREST并发与anon3秒性能、多卷/浏览器/整站仍未验收。

## 类型与测试
- `src/types/database.ts` 手工维护（没有生成脚本）：新增 RPC 时补充 `Functions` 的 `Args` / `Returns`；改表时同步 `Row` / `Insert` / `Update`。
- `supabase/tests/audit-cleanup.test.mjs`：用 PGlite 加载缩减版 schema，再执行指定的真实迁移；每个测试在事务中执行后回滚。运行 `npm run test:audit-cleanup`。
- `supabase/tests/service-chat-scale.test.mjs`：先装入正式库现行的会话摘要与分组 RPC（取自旧迁移），在混合数据（跨组旧会话、已归档员工、停用/紧急组、富卡、空时间消息、空聊天表）上记录结果，再执行 `20261101000002` 并逐行对比；另验证 `get_admin_chat_unread_counts` 的范围、无效/停用会话拒绝与执行权限。运行 `npm run test:service-chat`。
- `supabase/tests/work-session-stop.test.mjs`：装入现行的开工/停工/恢复 RPC，先复现「主动停工后刷新被自动恢复」，再执行 `20261101000003` 验证主动停工不再恢复、刷新（beacon 停工）仍会恢复、停工后重新开工再刷新仍会恢复，以及权限。运行 `npm run test:work-session`。
- `supabase/tests/employee-transfer-foundation.test.mjs`：严格核对当前 574 份 SQL 回放中的 12 项已知历史失败（文件和完整错误必须一致），验证迁移辅助的双库资源释放、同站保护、匿名 RPC 和私有表权限；新增/变化/缺失失败阻断。测试使用 platform/baseline 替身，**不是全部迁移成功或真实空库建库证明**。
- `supabase/tests/support/transfer-scope.mjs` 与 `employee-transfer-scope.test.mjs`：固化本地 109 张根表、967 列及业务迁移意图，拒绝未知/缺失表列、类型/空值性漂移；不是导出授权清单，也不表示转换已实现。SQL47/基础/范围三文件最终完整117/117通过；当前严格回放574份仍同12项旧失败，不把历史scope数量当本轮结果。根表覆盖不含独立分区，实际目标库仍须重新核对。
- `employee-transfer-production-scope.test.mjs` 单独核对正式 96 根表/871 列及独立目录 SHA-256，与本地 109 表配置不可混用；`employee-transfer-triggers.test.mjs` 验证真实迁移 SQL 的精确状态恢复、回执和提交门禁（使用 PGlite，不是原生多连接测试）。
- `npm run test:employee-transfer` 运行加密、ZIP 清单/容器、增量 SHA-256、基础回放、双结构库存、触发器、共享设置导出/导入、来源覆盖与备份/API、产品专用数据库/客户端、派单交单导出/目标预检及导入准备/独立备份、持续维护、派单配置、交单原文/使用计数及同包员工身份/精简订单及来源成员/used防双计数及资金六表、登录/工时/停工标记三表、实名15列及证件媒体SQL/API/客户端/Edge分层测试；本轮新增通知/广播/范本及自动化13表原文/关联预检；第31节曾对34文件分组覆盖6058项；第32节新增配置计划/独立通知记录备份后，本轮只对7文件分组覆盖1524项，其中activity-db236按46/44/60/86互斥名称组实际执行。单组跳过不计通过，合并无遗漏；不把历史总数当本轮完整总命令通过。全站往返、管理员/配置/自动化/真实Storage及界面验收尚未完成，不以fakeStorage替代实际媒体验收。专项命令为 `test:employee-transfer:crypto`、`:foundation`、`:scope`。
- 聊天SQL28/29专项为`employee-transfer-chat-{api,client}.test.mjs`及activity-db的`chat transfer:`组：67+12项；本轮同时重验旧activity-db244项，五个迁移文件分组395项（67+256+72），通过名称集合无漏/重。通知旧断言修正后单独复验，不声称一次全文件或npm总命令零失败；详细组数及超时说明见计划第34节。无聊天业务apply或媒体/界面验收。
- `supabase/tests/employee-transfer-verification-{api,client,media}.test.mjs`与扩展的`employee-transfer-activity-db.test.mjs`分别验证实名API、NDJSON/媒体客户端、Edge/fakeStorage及真实迁移SQL；最终147+581项证据与未覆盖边界见上节，不是完整加密归档往返或真实Storage验收。
- `supabase/config.toml` 只配置了 `process-orders`、`cleanup-dispatch`，未配置`content-audit`或本地新`employee-transfer-media`，本轮不修改；`supabase/health_check.sql` 是为新部署准备的只读检查，期望的定时任务与存储桶清单已过时。
