# 架构与公共约定

## 启动与页面切换
- `src/main.tsx`：先启用 `logger` 的生产环境日志保护，再以 StrictMode 挂载 `App`。
- `src/App.tsx`：持有 `AuthState`。没有路由器，按登录状态渲染登录页、员工端或管理员后台；两个 Dashboard 都包在 `ErrorBoundary` 内。登录页与员工端包在 `LanguageProvider` 内，管理员后台没有。
- 监听 `AUTH_LOGOUT_EVENT`（`work_platform_logout`），收到后切回登录页；监听 `AUTH_HANDOVER_EVENT`（`work_platform_handover`），用 `flushSync` 同步卸载员工页，避免旧页面的派单监听器在交接后继续动作。
- 启动时若本分页没有会话、但有未过期的「记住我」员工会话，先显示转圈，再调 `resumeRememberedSession()`（见下）决定进入员工页或登录页。

## 登录与会话（自建，不用 Supabase Auth）
`src/lib/auth.ts`
- `login()`：按用户名同时查 `admins` 与 `users`，管理员优先。管理员调 `create_admin_financial_session`，员工调 `create_employee_financial_session`。
- 会话存于 `sessionStorage['work_platform_auth']`（每个浏览器分页独立）：
  - 管理员：`{ user, userType: 'admin', adminSessionToken }`
  - 员工：`{ user, userType: 'employee', sessionToken, financialSessionToken, tabId, expiresAt }`（`expiresAt` 为登录请求时间 + 24 小时，前端估计值，以服务器为准；旧会话可能没有）
- 「记住我」（2026-10-10）：登录时勾选才写入 localStorage。`work_platform_remembered_username` 记账号（管理员与员工都有，登出后仍保留，下次登录预填并预设勾选）；`work_platform_remembered_auth` 记员工会话副本（仅员工）。新分页启动时：副本过期即删除；否则同时调 `validate_employee_session` 与按 `id` 重读 `users` 资料（5 秒超时），服务器明确回「无效」（被别处登录取代、停用、过期）就删副本回登录页，网络错误/超时则照常进入、交给员工页自身的恢复逻辑。`logout()` 只在副本的 `sessionToken` 与本分页相同时删除副本；不勾选登录会删除旧副本与记住的账号。`storeAuth()` 会同步更新同一会话的副本。
- 常用导出：`getAdminFinancialSessionToken()`（没有有效 token 会抛错）、`getEmployeeFinancialSession()`、`createFinancialOperationId()`（UUID）、`logout()`（撤销 financial session；员工另停止派单会话；最后派发登出事件）。
- 数据库端验证：
  - 管理员：`private.get_financial_admin_context(token)` → `admin_id`、`admin_role`（检查 hash、过期/撤销、管理员是否启用）。
  - 员工：`private.get_financial_employee_id(user_id, token, tab_id)`；另有可调用的 `validate_employee_session` RPC。
  - 部分旧 RPC 的参数名叫 `p_admin_id`，实际传的是会话 token。
- `src/lib/TabSessionManager.ts`：用 BroadcastChannel 广播 `NEW_LOGIN` / `LOGOUT`（附带 `sessionMarker`）；浏览器不支持时每 30 秒向服务器核对（用登录时的 `auth.tabId`，不是本次页面载入的 tabId）。前端时限：有 `expiresAt` 时按它计算，否则员工 24 小时、管理员 7 天。
  - 不同登录标记的 `NEW_LOGIN`：沿用原逻辑，本分页弹「Session Expired」后登出。
  - 同一登录标记（「记住我」或复制分页带来的同一会话）：最后启动的分页写入 `localStorage['work_platform_session_owner'] = { marker, tabId }` 成为拥有者；其他分页收到广播、`storage` 事件或回到前台时发现拥有者不是自己，就调用 `leaveSessionForAnotherTab()` 安静让出：只清本分页 sessionStorage，不撤销服务器会话、不停派单会话、不写登出纪录，登录页显示「账号已在另一个页面中打开」。回到前台的检查专门处理手机后台冻结、错过广播的页面。
