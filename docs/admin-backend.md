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
- 会话失效：后台根页面的锁定数、聊天未读和提款计数轮询在明确收到管理员会话失效时，用请求发出时的 token 调用 `expireFinancialAdminSession`，仅同步清除仍匹配的本分页管理员会话并返回登录页；随后停止根页面轮询，卸载时使在途请求作废。旧请求不能清除新管理员／员工登录，重复失效只退出一次；普通网络、超时和权限错误仍保留登录状态。不改变会话有效期，不异步撤销其他会话；其他业务页既有退出流程不在本次改动范围。前端待用户部署。
- 后台长时间停留后，若网站已部署新版、首次打开「訂單指派」等页面的旧分块已失效，错误边界在线时最多自动刷新一次以取得最新版本，不清除登录存储；持续失败或离线时显示「頁面載入未完成」与「重新整理頁面」，不反复刷新。刷新后回到默认页，可重新打开所需页面；未保存输入不会保留。此类错误与管理员会话过期不同，不会自动重送任何业务写操作。

## 数据范围规则
- 二级管理员只能看、管自己名下的员工（`users.created_by = admin.id`）；超管看全部，可按管理员分组切换。
- 例外：「員工搜尋」(`search_all_employees_for_admin`) 允许超管和二级跨组精确搜索（排除 emergency 组），不能假设结果只属于本人。
- 各列表都排除 `emergency_admin` 和已归档（已删）的员工。

