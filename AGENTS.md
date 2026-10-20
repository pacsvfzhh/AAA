# AGENTS.md · 员工工作平台

> 本文件是 Builder 官方支持的仓库根目录项目说明（AGENTS.md）。每个新对话在动手修改前先读完本文件；改动具体模块前，再读 `docs/` 中对应文档和 `docs/CHANGELOG.md` 最近几条。
> 文档用简体中文书写；界面文字按网站实际显示引用（管理员后台为繁体中文）；代码标识符保持英文。

## 1. 项目是什么
- 员工派单/接单工作平台 + 管理员后台。同一个登录页服务员工和管理员：`src/lib/auth.ts` 的 `login()` 按用户名先查 `admins` 再查 `users`。
- 角色：员工（`users`）；管理员（`admins.role`）：`super_admin` 超级管理员、`secondary_admin` 二级管理员（只管自己名下 `users.created_by` 的员工）、`emergency_admin`（只有「已鎖定」页）。
- 技术栈：React 18 + TypeScript 5（strict）+ Vite 5 + Tailwind 3；图标 lucide-react；富文本 Tiptap 3；HTML 净化 DOMPurify。后端 Supabase：Postgres RPC、Edge Function、Storage、Realtime、pg_cron。
- 没有前端路由：`src/App.tsx` 按登录状态渲染 `pages/Login.tsx`、`components/employee/EmployeeDashboard.tsx` 或 `components/admin/AdminDashboard.tsx`。
- 自建登录，不用 Supabase Auth：浏览器请求都以 `anon` 角色执行，身份靠 RPC 在数据库内验证会话 token（见 `docs/architecture.md`）。
- 正式环境：Supabase 项目 `hxpbpqoqkoiiplvdwmld`。前端按 `vercel.json` 构建，由用户自行部署。Builder 推送会建立 PR——**推送不等于部署**。

## 2. 目录地图
| 路径 | 内容 |
|---|---|
| `src/components/admin/` | 管理员后台各页面（`docs/admin-backend.md`） |
| `src/components/employee/` | 员工端各页面（`docs/employee-portal.md`） |
| `src/components/*.tsx` | 共用组件：ErrorBoundary、LanguageSwitcher、AnnouncementDetailModal、背景装饰 |
| `src/lib/` | 登录会话、Supabase client、上传/净化/设备等工具（`docs/architecture.md`） |
| `src/lib/employeeTransfer/` | 单卷加密/ZIP/清单、七表导出/导入、同名覆盖与独立密文备份、产品目录子阶段及派单/交单导出、导入准备/独立备份、持续DB维护、派单四配置表、交单原文/使用计数、同包停用员工/凭据及精简订单、派单来源成员和已用交单防双计数、资金六表及登录/工时/停工标记、实名15列原文与逐员工事务恢复、受控实际证件媒体传输/映射及通知/广播/范本/自动化13表原文传输与奖励关联预检已实现；通知配置对应/独立密文记录备份及三桶实际媒体/13表业务恢复已实现（第32–33节），聊天十表原文导出/同包暂存及服务端角色合并只读预检已实现（第34节），聊天独立记录备份/确认映射/四桶媒体与十表实际合并已实现（第35节）；档案依赖、全站恢复/自动化续接、协调、多卷与页面仍待实现（未部署） |
| `scripts/decrypt-employee-export.mjs` | Node 20 独立解密迁移加密容器（应急工具，不覆盖现有输出） |
| `src/lib/i18n/` | 员工端与登录页的 10 种语言 |
| `src/types/database.ts` | 手工维护的 Supabase 类型（新增表/RPC 要同步） |
| `src/index.css` | 全局样式与可复用滚动条类 |
| `supabase/migrations/` | 500+ 个按文件名时间戳排序的数据库迁移 |
| `supabase/functions/content-audit/` | 内容稽核 Edge 源码，已在正式环境 |
| `supabase/functions/employee-transfer-media/` | 实名证件、通知三桶及聊天四桶迁移 Edge 源码（index/handler），作用域隔离，仅本地未配置/部署；仓库共两个Edge源码目录 |
| `supabase/tests/*.test.mjs` | 内容稽核、聊天、工时及迁移PGlite/客户端/Edge分层回归；fakeStorage不等于真实Storage验收 |
| `docs/` | 详细说明与更新记录 |

