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
| 資料遷移 | `datamigration` | `EmployeeDataMigration`（本地验证版） | 仅超管，未部署 |

- 超管可在「導航設定」修改文字与顺序：存于 `system_configs` 的 `admin_navigation_preferences`（RPC `admin_save_shared_system_config`）和 localStorage。代码中有旧标签映射 `previousDefaultNavigationLabels`、`legacyNavigationLabelTranslations`，改默认文字时要一起更新，否则旧的自定义值可能盖过新默认值。
- `AdminTabId` 类型里有 `records`，但没有挂载任何页面。
- 未读数、锁定数靠 Realtime + 页面可见性回调 + 定时刷新；空闲时预取聊天工作区摘要。
- 会话失效：部分财务 RPC 失败时调用 `logout(false)`；没有统一的全局会话监听。

## 数据范围规则
- 二级管理员只能看、管自己名下的员工（`users.created_by = admin.id`）；超管看全部，可按管理员分组切换。
- 例外：「員工搜尋」(`search_all_employees_for_admin`) 允许超管和二级跨组精确搜索（排除 emergency 组），不能假设结果只属于本人。
- 各列表都排除 `emergency_admin` 和已归档（已删）的员工。

## 各页面
### 資料遷移 `EmployeeDataMigration.tsx`（本地验证版，未部署）
- 导航和组件渲染双重超管门禁；懒加载，切换后台页保留任务，失去超管角色立即卸载。验证版入口固定末尾、不参与共享导航重命名/排序；读取旧偏好时也剔除此键，避免既有数据库白名单拒绝其他导航保存。三个页签为「導出」「導入」「紀錄」。
- 后端先调用 SQL40 能力接口；未部署或无法确认则禁止导出。十领域按同包串行导出，各自正常关闭，逐卷实际写盘、独立认证回读，最终检查 SQL41 开始/结束目录和全部密文，再保存加密索引，共11个 `.edx`。默认处理已实现的全部领域，不提供任意跳过财务等关键类别。SQL56冻结来源时，截止凭据随快照进入加密索引，reader严格重算PG摘要并绑定站点；不是远程签名或新站营业许可。日常备份保持只读、不自动停站，冻结也不自动开始导出。
- 浏览器需支持目录选择和 OPFS，建议桌面 Chrome/Edge。真实行数/文件数/字节/阶段进度；仅在领域边界暂停。取消不等于服务端任务已取消或业务回滚，必须保留现有文件。浏览器离页提醒与屏幕常亮仅尽力而为。
- 「導入」先在本机认证完整11文件及记录/附件引用，此按钮不调用数据库或上传；`importReady/fullSiteComplete=false`。缺卷、混包、篡改和有引用无附件均拒绝。其下独立的「查詢目標准入（只讀）」验证SQL55 v3空站条件及总核对接口存在性；未本机核验、同站、任务/维护残留、目标业务或接口缺失时不能开始。换输入清除目标准入及密码，不把本机通过当恢复营业。
- 「紀錄」是阶段事件，不是整站完成。可用当前超管密码及固定确认语「確認停止導出任務」显式停止本人未结束的导出；不停止导入、不删业务或保存文件、不解除维护，未知结果先重新查核而非自动重试。
- SQL43已排除公告内容、分类及轮播设置；旧包若含轮播键会拒绝，不能静默丢键后继续。
- `EmployeeSiteImport` 已接真实 `siteImport/siteRestoreApi`：独立新备份目录、重新输入源口令和当前超管密码、固定确认语「確認導入員工資料」及隔离空站风险勾选后，才调用维护态导入；内部再次认证全部输入和查询准入。逐阶段显示服务端计划并重新勾选批准，聊天歧义手选、合并可见性可单独拒绝，最终计划显示差集人数。模态通过body portal显示，父页隐藏仍可处理；键盘焦点循环与Escape拒绝。
- 真正写入会先保存/回读认证/封存五份独立配置或记录备份，最后十域核验；不把这些文件当完整员工备份。显示真实领域/阶段/计数，支持领域边界暂停和停止后续操作；停止不取消服务端任务/回滚，第一次尝试即锁定再次开始，不提供伪续接。输入/密码不进localStorage，结束清空密码；本地`site-import-report.json`仅含站/包/任务/进度及维护态结果，另保存完整脱敏 `serverVerification` 回执；结果页显示服务端总核对摘要、员工数、待处理提款笔数和原字符串金额。报告保存失败另提示，不能据此重跑。
- 完成仍是账号停用、自动化暂停及dirty维护状态，不是营业放行；同名员工/UUID/员工号冲突继续阻断，不调用封存、删除或激活。前置配置进入维护后和结束时各复核一次；随后SQL55在同一锁定事务重验十域实物、最终媒体回执和五份备份密文哈希。服务端总核对不等于营业放行；新同名自动备份后彻底删除规则已确认，但迁移专用删除尚未实现，当前空站入口不因此开放覆盖。数据库协议准入不等于Edge/Storage已可用，勿在正式营业站演练。
- 本地Chromium与WebKit隔离替身22个交互场景通过（TAP含两父组24项）；WebKit允许写入路径注入桌面UA/目录替身，原生不支持路径另测。包含375px、焦点、切页审批、取消/响应丢失/目录拒绝/报告失败；没有真实登录、Supabase Storage/CORS或原生目录选择器验收。
- 已知阻断：完整员工备份恢复/同名专用彻底替换、自动化续接及最终放行、可恢复的跨会话续接未完成；迁入档案仍阻断统一导出；共享头像/图标实际文件未纳入、部分旧头像值不支持。当前按领域分卷、单领域1GiB/3000媒体，不是150MB自动分卷。不得正式迁移。

