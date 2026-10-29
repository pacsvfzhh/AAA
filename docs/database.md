# 数据库、服务端与运维

正式环境：Supabase 项目 `hxpbpqoqkoiiplvdwmld`。本文中「正式环境」的内容于 2026-10-09 只读核对。

## 核心表（public）
| 领域 | 表 |
|---|---|
| 账号与会话 | `users`（员工；`region_id` 指向 `employee_regions`）、`employee_regions`（员工所在地区选项，每个管理员群组独立，`admin_id`）、`admins`（`role`、`parent_id`）、`admin_financial_sessions`、`employee_financial_sessions`、`financial_admin_credentials`、`financial_employee_credentials`、`financial_login_attempts`、`login_attempts`、`account_locks`、`account_lock_events`、`employee_login_history`、`employee_login_history_events`、`employee_presence_events`、`work_sessions` |
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
- 员工地区迁移：`20261102000000_add_employee_regions.sql` 建表 `employee_regions`（RLS 开启、无策略，`anon`/`authenticated` 无表权限，只经 RPC 读写）与 `users.region_id`（外键，地区被删时置空），并给 `anon`/`authenticated` 补 `region_id` 列级读取权限（Realtime 才会带出地区变化）；改写 `get_employee_management_snapshot`、`admin_create_employee_account_with_automation_plan`（末尾 `p_region_id`）、`admin_update_employee_account_unlocked`（允许 `region_id`）。`20261102000001_per_admin_employee_regions.sql` 改为每个管理员独立：`employee_regions.admin_id`（必填，管理员删除时连带删除）取代 `created_by`，唯一索引 `(admin_id, lower(name))`；旧的共用地区按使用的群组拆成各自一份；新增 `admin_rename_employee_region`、`admin_delete_employee_region`（有在职员工时必须给同群组替代地区）与私有辅助函数 `private.resolve_employee_region_owner`、`private.normalize_employee_region_name`；`admin_create_employee_region` 改为 `(token, p_owner_admin_id, p_name)`；建立员工时地区必填且须属于员工的管理员；编辑时传 `region_id` 就必须是同群组地区、不能清空；快照只返回可见群组的地区并带 `admin_id`。已有员工的 `region_id` 可为空（数据库不加 NOT NULL）。`20261102000002_pin_employee_regions.sql`（经用户确认已部署，正式版本 `20261024011635 pin_employee_regions`）新增 `employee_regions.is_pinned boolean NOT NULL DEFAULT false` 和 `admin_set_employee_region_pinned(token, p_region_id, p_is_pinned)`：验证会话及群组权限、锁定目标地区后按指定布尔值保存（重复设置幂等）；新建、改名及快照返回 `is_pinned`，不改员工统计。地区表仍不对浏览器直接开放，二级管理员不能置顶其他群组地区。测试：`npm run test:employee-regions`。
- 本地有但正式库从未执行：`20260905015900_fix_workspace_summary_counts.sql`（正式库没有 `sync_conversation_source_type` 触发器）。正式的 `get_ccc_conversation_summaries` 来自 `20260901220357_enforce_ccc_group_isolation.sql`（超管工作区的摘要也包含其他非紧急组员工，前端再按本组员工过滤），`get_admin_groups_for_customer_service` 来自 `20260930081803_align_service_conversation_sources.sql`；消息与客户的 `source_type` 一致由该迁移的 `(customer_id, source_type)` 复合外键保证。改写这些函数时以正式库实际定义为准。

