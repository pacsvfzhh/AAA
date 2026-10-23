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
| `src/lib/employeeTransfer/` | 单卷加密/ZIP/清单、七表导出/导入、同名覆盖与独立密文备份、产品目录子阶段及派单/交单导出、导入准备/独立备份、持续DB维护、派单四配置表、交单原文/使用计数、同包停用员工/凭据及精简订单、派单来源成员和已用交单防双计数、资金六表及登录/工时/停工标记、实名15列原文与逐员工事务恢复、受控实际证件媒体传输/映射及通知/广播/范本/自动化13表原文传输与奖励关联预检已实现；通知配置对应/独立密文记录备份及三桶实际媒体/13表业务恢复已实现（第32–33节），聊天十表原文导出/同包暂存及服务端角色合并只读预检已实现（第34节），聊天独立记录备份/确认映射/四桶媒体与十表实际合并已实现（第35节）；只读档案六表原文及独立来源命名空间分块恢复/核对已实现（第36节）；档案私有附件/加密单卷/只读视图已本地接通，employeeReplacement仅只读前置风险/状态；迁入档案多来源独立加密再导出及员工15表核心记录独立加密备份已接通（第38节）；十领域验证版导出/加密索引/本机整组核验、浏览器磁盘及超管迁移入口已接（第39节）；十域真实维护态导入/五份独立配置记录备份/前置漂移复核及公告轮播排除已接（第40节）；维护态数据库向导/逐计划及角色可见性确认/安全结果报告已接（第41节）；配置变更前独立48类员工关联记录加密备份/本机认证reader/失令牌本人停止及记录页已接（第42–43节）；SQL47独立附件加密备份/原文引用重扫/成对reader及双文件页面串联已本地接（第44–45节），记录包v1及全部完整恢复门禁不变；第46节已补认证双包的员工UUID无损本机转换（非DB恢复/授权），第47节SQL48已补服务器候选UUID/任务源目标指纹冻结及漂移预检（非users全局占位/备份证明）；第48节SQL49已接新UUID停用账号/凭据/精简订单实际写入核验（同名活账号/封存历史仍阻断，不填旧verified map），第49节SQL50已接同一新UUID下派单成员/used恢复及防双计数（全包身份实物重验、独立状态，不解锁旧财务路径），第50节SQL51另接新UUID资金六表/全部提款事务恢复与阶段化身份派单资金实物核验（不改49/50零钱包保护、旧verified map不写）；第51节SQL52已接新UUID登录/工时/停工三表及完整资金verified前置、全部前置实物重验（最后心跳收尾、不写旧活动状态）；第52节SQL53已接新UUID实名15列记录及实际证件媒体独立阶段（仅映射user/审阅人/非NULL URL，不改is_verified，不写旧状态，无UI/协调器）；第53节SQL54已补新编号通知/奖励/自动化的目录绑定、13表原文暂存与只读关联准备（SQL53 verified及48–53实物重验，仅私有staging，无permit/summary变化，不是实际通知恢复）；第56节SQL57已接空站主线离线放行/来源启停与自动化原状态续接；不要求联网核验旧站或跨站交接锁，旧站由用户自行停用。原生/迁入档案统一编排及再次导入、密文与服务器映射认证/其余实体及引用恢复、同名专用彻底替换、跨会话安全续接与容量多卷等仍缺，full_site_complete=false（本地未部署） |
| `src/lib/employeeTransfer/siteTransfer.ts`、`siteExportApi.ts`、`browserStorage.ts` | 十领域真实串行导出、开始/结束快照及密文复核、10卷+加密索引、本机11文件核验和实际OPFS/目录保存；第55节已接source_cutover进入加密index、reader重算PG摘要/绑定来源站，非远程签名或营业许可；日常备份仍只读、不自动停站，can_import/importReady/fullSiteComplete=false；仅本地未部署 |
| `src/lib/employeeTransfer/sourceCutover.ts`、`src/components/admin/SourceCutoverPanel.tsx` | 第55节SQL56旧站停站切换：现有worker先排空，queue/failures/processing全零，密码+精确确认语建立持久source维护；terminal冻结任务不占单活，十域导出正常，freeze不算最近成功导出。本人超管带当前cutoff_id/密码显式恢复放弃切站，running export阻断、dirty import不可解除；模块级未知写互锁/writeGeneration拒旧status，父页全部导入/导出/备份互锁，读写均不自动重试；不改账号/自动化原状态、进度/activated_at或钱，无新表、不改guard/cron/Storage/Edge，未部署 |
| `src/lib/employeeTransfer/siteImport.ts`、`siteRestoreApi.ts` | 完整11文件认证→SQL57追加能力检查的v3准入→五份独立加密配置/记录备份→十域真实恢复核验；进入维护后和结束各复核前置配置，SQL55重扫实物/最终媒体回执/五份密文。导入本身仍为停用/paused/dirty维护；冻结包在dispatch末绑定cutoff、导入末尾返回闭包releaseSession（token不进报告），日常包无sourceCutover仍可维护态导入但releaseSession=null。独立放行见下行，本地未部署 |
| `src/lib/employeeTransfer/siteRelease.ts`、`src/components/admin/SiteReleasePanel.tsx` | 第56节SQL57 cutoff bind/status/release及导入结果下方显式启用；本人超管原任务/会话/密码/「確認啟用新站」/expected verification hash，真实SQL55复验、同UTC日首尾检查、来源failures及目标queue/failures/processing为零。原子恢复来源账号启停（含NULL）及plan/task状态，active员工仅一次入队、不现场发送/发奖；只清原dirty维护、job finished并保存独立回执，保留staging/备份。跨实例writeGeneration/未知结果fresh status，120秒不重试；未知互锁兄弟入口但保留status，site-release-report.json独立于历史site-import-report。旧站由用户管理，无联网/交接锁/额外旧站勾选；full_site_complete=false，其余pending不关闭，未部署 |
| `src/lib/employeeTransfer/employeeSafetyBackup.ts`、`src/components/admin/EmployeeSafetyBackupPanel.tsx` | SQL46配置变更前独立48类记录备份及导入页入口：原文分页/磁盘加密保存认证/显式close/安全报告，密码确认stop_owned可处理本人丢令牌/过期任务；未知结果互锁其他迁移、报告等待可独立取消。第45节页面已串联同任务记录→附件独立.edx→成对回读/全部清理→最后源检查→显式close，分别显示两文件/成对/close状态，报告v2/pair协议；记录v1/media_included:false不变，完整备份/封存/替换恒false，未部署（第42–45节） |
| `src/lib/employeeTransfer/employeeSafetyMedia.ts` | SQL47/handler独立employee-safety作用域，仅本人同一SQL46任务download/recheck-export；完整认证记录.edx并重扫48类原文/hash/精确引用后才下载，独立附件.edx绑定精确记录密文/元数据/全catalog，全认证/清理/最终实际源复核。成对reader原文重扫已修复自洽漏项并补回归；不自动stop/close，附件后由调用方显式旧session.close，第45节已接双文件备份页但无完整恢复许可，未部署（第44–45节） |
| `src/lib/employeeTransfer/employeeIdentityProjection.ts` | 第46节已认证双包的员工UUID本机投影：精确记录密文二次绑定，固定48表员工字段/虚拟复合键无损转换；金额/员工号/正文/媒体和两个audit表/admin元数据原文不动。输出全表核验，每次open先EOF/hash再64KiB基线块核验，回调退出即撤销reader、全部源/输出限时清理。只读候选数据，不预留服务器UUID/写库/接UI；缺依赖和各域恢复列blockers，canRestore/封存/替换恒false，未部署 |
| `src/lib/employeeTransfer/employeeIdentityReservation.ts` | 第47节SQL48的候选绑定status/reserve：真实原导入任务/来源目录，服务器选择UUID、冻结源与目标指纹，只写既有私有暂存/脱敏审计；重复显式请求同候选，漂移/占用拒绝重置。不占users全局命名空间，尚未绑定SQL46/47密文或接投影/各域apply/UI，恢复/完整备份/封存/替换/放行恒false，未部署 |
| `src/lib/employeeTransfer/employeeMappedIdentity.ts` | 第48节SQL49五显式RPC：真实候选UUID下逐员工停用账号/原凭据事务写入及精简订单分块/逐字段核验；严格计划/任务/候选/计数游标，未知写入只显式status续接，不自动重试，取消后底层未结束仍互斥。只允许无同名活/封存历史的新身份，全部完整恢复/封存/替换门禁false；不写旧identity_restore/verified map，其他领域/备份认证/封存窗口未接，无UI或部署 |
| `src/lib/employeeTransfer/employeeMappedDependency.ts` | 第49节SQL50五显式RPC：全包SQL49实际核验后，新UUID的来源成员/used分块恢复与完整实物核对，保留原valid次数/最后使用时间；严格计划/映射hash/进度/空块，未知写入仅status可续、取消后底层未结束仍互斥，不自动重试。不写旧identity_restore/dependency_restore/verified map，完整恢复/封存/替换/放行false；资金后需阶段化验证，其他领域/双包证明/封存窗口未接，无UI/部署 |
| `src/lib/employeeTransfer/employeeMappedFinance.ts` | 第50节SQL51七显式RPC：独立目录/原文暂存/计划→逐员工六表事务恢复及状态核验，账本/审计重编号、基准游标换算、全部提款/pending冻结与收入公式。新阶段化guard重验身份/派单/资金，旧49/50零钱包防护不动，不写旧summary/verified map；严格冻结/候选/金额字符串/进度，未知apply须同来源status、取消后底层未结束仍互斥，不自动重试。未全stage时status拒绝并安全暂停，早期丢响应/跨会话完整续传未解；完整恢复/封存/替换/放行false，其他域/双包证明/封存窗口未接，无UI/部署 |
| `src/lib/employeeTransfer/employeeMappedActivity.ts` | 第51节SQL52七显式RPC：新UUID登录/工时/停工三表原文恢复，完整资金verified前置及身份/订单/派单/资金实物重验；逐员工事务、最后心跳收尾，设备精度/SQL NULL与JSON null/历史员工号/脱敏会话原值。严格冻结/候选/计数/不倒退，未知apply仅同源status续、取消底层未结束仍互斥，早期未全stage丢响应安全暂停、不自动重试；旧activity状态/verified map不写，完整恢复/封存/替换/放行false，无UI/整站接线/部署 |
| `src/lib/employeeTransfer/employeeMappedVerification.ts`、`employeeMappedVerificationMedia.ts` | 第52节SQL53：新UUID实名15列记录七显式RPC及实际证件媒体（mapped-verification作用域）。严格要求SQL52 verified并实物重验，仅映射user/审阅人/非NULL URL，不改is_verified，仅verification_requests许可、不旁路触发器；媒体仅upload/recheck-import，service-only授权/提交、服务器候选路径、upsert=false、回读、全部apply后终检，50MiB/3000文件/1GiB。不自动重试，未知apply同来源status，媒体不确定须新会话显式对账；独立阶段无UI/协调器，完整备份/封存/替换/整站false，未部署 |
| `src/lib/employeeTransfer/employeeMappedNotifications.ts` | 第53节SQL54四显式RPC bind/stage/plan/status，仅目录/13表原文暂存及员工/管理员/父子/唯一键/真实SQL51奖金关联预检；要求SQL53实名verified并实物重验48–53，只写私有staging，不发permit/改summary，plan/status STABLE无heartbeat。严格深冻结/不倒退/当前会话/共享RPC类型，未知bind显式status核对目录、未知stage须同table+chunk核对原文回执（部分stage可查），写不自动重试、取消后底层未结束仍互斥，120秒等待不改服务端上限。配置UUID有限兼容不代表已对应/允许覆盖；新编号配置对应/独立备份/媒体/13表实际恢复仍缺，全部完整门禁false，四pending为true，员工停用/dirty维护保留，无UI/协调器/媒体Edge修改或部署 |
| `src/components/admin/EmployeeSiteImport.tsx` | 本机检查后独立只读准入、密码/确认语/目录、逐阶段计划和聊天角色/可见性审批、真实进度/边界暂停/停止、非敏感报告；body portal模态，首次开始锁定重跑，不封存或自动启用/解除维护；第56节下方另接SiteReleasePanel显式离线启用，维护回执不改写、放行报告独立保存，完整跨会话token恢复未实现，未部署 |
| `scripts/decrypt-employee-export.mjs` | Node 20 独立解密迁移加密容器（应急工具，不覆盖现有输出） |
| `src/lib/i18n/` | 员工端与登录页的 10 种语言 |
| `src/types/database.ts` | 手工维护的 Supabase 类型（新增表/RPC 要同步） |
| `src/index.css` | 全局样式与可复用滚动条类 |
| `supabase/migrations/` | 500+ 个按文件名时间戳排序的数据库迁移 |
| `supabase/functions/content-audit/` | 内容稽核 Edge 源码，已在正式环境 |
| `supabase/functions/employee-transfer-media/` | 实名证件、通知三桶、聊天四桶及独立私有档案证据迁移 Edge 源码（index/handler），另有仅SQL46任务的employee-safety下载/源复核作用域（第44节），及仅SQL53的mapped-verification上传/复核作用域（第52节），作用域隔离，仅本地未配置/部署；仓库共两个Edge源码目录 |
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
12. 写操作不要加自动重试；`src/lib/supabase.ts` 只对 GET 与白名单只读 RPC 重试。`get_employee_import_*` POST一律不重试，其中dry-run等会固化计划/备份，不因get命名自动重发。SQL56/sourceCutover的freeze/resume及状态读取、SQL57/siteRelease的bind/status/release同样不自动重试，客户端等待120秒不提高服务端上限；未知写入保持跨实例互锁，writeGeneration拒绝迟到旧status解锁，仅写结束后fresh status可核对，status不是新实物核验。

