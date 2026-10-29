# 架构与公共约定

## 启动与页面切换
- `src/main.tsx`：先启用 `logger` 的生产环境日志保护，再以 StrictMode 挂载 `App`。
- `src/App.tsx`：持有 `AuthState`。没有路由器，按登录状态渲染登录页、员工端或管理员后台；两个 Dashboard 都包在 `ErrorBoundary` 内。登录页与员工端包在 `LanguageProvider` 内，管理员后台没有。
- 监听 `AUTH_LOGOUT_EVENT`（`work_platform_logout`），收到后切回登录页；监听 `AUTH_HANDOVER_EVENT`（`work_platform_handover`），用 `flushSync` 同步卸载员工页，避免旧页面的派单监听器在交接后继续动作。
- 启动时若本分页没有会话、但有未过期的「记住我」员工会话，先显示转圈，再调 `resumeRememberedSession()`（见下）决定进入员工会话检查或登录页。

## 登录与会话（自建，不用 Supabase Auth）
`src/lib/auth.ts`
- `login()`：按用户名同时查 `admins` 与 `users`，管理员优先。管理员调 `create_admin_financial_session`，员工调 `create_employee_financial_session`。
- 团队维护（迁移 `20261103000000_employee_login_maintenance.sql` + `20261103000001_team_employee_maintenance.sql`，后端已获准部署，前端待用户上线）：员工登录RPC在正确密码后持有团队共享锁并查维护；维护返回专用code，由 `auth.login` 抛 `EmployeeLoginMaintenanceError`，只弹十语言提示，不写会话／记住我或失败尝试。管理员开启维护时同事务结束该团队派单／工时、撤销旧financial会话并标注maintenance_revoked_at、清空users会话标记和取消未提交派单；共享／独占团队锁协调同时登录及交单。
- `EmployeeSessionGuard.tsx` 在员工工作区挂载前验证 `get_employee_maintenance_status`，仅真实financial token+user+tab可查维护原因（允许尚未过期的维护撤销token查原因，不授业务权限）。用户更新Realtime、可见时15秒兜底及焦点／恢复事件重查；维护后卸载工作区，专用弹窗确认才执行logout(false)，不走普通失效的自动倒计时。Dashboard各失效入口交给边界再分类。维护关闭不复活旧token；需重新登录手动开工。管理员登录与原validate_employee_session函数定义保持不变，但原validate会因会话被撤销而返回false。
- 会话存于 `sessionStorage['work_platform_auth']`（每个浏览器分页独立）：
  - 管理员：`{ user, userType: 'admin', adminSessionToken }`
  - 员工：`{ user, userType: 'employee', sessionToken, financialSessionToken, tabId, expiresAt }`（`expiresAt` 为登录请求时间 + 24 小时，前端估计值，以服务器为准；旧会话可能没有）
- 「记住我」（2026-10-10）：登录时勾选才写入 localStorage。`work_platform_remembered_username` 记账号（管理员与员工都有，登出后仍保留，下次登录预填并预设勾选）；`work_platform_remembered_auth` 记员工会话副本（仅员工）。新分页启动时：副本过期即删除；否则同时调 `get_employee_maintenance_status` 与按 `id` 重读 `users` 资料（5秒超时）；普通无效（被别处登录取代、停用、过期）删副本回登录页，维护撤销则保留到维护边界提示确认退出，避免先删掉原因。网络错误/超时不直接删除副本，但工作区仍须通过EmployeeSessionGuard验证后才挂载。`logout()` 只在副本的 `sessionToken` 与本分页相同时删除副本；不勾选登录会删除旧副本与记住的账号。`storeAuth()` 会同步更新同一会话的副本。
- 常用导出：`getAdminFinancialSessionToken()`（没有有效 token 会抛错）、`getEmployeeFinancialSession()`、`createFinancialOperationId()`（UUID）、`logout()`（撤销 financial session；员工另停止派单会话；最后派发登出事件）。`expireFinancialAdminSession(requestToken)` 专供服务器已拒绝的管理员后台轮询：只在当前管理员 token 仍匹配时同步清除本分页并派发登出事件，不等待网络、不影响新登录或员工记住我；后台卸载使在途计数请求作废。
- 数据库端验证：
  - 管理员：`private.get_financial_admin_context(token)` → `admin_id`、`admin_role`（检查 hash、过期/撤销、管理员是否启用）。
  - 员工：`private.get_financial_employee_id(user_id, token, tab_id)`；另有可调用的 `validate_employee_session` RPC。
  - 部分旧 RPC 的参数名叫 `p_admin_id`，实际传的是会话 token。