### 通知正文取消业务长度上限（后端已部署，前端待上线）
- 新迁移 `20261103000003_remove_rich_content_length_limits.sql`：单事务内仅移除 `messages_content_length` 的100000字上界、`notification_automation_tasks_content_template_check` 的5000字上界，以及 `send_admin_message_secure` 的5000字／`commit_content_audit_change` 中 `notification_edit` 的100000字正文上界。空白／NULL、标题、鉴权、媒体证据与奖金幂等规则不变；普通 `chat_edit` 和已停用的旧编辑RPC不改。
- 函数按完整签名及唯一原文锚点定点替换，锚点不符则整个事务失败；参数、返回类型、所有者、search_path与ACL均不变，因此不涉及前端数据库类型形状更新。公告及aaa／ccc富卡正文原无数据库上限，不改其表／函数；公告仅删除前端500KB检查。Edge Function无代码或部署变化。
- 经用户明确确认，本迁移已于2026-10-26（UTC+8）部署到正式AAA库，正式版本 `20261025205517 remove_rich_content_length_limits`。部署前重跑34项长正文回归通过；部署后两个函数完整定义哈希与预期精确替换一致，所有函数元数据（含参数、ACL、所有者、search_path）未变，两个约束均仅保留非空下界且已验证。相关八表的表／列权限、NULL规则、RLS、触发器及其余约束目录指纹与部署前一致。
- 未重发通知、修改既有正文或奖励，也未放宽图片／视频等上传保护；未用正式员工账号或真实通知验证。原通知发送上限现已解除，公告前端500KB检查移除与空富文档补充检查仍待用户发布新版前端；上一轮尚未完成的界面边界复验不由本次部署替代。
- `npm run test:rich-content`：34项真实迁移回归，覆盖5001／100001字及中文HTML大于500KB完整往返、通知编辑留证、奖金幂等、权限、非空／标题约束、自动通知模板、两工作区富卡冻结、公告；对比完整数据库目录，除两处函数正文及两个约束外元数据均相同。回放533份迁移，12项既有历史失败未变，并非完整空库建库证明；真实Storage、Edge HTTP及多连接并发未覆盖。

### 派单服务器时钟（后端已部署，前端待上线）
- `20261103000002_dispatch_server_clock.sql`：在事务内仅为现有 `prepare_next_dispatch_order_secure`、`assign_next_dispatch_order_secure` 的 JSON 返回附加 `server_now = clock_timestamp()`，包括未到期重试及不可用响应；不改表、参数、返回类型、权限、会话校验、选池／间隔随机算法、概率及费率快照。迁移先检查原函数存在及预期返回锚点，结构不符则全部回滚，禁止盲目覆盖。
- 经用户明确确认，本迁移已于2026-10-26（UTC+8）部署到正式AAA库，正式版本为 `20261025200517 dispatch_server_clock`。部署后两个函数完整定义的MD5均与部署前计算的预期定义一致，移除新增字段后与原定义逐字一致；所有者、SECURITY DEFINER、search_path、执行权限全部保持不变，准备接口五处及派单接口七处JSON返回均带服务器时间。未使用真实员工会话或创建正式派单来测试。
- 后端已就绪，前端仍待用户通过现有Vercel发布流程上线；Builder推送不等于部署。旧前端忽略新增字段仍能运行，新前端缺少服务器时间会暂停派单并进入原有错误重查，不回退到不可靠的设备时间。
- `npm run test:dispatch-timing`：16项单调时钟／设备调时／任意区间／过期及非法时间单测，外加真实迁移回放后的维护与派单时钟共19项；断言两个函数移除新增JSON字段后与原定义逐字相等，权限／所有者／search_path不变，后台1秒、30–150秒、87–213秒、3000秒配置正常、已有选择不重抽、未到期及成功响应含服务器时间、无效身份仍拒绝。回放532份迁移存在12项既有历史失败，不是空库建库或完整结算验收；另运行 `test:work-session` 六项恢复回归。未访问正式订单或操作资金。

