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

## 全站迁移的只读来源档案（2026-10-20，本地未部署）

- SQL33/34新增独立 `private.employee_transfer_archive_records`，保存原稽核、已删账号、通知及收件版本，另固化旧档案页使用的员工摘要/提款四项记录。按来源站和包隔离，保留原员工与历史操作者身份；不插入既有私有档案表，不联查目标活账号，不重放删除或清理，也不新增删除能力。
- 原行、金额精度、微秒及SQL NULL/JSON null保留；仅剔除明确凭据/投递领取字段，非秘密历史时间保留。先完整验证、原任务维护绑定暂存、显式分块恢复及实际核对，失败不假称全量回滚。
- 超管只读 `get_employee_transferred_archive_page` 在记录核验后可用，取消/过期后仍独立核验持久化记录，无需暂存。SQL35/36及「遷入檔案」第三页签现已本地接通私有附件与来源站/包分页查看，不混入原两页，不新增删除或还原能力。附件逐事件/ref绑定授权，Blob字节/类型/哈希核验后显示；收起、切页和卸载撤销Blob URL。HTML及原URL只作文字显示，金额原文不重序列化。
- `employee-transfer-media` 新增独立archives scope；私有桶不开放给浏览器，来源原文/media_refs不改，目标文件路径由服务端生成，绑定来源站/包/事件/原行摘要/ref原文及实际字节摘要。完整回读后媒体子阶段才verified；原SQL33/34记录回执仍media_pending=true，不能冒充媒体或整站完成。`archiveBundle.ts`将六表及真实附件单卷加密保存、完整回读认证，再允许导入；中断后显式核对已提交状态，不重新begin或假称全量回滚。
- SQL38/`archiveReexport.ts`已可全量盘点迁入命名空间并逐来源独立加密再次导出，保留最初来源站/包、原始行和附件身份；缺记录/媒体核验的来源整批阻断，导出前后复核快照与全量目录，全部卷最终重读检测保存位置复用/覆盖。**尚未串通本站原生档案统一打包或多来源再次导入**；已有迁入快照时原六表导出继续阻断，不静默漏档案。原 `content-audit` Edge、既有封存/永久删除流程、桶权限和cron均未改。详见计划第38节；未部署SQL/Edge/前端，无真实Storage或原生PG/整站验收，本轮无UI改动或浏览器操作。

## 员工替换前独立备份：记录与附件的区别（2026-10-21，本地未部署）
- SQL46/`employeeSafetyBackup.ts`可在任何导入配置变更前独立读取并加密员工核心及聊天、通知/自动化、派单依赖和员工相关稽核/通知收件证据，共48类固定投影。原SQL39必须依赖配置已恢复的导入任务，不能把它误当作覆盖前保护。
- 通知稽核事件的employee_id通常为NULL，依消息和before/after收件快照精确关联；共享通知原始留证不会为了个人范围裁剪或改写，可能包含同一通知其他收件人的历史证据。不会混入其他员工个人聊天、收件、进度，不接受同名历史档案扩大员工UUID范围。
- SQL46记录v1包含实际记录及附件引用，不包含实际证据/证件/聊天文件，`media_included:false`不变；**不是完整可恢复员工备份，没有封存证明或替换授权。** 独立本机reader认证48表后可逐表读取，不能写库、调用删除、解封账号或解除维护。任务停止需独立密码与确认语，只清本人技术任务，不删已保存加密文件。
- 第43节已接独立记录页，第45节改为「導入前：獨立員工記錄與附件備份」：同一SQL46任务内记录保存/认证后不立即close，继续SQL47附件独立保存/认证，再成对核对两份密文及清理，最后复核来源附件和记录才显式close。记录与附件两份.edx使用同一口令，必须一起保留，零附件也保存可核验的独立附件目录卷。未知结果互锁其他迁移但保留本人stop，报告IO可单独取消。此页面不调用`archive_employee_without_media`或`mutateAuditedContent`，不把文件核验当封存许可。
- 第44节SQL47/`employeeSafetyMedia.ts`另加本人同一SQL46任务的独立附件库，先完整认证记录密文、重扫48类原文/摘要/精确引用并对照inventory才下载；附件.edx绑定精确记录密文SHA/大小/卷元数据与完整catalog，全部认证/字节魔数/清理后再实际源复核。成对本机reader也重扫原文，已修复“删文件及匹配manifest仍自洽”的遗漏并补合法重加密回归，伪造row/ref身份同样拒绝。
- 附件作用域四kind固定桶，只下载/源复核；authorize/commit仅service_role，inventory/verify为STABLE会话鉴权。档案`media_refs`原键只作不透明历史身份，不当网络目的地；实际路径只取固定私有`content-audit-evidence`，不借外链或同名档案扩权。跨行/字段同路径保留不同引用，同一行同一字段重复URL去重；未知/编码/外部媒体阻断不漏项。头像5MiB、文件50MiB、3000引用、记录加媒体1GiB，非完整恢复或病毒扫描。
- 附件库不自动stop/close；第45节页面已按上述顺序显式调用旧SQL46 session.close，无新增服务授权。Abort/响应丢失不重试/删除/回滚或假关闭，清理失败阻断成功。报告employee-backup-report.json仅白名单技术字段及两个文件独立回执，不含记录原文、媒体路径或不透明身份。成对核验通过也不表示最后源检查或任务关闭已确认。`completeEmployeeBackup/canArchive/canReplace/fullSiteComplete`恒false；跨域UUID/全部引用恢复、封存安全窗口及受控完整恢复仍缺，不得自动封存/覆盖或解除维护。
- `archive_employee_without_media`、`content-audit`及既有删除/留证/清理流程未改，未调用封存或接通同名员工覆盖。无正式环境访问或SQL/Storage/config/Edge/前端部署调整；第45节双浏览器合成RPC/fetch/IO搭配真实客户端/加密/成对reader，108个独立场景（含父组110项）通过；没有真实Storage、原生目录或PG并发验收，证据与后续见计划第44–45节。