## 各页面
### 員工詳情數據 `EmployeeManagement.tsx`
- 加载：`get_employee_management_snapshot`（排除已归档员工；另返回可见管理员群组的地区清单 `regions`（含 `admin_id`）与每位员工的 `region_id`）、`get_notification_automation_plan_assignments`、`get_withdrawals_for_admin`。加载途中若有实时变动或页面重新初始化，这次结果会作废并排队重载；首次加载作废时继续显示载入状态，不会先闪出「找不到員工」。
- 列表显示：管理员后台按桌面端使用设计，保留全部 21 列，不按 lg/xl/2xl 隐藏任何列。「驗證」表头文字居中，「狀態」以居中位置向左微调 8px；工作状态表头简写为「工作」，左对齐、左侧留 2px，「標籤」左对齐、左侧留 12px；「使用者」「員工 ID」「地區」「備註」左对齐、左侧留 4px。仅调整标题文字位置，不改变列宽或下方资料的对齐。超管分组和二级管理员列表共用 1320px 最小表宽，宽屏随容器铺满；窗口不足时，从序号到「標籤」的左侧 10 列保持固定，仅右侧订单、资金、工时、工作天数和操作共 11 列横向滚动。固定列偏移按实际表头宽度测量，缩放/窗口变化时更新，表头与行数据保持对齐；固定单元格与右侧行共用一致的不透明深色底，置顶/悬停状态及底色过渡同步，移除标签右缘的额外分隔线和投影，使左右区域无视觉接缝，保留浮层交互。仅在内容横向溢出时，于表头上方的右侧数据区显示低饱和灰蓝色滚动条：轨道/滑块厚度 6px、操作区高 20px，滑块上下透明拖动命中区覆盖整个操作高度，深蓝灰轨道配灰蓝渐变滑块与居中三道握持细纹，悬停时提亮轨道和滑块，拖动时显示抓取光标及滑块内侧按压阴影；移除整个操作区的焦点亮框，键盘聚焦改为滑块本身提亮并加内侧细高光，不加外围框或外发光；不受系统隐藏原生滚动条影响，可拖动、点击，或聚焦后用左右方向键、PageUp/PageDown、Home/End 浏览。隐藏底部重复的原生横向滚动条，移除两种列表底部的蓝色发光装饰带；员工表格在普通／悬停状态均覆盖通用滚动条的标准属性，避免原生横条重新出现，超管列表外层禁止横向溢出。只保留上方滑块，右侧纵向滚动条不变；触控板/触控横向滚动与上方滑块、尺寸变化保持同步，宽度足够时收起，各群组位置独立。未新增移动端专用布局。
- 建立接口：`admin_create_employee_account_with_automation_plan`（用户名、密码 ≥6 位、员工 ID、必填所在地区 `p_region_id`（须属于该员工的管理员群组）、派单组、可选自动化方案）。二级建立的员工 `created_by` 是自己，超管可选目标管理员。新增员工弹窗已按新布局恢复填写与建立：左栏基本资料与右栏三个设置区共用与弹窗外框一致的深色基底：超管群组为暖黑/香槟金，其他群组为深蓝；仅输入框使用柔和浅色（暖白/冰蓝白），包含用户名、密码（显示/隐藏、随机生成）、员工 ID 和备注。右栏从上到下是「所在地區」「派單分組」「自動化通知方案」，通过低饱和紫、青、琥珀的细边线/图标/半透明按钮区分，不使用大面积浅彩底；底部固定取消/建立按钮。地区和派单组必填，方案选填；建立失败保留输入与选择，后端接口与权限未改。三项选择后均以对应主题的高亮描边、渐层底色、实色图标与「已選擇」徽标区分；选择有效项目时设置区同步高亮，「不指定方案」保持中性未套用样式。
- 新增／编辑员工选择菜单（`EmployeeSetupSelect.tsx`）：三个深色按钮及选项卡片使用对应的轻量主题色，菜单与详情浮层同步继承新增弹窗的冷暖深色基底或编辑弹窗的独立梅紫基底，菜单宽度上限 296px、高度上限 326px，单行卡片桌面约 38px 高（小屏仍遵循全局触控尺寸），任务数改为同行徽标；桌面从按钮右侧放大展开，剩余宽度不足时改向上/下贴边避让；菜单有选中标记、滚动、方向键/Home/End/Enter 和 Esc，Esc 优先关闭菜单，不关闭表单；减少动态效果偏好下关闭菜单动画。派单组选项显示原始名称及「（说明）」，不附加「預設分組」标签（仍可选择默认分组），加载 `dispatch_groups.description`；按钮或选项中的长说明截断时，悬停/键盘聚焦可显示完整可滚动详情卡片。方案仅列目标管理员群组的启用方案，并显示所选任务数及「不指定方案」选项；未指定时按钮使用中性暗底、虚线边框、停用图标及「未套用」徽标，提示不建立自动通知；对应菜单卡片同样使用虚线及「暫不套用」标记，与一般方案实线彩色卡片分开，选择实际方案后恢复琥珀主题。地区仍可从齿轮新增/编辑/删除/置顶，未选择时新增地区会自动选上。
- 编辑：列表最右侧「操作」→「編輯員工」，布局与新增员工一致：左侧用户名、员工 ID、备注，右侧依次为地区、派单分组、自动化通知方案；使用独立的深紫／梅紫主题（标题、边框、基本资料、输入框焦点与储存按钮），不沿用新建的黄／蓝主题；右侧三个设置仍保留地区紫、派单青、方案琥珀色，使用同一侧展选择菜单，底部固定取消／储存。有效选中的配置会强化整张设置区：外层使用对应紫／青／琥珀主题色底、清晰描边、4px 实色侧边标记和编号色块；内侧按钮加深彩色渐变，图标与勾选「已選擇」徽标改为浅亮实色底／深色文字，并保留独立键盘焦点外框。效果跟随当前有效选项即时切换，表示当前选择而非已保存；未配置、「不指定方案」以及不在可用选项中的暂停／封存项目不标为启用。强化效果仅作用于编辑弹窗，不改变新建面板的选中外观。打开时加载该员工真实派单归属，方案预选现有成员关系；仅列启用且未封存派单组，以及所属管理员的启用方案。原派单组已停用／封存或方案已暂停／封存时清楚显示并可原样保留；未分组员工可保持现况，不会自动分派或清空原方案。储存仅提交改动：账号与地区用 `admin_update_employee_account`（`region_id` 必填、不能清空或跨管理员），派单归属用 `admin_assign_dispatch_group_member`，方案用 `set_notification_automation_plan_for_employee`（可选「不指定方案」移除）。共用原有员工 ID 和成员表，派单页经 Realtime 更新、自动化页重新激活时重载，无须去其他页面再设置。三个接口分别提交；部分失败明确列出已保存项、保留未完成草稿，重试不重复提交本窗口已成功的项目。全部写入成功后即显示已储存并关闭编辑框，列表在后台刷新；保存前已经启动的旧读取会作废，刷新占用或实时事件使读取作废时沿原队列重新读取，不再要求再次储存。真正的列表读取失败仍保留旧内容并显示独立的载入提示／「重試」，不会把已保存资料说成保存失败。关闭按钮、取消、背景点击或 Esc 在无改动时直接关闭；有未保存改动时改用与编辑面板一致的紫色页内确认，不再弹浏览器原生提示。默认聚焦「繼續編輯」，可选择「放棄變更並關閉」；继续、返回按钮、Esc 或点击确认框外侧均保留草稿并返回编辑，只有明确放弃才清空未保存内容，已成功保存的项不受影响。确认期间底层编辑面板不可操作，Tab 焦点限制在确认框内，返回后恢复原焦点；保存中禁止关闭。启停、验证、标签等仍用现有编辑 RPC，密码由独立 `admin_reset_employee_password` 重设（旧会话随即失效）。
- 删除：先走 `archive_employee_without_media` 快速路径；需要留证或返回 evidence changed 时，改走 `mutateAuditedContent('employee_delete', [id])`。删除后员工进入「已刪員工紀錄」（见 `docs/content-audit.md`）。
- 钱包调整：`admin_adjust_wallet_balance_atomic`（正负金额表示增减、必填备注、`createFinancialOperationId()`；失败重试沿用同一编号）。
- 详情弹窗 `EmployeeDetailModal.tsx`：`get_employee_detail_summary_for_admin`、`get_employee_transaction_page_for_admin`（每页 100）、`get_employee_transaction_date_counts_for_admin`、`get_employee_withdrawal_page_for_admin`（每页 10）。
- 员工标签管理：列表标签栏的「+」打开深色琥珀主题面板，顶部「選用已有標籤」汇总目标员工所属管理员群组全部已加载员工正在使用的标签，不受当前员工搜索/筛选影响，不跨管理员群组；精确去重、保留大小写与已有标签原文，排除纯空白。候选选择、手动新增与移除先修改面板草稿，不立即写入员工列表；已选标签有勾选标记且不可重复添加。右下角无改动时显示「關閉」，有改动时显示「儲存」，点击后统一通过 `admin_update_employee_account` 提交；输入框尚未点击新增的有效文字也会一并保存。保留手动新增（去首尾空白、Enter 加入草稿、输入法组字期间不提交）；快捷选择不清掉手动输入。保存中禁用增删与关闭，失败保留草稿、原列表不变并提示重试，关闭／Esc／背景点击有未保存改动时须确认放弃。候选区独立限高滚动，长标签换行；面板整体限制在画面内，可用键盘选择候选与 Esc 关闭。
- `EmployeeMetadataPopover.tsx`：只读的标签/备注弹层。
- 所在地区（`EmployeeRegionMenu.tsx`）：表格在「員工 ID」右侧有「地區」列（所有屏宽均显示，未设定显示「-」）。筛选列「入职日期」右侧的「地區」按钮（四个筛选按钮宽度 172/164/160/160px，屏宽 1536 时与「取消全部选中」排成一行）打开同宽下拉菜单：只列出**本群组管理员**的地区和人数；置顶地区固定在前（彼此保留原始排列，不随人数变化），其余按人数从多到少排列、同人数保留原始顺序，有人未设定时「未設定地區」始终在最后；不设搜索框，直接显示地区选项；标题栏右侧齿轮按钮「地區設定」。选中后与其他筛选同时生效，按钮右侧红色 × 或菜单底部「清除」取消，「取消全部选中」和选择「提現中」也会清除。新增与编辑员工的「所在地區」均为必填、只列该群组地区且提供齿轮设置；新增与编辑共用侧展卡片菜单。地区下拉菜单与设置面板共用独立的 `employee-region-scrollbar`：深紫色轨道、细圆角紫色滑块，悬停时提亮；不影响入职日期等其他菜单的滚动条。
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
- 员工团队维护：`EmployeeLoginMaintenanceSettings.tsx` 独立保存。超管在各管理员的「編輯管理員設定」面板操作：桌面加宽至最大1152px，左侧团队维护、右侧品牌来源／自订内容／超管对照，两栏独立滚动；右侧编辑字段及超管对照均按「品牌名稱」在上、「顯示幣別」在下各占一行；外框高度按视窗固定（90dvh，最高820px），标题和底部按钮固定，展开密码确认或显示错误不会改变弹窗尺寸或挤动右栏。1024px及以下改为上下单栏、内容统一滚动。二级仍在「我的設定」顶部操作自己团队；不在修改导航文字／排序的「導航設定」对话框。每个管理员（含超管自己的团队）独立，默认关闭，不继承超管或品牌设置来源。
- 开启／关闭都须输入**当前操作者**的管理员密码（超管操作二级团队时输入超管自己的密码），服务端以会话确认身份及范围。密码错误不变更状态，连续5次错误将该操作者的维护密码确认锁定15分钟，不锁管理员登录；成功后清空确认失败计数，并写私有审计。保存中禁用编辑关闭、Esc及品牌保存，密码Enter不提交品牌表单；取消清空密码，读取失败显示未确认状态，写入结果不确定时须重读，不自动重送。
- 开启后，`users.created_by` 属于该管理员的**全部员工**立即由服务器停工：结束派单与工时、撤销旧登录及记住我会话；取消尚未交单的派单，已保存的订单保留并继续由原系统结算，资金记录不变。在线页面收到信号后卸载工作区，弹十语言维护提示，只能确认退出；断线／后台页面恢复时补查。维护期间正确密码登录仍弹提示，不累计密码错误。管理员与其他团队不受影响。关闭维护后必须重新登录并手动开工，不自动恢复旧会话或已停工作。
- 配置 RPC 为 `get_employee_login_maintenance` / `set_employee_login_maintenance`，员工会话检查为 `get_employee_maintenance_status`。原读取报错是后端未部署；现在分别提示未部署／会话失效／权限／网络问题，绝不把读取失败当成关闭。两份迁移已获用户确认并于2026-10-25（UTC+8）依次部署，正式版本为 `20261024200433 employee_login_maintenance`、`20261024200605 team_employee_maintenance`；接口已刷新，部署后配置／启用／维护撤销／维护审计均为0，没有自动停工。前端仍待用户上线；须部署新版前端后再实际开启团队维护，旧前端不含专用确认退出流程。测试 `npm run test:employee-login-maintenance`。

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
- 封存分组仅软封存，不删除分组、成员、导入订单或派单历史；默认分组不可封存。封存前显示主题化二次确认，封存后员工停止接收该分组订单；重新指派员工或还原分组后可恢复。
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