**资料迁移约定（待完整实现）**：用户确认新站未营业；派单/交单整批按旧站恢复，不保留目标不同名可用残留。旧站默认分组/各组默认池必须成为新站对应默认对象，完整迁移设置、内容和引用，禁止沿用新站初始化默认池业务值；自动生成的 Base 仅是导入占位，未写入来源全部资料不得算成功（计划第 5.4 节）。先核验未营业及独立备份校验，有真实业务关联则阻断，不强行级联清库。同名非超管及自动化按对应范围来源覆盖，成员精确替换、不取并集；产品按全站唯一名称来源覆盖；这些领域不扩大为全表清空。公告及分类、仅供公告素材不迁移，保留新站现状；员工通知/广播/自动化仍迁移。保留新超管、既定聊天合并及财务/媒体留证，正式执行仍单独确认。七表 replacement 及独立产品目录协议已实现（旧入口不得旁路），产品映射需由后续全站协调使用；派单已新增持续数据库写入屏障和四配置表原子apply，默认组/Base全部业务字段/池内容按来源恢复，目标成员先清空、多余对象退出可用范围；管理员映射只取同包服务器共享回执；交单valid原文/启停/计数/时间已支持备份后清目标、分批插入和完整核对，保留NULL及精度、不重算使用次数。员工/凭据/7列精简订单已可同包原文导出/暂存及恢复停用身份，服务器核验全部内容后才提供对应，缺管理员或同名/ID/员工号冲突阻断，尚未串联现有备份封存替换；成员/used已可在同包身份、配置及valid核验后分批精确恢复，used计数触发器事务内精确旁路/恢复，不再改usage_count/last_used_at；资金六表已可绑定同一身份目录、按员工事务恢复及核对，账本/对账审计重新编号、基准游标换算，pending冻结一致；无基准的老账号保持无基准，不复制financial_operations请求原文或自动修平旧差异。登录/工时/主动停工标记已可同包恢复并全字段核验，旧session_id按来源站/员工脱敏、设备JSON区分SQL NULL/JSON null；进行中工时严格按最后心跳结束（无心跳用开始时间，不加运行时一分钟宽限，分钟四舍五入），已闭合原值不改，不产生自动化/Realtime信号。实名15列与实际证件媒体已完成本地子阶段：同包identity目录及身份/成员/资金/活动实体验证前置，逐员工仅verification_requests写许可、不关trigger/不改users.is_verified，审阅人仅服务器同包admin map；残留/UUID/缺映射/漂移阻断。证件仅本站supabase.co固定verification-documents三目录/所属员工UUID，拒外链/签名参数；service-only authorize/commit、上传不覆写/删除旧文件、实际回读及全部apply后recheckImport+SQLverify，generation绑定读前员工代次。单50MiB/3000文件、记录加媒体1GiB、单卷manifest4096条目，魔数非解码/病毒扫描；SDK上传不能强制中止、失败可能留对象，不自动delete/假回滚。通知13表已可固定原文导出、同包identity/finance绑定暂存与STABLE只读奖励/执行关联预检，不复制投递租约/原始错误；SQL25另完成同名方案/任务/范本对应与成员/多余任务预览、真实历史阻断及独立通知密文记录备份；新私有RLS表与派单备份分离，维护断言仅精确豁免此技术表，sealed取消后保留。明文8MiB/密文9MiB，先独立保存回读认证再上传封存，实际13表含租约/原始错误指纹防漂移；不含媒体，can_apply_configuration仍false。无业务apply/媒体搬迁/自动化恢复，can_restore恒false，不能降级或把checked当成功。其他历史/媒体仍待接，不代表员工或全站恢复完成。精简订单的停用产品/0.01金额/IMPORTED-*编号都是占位，按产品或金额的历史统计不可包含；当天展示标注仍待接。维护不随任务取消/过期自动释放；各恢复子阶段不能解除dirty维护。第56节SQL57已为完整空站主线提供独立显式离线放行，只有原任务真实总复验并原子恢复状态成功才清该维护，不是通用解除/回滚接口，未部署不可正式使用；replacement_ready/full_site_complete仍false，不当全站完成。屏障不等于停用cron或保护Storage，正式停站/任务管控另验；见计划第24–30节（第29节保留历史描述，当前状态见第30节）。公告轮播键的旧共享白名单仍待按排除规则修正，正式迁移前必须验证。

