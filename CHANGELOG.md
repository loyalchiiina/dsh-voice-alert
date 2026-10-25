# Changelog

## 0.4.18 — 2026-10-26

修四个用户实测报回的界面缺陷（都是**看得见的空/看不见的按钮**，不是数据丢）。

### 1. 音色库「每次重载都消失」（用户原话：「你现在这个音色库怎么没东西啊，每次重载都会消失吗」）

**根因**：设置面板是 React 槽位（`settings.section`）。`renderVoiceRows()` 是**命令式**写 DOM —— 把行 `replaceChildren` 塞进 `#dva-voice-rows`。而宿主随时可能把整棵 section 重渲染（切页签、其他插件注册/刷新），React 只认自己的 vdom，重渲染会把那个空容器**重建成全新的空 div**，命令式塞进去的行全部蒸发。同时 `loadSettings()` 被 `cache.loaded` 挡住不再跑，所以界面就永久停在「读取中…」+ 空音色库。**盘上的 `config.json` 一直是好的**（3 条音色俱在），纯前端显示问题。

**修法**：`SettingsSection` 重挂载时自愈 —— `cache.loaded` 已真就重放轻量读路径 `loadVoices()`（幂等 GET，重画行 + 预设 Key 状态）+ `refreshAllActionGroups()`；带 1.5 s 节流，避免切页签时打爆宿主回环路由。首装路径（`!cache.loaded`）行为不变。

| 类别 | 改动 | 位置 |
|---|---|---|
| 修复 | 重挂载自愈分支（`else if (cache.loaded)` → `loadVoices()` + `refreshAllActionGroups()`，1.5 s 节流） | `lib/client.js` `SettingsSection` |
| 新增断言 | 20r / 20r2 —— 锁住自愈分支存在且在 `loadSettings` 守卫的同一 `try` 内 | `test/self-check.mjs` §20 |

### 2. 「我的音色库」看不到删除按钮（用户原话：「我的音色库需要key没有删除的按钮」）

**根因**：行布局是左栏 `libLeft`（id + 可用状态）+ 右栏 `libRight`（试听结果 + **删除按钮**）。两栏 span 都 `document.createElement` 了，但**只有 `libLeft` 被 `row.appendChild`** —— `libRight` 建好后从没挂到行上，于是删除按钮和试听结果框一直在内存里飘着，界面上永远看不见。`row.appendChild(libRight)` 这一行缺失。

**修法**：补挂 `libRight`；同时把删除从「只改 cache 等下次保存」改成**点完即存**（`POST /voices/save` 全量库），否则用户以为删了、重载又回来（与「设为当前」同口径）。

| 类别 | 改动 | 位置 |
|---|---|---|
| 修复 | 补 `row.appendChild(libRight)` —— 删除按钮 / 试听结果终于可见 | `lib/client.js` `renderVoiceRows` |
| 变更 | 删除按钮点完即存（`POST /voices/save`），失败回滚并提示原因 | `lib/client.js` 删除 handler |
| 新增断言 | 20s / 20s2 / 20s3 / 20t —— 锁住两栏都挂回 row、无游离 `row.appendChild(avail/setBtn)` 旧写法、删除即存 | `test/self-check.mjs` §20 |

### 3. 音色库「有时候不显示」（用户原话：「不要出现有时候不显示的音色库内容的情况」）

**根因**：上一版的自愈走 `setTimeout(0)` —— 是**下一帧**才补。React 清空容器的那一帧到补画之间，界面上确实是一个空槽位，肉眼可见地闪一下；宿主重渲染频繁时就成了「有时候不显示」。

**修法**：给 `#dva-voice-rows` 挂 `MutationObserver`（`childList`）。React 一清空，回调**在同一轮微任务里同步重画**，肉眼看不到空档；纯内存重放 `cache`，不发任何网络请求。`cache.rowsRendering` 闸门挡住自己 `replaceChildren` 触发的递归。容器被 React 重建成新节点时，`rowsWatched` 比对失败会自动重挂观察器。空 cache（首装还没读到）不补画，保留「读取中…」。

| 类别 | 改动 | 位置 |
|---|---|---|
| 修复 | `watchRowsContainer()`：MutationObserver 同步补画 + `rowsRendering` 递归闸门 + 容器换了自动重挂 | `lib/client.js` `renderVoiceRows` 之后 |
| 修复 | 自愈分支里 `rowsWiped && cache 有数据` 时直接 `renderVoiceRows()`，不再走一趟网络 | `lib/client.js` `SettingsSection` |
| 新增断言 | 20v / 20v2 / 20v2b / 20v2c / 20v3 / 20v4 / 20v5 / 20v6 / 20v7 / 20v8 | `test/self-check.mjs` §20 |

### 4. 删除按钮仍然「用不了」（用户二次反馈：「我的音色库需要key没有删除的按钮」）

**根因**：`libRight` 挂回 `row` 之后按钮看得见了，但**「正在使用的克隆音色」那一行按钮是 `disabled` 的**（`delBtn.disabled = inUse`）。用户库里只有一个克隆音色时，唯一那行的删除按钮永远是灰的 —— 等于「还是没有删除按钮」。

**修法**：删除按钮**任何行都可用**。删掉当前正在用的音色由宿主 `/voices/save` 的 D2 归位兜底（选择悬空 → 自动落到剩下的第一个音色，删空则置空串），不会留下指向不存在 id 的悬空选择。客户端回填 `selectedVoiceId` 改用 `!== undefined` 判 —— 删空时宿主回的是空串（合法值），用 `||` 会把已删的旧 id 又留回来。

| 类别 | 改动 | 位置 |
|---|---|---|
| 修复 | `delBtn` 恒可用；tooltip 改成「当前正在使用；删除后会自动切到库里第一个音色」 | `lib/client.js` 删除按钮 |
| 修复 | 回填 `selectedVoiceId` 用 `!== undefined` 判（空串是合法值） | `lib/client.js` 删除 handler |
| 新增断言 | 20w / 20w2 / 20w3 / 20w4 / 20w5 | `test/self-check.mjs` §20 |

### 5. 试听图标的悬浮气泡「显示不完整 / 出框」（用户原话：「试听的展开消息显示不完整出框了」）

**根因**：气泡 `.dva-tip-bubble` 是 `position:absolute` 挂在 ⓘ / 🔈 图标上，靠纯 CSS 的 `left:0` / `left:auto;right:0` 猜对齐。CSS **无法得知两件事**：①祖先容器（宿主设置页的滚动容器就是 `overflow:auto`）的裁剪边界在哪；②自己展开后到底有多宽（`width:max-content` + `max-width:300px`）。所以只要图标贴着面板左/右边缘，300px 宽的气泡必然顶出去被裁 —— 用户看到的就是「展开消息显示不完整 / 出框」。这不是文案问题，也不是宽度写得太大，而是**绝对定位元素天生看不见祖先的裁剪矩形**。

**修法**：浮出的瞬间用 JS 实测真实矩形，再夹回可见区（`lib/client.js` 新增定位器三件套）：

| 函数 | 职责 |
|---|---|
| `tipClipRect(wrap)` | 从锚点向上遍历到 `body`，对每个 `getComputedStyle` 里 `overflowX/overflowY` 非 `visible` 的祖先取其矩形，与视口求**交集** → 得到真正的可见区域（没有裁剪祖先时退化为视口） |
| `placeTip(wrap)` | 先按可用宽度夹紧 `maxWidth = min(300, avail)` / `minWidth = min(180, avail)`；复位 `left:0` 再测宽；水平方向「右越界左移、左越界右移」夹回可见区；垂直方向下方放不下而上方更宽裕时翻到锚点上方展开。返回实测结果（含 `inside` 布尔）供自检与排错读，任何一步异常返回 `null` 而不是抛错 |
| `ensureTipPlacement()` | 在 `document` 上挂**一次**委托监听（`cache.tipPlacement` 闸门）：`mouseover`/`focusin` 浮出时定位、`mouseout`/`focusout` 清 `tipActive`、`scroll`/`resize` 按新位置重算（不是只在 hover 那一刻算一次） |