## 3. 硬性规则
**正式环境与数据**
1. 对正式 Supabase 执行迁移、部署 Edge Function、修改 Storage 或权限、删除/修改正式数据之前，必须先讲清影响并取得用户明确同意；每次单独确认。
2. 只读 SQL 核对可以直接做；不得为了测试删改真实数据。
3. 不自行 git commit / push / merge（Builder 自动提交，用户点按钮推送）。同步冲突时保留用户最新意图，并说明取舍。

**数据库**
4. 不改已执行的旧迁移；新增 `supabase/migrations/<YYYYMMDDHHMMSS>_<snake_name>.sql`，文件名时间戳必须大于目前最新的文件（部分文件名时间戳超前于实际日期，只用于排序）。
5. 新 RPC：`SECURITY DEFINER` + `SET search_path = pg_catalog, public, private, pg_temp`；`REVOKE ALL ... FROM PUBLIC, anon, authenticated` 后按需 GRANT（浏览器调用的给 `anon, authenticated`，只给 Edge Function 用的给 `service_role`）；在函数内用会话 token 验证身份，不信任前端传入的 admin id 或角色。
6. 新增或修改表/RPC 后同步 `src/types/database.ts`。

**鉴权与业务**
7. 管理员操作的 RPC 传 `getAdminFinancialSessionToken()`；员工财务操作传 `getEmployeeFinancialSession()` 的 token 与 `tabId`。
8. 钱包、提现、打赏、调账只走 `*_atomic` 等财务 RPC，并用 `createFinancialOperationId()` 生成操作编号；失败重试沿用同一编号。
9. 通知、聊天内容的修改/删除，以及删除客户、员工、管理员，一律经 `src/lib/contentAudit.ts` 的 `mutateAuditedContent()`（Edge Function `content-audit`），不要直接 update/delete 表。
10. 渲染任何 HTML 之前先用 `src/lib/sanitizeHTML.ts` 净化。
11. Realtime 只对 publication 中的表有效（清单见 `docs/database.md`），订阅清单外的表收不到事件。
12. 写操作不要加自动重试；`src/lib/supabase.ts` 只对 GET 与白名单只读 RPC 重试。