- 部署顺序：后端两份维护迁移已按用户确认部署（正式版本20261024200433、20261024200605），仍未开启任何团队。前端待用户上线；先上线含EmployeeSessionGuard的新版前端，再实际开启团队维护，确保在线员工使用专用确认退出提示。
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
- 部署后旧分页首次打开未加载的页面，可能仍请求已经失效的哈希资源。`ErrorBoundary` 只对明确的动态模块／CSS 加载失败调用 `moduleLoadRecovery.ts`：在线且 sessionStorage 可用时，以当前构建资源 URL 为标记最多自动整页刷新一次，保留原登录存储；同版本再次失败、离线或无法存储保护标记时改为专用「重新整理頁面」提示。React.lazy 缓存失败 Promise，不能仅重挂组件来重试；普通业务／程序错误仍沿用原边界，不自动刷新。仅实际呈现页面失败才触发恢复，不监听已被调用方捕获的后台预取错误。刷新会丢失未保存输入，已保存数据不变；会话若已过期仍由原鉴权处理。
- 工作区缓存 `src/lib/serviceWorkspaceCache.ts`：按管理员 + 工作区缓存，合并相同的并发请求，瞬时错误重试 2 次。
- 品牌配置：`useCompanyName()`、`useCurrencyUnit()` 读 `admin_configs`（考虑 `branding_mode` 全局/自定义），默认 `AAA SERVICE`、`USDC`，带 localStorage 缓存与 Realtime 更新。
- 登录页品牌：`Login.tsx` 将 `system_configs.login_title` / `login_subtitle` 一次读取、成组更新，并按 Supabase URL 分开缓存到 `localStorage`。无缓存时隐藏文字但保留两行位置，不提前显示公司名；有缓存时立即显示、后台刷新。配置明确没有标题或首次读取失败时，等待公司名加载结束才使用原有公司名回退；已有缓存遇读取失败保持不变，缓存不可用不阻断页面。手机、平板、桌面使用同一规则。

## src/lib 工具速查
| 文件 | 用途 |
|---|---|
| `contentAudit.ts` | 调用 Edge Function `content-audit` 的全部封装（留证改删、永久删除、私有附件读取） |
| `sanitizeHTML.ts` | DOMPurify 净化：`sanitizeHTML`、支持安全视频／封面的 `sanitizeAnnouncementContent`（公告、通知与富卡）、`sanitizeUserInput`、`sanitizeChatMessage` |
| `richVideo.ts` | 正文视频增强：开头临时封面、待播放按钮／时长、原生播放控件与卸载清理；`RichMediaContent.tsx` 封装净化后展示 |
| `fileValidation.ts` | 上传前校验文件名、MIME、扩展名、大小、文件头 |
| `imageOptimizer.ts` | 压缩 HTML 中的 base64 图片并上传 `template-images` |
| `storageUpload.ts` | 带进度的 Storage 上传 |
| `storageCleanup.ts` | 从 HTML 提取已知存储桶的文件并删除 |
| `dateUtils.ts` | UTC 日期边界与格式化；`getServerDeadline` 将服务端到期时间与当前时间的差值锚定浏览器单调时钟，供派单等待使用 |
| `safeUtils.ts` | 安全取值与格式化（数字、日期、金额、JSON） |
| `usePaginatedList.ts` | 本地数组分页 Hook |
| `passwordHash.ts` / `bcryptWorker.ts` | bcrypt（在 Web Worker 中执行，失败回退主线程） |
| `logger.ts` | 生产环境隐藏普通日志与敏感信息 |
| `moduleLoadRecovery.ts` | 识别版本分块加载失败，按构建防止自动刷新循环，不改登录或业务数据 |
| `dbValidation.ts` | 可选的 schema 检查与安全查询封装 |
| `devicePerformance.ts` / `useDeviceOptimization.ts` | 按设备性能降级动画、列表与图片；只在视口宽度变化时重新检测（手机地址栏收展只改高度），GPU 纹理上限只探测一次并释放 WebGL 上下文；没有常驻帧率监测（需要实测帧率的界面自行短时采样，见派单等待面板） |
| `responsiveBreakpoints.ts` / `useResponsive.ts` | 断点与响应式 Hook |
| `useCompanyName.ts` / `useCurrencyUnit.ts` | 公司名称与货币单位 |