### 员工团队维护（后端已部署，前端待上线）
- 迁移：`20261103000000_employee_login_maintenance.sql`。新增 `private.employee_login_maintenance`（管理员ID主键、开关、操作者、更新时间）、`private.employee_login_maintenance_confirmations`（操作者密码确认失败计数／锁定到期）和 `private.employee_login_maintenance_events`（操作审计，无密码或令牌）。均启用RLS，撤销PUBLIC／anon／authenticated直接表与序列权限，不加入Realtime。
- `get_employee_login_maintenance(token, owner_admin_id)` 及 `set_employee_login_maintenance(token, owner_admin_id, admin_password, enabled)` 为SECURITY DEFINER，固定search_path、撤销PUBLIC后仅按需授权。会话取真实操作者，二级只读写自己、超管可指定非紧急管理员团队；写入用 `financial_admin_credentials` 当前bcrypt验证，连续5次错误锁定此操作者的确认15分钟，不影响管理员登录。成功写入及审计同事务完成；默认无配置即关闭。
- 追加 `20261103000001_team_employee_maintenance.sql`：employee_financial_sessions新增私有maintenance_revoked_at。set RPC正确密码后持有团队独占事务锁，同事务撤销该组未撤销会话并标记原因、清空用户会话token/tab（触发现有users Realtime）、按原心跳截止规则结束工作与派单、记录employee_work_stop_markers、取消尚无实际订单且未标记提交的派单。已保存orders及资金表不修改，已提交派单由既有生命周期处理；失败全部回滚，关闭开关不恢复旧会话。
- create_employee_financial_session保留原密码／锁定逻辑，正确密码后持团队共享事务锁再判断维护，防止开启时并发新登录漏入；订单INSERT共享同一锁且维护中拒绝新提交。used_order_data中同员工真实orders可补写，避免维护切断已接受订单的防重复记录，他人／伪造／空订单不能绕过维护拦截。UPDATE不拦，既有订单结算照旧。
- get_employee_maintenance_status(user_id, financial_token, tab_id)验证真实未过期token hash及绑定员工／tab，返回maintenance/session_valid；标注维护原因的撤销token只能用本RPC查原因，不能复工或进行财务操作。管理员与原validate_employee_session函数定义不变，原业务认证因revoked_at拒绝旧会话。recover_employee_dispatch_assignment_secure先锁financial/user再处理派单以统一锁序，并检查历史维护撤销及停工标记；关闭维护并重新登录也不自动恢复维护前的已交派单工作，显式start不变。
- 经用户明确确认，两份迁移于2026-10-25（UTC+8）部署到正式AAA库：`20261024200433 employee_login_maintenance`、`20261024200605 team_employee_maintenance`。部署后六个函数体MD5与本地源码一致，管理员登录及原会话验证定义哈希与部署前一致；私有表RLS启用且anon不能读写，RPC无PUBLIC执行权，两个INSERT guard及撤销原因列均存在。维护配置、启用团队、维护审计、维护撤销数均为0，没有开启任何团队或测试真实登录／交单。公开状态接口以空身份只读探测HTTP200且session_valid=false，确认PostgREST已刷新。
- 前端仍待用户部署；须先上线新版员工维护边界，再实际开启团队维护，旧前端不含专用确认退出流程。安全Advisor中的[私有RLS表无策略](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)与[anon可执行SECURITY DEFINER](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)属于本项目设计：私有表仅由已认证RPC写入，浏览器不能直接访问；RPC内部验证自建会话。未为消除提示而开放私有表策略。既有通知过程search_path提示未在本任务变更。
- 隔离回归：npm run test:employee-login-maintenance，17项涵盖权限／操作者密码／限流／团队隔离／旧token撤销／停工时间／未交派单取消／已交订单保留／usage补写／恢复不自动开工／事务回滚。回放531份迁移仍有12项已知历史失败，并非空库完整建库证明；历史commission_audit_log缺old_order_status导致完整结算无法在此回放库验证，测试明确记录，不绕过触发器。正式库只读触发器清单不含该旧审计触发器；未用真实账号、未提交真实订单、原生多连接并发未实测。

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

