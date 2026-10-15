# 聊天工作区：「模擬客戶」与「經理」

| 后台导航 | 组件 | `source_type` |
|---|---|---|
| 模擬客戶 | `CustomerServiceManagement.tsx` | `aaa_service` |
| 經理 | `CccServiceManagement.tsx` | `ccc_service` |

员工端两个工作区都在 `src/components/employee/CustomerServiceChat.tsx`。

## 数据结构
- `simulated_customers`：聊天角色（客户/经理），可设 `is_super`、头衔、徽章、VIP、自定义头像，按管理员隔离。
- `customer_employee_conversations`：聊天消息（客户 ↔ 员工配对）。打开会话用 `get_or_create_service_session`（表 `customer_service_sessions`）。
- 相关表：`rich_card_contents`（冻结的富卡内容）、`cs_message_templates`、`customer_auto_messages`、`customer_auto_message_logs`、`rating_requests`、`service_ratings`、`ccc_conversation_annotations`。
- 消息类型：`text`、`image`、`rating_request`、`rating_result`、`tip`、`rich_card`。

## 后台功能
- 超管用 `AdminGroupPicker` 选择要查看的管理员工作区（未读多的排前面，并预取前 4 组）；二级直接进入自己的工作区。分组的会话数直接用 `get_admin_groups_for_customer_service` 的 `conversation_count`；各组未读数和后台顶部聊天角标都用 `get_admin_chat_unread_counts(p_admin_session_token)`（`fetchAdminChatUnreadCounts()`，在数据库内计数，只算同组会话，二级只看到自己组）。实时事件触发的刷新是节流（最多每秒一次），不是防抖，持续来消息也不会一直推迟。
- 消息每页 50 条；图片存 `chat-images`；自定义头像存 `super-customer-avatars`（`CustomerAvatarPicker` 只返回 `customer-avatar:regular|vip:<index>` 这类虚拟键）。
- 打赏：`send_customer_service_tip_atomic`（财务 RPC，需要会话 token 与操作编号），流水记在 `wallet_transactions`。
- 范本：`cs_message_templates`（按管理员 + `source_type` 分区）。`CustomerAutoMessages.tsx` 管理每个客户的快捷内容（`quick_send` / `rich_card`）——这不是定时自动化；员工登录时会自动发送已启用的自动消息。
- 富卡冻结：发送时写入 `source_template_id`，数据库 `BEFORE INSERT` 触发器把范本 HTML 复制到 `rich_card_contents` 并设 `content_frozen=true`。之后修改范本不会改变已发出的卡片。
- 修改/删除：单条消息、整段对话、删除客户、范本、自动消息都走 `mutateAuditedContent`（`chat_edit`、`chat_delete`、`conversation_delete`、`customer_delete`、`template_edit` / `template_delete`、`auto_edit` / `auto_delete`），留证进入「內容稽核總覽」。
- 已读：浏览器端只能更新 `customer_employee_conversations` 的 `is_read`、`read_at` 两列（正式库列级权限），不能直接改消息内容。
- 后台发文字：消息 id 在浏览器用 `crypto.randomUUID()` 生成并随 INSERT 写入；发送中的消息放在 `pendingImageMessagesRef`（与上传中的图片共用），`pendingConfirmAfterRef` 记下 INSERT 返回时的消息加载请求号，只有之后发起的加载才能确认或移除它。这样员工消息与后台发送同时发生时，刚发的消息不会被缓存/旧加载结果暂时盖掉，也不会显示两条。单条删除成功后要同时从这两个 Map 移除该 id，否则删除后的缓存恢复会把它短暂放回来。两个后台页（「模擬客戶」「經理」）做法相同。

## 缓存与实时
- `src/lib/serviceWorkspaceCache.ts`：按管理员 + 工作区缓存分组、客户/员工与会话摘要；组件另按 `customerId:employeeId` 缓存消息。
- Realtime：`customer_employee_conversations` 的 INSERT/UPDATE/DELETE → 短延迟刷新，另每 15 秒兜底刷新工作区摘要；后台已打开的会话也每 15 秒兜底刷新消息与已读状态（页面不可见或正在翻看旧消息时跳过）。
- 频道名都经 `uniqueRealtimeChannelName()`（`src/lib/realtimeChannel.ts`）加唯一后缀，重建订阅时不会复用正在关闭的同名旧频道。
- 后台摘要用 `fetchConversationSummaryRows()` 分页读 `get_ccc_conversation_summaries`（每页 1000 行，正式库单次上限也是 1000）；单个客户的会话列表也走这个 RPC，不再把全部消息拉到前端统计。
- `simulated_customers` **不在** Realtime publication 中，组件里对它的订阅收不到事件。
- 不要在前端下载消息行再计数，也不要把整组员工/客户 ID 放进 `.in()`：PostgREST 单次最多返回 1000 行，约 500 个 ID 时请求 URL 过长直接失败（测试分支实测）。需要计数时在数据库里算。