## 员工新身份转换准备（第46节，2026-10-22，本地未部署）
- `employeeIdentityProjection.ts`读取已认证的记录+附件双包，针对业务员工UUID及虚拟复合键生成本机只读投影；两个audit表和管理员身份元数据仍是完整原始字节，不把历史employee_id/实体快照/收件版本/media_refs改成新在职员工。
- 未改变附件URL/原路径，也不把留证文件当成已搬迁。源文件不写入或删除，无数据库恢复/身份预留/封存能力，`canRestore/canArchive/canReplace`恒false；共享依赖、其他业务ID冲突及档案命名空间尚需恢复器处理。
- 所有投影工作区只在回调期间可读，退出即撤销reader；清理超时或取消后未确认清理会拒绝成功。既有`archive_employee_without_media`、content-audit及维护拦截不变，未接入替换页面、未访问正式服务或部署。

## 服务端候选身份与留证边界（第47节，2026-10-22，本地未部署）
- SQL48/employeeIdentityReservation在真实原导入任务内固定服务器选出的候选员工UUID，只写私有技术暂存/审计；状态保留SQL37观察和全部旧封存阻断。候选不是users全局占位，也没有绑定SQL46/47完整密文，不构成覆盖前备份证明。
- `can_restore/complete_employee_backup/can_archive/can_replace/full_site_complete`恒false；既有archive_employee_without_media、content-audit、维护拦截与历史UUID/留证均不变。真实封存会改变目标指纹，当前只报告漂移，不自动批准或改写保存的映射。
- 本地实际封存/原UUID保留/旧SQL15恢复拒绝回归已通过；封存窗口和所有域新身份实际恢复仍未完成，无正式服务访问/部署或UI/浏览器改动，详见计划第47节。

## 候选UUID实际身份恢复与封存隔离（第48节，2026-10-22，本地未部署）
- SQL49/employeeMappedIdentity已能在服务器候选UUID下实际恢复停用账号、凭据和精简订单；任何未清同名封存历史、同名活员工或源UUID占用仍阻断，不调用archive_employee_without_media/content-audit，不重写原封存UUID、稽核行/媒体或通知留证。
- 该阶段verified只核对账号/凭据/订单，不是SQL46/47精确双密文的完整备份证明；不填旧identity_restore/verified_identity_map，不解锁旧依赖恢复器或覆盖/启用/维护解除。完整备份/封存/替换/放行恒false，其他领域新身份和安全封存窗口仍需完成。
- 本地真实现有封存流程产生历史后，新入口仍拒绝；新DB75/客户端417与相关七专项885/885、整站28/28通过，实际client丢core响应只能显式status后继续。无正式服务访问/部署或UI/本轮浏览器测试；详见计划第48节。