- 员工登录失效（2026-10-10 真实浏览器实测）：服务器端员工会话 24 小时到期；`create_employee_financial_session` 每次登录都撤销该员工所有旧会话，并把 `users.current_session_token` 换成新标记。旧页面靠 `EmployeeDashboard` 订阅自己 `users` 行的 Realtime UPDATE 发现标记改变（`anon` 可读该列），约 0.4 秒弹出「Session Expired」，5 秒倒数后登出回登录页；断网/后台时错过推送，重新连线后约 0.1 秒补到同一事件。其他发现途径：带员工会话的通知 RPC 返回 `Employee session is invalid or expired.`（每 30 秒或回到前台时检查）、`TabSessionManager` 前端 24 小时计时。旧页面登出时 `revoke_financial_session` 只清除仍等于自己标记的 `current_session_token`，不会把新设备踢下线；此时 `stop_employee_dispatch_session_secure` 因会话已失效返回 400，属预期。客服聊天的读取与发送不使用员工会话，所以登录失效不会让聊天变空白；重新登录后列表与会话 1 秒内正常显示。
- 登录限流：`src/lib/rateLimitService.ts`（检查 RPC 出错时放行）；管理员解锁用会话 token。
- 登录纪录：`src/lib/loginHistoryService.ts` 记录 IP、UA、设备（IP 查询走 ipify，会被 CSP 拦截而记为 Unknown）；`src/lib/deviceInfo.ts` 解析设备信息。员工页每次打开都会补记一次登录纪录；会话已被服务器结束（被别处登录顶替、已退出、过期、停用）时，登录/退出纪录的拒绝由 `isEmployeeSessionEndedError`（`src/lib/supabase.ts`）判为预期结果，静默跳过，不打印错误。