## 规模测试（2026-10-09，Supabase 测试分支，测完已删除）
- 数据：20 个管理员组、3,000 名员工、400 个客户/经理、约 99 万条消息（最大单会话 2,488 条）。
- 查询（迁移 `20261101000002_scale_service_chat_queries.sql` 之后，数据库内耗时）：打开会话 0.1–0.2 ms；员工会话列表 3–30 ms；后台会话摘要 23–52 ms；分组列表约 0.2 s（原 1.9–4.8 s）；分组未读计数 24–47 ms。
- 实时：300 名员工同时在线 + 3 个后台各 7 个全表监听（后台送达只统计每个后台的第 1 个监听）；每秒 10–50 条时送达约 0.6–1.1 秒，未丢失、未重复、未错发。每秒 100 条的突发下延迟升到约 6–10 秒；首轮有少量实时推送未及时到达，加入与员工端相同的重连补拉后全部送达——只测了两轮，这种速率下要靠补拉兜底，不保证实时推送从不遗漏。人为断开 30 名员工的网络后全部自动重连，并通过补拉找回断线期间的消息。标记已读后，员工端与后台监听都收到了全部已读更新。300 名员工每 30 秒错开刷新会话列表无报错。
- 迁移注意：只加了 `(employee_id, customer_id, created_at DESC)` 一个索引。再加 `(customer_id, employee_id, created_at DESC)` 测不到收益；不改写摘要函数时，加索引反而让旧版后台摘要从约 70 ms 变慢到 0.2–2 s。
- 结果一致：改写的两个函数以正式库现行定义为准（不是仓库里未执行的 `20260905015900`，见 `docs/database.md`）。测试分支上 40 个「管理员 × 工作区」组合共 26,061 行摘要、分组列表 3 种模式与旧版完全一致；`npm run test:service-chat` 在本地重复这项对比。
- 测试局限：Supabase 测试分支自动建库失败，相关表、索引、策略、触发器与函数是按正式库只读查询手工重建的；管理员会话验证用了简化替身。压测是合成数据 + 脚本客户端，不是真实账号的浏览器端到端测试，也不代表正式环境容量上限。
- 部署：`20261101000002` 已于 2026-10-10 部署正式库（版本 `20261009173803`），部署前后正式数据上的会话摘要与分组结果逐行一致。前端依赖其中的新 RPC `get_admin_chat_unread_counts`；在其他环境（如新测试库）必须先执行这个迁移再上线前端，否则后台聊天未读角标与分组未读数读不到。

## 真实浏览器端到端测试（2026-10-10，正式库 + 本地预览）
- 方法：Playwright + Chromium（需在开发容器里安装 `libnss3` 等系统库）打开本地预览，用超管 ada66 与专用测试员工 `qa_cs01`–`qa_cs03`（不在任何自动化方案中，不会触发奖励）、测试客户「QA測試客戶」（aaa）与「QA測試經理」（ccc）登录真实页面操作。账号密码只通过环境变量传入，脚本放在被 git 忽略的 `qa.local/`。
- 结果（两个工作区均测）：后台发送→员工悬浮按钮未读数 0.6–1.1 秒；打开面板列表 < 0.1 秒、会话 < 0.6 秒，均不空白；员工看到后后台显示「已讀」约 0.6–3 秒；员工回复→后台约 0.9–2.2 秒。三名员工同时在线（含 390px 手机尺寸）各自只收到自己的消息。断网 45 秒（面板关闭或会话打开）、页面冻结 90 秒（模拟手机切到后台）、分页隐藏 45 秒、闲置 4 分钟后，消息都在恢复后 0.01–3 秒内出现，无需重新登录。后台「模擬客戶」角标在员工回复后约 2 秒 +1，打开会话后约 0.8 秒恢复。双向各 8 条快速连发与双向图片：两端全部显示、无重复、顺序正确。数据库核对 100 条测试消息：0 重复、0 未读残留、0 错工作区、0 跨组。各页面除故意断网期间的网络错误外没有控制台错误或失败请求。
- 测试中发现并修复：员工消息与后台发送几乎同时发生时，后台刚发的消息会短暂消失（8 轮中 5 轮，多为 0.2 秒；极端时可能到下次 15 秒兜底刷新）。修复后两个工作区各 10 轮同样的竞态测试均为 0 消失、0 重复。消息从未丢失（已写入数据库，员工也已收到）。复查这项修复时发现：发出后约 1 秒内删除，消息会在出现「聊天訊息已刪除」后仍显示到重新加载完成；已修正，两个工作区各 2 轮实测删除提示与消息消失同时发生、之后不再出现，内容稽核均留证。单条删除经 `content-audit` 留证约需 2–5 秒，期间按钮显示「刪除中…」。
- 局限：只用了 3 个测试员工和 1 个管理员；headless Chromium 模拟手机尺寸与后台冻结，不等于真实 iOS/Android 浏览器。

## 员工端 `CustomerServiceChat.tsx`
- 会话摘要用 `get_employee_conversation_summaries`（只返回与员工同组管理员的客户；员工属超管时不限）。客户 `source_type` 在页面内缓存。
- 已读：只有面板打开、页面可见、确实有未读时，才把截至屏幕上最新一条的客户消息标为已读。
- 可靠性：订阅失败/断开会退避重订阅，重连后补拉列表和当前会话；另有兜底刷新（面板打开每 30 秒、关闭每 5 分钟，刚刷新过则跳过；切回页面或网络恢复时补拉）。列表或消息加载失败显示「加载失败 + 重试」，不再误显示为「暂无会话/暂无消息」。工单号每个会话只请求一次。
- 消息刷新以屏幕上的消息为准合并：保留已翻出的旧页和发送中的消息；发送结果与实时推送同时到达时不会显示两条。
- 员工可发送文字、图片、评分请求；富卡内容从 `rich_card_contents`、范本或自动消息读取，净化后显示；评分结果与打赏以卡片显示，员工端没有发起打赏的入口。
- `QuickCopyRichContent.tsx` 用于通知详情等处的一键复制富文本，不是聊天富卡的渲染组件。
