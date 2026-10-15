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
| `src/lib/i18n/` | 员工端与登录页的 10 种语言 |
| `src/types/database.ts` | 手工维护的 Supabase 类型（新增表/RPC 要同步） |
| `src/index.css` | 全局样式与可复用滚动条类 |
| `supabase/migrations/` | 500+ 个按文件名时间戳排序的数据库迁移 |
| `supabase/functions/content-audit/` | 仓库内唯一的 Edge Function 源码 |
| `supabase/tests/*.test.mjs` | 用 PGlite 执行真实迁移的回归测试（内容稽核清理、聊天摘要/未读计数） |
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

**界面**
13. 管理员后台文字直接写繁体中文（不走 i18n）；员工端与登录页文字走 `useLanguage()`，新增键先加 `src/lib/i18n/locales/en.ts`，再补齐其余 9 个语言文件。
14. 显示时间要明确时区：内容稽核与已删员工页统一 UTC+8；`src/lib/dateUtils.ts`、pg_cron、历史清理排程用 UTC；员工端多为浏览器本地时间。
15. 沿用现有深色后台风格与可访问性写法（`aria-*`、`focus-visible`、对话框 `role="dialog"`）。

## 4. 验证
- 每次改动后：`npm run typecheck`、`npm run lint`；较大改动加 `npm run build`。
- 改到聊天摘要、分组会话数、后台未读计数 RPC 或聊天表索引：`npm run test:service-chat`。
- 改到内容稽核/已删员工相关迁移或 Edge Function：`npm run test:audit-cleanup`；Edge Function 语法检查：`npx esbuild supabase/functions/content-audit/index.ts --format=esm --log-level=warning > /dev/null`。
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
- `supabase/config.toml` 没有 `content-audit` 项；部署它时必须保持 `verify_jwt=false`（正式环境现状）。
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
| `docs/CHANGELOG.md` | 每次修改的更新记录（新的在最上面） |
