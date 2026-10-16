# 员工端

入口：`src/components/employee/EmployeeDashboard.tsx`（包在 `LanguageProvider` 内）。

## 导航
| 英文默认 / 中文 | 组件 |
|---|---|
| Announcements / 公告 | `AnnouncementBoard` |
| Order Assignment / 订单分配（手机：派单） | `OrderDispatch` |
| Orders / 订单 | `OrderSubmission` + `OrderList` |
| Daily Statistics / 每日统计 | `DailyStatistics` |
| Wallet / 钱包 | `WalletOverview`（内嵌 `WithdrawalHistory`） |

- 文字来自 `t.nav`；页面首次打开后保持挂载。
- 全局组件：`CustomerServiceChat`（聊天）、`MessageCenter`（通知中心）、`LoginPopupMessages`（登录通知）、`PasswordChange`、会话失效弹窗。

## 全局行为
- Realtime：`users` 更新时同步资料并检测会话是否被顶替；`message_recipients` 的 INSERT/UPDATE 触发通知投递。
- 铃铛未读数 = 该员工 `message_recipients.is_read = false` 的数量（不含聊天未读）。
- 登录时自动发送「模擬客戶」自动消息：读 `simulated_customers`、`customer_auto_messages`、`customer_auto_message_logs`，按员工记录避免重复发送。
- 会话机制见 `docs/architecture.md`；员工安全 RPC 需要 financial token + `tabId`。

## 屏幕适配
- 手机横屏提示 `src/components/PhoneLandscapeGuard.tsx`：手机（`pointer: coarse` 且屏幕短边 <600px）横放时全屏遮罩，提示转回竖屏；平板、电脑不拦截。按设备方向（`screen.orientation`，旧浏览器用 `window.orientation`）判断，键盘把竖屏视口压扁不会误触发。遮罩不卸载页面，输入内容与实时订阅都保留；出现时让当前输入框失焦。员工端挂在 `EmployeeDashboard`，有待接订单或订单将超时时显示浅黄/浅红提醒（`notice.tone` = `order`/`urgent`）；登录页由 `App.tsx` 挂载。文字在 `t.orientation`，样式类 `phone-landscape-guard`/`plg-*` 在 `src/index.css`。卡片高过屏幕（矮屏或系统字体放大）时组件加 `data-compact`，隐藏说明文字，保证标题与提醒可见。普通网页无法强制锁定方向（iOS Safari 不支持 `screen.orientation.lock()`），所以采用遮罩提示。
- 导航：宽 <768 底部导航用短标签（`t.nav.*Mobile`），768–1024 用完整标签（CSS 切换，不依赖 `isMobile`）；≥1025 显示顶部标签栏，1025–1279 收紧按钮内边距与字号。
- 字号：员工端组件的像素字号最小 11px（固定尺寸的计数气泡 10px），新增文字不要再用更小的像素字号。窄屏根字号缩小造成的 `text-xs`/`text-sm` 过小，由 `src/index.css` 在 `body:has(.employee-shell)` 下补下限：宽 ≤414 时 `text-xs` 为 11px（带 `xs:text-*` 变体的元素在 360px 起交给变体），宽 ≤320 时 `text-sm` 为 11.5px。宽 ≤359（iPhone SE 一类）时 `text-[15px]` 缩为 14px、`text-[40px]` 缩为 32px，`tracking-wide/wider/widest` 字距收窄，公告详情正文 14px。
- 换行：标签和正文不要用 `[overflow-wrap:anywhere]` / `break-all`（会把 TOTAL 这类普通单词拆成两行），用 `break-words`，统计卡标签再加 `hyphens-auto`；`LanguageProvider` 会把 `<html lang>` 同步为当前语言，德语等长词按音节加连字号换行。`break-all` 只留给编号、文件名等无意义字符串。
- 弹窗：`src/index.css` 里旧的全局 `[role="dialog"]` 规则（宽 ≤320 压成 300px 加内边距、矮屏限高 85vh、横屏 90vh）已用 `body:not(:has(.employee-shell))` 排除员工端，员工端弹窗自己控制尺寸（手机为全屏面板）。消息/登录通知/通知详情头部右侧留 56px（`pr-14`）给触屏下 44px 的关闭按钮。
- 留白：各标签内容底部预留约 84–108px（随客服悬浮按钮上移 12px 同步增加），最后的按钮可滚到客服悬浮按钮上方；手机根元素按实测底部导航高度（`--employee-bottom-nav-height`）留白；全屏弹窗打开时隐藏客服悬浮按钮。
- 布局断点：钱包四张金额卡 ≥1025 才排一行（以下两列）；统计汇总 ≥720 才三列；派单页 6 个统计框在 600–1279 为 3 列 × 2 行、≥1280 才一行 6 列；平板（≥600，含竖屏）与电脑显示同一套完整内容：派单页完整标题区与带说明文字的统计框、统计页每日明细完整表格（<1025 时表头去图标、货币单位写在表头、表头可按音节换行），不再有单独的「平板精简版」；手机（<480）上 Today's Orders 与派单页的 6 格信息框统一为「图标 / 数字 / 名称」居中排列，名称预留两行高度，6 格对齐；提交订单表单 ≥1025 才左右两栏；订单处理面板在平板及以上高度为 `clamp(420px, 视口高 − 页头 − 底部导航 − 48px, 575px)`，矮屏平板（如 1024×600）也能完整显示。

