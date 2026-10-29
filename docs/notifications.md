# 通知、通知自动化与公告

## 后台发送 `MessageManagement.tsx`（导航「通知」）
- 收件人面板：二级只看到自己的员工；可按启用/已验证、姓名或员工 ID 筛选；多个标签之间是 **OR** 条件；已勾选的员工排到列表最前面；改变筛选不会取消已勾选。
- 发送：`send_admin_message_with_delivery`，参数含 `delivery_mode`（`realtime_only` / `login_only` / `realtime_with_login_fallback`）、优先级、可选奖金和 `operation_id`。内容相同的请求复用同一个操作编号，避免重复发奖。
- 正文长度（后端已部署，前端补充检查待上线）：迁移 `20261103000003_remove_rich_content_length_limits.sql` 取消发送5000字、通知表／稽核编辑100000字及自动通知任务正文模板5000字上限，保留原非空与NULL规则；标题仍限200字。前端发送／编辑另用Tiptap的 `isEmpty` 拒绝只有空段落格式的文档，图片／视频等合法内容不因此被当作空正文。HTML净化、图片／视频上传安全限制、权限、留证、奖金及操作编号均不变；没有业务字数上限不等于浏览器、数据库与网关容量无限。经用户确认，迁移已于2026-10-26（UTC+8）部署到正式AAA库，版本 `20261025205517 remove_rich_content_length_limits`；现有通知页无需等待前端发布即可解除原5000字发送错误，公告500KB检查移除及前端空文档补充检查仍需发布新版前端。
- 优先级配色（2026-10-15，员工端与管理端统一）：普通 = 蓝色，重要 = 绿色，紧急 = 红色（沿用），绩效奖励 = 琥珀色（沿用）。员工端在 `MessageCenter.tsx`（消息卡片、优先级标签）与 `EmployeeDashboard.tsx`（铃铛弹出卡片的优先级胶囊）；管理端在 `MessageManagement.tsx` 的优先级选择按钮、消息列表标签和消息详情里的优先级卡片。
- 奖金：`send_admin_message_secure` 在同一事务内为每位收件人调用 `private.credit_performance_bonus`：写一笔 `wallet_transactions(type='performance_bonus')`，`wallets.available_balance` 与 `users.total_income` 同步增加，并由触发器记入 `wallet_ledger_entries`、排入钱包对账；任何一步失败整笔回滚。总额 = 金额 × 收件人数。前端金额没有上限、不四舍五入（确认框会显示人均与总额）。永久删除员工时，其奖金流水与自动执行记录一并清除。
- 范本：`message_templates`（列表按 `admin_id` 筛选），可载入、套用、新增、修改、删除。下拉菜单与范本编辑器中的删除按钮均先弹出具名确认框，默认焦点为「取消」，支持Escape与键盘焦点循环；确认后按范本ID及当前管理员ID删除数据库记录，并要求返回准确的一条范本ID才显示成功。处理中禁用操作并防重复提交；错误或未返回已删记录时保留弹窗、显示原因，不假报成功。成功后立即移除列表项，若正编辑该范本则清空范本编辑表单，其他范本编辑及已经套用到发送框的内容不变；延迟返回的列表只过滤已删除ID，既不复活已删项，也不丢弃其他刚保存的更新。
- 删除通知范本只移除 `message_templates` 记录，不删除已发送的 `messages`／收件关系，不自动清理Storage图片或视频（可能被其他通知、公告等共享引用）；弹窗明确说明保留范围，不能把范本删除成功当作附件已彻底清理。这与聊天快捷回复 `cs_message_templates` 的稽核删除流程不同，本次不改变数据库权限或新增后台清理能力。
- 已读显示：汇总 `message_recipients.is_read` / `read_at`。筛选「已讀」= 有收件人且全部已读；「未讀」包含部分已读。
- 修改/删除：只允许管理员手动发送的通知，经 `mutateAuditedContent('notification_edit' | 'notification_delete')` 留证；系统自动通知在界面上不能编辑或勾选删除。