面板入口 `SettingsSection` 在 `ensureTipStyle()` 之后调用 `ensureTipPlacement()`；三个函数同时从 `exports.__dvaTest` 导出，供自检做桩几何功能测试。

| 类别 | 改动 | 位置 |
|---|---|---|
| 修复 | 新增 `TIP_EDGE_PAD` / `tipClipRect()` / `placeTip()` / `ensureTipPlacement()`，气泡浮出即实测夹紧 | `lib/client.js:1972-2090` |
| 修复 | `cache` 新增 `tipPlacement` / `tipActive` 两字段（监听只挂一次、记住当前浮出项） | `lib/client.js` `cache` |
| 修复 | 面板入口武装定位器 + 测试面导出三件套 | `lib/client.js` `SettingsSection` / `exports.__dvaTest` |
| 新增断言 | 20x / 20x2 / 20x3 / 20x4 / 20x5（源码静态：三件套齐备、只挂一次、宽度位置真被夹紧、滚动缩放会重算）+ 20x6 / 20x7 / 20x8 / 20x9（桩几何功能测试：窄面板 300→184 夹到可见区、贴右边缘整体左移、下方不够翻到上方、无裁剪祖先退化为视口不抛错） | `test/self-check.mjs` §20x |

> **为什么必须两层断言**：自检的假 DOM 里 `style` 是空对象、没有布局引擎，`position:absolute` + `overflow` 裁剪完全测不出来。只写源码静态断言等于「函数名写了」的自嗨。所以第二层给 `placeTip` 喂假矩形，断言它**真的**把气泡夹回 `inside === true`。变异测试确认非空跑：删掉水平夹紧 → 20x6/20x7 同时变红；删掉入口 `ensureTipPlacement()` 调用 → 20x2 变红。

### 6. 效果图更新（用户 2026-10-26 提供两张实拍）

README 顶部宣传区换成 **0.4.18 双图并排**：左 = 语音播报模式（`assets/settings-panel.png`），右 = 音效模式（新增 `assets/settings-panel-sfx.png`）。发布前已做**脱敏马赛克**：两处 API Key 掩码前缀、当前音色与 5 个克隆音色 ID、底部本机备份路径、音色 ID 输入框与批量导入的占位示例文本。旧图 `docs/images/voice-alert-settings.png`（757×1038，无引用）从仓库移除，原图均备份于 `_backup/20261026-before-new-shots/`。

### 自检

`--no-sound` 实测 **472 过 / 0 失败 / 6 跳过**（`SELF-CHECK OK`）。构成：§1–§16 共 **360** + §17 **41** + §18 **21** + §19 **8** + §20 **42** = **472**。§20 从 10 条增到 42 条 = 本轮新增 20r / 20r2 / 20s / 20s2 / 20s3 / 20t / 20u / 20u2 八条（音色库删除按钮 + 自愈）+ 20v / 20v2 / 20v2b / 20v2c / 20v3 / 20v4 / 20v5 / 20v6 / 20v7 / 20v8 十条（MutationObserver 防抹：盯容器 + 盯父节点发现换节点 + body 级槽位出生看门狗）+ 20w / 20w2 / 20w3 / 20w4 / 20w5 五条（删除按钮恒可用 + 删当前音色归位）+ 20x / 20x2 / 20x3 / 20x4 / 20x5 / 20x6 / 20x7 / 20x8 / 20x9 九条（悬浮气泡不出框：定位器 + 桩几何功能测试）。


## 0.4.17 — 2026-10-24

两块叠加发版：**A. 界面紧凑改造** + **B. 内嵌免费音色（edge-tts，零 Key）**。

### A. 界面紧凑改造（用户 2026-10 反馈）

> 用户原话：**「字体太大太稀疏，往下滑不方便；最上面的下载导入没用，三条播报那里有下载导入就够了；最好一目了然」**