### 对账队列死锁修复（APLF10 已部署）
- 目标为 APLF10（`ashxnuadjvhqucoobmyp`），不是本文默认的 AAA 项目。2026-10-29（UTC+8）只读日志显示，订单佣金触发器先入对账队列后更新钱包，而对账器先锁钱包、员工再删除队列；两种顺序及跨员工批次持锁产生了两次 pg_cron 死锁。
- 新迁移 `20261103000004_avoid_wallet_reconciliation_deadlocks.sql` 只替换 `process_wallet_reconciliation_queue(integer)` 的函数体：每名员工在子事务内以 `FOR UPDATE NOWAIT` 依次检查队列、钱包、员工行，再调用未修改的 `reconcile_wallet_from_ledger`。锁忙则该子事务回滚、保留队列且不增加失败次数，返回新增的 `skipped_busy` 计数。默认／最大批量、已有 JSON 字段、参数、所有者、SECURITY DEFINER、search_path、权限均保留。
- 普通业务失败仍回滚该员工并按原公式增加重试次数、安排延后；记录错误前再次非阻塞锁定队列，防止异常处理本身形成第二个死锁。此时若队列也忙，只输出警告并保留队列供后续重试。该修复针对已观察到的对账 worker 行锁环，不宣称消除全库所有死锁。
- 繁忙员工可能延后一个或多个分钟周期，不能保证固定一轮内完成；上线观察队列最早请求时间、`skipped_busy`、失败次数、cron 成功状态及新死锁。未改订单调度、成功率、佣金计算、提款规则、账本公式、索引、表、其他函数／触发器或任何历史金额，不关闭对账。
- 迁移只接受已审核的目标库正文与仓库原版正文，未知定义一律中止；通过 `pg_get_functiondef` 定点替换函数体而不是覆盖整函数。执行前须再次比对定义／元数据并保存原完整定义；回退只恢复经核对的原函数定义，不倒回资金数据、不重放业务。若函数已被其他人修改，停止而非覆盖。
- 上线后 2026-10-29 08:44（UTC+8）首轮订单结算和对账 cron 均成功，队列为 0、等待锁会话为 0；08:43:17–08:44:16 的初始日志窗口未见 ERROR／新死锁，仍需观察后续真实负载。部署管理接口因外层事务与 SQL 的显式 BEGIN／COMMIT 重叠，记录各一条 `25001`／`25P01` WARNING，已核对迁移记录和函数提交成功，不是业务任务错误，未为清除提示修改已部署迁移。
- 本地 `npm run test:wallet-deadlock` 在独立 Unix socket 临时 PostgreSQL 集群执行，不读取任何 Supabase URL／密钥；需要本机 PostgreSQL 的 initdb、pg_ctl、psql（优先 17，兼容 16／15），root 环境以 postgres 用户启动，结束后清除自己创建的集群。覆盖原死锁、队列／钱包／员工忙碌、跨员工锁环、失败记录竞态、提款冻结、收入、游标、回滚、重复执行、批量上限与权限。真实资金、线上并发和长期负载未用于测试。
- 经用户在部署确认中明确批准，本迁移已于 2026-10-29 08:43（UTC+8）部署至 APLF10，正式版本 `20261029004317 avoid_wallet_reconciliation_deadlocks`。线上函数体 MD5 `d9316355bee8a923e24086f09912f42b` 与本地已验证正文逐字一致；所有者／参数／SECURITY DEFINER／search_path／ACL 与部署前相同，其他 public/private 函数、触发器及 cron 配置指纹不变。部署后只读检查 74 个钱包，账本总额、冻结额、总收入、负余额及缺失基准异常均为 0；未手工调用线上资金函数。AAA 未部署，前端待用户发布；结构检查脚本仍以 AAA 为基线，不将其全局改成另一项目的目录。

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