## 数据访问模式
- 组件直接调用 `supabase.from(...)` / `supabase.rpc(...)`。没有全局状态库（无 Redux/Zustand），状态多在组件内 `useState`。
- `src/lib/supabase.ts`：
  - typed client（类型来自 `src/types/database.ts`），读取 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`。
  - 普通请求超时 8 秒，稽核/归档及共享设置导入/导出 RPC 请求 120 秒（不改变数据库角色执行上限）；网络错误有 XHR 回退。
  - 只对 GET 与白名单只读 RPC/稽核读取自动重试（最多 2 次），写操作不重试，避免重复执行。新增只读 RPC 如需重试，要加入白名单。
  - `formatSupabaseError()`：统一把错误转成可显示的文字。
- Realtime 一般只当作「有变化」的信号：收到后防抖、再重新查询。异步请求用请求序号或 AbortSignal，防止旧响应覆盖新结果。
- 后台页面懒加载；打开过的 tab 保持挂载，用 `hidden` 切换（切换时状态不丢失）。
- 工作区缓存 `src/lib/serviceWorkspaceCache.ts`：按管理员 + 工作区缓存，合并相同的并发请求，瞬时错误重试 2 次。
- 品牌配置：`useCompanyName()`、`useCurrencyUnit()` 读 `admin_configs`（考虑 `branding_mode` 全局/自定义），默认 `AAA SERVICE`、`USDC`，带 localStorage 缓存与 Realtime 更新。

## src/lib 工具速查
| 文件 | 用途 |
|---|---|
| `contentAudit.ts` | 调用 Edge Function `content-audit` 的全部封装（留证改删、永久删除、私有附件读取） |
| `employeeTransfer/crypto.ts` | WebCrypto 流式分块认证，解密可绑定预期包/卷和取消信号；须等整卷 EOF/结束认证后才可提交业务资料；独立解密工具为 `scripts/decrypt-employee-export.mjs` |
| `employeeTransfer/container.ts`、`manifest.ts`、`sha256.ts` | 双遍读取不可变临时文件，生成标准 STORED ZIP32；流式校验文件哈希/清单/卷集合/中央目录及外层结束认证，受大小与路径白名单限制。sink 仅写临时隔离区，abort 须阻断包括迟到完成在内的全部写入；浏览器OPFS/目录保存及十领域验证版导出页面已接入（见siteTransfer行）；维护态十域导入已本地联通（第40节），可营业的最终放行仍未接入，不代表完整媒体迁移 |
| `employeeTransfer/sharedExport.ts`、`api.ts` | 管理员/共享设置七表的固定协议分页导出，原始 NDJSON 哈希、写入后真实计数及源快照核对；清理失败显式标记不可复用。已接入验证版十领域串行导出，SQL40正常close释放任务而不冒充全站完成；未部署 |
| `employeeTransfer/sharedImport.ts`、`api.ts` | 七表两遍校验/暂存并取得干跑；create-only 与同名来源 replacement 分入口，业务 apply 独立确认、不自动执行。replacement 冻结备份 descriptor/计划与接收器，公开对象副本不能改变内部绑定；账号启用、全站协调/续接与页面仍待实现 |
| `employeeTransfer/replacementBackup.ts` | 七表冻结快照写临时文件→加密保存独立文件→重读完整认证及清单对照→重读密文按128KiB上传/回执→封存；最大9MiB，不自动apply/重试。失败清临时明文、不删除独立密文；封存结果不明须核对，真实浏览器磁盘适配/恢复向导仍待接入 |
| `employeeTransfer/productTransfer.ts`、`productBackup.ts`、`api.ts` | 产品专用固定单表协议，分页背压导出、两遍验证后暂存、真实回执计数；密文整卷认证后才开始导入，覆盖前独立密文保存/回读认证/上传封存。任务、备份、计划绑定且公开副本不改变内部值；不自动apply/close/重试，最大1万行/8MiB、密文9MiB。仅产品子阶段，未接全站协调、续传或后台页面，未部署 |
| `employeeTransfer/dispatchTransfer.ts`、`api.ts` | 派单/交单七表固定投影、主键游标分页导出；页SHA-256、逐行原始字节SHA-256串摘要与源前后核对，保留高精度原文，不经浮点重序列化；写临时区确认后才计数，清理失败显式报错。专用任务提供显式close/cancel，不自动结束/重试；目标只读预检始终replacement_ready=false，整批导入、浏览器磁盘/多卷/页面未接入，未部署 |
| `employeeTransfer/dispatchImport.ts`、`dispatchBackup.ts`、`api.ts` | 七表先全验证再begin、二遍原文校验/分块暂存与真实确认进度；干跑只准备、不提供apply。冻结目标备份实际独立加密保存→回读认证/行摘要/清单及文件哈希→再读密文上传封存，明文8MiB/密文9MiB超限阻断，来源暂存仍总1GiB；公开descriptor不改变闭包绑定。本地Abort不自动发取消RPC，失败明确暂存/封存结果不明并清临时明文；轻量API不加载ZIP/加密依赖。独立维护/配置阶段见下行；同站恢复和页面未实现，未部署 |
| `employeeTransfer/api.ts`（维护/配置/交单原文） | 显式enterMaintenance→configurationPlan→applyConfiguration，再显式beginValidData→applyValidDataChunk→verifyValidData，不自动执行或重试；严格冻结回执校验数量、分块游标及verified，dependencies_pending/maintenance=true、全站完成false。新会话可查询维护或撤回未写入且未变化的原任务，dirty禁止解除；来源四配置表/默认组Base和内容及valid原文/计数已可恢复，配置阶段目标成员清空，后续identityApi建立可信员工/订单对应，dependencyApi再恢复源成员和used。每块服务器提交后才有进度，结果不明不假回滚。屏障不代表停用cron/Storage，无法替代完整恢复核对或页面；未部署 |
| `employeeTransfer/identityTransfer.ts`、`identityApi.ts` | employee-identity-v1三表固定原文分页/行摘要/源前后核对；已认证隔离文件先全验证再bind到原派单任务、第二遍stage及真实回执计数，显式plan→begin→chunk→verify，不新建导入任务、不自动执行/重试/启用。保留账号14业务列/凭据4列/订单7列，业务归属只取同包共享服务器映射；逐行/数量/全部占位值核验后才提供私有身份对应。无冲突分支实际建停用员工与零钱包、不建财务基准或重复发佣金；资金回填见finance模块，成员/used后续依赖阶段见下一行，full_site_complete=false。轻量API不加载ZIP/crypto，无UI，未部署 |
| `employeeTransfer/dependencyApi.ts` | 复用原派单任务显式plan→begin→chunk→verify及新工厂重取计划/进度，不传客户端ID图/行；服务端重核同包身份、来源配置和valid完整内容后恢复来源成员和used，used计数触发器精确旁路/恢复，valid计数/最后使用时间不变。冻结严格回执、互斥/取消/结果不明不自动重试，真实提交后才计进度；资金后续见finance模块，其余历史按独立阶段接入、维护继续，无UI，未部署 |
| `employeeTransfer/financeTransfer.ts`、`financeApi.ts` | employee-finance-v1固定六表原文流式导出、双遍验证后同任务bind/stage/plan，目录须匹配已恢复的完整identity_catalog；bigint ID/游标用十进制字符串、按数值排序，金额不经浮点重序列化。显式逐员工apply/全量verify、服务端真实提交后计数及新工厂幂等续接；六表一个事务、账本/审计重编号与基准换算、pending冻结/账本收入公式及全字段重验，不重复发佣金或改写旧差异。临时明文清理与结果不明显式提示，不自动重试/启用/解除维护；其余历史/自动化/页面及原生PG时延验收待做，未部署 |
| `employeeTransfer/activityTransfer.ts`、`activityApi.ts` | employee-activity-v1固定登录/工时/停工标记三表，完整绑定identity目录及已核验身份/成员/资金的真实内容；原始NDJSON、嵌套JSON精度与SQL NULL/JSON null区分保真，旧session_id按来源站/员工脱敏。显式bind/stage/plan→逐员工事务apply→verify，不自动重试/启用/解除维护；未结束工时严格最后心跳收尾、无心跳用开始时间，已结束原值不变。真实提交进度/幂等续接/清理期间取消暂存提示、冲突和漂移阻断；实名及证件媒体后续见下一行，通知仍需奖励/自动化关联；无UI/浏览器或原生PG验收，未部署 |
| `employeeTransfer/verificationTransfer.ts`、`verificationApi.ts` | employee-verification-v1固定verification_requests全部15列原文，绑定同包identity目录及已核验身份/成员/资金/活动实际内容；显式bind/stage/plan→逐员工事务apply→媒体最终recheckImport→SQL verify。只写实名申请，不改users.is_verified或关触发器；审阅人只取同包服务器admin map，残留/UUID/缺映射/漂移阻断。真实回执计数、续接重取服务器计划，无自动重试/启用/解除维护，无UI，未部署 |
| `employeeTransfer/verificationMedia.ts` | 实名记录与实际证件文件子阶段：严格三目录/员工UUID引用，SQL inventory与不可变文件tuple目录，Edge受控下载/上传/回读及URL映射；全量验证原始NDJSON和媒体后才写、媒体二遍hash。单文件50MiB/3000文件、记录与媒体合计1GiB、单卷manifest仍最多4096条目；不是全站媒体/多卷。进度只认实际确认，错误脱敏、临时清理与取消仍提示服务器资料可能存在，不自动删除或假回滚，未部署 |
| `employeeTransfer/notificationsTransfer.ts`、`notificationsApi.ts` | site-notifications-v1固定通知/收件/广播/范本和自动化13表，绑定同包完整identity与finance目录；原文numeric/微秒、bigint字符串和C顺序组合游标，两遍校验后不可变暂存、只读关联预检。租约排除、原始错误脱敏，保留自动化执行/奖金引用；只在确认后计进度，失败/取消清临时区且提示server暂存可能存在，不自动重试/close。无业务apply/媒体/自动化恢复，can_restore恒false；未接UI、未部署，见计划第31节 |
| `employeeTransfer/notificationsConfigurationApi.ts`、`notificationsBackup.ts` | 同包通知配置对应与历史冲突计划→显式冻结13表记录备份→独立密文保存→清明文→整卷回读/行摘要核验→第三遍密文上传封存；8MiB明文/9MiB密文，动态加载容器，公开副本不改绑定，确认后才计进度。取消/结果不明无自动重试或回滚，sealed密文由原超管新会话取回。独立私有表不占原派单备份；无实际媒体、业务apply/自动化恢复或维护放行，无UI、未部署，见计划第32节 |
| `employeeTransfer/notificationsMedia.ts`、`notificationsRestoreApi.ts` | SQL26/27通知13表与三桶实际图片/影片/附件迁移、受控Edge/哈希/代次/URL改写，以及独立封存备份后的同名配置来源覆盖和分块历史恢复。保持方案/任务暂停、员工停用与dirty维护；收件留证保留，循环外键分阶段链接，投递序列换算但不发送/发奖。完整回执与status后显式续接，不自动写重试；无UI、真实Storage或全站放行，未部署，见计划第33节 |
| `employeeTransfer/chatTransfer.ts`、`chatApi.ts` | site-chat-v1十表固定原文导出、同包identity/finance绑定、双遍验证后不可变暂存及服务端角色合并只读预检；包含空角色/未引用模板、富卡及评分，SQL NULL/JSON null与精度保真。角色按服务器管理员映射/服务类型匹配，歧义、多旧合一、可见性差集和错链显式报告；目标漂移改变计划。每次重新取会话、真实确认后计进度，无自动写重试；无业务apply/媒体上传或URL改写，can_restore=false，账号停用/dirty维护继续，无UI、未部署，见计划第34节 |
| `employeeTransfer/chatBackup.ts`、`chatMergeApi.ts` | SQL30全部角色显式决定与独立目标十表记录备份；同管理员/工作区映射，独立密文保存→完整认证回读→第三遍上传封存，8MiB明文/9MiB密文。目标NULL可见性数组原文保留，sealed跨取消/过期由原超管新会话取回，不占派单/通知备份；不包含旧媒体，无UI，未部署 |
| `employeeTransfer/chatMedia.ts`、`chatRestoreApi.ts` | SQL31/32四桶受控实际图片/头像/富卡文件传输、原文URL字面改写，以及备份封存后的十表分块合并/完整核对。目标角色设置及原历史保留、工单/备注/内容复用、相同消息UUID异内容阻断；仅消息冻结触发器精确旁路/恢复，不重复打赏。每批真实generation，最后回读再verify；status后显式续接，无自动写重试/启用/dirty维护解除。头像5MiB、文件50MiB/3000个/总1GiB，无UI或真实Storage/整站验收，未部署，见计划第35节 |
| `employeeTransfer/archiveTransfer.ts`、`archiveApi.ts` | SQL33/34六表原文、同包不可变暂存与来源站/包隔离恢复；旧身份不关联目标活账号。记录核验后取消/过期仍可只读；记录接口media_pending恒true，不冒充全站完成，见计划第36节 |
| `employeeTransfer/archiveMedia.ts`、`archiveBundle.ts`、`archiveReader.ts` | SQL35/36私有留证的独立archives scope、按来源站/包/事件/ref/原行hash绑定、真实回读及Blob查看；单卷记录+媒体加密独立保存/回读、整卷认证后才导入，按服务端已提交状态续传、不重启begin。来源命名空间只读索引接「遷入檔案」页，原文保持精度。多来源再导出见下行，真实Storage/原生PG/整站验收未完成，未部署，见第37–38节 |
| `employeeTransfer/archiveReexport.ts` | SQL38全迁入来源目录及严格快照读取，原站/包/六表原文和附件身份保留，逐来源独立加密保存/认证，最终逐卷重读及全量目录复核。拒未核验来源和保存位置复用，不含本站原生档案，不代表多来源再导入已实现；无UI/部署，见第38节 |
| `employeeTransfer/employeeBackup.ts` | SQL39服务端选择唯一同名目标，15表核心记录真实分页导出、独立UUID加密保存/完整认证回读及目标二次核验；明文1GiB/ZIP1100MiB/密文1101MiB，嵌套设备秘密键阻断。缺聊天/通知/媒体等，不算完整备份、无sealed/封存/替换许可；无UI/部署，见第38节 |
| `employeeTransfer/employeeSafetyBackup.ts` | SQL46导入配置变更前的独立员工48类记录备份；真实原文分页/指纹、磁盘AES/ZIP保存/认证回读及只读callback reader，成功清理后才允许显式close。含聊天/通知/派单/留证依赖但不含实际媒体，全部封存/替换门禁false；丢令牌/过期仅独立密码确认stop_owned，不能自动重跑。已接EmployeeSafetyBackupPanel独立记录入口及父页互锁，真实媒体/同站恢复/UUID替换仍缺；报告独立取消不影响文件/任务事实，未知结果仅显式本人stop，不自动重跑，未部署，见第42–43节 |
| `employeeTransfer/siteTransfer.ts`、`siteExportApi.ts` | 十领域真实导出适配与串行协调；SQL41同一MVCC目录基线、每领域catalog绑定、独立密文保存/认证/明文清理后close，最终源目录及全部密文复核后写加密index。11文件本机检查核对同包/域/卷/行摘要；媒体调用各领域只读inspect，反向验证记录引用与附件及魔数。新增withAuthenticatedSiteBundleSet先全组认证，之后每域重新认证同索引摘要及目录才给恢复器，callback后真实清理、结束后不能再读；档案额外重读绑定原catalog/密文哈希/字节数。失败无自动写重试/取消，不启用业务；当前始终importReady/fullSiteComplete=false。不是完整站点可恢复协议，见计划第39–40节 |
| `employeeTransfer/siteImport.ts`、`siteRestoreApi.ts` | 认证全部11文件后才作目标准入；仅接受SQL45 v2，拒同站/业务残留/任务与维护。串联五份独立加密备份及十域实际恢复、身份后再恢复派单依赖、最终媒体回读/核验；SQL45进入维护后与末尾重验前置配置。所有账号停用/自动化暂停/dirty维护持续，结果不明不自动重跑、不是全站营业放行或完整同名员工替换；已由EmployeeSiteImport接维护态向导，见计划第40–41节 |
| `components/admin/EmployeeSiteImport.tsx` | 维护态写入向导：本机配套核验后独立只读准入，密码/确认语/独立备份目录，逐计划显式批准、聊天手选与可见性控制；body portal原生模态焦点循环，边界暂停/停止、不自动重试或假续接，首次开始后锁定重跑。非敏感JSON报告保存失败另提示，不改变已写入事实；无员工封存/启用/维护解除入口。浏览器/API替身回归见第41节，未部署 |
| `employeeTransfer/browserStorage.ts` | 用户手势选独立随机子目录，输出一次写入、不覆写、不删密文；OPFS随机明文工作区流式append/open/abort，读后路径冻结、迟到操作不可复活，清理失败阻断成功。真实Chromium OPFS已本地复验；原生目录选择器/CORS/配额仍待实机验收 |
| `employeeTransfer/deviceInfo.ts` | 登录设备JSON共享秘密键拒绝规则；普通历史时间/文本及原始数字不改写。activity传输及员工独立备份均调用；SQL41开始前复用SQL39服务端检查，不把会话秘密写进迁移文件 |
| `employeeTransfer/employeeReplacement.ts` | SQL37同任务员工替换前置只读计划/状态；同名目标资金风险以十进制字符串呈现，内容指纹检测同数量变更、原封存记录和账号释放独立核对。can_archive/can_replace恒false，现有共享设置备份不算员工完整备份；UUID映射/完整独立员工备份及封存导入串联仍待做，见第37节 |
| `sanitizeHTML.ts` | DOMPurify 净化：`sanitizeHTML`、`sanitizeAnnouncementContent`、`sanitizeUserInput`、`sanitizeChatMessage` |
| `fileValidation.ts` | 上传前校验文件名、MIME、扩展名、大小、文件头 |
| `imageOptimizer.ts` | 压缩 HTML 中的 base64 图片并上传 `template-images` |
| `storageUpload.ts` | 带进度的 Storage 上传 |
| `storageCleanup.ts` | 从 HTML 提取已知存储桶的文件并删除 |
| `dateUtils.ts` | UTC 日期边界与格式化 |
| `safeUtils.ts` | 安全取值与格式化（数字、日期、金额、JSON） |
| `usePaginatedList.ts` | 本地数组分页 Hook |
| `passwordHash.ts` / `bcryptWorker.ts` | bcrypt（在 Web Worker 中执行，失败回退主线程） |
| `logger.ts` | 生产环境隐藏普通日志与敏感信息 |
| `dbValidation.ts` | 可选的 schema 检查与安全查询封装 |
| `devicePerformance.ts` / `useDeviceOptimization.ts` | 按设备性能降级动画、列表与图片；只在视口宽度变化时重新检测（手机地址栏收展只改高度），GPU 纹理上限只探测一次并释放 WebGL 上下文；没有常驻帧率监测（需要实测帧率的界面自行短时采样，见派单等待面板） |
| `responsiveBreakpoints.ts` / `useResponsive.ts` | 断点与响应式 Hook |
| `useCompanyName.ts` / `useCurrencyUnit.ts` | 公司名称与货币单位 |

## 实名与证件媒体服务子阶段（2026-10-19，UTC+8，本地未部署）

- 仓库有两个Edge源码目录：`supabase/functions/content-audit/`（已在正式）及`supabase/functions/employee-transfer-media/`（新`index.ts`环境适配、`handler.ts`受控传输，未配置/部署）。`supabase/config.toml`仍只有旧process-orders/cleanup-dispatch，本轮不改。未来新服务部署须单独说明影响、确认`verify_jwt=false`，其内部由SQL验证管理员session/job，不放宽桶权限或把serviceKey给浏览器。
- SQL21/22复用私有任务/暂存及原dispatch-import dirty维护、独立封存备份和同包管理员回执。媒体库存/目录绑定供已验证浏览器会话使用，authorize/commit仅service_role。逐员工仅verification_requests写许可，保留ALWAYS维护/外键和全部保护，不关trigger；申请status与users.is_verified独立，不能联动覆盖。NULL媒体链接保留。
- 导出只认服务端固定环境的本站supabase.co公开对象URL、verification-documents固定桶与id-front/id-back/selfie三目录及所属员工UUID；外链/他站/签名参数/未知格式阻断不漏文件。目标服务器路径为`folder/employeeUUID-transfer-<SHA-256(job_id:key)前32位>.ext`，兼容既有删除留证清理；upsert=false、不覆写或删除旧文件，同任务同tuple须回读哈希/大小/MIME一致才复用，异内容路径冲突拒绝。
- Edge raw Storage fetch仅向固定环境origin带服务凭据，流式读取≤50MiB；响应头及正文共同受90秒下载超时与Abort控制，不先用SDK download缓冲Blob。JPEG/PNG/GIF/WebP/PDF魔数只识别MIME，不是完整解码/病毒扫描。上传后服务readback，全部员工apply后再显式recheckImport+SQL verify；读前授权generation绑定已提交员工代次，commit拒绝期间apply导致的旧代次，不能读后更新授权冒充最终回读。
- SDK upload不能强制中止，失败/取消可能遗留对象或暂存；不自动delete/重试或假回滚，错误脱敏。客户端使用整卷EOF认证后的隔离文件，NDJSON与全部媒体先全验证再写，媒体上传前二遍hash；实际写入/一致回执才计进度。清临时明文期间取消也提示服务器资料可能存在，清理不明不可复用。尚无真实浏览器磁盘适配或完整加密归档往返证据。
- 最终完整activity-db147/147（原61+新增86），实名API123/客户端130/Edge328共581/581，其他28迁移文件分组4575/4575，32文件合计5303/5303；scope真实文件18/18、foundation47/47含新增2项，严格549份SQL仍12旧失败，106表/937列未变。最终日志`/tmp/verification-db-complete.log`零失败/取消/skip，早期失败、多次完整命令超时不计通过；聊天6/稽核48/工时6另60项，typecheck/lint/build和格式检查通过。独立复审发现目录SQL语法/数组类型、回读代次竞态、SDK Blob缓冲、响应头取消及客户端续接门禁，均已修复并回归复核。
- 以上为PGlite、合成媒体回执及fakeStorage/注入传输分层测试，非真实Storage或全站验收。原生PG/PostgREST并发/anon3秒/大员工性能、真实Storage/CORS/Edge限额、浏览器磁盘、完整归档往返、多卷/整站演练均未验；无UI/导航，不可正式迁移。账号停用、dirty维护及pending标记不变，replacement_ready/full_site_complete仍false；通知奖励/自动化、聊天/档案、同名员工备份封存、全站协调核对/任务恢复放行、其他媒体/多卷/公告轮播排除和页面仍待做，详情见迁移计划第30节。
- 本轮未访问/改变正式库数据，未部署SQL/Edge/前端，无Storage/权限/cron调整；仅调用Supabase文档搜索，不是正式数据访问。本次只同步文档；前端完整功能做好后仍待用户自行部署，正式操作逐项确认。

## 样式与界面约定
- Tailwind 自定义断点：`xs` 360、`sm` 480、`md` 600、`lg` 1025、`xl` 1280、`2xl` 1536（与 Tailwind 默认值不同）。
- `src/index.css` 全局可复用类：`scrollbar-dark`、`audit-detail-scroll`、`audit-detail-scroll-light`、`dark-panel-scroll`、`dispatch-orders-scroll`、`login-history-*`、`message-content-dark`。
- 后台为深色 slate/cyan 风格，组件里大量内联 Tailwind。
- Tailwind 另有两个按屏幕高度的自定义变体（`tailwind.config.js`）：`short:` = 高 ≤640px，`low:` = 高 ≤520px；注册顺序保证两者同时成立时 `low:` 生效。
- 登录页按 `useResponsive` 选版面：手机版用于宽 <480，以及宽 480–659 且高 >520 的竖屏；平板版（左右两栏）用于宽 660–1024，或高 ≤520 的横放手机（`low:` 紧凑两栏）；>1024 为电脑版。注意 `isTablet` 从 480px 开始（`xl` 类别），不是 600px。手机版的上下间距随屏高伸缩（`clamp(…vh…)` 加有最小值的 flex 空白），矮屏用 `short:`/`low:` 收紧，所以 320×568 等小屏不需滚动。三种版面根元素都带 `login-page`（`src/index.css`：最小高 100dvh，并隐藏页面滚动条，必要时仍可滑动）。
- `src/index.css` 会按屏宽和触控改按钮尺寸：宽 ≤320/321–375/376–414 时所有 `button`、`input` 被 `!important` 撑到最小高 40/44/48px，根字号也变为 12/13/14px（415–480 为 15px，所以 rem 尺寸随设备变化）；触控设备（`pointer: coarse`）上 class 不含 `w-[`/`h-[` 的按钮另加最小 44×44 和 `12px 16px` 内边距。小按钮要在各设备同尺寸：用像素尺寸（如 `h-[30px]`，同时避开触控规则）再加 `!min-h-0`（压过按屏宽的规则），可参考 `src/pages/Login.tsx` 的眼睛与语言按钮。
- 员工端（`body:has(.employee-shell)`）在上述缩小根字号的窄屏上另有字号下限：宽 ≤414 时 `text-xs` 为 11px，≤320 时 `text-sm` 为 11.5px；员工端组件像素字号最小 11px。手机横屏提示 `PhoneLandscapeGuard` 以 z-index 2147483000 覆盖整页（登录页与员工端）。细节见 `docs/employee-portal.md`「屏幕适配」。
- 有多个超大单文件组件：`CccServiceManagement.tsx`（6000+ 行）、`EmployeeManagement.tsx`（约 5900 行）、`CustomerServiceManagement.tsx`（约 5100 行）、`OrderDispatch.tsx`（约 4800 行）。修改前先用搜索定位，尽量小范围改动。
- 命名：组件 PascalCase，函数与变量 camelCase，Hook `use*`，数据库字段 snake_case。

## 构建与部署
- `package.json` scripts：`dev`、`build`、`lint`、`preview`、`typecheck`、`test:audit-cleanup`。
- TypeScript strict，开启 `noUnusedLocals`、`noUnusedParameters`；ESLint 9 flat config（TS 推荐规则 + react-hooks + react-refresh）。
- `vite.config.ts`：分包，构建时移除 `debugger` 与 console 日志。
- `vercel.json`：输出 `dist`；所有路径 rewrite 到 `index.html`（SPA）；静态资源长缓存；CSP 的 `connect-src` 只允许 `'self'`、`https://*.supabase.co`、`wss://*.supabase.co`。
- 环境变量：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`，可选 `VITE_FORCE_PRODUCTION_LOGS`（见 `.env.local.example`）。
