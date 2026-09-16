# dsh-voice-alert

DSH（DeepSeek Harness）**对话语音播报插件**：一轮对话结束自动播报「完成」语音，
出现错误 / 工具失败时播报「失败」语音。播放**绝不改动系统音量或静音状态**。

**v0.4.0** **开源准备**（可直接分发给别人，**零配置开箱即用**）：
* **默认提醒方式 = 🎵 音效**：装完即用，不需要任何 API Key、不需要任何音频文件（20 个音效随包提供）。
* **默认播放内核 = waveOut / WAV**（`playerEngine: "wav"`）：实测在蓝牙耳机下 **不吞第一声、不打断正在播的音乐**；由 ffmpeg 首次播放时自动转 WAV 并缓存（~60ms / 200~300KB）。旧内核 `"mci"`（DirectShow）保留为可选。
* **默认音色库为空**：插件不内置任何具体音色（克隆音色是各人自己的）；想用自己的声音按 §4.1 填自己的音色 ID + Key，再一键生成三条语音。
* **个人路径全部中性化**：`originalsDir` 默认在插件自己的数据目录内、`ffmpegPath` 默认走 PATH 探测、`playerScript`/`volumeProbeScript` 默认留空（只用自带播放器）。使用者无需改代码。
* 新增 `.gitignore`（排除 `__pycache__` / `config.json` / 音频产物）。发布前已核查：**无密钥、无用户名、无内网信息**。

**v0.3.9** 备选播放内核 **waveOut / WAV**（默认仍是 MCI，行为零变化，`config.playerEngine = "wav"` 一键切换）：
* 为什么：主内核 MCI `type mpegvideo` 走 DirectShow，会创建播放图并打开音频端点；在蓝牙耳机上可能触发链路重协商，**打断其他正在播放的音乐**（用户 2026-09-16 反复反馈"播报/音效后音乐显示在播但没声音"）。waveOut（`winsound`）是 Windows 最基础的播放路径：**不启 DirectShow 图、不枚举设备、不改端点格式**，对链路和其他播放器冲击最小。
* 实现：新增 `lib/play_wav_out.py`（waveOut 播放器，含 350ms 静音预热 + 毫秒级阶段日志）；host 侧新增 `ensureWavCache()` 用 ffmpeg **一次性把 mp3 转成 WAV 并缓存**（实测单文件 64ms / 236KB，源文件更新会自动重转），`playKind`/`playSfx` 在 wav 引擎下优先走它，**任何失败自动回退 MCI**，绝不因为换内核而静音。
* 实测：wav 内核 611ms 出声、总耗时 5.8s（与 MCI 的 605ms / 6.1s 相当）。
* 自测新增 12 组断言（内核解析/缓存路径/命令形状/真实转换/真实 wav 播放），全绿。

**v0.3.8** 延迟优化（用户要求：对话结束到出声更快）+ 延迟可测量：
* **预热与打开文件并行**：静音预热放进子线程，主线程同时做 MCI `open`（实测 open 只要 38ms，现在完全被预热窗口吞掉）——唤醒效果不变。
* **实测**：播放器进程启动 → 开始出声 = **610ms**（其中预热 350ms + 链路稳定等待 150ms 是"第一次就有声"的代价）；加上 powershell/python 启动（约 200~400ms），**对话结束到听见声音约 0.8~1.0 秒**。触发本身仍是 **1ms 内**（`play launched` 与 `turn-end` 同毫秒）。
* **毫秒级阶段日志**：日志变成 `[时间.毫秒] sfx-player: +610ms play issued rc=0`，以后任何延迟疑问都能直接对着日志算，不用再猜。自测新增两条断言锁住「进程启动→出声 <900ms」和「open 发生在预热窗口内」。

**v0.3.7** 「**强制重新生成**」改成**一次性**（用户 2026-09-16 确认）：勾上后**本次**把三条语音全部重新合成（真实调用 TTS），提交成功后**自动取消勾选**；提交失败则保留勾选便于直接重试。标签改为「强制重新生成（仅本次）」并加了说明气泡。原来的坑：勾选框不会复位，勾一次后每次生成都强制重做三条、白耗额度。
* 顺带明确语义：不勾时插件比对每条语音的「指纹」（文案 + 音色 ID + 语速 + 音调 + 音量）——**全都没变就复用现有 mp3、完全不调用 TTS**；哪条变了只重做那一条；文件缺失也会自动重做。