## 样式与界面约定
- Tailwind 自定义断点：`xs` 360、`sm` 480、`md` 600、`lg` 1025、`xl` 1280、`2xl` 1536（与 Tailwind 默认值不同）。
- `src/index.css` 全局可复用类：`scrollbar-dark`、`audit-detail-scroll`、`audit-detail-scroll-light`、`dark-panel-scroll`、`dispatch-orders-scroll`、`login-history-*`、`message-content-dark`。
- 后台为深色 slate/cyan 风格，组件里大量内联 Tailwind。
- 公告／通知／已有富卡中的只读视频展示共用 `.rich-video-*`（`src/index.css`），保留原比例、竖屏限高，外层为浅蓝细边与3–4px柔和渐变内衬、16px圆角，`.rich-video-stage` 单独按原比例呈现画面。播放键为蓝白磨砂圆形（桌面直径104px、手机80px），搭配蓝青渐变图标与浅青光边，无可见「播放影片」文字，保留多语言 `aria-label`。Grid精确居中，真实时长位于右下、不写死；封面仅保留底部轻淡遮罩，避免压暗视频。悬停／按压围绕中心缩放；1.5px蓝青渐变边缘保留清晰外缘，通过径向透明度遮罩向内延伸5px渐变柔化，中心保持透明，不对整圈使用模糊滤镜；以6秒环绕、3.6秒明暗脉冲，深蓝／亮青／冰白色段随旋转流动，透明度在45%–100%之间变化，增强颜色闪动感但不作高频闪烁；仅动画transform／opacity，不再使用内部掠光。点击即发起播放，按钮用200ms轻缩至86%并淡出后隐藏，不延迟视频；原生控制条或键盘开始播放也衔接同样的过渡。暂停、播放拒绝、错误、结束及卸载会清除过渡定时器，避免按钮消失或旧回调误隐藏；过渡中重复激活不重复发起播放。`prefers-reduced-motion` 停用环绕／脉冲／缩放淡出，保留静态蓝色边缘并直接交还播放画面。播放时隐藏按钮，点击画面暂停后在当前帧上恢复圆形播放键，再点从原位置续播；暂停层仅图标接收指针，原生进度／音量／全屏控件仍可用，隐藏重复的自定义时长。触屏通过轻触处理，滑动不触发暂停，底部56px留给原生控件。缺失、失效或近乎全黑的封面会临时重建：上传与展示共用32×18像素检测，只有99%以上像素各色通道均不超过20才判为黑帧；依次尝试0.001／0.1／0.5／1／2／3／5秒（不超过视频一半），找到可见画面即停止；全程黑色视频有限次后停止，不循环重试。有效非黑封面保留，临时封面不回写历史内容；第一次播放仍从0开始。卸载移除两层包装、暂停视频、恢复原封面并撤销临时URL。播放器浅色文案要压过 `.message-content-dark` 的正文强制深色规则；编辑器不注入展示层按钮，避免临时URL和播放壳写回保存内容。
- Tailwind 另有两个按屏幕高度的自定义变体（`tailwind.config.js`）：`short:` = 高 ≤640px，`low:` = 高 ≤520px；注册顺序保证两者同时成立时 `low:` 生效。
- 登录页按 `useResponsive` 选版面：手机版用于宽 <480，以及宽 480–659 且高 >520 的竖屏；平板版（左右两栏）用于宽 660–1024，或高 ≤520 的横放手机（`low:` 紧凑两栏）；>1024 为电脑版。注意 `isTablet` 从 480px 开始（`xl` 类别），不是 600px。手机版常规上下间距随屏高伸缩（`clamp(…vh…)` 加有最小值的 flex 空白），矮屏用 `short:`/`low:` 收紧；宽≤359px，或宽≤375px且高≤640px时，由仅作用于 `.login-phone` 的紧凑样式将品牌名设为13px、主标题20px；品牌副标题以 `clamp(8px, 3vw, 11px)` 单行显示（320px宽时9.6px），既定英文B2B文案可完整显示。品牌到标题、标题到卡片、卡片到底部空白按3:2:1分配剩余高度，前两段分别限制在16–96px／20–64px，不再把剩余空间主要放在卡片下方；320×568英文卡片顶部约198px。卡片统一16px外边距／18px内边距，输入框与提交按钮视觉高度至少44px；输入文字计算字号保留16px，用 `.login-phone-input-wrap` 的44px容器及0.8125缩放呈现13px文字，宽高、内边距和圆角反向补偿，不缩小实际点击区域，兼顾iOS聚焦字号阈值；占位文字视觉12px，提交文字13px。常规手机及平板／桌面不套用这些覆盖。三种版面根元素都带 `login-page`（`src/index.css`：最小高100dvh并隐藏滚动条，必要时仍可滑动）；紧凑版正文块不被flex压缩，错误提示或键盘缩窗时允许页面增高并滚动。
- 登录背景：手机保留四块、平板保留三块半透明渐变圆角色块，移除背景SVG网格／路线／货柜／波纹线稿与额外旋转方块；保留原底色渐变和全部前景图标、标题细节。桌面背景组件 `LoginDecorations` 的顶部渐变以蓝色为主，叠加左青右淡靛蓝径向色彩，向下平滑淡出至白色；渐变高度 `clamp(360px,65vh,720px)`，仅装饰层、不接收指针事件，保留原有地球与贸易图案。
- 登录主标题三端共用 `.login-hero-title` 和内层 `.login-hero-title-text`，保留单个语义h1及完整翻译文案。手机／平板蓝底使用白至冰蓝文字渐变，桌面浅底使用藏蓝至主题蓝渐变；下方2px渐隐线与4px菱形为纯CSS装饰，三端线长44／52／64px，不含闪动、轮播或额外请求。手机及平板标题与内层文字明确使用800粗体，移除小屏600字重覆盖；桌面保持700。保留原分级字号（紧凑手机20px），拉丁语轻微收紧字距、中日韩及印地语保留自然字距，支持时均衡多行；平板／桌面适度增加标题到说明的间距，≤520px矮窗收紧。文字渐变放在独立span上，未支持文字裁剪的浏览器沿用原白色／深色；强制颜色模式恢复系统文字色并隐藏装饰，不限制用户缩放。
- 平板登录版使用局部 `.login-tablet-*` 类，不改变设备分类或员工后台断点。宽≥660px且高≥521px时，品牌名称18–20px、副标题13–14px，44px图标搭配12px间距，副标题改为70%白以增强可读性。宽≥660px、高≥641px且竖屏（含700×840）时，品牌区独立放在顶部并占据可用全宽，既定英文品牌／B2B副标题各一行；下方左侧说明占46%，右侧卡片不再强制340px最小宽（700px时约326px），顶部预留112–144px、底部64px，底部在线状态独立定位，安全标签缩小列间距。横屏平板保留原双栏结构并同步放大品牌；≤520px矮窗保留紧凑版原字号，手机与桌面不套用平板覆盖。
- `src/index.css` 会按屏宽和触控改按钮尺寸：宽 ≤320/321–375/376–414 时所有 `button`、`input` 被 `!important` 撑到最小高 40/44/48px，根字号也变为 12/13/14px（415–480 为 15px，所以 rem 尺寸随设备变化）；触控设备（`pointer: coarse`）上 class 不含 `w-[`/`h-[` 的按钮另加最小 44×44 和 `12px 16px` 内边距。小按钮要在各设备同尺寸：用像素尺寸（如 `h-[30px]`，同时避开触控规则）再加 `!min-h-0`（压过按屏宽的规则），可参考 `src/pages/Login.tsx` 的眼睛与语言按钮。
- 员工端（`body:has(.employee-shell)`）在上述缩小根字号的窄屏上另有字号下限：宽 ≤414 时 `text-xs` 为 11px，≤320 时 `text-sm` 为 11.5px；员工端组件像素字号最小 11px。手机横屏提示 `PhoneLandscapeGuard` 以 z-index 2147483000 覆盖整页（登录页与员工端）。细节见 `docs/employee-portal.md`「屏幕适配」。
- 有多个超大单文件组件：`CccServiceManagement.tsx`（6000+ 行）、`EmployeeManagement.tsx`（约 5900 行）、`CustomerServiceManagement.tsx`（约 5100 行）、`OrderDispatch.tsx`（约 4800 行）。修改前先用搜索定位，尽量小范围改动。
- 命名：组件 PascalCase，函数与变量 camelCase，Hook `use*`，数据库字段 snake_case。