## 派单与接单 `OrderDispatch.tsx`（服务器主导）
1. 开工前要求 `employee.is_verified`；调用 `start_employee_dispatch_session_secure`。
2. `prepare_next_dispatch_order_secure`（服务器选池与时间）→ `assign_next_dispatch_order_secure` 派单；派单记录在 `dispatch_assignments`（关联 `dispatch_group_orders`）。
3. `pending` 有服务器端 60 秒截止；接单 `accept_dispatch_assignment_secure`（可能按抢单成功率失败），成功后为 `accepted`。
4. 结束 `finish_dispatch_assignment_secure`，结果为 `completed` / `error` / `timeout` / `cancelled`。
- 连续 5 单未接，服务器自动停工。客户端不能自行决定派单时刻或判定超时（已提交的订单有服务器宽限）。
- `dispatch_assignments` 不在 Realtime publication 中，状态靠 RPC 与轮询。
- 刷新与停工：刷新/关闭页面时用 sendBeacon 调 `stop_employee_dispatch_session_secure`；重新进入页面时 `recover_employee_dispatch_assignment_secure` 会恢复 30 秒内结束（且 2 分钟内有活动）的会话，所以刷新不会中断工作。员工主动结束（「End Session」、超时/闲置自动停工、退出登录）改用 `end_employee_dispatch_session_secure`：先停工，再在 `private.employee_work_stop_markers` 记下停工时间，恢复时跳过在该时间或之前结束的会话，刷新后保持停工（迁移 `20261101000003_keep_user_stopped_work_sessions_stopped.sql`）。
- 关键迁移：`20260918215530_server_authoritative_dispatch_lifecycle.sql`；pg_cron 每分钟 `auto_cleanup_dispatch_system()` 协调生命周期。
- 开工过渡（手机、平板、电脑统一；开启「减少动态效果」时用简化版）：点击后按钮原位换成「Starting...」，待机内容自下而上依次淡出并上移（`.dispatch-standby-leaving`，每行 560ms、`--leave-order` 错开 80ms）；480ms 后「Starting Work」遮罩用 600ms 淡入，进入「连接派单中心」模式（`DispatchVeil` 的 `connect`）：小船后有雷达波纹，进度条和状态行依次显示「正在连接派单中心 → 正在验证工作会话 → 正在同步订单队列」，最后「连接成功」（蓝色对勾、小船后一团柔和的蓝青色光晕、进度条走满并扫过一道高光，不再用绿色）。「连接成功」最早在点击后 4.2 秒出现，整段约 6 秒结束。平板/电脑上大按钮里的内容同样依次上移淡出；面板在遮罩下从待机高度平滑长到等待高度，遮罩里的小船位置固定不动。遮罩进场完成后改为静止状态，中途切走再切回不会重播，并且必须等 `start_employee_dispatch_session_secure` 成功返回；服务器慢时进度条停在第三步缓慢逼近 90%。显示「连接成功」后 250ms，在不透明遮罩下切换到等待面板，再过 500ms 遮罩消散（先收起小船和文字，再淡出背景），整个过程约 5 秒，服务器请求与动画并行，不增加请求。为免第一单在遮罩期间到达、占用 60 秒接单时间，开工时设置 `dispatchHoldUntilRef`，`armDispatchTimer` 至少等到遮罩消散后才派单。失败时至少显示 1.6 秒「正在连接」，再显示红色「连接失败」0.9 秒，然后恢复待机内容。每次开工都会重新创建遮罩（`panelVeilKey`），并取消上一个遮罩的移除计时，避免刚结束工作就再开工时连接动画被提前关掉。时间常量在 `OrderDispatch.tsx` 的 `START_CONNECT_*`，状态步骤时间在 `DispatchVeil.tsx` 的 `CONNECT_STEP_AT_MS`。只有开启减少动态效果时走原来的简化流程。派单页的错误提示通过 portal 挂到 `body`，出现时不推挤面板。
- 手机面板尺寸（<600px）：`.dispatch-work-panel` 在外层统一计算完整高度（包含边框与留白），不再用隐藏面板占位或记录旧机型的最大高度。待机最高 480px，连接加载层入场后用 1 秒平滑向下展开：目标高度只确定一次，使用图层缩放与内容反向补偿，不逐帧改变布局高度，下方卡片同步平移；背景/遮罩始终跟随面板铺满，只有文字、插图和遮罩独立前景层做比例补偿，遮罩前景固定高度，避免结束缩回时露出白块。遮住的吊机和装饰暂停，失败或结束后的尺寸过渡完成才恢复；结束时也会重建遮罩、清理上次开工的连接状态与移除计时器，快速操作不互相干扰。等待派单、New Order、In Progress 共用最高 580px 的工作高度，两者都受「100svh − 页头 − 底部导航 − 预留空间」限制（最低 340px），矮屏不强行拉长。`svh` 避免地址栏伸缩驱动高度跳动，换尺寸时 CSS 直接重算；600px 起沿用平板/电脑布局。说明文字与 AUTO-DISPATCH / REAL-TIME 卡片保留，矮屏压缩吊机场景，长文案在内容区滚动，开始按钮始终留在面板内。开启减少动态效果时不播放高度过渡。
- 结束工作过渡：服务器确认结束后，先等遮罩完全盖住内容；手机、平板、电脑统一使用约 1.4 秒图层缩回（原尺寸不变），等真实动画完成后再用约 0.7 秒整体淡出遮罩。待机内容直接在遮罩下准备好，不再另做上移/入场；顶部强调线随遮罩淡出，在揭幕阶段与遮罩交叉淡入（减少动态效果时不淡入），揭幕后不再单独闪现。遮罩（`.dispatch-veil`）不自带圆角，只由面板的 `overflow: hidden` 统一裁切——带外圈圆角的遮罩比面板内缘小，四角会露出下层的强调线；遮罩里的色块、扫光放在 `.dispatch-veil-content` 内，与文字一起做缩放补偿，不要直接放回遮罩根节点，否则缩放时会被压扁。开始按钮在整个收尾期间保持禁用，但呈现待机图标和文案，避免最后才从「Starting...」切回；揭幕完成统一解锁并恢复吊机和装饰。减少动态效果时跳过尺寸及遮罩动画，自动停工仍即时更新。`SmoothHeight` 只用于平板/电脑开工过渡，测量使用布局像素与小数高度，避免 CSS zoom 或取整造成收尾跳动。
- 抢单失败过渡：`accept_dispatch_assignment_secure` 返回 `grab_failed` 时，面板从 New Order 回到等待派单。先用 `buildPanelSnapshot` 把当前面板克隆进 `data-accept-ghost-host`，700ms 淡出（`.dispatch-grab-snapshot`），期间 `grabTransition` 为真：桌面/平板的面板高度（New Order 固定高度 → 等待面板自然高度）与手机一样用图层缩放平滑过渡，下方卡片同步平移，并暂停装饰动画；提示弹窗的暗色遮罩用 `.dispatch-modal-backdrop-in` 淡入。弹窗锁定页面滚动时（`isAnyModalOpen`）按滚动条宽度补右内边距，避免页面横向跳动。减少动态效果时直接切换。接单成功仍用原有的 `buildAcceptGhost` 快照，面板高度不变。结束工作遮罩里的色块、轮船、海浪保持动画，不要再为省性能暂停它们（色块已在补偿缩放的前景层内，不会变形）。
- 等待面板动画（`src/index.css` 的 `dispatch-*`）：持续动画只改 `transform`/`opacity`——渐变漂移、内光晕、计时卡片、数字扫光、开始按钮光晕、海鸥翅膀都做成独立图层。不要对大面积元素动画 `background-position`、`box-shadow`、`filter` 或 SVG 内部属性，也不要给含动画子元素的容器加 `filter`，否则手机每帧整块重绘。网格里互为占位的隐藏面板加 `.dispatch-parked`（停掉其中全部动画）。装饰层（呼吸光环 `.dispatch-panel-wave`、四角弧线、海鸥、小船、海浪）整体是 `z-[2]`，在面板顶部白色渐变（`.dispatch-waiting-surface::after`，z-index 1）之上、内容（z-10）之下；光环放回白色渐变下面会被冲淡。进入等待面板 1.5 秒后测两段各 2 秒帧率，都低于 45fps（低端机、iOS 低电量模式锁 30fps）就切到静态版 `.dispatch-waiting-lite`；手机、平板、电脑都适用，不按设备类型或 UA 判断，因为 UA 档位会把所有 iPhone 判为低端。注意：没有显卡的测试环境（如无头浏览器）里，平板/电脑尺寸帧率低，会切到静态版，测动画版性能时要先排除这一点。