**资料迁移约定（待完整实现）**：用户确认新站未营业；派单/交单整批按旧站恢复，不保留目标不同名可用残留。旧站默认分组/各组默认池必须成为新站对应默认对象，完整迁移设置、内容和引用，禁止沿用新站初始化默认池业务值；自动生成的 Base 仅是导入占位，未写入来源全部资料不得算成功（计划第 5.4 节）。先核验未营业及独立备份校验，有真实业务关联则阻断，不强行级联清库。同名非超管及自动化按对应范围来源覆盖，成员精确替换、不取并集；产品按全站唯一名称来源覆盖；这些领域不扩大为全表清空。公告及分类、仅供公告素材不迁移，保留新站现状；员工通知/广播/自动化仍迁移。保留新超管、既定聊天合并及财务/媒体留证，正式执行仍单独确认。七表 replacement 及独立产品目录协议已实现（旧入口不得旁路），产品映射需由后续全站协调使用；派单已新增持续数据库写入屏障和四配置表原子apply，默认组/Base全部业务字段/池内容按来源恢复，目标成员先清空、多余对象退出可用范围；管理员映射只取同包服务器共享回执；交单valid原文/启停/计数/时间已支持备份后清目标、分批插入和完整核对，保留NULL及精度、不重算使用次数。员工/凭据/7列精简订单已可同包原文导出/暂存及恢复停用身份，服务器核验全部内容后才提供对应，缺管理员或同名/ID/员工号冲突阻断，尚未串联现有备份封存替换；成员/used已可在同包身份、配置及valid核验后分批精确恢复，used计数触发器事务内精确旁路/恢复，不再改usage_count/last_used_at；资金六表已可绑定同一身份目录、按员工事务恢复及核对，账本/对账审计重新编号、基准游标换算，pending冻结一致；无基准的老账号保持无基准，不复制financial_operations请求原文或自动修平旧差异。登录/工时/主动停工标记已可同包恢复并全字段核验，旧session_id按来源站/员工脱敏、设备JSON区分SQL NULL/JSON null；进行中工时严格按最后心跳结束（无心跳用开始时间，不加运行时一分钟宽限，分钟四舍五入），已闭合原值不改，不产生自动化/Realtime信号。实名15列与实际证件媒体已完成本地子阶段：同包identity目录及身份/成员/资金/活动实体验证前置，逐员工仅verification_requests写许可、不关trigger/不改users.is_verified，审阅人仅服务器同包admin map；残留/UUID/缺映射/漂移阻断。证件仅本站supabase.co固定verification-documents三目录/所属员工UUID，拒外链/签名参数；service-only authorize/commit、上传不覆写/删除旧文件、实际回读及全部apply后recheckImport+SQLverify，generation绑定读前员工代次。单50MiB/3000文件、记录加媒体1GiB、单卷manifest4096条目，魔数非解码/病毒扫描；SDK上传不能强制中止、失败可能留对象，不自动delete/假回滚。通知13表已可固定原文导出、同包identity/finance绑定暂存与STABLE只读奖励/执行关联预检，不复制投递租约/原始错误；SQL25另完成同名方案/任务/范本对应与成员/多余任务预览、真实历史阻断及独立通知密文记录备份；新私有RLS表与派单备份分离，维护断言仅精确豁免此技术表，sealed取消后保留。明文8MiB/密文9MiB，先独立保存回读认证再上传封存，实际13表含租约/原始错误指纹防漂移；不含媒体，can_apply_configuration仍false。无业务apply/媒体搬迁/自动化恢复，can_restore恒false，不能降级或把checked当成功。其他历史/媒体仍待接，不代表员工或全站恢复完成。精简订单的停用产品/0.01金额/IMPORTED-*编号都是占位，按产品或金额的历史统计不可包含；当天展示标注仍待接。维护不随任务取消/过期自动释放，已写入dirty状态当前无解除/恢复接口，不可正式使用；replacement_ready/full_site_complete仍false，不当全站完成。屏障不等于停用cron或保护Storage，正式停站/任务管控另验；见计划第24–30节（第29节保留历史描述，当前状态见第30节）。公告轮播键的旧共享白名单仍待按排除规则修正，正式迁移前必须验证。

通知最新进展（计划第33节）：SQL26/27及notificationsMedia/RestoreApi已串联三桶文件受控传输/URL改写、独立封存备份门禁、同名配置实际来源覆盖与13表分块历史恢复。方案/任务保持paused并保存来源状态，员工停用、dirty维护不解除；循环外键分阶段链接，投递序列换算且不发消息/奖金。收件留证触发器保持，版本表只在收件块获精确许可；旧证据冲突阻断并逐行核对，编码附件无法识别时显式拒绝，不静默漏文件。自动化截止点/队列续接与全站放行仍待做，未部署。

聊天最新进展（计划第35节）：SQL30–32及chatBackup/MergeApi/Media/RestoreApi已接独立记录密文备份、全部角色显式决定、四桶受控实际媒体与十表分块合并/核对/续接；原文/预检旧接口仍can_restore=false。保留目标角色属性，只按确认追加可见性，NULL数组原文不清空；工单/备注/内容哈希复用，相同消息UUID异内容阻断。消息只精确旁路冻结重写触发器后恢复原模式，其余保护保持；冻结来源快照、链接改写后重算MD5，最终代次回读才verify。头像图片≤5MiB、普通文件50MiB/3000个/记录加媒体1GiB；备份仅记录8/9MiB，不冒充独立完整媒体备份。账号停用/dirty维护不解除，无UI/部署。