## 构建与部署
- `package.json` scripts：`dev`、`build`、`lint`、`preview`、`typecheck`、`test:audit-cleanup`；`test:module-recovery` 验证分块错误分类、跨刷新保护、版本切换、离线、存储受限和登录存储保留。
- TypeScript strict，开启 `noUnusedLocals`、`noUnusedParameters`；ESLint 9 flat config（TS 推荐规则 + react-hooks + react-refresh）。
- `vite.config.ts`：分包，构建时移除 `debugger` 与 console 日志。
- `vercel.json`：安装与构建分别执行 `npm install`、`npm run build`，执行前用 `env -u` 清除不受支持的 `npm_config_cache_dir` / `NPM_CONFIG_CACHE_DIR`，保留合法 `npm_config_cache`；若 Vercel 控制台覆盖了安装或构建命令，需同步这两个命令。输出 `dist`；所有路径 rewrite 到 `index.html`（SPA）；静态资源长缓存；CSP 的 `connect-src` 只允许 `'self'`、`https://*.supabase.co`、`wss://*.supabase.co`。
- `package.json.allowScripts` 仅许可锁文件中的 `esbuild@0.21.5` 安装脚本，不全局放开依赖脚本；升级 esbuild 时重新审查并同步此版本许可。
- 环境变量：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`，可选 `VITE_FORCE_PRODUCTION_LOGS`（见 `.env.local.example`）。
