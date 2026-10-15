# 管理员后台

入口：`src/components/admin/AdminDashboard.tsx`。权限按 `admin.role` 判断。

## 导航（代码默认值）
| 显示文字 | tab id | 组件 | 谁可见 |
|---|---|---|---|
| 員工詳情數據 | `employees` | `EmployeeManagement` | 超管、二级（默认页） |
| 員工搜尋 | `employeesearch` | `EmployeeSearch` | 超管、二级 |
| 登入紀錄 | `loginhistory` | `EmployeeLoginHistory` | 超管、二级 |
| 已鎖定 | `accountlocks` | `AccountLockManagement` | 超管、二级；`emergency_admin` 只有此页 |
| 通知 | `messages` | `MessageManagement` | 超管、二级 |
| 公告 | `announcements` | `AnnouncementManagement` | 超管、二级 |
| 模擬客戶 | `customerservice` | `CustomerServiceManagement` | 超管、二级 |
| 經理 | `cccservice` | `CccServiceManagement` | 超管、二级 |
| 訂單指派 | `dispatch` | `DispatchManagement` | 超管、二级（二级大多只读） |
| 提款 | `withdrawals` | `WithdrawalReview` | 超管、二级 |
| 身份驗證 | `verifications` | `VerificationReview` | 超管、二级 |
| 設定 | `config` | `SystemConfiguration`：超管进 `AdminGroupConfiguration`，二级进 `SecondaryAdminConfiguration` | 超管、二级 |
| 產品目錄 | `products` | `ProductTypeManagement` | 仅超管 |
| 交單數據 | `validdata` | `ValidOrderDataManagement` | 仅超管 |
| 管理員 | `admins` | `AdminManagement` | 仅超管 |
| 歷史資料 | `history` | `HistoryDataManagement`（含隐藏稽核入口） | 仅超管 |

- 超管可在「導航設定」修改文字与顺序：存于 `system_configs` 的 `admin_navigation_preferences`（RPC `admin_save_shared_system_config`）和 localStorage。代码中有旧标签映射 `previousDefaultNavigationLabels`、`legacyNavigationLabelTranslations`，改默认文字时要一起更新，否则旧的自定义值可能盖过新默认值。
- `AdminTabId` 类型里有 `records`，但没有挂载任何页面。
- 未读数、锁定数靠 Realtime + 页面可见性回调 + 定时刷新；空闲时预取聊天工作区摘要。
- 会话失效：部分财务 RPC 失败时调用 `logout(false)`；没有统一的全局会话监听。

## 数据范围规则
- 二级管理员只能看、管自己名下的员工（`users.created_by = admin.id`）；超管看全部，可按管理员分组切换。
- 例外：「員工搜尋」(`search_all_employees_for_admin`) 允许超管和二级跨组精确搜索（排除 emergency 组），不能假设结果只属于本人。
- 各列表都排除 `emergency_admin` 和已归档（已删）的员工。

## 各页面
### 員工詳情數據 `EmployeeManagement.tsx`
- 加载：`get_employee_management_snapshot`（排除已归档员工）、`get_notification_automation_plan_assignments`、`get_withdrawals_for_admin`。加载途中若有实时变动或页面重新初始化，这次结果会作废并排队重载；首次加载作废时继续显示载入状态，不会先闪出「找不到員工」。
- 建立：`admin_create_employee_account_with_automation_plan`（用户名、密码 ≥6 位、员工 ID、派单组、可选自动化方案）。二级建立的员工 `created_by` 是自己，超管可选目标管理员。
- 编辑：`admin_update_employee_account`（用户名、员工 ID、备注、标签、启停、验证、置顶、注册时间）；自动化方案用 `set_notification_automation_plan_for_employee`；重设密码 `admin_reset_employee_password`（旧会话随即失效）。
- 删除：先走 `archive_employee_without_media` 快速路径；需要留证或返回 evidence changed 时，改走 `mutateAuditedContent('employee_delete', [id])`。删除后员工进入「已刪員工紀錄」（见 `docs/content-audit.md`）。
- 钱包调整：`admin_adjust_wallet_balance_atomic`（正负金额表示增减、必填备注、`createFinancialOperationId()`；失败重试沿用同一编号）。
- 详情弹窗 `EmployeeDetailModal.tsx`：`get_employee_detail_summary_for_admin`、`get_employee_transaction_page_for_admin`（每页 100）、`get_employee_transaction_date_counts_for_admin`、`get_employee_withdrawal_page_for_admin`（每页 10）。
- `EmployeeMetadataPopover.tsx`：只读的标签/备注弹层。

### 員工搜尋 `EmployeeSearch.tsx`
- `search_all_employees_for_admin`：按用户名、员工 ID、已批准验证资料精确匹配，`p_limit: 100`。

### 登入紀錄 `EmployeeLoginHistory.tsx`
- `get_employee_login_summary`、`get_employee_login_history_with_device_info`（上限 10,000）；Realtime `employee_login_history_events`；每 30 秒静默刷新。`LoginDeviceSummary.tsx` 显示设备信息。