## 迁移检测 SQL（`supabase/migration-check/`，只读）
用于把数据库复制/转移到另一个 Supabase 项目后确认新库是否正常。两份脚本都以 `set transaction read only` 开头，只查询不修改；在 Supabase SQL Editor 粘贴全文运行。
- `01_structure_health_check.sql`：内嵌旧正式库结构基线（2026-10-26 21:45 UTC 生成，609 项：表的字段/约束/索引/触发器/RLS 策略/表与字段权限/RLS 开关/所有者，函数内容与执行权限/所有者/SECURITY DEFINER，序列、视图、schema 权限、扩展版本与位置、anon/authenticated/authenticator 角色超时、存储桶设置、storage 策略与 `storage.objects` 上调用应用函数的触发器、Realtime 表、cron 任务、平台事件触发器、库编码/时区）。对比后按「失败/警告/提示/通过」输出，第一行为总结。另外实时检查：钱包账本公式、累计收入、冻结金额=待处理提款、负余额、员工钱包/登录凭据、启用中超管、订单状态、处理中订单/对账队列/自动通知队列积压、自动通知失败、全部外键孤儿记录、自增编号落后、索引有效、约束已验证、各 cron 任务最近成功运行与 1 小时内失败、bcrypt/SHA-256/UUID/pg_trgm 实际可用、各存储桶文件记录数、数据库中文件地址指向的项目。
- `02_data_fingerprint.sql`：逐表（public/private 全部表、`storage.buckets`、`storage.objects` 文件清单、`cron.job`）计算行数与内容指纹。先在旧库运行并复制第一行「说明」（`v1;` 开头），粘贴到新库脚本的两个 `$old$` 标记之间再运行，逐表显示一致/行数不同/内容不同/缺少；脚本内的「运行记录」清单（会话、队列、日志、派单运行记录、对账基准等）迁移后会继续变化，不计入核心结论。整体转移项目（项目 ID 不变）时无需使用。
- 重新生成结构基线：数据库结构有更新后，把 `01` 中两个 `$baseline$` 标记之间清空，在旧库运行，复制「当前结构指纹」那一格粘贴回去；并更新 `supabase/tests/migration-check.test.mjs` 中的对象数量断言。
- SQL 无法检查：Edge Function 是否部署、存储里的实际文件内容、项目 API/上传大小设置、前端环境变量；脚本结果把这些列为人工确认项。
- 复制数据库到新项目只会带上 `storage.objects` 文件记录，不带文件本身（GET 才能核对实际文件，不能只看 HEAD）。`03_copy_storage_files.html` 为**公告专用**独立工具（电脑版 Chrome/Edge 打开），每次只读取 `public.announcements.content` 的当前媒体链接，不缓存第一次的清单；03与04必须同时下载公告专用版，不能搭配旧版全站脚本。
  - 范围按「公告正文引用」判断，不按桶名判断：处理公告里的图片、视频、视频封面等；粘贴到公告的其他已知公开桶链接也处理。六个支持的公开媒体桶为 `announcement-images`、`template-images`、`chat-images`、`super-customer-avatars`、`verification-documents`、`website-icons`；非Supabase外链不会复制或改写。不读取其他业务表，不递归遍历未引用目录，不搬运同桶未被公告引用的文件、聊天／富卡／通知专用附件或私有稽核文件。其他内容缺图不阻断公告迁移；如果同一缺图也被公告引用，仍须处理，不能绕过。
  - 直接复制：分别填写来源、目标项目的 service_role / Secret key，合并两站当前公告引用后只读取相关文件记录，包含目标还没有对象记录的新文件；来源与目标方向以填写地址为准，可反向复制。授权读取失败时可无密钥回退已知公开桶的同项目公开端点；同来源正文公开地址失败时可回退授权读取。第三方Supabase公开媒体不发送密钥、不跟随重定向；密钥仅保留在页面内存，不写入备份。
  - 下载到电脑：只备份本项目当前公告引用的媒体（含跨站公开媒体），保存为 `files/<桶>/<原路径>`，v2 `storage-manifest.json` 带 `scope: announcements`、逐文件完成状态及SHA-256；重复运行核对同来源有效哈希并补新引用。失败条目不能借残留旧文件恢复；大视频按大小放宽超时。已存在备份中的其他文件不会被删除，但不进入新公告清单。
  - 从电脑上传：**先同步目标公告数据库记录**，再按目标当前公告引用与备份清单的交集处理；v1/v2旧全站备份可读取，但其中未被目标公告引用的文件、私有附件及手动放入的文件均不上传。没有目标公告时为0个文件，不会恢复整份旧备份；目标仍引用外站时，备份登记的原始来源必须与公告链接一致（无逐文件来源的旧备份核对项目来源），不能把其他项目同路径文件签为已迁移。备份没有成功下载的公告文件不能恢复，缺失／大小／哈希不符明确报错。
  - 逐文件按「桶＋路径」读取公告中的所有来源，比较完整文件SHA-256；同一路径来源字节完全相同才选用，任何来源缺失／不可读、来源间内容不同或与目标已有文件不同，都只阻断该文件且不覆盖。目标已有文件先与来源／本地备份核对；相同但缺少当前凭据时才重新上传同一内容补凭据。上传后完整GET并核对SHA-256，Storage metadata记录目标项目、大小、SHA-256及凭据版本3；需切换的引用必须读回匹配凭据才算完成。目标读取异常不能当作不存在后覆盖；只有明确不存在响应才进入新增上传。
  - HTTP400不一律代表文件丢失，日志保留实际端点、HTTP、Storage错误码与说明；明确NoSuchKey／Object not found仍需核实权限或文件备份。JSON检查报告带 `scope: announcements`，仅反映公告文件，不能视为全站迁移证明；包含问题路径及公告记录定位，不含密钥。界面分别显示目标原本已存在、当次复制／下载／上传成功、待处理和检查异常，避免把已存在文件误认为本次传输；只有实际执行失败才称相应操作失败。待处理／异常／失败／停止时不要运行04，不自动生成缺失白名单。
  - 03与04使用相同Markdown图片／链接及CSS `url()` 包装括号规则；不能把结尾分隔符`)`当作文件路径，文件名的真实成对括号、引号中字面`)`与`%29`保留。同桶同路径的不同来源按实际文件SHA-256核对，不再因URL域名不同直接中止；字节一致才继续，内容不一致或任一来源无法核实则显示来源URL、公告ID与哈希诊断，阻断该文件且不覆盖。