### 舊站停站切換 `SourceCutoverPanel.tsx`（第55节，2026-10-22 UTC+8，本地未部署）
- 位于「資料遷移 → 導出」，仅超管操作；采用停站切换，不做在线增量或搬运行队列。先由现有worker排空待发自动化，面板显示「待處理自動化佇列」「自動化失敗紀錄」「處理中訂單」，三项全零、无其他任务/维护阻断才可提交。非零时先处理再刷新，面板不代发、删队列/失败或代处理订单；未知数量不补零，旧结果明确为上次确认。
- 当前超管密码及精确确认语「確認暫停舊站業務並導出」建立持久source维护，账号/自动化原启停、进度/基线/activated_at/资金不改。source冻结是finished terminal技术任务，不占单活任务，之后十域导出可正常执行；freeze不算最近成功导出，getlog保留旧子协议排除。
- 导出完成、失败、取消、离开或过期都不自动恢复旧站。本人超管须带当前cutoff_id、密码及「確認恢復舊站業務並放棄切站」显式恢复，running export未结束时阻断；不能解除其他维护或dirty import。恢复旧站即放弃本次切站，不能用旧切站文件启用新站，不能两站同时营业；若新站已营业，须先停下并核对切站后变动，不能直接恢复旧站。
- 写入及状态读均不自动重试；丢响应/取消结果未知时模块级互锁保留，writeGeneration拒绝交错写入后迟到的旧status。父页全部导入/导出/本机核验/独立员工备份及停止入口与source在途/未知操作双向互锁，不靠切页重新挂载解锁；「刷新狀態」仍可显式核对，只有写结束后新发起且严格验证成功的状态读才解除未知。
- source屏障只冻结受保护DB写，不代表停Storage/cron或原子跨DB文件快照；无新表、不改guard/cron/Storage/Edge。新站账号仍停用、自动化暂停、dirty import维护保留，最终续接/账号启用/营业放行、同名彻底替换及其他原pending未完成。
- 现有证据：新DB25/25、client74/74，Chromium/WebKit各25交互场景（含父组TAP52）通过；SQL56十域11磁文维护态整站61项按3+14+9+6+29互斥组通过（原60+新frozen往返/合法重加密摘要篡改拒绝）。583份SQL仍12原历史失败、109表967列不变；主会话最终foundation/scope100/100、client74/74加双浏览器各25场景合计TAP126/126、旧导入UI28/28、旧员工双文件备份UI110/110、transport security13/13、typecheck/lint/build及聊天6/稽核48/工时6通过；整站61项为实现agent完整覆盖，主会话另复跑的重叠项不加总。两轮复审修补已完成，最终独立复审无新增高置信问题，详见计划第55节。仅本地隔离测试，非正式登录/真实Storage/CORS/原生PG/容量或正式切站验收，未跑整个employee-transfer总套件；本轮实际新增SQL56/API/面板并改父页，无正式访问或SQL/Edge/Storage/权限/config/cron/前端部署。

