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
  - 只对 GET 与白名单只读 RPC/稽核读取自动重试（最多 2 次），写操作不重试，避免重复执行。新增只读 RPC 如需重试，要加入白名单。`get_employee_import_*` POST一律不自动重试，不因get命名自动重发；SQL54四个显式RPC也不自动重试，含STABLE plan/status，客户端等待120秒不改变服务端上限。SQL55 `employee_import_site_verify` 同样单次120秒、不自动重试，返回实物总核对回执而非营业许可。SQL56/sourceCutover的freeze/resume及状态读、SQL57/siteRelease的bind/status/release均不自动重试，不因status只读而加入重试白名单；SQL57单次等待120秒不提高数据库角色执行上限。
  - `formatSupabaseError()`：统一把错误转成可显示的文字。
- Realtime 一般只当作「有变化」的信号：收到后防抖、再重新查询。异步请求用请求序号或 AbortSignal，防止旧响应覆盖新结果。
- 后台页面懒加载；打开过的 tab 保持挂载，用 `hidden` 切换（切换时状态不丢失）。
- 工作区缓存 `src/lib/serviceWorkspaceCache.ts`：按管理员 + 工作区缓存，合并相同的并发请求，瞬时错误重试 2 次。
- 品牌配置：`useCompanyName()`、`useCurrencyUnit()` 读 `admin_configs`（考虑 `branding_mode` 全局/自定义），默认 `AAA SERVICE`、`USDC`，带 localStorage 缓存与 Realtime 更新。

空站十领域恢复在各域完成后，现由 `siteRestoreApi` 调用 SQL55 服务端原子总核对，再核实仍处于原任务dirty维护；客户端严格绑定任务/来源站/包/十域顺序和员工总数，金额保留原十进制字符串。总核对失败、丢响应、凭据错绑或清理未确认均不返回成功。SQL55 v3准入在首笔写入前要求总核对能力，不接受旧v1/v2。`EmployeeSiteImport`结果页及`site-import-report.json`保存`serverVerification`，记录导入当时账号停用、自动化暂停及dirty维护；不会自动恢复营业。第56节SQL57已本地另接独立离线放行，冻结包返回闭包releaseSession、结果下方显式启用并另存`site-release-report.json`，不重写维护回执；日常包无sourceCutover仍可维护态导入，但releaseSession=null不能启用。本地未部署，full_site_complete始终false。

## 旧站停站切换、截止凭据与互锁（第55节，2026-10-22 UTC+8，本地未部署）
> 本节保留SQL56当时的实现/测试事实；当前空站离线放行已接，旧站由用户自行停用/管理，不要求系统跨站核验或交接锁，见下方第56节。源cutoff本身仍不是营业许可。
- 最新采用停站切换，不做在线增量或搬运行队列；先由现有worker排空待发自动化，freeze时queue/failures/processing订单必须全零。日常备份保持业务只读、不自动停站；SQL56/sourceCutover.ts/SourceCutoverPanel只在超管密码及精确确认语「確認暫停舊站業務並導出」后建立持久source维护，不改账号/自动化原状态、进度/基线/activated_at或钱，也不自动导出。
- 复用既有jobs/maintenance，source冻结为`source-cutover-v1`的finished terminal技术任务，不占单活running任务，十域导出正常；getlog包装保留旧子协议排除并排除source冻结，freeze不算`last_export_at`最近成功导出。取消/离开/过期不解除source维护；本人超管带当前cutoff_id、密码及「確認恢復舊站業務並放棄切站」显式恢复，有running export阻断，dirty import不能借此解除。
- 客户端模块级`activeWrite/uncertainWrite`跨实例互锁，写结果未知时不自动重试/恢复/stop或假称回滚，状态读也不自动重试。`writeGeneration`绑定状态读发起时的写代次，新写入之后才到的旧status拒绝，不能错误解锁；只有写结束后新发起且严格核验成功的状态读可解除未知。父页所有导入/导出/本机核验/独立备份及停止入口双向互锁，仍保留显式「刷新狀態」核对通道。
- SQL56 site snapshot在冻结时携`source_cutover`并复查三项零值，导出前后比较后进入加密index。reader严格校验固定字段/UTC微秒格式，重算去掉cutoff_hash后的PostgreSQL jsonb文本SHA-256并绑定索引来源站，认证整组回调传递元数据；合法重加密但摘要篡改亦拒绝。未冻结的日常备份不强制带cutoff。
- 来源元数据不是远程签名、旧站当前仍冻结的远程证明或新站营业许可。恢复旧站后不能用旧切站文件启用新站，不能两站同时营业；本机认证不能自动撤销旧文件；旧站由用户管理，系统不增加联网核验或交接锁，当前离线放行见第56节。source屏障只冻结受保护DB写，不代表停Storage/cron或原子跨DB文件快照；无新表、不改guard/cron/Storage/Edge。
- 现有DB25/25、client74/74、Chromium/WebKit各25场景（含父组TAP52）、SQL56十域11磁文维护态整站61项五互斥组3+14+9+6+29已通过（原60+新frozen往返/合法重加密摘要篡改拒绝）；583份SQL仍12原历史失败、109表967列不变。主会话最终foundation/scope100/100、client74/74加双浏览器合计TAP126/126、旧导入UI28/28、旧备份UI110/110、transport security13/13、typecheck/lint/build及聊天6/稽核48/工时6通过；整站61项为实现agent完整覆盖，主会话重叠复验不加总。两轮复审修补完成，最终独立复审无新增高置信问题；未跑整个employee-transfer总套件。
- 本轮实际新增SQL56/source API/panel并修改父页/类型/网络/加密index（本文件同步说明），无正式访问或SQL/Edge/Storage/权限/config/cron/前端部署，前端仍待用户另行部署。最终自动化续接、账号启用/营业放行、同名彻底替换及其余原pending未完成；隔离浏览器/数据库替身不替代真实Storage、原生PG并发/容量和正式切站验收。