**v0.3.6** 把「没声音怎么办」写进界面：总控卡「▶ 试听一下」正下方新增**常驻提示**（`dva-audio-tip`）——「点了试听没声音？把系统音量拖一下再点一次就有声了 —— 蓝牙耳机 / 虚拟声卡空闲挂起时，系统会把第一次播放吞掉，调音量正好把它唤醒」。

**v0.3.5** 修「**刚生成语音后点试听没声音，调一下系统音量就有声音**」（用户实测报告，根因探针实测非推测）：
* **实测证据**：MCI `open`/`play` 返回码全 0、`status position` 正常推进（229→482→733→983 ms）、`mode=playing`、系统音量 35% 非静音——音频确实在"播放"；而同一时刻 Core Audio 探针（`IMMDeviceEnumerator`）读出**默认输出设备 = 耳机 (EDIFIER Lolli Pro 5)，即蓝牙耳机**（三个 role 一致）。蓝牙 A2DP 链路空闲后会挂起，这段时间 Windows 仍把音频"成功"送进驱动、**耳机端不出声**；**调节系统音量会立刻激活链路**——这正是"调一下音量之后就有声音"的来源。虚拟声卡端点未唤醒时同理。
* **修复**：播放前先用 **350 ms 静音预热默认端点**（同步等待链路建立），再播真实音频；预热只播静音，**不读写任何音量 / 静音接口**（硬规则不变）。
* **顺带修一处旧缺陷**：MCI `play` 的返回码此前被完全忽略，播放失败会被当成"播完了"（静默误报成功）。现在检查返回码，失败重试一次。
* **诊断留痕**：播放全程写进插件日志（`--log-file`），含 `prewarm ok` / `play_rc` / `positions` —— 以后遇到无声可查 `<data>\voice-alert.log` 直接判断是"没播起来"还是"播了但端点没出声"。
* 若仍偶发无声：多半是蓝牙耳机 / 虚拟声卡的省电策略所致，可在「设备管理器 → 蓝牙适配器 → 电源管理」取消勾选"允许计算机关闭此设备以节约电源"，或改用有线耳机。