| 类别 | 改动 | 位置 |
|---|---|---|
| 变更 | 删掉「🔔 播报开关」卡顶部的 ⬇下载 MP3 / ⬆导入 MP3 按钮组及其说明行 —— 「✍️ 播报内容」里每条播报本来就各带一对（含审批），顶部那排是冗余 | `lib/client.js`（原位置留注释说明缘由） |
| 变更 | 25+2+2 处样式压缩：外层容器 gap 12 → 8px、卡片 padding 16/18 → 11/13px、卡片内 gap → 8px、卡标题 17 → 15px、`subText`/`cardDesc` → 11.5px、分节标题 → 12.5px、输入框 → 12.5px、主按钮 15 → 13px、次按钮 → 12.5px、模式按钮 → 12.5px、行内动作按钮 → 11.5px、音效分组/行 → 11.5px、音效勾选/迷你按钮/文本域 → 11px、状态行 `#dva-status` → 12px | `lib/client.js` 样式常量区 |
| 变更 | 5 段冗长说明文案精简（一屏能看全，不再占三行） | `lib/client.js` 文案 |
| 变更 | **常驻说明文字一律改成悬浮提示**（用户第二轮反馈：「你这些提示词我不是说了改成悬浮展示吗」）—— 顶栏「平时保持勾选即可…」与「🔈 试听没声音？先把系统音量拖一下再点…」、提醒方式说明、音效面板用法、「播报内容」写法说明，全部收进 ⓘ / 🔈 图标后的悬浮气泡（`:hover` / `:focus-within` 才显示，默认 `visibility:hidden`，不占版面）。样式只注入一次（必须用 `<style>` 注入，因为 inline style 表达不了 `:hover`），气泡配色走主题令牌；`dva-alert-mode-hint` 等由 JS 写入的 id 全部保留在气泡内 | `lib/client.js` `tip()` / `ensureTipStyle()` 及各调用点 |
| 修复 | **音色库每行右侧按钮被挤出卡片、按钮文字被压成竖排单字**（用户第三轮反馈，带截图：「这按钮都出去了这完全没必要弄两行。按钮，或者输入栏紧凑整齐一点能一行就不要拐行」）—— 根因是每行动作区里有多个**不可收缩**的固定宽度单元格（`flex:0 0 210px` / `220px` / `130px`）与备注框 `min-width:110px` 的硬底，窄面板下它们拒绝让位，合计宽度超过卡片可用宽度，把后面三个按钮推出卡片右缘；按钮自身又可换行，于是被压成一列单字 | 行容器改 `flex-wrap:nowrap` + `min-width:0`；文本列由 `flex:0 0 <px>` 改 `flex:0 1 <px>` + `min-width:0`（允许收缩）；备注框 `min-width` 归零、改 `flex:1 1 110px`；探测结果列加省略号；按钮加 `flex:0 0 auto;white-space:nowrap`（不缩不折）。「🎚 声音设置」的数值输入框同步收窄（84 → 72px）、「音色备注」框由横贯整卡改为 `0 1 240px` | `lib/client.js` `btnMini` / `renderVoiceRows()` / `numberInputStyle()` |
| 新增断言 | **`§20l` 把上面这条「一行放下」不变量锁成永久回归**（行容器必须 `nowrap` + `min-width:0`、文本列必须可收缩、按钮必须不缩不折） | `test/self-check.mjs` |
| 变更 | **「声音设置」卡也改成「一行放下」+ 音色备注说明改悬浮提示**（用户第四轮反馈：「这没必要拐行把弄一行就行了有需要提示得悬浮提示就行了」）—— 「音色固定为你自己克隆的音色，不可更换；备注只写在本机 config.json。」这句原先常驻在备注框后面，窄面板下被挤成第二行、整张卡白多占一行高度。现在：①说明搬进 ⓘ 悬浮气泡（气泡里那个节点仍是 `#dva-voice-note-policy`，宿主侧 `setText` 一字未改）；②该行改用新增的 `rowNowrapStyle`（`flex-wrap:nowrap` + `min-width:0`），备注框改成吃掉行的剩余宽度（`flex:1 1 160px`，封顶 260px），窄面板下只会变窄、不再折行；顺带给 `tip()` 加了 `node` 形态（气泡内容可给 React 节点，id 挂在气泡内部而不是 ⓘ 图标上） | `lib/client.js` |
| 新增断言 | **`§20m` / `§20n`**：断言那句说明确实住在气泡里（且旧的常驻形态已消失）、该行确实是 `rowNowrapStyle`；配合 `§20l2` 的「不可收缩单元格 ≤ 70px」，把「一行放下」钉成永久回归 | `test/self-check.mjs` |
| 修复 | **「声音设置」卡真·合成一行**（用户第五轮反馈原话：「给你说了改成一行，为啥还是两行」）—— 上一版只做了「行内不换行」，可备注行（`key: "voice-note"`）与语速行（`key: "prosody"`）**本来就是两个独立的 `div`**，结构上天生两行，怎么调 `flex-wrap` 都不会变成一行。修法：①两行合并成单个 `key: "voice-settings"` 的 nowrap 行，四个控件同 div；②「音色备注」缩成「备注」（完整说法挂 `title`），新增 `fieldLabelTight`（`min-width` 2.6em → 1.8em）；③`numberInputStyle()` 再收窄 72→64px、下限 48→40px；④行内 gap 8→5px；⑤静音红字 `#dva-mute-note` 拆到独立 `key: "mute-note-row"`（默认空、高度 0，避免出现时把 nowrap 行撑溢出） | `lib/client.js` |
| 修复 | **「播报开关」卡顶栏与提醒方式也合成一行**（用户第六轮反馈，带截图三支红箭头 + 原话：「同理这个也弄成一行」）—— 这张卡原先标题行 / 「▶ 试听 + 音色」行 / 「🎚 怎么提醒你 + 提醒方式三按钮」行是三个独立块，天生三行。修法：①`cardHead`（标题行）由 `flexWrap:"wrap"` 改 `nowrap`；②三段合并成单个 `key: "main-top"` 容器（试听按钮 + 音色信息 + 🔈悬浮气泡 + 提醒方式标签 + ⓘ + 三个模式按钮同住一个 `div`），删除 `key: "top-row"` / `divider-mode` / `mode-title` / `key: "alert-mode"` 四个独立块；③音色信息 `span` 仍是这行的缓冲垫（`flex:1 1 auto` + `min-width:0`，窄面板先收缩出省略号），保证三个模式按钮永远完整可点；④整行兜底 `flexWrap:"wrap"`：只有面板窄到约 560px 以下才会折行 —— 三按钮自身宽约 184px，极端窄时宁可折行也不能把「关闭」截到卡片外 | `lib/client.js` |
| 修复 | **切换音效时没有「已切换」提示**（用户第七轮反馈：「你这个切换音效得时候没有切换语音一样的提醒，我需要统一有这个类似得提醒」）—— 换音效本来就「点完即存」并写状态栏，但句式与切换提醒方式不一致（`成功时的提醒音已改为「木鱼」（立即生效）` vs `已切换为「音效」（立即生效）`），用户感知不到。已统一为 `已切换为「木鱼」的提醒音（立即生效）` | `lib/client.js` `setSfxFor()` |
| 新增 | **音效文件统一导出/导入**（用户第七轮反馈：「这个提示音也要增加上传和下载得按钮。为避免太乱先在列表中勾选，由统一得下载按钮，不至于每一个都有下载」）—— 面板顶部新增一行：下拉选提示音 + 「⬇ 导出」+ 「⬆ 导入」；列表每行保持「勾选 + 试听」，不逐个加下载。宿主新增 `GET /sfx/download?name=<key>`（白名单校验，导出该 mp3）与 `POST /sfx/import?name=<key>`（10 MB 上限、mp3 校验、覆盖前把原文件备份到 `sfx-backups/import-<时间>-<key>/`、清掉对应 WAV 缓存） | `lib/index.js`、`lib/client.js` |
| 变更 | **音效导出/导入改为按「完成 / 报错 / 审批」三个分类各一组 + 切换提示显示在音效面板内**（用户第八轮反馈，带截图：①「你这个提醒应该显示在上方在这个第二个图得上访显示比较合适」—— 操作发生在音效面板，反馈就该贴着它出现，不该滚去卡片顶部的状态栏；②「我说得导出不一定是一个同类得导出可能是这个是成功,哪个报错,哪个失败属于三个分类都有可能,但是导入肯定是新增得」）—— 删掉原来的「单一下拉选音效库条目 + 一对按钮」，改成三行：每行 = 分类名 + 「⬇ 导出」+ 「⬆ 导入」。导出 = 下载该事件**当前正在用**的那条提示音（`cache.sfxByKind[kind]`，随勾选实时变化）；导入 = 用本地 mp3 换掉该事件当前用的这条（宿主照旧先备份）。切换提示写入面板内的 `#dva-sfx-note`，`persistPatch` 加了第 4 参 `onOk` 成功回调 | `lib/client.js` |
| 修复 | **「导入失败：」后面空白，用户不知道下一步该干什么**（用户第九轮反馈，带截图）—— 根因：宿主还是旧进程，`/sfx/import` 这条新路由根本不存在，返回 404；前端 `res.json()` 解析空响应体得到 `{}`，`reason` 为 `undefined`，`humanReason(undefined)` 返回空串。修法：①错误文案**绝不允许为空** —— `reason` 缺失时按 HTTP 状态给明确说法；②404 / 405 / 403 HTML（DSH 浏览器栅栏）统一指向「**完全重启 DSH**」；③成功与失败的提示都写在**音效面板内**（`#dva-sfx-note`），不再滚去顶部状态栏；④`downloadSfx` 的失败分支同样接入这套文案（不再吞 JSON 解析失败） | `lib/client.js` `importSfx()` / `downloadSfx()` / 新增 `sfxIoFailReason()` |
| 回退 | **删掉音效面板的「导出/导入」入口**（用户第十轮反馈：「清楚音效得导入和导出功能」+「这个音效导入和语音导入重复了，语音导入也可以导入这些音效。因此没必要重复了」）—— 「✍️ 播报内容」里三条播报各自已带「⬇ 下载 / ⬆ 导入」，语音导入本来就能导入任意 mp3（含音效），音效面板再放一套属重复入口。已整体移除：客户端 downloadSfx() / importSfx() / sfxIoFailReason() 三个函数、面板里三组 #dva-sfx-export-* / #dva-sfx-import-* / #dva-sfx-file-pick-* 按钮，以及宿主 lib/index.js 的 /sfx/download、/sfx/import 两条路由（不留半成品）。**保留**切换音效的面板内提示 #dva-sfx-note | lib/client.js、lib/index.js、	est/self-check.mjs |
| 变更 | **音效选择从「20 行 × 3 勾选框」改成三个下拉**（用户第十一轮反馈：「这个音效最好弄成下来选项，三个下拉选项可以试听」）—— 旧版是 20 条音效 × 3 个事件 = 60 个单选框铺满整屏，既占地方又容易点错。现在每个事件一行：标签 + 下拉（optgroup 按「提醒 / 大自然」分组，列全部 20 条）+ ▶ 试听。下拉里选中即生效（点完即存，与总开关/提醒方式同口径），试听按钮试的是该行**当前选中**的那条。setSfxFor / pplySfxSelection 从「刷 20 个单选框」改成「对齐 select 的 value」 | lib/client.js、	est/self-check.mjs |
| 修复 | **「当前音色」把顶栏撑到拐行**（用户第十二轮反馈，带截图红圈 + 箭头：「因为显示当前音色导致拐行了，这不好看。当前音色放在我第二章画箭头得位置比较合适」）—— 音色文字（如「台湾·晓陈（甜美女声）（免费音色）」）原先紧跟在「▶ 试听」后面，长音色名把 main-top 行撑宽，把「提醒方式 + 三按钮」挤到第二行。现在按箭头所指把它移到 **「提醒方式 ⓘ」之后、三个模式按钮之前**，作为整行的**弹性缓冲垫**：宽面板下吃掉剩余宽度让三按钮贴右；窄面板下它先收缩出省略号，三按钮永远完整可点 | lib/client.js |
| 变更 | **「播报内容」卡变成一张卡、两种形态：语音模式 = 输入框，音效模式 = 下拉**（用户第十三轮反馈，带截图圈了两个区域：「我发现用红线圈主得两个区域是一个意思…能不能切换到音效之后，输入框变成下拉框…然后直接在相同的位置可以导入音效，也可以加上导出音效也行就是界面要一致」）—— 独立的音效面板整块删除，三条行按当前提醒方式二态渲染：①**语音模式**：事件名 + 文案输入框 + 试听/下载/导入（现状不变）；②**音效模式**：事件名 + 提示音下拉（optgroup 按「提醒/大自然」分组，选中即生效）+ 试听/**导出**/**导入**。动作组同一位置、同一组按钮：音效模式下「⬇ 下载」变「⬇ 导出」（导出该分类当前选中的提示音 mp3）、「⬆ 导入」换成换提示音。切换音效的反馈行 #dva-sfx-note 跟到这张卡的三条行下方。宿主恢复 /sfx/download 与 /sfx/import 两条路由（导出/导入按分类走，覆盖前自动备份到 sfx-backups/ 并清对应 WAV 缓存）。setSfxFor / pplySfxSelection 改为对齐 select 的 value；恢复 downloadSfx / importSfx / sfxIoFailReason / 新增 sfxNote。uildActionGroup 的下载/导入按钮按模式分流。**页面少一个卡片区，一页能显示完** | lib/client.js、lib/index.js、	est/self-check.mjs |
| 变更 | **切模式零重渲染 + 「当前音色」移到状态区**（用户第十四轮反馈，带截图：①「现在从语音播报和音效来回切换，界面不能即使得切换过来，得关闭界面重新打开或者多等一会才会缓过来，那你干脆本来就是两个界面只不过是长得像呢」②「音色读取中每次都比较慢很卡，如果说读取到了又导致按键拐行，不如把这个读取音色，音色显示状态这个放到，正在读取设置得旁边，弄成两个区域也就是箭头指向区域」）—— ①三条行**预渲染两套**（语音套 dva-row-voice-<kind> / 音效套 dva-row-sfx-<kind>），pplyAlertMode 切模式时用**纯 DOM display 翻转**（含 #dva-sfx-note 反馈行），零 React 重渲染，即时切换；②「当前音色」span 从顶栏 main-top 移到状态区（新增 oice-status-row 一行：左「音色：…」/ 右下状态条 dva-status），读取慢时不再占顶栏、也不会把行撑宽 | lib/client.js、	est/self-check.mjs |
| 修复 | **点「设为当前」后生成仍用旧音色**（用户第十五轮反馈：「我原来得 api 得火山音色改成设为当前，再重新生成，还是原来得音色不是火山设置得音色，又 bug」）—— 根因：音色库（克隆/预设）的「设为当前」只改 cache.selectedVoiceId + oicesDirty=true，**从不落盘**；而 generateAll() 里的 saveSettings() 也不提交 selectedVoiceId，于是生成时宿主读到的仍是旧的 selectedVoiceId。修法：点「设为当前」**立即 POST /voices/save**（只提交 selectedVoiceId，voices 原样不动），与免费音色的 reePick() 完全同口径，并回写 list/statuses + 刷生成按钮 + 写状态提示 | lib/client.js |
| 修复 | **状态区两栏这次真落盘 + 音色库行与免费行同构**（用户第十六轮反馈：「第一预设得key和不需要key得形式长得不一样，形式要统一以上面得为准，好看规范一些」「我的音色和语音合成状态这个显示选项现在是上下关系，我需要让他们是左右关系，整行不拐行。一行分两栏」）—— ①上一轮的两栏补丁实际没写进文件（补丁块匹配的文本与文件不一致，工具却报了 ok —— 已排查），这次直接改：oice-status-row 左栏 dva-voice（flex 1 1 50%）+ 右栏 dva-sfx-note（flex 1 1 50%，textAlign right），「共 20 个内置音效」从三条行下方的独立行删除（那才是「上下关系」的元凶）；②音色库行（克隆/预设）改成与免费行**同构两栏**：libLeft（flex 0 0 auto：徽标 + 音色 ID + 可用状态）+ libRight（flex 1 1 auto：备注框 + 设为当前 + 删除），行本体仍 nowrap + min-width 0 | lib/client.js、	est/self-check.mjs |
| 变更 | **状态区一行两栏 + 删掉音色库「试合」按钮**（用户第十五轮截图：「这个在一行分左右两栏」「第二张得内容挪到第三张得箭头位置比较合适或者弄到感叹号里」「不要再音色库中加入按钮再合…我直接在固定得那个统一得按钮合成就行了」）—— ①状态区一行两栏：左「音色：…」/ 右「共 20 个内置音效」，各占 50%、各自可省略，互不挤压；②「共 20 个内置音效」从三条行下方的独立行并入状态区右栏（箭头位置），pplyAlertMode 里不再显隐它；③音色库每行的「试合」按钮删除，统一走底部「🎙 生成语音」 | lib/client.js |
| 修复 | **20 个提示音响度参差 30 dB**（用户第七轮反馈：「检查下各提醒音得分贝，别太低，音量大小要统一」，并明确「拉齐指的是分贝按照最高得调」）—— 实测最响 `remind-alarm` 平均 −14.6 dB、最轻 `remind-dingdong` −44.6 dB，相差 30 dB（听感约 10 倍音量）。按用户要求**以最响那条为基准**统一：`acompressor`(4:1) 压峰均比 → `volume` 增益 → `alimiter`(−2 dBFS) 兜底 → 48 kHz。19 条抬到 −14.0～−14.9 dB；3 条噪声类（蟋蟀/雨/溪流，峰均比 14～19 dB）在「峰值不削波」约束下物理上到不了 −14.9，用 20:1 硬压缩收到 −15.1 / −15.8 / −16.3 dB。**最终极差 2.3 dB（原 30 dB），峰值全部 ≤ −1.4 dBFS**。原文件备份在 `<data>\sfx-backups\pre-loudnorm-*` | `sfx/*.mp3` |
| 删除 | **删掉「✍️ 三条播报文案」小标题与「改完文案点「🎙 生成语音」即可一键更新（自动保存并合成）」那句常驻说明**（用户第七轮反馈，带截图原话：「这一句话多余了」+「删掉包括这个三条播报文案」）—— 卡片标题已是「✍️ 播报内容」，小标题属同一件事说第二遍；那句用法说明与「🎙 生成语音（一键更新）」按钮文案完全重复。两行全删，三条文案直接跟在卡片标题下，卡片矮了两行 | `lib/client.js` |
| 变更 | **「失败」改叫「报错」**（用户第七轮反馈，带截图原话：「这个失败改一下字眼叫报错」）—— `LABELS` 里 `fail` 的显示文案改「报错」，影响所有出现这个事件名的地方：三条文案输入框左侧的事件名、音效面板的列头、状态提示。语义不变（宿主配置键仍是 `fail`，只有显示字眼变了） | `lib/client.js` |
| 修复 | **`--no-sound` 其实会真出声**（独立复核实测发现）：自检里那条「音量正常时蜂鸣降级照旧可用」是**顶层块**，6 处 `skipSound` 守卫都够不到它，跑一次 `--no-sound` 会真的拉起隐藏 powershell 播 `[console]::beep(880,180)`；已把它收进守卫，跳过数 7 → 8。顺带把「不可收缩单元格 ≤ 70px」写成 §20l2（光查字面量测不到复发） | `test/self-check.mjs` |