**界面**
13. 管理员后台文字直接写繁体中文（不走 i18n）；员工端与登录页文字走 `useLanguage()`，新增键先加 `src/lib/i18n/locales/en.ts`，再补齐其余 9 个语言文件。
14. 显示时间要明确时区：内容稽核与已删员工页统一 UTC+8；`src/lib/dateUtils.ts`、pg_cron、历史清理排程用 UTC；员工端多为浏览器本地时间。
15. 沿用现有深色后台风格与可访问性写法（`aria-*`、`focus-visible`、对话框 `role="dialog"`）。

## 4. 验证
- 每次改动后：`npm run typecheck`、`npm run lint`；较大改动加 `npm run build`。
- 改到聊天摘要、分组会话数、后台未读计数 RPC 或聊天表索引：`npm run test:service-chat`。
- 改到内容稽核/已删员工相关迁移或 Edge Function：`npm run test:audit-cleanup`；Edge Function 语法检查：`npx esbuild supabase/functions/content-audit/index.ts --format=esm --log-level=warning > /dev/null`。
- 迁移当前本地证据（2026-10-19 UTC+8）：34文件分组6058项覆盖；activity-db190项分互斥名称组44（含通知43+回放）/60（活动）/86（实名）全部执行通过，各组跳过仅为分组且合并无遗漏，不声称单次完整文件通过。通知client/API710、foundation49/scope18共777，其余客户端/媒体19文件4279、五库文件326、配置库169、四库文件317，均零失败/取消；多次超时命令不计最终通过。551份SQL仍12旧失败、106表/937列不变，非干净建库证明。聊天6/稽核48/工时6另列；typecheck/lint/build/格式通过。本轮无UI，无真实Storage/浏览器磁盘/全站往返或原生PG/PostgREST并发/anon3秒性能验收，详见计划第31节。
- 通知配置备份本轮证据（第32节）：7迁移测试文件分组1524项（新client/API510、旧通知710、foundation/scope68、双站236按46/44/60/86互斥组）；超时负向过滤命令不计通过。552份SQL仍12旧失败，本地107表/948列；typecheck/lint/build/格式与聊天6/稽核48/工时6通过。仅配置计划/独立记录备份，无媒体/业务apply/启用/维护放行，未部署、无UI或真实Storage/原生PG验收。
- 通知实际恢复本轮证据（2026-10-20 UTC+8，第33节）：四客户端/媒体服务文件902项，新增SQL恢复8项按互斥组4+4通过，foundation/scope70项；554份SQL仍12旧失败、107表/948列不变。聊天6/稽核48、typecheck/lint/build/差异检查通过。SQL媒体为合成服务回执、Edge为fakeStorage，非真实Storage/全站验收；无UI/部署，自动任务续接与全站放行未实现。
- 聊天原文/预检本轮证据（2026-10-20 UTC+8，第34节）：客户端/API67、activity-db合并256唯一用例（新聊天12+旧活动60/实名86/通知计划备份89/恢复8/修正权限1）、foundation/scope72，共五迁移文件分组395项。通知90项组的一条过期断言修正后独立复验，其余89未改；超时98项组不计通过，不称单次全文件/总命令通过。556份SQL仍12旧失败、107表/948列；聊天6/稽核48与typecheck/lint/build/格式通过。无聊天业务apply/媒体搬迁、UI或部署，不代表真实Storage/原生PG/全站验收。
- 聊天实际合并本轮证据（第35节）：七聊天客户端/服务1065、foundation/scope75、activity-db新增18+旧预检契约15共33唯一用例，十迁移文件分层1173项；未重跑其余241项，skip不算通过。旧媒体Edge706、聊天6/稽核48另列；559份SQL仍12旧失败，本地108表/959列。typecheck/lint/build/Edge语法/格式通过。SQL媒体回执与fakeStorage不替代真实Storage/原生PG/PostgREST/anon3秒/多卷/整站或浏览器验收，均未部署。
- 界面改动要在预览中实际操作。本环境的浏览器自动化不可用，且预览需要登录账号；无法实测时要明说，并请用户验证。