**v0.3.4** 依用户反馈再修（**界面不再出现任何具体人名**，插件可直接分发给别人用）：
* 音色名一律由使用者在「音色备注」里自己填（默认留空）；界面只叫「**🎙 我的音色 · 语音合成**」。
* **音效改成可勾选列表**：20 个音效各占一行，行内三个勾选框（完成/失败/审批，同事件互斥）+ 音效名 + 「▶ 试听」。列表由 React 直接渲染，根治 v0.3.3「选了没反应」（下拉 option 被重渲染清空）。
* **一键生成 + 明确反馈**：点「🎙 生成语音（一键更新）」会**先自动保存文案再合成**；运行中显示 `x/y` 进度，结束后明确显示「**✅ 语音更新成功！已重新合成 N 条，复用 M 条**」，失败显示「⚠️ 语音更新失败：… 合成出错」。
* **克隆入口写进界面**：新增「克隆音色」行 + 两个链接——[声音复刻控制台](https://console.volcengine.com/speech/app)、[产品介绍/开通](https://www.volcengine.com/product/voicecloning)。
* **修复「有时点试听没声音」**：所有播放入口（引擎播报 / `/preview` / `/sfx/play`）**串行化**——等上一个播完再开下一个，避免两个 python+MCI 进程抢声卡导致后一个静默失败。

**v0.3.3** 新增**音效提醒**：内置 **20 个音效**（提醒 10：叮咚/电话铃/消息提示/闹钟/滴滴/清脆叮/钟声/成功号角/欢快音/木鱼；大自然 10：鸟鸣/蝉鸣/蛙鸣/雨声/海浪/溪流/风声/篝火/雷鸣/森林），设置页一个全局「提醒方式」三选：**🗣 语音播报 / 🎵 音效 / 🔕 关闭**。音效模式**完全不调用 TTS、不需要 API Key**；选音效时展开「完成 / 失败 / 审批」三个勾选（默认 成功号角 / 木鱼 / 叮咚），每行可一键试听。详见 §4.2。

> v0.3.3 同版修正：**「🎙 我的音色 · 语音合成」卡常驻页面**（不再藏进折叠区）——三条播报文案 + 试听 + **一键生成主按钮**一目了然。

**v0.3.2** 设置页 UI 傻瓜化重做（`lib/client.js`）：中文优先字体（微软雅黑，标题 16px/正文 14px/行距 1.6）、卡片式分区（语音播报总控大卡 → 常用设置卡 → 「高级设置」折叠卡，默认收起）、主次分明的按钮布局（「▶ 试听一下」大按钮 + 强调色主按钮，hover/active 反馈）；高级项（文案/API Key/音色库/系统音量/日志）收进折叠面板，折叠只影响可见性、DOM 元素全部保留。

**v0.3.1** 在 DSH 原生设置页新增**音色库**能力（`lib/client.js` 渲染的「语音播报」分区，见 §4.1：克隆/预设双路由、批量导入、试合验证；v0.3.1 已移除 v0.3.0 的朗读面板）。

A DSH plugin that deterministically plays a fixed voice alert when a conversation turn finishes and a
different one when something failed, plus a settings-section voice library.

---

## 1. 它做什么

| 事件 | 语音 | 文件（默认优先播放增益版） |
|---|---|---|
| 任意一个 **turn 结束** | 完成 | `voice-alert-complete-poetic-loud.mp3` |
| 该 turn 内出现过错误（`agent/error` 或工具 `isError`） | 失败 | `voice-alert-fail-poetic-loud.mp3` |
| 立即错误播报（工具失败/agent 报错当下，节流 5s） | 失败 | 同上 |
| 手动验证（HTTP 路由） | 完成/失败/审批 | `voice-alert-approval-poetic-loud.mp3` |

音频**永不改动系统音量与静音状态**：播放器用 winmm/MCI「原样播放」（系统多大就多大，系统静音就无声），
不读写任何音频控制接口。响度问题通过**音频文件本身**解决（见 §4）。

---

## 2. 事件依据（官方源码实证，非猜测）

| 用途 | 事件 | 出处（已装官方包） |
|---|---|---|
| 判「一个 turn 结束」 | `session/event` 且 `event.type === "turn/end"` | `@deepseek-ai/dsh-agent-loop/lib/index.js:994`（`finally` 里 append `turn/end`） |
| 识别 turn 开始（用于归属错误） | `session/event` 且 `event.type === "turn/start"` | 同上 `:926` |
| 判「出现错误」 | `agent/error`，payload `{agent, turn, step, error}` | 同上 `:863`（`throwError`），且在 `turn/end` **之前**发出（`:991` → `:994`） |
| 判「工具失败」 | `tools/result` 的 `result.isError` | `@deepseek-ai/dsh-tools/lib/types/index.js:3287`（以 `exec.agent` 为 scope 派发） |

关键结论：

* `turn/end` **每个 turn 只发一次**（不是每个 step），所以含大量工具调用的长任务只会按 turn 播报；含工具的一轮会话不会因为 step 多而重复播报。
* `agent/status`（running→idle）只在「整个 agent 彻底空闲」时变化，**不是**每 turn 信号，因此没有采用。
* `session/event` 的**历史回放不发事件**（构造函数种子不 emit，见 `dsh-session/lib/index.js` 注释），所以 DSH 重启 / 恢复会话不会误报。

---

## 3. 去重与错误优先（实现要点）

* **同一 turn 只播一次**：以 `sessionId#turn` 为键登记，重复的 `turn/end` 直接忽略（缓存上限由 `dedupeCacheSize` 控制）。
* **错误优先**：`turn/start` 打开该会话的 turn 记录；该 turn 内出现 `agent/error` 或 `tools/result.isError` 即把该 turn 标记为 errored；
  `turn/end` 时若已 errored → 只播**失败**，不叠加播完成。
* **错误节流**：立即失败播报受 `errorMinIntervalMs`（默认 5000ms）约束，同一时间窗内只播一次。
* **断「失败+完成」连声**（2026-09-15 新增）：任意 fail 语音播出后 `suppressCompleteAfterFailMs`（默认 3000ms）之内，
  `turn/end` 的 **complete 一律抑制并记日志**（`suppressedComplete` 计数）。两个开关彼此独立：`errorMinIntervalMs` 管 fail 自身节流，
  `suppressCompleteAfterFailMs` 只管「fail 之后是否还允许立刻播 complete」；设 `0` 关闭本闸门。
  实测场景（宿主日志 2026-09-15 11:28:23）：`agent/error` 播 fail 后 0.26s，同 turn 的 `turn/end` 又播 complete → 本闸门消除。
* **turn/end 的 reason 映射**：`completed` / `max-tokens` → 完成；`error` / `blocked` → 失败；`aborted`（用户中断）默认**不播**（`abortPlays: none|complete|fail`）。
* **子代理会话默认不播**：按会话 header 的 `origin === "subagent"` / `delegationDepth > 0` 判定（`skipSubagentSessions`，默认 true），
  避免一个长任务里子代理每轮都播；需要时设 `countSubagentErrors: true` 让子代理错误也计入父会话。

---

## 4. 响度（"声音太小"的根因与解法）

真因：**系统主音量只有 9.0%**（未静音）。用户明确选择**不调整系统音量**（2026-08-26 铁律），
因此只从音频文件侧解决。原始 poetic MP3 实测（ffmpeg volumedetect）：

| 文件 | 原始 mean_volume | 原始 max_volume | 增益版 mean | 增益版 max | 提升 |
|---|---|---|---|---|---|
| voice-alert-complete-poetic.mp3 | −20.8 dB | −7.0 dB | −8.7 dB | −0.6 dB | +12.1 dB |
| voice-alert-fail-poetic.mp3 | −20.9 dB | −5.1 dB | −8.7 dB | −0.5 dB | +12.2 dB |
| voice-alert-approval-poetic.mp3 | −19.9 dB | −5.3 dB | −8.8 dB | 0.0 dB | +11.1 dB |

* 处理链：`volume=+26dB,alimiter=limit=0.98:level=disabled`（限幅器把峰值压在 0.98≈−0.17 dBFS 之下，不削波）。
* 生成方式：本地 ffmpeg 一键增益（该脚本是本机开发脚本，含本机绝对路径，**不随开源包发布**），输出到 `<home>\.dsh\data\dsh-voice-alert\audio\voice-alert-<kind>-poetic-loud.mp3`。
* **原始 MP3 一律不改动**，插件播放优先级：**增益版 → 原始版 → 蜂鸣降级**。
* 增益版与原始版都用插件自带的 `lib/play_mp3_mci.py` 播放（`--file`，winmm/MCI「原样播放」机制）。
  仅当你自己在 `config.json` 里配了 `playerScript`（可选的共享播放器）时，原始版才改走它的 `--kind` 入口。
  两者都**不读写任何音频控制接口**：系统音量多大就多大，系统静音就无声。
* 关闭增益版：`config.json` 里 `"preferLoudAudio": false`。

---

## 4.1 音色库（需求 A · v0.3.0）

设置页「语音播报」分区新增**音色库**小节，管理两类火山 TTS 音色：

| 类型 | 端点 | Resource | Key | 判定 |
|---|---|---|---|---|
| 克隆（`clone`） | `/api/v3/tts/unidirectional` | `seed-icl-2.0` | 控制台 Key（`tts.apiKey`） | ID 以 `S_` 开头 |
| 预设（`preset`） | `/api/v3/plan/tts/unidirectional` | `seed-tts-2.0` | Agent Plan Key（`presetApiKey`，`ark-…`） | ID 以 `zh_`/`BV` 等开头 |

* 每行显示：类型徽标、音色 ID、可用性（✓可用 / 缺 key）、备注（可编辑）、「设为当前」、「试合」、「删除」。
* **试合**：约 20 字短文本真实调用一次 TTS（不写入任何文件），成功显示 `✓ N B`，失败显示火山返回的错误码/信息。
* **批量导入**：粘贴多行 `ID,备注`（`#` 为注释）或 JSON 数组，自动识别类型、自动去重，幂等可反复导入。
* **删除**：正在使用的克隆音色不可删；其余随时可删。改完点「保存音色库」把整个数组写回 `config.json`，手工添加的音色重启不丢。
* **生成侧按 kind 路由**：合成前按音色类型选 endpoint/resource/key/speaker，混用必 401/403 的坑已被显式拒绝——预设音色被选但 `presetApiKey` 未配置时，返回明确错误 `preset-key-missing`，绝不静默用错 Key。
* 生成接口（`POST /generate`）支持 `speakerId` 参数，缺省用当前选中音色；音色切换会改变生成指纹，自动触发重合成。
* 预设音色 Key 入口：音色库小节底部「预设音色 Key」输入框（`ark-…`，留空不修改），随「保存音色库」写入 `config.json` 的 `presetApiKey`。

**默认音色库为空**（v0.4.0 开源决定）：插件不代你选音色。克隆音色到火山「声音复刻」做（拿到 `S_` 开头的 ID），
预设音色需要自己的 Agent Plan Key（`ark-…`）。两者都在设置页「音色库」里添加或批量导入，只存本机 `config.json`。

---

## 4.2 音效提醒（需求 B · v0.3.3）

不想折腾火山音色 / 不需要 API Key 时，把「提醒方式」切到 **🎵 音效** 即可：turn 结束就播一个内置音效。

**内置 20 个音效**（`<data>\sfx\*.mp3`，单声道 44.1 kHz / libmp3lame 128k，已做响度统一）：

| 分组 | 音效 |
|---|---|
| 提醒（10） | 叮咚 / 电话铃 / 消息提示 / 闹钟 / 滴滴 / 清脆叮 / 钟声 / 成功号角 / 欢快音 / 木鱼 |
| 大自然（10） | 鸟鸣 / 蝉鸣 / 蛙鸣 / 雨声 / 海浪 / 溪流 / 风声 / 篝火 / 雷鸣 / 森林 |

* **默认分配**：完成 → 成功号角，失败 → 木鱼，审批 → 叮咚（`sfxByKind`，可逐个更换）。
* **选择方式**（v0.3.4）：每个音效一行，行内三个勾选框（完成/失败/审批，**同一事件只能勾一个**）+ 音效名 + 「▶ 试听」；列表由 React 直接渲染（不再用 DOM 追加 option，那会被重渲染清空）。
* **试听**：「▶ 试听」走 `GET /sfx/play?name=<key>`，**不经过引擎**，绝不会影响完成/失败的判定；v0.3.4 起试听会**排队**（等上一个播完），连点不再出现"没声音"。
* **完整性**：`GET /sfx/list` 返回目录 + 每个文件是否在库（`present`），设置页显示「共 20 个内置音效，已在库 N 个」。
* **来源**：提醒 10 个来自 Windows 系统音效（转 mp3）+ 1 个合成木鱼音；大自然 10 个来自 pacdv.com / mixkit.co 免费音效库。全部随插件本机存放，无外链。
* **安全**：播放文件名只接受 `[a-z0-9-]` 的目录 key（`sfxPathFor` 再校验一次），`/sfx/play?name=../../x` 直接 400；音效同样走 scratch copy，不会被播放占用。

### 提醒方式三种取值

| `alertMode` | 行为 | 需要 API Key |
|---|---|---|
| `voice`（默认） | 用你的克隆音色朗读三条文案（原行为） | 需要 |
| `sfx` | 播内置音效，**完全不调用 TTS** | 不需要 |
| `off` | 完成 / 失败 / 审批都不提醒 | 不需要 |

> `enabled`（总开关）优先级最高：关掉后三种模式一律静音（引擎层拦截，UI 保存立即生效）。

---

## 5. 配置

`<home>\.dsh\data\dsh-voice-alert\config.json`（首次启动自动写入默认值；不存在则用内置默认值，默认开启）。
优先级：内置默认值 < config.json < 插件 `cordis.patch.yml` 的 `config` 行 < 环境变量。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（关掉 = 语音和音效都静音） |
| `alertMode` | `"voice"` | 提醒方式：`voice` 语音 / `sfx` 音效 / `off` 关闭（v0.3.3） |
| `sfxByKind` | 成功号角 / 木鱼 / 叮咚 | 音效模式下三类事件各播哪个音效（v0.3.3，key 必须是内置目录里的） |
| `sfxDir` | `<data>\sfx` | 内置音效目录（v0.3.3） |
| `playOnTurnEnd` | `true` | 每个 turn 结束播一次 |
| `playFailOnError` | `true` | 出错当下立即播失败（受节流约束） |
| `turnEndPlaysFailWhenErrored` | `true` | 该 turn 已出错 → turn 结束只播失败 |
| `errorMinIntervalMs` | `5000` | 错误播报最短间隔（fail 自身节流） |
| `suppressCompleteAfterFailMs` | `3000` | fail 播出后 N ms 内的 complete 一律抑制（断连声）；`0` 关闭 |
| `abortPlays` | `"none"` | 用户中断的 turn：`none` / `complete` / `fail` |
| `skipSubagentSessions` | `true` | 子代理会话不播 |
| `countSubagentErrors` | `false` | 子代理错误是否计入父会话 |
| `preferLoudAudio` | `true` | 优先播放增益版（音量不低的那一档） |
| `loudSuffix` / `audioDir` / `originalsDir` | `-loud` / `<data>\audio` / 原始目录 | 音频定位 |
| `pythonPath` / `playerScript` / `bundledPlayer` | 见文件 | 播放器路径 |
| `fallbackBeep` | `true` | 播不了时蜂鸣降级 |
| `controlFile` / `controlResultFile` / `statusFile` | `<data>\control.txt` / `control-result.txt` / `status.json` | 免凭据文件控制通道 |
| `controlPollMs` | `2000` | 控制文件轮询间隔 |
| `logPath` / `logMaxBytes` | `<data>\voice-alert.log` / 1MB | 插件日志 |
| `voices` | `[]`（空库） | 音色库（完整数组，可被 `/voices/save` 整体覆盖，手工添加重启不丢） |
| `selectedVoiceId` | `""` | 当前选中音色（生成缺省用它；为空时需先在音色库点「设为当前」） |
| `presetApiKey` | `""` | 预设音色用的 Agent Plan Key（`ark-…`）；未配置时预设音色合成拒绝返回 `preset-key-missing` |

环境变量覆盖：`DSH_VOICE_ALERT_PYTHON` / `DSH_VOICE_ALERT_PLAYER` / `DSH_VOICE_ALERT_LOG` / `DSH_VOICE_ALERT_DISABLED=1`。

---

## 5.1 蓝牙耳机注意事项（实测 2026-09-16）

如果默认输出是**蓝牙耳机**，可能遇到「播报/试听后音乐显示在播却没声音」或「播报打断音乐」。**这不是插件的问题**：

* **实测证据**：50ms 逐帧采样（会话音量 / 会话状态 / 端点状态 / 端点采样率格式）显示——
  播报期间**音乐会话音量恒为 100%、未静音、会话 Active、端点 `state=1` 与 `44100Hz/2ch` 全程不变**，
  播报自身每次 `play_rc=0`、position 平滑推进。也就是说 **Windows 音频层没有任何"断开音乐"的动作**。
* **真正的原因在蓝牙链路层**：A2DP 链路在「新音频会话加入/离开」时会重协商，这段时间耳机端可能短暂
  不出声或吞掉正在播的流（Windows 完全看不到这一层）。调一下系统音量 / 重播一次通常能恢复。
* **判定方法**：换 USB/有线耳机（或内置声卡）后一切正常 → 即可确认是蓝牙链路问题。
* **缓解手段（按省事排序）**：
  1. 默认输出改成**有线 / USB 耳机**（最彻底）；
  2. 播放内核：**v0.4.0 起默认就是 waveOut**（实测对蓝牙更温和）；若你手工改成了 `"mci"`，改回 `"wav"` 即可；
  3. 设备管理器 → 蓝牙适配器 → 电源管理 → 取消「允许计算机关闭此设备以节约电源」；
  4. 更新蓝牙驱动 / 重新配对耳机；耳机若支持多点连接，别让手机同时连着抢占。

* **实测案例（2026-09-16）**：某台机器上蓝牙是 **CSR「BT DONGLE10」USB dongle（`VID_0A12`）+ 微软通用驱动**
  （`bth.inf`，驱动日期 2006）。症状：**音乐放一会儿自己就断**、插件播报也时有时无。而探针逐帧显示
  **音乐会话音量 100%、会话全程 Active、端点 `state=1`、端点采样率格式恒定、音频峰值 > 0**
  —— Windows 层一切正常，数据确实在往蓝牙送，**只是耳机不发声**。
  * **判定**：同一副耳机连**手机**正常、连**电脑**就断 → **电脑蓝牙侧的锅**（耳机没问题）。
  * **结论**：老芯片 + 通用驱动的组合，蓝牙音频长时丢流**没有软件可修**（无厂商驱动、主板也没内置蓝牙可切）。
  * **对策**：换一个 **Realtek RTL8761B** 芯片的 USB 蓝牙 5.x 适配器（免驱，几十元）；
    或直接改用 **USB / 有线耳机** —— 同样条件下实测：**音乐不断 + 播报全听到**。

---

## 6. 播放链路（为什么这样启动）
```
DSH 宿主 (node) ──spawn──> powershell.exe（隐藏、无管道、unref）
                             └─ Start-Process ─> python.exe（播放器，父进程是 powershell）
```

* python **不是** DSH 的直接子进程，powershell 约 1s 后自行退出，播放进程随即成为独立进程；
  DSH 会话/job 销毁只能杀掉那个已经退出的 launcher，**杀不到正在播放的声音**。
* 🔴 **实测坑（勿改回）**：`spawn(..., { detached: true })`（DETACHED_PROCESS）在本机让 `powershell.exe`
  **静默退出、什么都不执行**（退出码 0）。用 marker 探针实测：detached→无副作用，非 detached→子进程正常生成。
  因此"独立"由 `Start-Process` 实现，而不是 node 的 detached 标志（见 `lib/player.js` 顶部注释与
  `test/self-check.mjs` 的 `LAUNCH_OPTIONS` 断言）。
* 播放失败全线静默降级（缺文件 → 蜂鸣；异常 → 只写日志），绝不影响 DSH 运行。

---

## 7. 部署（desktop + web）

```powershell
cd <你的插件源码目录>          # 例：你 clone 下来的 dsh-voice-alert/
# 把整个目录拷到 ~\.dsh\local-plugins\dsh-voice-alert，再在 profile 里声明 link: 依赖与 bundles
```

> 本机原有的两个开发脚本（`dev-deploy-local.ps1` / `dev-install-profiles.ps1`）含本机绝对路径，
> **不随开源包发布**，因此上面的命令需要你按自己的环境手动执行。

安装形态与本机既有插件一致：`local-plugins` 持久目录 + profile `dependencies` 的 `link:` 声明 + `bundles` 声明 +
`node_modules` Junction。**不使用 `file:`（tgz）依赖**，避免触发 DSH 的 plugin-install-recovery 死循环。
改完需要**重启 DSH** 才加载（重启需用户批准）。

---

## 8. 自检（可独立运行，不经 DSH）

```powershell
node test\self-check.mjs              # 全量：逻辑 + 播放链路 marker 实证 + 真实出声
node test\self-check.mjs --no-sound   # 只跑逻辑与形状断言，不出声
```

> ⚠️ **完整模式会真的出声**（会连续播几条语音/音效，用来验证音频链路）。它**绕过提醒方式设置**
> 直接调播放器，所以即使你把「提醒方式」设成语音，也会听到音效测试用例在响。
> **不想被吵就用 `--no-sound`**（v0.4.2 起真实播放用例之间已加等待，不会几条叠在一起合唱）。

覆盖 **278 项断言**（完整模式含真实播放/播放器触发时 **299 项**）：事件回调是否真的驱动播放、每 turn 去重、错误优先、5s 节流、**fail→complete 连声闸门（1s 内不播 / 4s 后照播 / 设 0 关闭）**、
子代理跳过、abort 策略、总开关、播放命令形状（必须 powershell Start-Process、不得 DETACHED_PROCESS）、
增益版优先/原始版回退/无音频静默降级、**免凭据控制通道（控制文件触发 + status.json 快照 + 非法内容拒绝）**、
**HTTP 路由层（注册路径 + 回环 200 / 非回环 403 / 未知 kind 400）**，以及**真实播放链路**
（marker 文件证明子进程真的被拉起——直接链路与控制文件链路各验一次，并用同步播放验证 exit code 0 与占用音频设备时长）。
v0.3.0 追加：音色库保存/导入/去重（`saveVoicesConfig`/`parseVoiceImport`/`mergeVoiceImport`）、试合探针（mock TTS）、
**kind 路由（clone vs preset 的 endpoint/resource/key/speaker 选择，mock 断言）**；
v0.3.1 起额外断言**不再注册任何 `/reading/*` 路由**（朗读功能已移除）。

---

## 9. 诊断接口与免凭据控制通道

### 9.1 HTTP 路由（回环）

| 路由 | 作用 |
|---|---|
| `GET /dsh-voice-alert/status` | 解析后的配置、音频解析结果（增益版/原始版）、计数器 |
| `GET /dsh-voice-alert/play?kind=complete\|fail\|approval` | 手动真播一次，用于重启后验证 |
| `GET /dsh-voice-alert/reload` | 重新读取 `config.json`（不用重启 DSH） |
| `GET /dsh-voice-alert/voices` | 音色库列表 + 选中 ID + 各音色可用性（clone 有 key / preset 有 key） |
| `POST /dsh-voice-alert/voices/save` | 保存整个 voices 数组 + 选中 + `presetApiKey`（写入 config.json） |
| `POST /dsh-voice-alert/voices/import` | 批量导入（多行 `ID,备注` 或 JSON 数组，自动识别类型、去重） |
| `POST /dsh-voice-alert/voices/probe` | 试合：约 20 字真实 TTS 一次（不写文件），返回 `{ok, bytes, code, error}` |
| `GET /dsh-voice-alert/sfx/list` | 内置音效目录（20 项 + 每项是否在库 `present`）+ 当前 `alertMode`/`sfxByKind`（v0.3.3） |
| `GET /dsh-voice-alert/sfx/play?name=<key>` | 试听一个内置音效；`name` 必须是目录 key，否则 400（v0.3.3） |

🔴 **DSH Desktop 上的 403 是官方设计，不是插件 bug**（2026-09-15 实证）：
桌面壳把**所有** HTTP 路由（含插件路由）包了一层浏览器访问闸门——

* `C:\Program Files\DSH Desktop Beta\resources\app\lib\webserver.js:42-53`
  `DesktopWebServer.permits()` → 不通过则 `rejectBrowserRequest()` → `403` + 头 `cache-control: no-store`、`x-content-type-options: nosniff`、体 `forbidden`；
* `...\resources\app\lib\desktop-browser-access-5-Ph3Uv7.js:47-51`
  `decideDesktopBrowserAccess()`：请求带 Electron 渲染器能力头 `x-dsh-desktop-renderer:<每代随机 token>` → 放行；
  否则若 `ordinaryBrowserEnabled === false` → `denied`（即 403）；`ordinaryBrowserEnabled` 只在
  `desktop-network-*.js:21-23` 的「compatibility 模式 且 (openBrowser 或 networkExposure=lan)」时为真。
* 反证：`curl http://127.0.0.1:43120/`、`/api/ping`、`/dsh-todo-float-ball/health` 同样全部 403 —— 与该插件无关。

因此**普通本机请求无法（也不应）绕过**这层闸门；要让它放行只能改 DSH Desktop 的浏览器访问设置（需重启，属用户决策）。
插件自身也另有一道回环校验（非回环一律 403，与外壳闸门无关，已在自检中覆盖）。

### 9.2 免凭据控制通道（推荐用这个做验收）

| 动作 | 做法 |
|---|---|
| 真播一次 | 写入 `%USERPROFILE%\.dsh\data\dsh-voice-alert\control.txt`，内容 `kind=complete`（或 `fail` / `approval`）；插件在 `controlPollMs`（默认 2s）内播放并**自动删除**该文件 |
| 读取状态 | 读 `%USERPROFILE%\.dsh\data\dsh-voice-alert\status.json`（与 `/status` 同一份 JSON：配置、音频解析、规则、计数器、控制通道说明） |
| 上次触发结果 | 读 `%USERPROFILE%\.dsh\data\dsh-voice-alert\control-result.txt` |

```powershell
# 触发一次真播放（无需任何凭据）
Set-Content "$env:USERPROFILE\.dsh\data\dsh-voice-alert\control.txt" "kind=complete" -Encoding ascii
Start-Sleep -Seconds 3
Get-Content "$env:USERPROFILE\.dsh\data\dsh-voice-alert\status.json"
```

在 DSH 窗口内（DevTools 控制台）也可以直接 `await fetch('/dsh-voice-alert/status').then(r=>r.json())` ——
渲染器请求自带能力头，会通过外壳闸门。

---

## 10. 卸载

1. 从两个 profile 的 `package.json` 删掉 `dependencies` 项与 `bundles` 项（可从 `.bak-*` 恢复）；
2. 删除 `<profile>\node_modules\dsh-voice-alert` Junction（只是链接，不删数据）；
3. 可选：删除 `<home>\.dsh\local-plugins\dsh-voice-alert` 与 `<home>\.dsh\data\dsh-voice-alert`。

## License

MIT