## 空站离线放行、闭包会话与独立回执（第56节，2026-10-23 UTC+8，本地未部署）
- 用户确认完全离线，新站启用后旧站由用户自行停用/管理；没有旧站联网核验、跨站交接锁或额外旧站checkbox。继续SQL56先排空再freeze，不搬运行队列。用户同意freeze/release同UTC日（UTC+8每日08:00换日），cutoff/receipt不是远程签名或旧站实时状态证明。
- SQL57共享apply wrapper在取消清staging前冻结来源非超管is_active（含NULL）及source/role绑定，不从目标停用状态反推；preflight保留v3、追加release接口及正确wrapper能力检查。target bind严格六字段、PG摘要/同source，已绑定不可改；冻结包在dispatch末绑定，旧日期可绑定检查但不能启用。
- `siteImport/siteRestoreApi`完成冻结包维护态导入后返回闭包`releaseSession`，原job token不进入报告或模块级互锁对象。无`sourceCutover`/undefined的日常包仍合法维护态导入，但`releaseSession=null`；不能补造凭据启用。完整刷新/跨会话导入token安全恢复尚未实现，status不能替代会话恢复或新实物核验。
- `siteRelease.ts`严格绑定字段/任务/来源站/包/cutoff/verification hash/时间/计数及布尔，回执深冻结；跨实例writeGeneration及未知写互锁拒迟到旧status，只有底层写结束后fresh status能核对未知结果。bind/status/release单次120秒、不自动重试；取消不视为回滚。兄弟导出/导入/备份入口互锁，但保持显式status通道，不靠重新挂载解锁。
- `SiteReleasePanel`在`EmployeeSiteImport`结果下方显式「查詢啟用條件」→新站超管密码及精确「確認啟用新站」→「核對並啟用新站」。release凭本人超管原任务/session/password/expected verification hash调用真实SQL55重扫十域、最终媒体回执及五份实际备份密文；来源failures及目标queue/failures/processing为零、同UTC日且事务末尾再查边界。status只提供候选条件/历史回执，不是放行前实物总核验。
- SQL57只向users/admins/plans/tasks/queue五表发精确permit并最终清除，原子恢复来源员工/非超管is_active含NULL及plan/task原status，不全员启用、不改activated_at/version/updated_at/progress/executions/钱。评估锁内临时plan active→恢复task→plan原状态，支持paused/archived plan含active task，不关trigger；admins未知trigger审核只限UPDATE并保留既有删除trigger。active员工仅一次新入队、不现场发送/发奖，完整受保护业务行前后指纹防隐藏副作用。
- 成功仅清本人原dirty maintenance、job finished、summary receipt/audit，保留staging/备份；同事务失败全回滚。真实COMMIT丢响应须fresh status读取既有回执，不自动再release。单独`site-release-report.json`，原`site-import-report.json`及serverVerification保持历史维护回执；报告保存失败不撤销提交、不触发重发，后来另有维护时不能据旧放行回执称当前仍可营业。
- 最终本地证据：SQL专项24（父+23）通过/33旧顶层skip不计，另strict/原十域golden/冻结golden3项通过/31skip不计，不称整文件。foundation/scope修正显式SQL57清单及584基线后完整101/101通过，584迁移仍12项原历史失败、109表967列，非干净建库。主会话三文件新release client187+旧cutover74+site-import-security13完整274/274通过，与此前312及reviewer结果重叠不加总；Chromium/WebKit各23场景含父组48/48主会话完整复跑通过，旧UI28/28由UIagent通过。主会话typecheck/lint/build通过（保留迁移页约571KiB chunk警告），聊天6/稽核48/工时6分别通过；旧583基线初跑失败及早期fail/aborted不计通过。详细真实worker/磁盘/COMMIT及7.25仅一次奖励链见计划56.4，不声明整个employee-transfer总套件通过。
- 95受保护表指纹约2.8秒仅小fixture，不证明生产anon3秒容量。预览仅登录，隔离UI API/IO替身无外网，不代表真实Storage/CORS/原生PG并发/真实两站验收；未跑全employee-transfer总套件。无正式SQL/Edge/Storage/权限/config/cron/前端访问或部署；回退仅移除函数/还原包装，不清维护、不撤销已放行或资金，非数据回滚。full_site_complete=false，同名彻底替换、新编号剩余引用/通知恢复、统一档案/共享媒体、完整跨会话续接及容量多卷仍缺。