## 5. 文档维护（每次修改都必须做）
- 改动前：读本文件 → 相关 `docs/*.md` → `docs/CHANGELOG.md` 顶部最近几条。
- 同一次任务结束前：
  1. 在 `docs/CHANGELOG.md` 顶部追加一条记录（格式见该文件开头），写明数据库/Edge Function 是否已部署正式环境、前端是否待用户部署。
  2. 改变了功能、流程、表、RPC、权限、定时任务或业务规则 → 同步修改对应 `docs/*.md`。
  3. 新增模块/目录或改变全局规则 → 更新本文件（保持精简，细节写进 `docs/`）。
- 发现文档与代码不一致：以代码为准，顺手修正文档，并在 CHANGELOG 中说明。
- 纯问答、只读检查不需要写 CHANGELOG。
- 文档里不要写密钥、密码、token 或个人资料。

## 6. 已知陷阱
- 未接入页面的旧组件，改了不会生效：`admin/DispatchRecords.tsx`、`admin/SubmitTimeManagement.tsx`、`admin/AutoCleanupSettings.tsx` + `services/autoCleanupService.ts`、`employee/TransactionHistory.tsx`、`employee/WorkSessionTracker.tsx`；`services/orderProcessor.ts` 是空文件。
- 正式环境另有 `process-orders`、`cleanup-dispatch` 两个 Edge Function：仓库无源码，前端未调用（逻辑已移到 RPC）。
- `supabase/config.toml` 仅有两个旧服务，没有 `content-audit` 或新 `employee-transfer-media` 项；前者部署保持 `verify_jwt=false`（正式现状）。后者未配置/部署，未来须单独说明影响并确认以 `verify_jwt=false` 部署（内部验证session/job），本轮不改config、不放宽桶权限。
- 超管可在「導航設定」改导航文字和顺序（存于 `system_configs.admin_navigation_preferences`），正式环境显示的文字可能和代码默认值不同。
- `vercel.json` 的 CSP `connect-src` 只允许本站与 `*.supabase.co`；接入外部 API 必须同步修改。
- 员工改密码：前端要求 ≥8 位且含字母与数字，数据库 RPC 只要求 ≥6 位。
- `VerificationForm` 把身份证号存进 `verification_requests.wallet_address`、地址存进 `email`（历史字段沿用）。
- 正式库安全现状（2026-10-09 核对）：`orders`、`announcements`、`product_types`、`verification_requests`、`admin_configs` 的 RLS 策略允许 `anon` 任意增删改；`verification-documents` 存储桶是公开桶。详见 `docs/database.md`。
- `bolt/`、`full_diff.txt` 是旧模板与差异文件的残留，代码未引用；`supabase/health_check.sql` 已过时。

## 7. 与用户沟通
- 用简体中文、少用术语、先讲结果；用户是网站运营者（超级管理员），不是开发者。
- 涉及正式环境或删除数据的操作，先讲清范围和影响，再请求确认。

## 8. 文档索引
| 文件 | 内容 |
|---|---|
| `docs/architecture.md` | 启动、登录与会话、数据访问与错误处理、`src/lib` 工具速查、样式与构建部署 |
| `docs/admin-backend.md` | 后台导航与各页面：员工、搜索、登录纪录、锁定、管理员、设定、提款、身份验证、派单、产品、交单数据、历史资料 |
| `docs/employee-portal.md` | 员工端：派单接单、提交订单、统计、钱包提现、验证与密码、通知中心已读规则、多语言 |
| `docs/notifications.md` | 后台通知发送/范本/投递、通知来源、删除员工时的通知处理、通知自动化、公告与富文本媒体 |
| `docs/service-chat.md` | 「模擬客戶」「經理」聊天工作区、富卡与快捷消息、评分打赏、员工端聊天 |
| `docs/content-audit.md` | 隐藏稽核页、「內容稽核總覽」与「已刪員工紀錄」、留证与永久删除流程 |
| `docs/database.md` | 核心表、RPC 与安全约定、正式环境安全现状、迁移、定时任务、存储桶、Realtime、Edge Function、测试 |
| `docs/employee-data-transfer-plan.md` | 全站业务迁移计划与进度：已开始基础实现，完整功能未完成/未部署；默认全部、保留新超管、精简历史订单、配置/自动化、真实进度与验收 |
| `docs/CHANGELOG.md` | 每次修改的更新记录（新的在最上面） |