- 工具只搬公告媒体文件，不复制公告正文或其他数据库记录。后续新增公告须先同步记录，再重跑03和04；公告文件备份不能代替数据库备份，也不再提供全站文件备份能力。
- `04_switch_storage_origin.sql` 同为**公告专用**：在目标项目填写【填写这里】地址，仅扫描、更新并检查 `public.announcements.content`，支持多来源、后续新增引用和编码文件名。只改Storage URL前缀，不改公告标题、聊天、富卡内容及哈希、通知、头像、实名、范本、配置或私有历史证据；不再因其他字段旧地址／缺图阻断，也不关闭、开启或修改任何触发器，现有媒体删除保护保持原状。
- 04按唯一的「桶＋路径」核对目标对象，不把多条来源URL误算成多个文件；每个来源域名仍会被逐一替换并纳入可信来源记录。要求目标对象具有03版本3凭据，且凭据中的目标、对象大小与SHA-256格式均匹配；缺失／未复制／错误凭据默认整体回滚。SQL本身无法读取Storage对象字节，SHA-256由03实际读回校验后写入，04只核对其凭据，运行后仍须用03复检。旧文件无凭据时先重跑03核对内容后补齐；仅人工核实原站已缺失且目标无对象记录时才可填写 `v_allow_missing`，目标仍有残留记录则阻断，不删记录或伪造凭据。公告中的临时签名URL仍拒绝切换，真正缺失的公告媒体仍需恢复或另行确认处置。
- 04只补入目标 `private.content_audit_storage_origins`，**保留全部旧可信来源**，不扫描全库历史用途、不删除旧来源，以免破坏未迁移的聊天及稽核文件保护；新站其他模块所需的 `content-audit` 部署仍按原系统要求，不由此工具完成。
- 04必须运行全文并查看最后结果表：完成、完成（有警告）、无需切换或未通过（已撤销），并明确「仅公告正文／其他内容与触发器未改动」。核对公告字段「原有目标地址数+本次切换数=切换后目标地址数」及公告正文旧地址残留；数量、权限、约束或保护异常时撤销本次公告与新增可信来源修改，保留具体原因、阶段、SQLSTATE和下一步，不保留虚假已修改明细。普通错误由子事务回滚后输出；断线、取消、语法等无法进入结果表的错误也不算成功。结果不创建永久审计表或改表结构。
- SQL不能验证实际对象字节，结果仍提示「实际文件可读性：需03复检」；运行04前完成03，运行后用03只检查并在网站抽查公告图片／视频。未通过时按原因处理再重跑完整脚本，不能单独执行UPDATE；切勿在来源库误运行。
- 测试：`npm run test:migration-check`，保留01/02的结构、指纹、财务、权限与健康回归；03覆盖公告引用范围、同桶孤儿与11条富卡缺图排除、跨桶／跨站公告图片视频封面、逐文件多来源相同／冲突／缺失、复制／检查／下载／v1/v2恢复、实时增量、SHA-256凭据、重试、停止和路径安全；04在PGlite真实迁移回放库验证只公告变化、其他业务与富卡哈希不变、旧可信来源／触发器状态不变、缺图／错误凭据／权限／保护／静默跳过UPDATE均回滚、多来源同路径按唯一对象计数、编码／Markdown与重复运行。
