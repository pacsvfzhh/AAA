# 内容稽核与已删员工纪录（超管隐藏功能）

## 入口
- 超管 →「歷史資料」→ 标题「歷史資料管理」左侧的数据库图示，1.1 秒内连点三次 → `ContentAuditPanel.tsx`。「返回」回到历史资料；离开该导航页即退出。
- 面板内切换两个板块：「內容稽核」（标题「內容稽核總覽」）与「刪除員工」（标题「已刪員工紀錄」，组件 `DeletedEmployeesPanel.tsx`）。

## 分类规则
| 操作 | 去向 |
|---|---|
| 修改/删除管理员手动通知 | 內容稽核總覽（通知異動） |
| 修改/删除单条聊天、删除整段对话、删除客户、修改/删除富卡来源 | 內容稽核總覽（模擬客戶 / 經理） |
| 删除员工账号（单独删除，或随管理员一起删除） | 已刪員工紀錄：账户资料、提现记录、通知档案、两个工作区的聊天 |
| 删除系统自动通知 | 不留证 |

- 旧的「歷史清理」板块已经移除。

## 留证流程（普通的修改/删除）
1. 前端 `mutateAuditedContent(action, ids, payload)` → Edge Function `content-audit`（请求 body 带 `sessionToken`）。
2. `prepare_content_audit_change` 取快照与 hash → 把相关图片复制到私有存储桶 `content-audit-evidence` → `commit_content_audit_change` 重新核对 hash、权限与附件清单，写入证据后再修改或移除即时数据。
3. 公开原图只有在不再被任何内容引用时才删除（`recheck_content_audit_public_media`，每批核对 5 个）。
- 只接受本项目 Storage 的公开路径（`chat-images`、`template-images`、`announcement-images`、`super-customer-avatars`），拒绝外部 URL 与含 `.`、`..` 的路径。

## 超管永久删除（两段式）
1. 准备：`prepare_content_audit_delete`（单条或按筛选批量）、`prepare_content_audit_conversation_delete`（整段对话）、`prepare_deleted_employee_archive_delete`、`prepare_unpurged_archived_employee_delete` → 生成确认任务（job），绑定管理员与会话 token hash，并有过期时间。
2. 执行：`finish_*` 删除数据库证据、设置 `finished_at`、记下要删的文件 → Edge Function 删除私有证据文件和不再共用的原图 → `complete_*` 删除 job。

job 的两种状态：
- `finished_at IS NULL`：只是确认预览。关闭、取消、按 Esc、切换或离页时，前端调用 `cancel_confirmation`（RPC `cancel_audit_deletion_confirmation`，只限同一超管、同一会话）。pg_cron `collect-audit-deletion-confirmations` 每分钟清除过期或目标已不存在的预览；执行 finish 时也会顺带回收。
- `finished_at IS NOT NULL`：资料已删除、附件可能还没清完——**不可删除**。界面显示「完成上次刪除」或「點此重試清理」。

其他规则：
- 回收、取消与执行共用锁 `pg_advisory_xact_lock(hashtext('content-audit-purge-media'))`。
- 永久删除后不保留封存内容，也不保留清理凭证（`20261028000000_remove_audit_cleanup_receipts.sql`）。
- 仍会保留：被范本或其他内容引用的共用素材；`private.content_audit_public_media_claims` 中 `job_id IS NULL` 的路径安全标识（防止路径被重用，不含内容）；`private.content_audit_recipient_versions` 中仍存在的通知的收件快照。
- 已删通知在财务操作记录中的标题与正文会被清除（`redact_deleted_notification_send_content`），只保留 hash 与金额。

## 查看
- 异动列表每页 30 条（往下滚动加载）；整段对话每页 100 条，翻页只刷新右侧聊天区，失败时保留原页并可重试。
- 已删员工：账户每页 30 条；聊天证据每次取 100 条；通知档案每页 20 条。
- 私有附件：`loadAuditedMedia(eventId, path)` → Edge action `media`，核对事件未清除且路径属于 `media_refs` 后返回 Blob（png/jpeg/webp/gif/mp4），不发长效签名链接。
- 时间统一显示 UTC+8（Asia/Taipei）；HTML 一律净化后显示。

## 关键位置
- 前端：`src/components/admin/ContentAuditPanel.tsx`、`src/components/admin/DeletedEmployeesPanel.tsx`、`src/lib/contentAudit.ts`。
- Edge Function：`supabase/functions/content-audit/index.ts`（正式环境 v14，`verify_jwt=false`，身份由 RPC 验证会话）。
- 迁移：`20261002000000_protect_manual_notifications_and_service_chats.sql` 起；`20261008000000_audit_deleted_employee_accounts.sql`；`20261014000000` 至 `20261030000000_reclaim_audit_deletion_confirmations.sql`。
- 私有表：`private.content_audit_events`、`content_audit_recipient_versions`、`content_audit_purge_windows`、`deleted_employee_accounts`、`deleted_employee_notifications`、`content_audit_delete_jobs`、`deleted_employee_delete_jobs`、`employee_chat_image_deletion_claims`、`content_audit_storage_origins`、`content_audit_public_media_claims`。
- 测试：`npm run test:audit-cleanup`（48 项，用 PGlite 执行真实迁移；不覆盖真实 Storage 与并发）。新增相关迁移时，要把文件加进测试的 `files` 清单与 fixture 顺序。

## 现状（2026-10-09）
- 超管已清空两个板块：稽核记录、已删员工档案与通知、私有证据文件、确认暂存、待重试任务均为 0。
