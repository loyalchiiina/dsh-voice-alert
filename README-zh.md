# dsh-voice-alert

> 把任务里程碑、报错与完成情况朗读出来，人可以离开屏幕去干别的。

> 完整文档以 [English README](./README.md) 为准，本页提供中文导读与关键信息速查。

## v0.4.18 新特性速览 / What's new

* 🩹 **音色库不再重载就消失**：设置面板是 React 槽位，而音色库是命令式写 DOM，宿主重渲染会把容器重建成空 div。现加三层防抹（容器 MutationObserver + 渲染闸门 + 槽位出生看门狗），重挂载后自动补画。
* 🗑 **「我的音色库」终于看得见删除按钮**：根因是右栏 span 建好后从未 `appendChild` 到行上，按钮一直在内存里飘着。现任何一行都可删、**点完即存**（不用再点保存）；删掉正在使用的音色会自动切到库里第一个，不留悬空选择。
* 💬 **悬浮气泡永不出框**：ⓘ / 🔈 的提示气泡是 `position:absolute`，纯 CSS 既不知道祖先 `overflow` 裁剪边界也不知道自己展开多宽，图标一贴边就顶出去被裁。现浮出瞬间用 JS 实测矩形夹回可见区（含上下翻转），滚动/缩放重算。
* 🖼 **效果图更新**：两张脱敏实拍（语音模式 / 音效模式）替换旧图。

## v0.4.17 新特性速览 / What's new

* 🆓 **免费内置音色（零 Key）**：新增第三条音色路线 `free` = 微软 edge-tts 字生语音。7 个试听音色，台湾腔甜美女声打头（晓陈 / 晓陈·嗲 / 晓宇 / 晓宇·嗲 / 晓伊 / 晓晓 / 粤语晓曼）；点「设为当前」立即生效、「▶ 试听」当场合成。**前提**：本机装有 Python 且执行过 `pip install edge-tts`（国内建议加 `-i https://mirrors.aliyun.com/pypi/simple/`），首次合成需联网，产物缓存后即可离线重放。缺依赖时界面会明确说缺什么（`edge-python-missing` / `edge-tts-not-installed` / `edge-offline`），不会崩。免费音色是服务端虚拟目录：不写进 `config.json` 的 `voices`、不混进 `/voices` 列表、不进 `DEFAULT_VOICES`，唯一闸门 `isVoicesLibraryId()`（手写 `free:xxx` 同样挡）；你自己配 Key 的音色完全不受影响。（详见 [24.3](./README.md#43-免费内置音色v0417-edge-tts零-key)）
* 🔎 **界面紧凑改造**：字号与间距整体收紧一档 —— 卡片内边距 16/18 → 11/13px、外层间距 12 → 8px、卡标题 17 → 15px、正文/说明 → 11.5px、分节标题/输入框/次按钮 → 12.5px、主按钮 15 → 13px、行内动作按钮与音效行 → 11.5px；并删掉「🔔 播报开关」卡顶部多余的 ⬇下载 / ⬆导入 一排（「✍️ 播报内容」每条本来就各带一对），5 段冗长说明文案同步精简，往下一屏看全。常驻说明文字已改成悬浮提示（悬停 ⓘ / 🔈 图标查看，平时不占版面）；音色库每行改成「一行放下」（不换行 + 文本列可收缩 + 按钮不缩不折），窄面板下按钮不再被挤出卡片。
* ✅ 自测规模：**472 项断言**；`--no-sound` 实测 **472 过 / 0 失败**，另有 6 项跳过（都会真出声，`--no-sound` 下直接不执行）。构成：21–216（0.4.16 及更早）共 360 条 + 新增一节 217「免费内置音色」**41 条** + 新增一节 218「端到端复核缺陷回归」**21 条** + 新增一节 219「第三轮复核缺陷回归」**8 条** + 新增一节 220「客户端界面静态一致性」**42 条** = 472；218 锁的是第二轮实测报回的 6 个缺陷（D1~D6），219 锁的是第三轮报回的 2 个（D7 `/generate` 缺畸形 free id 闸门、D8 free 名长度无上限），均已修。

## 功能总览 · At a glance（中英对照 / Bilingual）

本节内容详见 [English README](./README.md)。

## 1. 它做什么

本节内容详见 [English README](./README.md)。

## 2. 事件依据（官方源码实证，非猜测）

本节内容详见 [English README](./README.md)。

## 3. 去重与错误优先（实现要点）

本节内容详见 [English README](./README.md)。

## 4. 响度（"声音太小"的根因与解法）

本节内容详见 [English README](./README.md)。

## 4.1 音色库（需求 A · v0.3.0）

本节内容详见 [English README](./README.md)。

## 4.2 音效提醒（需求 B · v0.3.3）

本节内容详见 [English README](./README.md)。

## 4.3 免费内置音色（v0.4.17 · edge-tts，零 Key）

本节内容详见 [English README](./README.md#43-免费内置音色v0417-edge-tts零-key)。要点：第三条音色路线 `free`，走微软 edge-tts 本地子进程（`lib/edgevoice.js`），完全不发 HTTP、不需要任何 Key；7 个音色见上；相关路由 `GET /dsh-voice-alert/free/runtime`（检测本机 python + edge_tts，缓存正负分档 —— 通过缓 30 s、失败只缓 5 s，所以 `pip install` 完刷新立刻生效；不测网）与 `POST /dsh-voice-alert/free/audition`（试听，产物缓存在 `<data>\edge-cache`，命中不重复合成）；「🎙 生成语音」`/generate`、`/voices/probe` 对 `free:` 音色自动分流到 edge 合成；「语速」滑块折算进 edge 的 `--rate`。**唯一闸门** `isVoicesLibraryId()` 在 `normalizeVoices` / `mergeVoiceImport` 两处一起挡（含手写的 `free:xxx`），所以免费音色永远进不了 `config.json` 的 `voices`，也不会被导入成红色「缺 ark-key」；`/voices/save` 的 `selectedVoiceId` 还要校验通过才写入。落盘文件名会先把音色 id 里的非法字符（**含冒号**）洗成 `_`：NTFS 上冒号是交替数据流（ADS）分隔符，不洗的话每次合成会漏一个 0 字节文件。

## 5. 配置

本节内容详见 [English README](./README.md)。

## 5.1 蓝牙耳机注意事项（实测 2026-09-16）

本节内容详见 [English README](./README.md)。

## 6. 播放链路（为什么这样启动）

本节内容详见 [English README](./README.md)。

## 7. 部署（desktop + web）

本节内容详见 [English README](./README.md)。

## 8. 自检（可独立运行，不经 DSH）

本节内容详见 [English README](./README.md)。

## 9. 诊断接口与免凭据控制通道

本节内容详见 [English README](./README.md)。

## 10. 卸载

本节内容详见 [English README](./README.md)。

## License

MIT