## 新UUID派单依赖与封存隔离（第49节，2026-10-22，本地未部署）
- SQL50/employeeMappedDependency只在全包SQL49停用身份、配置/valid及真实封存备份/dirty维护核验后恢复来源成员和used，员工归属改服务器候选UUID；不写原封存UUID、稽核事件、收件版本或历史媒体，不调用任何封存/删除流程。
- 独立mapped-dependencies-v1状态不伪造旧verified map，完整恢复/备份/封存/替换/放行恒false；两表verified不是SQL46/47双密文恢复证明。未来资金及其他领域映射、安全封存窗口仍未完成，旧同名活账号/未清封存历史阻断不变。
- 新数据库145项（含真实客户端丢响应及零员工包）、客户端/基础范围718项、旧整站维护态28项本地通过；无UI改动或本轮浏览器测试，无正式服务访问或SQL/Edge/Storage/config/前端部署，详见计划第49节。

## 新UUID资金恢复与留证边界（第50节，2026-10-22，本地未部署）
- SQL51/employeeMappedFinance仅在已核验SQL49新身份、SQL50依赖和真实备份/dirty维护前置下，按候选UUID逐员工恢复六表资金，包含全部提款及pending冻结。新阶段guard同时重验身份/订单/派单和资金，不删除旧零钱包检查、不修改原员工/档案UUID、稽核或收件留证，不调用封存/删除能力。
- ledger.source_id仍是流水/提款UUID，合法已删原行的历史事件保留；发现存在却跨员工的引用会阻断，不清除证据来迁就导入。资金verified仅本子阶段，不是SQL46/47双密文完整恢复证明，封存/替换/启用/营业门禁恒false；其他领域映射及安全封存窗口仍待做。
- 新DB194分组全覆盖、客户端/基础范围1034及SQL51旧整站28项通过，无UI改动或本轮浏览器/正式服务访问和SQL/Edge/Storage/config/前端部署；详见计划第50节。迁移DROP仅移除函数，不撤销资金、删除历史或解除维护。

## 新UUID登录工时恢复与留证边界（第51节，2026-10-22，本地未部署）
- SQL52/employeeMappedActivity仅在SQL51完整资金verified且身份/订单/派单/资金实物重新通过后，按服务器候选UUID恢复三张活动表；历史员工号/时间/设备和已散列会话保留，未闭合工时按最后心跳收尾。不修改旧封存UUID、稽核/通知留证/档案或媒体，不调用封存/删除，不新增替换能力。
- 活动verified仅本子阶段，不是SQL46/47精确双密文完整恢复或安全封存证明；完整备份/封存/替换/启用/放行仍false、dirty维护不解除，其余引用与安全封存窗口未完成。
- 新DB60分组全覆盖、新旧客户端/基础范围1342、最新SQL52旧整站28项本地最终通过；无UI/本轮浏览器、正式服务访问或SQL/Edge/Storage/config/前端部署，详见计划第51节与回滚参考。

## 现状（2026-10-09）
- 超管已清空两个板块：稽核记录、已删员工档案与通知、私有证据文件、确认暂存、待重试任务均为 0。

## 新UUID实名记录与证件媒体边界（第52节，2026-10-22，本地未部署）
- SQL53/employeeMappedVerification(+Media)仅在SQL52活动verified且此前各阶段实物重验通过后，按服务器候选UUID恢复实名15列记录和固定verification-documents实际证件；不修改`users.is_verified`、旧封存UUID、稽核/通知留证或档案，不旁路触发器，不新增替换能力。
- 媒体只做upload/recheck-import，upsert=false、实际回读，不覆盖/删除旧文件；不确定须新会话显式对账。实名verified仅本子阶段，不是双密文完整恢复或安全封存证明；完整备份/封存/替换/放行false、dirty维护不解除。
- DB1–20组最终20/20，其余分组仍在运行、尚未计入；详见计划第52节与仅DROP函数的回滚参考。