### B. 新增：内嵌免费音色（零 Key 的字生语音）

> 用户需求（2026-10-24）：**「内嵌有没有免费得不需要 api 得字生语音，安装上直接体验语音提醒」**，偏好「甜美的女生声音台湾腔」，并要求「不影响用户自己 key 音色切换」。

| 类别 | 内容 |
|---|---|
| 新增 | **第三条音色路线 `free`** = 微软 **edge-tts**（pip 上的 MIT 开源包，调 Edge「大声朗读」公开端点）：**不要任何 API Key**；产物 mp3 落 `~\.dsh\data\dsh-voice-alert\edge-cache`，首次合成需联网、之后可离线重放 |
| 新增 | `lib/edgevoice.js`：`edgeArgsFor` / `synthesizeEdge` / `edgeRuntimeStatus` / `edgeRuntimeStatusAsync` / `edgeRateFor`。返回契约与 `lib/tts.js` 的 `synthesize` 同形且**永不抛异常**（失败一律变返回值）；文本走 argv 不走 shell；临时产物在 `edge-tmp`，任何退出路径都清理 |
| 新增 | `lib/config.js` 的 `FREE_VOICES` 服务端虚拟目录，7 个试听音色（pitch/rate 为实测调校值，不可改写、不可互换）：`free:tw-chen` 台湾·晓陈（甜美女声，排第一）、`free:tw-chen-cute` 台湾·晓陈·嗲（+25Hz/+8%）、`free:tw-yu` 台湾·晓宇（柔和女声）、`free:tw-yu-cute` 台湾·晓宇·嗲（+25Hz/+8%）、`free:cn-xiaoyi` 大陆·晓伊（活泼女声）、`free:cn-xiaoxiao` 大陆·晓晓（温暖女声）、`free:hk-hiumaan` 粤语·晓曼（甜靓女声） |
| 新增 | HTTP 路由（前缀 `/dsh-voice-alert`，仅回环）：`GET /free/runtime`（检测本机 python + edge_tts 是否就绪；**只 GET**，TTL **正负分档** —— 通过缓 30 s、失败只缓 5 s；**不测网络**）、`POST /free/audition`（试听某个免费音色，带缓存复用，与音效/语音试听同一套静音与总开关闸门） |
| 新增 | `/voices/probe`、`/generate` 对 `free:` 音色自动分流到 edge 合成；「语速」滑块经 `edgeRateFor()` 折算进 edge 的 `--rate`（钳位 `[-90%, +200%]`，pitch 不动） |
| 新增 | UI：音色库分两组渲染 —— **「🆓 免费内置音色 · 无需 Key（点「设为当前」立即生效）」** 与 **「🔑 我的音色库 · 需要 Key」**（后者同时容纳克隆与预设两类）。每条可单选「设为当前」+ 一键「▶ 试听」，行内显示 `✓可用` / `缺edge-tts` |
| 修复 | 选了免费音色后「🎙 生成语音」按钮立刻可用（`currentVoiceReady()` 对 `free:` 直接返回 true）—— 旧版只认火山 Key，选了免费音色按钮永远灰、还误显示「未配置 TTS API Key」 |