**离线切站最新决定（计划第56节，2026-10-23 UTC+8）**：用户确认完全离线，新站启用后旧站由用户自行停用/管理；系统不联网核验旧站、不设跨站交接锁，不另加旧站确认checkbox。继续采用现有worker先排空、freeze时queue/failures/processing全零的停站导出，不做在线增量、不搬运行队列，日常备份只读、不自动停站。SQL56持久source维护和本人密码确认resume规则不变，取消/离开/过期不自动解除；恢复旧站表示放弃原切站文件，避免双站营业由用户负责，不新增远程核验阻断。截止元数据/回执不是远程签名或旧站当前状态证明。SQL57已本地接通空站离线放行：冻结与启用须同一UTC日（UTC+8每日08:00换日），最终事务结束前再次防跨界；本人超管原任务显式验证密码/确认语/核验hash，实际重扫十域/五份密文后原子恢复账号与自动化原状态、仅清原dirty维护。不是全员启用、通用维护解除、数据回滚或全部迁移完成，full_site_complete始终false；同名专用彻底替换、新编号剩余引用/通知恢复、统一档案/共享媒体、完整跨会话续接/容量多卷仍缺，未部署。屏障不等于停Storage/cron或原子跨DB文件快照；第55节及以前实施/测试按历史事实保留，不替代本决定。

