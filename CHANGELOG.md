# Changelog

## 0.4.15 — 2026-10-24

### 缺陷修复

| 严重度 | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| P0 | 设置页「保存音色库」时，若预设音色 Key 输入框留空，会把 config.json 里已保存的 `presetApiKey` 覆盖成空串，且无提示、无备份 | `/voices/save` 把请求里的 `presetApiKey: ""` 当作「用户要清空」直接写入；前端 `voiceSave()` 也无条件提交该字段 | 三层守卫：①前端留空时**根本不带该字段**（`client.js` `voiceSave()`）；②宿主 `/voices/save` 只在 `length > 0` 时才写；③`saveVoicesConfig()` 落盘前同样只接受非空值，清空必须显式传 `clearPresetApiKey: true` |
| P2 | 预设音色 Key 状态在前端不显示「是否已配置」，用户无法判断留空是否安全 | 缺少状态回显 | 新增 `renderPresetKeyState()`：已配置显示「已配置（mask）· 留空表示不修改」，未配置显示引导文案 |

### 说明

- 本次改动不涉及任何默认值变更，已有 `config.json` 不受影响。
- 需重启 DSH 使宿主侧守卫生效。

## 0.4.14 — 2026-10-24

### 新增功能

| 功能 | 说明 |
|---|---|
| **下载 MP3** | 每条播报的「试听」旁新增「⬇ 下载」，把当前音频存成 mp3 文件。宿主新增 `GET /audio/download?kind=&variant=loud|origin`，返回 `audio/mpeg` + `Content-Disposition: attachment`；`variant` 可选增益版（默认）或原件 |
| **导入 MP3** | 每条播报的「试听」旁新增「⬆ 导入」，用你自己的 mp3 替换该条播报。宿主新增 `POST /audio/import?kind=`，接收原始 mp3 字节（上限 10 MB），落盘前自动备份到 `audio\backups\import-<ts>\`，同时写 origin 与 loud 两份并清掉过期 wav 缓存；前端导入成功后自动试听一次 |
| **撤销导入** | 已导入的播报旁多一个「↩ 撤销导入」，从导入时的备份还原 origin + loud 并删掉标记。宿主新增 `POST /audio/import/undo?kind=`；`/settings` 与 `/status` 顶层回显 `imported: {complete,fail,approval}` |
| **错误原因中文化** | 宿主返回的英文 reason（`not an mp3` / `audio file not found` / `body too large` 等 9 类）在前端统一翻成中文人话，未知原因保留原文兜底 |

### 缺陷修复

| 严重度 | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| P0 | 响度增益全部跳过、wav 播放内核永远降级 MCI | `ffmpegPath` 指向不存在的 Tecplot 路径 | ffmpeg 复制进插件数据目录 `<data>\bin\ffmpeg.exe` 并改配置 |
| P0 | `originalsDir` 指向不存在的旧路径 → original 候选恒不存在 | 配置遗留 | 改为 `<data>\audio\origin` |
| P0 | 每次生成都全量重合成，白耗 TTS 额度 | `generate.js` 的 fingerprint 落库条件误排除 `gainSkipped` | 改为 `if (entry && entry.ok)`，并删掉随之成为死代码的 `else if` 分支 |
| P1 | 播放时长按 192/160 kbps 估算，实际 mp3 为 64 kbps → 21.4s 只算成 7.15s，槽位提前释放抢声卡导致「点试听没声音」 | 固定码率常量 | 新增 `lib/mp3info.js` 纯 JS 解析 MP3 帧头（含 VBR Xing 头），head-slice 只读 64 KB；旧公式保留为 fallback |
| P1 | 同一 turn 内多次工具失败连续播多次 fail | `agent/error` 与 `tools/result` 各自 emit，5s 窗只限速不按轮去重 | 新增 `failOncePerTurn`（默认 true），同 turn 内 fail 只播一次；手动 `/play` 豁免 |
| P0 | 用户导入的 mp3 会被「生成语音」静默覆盖（改任意一条文案就冲掉全部导入，且无备份） | 合成流水线只比对文案指纹，完全不知道磁盘上的音频是用户导入的 | 导入时写标记 `audio\origin\voice-alert-<kind>-poetic.imported.json`（含 backupDir/sha256）；`generate.js` 在 `planChanges` 与 `generateOne` 两处按标记跳过该 kind，只有 `force`（强制重新生成）才覆盖 |
| P2 | 导入长音频（或长台词）时，排队等声卡的 24 s 固定上限会在音频还没放完时提前放弃，新进程抢声卡 → 又回到「静默无声」 | `acquirePlaybackSlot` 用固定次数 `guard < 200` × 120 ms = 24 s，与放宽到 120 s 的时长上限脱节 | 改成按「当前占用剩余时长 + 5 s 余量」动态算截止时间，轮询节奏仍是 120 ms |

### UI 改进

三张卡片统一圆角 + 轻投影 + 图标标题（🔔 播报开关 / ✍️ 播报内容 / ⚙️ 高级设置），每张卡片加一句白话说明；试听 / 下载 / 导入收进同一动作组；卡片二改「一行一个事件」色点小块并分四段（✍️ 文案 / 🎚 声音设置 / 🚀 生成语音 / 🎤 换音色）；高级设置分三段（🔑 Key / 🔊 系统音量 / 🎼 音色库）。**原有 56 个 `dva-*` id（141 处引用）与 44 个函数逐个比对，删除 0 个，无功能删减**。

### 新增路由

| 路由 | 作用 |
|---|---|
| `GET /dsh-voice-alert/audio/download?kind=<kind>&variant=loud|origin` | 下载该条播报 mp3（二进制流） |
| `POST /dsh-voice-alert/audio/import?kind=<kind>` | 导入 mp3 替换该条播报（原始字节 body），成功后写导入标记 |
| `POST /dsh-voice-alert/audio/import/undo?kind=<kind>` | 撤销导入，从备份还原 origin + loud 并删标记 |

### 自检

`node test/self-check.mjs --no-sound` → **passed 325 / failed 1**（唯一失败为测试自身环境限制：self-check 用 mkdtemp 自建临时配置、不走运行时 config.json，故其 ffmpeg 仍为 null）。
## 0.4.13 — 2026-10-19

### 文档与代码对齐（无运行时改动）

对 README、插件描述、locale 文案做了一次逐条比对，把 8 处「文档说得比代码多」的地方全部改回真实行为。

| # | 位置 | 原写法 | 实际行为 | 取证 |
|---|---|---|---|---|
| 1 | README 提醒方式表 / 首段 | 「自动播报完成/失败/审批」 | 自动播报**只有完成 / 失败**两种 | 只监听 `session/event`（turn 结束）、`agent/error`、`tools/result`；`engine.js` 无任何权限/审批事件监听 |
| 2 | README 手动验证表 | 「完成/失败/审批」并列，读起来像三事件都自动 | `approval` 仅能手动触发 `GET /play?kind=approval` / `preview` / 控制文件 | 同上 |
| 3 | README `alertMode` 表 | `voice` 标为「默认」 | 默认是 **`sfx`**（装完即用，不需要 Key） | `lib/config.js:223` `alertMode` 默认值 `"sfx"` |
| 4 | README 断言数 | 278 项（完整 299） | **312 项**（`--no-sound`）/ 完整模式 **335 项** | `node test/self-check.mjs --no-sound` 实跑 |
| 5 | README 处理链 | `alimiter=limit=0.98` | `limit=0.95`（峰值压 0.95≈−0.45 dBFS） | 实际 ffmpeg 参数 |
| 6 | README 环境变量 | 4 个 | 6 个（漏 `DSH_VOICE_ALERT_TTS_KEY`、`DSH_VOICE_ALERT_FFMPEG`） | `lib/config.js:642-650` |
| 7 | README 路由表 | 缺 4 条 | 漏 `/settings`、`/generate`、`/generate-status`、`/preview` | `lib/index.js` 路由注册 |
| 8 | `cordis.patch.yml` 注释 | 「host-only，无客户端 bundle、无 UI」 | 有 `lib/client.js`（`__ModuleLoader__` bundle，`platform: web`）渲染设置页卡片 | `package.json` `dsh.client` + `lib/client.js` 存在 |

### 同步内容

- `package.json` `version` 0.4.12 → **0.4.13**；`description` 改为「自动播报完成/失败 + 审批手动」，中英双语
- `locale/zh.json` / `locale/en.json` `description` 同步（原先写「任务里程碑」且未提三种提醒方式）
- `README.md` 新增「⚠️ 关于审批事件」警示块，首段、提醒方式表、手动验证表、`alertMode` 表、断言数、处理链、环境变量、路由表共 8 处修正
- `cordis.patch.yml` 注释由「host-only」改为「host + web-client bundle row」

### 教训

写 README 时把「音效槽位有三个」误当成「自动事件有三个」。槽位数量 ≠ 事件源数量——`sfxByKind` 里有 `approval` 这一格，不代表有代码去触发它。

## 0.4.12 — 2026-10-14

### 合规性改进（无功能改动）

本次为**纯元数据与文档改动，未触碰任何运行代码**（`lib/*.js` 与上一版逐字节一致）：

- **包元数据**：`engines.node` 对齐 DSH 运行时（`^22.19.0 || >=24.0.0`）；补 `packageManager`；`files` 白名单补上裸目录 `lib`、`locale/*.json`、`icon.svg` 与多语言 README；`exports` 补 `./locale/*.json` 与 `./icon`。
- **交付元数据**（官方插件契约要求）：新增 `locale/en.json` 与 `locale/zh.json`（含 `meta.title` / `meta.description`），新增 `icon.svg`（插件管理器显示用图标，不再显示裸 id）。
- **多语言文档**：新增 `README-zh.md` 中文说明；`README-es/pt/hi.md` 标题与主 README 对齐。

以上改动使插件通过官方 `dsh-plugin-dev check` 全部检查项（`P=12 F=0 W=0`）。

### Compliance improvements (no functional changes)

This release is **metadata and documentation only — no runtime code was touched** (`lib/*.js` is byte-identical to the previous version):

- **Package metadata**: `engines.node` aligned with the DSH runtime (`^22.19.0 || >=24.0.0`); `packageManager` added; `files` allowlist now includes the bare `lib` directory, `locale/*.json`, `icon.svg` and the multi-language READMEs; `exports` gained `./locale/*.json` and `./icon`.
- **Display metadata** (required by the official plugin contract): added `locale/en.json` and `locale/zh.json` with `meta.title` / `meta.description`, plus `icon.svg` so the plugin manager shows a real name and icon instead of a bare id.
- **Multi-language docs**: added `README-zh.md`; `README-es/pt/hi.md` headings aligned with the main README.

With these changes the packages pass every official `dsh-plugin-dev check` item (`P=12 F=0 W=0`).

---

## 0.4.11 - 文档：新增设置页实拍效果图

- **新增 `assets/settings-panel.png`**（设置页实拍，742×878）：README 顶部宣传区展示，
  一眼看到插件长什么样。
- **`files` 白名单补 `assets/*.png`** —— 这一步不能漏：不在白名单里的文件**不会进 npm 包**，
  症状是「GitHub 上有图、npm 用户看到的 README 没图」。

无功能变更，只加文档与配图。

## 0.4.10 - 修复：语速/音调/音量 输入框溢出卡片右边缘

**问题**：设置页「我的音色 · 语音合成」里的 **语速 / 音调 / 音量** 一行，
第三个输入框跑到卡片**外面**（用户截图反馈）。

**根因**：这一行的 flex 项宽度被 `min-width` **锁死**，无法收缩——
标签 `min-width:60px` × 3 + 输入框 `flex:0 0 88px; min-width:88px` × 3 + 间距 10px × 5
= **最小 494px**。设置面板（含侧栏与卡片内边距）比这窄时，因为每个盒子都
拒绝收缩，整行只能**横向溢出**卡片右边界。

同类问题还有几处：文案输入框 `min-width:200px`、音色 ID 备注 `flex:0 0 110px`、
音效名 `flex:0 0 84px`——都是"锁死宽度"，窄面板下同样会顶出去。

**修法**（三个层面，缺一不可）：

1. **行允许换行**：所有含输入的行改用 `flexWrap:"wrap"`——宽度不够时折成两行，
   而不是溢出（比"压窄控件"更不容易把字挤没）。
2. **解除宽度锁**：标签 `min-width` 改为相对单位（`2.6em`/`3.2em`/`6em`），
   数字框 `flex:"0 1 84px"`（**收缩因子 1**，可缩）+ `minWidth:56px`，
   文案框 `flex:"1 1 200px"` + `minWidth:0`。
3. **容器可压缩**：卡片与根容器补 `minWidth:0` + `boxSizing:border-box`，
   避免父级 flex 按"内容最小宽度"把卡片自身撑开。

**验证**：新增 10 条布局回归断言（第 15 节）——禁止再出现 `minWidth >= 100px`
的死值、要求数字框收缩因子非 0 且为 border-box、要求存在换行样式。
自检 **312 项全过**。

无行为变更，只改外观与布局。

## 0.4.9 - 修复：浅色背景下设置页文字看不清（配色改为跟随宿主主题）

**问题**：设置页在深色背景下正常，切到**浅色背景就几乎看不见字**。

**根因**：客户端界面的颜色是**写死的深色主题色**——正文用半透明白
`rgba(255,255,255,.85)`、标题 `#e6edf3`、次要文字 `#8b93a8`，容器底用半透明白
`rgba(255,255,255,.10)` 加黑色输入框底 `rgba(0,0,0,.28)`。
深色背景下"白字＋亮底"正常，**浅色背景下白字落在白底上＝完全不可见**。

**修法**：不用"再写一套浅色"，而是改用**宿主的设计令牌**。DSH 主题服务
（`@deepseek-ai/dsh-client-ui-theme`）在浅/深两套调色板上重绑 `--dsw-alias-*`
变量（深色由 `body[data-ds-dark-theme]` 选择器切换），令牌随主题**自动反转**，
因此同一份代码在两种背景下都可读，也不会在换肤或"跟随系统"时失配。

- 新增 `TOKEN` 配色表，把 52 处硬编码色全部替换为主题令牌：
  文字走 `--dsw-alias-label-primary/secondary`，卡片与输入框底走
  `--dsw-alias-bg-layer-1/2`，控件底走 `--dsw-alias-interactive-bg-hover/active`，
  边框走 `--dsw-alias-border-l2/l3`，主色走 `--dsw-alias-brand-primary`，
  状态色走 `--dsw-alias-state-*`。
- 每个令牌都带 `var(..., 兜底灰阶)`：万一宿主令牌缺失，退回中性灰阶（仍可读），
  而不是退回白底白字。
- 顺带修掉两处**同源但更隐蔽**的不可读色：宿主 `state-success-primary`
  绑的是 `green-500 #22c55e`（白底对比度仅 2.28）、`state-warn-primary` 绑
  `amber-500 #f59e0b`（白底仅 2.15），且这两个静态色**浅/深两套主题同值、
  不随主题反转**，直接拿来做文字色在浅色下同样看不清。现分别用
  `color-mix` 与文字语义令牌派生，两种主题下均达标。
- 新增 22 条回归断言（自检第 14 节）：禁止再写死深色专用色 / 白字 / 黑底，
  并正面要求"节点颜色确实走 `--dsw-alias-*`"，防止只是把颜色删掉。

**验证**：自检 302 项全过；另按 WCAG 对比度对浅/深两套主题逐令牌实测，
正文类令牌浅色 5.80~18.90、深色 8.54~17.45，全部达标。

无行为变更，只改外观。

## 0.4.8 - 补齐 npm 包元数据（repository / homepage）

本版无功能变更，仅修正包元数据——它直接决定插件市场能否采集到本插件的下载量。

- **补 `repository` 字段**：此前 `package.json` 缺 `repository`，导致上游
  awesome-dsh-plugin 的 `scripts/probe-npm.mjs` 在「npm 包是否属于该仓库」这一步
  判定失败（该脚本读取 registry 里 `latest` 版本的 `repository`，要求包含对应
  GitHub 仓库路径），于是 `data/npm-map.json` 不收录本条目、`downloads` 在
  `plugins.json` 里落成 `null`。
- **症状**：插件市场列表与详情页**不显示下载量数字**（看起来像"一个下载都没有"），
  实际 npm 近30天有 800+ 次下载；同时收录条目会降级为 `github:` 安装方式、
  不展示 npm 版本号。
- **补 `homepage` 字段**：指向仓库 README，用于 npm 页面与市场条目的主页链接。

## 0.4.7 - 官方 DSH 兼容声明与引擎版本口径修正

依照 DeepSeek Harness **官方规范**（`packages/boot/app-boot/README.md`）修正兼容性声明。

- **新增官方 DSH 兼容声明**：内核检查的是 `peerDependencies` 中的
  `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 范围，**不读取 `engines.dsh`**。
  现已在 `peerDependencies` 与 `devDependencies` 同范围声明：
  `@deepseek-ai/cordis` `^4.0.2`、`@deepseek-ai/dsh` `>=0.1.7-rc.1`。
- **引擎口径修正为内核版本**：此前 `engines` 只写 `node`，未声明 DSH 内核要求；
  现补 `engines.dsh = >=0.1.7-rc.1`（内核版本口径，非客户端/外壳版本）。
- 说明：`^0.1.7` **不匹配**预发布内核 `0.1.7-rc.2`，故范围使用显式预发布下限。

无功能变更。


## v0.4.5 (2026-09-17) — 文档与描述双语化

- **package.json description 改为中英双语卖点式**：此前描述里塞满了 v0.3.1～v0.4.4 的逐版本变更记录，用户在 npm / 插件市场列表页根本读不完；现改为先说价值（让 DSH 干完活会开口说话），再列能力（三条播报 / 20 个内置音效 / 克隆音色 / 绝不改动系统音量）。
- **README 顶部新增宣传区**：中英双钩子 + 语音播报设置页截图 + 图注 + 「为什么值得装」中英段落 + 四条卖点速览；原有全部版本历史整体下沉到 `## 版本历史 / Changelog` 标题之下，内容一字未删。另补 `CHANGELOG.md` 小结文件。
- **description 最终收敛**（本次复核）：只保留「功能简介」一段中英双语，逐版本变更历史（v0.3.1～v0.4.4）全部归入本文件下方，不再挤在 package.json 里。

## 版本历史（自 description 迁入）

### 0.4.4

- 隐私清理：去除开发机绝对路径与设备型号，改用示例 Key 掩码。
- 修复自检 `--no-sound` 仍会真的出声的问题。

### 0.4.0

- 开源准备：默认音色库为空（不预置任何私人音色）。
- 个人路径全部中性化，不再写死开发机目录。
- 默认使用「音效」模式，开箱即用、无需任何 Key。

### 0.3.9

- 备选播放内核：`playerEngine=wav`（waveOut / WAV 路径）。

### 0.3.8

- 预热与打开文件并行执行；新增毫秒级阶段日志，便于定位播放卡点。

### 0.3.7

- 「强制重新生成」改为一次性操作，避免误触重复生成。

### 0.3.6

- 界面常驻「没声音怎么办」提示。

### 0.3.5

- 修复「第一声没声音」（实测根因：蓝牙 A2DP 挂起）：播放前静音预热 + 检查 MCI play 返回码。

### 0.3.4

- 去掉具体人名（音色名由使用者自行备注）。
- 音效改为可勾选列表；新增生成进度与成功提示；补充克隆入口网址。

### 0.3.3

- 新增音效提醒。

### 0.3.2

- 设置页傻瓜化：中文优先字体、卡片式分区、高级项折叠。

### 0.3.1

- 移除朗读面板。