## 提交订单 `OrderSubmission.tsx`
- Product Type 选择框在选中后显示清除按钮（X）；清除后恢复未选择状态并关闭下拉菜单，不影响其他表单内容，焦点回到选择框。
- 订单号 9 位、交易号 11 位；`get_employee_dispatch_submit_wait_secure` 取得有效的 assignment。
- 用 `valid_order_data` 校验，`used_order_data` 防止重复使用；插入 `orders(status='processing', assignment_id)` 后调用 `mark_dispatch_assignment_submitted_secure`；标记失败会删除刚插入的订单和使用记录。
- `orders.status` 为 `processing` / `success` / `failure`（和派单状态是两回事）。pg_cron 每分钟 `process_pending_orders()` 处理已 processing 满 3 分钟的订单（每批 200）。

## 订单列表与统计
- `OrderList.tsx`：读 `orders`、`product_types`、`wallet_transactions(type='tip')`；Realtime + 每 5 秒轮询。
- `DailyStatistics.tsx`：每 10 秒调用 `get_daily_order_stats`、`get_overall_order_stats`；日期按 **UTC** 分组。

## 钱包与提现
- `WalletOverview.tsx`：读 `wallets`、`users`、`verification_requests`；总资产 = `available_balance + frozen_balance`，`total_income` 来自用户资料。
- 提现：`get_employee_withdrawal_policy_secure` 查资格（门槛来自所属派单组）→ `request_employee_withdrawal`（**提走全部可用余额**、同时只能有一笔 pending、金额转入冻结）；`cancel_employee_withdrawal` 只能取消 pending 并退回可用余额。都要带 financial token + `tabId` + 操作编号。
- `WithdrawalHistory.tsx`：提现与人工调整记录（`TransactionHistory.tsx` 未接入）。