**关键设计：不影响用户自己的 Key 音色。** 免费音色是服务端虚拟目录，三条硬约束：①**不写进** `config.json` 的 `voices`（唯一闸门 `isVoicesLibraryId()`，见下方评审修复 P1）；②**不并入** `/voices` 的 `list`（走独立字段 `freeVoices`）；③**不进** `DEFAULT_VOICES` —— 开源版「不内置任何音色」的决定保持不动。唯一持久化的是 `selectedVoiceId`，`resolveConfig()` 为此专门特判（否则每次解析都会被顶回第一个 key 音色）。

**依赖前提（实话写明）**：需要本机有 Python 且装过 `edge-tts`（`pip install edge-tts`，国内建议 `-i https://mirrors.aliyun.com/pypi/simple/`），且首次合成要联网。二者缺一，界面明确显示原因而不是崩：`edge-python-missing` / `edge-tts-not-installed`（附「装一下：pip install edge-tts」）/ `edge-offline` / `edge-timeout`。

### B 的评审修复（free-review 报回 1×P1 + 4×P2，均已落盘）

| 严重度 | 问题 | 根因 | 修法 |
|---|---|---|---|
| P1 | **免费音色会不会落盘，三处各写一套判据、互相打架** | 宿主 `/voices/save` 只比对 7 条目录 id → 手写的 `free:zh-CN-XiaoxiaoNeural` 能进 `config.json`；客户端保存时又按 `free:` 前缀过滤 → 下一轮保存把它删掉。导入面板是第三套判据，导入一行 free 会被降级成 `preset`、界面冒出一个红色「缺 ark-key」 | `config.js` 新增**唯一闸门** `isVoicesLibraryId(id)`（= `!isFreeVoiceId(id)`）；`normalizeVoices` 与 `mergeVoiceImport` 都改成问它，`/voices/save` 删掉本地那套「只比 7 条目录」的过滤，客户端前缀过滤降级为「顺手省字节」并注明权威在宿主。目录 id 与手写形式从此一律进不了库，规则只有一条不可能再自相矛盾；被挡在库外的 free id 仍然能正常合成（走 `selectedVoiceId`） |
| P2 | **`/voices/save` 无条件写入 `selectedVoiceId`** | 该字段是自由文本，粘一个乱串进去就会持久化，之后每次合成都报一个用户看不懂的 Key 错误，刷新还在 | 只接受三种值：库里存在的 id / 合法 `free:` id / 空串。其余记日志 `voices/save: ignored unknown selectedVoiceId …` 并**保留原选择**（注：这一版拒绝分支后来又顺手加了「归位到库里第一个音色」，与「保留原选择」自相矛盾，已由下方 C 的 **D1** 去掉 —— 现在拒绝就是什么都不动） |
| P2 | **`/free/runtime` 不校验方法 + 负缓存顶着 30 s** | 任何方法都当 GET 处理；更麻烦的是 TTL 一刀切 30 s —— 用户照提示 `pip install edge-tts` 装完，徽标仍显示「缺 edge-tts」，看着像没装上，实际上会白折腾一轮重装 | 补 GET 方法校验（非 GET → 405 `reason:"use GET"`）；TTL **正负分档**：通过结果缓 30 s（免得每次开面板拉一个 python 子进程），失败结果只缓 5 s |
| P2 | **`edge-tmp` 里每次合成漏一个 0 字节文件** | `voice.id` 形如 `free:tw-chen`，**冒号在 NTFS 上是交替数据流（ADS）分隔符**：`rmSync` 删掉的是那条数据流，宿主文件留在原地 | 文件名里的非法字符（含冒号）统一替换成 `_`（合成临时名再截断到 60 字符），`/free/audition` 的缓存文件名同样处理 |
| P2 | **试听成功后徽标仍显示「缺 edge-tts」** | 前端 `freeRuntime` 缓存没有被更新，还要等一次 `/free/runtime` | 试听成功就地把自己的检测结果改写成 `{python:true, edgeTts:true}` 并重渲染徽标，不用刷新 |

