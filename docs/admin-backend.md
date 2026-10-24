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
- 加载：`get_employee_management_snapshot`（排除已归档员工；另返回可见管理员群组的地区清单 `regions`（含 `admin_id`）与每位员工的 `region_id`）、`get_notification_automation_plan_assignments`、`get_withdrawals_for_admin`。加载途中若有实时变动或页面重新初始化，这次结果会作废并排队重载；首次加载作废时继续显示载入状态，不会先闪出「找不到員工」。
- 列表显示：管理员后台按桌面端使用设计，保留全部 21 列，不按 lg/xl/2xl 隐藏任何列。「驗證」表头文字居中，「狀態」以居中位置向左微调 8px；工作状态表头简写为「工作」，左对齐、左侧留 2px，「標籤」左对齐、左侧留 12px；「使用者」「員工 ID」「地區」「備註」左对齐、左侧留 4px。仅调整标题文字位置，不改变列宽或下方资料的对齐。超管分组和二级管理员列表共用 1320px 最小表宽，宽屏随容器铺满；窗口不足时，从序号到「標籤」的左侧 10 列保持固定，仅右侧订单、资金、工时、工作天数和操作共 11 列横向滚动。固定列偏移按实际表头宽度测量，缩放/窗口变化时更新，表头与行数据保持对齐；固定单元格与右侧行共用一致的不透明深色底，置顶/悬停状态及底色过渡同步，移除标签右缘的额外分隔线和投影，使左右区域无视觉接缝，保留浮层交互。仅在内容横向溢出时，于表头上方的右侧数据区显示低饱和灰蓝色滚动条：轨道/滑块厚度 6px、操作区高 20px，滑块上下透明拖动命中区覆盖整个操作高度，深蓝灰轨道配灰蓝渐变滑块与居中三道握持细纹，悬停时提亮轨道和滑块，拖动时显示抓取光标及滑块内侧按压阴影；移除整个操作区的焦点亮框，键盘聚焦改为滑块本身提亮并加内侧细高光，不加外围框或外发光；不受系统隐藏原生滚动条影响，可拖动、点击，或聚焦后用左右方向键、PageUp/PageDown、Home/End 浏览。底部原生滚动、上方滑块与尺寸变化同步，宽度足够时收起，各群组位置独立。未新增移动端专用布局。
- 建立接口：`admin_create_employee_account_with_automation_plan`（用户名、密码 ≥6 位、员工 ID、必填所在地区 `p_region_id`（须属于该员工的管理员群组）、派单组、可选自动化方案）。二级建立的员工 `created_by` 是自己，超管可选目标管理员。新增员工弹窗已按新布局恢复填写与建立：左栏基本资料与右栏三个设置区共用与弹窗外框一致的深色基底：超管群组为暖黑/香槟金，其他群组为深蓝；仅输入框使用柔和浅色（暖白/冰蓝白），包含用户名、密码（显示/隐藏、随机生成）、员工 ID 和备注。右栏从上到下是「所在地區」「派單分組」「自動化通知方案」，通过低饱和紫、青、琥珀的细边线/图标/半透明按钮区分，不使用大面积浅彩底；底部固定取消/建立按钮。地区和派单组必填，方案选填；建立失败保留输入与选择，后端接口与权限未改。
- 新增员工选择菜单（`EmployeeSetupSelect.tsx`）：三个深色按钮及选项卡片使用对应的轻量主题色，菜单与详情浮层同步继承弹窗冷暖深色基底，菜单宽度上限 296px、高度上限 326px，单行卡片桌面约 38px 高（小屏仍遵循全局触控尺寸），任务数改为同行徽标；桌面从按钮右侧放大展开，剩余宽度不足时改向上/下贴边避让；菜单有选中标记、滚动、方向键/Home/End/Enter 和 Esc，Esc 优先关闭菜单，不关闭表单；减少动态效果偏好下关闭菜单动画。派单组选项显示原始名称及「（说明）」，不附加「預設分組」标签（仍可选择默认分组），加载 `dispatch_groups.description`；按钮或选项中的长说明截断时，悬停/键盘聚焦可显示完整可滚动详情卡片。方案仅列目标管理员群组的启用方案，并显示所选任务数及「不指定方案」选项；未指定时按钮使用中性暗底、虚线边框、停用图标及「未套用」徽标，提示不建立自动通知；对应菜单卡片同样使用虚线及「暫不套用」标记，与一般方案实线彩色卡片分开，选择实际方案后恢复琥珀主题。地区仍可从齿轮新增/编辑/删除/置顶，未选择时新增地区会自动选上。
- 编辑：`admin_update_employee_account`（用户名、员工 ID、所在地区 `region_id`（必填，只在改动时传；只能选该员工管理员群组的地区，不能清空）、备注、标签、启停、验证、置顶、注册时间）；自动化方案用 `set_notification_automation_plan_for_employee`；重设密码 `admin_reset_employee_password`（旧会话随即失效）。
- 删除：先走 `archive_employee_without_media` 快速路径；需要留证或返回 evidence changed 时，改走 `mutateAuditedContent('employee_delete', [id])`。删除后员工进入「已刪員工紀錄」（见 `docs/content-audit.md`）。
- 钱包调整：`admin_adjust_wallet_balance_atomic`（正负金额表示增减、必填备注、`createFinancialOperationId()`；失败重试沿用同一编号）。
- 详情弹窗 `EmployeeDetailModal.tsx`：`get_employee_detail_summary_for_admin`、`get_employee_transaction_page_for_admin`（每页 100）、`get_employee_transaction_date_counts_for_admin`、`get_employee_withdrawal_page_for_admin`（每页 10）。
- `EmployeeMetadataPopover.tsx`：只读的标签/备注弹层。
- 所在地区（`EmployeeRegionMenu.tsx`）：表格在「員工 ID」右侧有「地區」列（所有屏宽均显示，未设定显示「-」）。筛选列「入职日期」右侧的「地區」按钮（四个筛选按钮宽度 172/164/160/160px，屏宽 1536 时与「取消全部选中」排成一行）打开同宽下拉菜单：只列出**本群组管理员**的地区和人数；置顶地区固定在前（彼此保留原始排列，不随人数变化），其余按人数从多到少排列、同人数保留原始顺序，有人未设定时「未設定地區」始终在最后；不设搜索框，直接显示地区选项；标题栏右侧齿轮按钮「地區設定」。选中后与其他筛选同时生效，按钮右侧红色 × 或菜单底部「清除」取消，「取消全部选中」和选择「提現中」也会清除。新增与编辑员工的「所在地區」均为必填、只列该群组地区且提供齿轮设置；新增使用侧展卡片菜单，编辑保留原同宽菜单。地区下拉菜单与设置面板共用独立的 `employee-region-scrollbar`：深紫色轨道、细圆角紫色滑块，悬停时提亮；不影响入职日期等其他菜单的滚动条。
- 地区设定弹窗（齿轮打开，居中，Esc 先退出改名/删除再关闭，不会关掉后面的新建/编辑弹窗）：顶部输入新地区名称并「新增」；每个地区一行显示人数，图钉按钮置顶/取消置顶，铅笔改名（Enter 保存），垃圾桶删除；置顶保存到该管理员群组的地区资料，地区选择菜单遵循同样的置顶优先、其余人数降序规则。设置列表与下拉菜单共用排序逻辑，置顶或取消置顶保存成功后立即重排，无需关闭重开；新增、改名与人数更新也实时采用同一规则；保存时只有当前操作显示转圈和「正在儲存……」，不会整片按钮闪灰，写操作仍串行且成功后才更新资料。员工表的地区名称由独立单元格更新，不因地区设置变化重建全部员工行。没有员工的地区确认后直接删除；有员工的必须先选一个同群组的其他地区，按「改到新地区并删除」会把这些员工一起改过去；没有其他地区时提示先新增。
- 地区 RPC：`admin_create_employee_region(p_owner_admin_id, p_name)`、`admin_rename_employee_region(p_region_id, p_name)`、`admin_delete_employee_region(p_region_id, p_replacement_region_id)`。地区属于单一管理员群组：二级只能管自己群组，超管可管所有非紧急管理员群组；名称去首尾空白、1～30 字、同群组内不分大小写唯一（不同群组可同名）；新增重名返回已有地区并提示「已存在」，改名重名报错「此群組已有同名地區」。删除时已删除员工的地区会自动置空。

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