通知最新进展（计划第33节）：SQL26/27及notificationsMedia/RestoreApi已串联三桶文件受控传输/URL改写、独立封存备份门禁、同名配置实际来源覆盖与13表分块历史恢复。方案/任务保持paused并保存来源状态，员工停用、dirty维护不解除；循环外键分阶段链接，投递序列换算且不发消息/奖金。收件留证触发器保持，版本表只在收件块获精确许可；旧证据冲突阻断并逐行核对，编码附件无法识别时显式拒绝，不静默漏文件。本子阶段不负责放行；第56节空站离线放行已接来源状态续接与一次入队，不重发历史奖励，新编号通知实际恢复等其余pending不因此关闭，未部署。

聊天最新进展（计划第35节）：SQL30–32及chatBackup/MergeApi/Media/RestoreApi已接独立记录密文备份、全部角色显式决定、四桶受控实际媒体与十表分块合并/核对/续接；原文/预检旧接口仍can_restore=false。保留目标角色属性，只按确认追加可见性，NULL数组原文不清空；工单/备注/内容哈希复用，相同消息UUID异内容阻断。消息只精确旁路冻结重写触发器后恢复原模式，其余保护保持；冻结来源快照、链接改写后重算MD5，最终代次回读才verify。头像图片≤5MiB、普通文件50MiB/3000个/记录加媒体1GiB；备份仅记录8/9MiB，不冒充独立完整媒体备份。账号停用/dirty维护不解除，无UI/部署。