### C 的端到端复核修复（实测报告报回 6 个缺陷 D1~D6，均已落盘）

> 来源：把 v0.4.17 从头到尾实测复核一遍（不只是单测）报回来的 6 个缺陷。每一条都在 `test/self-check.mjs` 的**新章节 §18** 里锁了断言（共 21 条）。

| 严重度 | 问题 | 根因 | 修法 |
|---|---|---|---|
| P2 | **D1 粘进一串非法 `selectedVoiceId`，音色被悄悄换掉**（`lib/index.js` `/voices/save`） | 拒绝分支除了记日志还会把选择顶回库里第一个音色 —— 用户当前明明选着有效的免费音色或第二个音色，粘贴一个垃圾 id 点保存就换了音色，与本功能「完全不碰你的选择」的承诺自相矛盾，也和自己刚打的 `ignored` 日志矛盾（都说了不采纳，却又改了状态） | 拒绝时**只记一条 `voices/save: ignored unknown selectedVoiceId …` 日志，当前选择保持不动**（`lib/index.js:1114-1120`）；接受条件不变：库里存在的 id / 合法 `free:` id / 空串 |
| P2 | **D2 只保存音色库、把当前选中的那行删掉 → 选择悬空** | 归位检查过去挂在「被拒绝」那条分支上，没发 `selectedVoiceId` 时根本不判。悬空的下一次合成按 inline 规则把不存在的 id 猜成 clone/preset，配上 Key 就真的去合成一个不存在的音色（实测 `POST /generate` 返回 202、无任何报错） | 新增**独立的有效性检查**（`lib/index.js:1122-1136`）：空串 / 合法 free id / 仍在库里 视为有效；只有确实失效才归位到 `voices[0].id`（库空则 `""`），并记 `voices/save: selection fell back to …` 日志 |
| P2 | **D3 `/generate` 带 `speakerId` 覆盖时，去重指纹记错了音色**（`lib/generate.js`） | `fingerprintFor()` 只记 `config.selectedVoiceId`，而 `/generate` 可以带 `speakerId` 覆盖 —— 于是「覆盖成 A 合成、指纹记的却是 B」。之后换一个覆盖音色会被判 `nothing-changed`，把旧音频留在原地不动 | `fingerprintFor(kind, config, speakerId)` 第三参记录**真正拿去合成的那个音色**（`lib/generate.js:341`），`planChanges`（:397-408）、快照写入（:762）、`start`（:797-810）全部把 `runSpeaker` 传下去。面板从不发 `speakerId`（`lib/client.js` 只在 `/free/audition` 与 `/voices/probe` 发），所以只影响直接调 API 的使用方 |
| P2 | **D4 畸形 `free:…` id 打 `/voices/probe` 不 400，反而发给厂商** | 该 id 过不了 `resolveVoice` 的 free 分支、又因为不以 `S_` 开头被当成 inline preset，于是把用户粘进来的字符串原样塞进火山 `req_params.speaker` 发出去 —— 白烧一次厂商调用，返回的状态码形状也是 502 而不是 400 | 进 `resolveVoice` **之前**先拦（`lib/index.js:1205-1207`）：以 `free:` 开头但不是合法 free id 的，直接 400 `reason:"unknown-free-voice"` 并记 refusal 日志，一次上游调用都不发出 |
| P3 | **D5 试听缓存与合成临时目录写死在 `DATA_DIR`** | `edge-cache` / `edge-tmp` 是硬编码字面量：①换不了盘（试听缓存只能落在系统盘）；②同机第二个实例共用同一份缓存，第二个 mount 一点试听就是 `reused:true`，复用的是别人的 mp3 | 跟 `wavCacheDir` 一样做成配置键 `edgeCacheDir` / `edgeTmpDir`（默认值 `join(DATA_DIR,"edge-cache")` / `join(DATA_DIR,"edge-tmp")` 不变，见 `lib/config.js:443-449` 与解析 `:747-748`），消费端改读配置键并各自留默认兜底：`lib/edgevoice.js:81`（合成临时目录）、`lib/index.js:1018`（试听缓存目录）。**不配也不坏** |
| P3 | **D6 每次开面板都阻塞探测 ffmpeg**（`lib/generate.js` `resolveFfmpeg`） | `GET /settings` 每次都要读 `gain.ffmpeg`，而它每次都 `spawnSync("ffmpeg","-version")` —— 没装 ffmpeg 的机器每次打开设置页都要阻塞等一个子进程失败 | 加探测缓存（`lib/generate.js:62-88`）：**正结果永久缓存、负结果 60 s TTL**（`NEGATIVE_FFMPEG_TTL_MS`），所以中途装上 ffmpeg 能自愈、不用重启；保留 `noCache` 逃生口给强制重探的调用（自检走它）。顺带满足「省内存 / 减少打开客户端设置页的加载时间」的诉求 |

### D 的第三轮复核修复（实测报告报回 2 个缺陷 D7~D8，均已落盘）

> 来源：把 D1~D6 修完之后再跑一轮端到端复核（8 条判据全 PASS）时新报回的两条。断言锁在 `test/self-check.mjs` 的**新章节 §19**（共 8 条）。

| 严重度 | 问题 | 根因 | 修法 |
|---|---|---|---|
| P2 | **D7 畸形 `free:…` id 打 `/generate` 不 400，反而发给厂商**（`lib/index.js`） | D4 那道闸只加在 `/voices/probe` 一个路由上，`/generate` 没拦 —— 同一串 `free:../../etc/passwd` 照样进 `generator.start()`，`resolveVoice` 过不了 free 分支、又因不以 `S_` 开头被当成 inline preset，**已经配了 Agent Plan Key 的机器真把这串恶意文本当 `req_params.speaker` 打给火山**（实测 1 次真上游 POST）、白烧额度，用户拿到的是一个半个失败的 202 而不是 400 | 判定收口成 `config.js` 的一个共用函数 `isMalformedFreeVoiceId()`（`free:` 开头但不是合法 free id），三个消费方问同一个谓词：`/generate`（`lib/index.js:938-941`，**在 `generator.start()` 之前**，400 `unknown-free-voice` + refusal 日志）、`/voices/probe`（同函数，替换原来那段内联判定）、`/free/audition`（非合法 free id 本来就 400）。断言同时覆盖「合法 free id 不被这道闸误伤」 |
| P3 | **D8 自定义 free 名没有长度上限 → 试听缓存永远写不进盘、每次试听都重新联网合成**（`lib/config.js` / `lib/index.js`） | `isFreeVoiceId` 的名字正则没有长度限制，300 字符的 `free:zh-CN-aaaa…` 也算合法；`/free/audition` 的 `safeKey` 同样不截断，拼出的文件名超过 MAX_PATH，写缓存 `ENOENT` 只记一条日志 → 接口仍返回 `200 ok:true`，用户完全看不出异常，**每次试听都重新合成一遍** | 长度上限放进 `isFreeVoiceId` 本身（`FREE_VOICE_NAME_MAX = 60`，空名或超长直接不算 free id → 各路由按畸形 id 400），`/free/audition` 的 `safeKey` 再兜一层 `.slice(0, 80)`（注释写明别把长度校验收窄成调用点的事）。断言覆盖恰好 60 合法 / 61 拒、超长名被认成畸形、`/free/audition` 直接 400 |

### 文档与自检