## 账户
- `VerificationForm.tsx`：弹窗（手机全屏、平板/电脑居中卡片，`onClose` 关闭，打开时锁定背景滚动），由钱包页的验证状态卡片打开。证件图片上传到 `verification-documents`（取公开 URL），写入 `verification_requests`（有待审申请则更新，否则新增）。字段沿用历史命名：身份证号存 `wallet_address`、地址存 `email`。
- `PasswordChange.tsx`：前端要求 ≥8 位且含字母和数字，调用 `change_employee_password_atomic`（数据库只要求 ≥6 位），成功 2 秒后登出。

## 通知与公告（已读规则）
- 通知中心 `MessageCenter.tsx`：用 `get_employee_notification_messages` 拉列表；**只有选中某条通知、显示详情时**才调用 `mark_employee_notification_read`，只打开列表不算已读。打开时锁定背景滚动（隐藏页面滚动、根节点设为 inert、手机端固定 body）。
- 实时弹出卡片：投递完成时传 `p_mark_read: false`；点击卡片会打开通知中心并选中该条 → 标为已读；点关闭则不标记。卡片不会自动消失（2026-10-15 起，与客服聊天新消息卡片一致），只有员工点击卡片、点关闭或点铃铛才消失；新通知到达时直接替换当前卡片（旧通知仍在通知中心和铃铛未读数里）。
- 弹出卡片的位置与样式（2026-10-15，`EmployeeDashboard.tsx`）：卡片用 portal 挂到 `body`、`fixed` 定位，`useLayoutEffect` 按铃铛的实际位置算出 `top`/`right`/箭头偏移（右边缘对齐铃铛，但左边至少留 12px），所以窄屏手机上不会超出屏幕左侧；宽度 `min(100vw − 24px, 340px)`。z-index 由 `.employee-header-toast` 控制（平时 10021，打开弹窗时降到 9000，与页头一致）。尺寸全部用 px。
- 弹出卡片的内容布局：最上面是卡片标题（普通通知为「新消息」，绩效奖励为「Performance Reward」），17px（≥480px 为 19px）超粗体、带轻微文字阴影，前面有一道渐变竖条；其下是通知自己的标题（13/14px 半粗，最多 2 行）和内容预览（手机 1 行，≥480px 最多 2 行，11/12px）。关闭按钮 26px 圆形放在卡片右上角（用 `after:` 伪元素把点击区扩到约 44px，所以不用全局的 `emp-close-btn`），圆底与底部操作栏同色（普通通知 `emerald-950/30`，绩效奖励 `amber-900/25`），X 为白色；标题行右侧留 24px 避开它。底部深色底带左侧是优先级「文字图标」：高 24px 的圆角胶囊，里面是小图标 + 文字（`t.header.urgent/highPriority/normal`，低为 `t.messages.priorityLow`），图标与通知中心 `MessageCenter.getPriorityIcon` 同一套，按类型配色：紧急 `AlertCircle` 红底白字、重要 `Zap` 黄底深琥珀字、普通 `Shield` 白底（随卡片主题为深青绿或琥珀字）、低 `Radio` 浅蓝底；绩效奖励的金额紧跟在胶囊后（≥480px 前面带「奖励钱包」标签）；右侧是「查看」按钮（28px，≥480px 为 32px）。所有屏宽显示装饰色块。手机上普通通知卡片约 130px 高。
- 登录弹窗 `LoginPopupMessages.tsx`：`has_pending_employee_login_notifications` → claim → 显示时调用 `complete_notification_delivery(p_mark_read: true)`，弹出即算已读。
- 自动化通知同样适用以上规则。
- 错过的实时通知不会丢：页面可见且在线时（每 30 秒、切回页面或恢复联网时；实时连接断开也照常执行，失败按 30 秒起倍增、最长 5 分钟重试），`claim_next_realtime_notification_delivery` 会补弹所有未投递、未过期的实时通知；`realtime_with_login_fallback` 的通知在下次登录时由登录弹窗先显示。
- 一次补弹超过 3 条时只显示一张「你有 N 条新消息」提示（只响一次提示音），点击打开通知中心但不选中任何一条，因此不会标为已读；3 条以内仍逐条弹出。实时到达的新通知照旧逐条弹出。
- `EmployeeNotificationDetailPanel.tsx` 是通知详情的展示组件（后台预览也在用），本身不写已读。
- 通知详情正文字号（2026-10-16）：正文容器统一用 `.notification-detail-prose`（`src/index.css`）：手机 15px、平板/电脑 16px（宽度 ≤359px 为 14px），行高 1.65–1.7，用固定 px，不受手机根字号（12–15px）缩小影响；管理员在编辑器里设的大/中/小字是 em 比例，随正文一起放大。使用处：`MessageCenter.tsx` 详情、`LoginPopupMessages.tsx`（手机与平板/电脑两种布局）、`EmployeeNotificationDetailPanel.tsx`（后台预览）。通知列表卡片预览和铃铛弹出卡片预览（11/12px）是另一套小字号，不要和详情共用同一个类。触屏设备的全局「最小点击区域」规则会给每个 `<a>` 加内边距，`.notification-detail-prose` 内无 class 的链接已在 `src/index.css` 里排除，避免句中链接前后出现空白。
- 公告：`AnnouncementBoard.tsx` 读 `announcements`，`AnnouncementDetailModal.tsx` 净化后显示；公告没有已读标记。首次加载且没有缓存时，内容区正中显示「加载中...」；加载完成仍无公告才显示居中的「暂无公告」卡片。之后的实时刷新在后台进行，不再显示加载状态。切到其他标签（公告页 `display: none`）时自动滚动循环停止，切回后由 `ResizeObserver` 重新启动。