档案最新进展（计划第36节）：SQL33/34及archiveTransfer/Api固定六表原文、同包不可变暂存、独立来源站/包命名空间恢复/核对与超管只读分页；保留旧员工/操作者，不写既有档案或联查目标活账户，原文精度/空值/非秘密历史时间保留。新业务表纳入ALWAYS维护库存；部分暂存响应丢失可status后显式重发，已核验档案取消/过期后不依赖暂存读取。后续SQL35/36已接archiveMedia/Bundle/Reader与「遷入檔案」页，私有文件绑定原行/来源/ref且完整回读；记录接口仍media_pending=true，不替代媒体/整站核验。SQL38/archiveReexport已接全量迁入来源目录、快照绑定及逐来源独立加密再导出/最终各卷重读，任何未核验来源阻断；不含本站原生档案，多来源再次导入未接，旧原生导出继续阻断。SQL37/employeeReplacement仅只读风险/封存状态；SQL39/employeeBackup已接15表核心记录独立加密保存/认证，设备明确秘密键阻断。SQL46/employeeSafetyBackup另接配置变更前的48类员工关联记录独立加密备份（含聊天/通知/派单/留证记录）；SQL47独立附件与页面串联进展见下段，记录包仍records_only，完整依赖恢复与封存证明仍缺，complete_employee_backup/can_archive/can_replace=false。共享设置及记录子集均不算完整员工备份，统一UUID/全部引用恢复及安全封存串联未做；不启用账号或解除dirty维护，未部署。