| 项目 | 说明 |
|---|---|
| 自检 | `--no-sound` 实测 **472 过 / 0 失败 / 6 跳过**（跳过 = 6 条都会真出声的用例，`--no-sound` 下直接不执行，不计入通过/失败）。构成：§1–§16（0.4.16 及更早）共 **360 条** + §17 **41 条** + §18 **21 条** + §19 **8 条** + §20 **42 条** = **472**（0.4.18 收尾复测值；本节写作时 §20 为 33 条，0.4.18 新增 20x 系列 9 条后升到 42）。README 各处旧的计数（368、449、456）已全部改为实测值；本文件 0.4.16 段落里的 368 与「43 条回归断言（§16a–16f）」属该版本的历史事实，保留不动。<br>**为什么 §1–§16 从 366 掉到 360、§20 从 20 掉到 10（后又随本轮修复增到 33）**：第十三轮「音效面板整块删除」时，断言旧结构的用例（`sfx panel rendered`、20g/20h/20i/20j/20k/20l2/20m/20n/20o 等）随功能一并删除——它们锁的是已不存在的 UI，留着只会永远失败，故属**有意删除**而非回归；§19 曾在同一轮被误删（修复代码还在、断言没了，属「修了但没锁」），已于 2026-10-26 从 `_backup\\20261025-103419-before-ui-compact` 整节恢复，现 8 条全绿 |
| 新增断言 | 四节共 **112 条**（472 − §1–§16 的 360 = 112）：<br>**§17「免费内置音色：目录 / 判定放行 / 命令行拼装 / 失败分类」共 41 条**：edge 命令行形状（`-m edge_tts --no-progress --voice … --rate … --pitch … --text … --write-media …`，非法 rate/pitch 不传）、7 个目录 id/标签/pitch/rate 逐条锁定、**唯一闸门 `isVoicesLibraryId()`（目录 id 与手写 `free:xxx` 都被 `normalizeVoices` / `mergeVoiceImport` 挡住，不再两套判据打架）**、被挡在库外的 free id 仍然能合成、`edgeRateFor` 折算与钳位、edge 失败原因分类（各归各的 reason，绝不谎报）、`/free/runtime` 与 `/free/audition` 路由语义（回环 + GET/POST 方法校验 + 静音与 `alertMode=off` 闸门 + 缓存戳记复用条件）、**voice id 落盘前洗掉非法字符（含冒号，NTFS ADS 泄漏）**。合成用例用注入的假 spawner，**自检不出声、不联网、不真起 python**<br>**§18「端到端复核发现的缺陷已修（当前选择/悬空归位/伪造 free id/指纹音色/探测缓存）」共 21 条**，按缺陷分布：D1 乱串被拒且不动当前选择 + 必须留日志（2）、免费音色可设为当前且不落盘（2）、D2 悬空归位 + 留日志 + 反向绝不顶走免费音色（4）、D4 畸形 free id → 400 且一次上游调用都不发（2）、D3 指纹默认取 `selectedVoiceId` / 带覆盖时跟着变 / 录的是覆盖音色则换覆盖必须判脏 / 用回当初那个才允许复用 / 不带覆盖与「录的是覆盖音色」状态互不干扰（5）、D6 第二次探测命中缓存 + `noCache` 仍可强制重探（2）、D5 `edgeCacheDir` / `edgeTmpDir` 走配置键 + 临时文件确实落在指定目录 + 默认值仍在插件数据目录内（4）<br>**§19「第三轮复核发现的缺陷已修」共 8 条**：D7 `/generate` 对畸形 free id 直接 400 + 一次上游调用都不发出 + 留 refusal 日志 + 合法 free id 不被误伤（4）、D8 超长名不算合法 free id + 被认成畸形 + 恰好 60 合法/61 拒的边界 + `/free/audition` 直接 400（4） |<br>**§20「客户端界面静态一致性」共 33 条**（当前实存，与自检实测对齐）：`hidden carriers still rendered`（三个隐藏 carrier 节点仍在）、**20a/20b** 启用状态徽标 `applyEnabledBadge()` 存在且被引用 ≥ 4 处、**20c** 所有 `setDisabled("dva-generate"` 都必须带 `currentVoiceReady()` / `!ready` / `, true)` 之一（防止绕过门禁）、**20d** 全文件不许再出现 `fontSize: "15px"…"29px"` 一类越档字号、**20e** 旧的 `dva-big-download` / `dva-big-import` / `mp3-tip` 已彻底消失、**20f** `refreshGenerateGate(` 引用 ≥ 8 处、**20l3** 音效行「一行放下」不变量（容器 `nowrap` + 曲名可收缩 + 按钮不缩不折）、**20p** 顶栏合并为单块 `key: "main-top"`（含 `dva-big-preview` / `dva-audio-tip` / `persistPatch(` / `flexWrap: "wrap", minWidth: "0"`），且旧的 `top-row` / `mode-title` / `alert-mode` / `divider-mode` 四个 key 已全部消失、**20q** 音效「统一导出/导入」两条宿主路由（`/sfx/download`、`/sfx/import`）+ 客户端 `downloadSfx(` / `importSfx(key, kind)` / `sfxIoFailReason(` / `sfxNote(` / `persistPatch(patch, okMessage, before, onOk)` 存在 + 切换音效提示与切换提醒方式同款句式（`已切换为「…」的提醒音（立即生效）`），且旧的面板级 `key: "sfx-panel"` / `id: "dva-sfx-io-pick"` / `id: "dva-sfx-note"` 已不存在、**20s/20s2/20s3** 音色库行 `libRight`/`libLeft` 必须挂回 `row`（原先 `libRight` 从未 append，删除按钮、备注框、probe 输出全都渲染在游离节点上 → 用户「没有删除按钮」的真因）、**20t** 删除按钮点完即存（POST `/voices/save`，不是只改 cache 等下次保存）、**20u/20u2** 重挂载自愈只在真被抹掉时触发且延后一帧判定、**20v/20v2/20v3/20v4/20v5** 音色库容器挂 `MutationObserver`（React 清空时同一轮同步重画，不留空帧；`rowsRendering` 闸门防递归；cache 有数据直接重画不发网络请求；空 cache 保留「读取中…」）、**20w/20w2/20w3** 删除按钮恒可用（不再因「正在使用」被禁用或写「不可删除」文案，删当前音色时提示会归位到第一个）、**20w4/20w5** 宿主 `/voices/save` 在选中项悬空时归位 + 客户端回填 `selectedVoiceId` 用 `!== undefined` 判（删空时空串是合法值）、**20x/20x2/20x3/20x4/20x5** 悬浮气泡定位器三件套（`placeTip` / `tipClipRect` / `ensureTipPlacement`）齐备且委托监听只挂一次、浮出时宽度与水平位置真被夹紧、滚动/缩放会按新位置重算、面板入口武装 + 测试面导出、**20x6/20x7/20x8/20x9** 桩几何功能测试（窄面板 300→184 夹到可见区、贴右边缘整体左移、下方不够翻到上方、无裁剪祖先退化为视口不抛错）。<br>（20g/20h/20i/20j/20k/20l2/20m/20n/20o 九条随第十三轮「音效面板整块删除 / 说明改悬浮」的结构改动一并移除，锁的是已不存在的 UI，属有意删除。）
| 文档 | README.md 新增 §4.3「免费内置音色」整节 + §9.1 两条新路由 + §5 配置表同步（`alertMode` / `prosody.speed_ratio` / `pythonPath` / `voices` / `selectedVoiceId`），并按 C 的复核补上 **`edgeCacheDir` / `edgeTmpDir` 两行**（默认 `<data>\edge-cache` / `<data>\edge-tmp`，可改盘）、§9.1 里 `/voices/save`（D1/D2）、`/voices/probe`（D4）、`/generate`（D3 + D7）、`/free/audition`（每音色各自一份 `audition-<safeKey>.mp3` + 同名 `.stamp.json`，`safeKey` 截断 80 字符）四行口径与实现对齐、§4.3 补自定义 free 名 60 字符上限（D8）、§2 增益节补 D6 的探测缓存说明；README-es / -hi / -pt / -zh 各新增「v0.4.17 新特性」速览段与 §4.3 条目，口径与英文版对齐 |
| 版本 | `package.json` → `0.4.17`。宿主 `status.json` 的 `version` 字段读自 package.json（无硬编码），GitHub Release workflow 的 tag 同样取 `node -p require('./package.json').version`，均自动跟随；`files` 白名单已含 `lib/**/*.js`，新模块 `lib/edgevoice.js` 自动纳入打包，无需新增条目 |
| 需要 | 需重启 DSH 使宿主侧（`config.js` / `index.js` / `generate.js`）与新模块生效 |