## src/lib 工具速查
| 文件 | 用途 |
|---|---|
| `contentAudit.ts` | 调用 Edge Function `content-audit` 的全部封装（留证改删、永久删除、私有附件读取） |
| `employeeTransfer/crypto.ts` | WebCrypto 流式分块认证，解密可绑定预期包/卷和取消信号；须等整卷 EOF/结束认证后才可提交业务资料；独立解密工具为 `scripts/decrypt-employee-export.mjs` |
| `employeeTransfer/container.ts`、`manifest.ts`、`sha256.ts` | 双遍读取不可变临时文件，生成标准 STORED ZIP32；流式校验文件哈希/清单/卷集合/中央目录及外层结束认证，受大小与路径白名单限制。sink 仅写临时隔离区，abort 须阻断包括迟到完成在内的全部写入；浏览器OPFS/目录保存及十领域验证版导出页面已接入（见siteTransfer行）；维护态十域导入已本地联通（第40节），空站显式离线放行已另接SQL57（第56节），不代表完整媒体迁移或全部缺项关闭 |
| `employeeTransfer/sharedExport.ts`、`api.ts` | 管理员/共享设置七表的固定协议分页导出，原始 NDJSON 哈希、写入后真实计数及源快照核对；清理失败显式标记不可复用。已接入验证版十领域串行导出，SQL40正常close释放任务而不冒充全站完成；未部署 |
| `employeeTransfer/sharedImport.ts`、`api.ts` | 七表两遍校验/暂存并取得干跑；create-only 与同名来源 replacement 分入口，业务 apply 独立确认、不自动执行。replacement 冻结备份 descriptor/计划与接收器，公开对象副本不能改变内部绑定；本子协议不启用账号；空站协调/页面和来源账号启停恢复见siteImport/siteRelease，完整跨会话续接仍待实现 |
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
| `employeeTransfer/employeeSafetyBackup.ts` | SQL46导入配置变更前的独立员工48类记录备份；真实原文分页/指纹、磁盘AES/ZIP保存/认证回读及只读callback reader，成功清理后才允许显式close。含聊天/通知/派单/留证依赖但不含实际媒体，全部封存/替换门禁false；丢令牌/过期仅独立密码确认stop_owned，不能自动重跑。已接EmployeeSafetyBackupPanel独立记录及附件入口/父页互锁：同一任务中记录→附件→成对认证/全部清理→源附件与记录最终复核→显式close，两份独立.edx共用口令并各有SHA-256。记录v1/media_included:false不变，页面报告另为v2/pair协议，完整恢复/UUID替换仍缺。报告独立取消不影响文件/任务事实，未知结果仅显式本人stop，不自动重跑，未部署，见第42–45节 |
| `employeeTransfer/employeeSafetyMedia.ts` | SQL47及媒体handler独立employee-safety作用域，仅本人同一SQL46任务的download/recheck-export，无全站令牌或upload/import/read/delete。先完整认证记录.edx并重扫48类原文/hash/精确引用，再对照inventory下载；附件独立.edx绑定精确记录密文SHA/大小/卷元数据及完整catalog，保存后全认证/字节魔数/清理/最终实际源复核。本机成对reader同样重扫原文，已修复并回归验证自洽删附件/manifest及伪造row/ref身份漏检。四kind固定桶，头像5MiB/文件50MiB/3000引用/记录加媒体1GiB；不自动stop/close，由调用方附件后显式旧session.close，丢响应/Abort不重试/删除/回滚或假关闭，清理失败阻断成功。全部完整备份/封存/替换/全站完成恒false；第45节已由EmployeeSafetyBackupPanel串联，两文件各自保存/认证后再成对回读及最终源检查。任何失败不提前close，未知结果保留本人stop，报告等待单独取消。双浏览器真实客户端/AES/ZIP与合成RPC/fetch/IO测试覆盖110项，非真实Storage/原生picker/PG验收；未部署，见第44–45节 |
| `employeeTransfer/employeeIdentityProjection.ts` | 第46节本机身份投影：先认证SQL46/47双包，再认证精确同一记录密文，固定48表员工UUID字段/虚拟复合键无损转换；不重序列化数字/正文/员工号/媒体，两个audit表和管理员元数据保持原始字节。源原文重扫、输出全表认证后才开放限时只读callback；每次open先EOF/hash，再按转换时64KiB块摘要核验后交付，回调退出立即撤销reader，所有工作区独立限时清理。仅转换，不预留目标UUID、不写库；服务器预留/其他实体ID/共享配置/账本游标/媒体/档案/工时/DB核对均列blocker，canRestore/封存/替换恒false；未接UI或部署 |
| `employeeTransfer/employeeIdentityReservation.ts` | 第47节SQL48服务端候选绑定的status/reserve客户端：原导入任务与不可变来源目录，服务端选择UUID、冻结源/目标观察指纹，漂移/占用不重置；严格字段/任务校验、冻结checkpoint、互斥/取消/脱敏错误，不自动重试。只写技术暂存/审计，不是users全局占位或SQL46/47密文备份证明；尚未接投影/各域恢复/UI，全部恢复/封存/替换门禁false，未部署 |
| `employeeTransfer/employeeMappedIdentity.ts` | 第48节SQL49：候选UUID的实际停用账号/凭据及精简订单恢复，plan/core/orders/verify/status五显式调用；冻结计划/每员工绑定、真实计数游标、每请求取当前会话，未知写入需status明确核对、取消后请求未结束仍互斥，无自动重试。源/目标/已写内容漂移拒绝；只支持无同名活账号/封存历史的新身份，不写旧identity_restore/verified map，资金/其他引用/密文备份证明与封存替换仍缺，未接UI或部署 |
| `employeeTransfer/employeeMappedDependency.ts` | 第49节SQL50五显式RPC恢复新员工UUID的来源派单成员/used：全包SQL49身份与配置/valid实物重验，独立状态与计划映射hash、先成员后used/空块/真实游标，used精确防双计数。严格冻结/不倒退/互斥/取消后底层未结束继续互斥，未知写入只status可续、不自动重试。旧identity/dependency/verified map不写，完整恢复/封存/替换/放行false；后续资金需阶段化验证，其他域/双包证明/封存窗口未接，无UI/部署 |
| `employeeTransfer/employeeMappedFinance.ts` | 第50节SQL51七显式RPC：新员工UUID资金六表原文bind/stage→只读plan/status→begin→逐员工事务apply→verify，阶段化身份/派单/资金实物重验、不改旧零钱包防护。严格深冻结/候选/计数/金额字符串/不倒退，未知写入只status可续，未知apply须同来源、取消后底层未结束仍互斥；未全stage的status会拒绝并保持安全暂停，早期丢响应/跨会话完整续传未解。账本/审计重编号、基准游标及pending冻结均核验，旧summary/verified map不写；完整恢复/封存/替换/放行false，其他域/双包证明/封存窗口未接，无UI/部署 |
| `employeeTransfer/employeeMappedActivity.ts` | 第51节SQL52七显式RPC：候选UUID下登录/工时/停工三表原文恢复，资金完整verified前置及身份/订单/派单/资金实物重验、逐员工事务与真实计数。历史员工号/会话散列/设备JSON精度与两种NULL保留，未结束严格按最后心跳收尾；不发信号/通知或改钱包。深冻结/不倒退/互斥，未知apply仅同来源status可续，未全stage的早期丢响应安全暂停、不自动重试。旧summary/verified map不写，完整恢复/封存/替换/放行false；未接UI/整站协调器/双包证明，未部署，详见计划第51节 |
| `employeeTransfer/employeeMappedVerification.ts`、`employeeMappedVerificationMedia.ts` | 第52节SQL53：新UUID实名15列记录七显式RPC（严格要求SQL52 verified并实物重验，仅映射user/审阅人/非NULL URL，不改is_verified，仅verification_requests许可、不旁路触发器）及实际证件媒体inventory/bind/upload/recheckImport（mapped-verification作用域，service-only授权/提交、服务器候选路径、upsert=false、回读、全部apply后终检；50MiB/3000/1GiB）。原文NDJSON、严格冻结、不自动重试，未知apply同来源status，早期未完整暂存失败关闭，媒体不确定须新会话显式对账、不自动修复/删除；独立阶段，未接UI/协调器，完整备份/封存/替换/整站false，未部署 |
| `employeeTransfer/employeeMappedNotifications.ts` | 第53节SQL54四显式方法bind/stage/plan/status，仅目录绑定/13表原文暂存与只读映射和SQL51奖金关联预检，非实际通知恢复。每入口SQL53实名verified及SQL48–53实物重验；只写私有staging，不发permit/改summary，plan/status STABLE无heartbeat。共享RPC类型、当前会话、深冻结/不倒退；未知bind须status核对目录，未知stage须同table+chunk的原文回执（部分stage亦可查），plan不能解锁；无自动重试，取消后底层未结束仍互斥。四RPC120秒等待不改服务端上限，完整恢复/备份/封存/替换/整站false、配置/记录/媒体/自动化pending为true，员工停用/dirty维护不变；新编号配置对应/独立备份/媒体/13表apply仍缺，无UI/协调器或媒体Edge修改，未部署 |
| `employeeTransfer/sourceCutover.ts`、`components/admin/SourceCutoverPanel.tsx` | SQL56旧站停站切换，三项零值前置/密码及精确确认语/当前cutoff_id恢复；模块级未知互锁及writeGeneration拒旧status、父页全入口互锁，读写不自动重试。持久source维护兼容十域导出，不改原业务状态，不能解除dirty import或放行新站，见第55节 |
| `employeeTransfer/siteTransfer.ts`、`siteExportApi.ts` | SQL56来源截止凭据进入加密index，reader重算PG摘要/绑定来源站，非远程签名或新站许可；十领域真实导出适配与串行协调；SQL41同一MVCC目录基线、每领域catalog绑定、独立密文保存/认证/明文清理后close，最终源目录及全部密文复核后写加密index。11文件本机检查核对同包/域/卷/行摘要；媒体调用各领域只读inspect，反向验证记录引用与附件及魔数。新增withAuthenticatedSiteBundleSet先全组认证，之后每域重新认证同索引摘要及目录才给恢复器，callback后真实清理、结束后不能再读；档案额外重读绑定原catalog/密文哈希/字节数。失败无自动写重试/取消，不启用业务；当前始终importReady/fullSiteComplete=false。不是完整站点可恢复协议，见计划第39–40节 |
| `employeeTransfer/siteImport.ts`、`siteRestoreApi.ts` | 认证11文件后查询SQL57追加能力检查的v3准入（SQL45前置复核/SQL55总核对），拒v1/v2、同站/业务残留/任务与维护。五份独立密文备份→十域实际恢复/派单依赖→最终媒体/实物核验；导入本身停用/paused/dirty维护。冻结包dispatch末绑定cutoff、末尾返回闭包releaseSession，日常包无sourceCutover则为null；token不进报告，不自动放行/重跑，未实现完整同名替换或刷新跨会话恢复，见第40–41/56节 |
| `employeeTransfer/siteRelease.ts`、`components/admin/SiteReleasePanel.tsx` | SQL57独立离线bind/status/release，严格回执/跨实例writeGeneration/未知结果fresh status，120秒不重试。本人原任务超管密码/确认语/expected hash→真实SQL55重扫十域/五份密文→同UTC日首尾校验/零队列门槛→恢复来源启停/自动化原状态及active员工一次入队→清原dirty维护/finished，保留staging/备份。下方显式查询后启用，独立site-release-report不重写维护回执；无联网/交接锁/旧站勾选，旧站用户管理，其余pending/full_site_complete=false，未部署，见第56节 |
| `components/admin/EmployeeSiteImport.tsx` | 维护态写入向导：本机配套核验后独立只读准入，密码/确认语/独立备份目录，逐计划显式批准、聊天手选与可见性控制；body portal原生模态焦点循环，边界暂停/停止、不自动重试或假续接，首次开始后锁定重跑。非敏感JSON报告保存失败另提示，不改变已写入事实；不封存员工或自动启用/解除维护；第56节在结果下方另接SiteReleasePanel显式离线启用入口，报告独立保存。第41节旧浏览器事实保留，新隔离UI证据见56.4，未部署 |
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