## 通知来源 `messages.audit_origin`
| 值 | 含义 |
|---|---|
| `manual_admin` | 管理员手动发送（包括套用范本后再发送） |
| `automation` | 自动化任务发送（`automation_execution_id` 不为空） |
| `unverified` | 旧通知或无法证明来源，界面显示「舊通知 · 來源待核實」 |

- 稽核只针对管理员手动通知的修改与删除；自动通知不留证（迁移 `20261002000000_protect_manual_notifications_and_service_chats.sql`）。

## 员工端已读规则
- 打开某条通知的详情才算已读；点击弹出卡片看到详情算已读；登录弹窗显示即算已读；只看列表不算。细节见 `docs/employee-portal.md`「通知与公告」。

## 删除员工时的通知处理
- 先封存员工；其手动/待核实通知的快照进入「已刪員工紀錄」的通知档案，然后移除该员工的收件关系。
- 多人通知保留，只去掉这名员工；只发给他一个人的通知会被删除。自动化通知不进入档案。
- 迁移：`20261008000000_audit_deleted_employee_accounts.sql`、`20261025000001_remove_deleted_employee_notifications.sql`。

## 通知自动化 `NotificationAutomation.tsx`
> 2026-10-09 起正式库使用下列「执行」「锁」「判定」「错误」描述的流程（迁移 `20261101000000_scale_notification_automation_processing.sql`，正式库版本 `20261009104010`）。之前的旧流程：pg_cron 调用 `process_notification_automation_queue_fast(200)` / `process_notification_automation_queue(200)`，一批最多 200 人在同一个事务里并独占锁；员工登录时要等这把锁；同一员工任一任务失败会回滚他本次所有任务，错误只记在 `notification_automation_queue.last_error`；启用任务/恢复方案/加成员时当场逐个员工计算基线。两种流程的发送规则（何时达标、不补发、只发一次）相同。