## 聊天
- 见 `docs/service-chat.md`（员工端组件 `CustomerServiceChat.tsx`）。

## 多语言 `src/lib/i18n/`
- 10 种语言：`en`（默认）、`es`、`zh`、`fr`、`de`、`pt`、`ja`、`ko`、`it`、`hi`；偏好存 `localStorage.employee_language`；`LanguageSwitcher.tsx` 负责切换。
- `Translations = typeof en`：新增键先加到 `locales/en.ts`，再补齐其余 9 个文件。加载时只做类型断言，缺键不会报错，运行时会显示 undefined。
- 用法：`const { t, dateLocale } = useLanguage()`；按命名空间取文字，如 `t.nav`、`t.header`、`t.session` 等。
- 现有代码中仍有少量硬编码英文：部分 `aria-label`。
- 派单错误通知（`OrderDispatch.tsx` 的 `showNotification`）不要直接显示服务器原文：用 `dispatchErrorText(error, hint)`，由 `getDispatchErrorReason` 归为网络 / 登录过期 / 工作已结束 / 账号不可用 / 系统繁忙 5 类，对应 `t.dispatch.reason*`；只有网络和系统繁忙才附 `t.dispatch.hint*`。原始错误只写控制台。卡片样式与位置在 `src/index.css` 的 `.dispatch-notice` / `.dispatch-notice-stack`（按页头高度下移），自动关闭的通知底部有 `.dispatch-notice-timer` 进度条。
- 登录页 `src/pages/Login.tsx`：错误存为 `LoginErrorKind`（invalid / deactivated / network / unavailable / failed / locked），文字取 `t.login.error*`、`lockedDesc`、`attemptsWarning`、`tryAgainIn`；`check_login_rate_limit` / `record_login_attempt` 返回的 `lock_reason`、`warning` 是固定英文，不要直接显示。三套布局共用 `LoginAlert`。
- 按语言排版（`src/index.css`，`body:has(.employee-shell)` 下用 `:lang()` 匹配 `<html lang>`）：中文、日文、韩文、印地语去掉 `tracking-wide*` / `tracking-[0.x]` 的加宽字距；韩文 `word-break: keep-all` 按词换行；印地语把 `leading-tight` / `leading-snug` 放宽到 1.45。新加大写标签照常用 `tracking-*`，会自动适用。
- 拼接多句文字时，中文、日文句间不加空格（参考派单暂停提示的写法）。
- 全局触屏规则会给按钮加左右 16px 内边距；底部导航按钮已用行内 `paddingLeft/Right: 0` 抵消，新做的窄按钮如果文字被挤成两行，先检查这一条。