### 已鎖定 `AccountLockManagement.tsx`
- `get_account_locks_for_admin`、`get_account_lock_history_for_admin`（缺失时降级为只看当前锁定）；解锁 `unlock_account_with_permission_check`；Realtime `account_lock_events` + 每 60 秒刷新。

### 管理員 `AdminManagement.tsx`（仅超管）
- `admin_create_secondary_account`（新账号的 `parent_id` = 当前超管）、`admin_update_secondary_account`（用户名、可选密码）、`admin_update_admin_account`（启停）。
- 删除走 `mutateAuditedContent('admin_delete', [id])`，其名下员工一并进入「已刪員工紀錄」。

### 設定
- `AdminGroupConfiguration.tsx`（超管）：管理各管理员 `admin_configs` 的 `company_name`、`currency_unit`、`branding_mode`；登录页标题与副标题存于 `system_configs`。这里是品牌设置，不是员工分组。
- `SecondaryAdminConfiguration.tsx`（二级）：只改自己的品牌配置（全局/自定义），登录文案只读。

### 提款 `WithdrawalReview.tsx`
- `get_withdrawal_review_data`：超管看全部，二级只看自己的员工。
- 审核 `review_withdrawal_atomic`：只处理 pending；批准扣除冻结余额，拒绝退回可用余额。
- 更正历史状态 `correct_withdrawal_status_atomic`：会取消该员工其他 pending 提现并校正钱包。
- 两者都要会话 token + 操作编号，备注必填。Realtime `withdrawal_events`。

### 身份驗證 `VerificationReview.tsx`
- 直接读写 `verification_requests`；拒绝时备注必填；批准时另调 `admin_update_employee_account` 设置 `is_verified=true`；重置已批准的申请会设回 false。Realtime 监听申请、用户、钱包。
- 证件图片来自 `verification-documents` 存储桶（公开桶）。

### 訂單指派 `DispatchManagement.tsx`
- 表：`dispatch_groups`、`dispatch_order_pools`、`dispatch_group_members`、`dispatch_group_orders`、`users`；前四张表变化时由 Realtime 触发防抖刷新。
- 超管：管理分组、订单池、订单与导入（每批 250 条；失败时保留未确认内容，先刷新核对再重试，避免重复导入）。写入 RPC：`admin_save_dispatch_group`、`admin_save_dispatch_pool`、`admin_manage_dispatch_orders` 及概率设置。加权池的概率合计必须为 100%；已归档的分组/池不可再管理。
- 二级：只读；可把自己的员工移到启用中的分组（`admin_assign_dispatch_group_member`，最多 5 个并发，失败项会回滚）。
- 员工端派单流程见 `docs/employee-portal.md`。

### 產品目錄 `ProductTypeManagement.tsx`（仅超管）
- `product_types`；「删除」实际是设 `is_active=false`（保留历史订单关联）；同名的停用产品可重新启用；排序用 `reorder_product_types`（带 token）；有未保存离页提醒。

### 交單數據 `ValidOrderDataManagement.tsx`（仅超管）
- `valid_order_data`：单条/批量新增（每批 1000 条，上限 500,000 条，超出时清理最旧的）、启停、删除；全部删除超过 5,000 条时用 `batch_delete_valid_order_data`。员工提交订单时用它校验（见员工端文档）。

### 歷史資料 `HistoryDataManagement.tsx`（仅超管）
- 管理 16 张表、4 类（operational / audit / performance / archive）的保留天数与清理排程：`history_cleanup_summary`、`admin_get_history_cleanup_schedule`、`admin_save_history_cleanup_schedule`（时间为 **UTC** `HH:MM`，保留天数不得少于每张表的下限）；手动清理先 `admin_preview_history_cleanup` 再 `admin_execute_history_cleanup`。
- 自动执行：pg_cron 每分钟调用 `auto_cleanup_due_history_data()`，每次处理一张到期的表；单表每天最多成功一次，失败最多重试 3 次。
- 「工作會話記錄」（`work_sessions`）的保留天数决定通知自动化「工作天数」类条件能往回算多少天，必须大于最大的工作天数目标；2026-10-09 起为 400 天（见 `docs/notifications.md`）。
- 内容稽核与已删员工的资料**不在**这 16 类中，不会被自动清理。
- 隐藏入口：标题「歷史資料管理」左侧的数据库图示，1.1 秒内连点三次 → 内容稽核面板（见 `docs/content-audit.md`）。

## 未接入的旧组件（改了不会生效）
- `DispatchRecords.tsx`（员工派单统计）、`SubmitTimeManagement.tsx`（提交时间设置，直接写表）、`AutoCleanupSettings.tsx` + `src/services/autoCleanupService.ts`（旧的自动清理，使用 `system_configs.auto_cleanup_*`）。要重新启用前先和用户确认用途。