- 方案（plan）状态：active / paused / archived；任务（task）状态：draft / active / paused。二级只能管理自己的；超管可切换管理员组。「員工詳情數據」的「編輯員工」可直接预选、更换或移除该员工的方案，储存共用 `set_notification_automation_plan_for_employee` 与原成员关系，返回自动化页会重新加载名单，无须重复勾选；原暂停／封存方案不改动时保留，候选仅列员工所属管理员的启用方案。
- 管理员之间的隔离（服务端强制）：员工只能加入建立他的管理员（`users.created_by`）的方案，且同时只能在一个方案（`notification_automation_plan_members` 的 `UNIQUE(user_id)`）；方案任务只发给任务所属管理员名下的方案成员，超管的任务也一样；新任务必须属于方案。另有约束 `notification_automation_active_tasks_require_plan`：启用中的任务必须属于方案且不是共享模板；`automation_task_applies_to_user` 不再放行未分组任务。`resolve_notification_automation_owner` 让二级只能操作自己的分组，超管可以操作任何分组，但改动仍归属该分组。
- 触发条件：累计订单、每日订单、工作天数、佣金、连续工作日、年度日期、首次登录；可设一次性达标或循环。编辑任务会重置为草稿并清除进度；方案内任务的收件人是方案成员。
- RPC：`get_notification_automation_dashboard_v2`、`get_notification_automation_executions_v2`、`save_notification_automation_task_v2`、`set_notification_automation_task_status_v2`、`set_notification_automation_plan_for_employee`、`get_notification_automation_plan_assignments`、`get_notification_automation_failures`。以下旧 RPC 已撤销浏览器调用权限：`save_notification_automation_task`、`save_notification_automation_task_with_delivery`、`save_notification_automation_task_copy`、`save_notification_automation_task_copy_with_delivery`、`copy_shared_notification_automation_task`、`copy_shared_notification_automation_task_with_delivery`、`set_notification_automation_task_status`、`get_notification_automation_dashboard`、`process_notification_automation_queue`、`process_notification_automation_queue_fast`（前端都未调用）。
- 执行：订单状态变化、佣金交易、工作会话结束、员工登录等触发器把员工写入 `notification_automation_queue`（每人一行，保留最早的排队时间）。pg_cron 每 5 秒与每分钟各调用 procedure `private.run_notification_automation_queue(200, …)`（每分钟那次另安排年度日期任务）：逐个员工处理并立即提交，每次最多 200 人或约 4 秒，队列为空时约 5 毫秒就结束。员工登录时若没有设定变更在进行，当场处理该员工；有则不等待，留给队列处理。执行时建立执行记录、`messages`（`audit_origin='automation'`）、`message_recipients`；有奖金的任务同时调用 `credit_performance_bonus` 入账，并以 `actor_type='system'` 记入 `financial_operations`。
- 锁：设定类操作（保存/启停任务与方案、改成员、删除员工或管理员等）取独占 advisory lock（`acquire_notification_automation_configuration_lock`）；评估取共享锁（`acquire_notification_automation_evaluation_lock`），多个评估可并行。队列 worker 先取共享锁再领取队列行（`FOR UPDATE SKIP LOCKED`），所以设定变更期间员工登录不会被卡住。
- 判定 `private.evaluate_notification_automation_tasks`：只评估「启用中的方案 + 启用中的任务 + 该方案成员 + 员工属于任务所属管理员」。员工第一次被某任务评估时，以「任务启用、任务开始时间、方案启用或恢复（`notification_automation_plans.activated_at`）、加入方案」中最晚的时间点计算基线，**之前已达成的目标不补发**（暂停期间的成绩恢复后也不补发）；同一任务版本 + 员工 + 周期 + 阶段只发一次（唯一约束）。启用任务、恢复方案、批量加入成员时只清除相关进度，基线在首次评估时补算；单个员工改方案（`set_notification_automation_plan_for_employee`）和建账号时指定方案仍当场记录基线。「每天」类条件按 UTC 日期计算（北京时间 08:00 换日）；员工在前一天排队、跨日才处理时，先按排队当天结束时补判每日与年度条件（最多回补 7 天）。
- 错误：每个任务各自在子事务中执行，执行记录、通知、收件记录、奖金一起成功或一起回滚；某任务失败不影响同一员工的其他任务。失败写入 `notification_automation_failures`（任务 + 员工 + 次数 + 原因，浏览器不能直接读写），员工留在队列，每次失败多等 5 秒、最长 300 秒后重试，成功后自动清除。自动化页任务列表上方显示可展开的「有 N 筆自動通知發送失敗，系統會自動重試」面板（`get_notification_automation_failures`，验证管理员会话并按分组隔离，最多 200 条）；没有失败时不显示。
- 订单统计索引 `idx_orders_user_completed_processed_at`（`orders(user_id, processed_at)`，只含 `success` / `failure`），用于累计与每日订单判定。
- 工作天数类条件（`work_days`、`consecutive_work_days`）按 `work_sessions` 与订单同日计算，`work_sessions` 受「歷史資料」保留期影响：累计工作天数只算保留期内的天数，目标超过保留期的任务永远不会触发。保留期 2026-10-09 由 90 天改为 400 天（`20261031000001_extend_work_session_history_retention.sql`）；之前已被清理的记录无法恢复，正式库最早的工作记录是 2026-08-27。新建工作天数任务时，目标要小于这个保留期。
- 自动通知的已读状态在「通知」页（自动筛选）查看；自动化页只显示执行记录。
- 旧「共享任务」（`is_shared_template=true`）：早期给二级管理员复制用的模板。迁移 `20260920126000_execute_enabled_shared_notification_tasks.sql` 让启用中的模板也会执行，但 v2 后台只列出 `is_shared_template=false` 的任务，也不能复制或管理模板。2026-10-09 先暂停了会造成重复祝贺的「46」「654」（`20261031000000_pause_hidden_shared_notification_tasks.sql`），随后按用户要求删除全部 4 个模板及其进度记录（`20261031000002_delete_hidden_shared_notification_tasks.sql`）；正式库已没有共享模板。表结构和旧的复制/保存 RPC 仍在，前端不再调用。
- 未分组任务（`plan_id IS NULL`）：方案改版前建立的旧任务。新版页面在电脑版左侧只列方案，没有「未分組任務」入口（只有手机版下拉选单可选），新建任务也必须属于方案。bb 名下两条「654」（从旧模板复制，一条启用、一条草稿）因此在电脑版看不到，2026-10-09 按用户要求删除（`20261031000003_delete_legacy_ungrouped_notification_tasks.sql`）；正式库已没有未分组任务。如果以后又出现这类任务，需要先给电脑版补上入口。
- 迁移：`20260918231458_create_notification_automation_system.sql`、`20260922001942_harden_all_notification_automation_triggers.sql`、`20260922185616_accelerate_notification_automation_queue.sql`、`20261101000000_scale_notification_automation_processing.sql`。