## 切换页面
- 访问过的页面保持挂载（`display:none`），页面元素在 `EmployeeDashboard` 里用 `useMemo` 固定，切换时只重绘外壳和导航，不再重绘所有页面。
- `useResponsive` 只在宽高等数值真的变化时才更新；以前页面高度一变（每次切换都会）就让整个应用重绘一遍。
- 登录动画结束 1.5 秒后在后台依次预取各页面代码，首次打开页面一般不再出现加载画面。
- 切换页面不再做整页淡入（以前电脑端 280ms 淡入时文字会先发虚再变清楚）。
- iOS 上不再强制每个带 blur 的元素单独成层（`[class*="blur-"]{transform:translateZ(0)}` 已删除），重页面切换时不会先模糊后清晰。

## 钱包提现
- 点「Submit Withdrawal」后，幕布合拢，中间显示白色申请卡片：图标 + 标题 + 当前步骤（验证账户 → 核验提现资格 → 准备申请，右上角 1/3…3/3）+ 进度条。结果最早 4.4 秒、且服务器返回后才显示（通过=蓝色对勾，不能提现=琥珀色提示），停 0.8 秒后幕布打开，露出表单或原因说明。
- 卡片高度在检查开始时量一次；上一次的结果提示此时正在收起，测量时减掉它的高度，否则卡片会按旧高度居中、偏到下方。
- 内容出现动画只播放一次（`playContentReveal`），不再带模糊；钱包页隐藏时内容高度量出来是 0，会被忽略，所以切回钱包页时面板不会再从 0 下拉展开。中途切走再切回也不会重播幕布合拢。