员工附件最新进展（计划第44–45节）：SQL47仅追加函数，无新表或既有函数/触发器变化；inventory/verify为anon/authenticated可调用的STABLE鉴权接口，authorize/commit仅service_role，只接受本人同一SQL46独立任务，不接受全站令牌或upload/import/read/delete。身份绑定site/job/employee/recordFP/rawrowSHA/refSHA/bucketpathSHA，档案原键不是网络目的地；四kind固定桶，头像5MiB/文件50MiB/3000引用/记录加媒体1GiB，同一行同一字段重复URL去重但跨行/字段共用文件保留引用，未知/编码/外部媒体阻断。employeeSafetyMedia先全认证记录密文并重扫48类原文/hash/引用再对照库存，附件独立加密绑定精确记录密文SHA/大小/元数据/全catalog，全认证/字节魔数/清理后最终实际源复核；成对reader同样原文重扫，已修复并回归验证删文件+匹配manifest的自洽遗漏及伪造row/ref身份。记录v1/media_included:false不变；第45节EmployeeSafetyBackupPanel已接记录和附件两份.edx与再次成对回读，全部清理/最后来源复核后才显式旧session.close。附件库本身不自动stop/close，Abort/丢响应不重试/delete/回滚或假关闭，清理失败阻断成功。completeEmployeeBackup/canArchive/canReplace/fullSiteComplete恒false，UUID/全部引用恢复及封存安全窗口仍待做；无正式访问、迁移、Storage/config/Edge/前端部署。

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
- 档案记录本轮证据（2026-10-20 UTC+8，第36节）：客户端85、foundation59/scope19、activity-db新增12及旧通知/聊天等4共16唯一用例，四文件179项分层通过；其余270未重跑、skip不算通过。561份SQL仍12旧失败，109根表/967列（private24/public85）。旧媒体Edge706、聊天6/稽核48、typecheck/lint/build/差异检查通过；无私有证据实际搬迁、档案UI、原生PG/真实Storage/整站验收或部署。
- 第37节证据：新增八专项448/448（按列示单项修正原548合计误记）、旧媒体1145、foundation/scope81、旧档案85、聊天6/稽核48通过，typecheck/lint/build/Edge语法/差异检查通过；564份SQL仍原12旧失败、109根表/967列不变。真实SQL+落盘加密包测丢失响应续接；Chromium本地注入替身测档案分页/附件/取消资源回收/375px，外网全拦，临时入口已删。非真实Storage/原生PG/整站/正式登录验收，固定六项均未整项关闭。
- 第38节证据：档案再导出client124/db119、员工核心备份client189/db69，foundation/scope83、既有档案/替换五专项276、聊天6/稽核48通过；typecheck/lint/build/格式通过。566份SQL仍原12旧失败、109根表/967列不变；真实SQL39回执接独立磁盘加密及15表回读，非完整员工备份/多来源再导入/原生PG或Storage验收。本轮无UI改动、浏览器操作或正式服务访问/部署，固定六项仍未整项关闭。
- 第39节证据：十领域/只读媒体51项、SQL40/41/42及foundation/scope295项通过；SQL41更新后58项独立复跑，不重复相加。设备/备份/存储/加密425、旧activity456、聊天6/留证48通过；569份SQL仍12旧失败、109表/967列不变。Chromium初版52/最终16项页面交互、真实Dashboard另51项门禁/保留实例/导航保存及真实OPFS7断言，原生picker仍替身；最终往返/带媒体/停止三个用例另复验。typecheck/lint/build通过，临时入口已删。没有真正导入、启用/维护解除、真实Supabase Storage/原生PG或正式部署。
- 第40节证据：真实两站export/11磁文/import维护态完整28/28（含四合成媒体、五实际备份）；SQL43/44共185、SQL45最终197；网络/身份/实名399（含新安全13，不重复相加）、foundation/scope/共享/覆盖/产品292、旧导出/只读/档案整包155，聊天6/稽核48通过。572份SQL仍12旧失败、109表/967列。typecheck/lint/build/格式通过；未跑全量employee-transfer，代理额外旧SQL11夹具组合有库存不一致，非整套通过。页面只改范围提示，浏览器复验受策略阻断、0项完成；无真实Storage/原生PG/正式部署或营业放行。
- 第41节证据：Chromium/WebKit22个隔离交互场景（含两父组TAP24/24）、真实加密包维护态SQL往返及安全41/41、foundation/scope/SQL44准入246/246、聊天6/稽核48，typecheck/lint/build/格式通过。修复复选框appearance、父页隐藏模态、手选角色可见性授权和表格对比；旧SQL44清单断言显式加SQL45唯一追加项后完整复跑。生产网络调用0；浏览器API/Storage/picker为替身，WebKit许可路径注入桌面UA，原生不支持路径另测，不代表真实Storage/目录或原生PG验收。测试临时Playwright缺失时两组明确skip，不算验收；无SQL/Edge/正式部署。
- 第42节证据：新客户端106（真实磁盘/加密，RPC合成桥）、真实SQL/48类原文/独立磁盘及失令牌停止49；新旧客户端加foundation/scope整组385、SQL46后真实整站往返28、聊天6/稽核48，typecheck/lint/build/格式通过。573份SQL仍12旧失败、109表/967列不变。修正历史订单真实六列/登录员工号语义、完整旧任务协议保护、无聊天角色与NULL通知留证、显式失令牌停止；不伪造任务或维护。无UI/浏览器、本轮无正式服务访问/部署；无真实媒体/完整同站恢复/UUID替换许可。
- 第43节证据：独立员工备份真实客户端加密浏览器Chromium/WebKit各26场景（含父组54/54），旧导入UI24/24；新旧员工备份客户端295、Storage149、真实两站维护态导入/安全41、聊天6/稽核48通过，typecheck/lint/build/格式通过。RPC/picker/workspace为替身，非真实Storage/原生磁盘/PG并发；实时预览仅登录页，隔离组件页实测。无新SQL/Edge/正式迁移或部署，实际附件/完整恢复/UUID封存替换及营业放行仍缺；旧UI补新模块mock后完整复跑，不计早期失败。
- 第44节证据：七客户端/Edge媒体文件完整2225/2225（新client176/Edge723、旧chat client75、旧四Edge328/378/439/106），SQL47下全站维护态导入28/28，聊天6/稽核48、typecheck/lint/build/Edge语法/差异检查通过。SQL专用现26项（保留原24合成回执+2真实SQL46/47/handler/memoryStorage/磁盘成对读取与显式close、最终源漂移拒绝）；SQL47/基础/范围三文件最终完整117/117通过，已含上述26项、不重复累加。574份SQL仍同12旧失败、109表/967列不变，非干净建库；600秒超时组合及误写文件名未执行不计通过。无UI改动/本轮UI或浏览器功能测试/正式访问部署；真实Storage/CORS/原生picker/PG并发/PostgREST性能、完整迁移/UUID恢复未验，详见第44节。
- 第45节证据（2026-10-22 UTC+8）：员工记录+附件备份页已接，真实SQL46/47客户端/加密/成对reader，合成RPC/fetch/IO；双浏览器各54场景，含父组110/110完整通过，主线程互斥引擎各55项亦完整复跑，不重复累加。旧导入UI24/24、记录/媒体客户端及Storage431/431、SQL47专项26/26、聊天6/稽核48、typecheck/lint/build/差异检查通过；一次600秒浏览器组合和120秒构建超时不计通过。零外网/正式访问，无SQL/Edge/Storage/config或前端部署；未跑完整employee-transfer，未重跑574份完整结构/整站28项。实际Storage/CORS/原生picker/PG并发/完整恢复仍未验，封存替换及营业放行恒false，详见计划第45节。
- 第46节证据（2026-10-22 UTC+8）：员工身份本机投影新增198项按100/98互斥分组最终完整通过，含48表独立逐字节期待/候选冲突/源与输出漂移/双遍EOF及64KiB块/回调结束迟到IO/清理deadline和取消；记录client106、聊天6/稽核48、typecheck/lint/build/差异检查通过。初期失败已修正，旧176最后重跑超时、Node20不支持skip命令及180秒构建组合不计通过，独立build已过；不称374整文件或总迁移套件通过。无UI/本轮浏览器验证、SQL/Edge/正式服务访问或Storage/config/前端部署；只是本机候选UUID转换，服务器预留/其他实体ID/共享缺依赖（submit_time_groups）/账本/媒体/档案/工时/实际DB恢复仍缺，所有封存/替换/放行恒false，见计划第46节。
- 第47节证据（2026-10-22 UTC+8）：SQL48/候选客户端及旧SQL37、基础/范围五文件最终完整392/392（数据库44含实际client→anon RPC，新client179/旧77/基础范围92），另最新SQL48真实两站维护态整站28/28；聊天6/稽核48、typecheck/lint/build/差异通过。575份SQL仍12历史失败，109表/967列不变。精确旧RPC清单及已验证新OID RNG碰撞替身修正后重跑，早期失败不计成功。只写技术候选/审计，无业务写入/全局users占位/备份证明，所有恢复/封存/替换门禁false；无UI/本轮浏览器/正式服务访问或SQL/Edge/Storage/config/前端部署，真实PG并发/Storage/完整恢复仍缺，见计划第47节。
- 第48节证据（2026-10-22 UTC+8）：SQL49新DB75/client417、含旧SQL48/37和基础范围七文件最终885/885，最新SQL49真实两站维护态整站28/28，共913项零失败/取消/跳过；聊天6/稽核48、typecheck/lint/build/差异通过。576份SQL仍12旧失败，109表/967列不变，非干净建库。实际client丢core响应、非UTC、精度/NULL/多员工/空块、权限/漂移/计划篡改与约束失败事务回滚均测；初期SQL括号/时区及矛盾管理员夹具修复后完整重跑，独立复审无新高置信问题。只恢复新停用账号/凭据/精简订单，不填旧verified map/封存启用/放行；其余域/密文证明和安全封存窗口仍缺，无UI/本轮浏览器或正式服务访问、SQL/Edge/Storage/config/前端部署，详见计划第48节。
- 第49节证据（2026-10-22 UTC+8）：SQL50新DB145/145（含真实client→anon RPC在begin/used/verify提交后丢响应、独立dump真实COMMIT续接和零员工整包）；新client207/旧身份client417/基础范围94完整718/718，五文件共863项，最新SQL50旧整站十域11密文维护态28/28另列，共891项无失败/取消/跳过。聊天6/稽核48、typecheck/lint/build/差异通过；577份SQL仍12旧失败、109表/967列不变，非干净建库。只恢复新UUID成员/used，不重计valid/写旧verified map/封存启用/解除维护，完整恢复门禁false；后续资金必须阶段化验证，不可直接删除零钱包保护。独立复审无高置信问题；未跑完整迁移总套件，无UI/本轮浏览器或正式服务访问、SQL/Edge/Storage/config/前端部署，原生PG并发/全量重扫性能/真实Storage/完整封存演练未验，详见计划第49节。
- 第50节证据（2026-10-22 UTC+8）：SQL51新DB194以1–60/61–105/106–150/151–194四互斥组最终60+45+45+44全覆盖，不称单次整文件；新client315/旧派单207/身份417/基础范围95完整1034，合计1228项，最新SQL51旧十域11密文维护态整站28另列，共1256项最终零失败/取消/跳过。真实client→anon RPC的begin/apply/verify提交后丢响应、dump跨COMMIT、pending冻结/精度NULL/无基准/零员工/游标/对账零金额修正/单员工晚失败隔离均测。map篡改夹具别名已修正并确认命中；残留流水来源管理员外键夹具修正后整组45/45复跑，首次失败不算通过。聊天6/稽核48、typecheck/lint/build/差异通过；578份SQL仍12旧失败、109表/967列不变。独立SQL复审无高置信实现缺陷，无UI/本轮浏览器/正式访问或SQL/Edge/Storage/config/前端部署，未跑完整迁移总套件；原生PG并发/取消/超时/重扫容量、真实Storage/完整封存切站未验。其他领域映射/双密文证明和封存窗口仍缺，所有完整恢复/封存/替换/放行false，详见计划第50节。
- 第51节证据（2026-10-22 UTC+8）：SQL52新DB60按1–20/21–40/41–60三互斥组最终20+20+20全覆盖，新client307/旧资金315/派单207/身份417/基础范围96整组六文件1342，最新SQL52旧十域11密文整站28另列，共1430项最终零失败/取消/跳过；聊天6/稽核48/工时6、typecheck/lint/build/差异通过。579份SQL仍12旧失败、109表/967列，非干净建库；初次测试helper清单、冻结幂等语义和旧整站尾清单修正后完整复跑，不算首次失败通过，不放宽业务保护。独立实现复审无高置信缺陷，未跑迁移总套件；无UI/本轮浏览器/正式访问或SQL/Edge/Storage/config/cron/前端部署，原生PG并发/取消/容量/PostgREST/真实Storage/完整封存未验。只完成登录工时映射，实名/通知/聊天等引用、双包证明和封存窗口仍缺，完整恢复/封存/替换/放行false，详见计划第51节。
- 第52节证据（2026-10-22 UTC+8）：SQL53新DB58按1–20/21–30/31–40/41–50/51–58五互斥组最终20+10+10+10+8全覆盖；新core/media客户端464、旧实名与映射六文件1499、既有五Edge文件1974、foundation/scope最终97、最新旧十域11密文整站28，共17文件分层4120项最终零失败/取消/跳过，不称单次总套件通过。真实SQL48–52链、独立磁盘备份、205行跨200/5分块、晚失败回滚、丢响应/COMMIT续接和代次/最终回读均测；handler/service SQL配memoryStorage非真实Storage。聊天6/稽核48/工时6、typecheck/lint/build/格式及Edge语法通过。580份SQL仍12旧失败、109表/967列，非干净建库；超时不计通过，媒体引用/回执每次调用预取保持检查，晚约束测试改仅目标并先证plan通过后整组10/10复跑，未放宽防护。独立两次实现审阅无高置信问题；无UI/本轮浏览器、正式访问或SQL/Edge/Storage/config/cron/前端部署，原生PG/真实Storage/完整封存未验，通知/聊天等映射及双包证明/封存窗口仍缺，完整员工备份/封存/替换/放行false，详见计划第52节。
- 第53节证据（2026-10-22 UTC+8）：SQL54新DB72按1–20/21–40/41–72互斥范围最终20+20+32通过、零失败/取消/跳过；新client38（真实transport60组合+24伪前缀/后缀不另拆计数）、foundation/scope98及旧十域11密文维护态28分别通过。旧通知/实名回归逐文件见第53.3节、不加总；过时自动重试断言修正后通知API另完整复跑74/74，聊天6/稽核48/工时6、typecheck/lint/build通过。581SQL仍12原历史失败、109表967列；非干净建库/总套件证明。仅通知关联准备，三处复审缺口修补后再审无新增高置信问题；无UI/浏览器、正式访问部署或真实Storage/PG并发/容量验收，完整恢复/备份/封存/替换/放行false。
- 第54节证据（2026-10-22 UTC+8）：SQL55/v3空站十域总核对和serverVerification页面/报告已接；旧整站20+8、新专项32分组覆盖60唯一TAP项目，锁修正后专项+重叠黄金33及旧20+8分别最终复跑通过。foundation/scope99、transport13、双浏览器各13场景（TAP28）、聊天6/稽核48/工时6及typecheck/lint/build通过。582SQL仍12旧失败、109表/967列不变；组合600秒超时不算整文件通过。复审修补反向锁等待，NOWAIT/try-lock竞争安全失败；不是原生PG并发/真实Storage/容量验收。账号停用/dirty维护持续；自动化截止点续接、最终启用放行与同名专用彻底替换仍缺，无正式访问或部署。
- 第55节现有证据（2026-10-22 UTC+8）：SQL56新DB25/25、client74/74、Chromium/WebKit各25交互场景（含父组TAP52）通过；SQL56下十域11磁文维护态整站61唯一项按五互斥组3+14+9+6+29全部通过（原60+新frozen往返/合法重加密摘要篡改拒绝），非单次整文件/总套件证明。583份SQL仍12原历史失败、109表967列不变；主会话最终：foundation/scope 100/100；新DB25/25；client74/74加双浏览器各25场景合计TAP126/126；旧导入UI28/28；旧员工双文件备份UI110/110（真实client/AES，RPC/IO替身）；transport security13/13；typecheck/lint/build及聊天6/稽核48/工时6通过。整站61项由实现agent按五互斥组完整覆盖；主会话另复跑严格清单+原黄金2项及frozen golden1项均过，仅重叠复验、不可加总。初次UI失败因系统缺libatk等，安装本地浏览器依赖后新126完整重跑通过；旧UI因新增panel致mock边界/泛化submit选择器失败，补sourceCutover隔离与精确导出按钮后旧28/110完整通过；早期失败及未启用runner导致的skip不算通过。两轮复审修补（父入口互锁/未知写入/摘要与旧status交错/导出时间筛选）已完成，最终独立复审无新增高置信问题；仍未做原生PG并发/真实Storage/CORS/容量/正式切站验收，未跑整个employee-transfer总套件。本轮实际新增SQL56/source API/panel并修改父页/类型/网络/加密index及多个测试文件（文档为同步）；无正式访问或SQL/Edge/Storage/权限/config/cron/前端部署，无新表、不改guard/cron/Storage/Edge；全部营业放行及其余pending不关闭。
- 第56节当前证据（2026-10-23 UTC+8，待主会话最终核对项明确保留）：真实新release SQL专项24项（父+23）通过，33旧顶层skip不计；strict/原十域golden/冻结golden另3项通过，31skip不计，不称全文件。新client187、与3旧client合312通过；主会话Chromium/WebKit各23场景含父组48/48完整复跑，既有UI28/28由UIagent通过；reviewer新client187+旧cutover74为重叠复验不加总。584迁移仍12既有失败、109表967列，非干净建库；foundation/scope主会话重跑待最终核对（旧583 baseline初跑失败正在修正，不计通过）。typecheck/lint/build此前通过、主会话最终重跑待核对；聊天6通过，audit/work待主会话复跑，不先写最终通过。真实worker失败拒freeze→drain→11落盘密文→来源账号/自动化状态→历史奖励→真实COMMIT失响应/fresh status不重发→新订单下一阶段7.25仅一次已覆盖，详见计划56.4；95受保护表指纹约2.8秒仅小fixture，不证明生产anon3秒容量。两项review问题及daily包sourceCutover undefined判断已修复并复验，再审无新高置信问题；早期fail/aborted不计通过。预览仅登录页，隔离UI的API/IO替身无外网，不代表真实Storage/CORS/原生PG并发/真实两站验收；未跑employee-transfer总套件。所有实现本地未部署，本次只同步七份既有文档、不运行新测试或正式服务。
- 界面改动要在预览中实际操作。Chromium已可用于本地隔离替身测试；正式预览需登录，不能为测试调用正式资料。无法实测的路径要明确说明。

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
| `docs/employee-data-transfer-plan.md` | 全站业务迁移计划与进度：第56节已接本地空站离线放行，其余缺项仍在、完整功能未完成/未部署；默认全部、保留新超管、精简历史订单、配置/自动化、真实进度与验收 |
| `docs/CHANGELOG.md` | 每次修改的更新记录（新的在最上面） |