### 導入前獨立員工記錄與附件備份 `EmployeeSafetyBackupPanel.tsx`（本地未部署）
- 位于「資料遷移 → 導入」，不要求先选择来源包，也不依赖空站导入已开始。按新站员工完整用户名精确绑定，大小写敏感、首尾空白拒绝；这是逐员工安全工具，不是改变全站默认全部导出的范围。
- 需当前超管密码、两次至少14字元的独立加密口令、新目录及范围确认。需SQL46、SQL47及附件Edge服务；同一任务内先保存并认证48类记录，再按原文引用下载附件、独立加密保存/认证，随后成对回读两个.edx并清理全部临时明文，最后复核来源附件与记录才显式close。两文件用同一口令，但独立export/volume身份，必须一起保留；零附件也产生已核验的独立附件目录卷。显示记录/附件/成对/来源/close阶段、真实行/引用/字节与各卷SHA-256，不推算百分比或显示原文。
- 成功与失败均尽力保存employee-backup-report.json（v2、employee-safety-pair-v1），仅白名单技术ID/数量/摘要/UTC时间、不完整标志及两份独立文件回执/状态、pairVerified和taskCloseConfirmed；不含用户名/口令/令牌/记录/附件路径或不透明媒体身份。记录包仍为v1、records_only:true/media_included:false，报告mediaIncluded只在成对核验及清理成功后为true，不代表完整恢复或源最终核验/close必然成功。报告等待有独立取消按钮，取消/失败不撤销已核验文件或已确认的任务结束，不为报告重跑备份。
- 操作中或结果未知时，父页其他导出/导入与停止其他协议入口互锁，切页不卸载；已知任务ID只停止该任务，开始回执丢失时可用密码和「確認停止員工備份任務」处理本人当前SQL46任务，不影响其他协议/管理员或维护。未知停止结果同样禁止新备份；停止不会自动重跑，已尝试备份需明确准备新目录。
- 附件失败、文件篡改、成对认证/清理失败或最终源复核失败均不close；已核验记录保留独立回执，不冒充附件/完整备份成功。取消/卸载不自动stop/close/删文件，丢响应保持未知互锁，报告停止等待后仍可显式处理本人任务。**完整恢复、UUID关联及封存/覆盖许可仍未完成。** 原SQL45空站准入与现有封存留证不变，不能据此在有业务站导入。Chromium/WebKit各54个独立场景、含两父组110项；主线程分引擎互斥复跑各55项通过，旧向导24/24通过。真实组件/SQL46与47客户端/AES/ZIP/成对reader，RPC/Edge传输/目录/工作区为替身、外网0；不代表真实Storage、原生picker或正式登录验收，详见计划第45节。

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
- 本地新增第三页签「遷入檔案」（未部署）：按来源站/包查看已核验的六类只读快照，历史身份不关联新站活账号；已核验附件按需授权加载，不打开旧URL。分页错误保留确认页并提供重试，时间UTC+8；原「內容稽核／刪除員工」工作流保留。这不是完整「資料遷移」向导。

## 未接入的旧组件（改了不会生效）
- `DispatchRecords.tsx`（员工派单统计）、`SubmitTimeManagement.tsx`（提交时间设置，直接写表）、`AutoCleanupSettings.tsx` + `src/services/autoCleanupService.ts`（旧的自动清理，使用 `system_configs.auto_cleanup_*`）。要重新启用前先和用户确认用途。