## 公告 `AnnouncementManagement.tsx` + `TiptapEditor.tsx`
- 表 `announcements`，直接表操作（不经稽核）。二级只管理自己的公告；超管可管理全部，并设置全局公告与轮播。支持发布时间、隐藏、置顶排序；已移除前端正文500KB保存检查，数据库正文原本没有字数上限，前端待用户部署。媒体处理及上传安全限制不变。
- 媒体存储桶：编辑器插入的图片/视频/封面 → `announcement-images`；正文里的 base64 图片经 `processContentImages` → `template-images`；Word 导入的图片 → `chat-images`。删除公告时会尝试清理正文图片（`src/lib/storageCleanup.ts`）。
- 员工端显示：`AnnouncementBoard.tsx`、`AnnouncementDetailModal.tsx`（用 `sanitizeAnnouncementContent` 净化）。
- 视频封面与视窗（2026-10-27，前端待上线）：公告后台预览、员工公告详情、通知详情／登录通知与经理富卡复用 `src/lib/richVideo.ts`。新上传MP4从0.001秒等待解码后截取JPEG；若近乎全黑，再有限尝试0.1／0.5／1／2／3／5秒（不超过视频一半），选开头首个可见画面，同时上传视频和封面。保留既有非黑封面；旧内容缺少封面、封面失效或图片本身近乎全黑时，打开正文后使用相同规则临时生成，不回写旧内容或Storage、不必重新上传。全部候选仍黑时停止尝试；首次播放从0开始，不跳过已采样的片头。旧视频必须仍可读取和解码，跨域截帧受存储服务CORS约束；失败保留可点击的播放入口，视频源不可播放则显示错误与原文件链接。
- 待播放状态采用浅蓝细边与渐变内衬的内嵌圆角视窗，播放键为蓝白磨砂圆形（桌面直径104px、手机80px）、蓝青渐变图标及浅青光边；不生成可见「播放影片」文字，保留多语言无障碍名称。按钮自身在画面正中央，右下时长按视频元数据读取、不写死；遮罩减淡，悬停／按压居中微缩放；边缘为1.5px蓝青渐变跑马灯，外侧清晰、内侧向按钮中心延伸5px透明渐变柔化（6秒一圈），以深蓝／亮青／冰白色段形成旋转流光，配合3.6秒、45%–100%透明度脉冲，颜色明暗变化更明显而不高频闪烁。点击立即播放，按钮约200ms轻微缩小并淡出后隐藏，不人为延迟视频；原生控制条或键盘播放同样衔接过渡。暂停、拒绝播放、错误、结束与卸载会取消待完成过渡并恢复对应状态，避免按钮卡住。减少动态效果时停用环绕、脉冲、缩放及淡出，保留静态蓝色细环。播放后隐藏按钮；桌面点击／手机轻触画面暂停时，当前视频帧上重新出现圆形播放键，点击后从原位置继续，暂停不跳回封面。暂停层只让图标接收指针，保留底部原生进度／音量／全屏控件，避免覆盖控制条。横竖视频完整显示、竖视频限制高度；不自动播放。支持键盘播放与结束后重播；卸载正文时暂停视频、还原原封面并撤销临时URL。
- 通知上传原本已有视频入口，但 `QuickCopyRichContent.tsx` 的旧通用净化白名单会剥除视频；现改用保留video/source/poster的富媒体白名单，继续移除脚本、事件属性和自动播放。通知一键复制和已读逻辑不变，员工播放器提示使用十语言 `t.media`，后台未提供员工语言上下文时使用繁体中文。编辑器原有MP4/H.264/AAC、80MB、30分钟、1080p、每则3段影片与图片压缩规则均保留；无数据库／Edge Function变更。