## 0.4.16 — 2026-10-24

### 缺陷修复（用户 2026-10-24 反馈三连）

| 严重度 | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| P0 | **总开关点不动 / 点了不生效** | 复选框是 React 受控组件（`checked` 绑 `cache.enabled`）但**没有 `onChange`** —— 用户点击后 React 立刻按旧值回写，界面表现就是「点了没反应」；即使生效也要再按一次「保存设置」 | `dva-enabled` 补 `onChange`：先改本地 `cache.enabled` 让界面即时响应，再 `persistPatch({ enabled })` **点完即存**（宿主是权威，失败时按服务端值回写） |
| P0 | **选了「音效播报」还是响人声** | 点「音效」按钮只改了本地 `cache.alertMode` + 按钮高亮，**根本没发 POST**。用户不按「保存设置」时，宿主 `config.alertMode` 仍是 `voice` → 回合结束照旧合成并播放人声。界面亮着、耳朵里还是人 | 三个提醒方式按钮（语音/音效/关闭）统一走 `persistPatch({ alertMode })`，**点完即存**；成功后按宿主返回值重画按钮与音效面板 |
| P0 | **音量设 0 设不了（0 应等于静音）** | 三处硬编码 `0.2` 下限：①`normalizeEditablePatch()` 统一 `value >= 0.2` → 用户填 0 被**静默丢弃**；②`resolveConfig()` 的 `num()` 下限同样写死 0.2 → 手写进 config.json 的 `volume_ratio: 0` 被**悄悄抬成 0.2**；③输入框 `min="0.2"` → 浏览器层面就拦住 | ①新增 `EDITABLE_PROSODY_MIN = {speed_ratio:0.2, pitch_ratio:0.2, volume_ratio:0}` + `prosodyMinFor()`，音量下限单独为 0；②新增 `mutedByVolume(config)`（`volume_ratio === 0` 严格判定，缺字段不算静音）；③输入框 `min="0"`；④`play()` 闸门在**语音与音效之前**统一判静音，试听（`/preview`、`/sfx/play`）同样静音并返回 `muted:true`；⑤界面加红字「🔕 当前音量 = 0（静音）」提示 |
| P1 | **音效选择也是「改了不落盘」（同类坑，审查发现）** | 与「选了音效还响人声」同源：音效单选（`sfxByKind`）的 `onChange` 只调 `setSfxFor`（改 cache + DOM，**不发 POST**），状态行还写着「点保存设置生效」。用户换完音效不点保存，回合结束仍是旧音效；更隐蔽的是此后任何一次 `persistPatch` 都会用服务端回包把勾选**静默退回旧值** | `setSfxFor()` 改为 `persistPatch({ sfxByKind: { [kind]: key } })` **点完即存**，与总开关 / 提醒方式统一口径 |
| P1 | **`persistPatch` 失败不回滚（界面与宿主漂移）** | 失败分支只写红字状态，既不还原 `cache` 也不重置 `box.checked`，而注释却声称「失败时会按服务端值纠正」——用户看到「已关闭」，宿主其实还在播报 | 三个调用方**在改动 cache 之前**先 `snapshotState()` 并把它传给 `persistPatch`（若在函数内取快照，拿到的已是改后值，回滚恢复的就是新值 = 等于没回滚）；失败（HTTP 非 200 或网络异常）统一 `rollback()` 并重画控件（含 `applyMuteNotice` 静音提示） |
| P2 | **蜂鸣降级不受静音闸门（隐式契约）** | `beepFallback()` 自身不判 `mutedByVolume`，静音完全依赖调用方 `play()` 的前置 `return`。当前 8 个调用点都在 `playKind`/`playSfx` 内所以没漏，但将来新增一条直接调它的路径就会在音量 0 时「叮」一声 | `beepFallback()` 开头补 `if (mutedByVolume(config)) return { ok:false, reason, beep:false, muted:true }`，双保险 |
| P2 | **手写负音量被钳成 0（= 静音）** | `num()` 会把 `volume_ratio: -1` 钳到下限 0，而 0 恰好是「静音」——多打一个负号导致整机一声不响，比「值被拒绝、沿用默认」难排查得多 | `resolveConfig()` 的 prosody 合并处对负数特判回退 `fallback`（回退各自默认值 1.05 / 1.04 / 1.0），不再钳成 0 |
| P3 | **`alertMode=off` 的试听提示被写成「失败」** | 用户自己关掉了提醒方式，点试听却显示「试听失败：HTTP 200（alertMode=off）」，看起来像故障 | 两处试听（`/preview`、`/sfx/play`）对 `alertMode=off` 单独给文案：「提醒方式当前是「关闭」，试听不会出声。要听就先把提醒方式改成「语音」或「音效」。」 |

### 说明

- **空框 ≠ 0**：清空音量输入框后保存，`numField()` 退回上次已知值（`Number("") === 0` 的老坑），空框是「不改」而不是「变静音」。
- **语速/音调下限仍是 0.2**（0 对 TTS 无意义，会直接报错）。
- **回归断言自证有效**：删掉 `rollback()` 调用、或把快照挪回函数内（即本 bug 的原写法），4 条回滚断言会同时变红 —— 已用变异测试实测确认，不是「删了也照样绿」的空断言。`mock` 宿主回包也改为维护自身状态（原先对未点名字段回落常量，会把 `alertMode` 静默打回 `voice`，制造假缺陷）。
- **空值 ≠ 0（加固）**：`null` / `""` / 缺字段一律视为「没设」而不是「设成 0」。新增 `isEmptyValue()` 并在 `num()`、`mutedByVolume()`、`normalizeEditablePatch()` 三处使用 —— 否则 `Number(null) === 0` 会让手写进 `config.json` 的 `volume_ratio: null` 被读成静音，用户没设 0 却一声不响。
- **越界值不再「假装保存成功」（审查 R7）**：宿主对超范围的语速/音调/音量是静默丢弃的，旧界面无论宿主是否接受都写「已保存」。现在保存后拿 `applied.prosody` 与提交值逐项比对，不一致就在状态行点名「⚠ 未生效：音量 9（超出允许范围，已忽略）」—— 与静音 bug 同一类「界面自嗨」，一并堵掉。同时把测试 `mock` 宿主改为**走 `normalizeEditablePatch` 校验后再接受**（原先全量吞下 `sent.prosody`，等于假装越界值也生效，会掩盖此类缺陷）。
- 新增 **43 条回归断言**（§16a–16f：16a 总开关 4 / 16b 提醒方式 4 / 16c 音量 0 共 17 / 16d 宿主闸门 3 / 16e 音效不合成人声 1 / 16f 同类坑 14），覆盖「宿主真的收到了」而非仅界面样式变化 —— 界面自嗨正是这三个 bug 的共同特征。`--no-sound` 实测 **368 过 / 0 失败 / 7 跳过**（跳过的是会真出声的用例与本机未装 ffmpeg 的转换用例，属环境限制）。
- 需重启 DSH 使宿主侧（`config.js` / `index.js`）生效。

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
