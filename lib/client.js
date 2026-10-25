// dsh-voice-alert - client half (DSH settings section).
//
// Built as a browser bundle on purpose (no build step): the harness injects this
// file into the page, and the top-level __ModuleLoader__.load call is the contract
// (id must equal the package name).
//
// WHY THIS SHAPE (all four are lessons already paid for on this machine):
//   1. exports.inject must be a PLAIN ARRAY - a function form silently skips the
//      client-side service injection, and ctx.slots never appears;
//   2. ctx.slots.inject("settings.section", ...) is called DIRECTLY (no ctx.effect
//      wrapper) - wrapping it releases the registration on hot reload and the
//      section "shows up once and disappears";
//   3. the component uses NO React hooks (hooks need a very specific React
//      instance) - it reads DOM values on click and writes results straight back
//      into the DOM by id;
//   4. React comes from require("react") with a window.React fallback.
//
// The data channel is the plugin's own host routes. On DSH Desktop an ordinary
// local request is 403 "forbidden" (the shell's browser-access fence), but the
// Electron renderer carries the capability header automatically, so fetch() from
// this section passes - that is exactly why the UI lives here and not in curl.

window.__ModuleLoader__.load({
  id: "dsh-voice-alert",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var BASE = "/dsh-voice-alert";
    var KINDS = ["complete", "fail", "approval"];
    var LABELS = { complete: "完成", fail: "报错", approval: "审批" };

    /**
     * 内置音效清单（与宿主 lib/config.js 的 SFX_CATALOG 保持一致，自测会断言两者相同）。
     *
     * 为什么在客户端也存一份：列表必须在**第一帧**就画出来，否则等 /sfx/list 回来之前
     * 面板是空的；而 React 渲染后再由 DOM 追加 option 会被下次重渲染清掉（v0.3.3 的
     * "选了没反应"根因）。所以列表由 React 直接渲染，这里只是数据源。
     */
    var SFX_FALLBACK = [
      { key: "remind-dingdong", name: "叮咚", group: "提醒" },
      { key: "remind-phone", name: "电话铃", group: "提醒" },
      { key: "remind-msg", name: "消息提示", group: "提醒" },
      { key: "remind-alarm", name: "闹钟", group: "提醒" },
      { key: "remind-didi", name: "滴滴", group: "提醒" },
      { key: "remind-crisp", name: "清脆叮", group: "提醒" },
      { key: "remind-bell", name: "钟声", group: "提醒" },
      { key: "remind-tada", name: "成功号角", group: "提醒" },
      { key: "remind-happy", name: "欢快音", group: "提醒" },
      { key: "remind-muyu", name: "木鱼", group: "提醒" },
      { key: "nature-bird", name: "鸟鸣", group: "大自然" },
      { key: "nature-cricket", name: "蝉鸣", group: "大自然" },
      { key: "nature-frog", name: "蛙鸣", group: "大自然" },
      { key: "nature-rain", name: "雨声", group: "大自然" },
      { key: "nature-ocean", name: "海浪", group: "大自然" },
      { key: "nature-stream", name: "溪流", group: "大自然" },
      { key: "nature-wind", name: "风声", group: "大自然" },
      { key: "nature-fire", name: "篝火", group: "大自然" },
      { key: "nature-thunder", name: "雷鸣", group: "大自然" },
      { key: "nature-forest", name: "森林", group: "大自然" }
    ];

    var React = null;
    try {
      var reactModule = require("react");
      React = (reactModule && reactModule.default) || reactModule;
    } catch (e) {
      React = null;
    }
    if (!React) {
      try {
        React = window.React || null;
      } catch (e2) {
        React = null;
      }
    }

    // Module-level cache: survives re-renders, so the inputs always show the last
    // known server values even though the component has no state.
    var cache = {
      loaded: false,
      loading: false,
      busy: false,
      // 重挂载自愈节流戳（2026-10-26）：React 槽位重渲染会把命令式 DOM 全抹掉，
      // SettingsSection 每次渲染都要重放一次 loadSettings —— 用这个戳限速 1.5s。
      lastSelfHealAt: 0,
      // 音色库容器防抹（2026-10-26 用户：「不要出现有时候不显示的音色库内容」）：
      // React 清空 #dva-voice-rows 时用 MutationObserver 在同一帧里同步重画，
      // 不走网络、不留空档。rowsRendering 是重画期间的递归闸门。
      rowsObserver: null,
      rowsWatched: null,
      rowsRendering: false,
      // 槽位「出生」看门狗（挂在 body 上，全插件只挂一个）：React 把整个
      // #dva-voice-rows 卸掉再挂一个新的时，容器观察器无从下手，靠它兜。
      slotGuard: null,
      // 悬浮气泡「不出框」定位器（2026-10-26 用户：「试听的展开消息显示不完整出框了」）：
      // 绝对定位的气泡感知不到祖先容器的 overflow 裁剪边界，只能浮出时实测矩形再夹回来。
      // tipPlacement 保证委托监听全插件只挂一次；tipActive 记住当前浮出的那个 .dva-tip，
      // 滚动 / 窗口缩放时按新位置重算。
      tipPlacement: null,
      tipActive: null,
      enabled: true,
      texts: { complete: "", fail: "", approval: "" },
      prosody: { speed_ratio: 1.05, pitch_ratio: 1.04, volume_ratio: 1.0 },
      status: "正在读取设置…",
      results: {},
      apiKeyPresent: null,
      statusTimer: null,
      // requirement A: voice library
      voices: [],
      voicesStatuses: {},
      selectedVoiceId: "",
      presetApiKeyPresent: false,
      presetApiKeyMask: "",
      apiKeyMask: "",
      voicesDirty: false,
      // 免费内置音色（edge-tts，无 Key）：服务端目录，只读，不进 voices 数组。
      freeVoices: [],
      freeRuntime: null, // { python, edgeTts } | null = 未知
      // requirement B: alert mode + sound-effect library
      // 默认 sfx：与宿主 DEFAULT_CONFIG 一致（开源版装完即用，不需要任何 Key）。
      alertMode: "sfx",
      sfxByKind: { complete: "remind-tada", fail: "remind-muyu", approval: "remind-dingdong" },
      sfxCatalog: [],
      // 下载 / 导入 mp3：哪几条播报当前用的是「用户自己导入的 mp3」。
      // 由宿主 /settings 与 /status 的顶层 imported 字段驱动（true = 已导入）。
      imported: { complete: false, fail: false, approval: false },
      // 宿主权威判定的「音量 0 = 静音」状态，由 applyMuteNotice() 维护。
      muted: false,
    };

    function el(id) {
      try {
        return document.getElementById(id);
      } catch (e) {
        return null;
      }
    }
    function setText(id, value) {
      var node = el(id);
      if (!node) return;
      node.textContent = value;
      // 状态行是唯一会被 setStatus() 染色（红/绿）的节点；每次普通写入都复位成
      // 次要色，否则一条红色报错会一直「红」到后面每一条正常提示上。
      if (id === "dva-status") {
        try {
          node.style.color = TOKEN.textDim;
        } catch (e) {}
      }
    }
    /**
     * 状态行的语义色写入口：error=红字、ok=绿字、默认=次要色。
     * WHY：下载/导入失败必须让用户一眼看出是「红字报错」（用户要求），
     * 而 #dva-status 默认是灰色次要文字，所以需要一个能带语气的写入口。
     */
    function setStatus(message, tone) {
      var node = el("dva-status");
      if (!node) return;
      node.textContent = message;
      try {
        node.style.color = tone === "error" ? TOKEN.danger : tone === "ok" ? TOKEN.success : TOKEN.textDim;
      } catch (e) {}
    }
    function setDisabled(id, disabled) {
      var node = el(id);
      if (node) node.disabled = Boolean(disabled);
    }
    function valueOf(id, fallback) {
      var node = el(id);
      if (!node || typeof node.value !== "string") return fallback;
      return node.value;
    }

    function request(path, options) {
      var init = options || {};
      init.headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
      return fetch(BASE + path, init).then(function (response) {
        return response.json().then(function (json) {
          return { status: response.status, json: json };
        }, function () {
          return { status: response.status, json: null };
        });
      });
    }

    function describeResult(kind, entry) {
      if (!entry) return LABELS[kind] + "：未生成";
      if (!entry.ok) return LABELS[kind] + "：生成失败（" + String(entry.error || "unknown") + "）";
      var gain = entry.gainSkipped
        ? "未做响度增益（" + String(entry.error || "ffmpeg 不可用") + "）"
        : "mean " + String(entry.gain && entry.gain.mean) + " dB / max " + String(entry.gain && entry.gain.max) + " dB" +
          (entry.withinTarget ? " ✓" : " ⚠ 超出目标区间");
      return LABELS[kind] + "：已生成 " + String(entry.bytes) + " bytes · " + gain;
    }

    function renderResults(job) {
      cache.results = job && job.outputs ? job.outputs : {};
      var lines = KINDS.map(function (kind) {
        return describeResult(kind, cache.results[kind]);
      });
      if (job && job.backupDir) lines.push("备份：" + job.backupDir);
      if (job && job.error) lines.push("注意：" + job.error);
      setText("dva-results", lines.join("\n"));
    }

    function pollJob() {
      return request("/generate-status", { method: "GET", headers: {} }).then(function (res) {
        var job = res.json || {};
        renderResults(job);
        if (job.running) {
          // 进度：本次要合成 changed.length 条，已完成 done 条（用户要求显示进度）。
          var changed = Array.isArray(job.changed) ? job.changed : [];
          var outputs = job.outputs || {};
          var done = changed.filter(function (kind) {
            return outputs[kind] && !outputs[kind].reused;
          }).length;
          setText(
            "dva-status",
            "⏳ 正在生成语音… " + String(done) + "/" + String(changed.length || KINDS.length) + "（合成 → 响度增益 → 备份）"
          );
          return;
        }
        cache.busy = false;
        setDisabled("dva-generate", !currentVoiceReady());
        // 完成/失败必须说清楚（用户要求「语音更新成功」这样的明确提示）。
        var failed = KINDS.filter(function (kind) {
          var entry = (job.outputs || {})[kind];
          return entry && entry.ok === false;
        });
        if (job.error || failed.length > 0) {
          setText(
            "dva-status",
            "⚠️ 语音更新失败：" +
              (failed.length > 0
                ? failed.map(function (kind) { return LABELS[kind]; }).join("、") + " 合成出错"
                : String(job.error))
          );
          return;
        }
        if (job.result === "nothing-changed") {
          setText("dva-status", "✅ 文案没有变化，已复用现有语音（未调用 TTS 合成）。");
          return;
        }
        if (job.result) {
          var updated = (job.changed || []).length;
          var reused = (job.reused || []).length;
          setText(
            "dva-status",
            "✅ 语音更新成功！" +
              (updated > 0 ? "已重新合成 " + String(updated) + " 条" : "本次无需合成") +
              (reused > 0 ? "，复用 " + String(reused) + " 条" : "") +
              "。点「试听」即可听到新语音。"
          );
          return;
        }
        setText("dva-status", "生成结束");
      });
    }

    function startPolling() {
      try {
        if (cache.statusTimer) clearInterval(cache.statusTimer);
      } catch (e) {}
      cache.statusTimer = setInterval(function () {
        if (cache.busy) pollJob();
        else {
          try {
            clearInterval(cache.statusTimer);
          } catch (e) {}
          cache.statusTimer = null;
        }
      }, 1500);
      pollJob();
    }

    function loadSettings() {
      if (cache.loading) return;
      cache.loading = true;
      // 返回这条 Promise，方便调用方在「设置读回来之后」再做收尾（例如撤销导入后
      // 重新写回成功提示——loadSettings 会往 dva-status 写空串，会把提示冲掉）。
      return request("/settings", { method: "GET", headers: {} }).then(
        function (res) {
          cache.loading = false;
          var data = res.json || {};
          if (!data.ok) {
            setText("dva-status", "读取失败（HTTP " + String(res.status) + "）");
            return;
          }
          cache.loaded = true;
          cache.enabled = data.enabled !== false;
          // requirement B: 提醒方式（语音/音效/关闭）+ 每类事件的音效选择。
          cache.alertMode = data.alertMode === "sfx" || data.alertMode === "off" ? data.alertMode : "voice";
          cache.sfxByKind = Object.assign({}, cache.sfxByKind, data.sfxByKind || {});
          if (Array.isArray(data.sfxCatalog) && data.sfxCatalog.length > 0) cache.sfxCatalog = data.sfxCatalog;
          applyAlertMode(cache.alertMode);
          applySfxSelection();
          loadSfxCatalog();
          cache.texts = Object.assign({}, cache.texts, data.texts || {});
          cache.prosody = Object.assign({}, cache.prosody, data.prosody || {});
          // 音量 0 = 静音：把宿主的权威判定显示到界面上（红字），避免用户设了 0
          // 却以为没生效。
          applyMuteNotice(Boolean(data.muted));
          cache.apiKeyPresent = Boolean(data.apiKeyPresent);
          cache.apiKeyMask = String(data.apiKeyMask || "");
          cache.voiceNote = String(data.voiceNote || "");
          // 哪几条播报已经换成用户自己导入的 mp3（宿主写标记文件后回传）。
          cache.imported = Object.assign({}, cache.imported, data.imported || {});
          KINDS.forEach(function (kind) {
            var node = el("dva-text-" + kind);
            if (node) node.value = cache.texts[kind] || "";
          });
          ["speed_ratio", "pitch_ratio", "volume_ratio"].forEach(function (key) {
            var node = el("dva-" + key);
            if (node) node.value = String(cache.prosody[key]);
          });
          var noteNode = el("dva-voice-note");
          if (noteNode) noteNode.value = cache.voiceNote;
          // The key input starts EMPTY on purpose: we never echo the stored secret,
          // only whether it exists (plus a short prefix mask).
          var keyNode = el("dva-tts-key");
          if (keyNode) keyNode.value = "";
          setText(
            "dva-key-state",
            cache.apiKeyPresent ? "已配置（" + cache.apiKeyMask + "）· 留空表示不修改" : "未配置"
          );
          setText("dva-key-note", String(data.keyStorageNote || ""));
          setText("dva-voice-note-policy", String(data.voicePolicyNote || ""));
          // 克隆入口文案以宿主为准（client 里那份只是首帧兜底，避免两边漂移）。
          if (data.cloneNote) setText("dva-clone-note", String(data.cloneNote));
          var volume = data.systemVolume || {};
          setText(
            "dva-volume",
            volume.ok
              ? "当前系统主音量：" + String(volume.volumePercent) + "%" + (volume.muted ? "（已静音）" : "") + " · " + String(volume.source || "")
              : "当前系统主音量：读取失败（" + String(volume.error || "unknown") + "）"
          );
          setText("dva-volume-note", String(data.systemVolumeNote || ""));
          refreshGenerateGate(data);
          if (data.generate) renderResults(data.generate);
          // imported 变了 → 动作组要跟着变（已导入的显示「⬆ 换一个」+「↩ 撤销导入」）。
          // 注意：这里是就地改 DOM，不重渲染 React 树，避免清掉用户正在输入的内容。
          refreshAllActionGroups();
          // requirement A: voice library (fire and forget).
          loadVoices();
        },
        function () {
          cache.loading = false;
          setText("dva-status", "读取失败：宿主路由不可达");
        }
      );
    }

    function saveSettings() {
      var keyValue = String(valueOf("dva-tts-key", "") || "").trim();
      /**
       * 读一个数字输入框，**空值退回上次已知值**。
       * WHY：Number("") === 0，用户把「音量」清空后点保存，旧写法会把它当成
       * 「音量 0 = 静音」写进去 —— 变成莫名其妙的静音。空框必须是「不改」。
       */
      function numField(id, fallback) {
        var raw = String(valueOf(id, "") || "").trim();
        if (raw.length === 0) return Number(fallback);
        var n = Number(raw);
        return Number.isFinite(n) ? n : Number(fallback);
      }
      var payload = {
        texts: {
          complete: valueOf("dva-text-complete", cache.texts.complete),
          fail: valueOf("dva-text-fail", cache.texts.fail),
          approval: valueOf("dva-text-approval", cache.texts.approval)
        },
        prosody: {
          speed_ratio: numField("dva-speed_ratio", cache.prosody.speed_ratio),
          pitch_ratio: numField("dva-pitch_ratio", cache.prosody.pitch_ratio),
          // 音量 0 是合法值（= 静音），只有「空框」才算不改。
          volume_ratio: numField("dva-volume_ratio", cache.prosody.volume_ratio)
        },
        voiceNote: String(valueOf("dva-voice-note", cache.voiceNote) || ""),
        enabled: el("dva-enabled") ? Boolean(el("dva-enabled").checked) : cache.enabled,
        // requirement B: 提醒方式 + 每类事件的音效（下拉值就是目录 key）。
        alertMode: cache.alertMode || "voice",
        sfxByKind: {
          complete: valueOf("dva-sfx-complete", cache.sfxByKind.complete),
          fail: valueOf("dva-sfx-fail", cache.sfxByKind.fail),
          approval: valueOf("dva-sfx-approval", cache.sfxByKind.approval)
        }
      };
      // Empty key box = "leave the stored key alone" (we never echo it back).
      if (keyValue.length > 0) payload.tts = { apiKey: keyValue };
      setText("dva-status", "正在保存…");
      return request("/settings", { method: "POST", body: JSON.stringify(payload) }).then(function (res) {
        var data = res.json || {};
        if (res.status === 200 && data.ok) {
          cache.enabled = data.enabled !== false;
          if (data.alertMode === "sfx" || data.alertMode === "off" || data.alertMode === "voice") {
            cache.alertMode = data.alertMode;
          }
          cache.sfxByKind = Object.assign({}, cache.sfxByKind, data.sfxByKind || {});
          applyAlertMode(cache.alertMode);
          // 「保存设置」这条路径同样改了 cache.enabled（宿主权威值），徽标要跟着更新。
          var enabledBox = el("dva-enabled");
          if (enabledBox) enabledBox.checked = cache.enabled !== false;
          applyEnabledBadge();
          cache.texts = Object.assign({}, cache.texts, data.texts || {});
          cache.prosody = Object.assign({}, cache.prosody, data.prosody || {});
          // 音量 0 = 静音：把宿主的权威判定显示到界面上（红字），避免用户设了 0
          // 却以为没生效。
          applyMuteNotice(Boolean(data.muted));
          cache.apiKeyPresent = Boolean(data.apiKeyPresent);
          cache.apiKeyMask = String(data.apiKeyMask || "");
          cache.voiceNote = String(data.voiceNote || "");
          var keyNode = el("dva-tts-key");
          if (keyNode) keyNode.value = "";
          setText("dva-key-state", cache.apiKeyPresent ? "已配置（" + cache.apiKeyMask + "）· 留空表示不修改" : "未配置");
          refreshGenerateGate(data);
          // 越界值会被宿主静默丢弃（审查 R7）：把「提交了但没被接受」的参数点名出来，
          // 否则用户填了 9 保存成功、界面看着「已保存」，实际仍是旧值 —— 与静音那个
          // bug 同类的「界面自嗨」。
          var rejected = [];
          var PROSODY_LABELS = { speed_ratio: "语速", pitch_ratio: "音调", volume_ratio: "音量" };
          var acceptedProsody = (data.applied && data.applied.prosody) || {};
          ["speed_ratio", "pitch_ratio", "volume_ratio"].forEach(function (key) {
            var sent = payload.prosody[key];
            var got = acceptedProsody[key];
            if (typeof got === "number" && Math.abs(got - sent) < 1e-9) return;
            rejected.push(PROSODY_LABELS[key] + " " + String(sent) + "（超出允许范围，已忽略）");
          });
          setText(
            "dva-status",
            "已保存" +
              (data.persisted && data.persisted.skipped ? "（仅内存）" : "（已写入 config.json）") +
              (data.applied && data.applied.tts && data.applied.tts.apiKey ? " · API Key 已更新" : "") +
              (rejected.length > 0 ? " ⚠ 未生效：" + rejected.join("、") : "")
          );
        } else {
          setText("dva-status", "保存失败：" + String((data && data.reason) || ("HTTP " + String(res.status))));
        }
      });
    }

    /**
     * 只提交一小块设置（总开关 / 提醒方式 / 音效选择），**立即生效、立即落盘**。
     *
     * WHY 需要它（2026-10 用户反馈）：
     *  - 总开关：旧版复选框是 React 受控组件但没 onChange，点了会被 React 立刻回写，
     *    看起来「根本点不动」；就算点动了，也要再按「保存设置」才生效。
     *  - 提醒方式：旧版点「音效」只改本地 cache + 按钮样式，**不发 POST**。用户点了
     *    音效却没按保存，宿主 config.alertMode 仍是 voice → 回合结束照样播人声。
     *
     * 所以凡是「开关类」控件一律点完即存：不依赖用户再去按保存按钮。
     * 注意：这里**只提交传入的那几个字段**，不读界面上的文案/Key（那是 saveSettings
     * 的职责），避免把用户正在输入但还没保存的内容顺带写进去。
     */
    /**
     * 只提交 patch 里点名的字段，成功则按宿主回包重画界面。
     *
     * 「点完即存」的三个控件（总开关 / 提醒方式 / 音效选择）都走这里。因为界面上
     * 已经先动了，失败时必须把界面**回滚到宿主仍持有的旧值**，否则用户看到的是
     * 「已关闭」，而宿主其实还在播报 —— 状态漂移比报错更难排查。
     */
    /**
     * 取「改动前」的状态快照。三个调用方都是**先改 cache 让界面即时响应、再落盘**，
     * 所以快照必须由调用方在改之前取好传进来 —— 若在这里取，拿到的已是改后值，
     * 失败回滚恢复的就是新值，等于没回滚（2026-10 审查发现）。
     */
    function snapshotState() {
      return {
        enabled: cache.enabled,
        alertMode: cache.alertMode,
        sfxByKind: Object.assign({}, cache.sfxByKind || {}),
        prosody: Object.assign({}, cache.prosody || {}),
        muted: cache.muted
      };
    }

    /**
     * 总开关标题旁的「已启用 / 已禁用」徽标。
     * WHY：状态徽标在 JSX 里由 cache.enabled 渲染，但 persistPatch 是命令式改 DOM、
     * 不触发 React 重渲染 —— 所以保存成功/失败回滚之后必须手动刷一次，
     * 否则勾了勾选框、徽标还停在旧文字（用户会以为开关没生效，正是 2026-10 那条反馈的同款）。
     */
    function applyEnabledBadge() {
      var node = el("dva-enabled-state");
      if (!node) return;
      var on = cache.enabled !== false;
      node.textContent = on ? "已启用" : "已禁用";
      node.style.color = on ? TOKEN.success : TOKEN.textDim;
      node.style.borderColor = on ? TOKEN.success : TOKEN.border;
    }

    function persistPatch(patch, okMessage, before, onOk) {
      // 快照：失败时用这份把界面退回去（宿主始终是权威）。优先用调用方传入的
      // 「改动前」快照；没传才退回当前值（老调用点兼容，但那样回滚不彻底）。
      var snapshot = before || snapshotState();
      function rollback() {
        cache.enabled = snapshot.enabled;
        cache.alertMode = snapshot.alertMode;
        cache.sfxByKind = Object.assign({}, snapshot.sfxByKind);
        cache.prosody = Object.assign({}, snapshot.prosody);
        applyAlertMode(cache.alertMode);
        applySfxSelection();
        applyMuteNotice(Boolean(snapshot.muted));
        var node = el("dva-enabled");
        if (node) node.checked = cache.enabled !== false;
        applyEnabledBadge();
      }
      return request("/settings", { method: "POST", body: JSON.stringify(patch) }).then(
        function (res) {
          var data = res.json || {};
          if (res.status === 200 && data.ok) {
            if (typeof data.enabled === "boolean") cache.enabled = data.enabled;
            if (data.alertMode === "sfx" || data.alertMode === "off" || data.alertMode === "voice") {
              cache.alertMode = data.alertMode;
            }
            if (data.sfxByKind) cache.sfxByKind = Object.assign({}, cache.sfxByKind, data.sfxByKind);
            if (data.prosody) cache.prosody = Object.assign({}, cache.prosody, data.prosody);
            // 宿主是唯一权威：按钮/面板按服务端回来的值重画，避免界面与真实状态漂移。
            applyAlertMode(cache.alertMode);
            applySfxSelection();
            var box = el("dva-enabled");
            if (box) box.checked = cache.enabled !== false;
            applyEnabledBadge();
            applyMuteNotice(Boolean(data.muted));
            if (okMessage) setStatus(okMessage, "ok");
            if (typeof onOk === "function") onOk();
          } else {
            rollback();
            setStatus("保存失败：" + String((data && data.reason) || ("HTTP " + String(res.status))), "error");
          }
        },
        function () {
          rollback();
          setStatus("保存失败：宿主路由不可达", "error");
        }
      );
    }

    /**
     * 「音量 = 0 就是静音」的界面提示：状态行 + 音量输入框旁的红字。
     * 用户设 0 却还听到声音时会以为设置没生效，所以必须显式告诉他现在是静音状态。
     */
    function applyMuteNotice(muted) {
      cache.muted = Boolean(muted);
      setText(
        "dva-mute-note",
        cache.muted ? "🔕 当前音量 = 0（静音）：所有播报和试听都不会出声。" : ""
      );
    }

    function generateAll() {
      if (cache.busy) return; // guard against double clicks while a run is in flight
      var force = false;
      var forceNode = el("dva-force");
      if (forceNode) force = Boolean(forceNode.checked);
      cache.busy = true;
      setDisabled("dva-generate", true);
      setText("dva-status", "正在保存文案…");
      // 🔴 一键式：先把界面上当前的文案（连同总开关 / 提醒方式 / 音效选择）写进
      // config，再提交生成。否则「改了文字直接点生成」会拿上一次保存的旧文案去合成
      // ——那是用户反馈的核心痛点。保存失败也继续提交（生成器用的是宿主内存里的文案）。
      return saveSettings()
        .then(function () {
          setText("dva-status", "正在提交生成任务…");
          return request("/generate", { method: "POST", body: JSON.stringify({ kinds: KINDS, force: force }) });
        })
        .then(function (res) {
          var data = res.json || {};
          if (res.status === 202 && data.ok) {
            // 🔴「强制重新生成」= 一次性：本次已按强制提交，立刻取消勾选。
            // 否则用户勾一次后忘记取消，以后每次生成都会把三条全部重做、白耗 TTS 额度
            // （用户 2026-09-16 确认改成一次性）。
            if (forceNode) forceNode.checked = false;
            setText(
              "dva-status",
              "任务已受理，正在生成…（本次需合成：" + String((data.changed || []).join("、") || "-") + "；复用：" + String((data.reused || []).join("、") || "-") + "）"
            );
            startPolling();
            return;
          }
          if (res.status === 200 && data.ok && data.reason === "nothing-changed") {
            if (forceNode) forceNode.checked = false;
            cache.busy = false;
            setDisabled("dva-generate", !currentVoiceReady());
            setText("dva-status", "没有需要重新合成的改动，已复用现有语音（未调用 TTS）。如需强制重做，请勾选「强制重新生成（仅本次）」。");
            pollJob();
            return;
          }
          // 提交失败：保留勾选状态，用户可以直接重试（仍按强制重做）。
          cache.busy = false;
          // 走统一判据：选免费音色时无需任何 Key 也能重试，否则免费音色用户
          // 提交失败一次之后按钮就永久置灰（免费音色评审 D 轮报回的漂移残留）。
          setDisabled("dva-generate", !currentVoiceReady());
          setText("dva-status", "无法生成：" + String((data && data.reason) || ("HTTP " + String(res.status))));
        });
    }

    function preview(kind) {
      setText("dva-status", "试听 " + LABELS[kind] + "…（若听不到声音，请先检查系统音量）");
      return request("/preview?kind=" + encodeURIComponent(kind), { method: "POST", body: "{}" }).then(function (res) {
        var data = res.json || {};
        setText(
          "dva-status",
          data.ok
            ? "试听 " + LABELS[kind] + "（" + String(data.audioMode) + "）· 无声时请检查系统音量"
            : data.muted
              ? "试听 " + LABELS[kind] + "：已静音（音量设为 0）"
              // alertMode=off 不是「失败」，是「你把它关了」——按失败报错会让用户以为出故障。
              : String(data.reason || "").indexOf("alertMode=off") >= 0
                ? "提醒方式当前是「关闭」，试听不会出声。要听就先把提醒方式改成「语音」或「音效」。"
                : "试听失败：HTTP " + String(res.status) + (data.reason ? "（" + String(data.reason) + "）" : "")
        );
      });
    }

    // ================= 下载 MP3 / 导入 MP3（用户 2026-10 需求） =================
    //
    // 宿主契约（已冻结，不得改名）：
    //   下载 GET  /dsh-voice-alert/audio/download?kind=<complete|fail|approval>&variant=loud|origin
    //             -> 二进制 audio/mpeg
    //   导入 POST /dsh-voice-alert/audio/import?kind=<kind>
    //             -> body 就是原始 mp3 字节（**不是 JSON**），上限 10MB
    //
    // 🔴 这里必须用原生 fetch，不能用上面的 request()：request() 会强加
    //    content-type: application/json 并把响应当 JSON 解析——二进制 mp3 走那条路
    //    会被 .json() 吃掉（拿到 null），上传也会把字节声明成 JSON。
    var MP3_IMPORT_LIMIT = 10 * 1024 * 1024; // 10MB，与宿主上限一致
    var MP3_VARIANT = "loud"; // 下载默认取「已做响度增益」的那份（与试听/播报听到的一致）

    // ---- 英文 reason → 中文人话（用户 2026-10 需求） ----
    //
    // WHY: 宿主侧的错误原因是英文常量（"not an mp3" / "audio file not found" …），
    // 直接拼进提示行普通用户看不懂。这里做一层翻译：把技术原因翻成
    // 「下一步该干什么」，而不是把后台原话甩给用户。
    //
    // 未知原因保留原文兜底（绝不返回空串，否则用户只看到「导入失败：」）。
    function humanReason(reason, kind) {
      var raw = reason === null || reason === undefined ? "" : String(reason).trim();
      if (!raw) return "";
      var low = raw.toLowerCase();
      var label = LABELS[kind] || "";
      var who = label ? "「" + label + "」这条播报" : "这条播报";
      if (low.indexOf("not an mp3") >= 0) {
        return "这个文件不是 mp3 格式。请选一个 .mp3 文件（或者先用别的软件把它转成 mp3）。";
      }
      if (low.indexOf("audio file not found") >= 0) {
        return who + "还没有音频文件。请先点「🎙 生成语音（一键更新）」。";
      }
      if (low.indexOf("body too large") >= 0) {
        return "文件太大了（上限 10 MB）。请先压缩或裁短再试。";
      }
      if (low.indexOf("kind must be one of") >= 0) {
        return "内部参数不对（kind 取值不合法），请刷新页面重试。";
      }
      if (low.indexOf("variant must be") >= 0) {
        return "内部参数不对（variant 取值不合法），请刷新页面重试。";
      }
      if (low.indexOf("use get or post") >= 0 || low.indexOf("use post") >= 0) {
        return "操作方式不对，请刷新页面重试。";
      }
      if (low.indexOf("name must be a catalogue key") >= 0) {
        return "音效名不对（这个音效不在音效库里），请刷新页面重试。";
      }
      if (low.indexOf("body is not json") >= 0) {
        return "请求内容格式不对，请刷新页面重试。";
      }
      return raw; // 兜底：保留原文，不让用户看到空白
    }

    /** 触发浏览器下载：blob -> objectURL -> 临时 <a download> -> 延迟回收。 */
    function saveBlobAsFile(blob, filename) {
      var url = null;
      try {
        url = URL.createObjectURL(blob);
      } catch (e) {
        return false;
      }
      var ok = false;
      try {
        var a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        a.style.display = "none";
        var host = document.body || document.documentElement;
        if (host && host.appendChild) host.appendChild(a);
        a.click();
        if (host && host.removeChild) {
          try {
            host.removeChild(a);
          } catch (e2) {}
        }
        ok = true;
      } catch (e3) {
        ok = false;
      }
      // 延迟回收：立刻 revoke 会让部分浏览器取消下载。
      try {
        setTimeout(function () {
          try {
            URL.revokeObjectURL(url);
          } catch (e4) {}
        }, 20000);
      } catch (e5) {}
      return ok;
    }

    /** 音效导出/导入的失败提示（2026-10-25 第九轮教训：绝不留空白）。 */
    function sfxIoFailReason(status, raw, data) {
      var st = Number(status) || 0;
      var looksHtml = typeof raw === "string" && raw.slice(0, 200).toLowerCase().indexOf("<!doctype html") >= 0;
      if (st === 403 && looksHtml) return "请求被 DSH 的浏览器安全栅栏拦下。请在 DSH 桌面端的设置面板里操作（不要用外部浏览器打开该页面）。";
      if (st === 404 || st === 405) return "插件的宿主半还没加载这条新路由 —— 需要**完全退出并重启 DSH**（不是刷新页面）。";
      var reason = data && data.reason ? String(data.reason) : "";
      var human = humanReason(reason);
      if (human) return human;
      if (reason) return reason;
      if (st === 413) return "文件太大（上限 10 MB）。请先压缩或裁短。";
      if (st >= 500) return "后台处理出错（HTTP " + st + "）。请重试一次；仍然失败请把 voice-alert.log 发我。";
      if (st === 0) return "网络请求没完成，请检查 DSH 是否正在运行。";
      return "后台返回了 HTTP " + st + "，但没有给出具体原因。请重试；仍然失败请把 voice-alert.log 发我。";
    }

    /** 音效导出/导入的反馈：直接写状态盒左栏（#dva-sfx-note 节点已删）。 */
    function sfxNote(msg, tone) {
      if (tone === "error") setStatus(msg, "error");
      else setStatus(msg, tone === "ok" ? "ok" : undefined);
    }

    /** 导出某条提示音的 mp3（音效模式下「⬇ 导出」按钮）。 */
    function downloadSfx(key) {
      if (!key) { sfxNote("还没有为这个事件选提示音。", "error"); return; }
      var name = sfxNameOf(key);
      sfxNote("正在导出提示音「" + name + "」…");
      return fetch(BASE + "/sfx/download?name=" + encodeURIComponent(key), { headers: {} }).then(
        function (res) {
          if (!res.ok) {
            return res.text().catch(function () { return ""; }).then(function (raw) {
              var data = {};
              try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = {}; }
              sfxNote("❌ 导出失败：" + sfxIoFailReason(res.status, raw, data), "error");
            });
          }
          return res.blob().then(function (blob) {
            if (!blob || !blob.size) { sfxNote("❌ 导出失败：后台返回了空文件。", "error"); return; }
            var okFile = "voice-alert-sfx-" + key + ".mp3";
            if (!saveBlobAsFile(blob, okFile)) { sfxNote("❌ 导出失败：当前环境不支持保存文件，请换用桌面端再试。", "error"); return; }
            sfxNote("✅ 已导出「" + name + "」，文件名 " + okFile + "（大小 " + Math.round(blob.size / 1024) + " KB）。", "ok");
          });
        },
        function () { sfxNote("❌ 导出失败：连不上插件后台（宿主路由不可达）。", "error"); }
      );
    }

    /** 用一个本地 mp3 换掉某条提示音（音效模式下「⬆ 导入」按钮）。 */
    function importSfx(key, kind) {
      if (!key) { sfxNote("还没有为这个事件选提示音。", "error"); return; }
      var name = sfxNameOf(key);
      // 复用动态 <input type=file>（与 importMp3 同一套：用完即弃，不占界面）。
      var picker;
      try { picker = document.createElement("input"); } catch (e) { sfxNote("导入失败：当前环境无法选择文件。", "error"); return; }
      picker.type = "file";
      picker.accept = "audio/mpeg,audio/mp3,.mp3";
      picker.style.display = "none";
      picker.addEventListener("change", function () {
        var file = picker.files && picker.files[0];
        try { var parent = picker.parentNode; if (parent && parent.removeChild) parent.removeChild(picker); } catch (e0) {}
        if (!file) return;
        if (file.size > MP3_IMPORT_LIMIT) { sfxNote("导入失败：文件太大（上限 10 MB），请先压缩或裁短。", "error"); return; }
        sfxNote("正在导入提示音「" + name + "」…");
        // 与 /audio/import 同一上传形态：裸二进制（content-type: audio/mpeg）。
        fetch(BASE + "/sfx/import?name=" + encodeURIComponent(key), { method: "POST", headers: { "content-type": "audio/mpeg" }, body: file }).then(
          function (res) {
            return res.text().catch(function () { return ""; }).then(function (raw) {
              var data = {};
              try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = {}; }
              if (res.status === 200 && data.ok) {
                loadSfxCatalog();
                sfxNote("✅ 已导入「" + name + "」，点「▶ 试听」即可听到新声音。", "ok");
                previewSfxKey(key);
              } else {
                sfxNote("❌ 导入失败：" + sfxIoFailReason(res.status, raw, data), "error");
              }
            });
          },
          function () { sfxNote("❌ 导入失败：连不上插件后台（宿主路由不可达）。", "error"); }
        );
      });
      document.body.appendChild(picker);
      picker.click();
    }

    /**
     * 下载当前这条播报的 mp3。
     * 失败一律写红字（用户要求），成功写绿字并带上文件名。
     */
    function downloadMp3(kind) {
      var label = LABELS[kind] || String(kind);
      var filename = "voice-alert-" + String(kind) + ".mp3";
      setStatus("正在打包「" + label + "」的 mp3…");
      var url = BASE + "/audio/download?kind=" + encodeURIComponent(kind) + "&variant=" + MP3_VARIANT;
      return fetch(url, { method: "GET" }).then(
        function (response) {
          if (!response || response.ok === false || (response.status && response.status >= 400)) {
            // 宿主失败时回的是 JSON {ok:false, reason:"…"}（英文常量），
            // 这里翻成中文人话；读不到 body 就退回按 HTTP 状态给建议。
            var statusCode = String((response && response.status) || "?");
            var readReason =
              response && typeof response.json === "function"
                ? response.json().then(
                    function (json) {
                      return json && json.reason ? json.reason : "";
                    },
                    function () {
                      return "";
                    }
                  )
                : null;
            if (!readReason) {
              setStatus(
                "下载失败：「" + label + "」这条音频还没生成（HTTP " + statusCode + "）。请先点「🎙 生成语音（一键更新）」。",
                "error"
              );
              return;
            }
            return readReason.then(function (reason) {
              var friendly = humanReason(reason, kind);
              if (friendly) {
                setStatus("下载失败：" + friendly, "error");
                return;
              }
              setStatus(
                "下载失败：「" + label + "」这条音频还没生成（HTTP " + statusCode + "）。请先点「🎙 生成语音（一键更新）」。",
                "error"
              );
            });
          }
          if (typeof response.blob !== "function") {
            setStatus("下载失败：当前环境不支持保存文件，请换用桌面端再试。", "error");
            return;
          }
          return response.blob().then(
            function (blob) {
              if (!blob || !blob.size) {
                setStatus("下载失败：后台返回了空文件，请先点「🎙 生成语音（一键更新）」再试。", "error");
                return;
              }
              if (!saveBlobAsFile(blob, filename)) {
                setStatus("下载失败：浏览器没有允许保存文件，请换用桌面端再试。", "error");
                return;
              }
              setStatus("✅ 已下载「" + label + "」这条播报，文件名 " + filename + "（大小 " + Math.round(blob.size / 1024) + " KB）。", "ok");
            },
            function () {
              setStatus("下载失败：读取音频数据出错，请稍后再试。", "error");
            }
          );
        },
        function () {
          setStatus("下载失败：连不上插件后台（宿主路由不可达）。", "error");
        }
      );
    }

    /**
     * 用用户自己的 mp3 替换某一条播报。
     * 选文件用动态创建的隐藏 <input type=file>（不占界面、不新增常驻控件）。
     */
    function importMp3(kind) {
      var label = LABELS[kind] || String(kind);
      var picker;
      try {
        picker = document.createElement("input");
      } catch (e) {
        setStatus("导入失败：当前环境无法选择文件。", "error");
        return;
      }
      if (!picker) {
        setStatus("导入失败：当前环境无法选择文件。", "error");
        return;
      }
      picker.type = "file";
      picker.accept = "audio/mpeg,audio/mp3,.mp3";
      picker.style.display = "none";
      // 每次点击都新建一个 input，用完即弃 —— 否则同一个 input 选同一个文件
      // 不会再触发 change（浏览器行为），用户会以为「点了没反应」。
      picker.addEventListener("change", function () {
        var file = picker.files && picker.files[0];
        // 选完就把临时 input 摘掉（它永远不该留在界面上）。
        try {
          var parent = picker.parentNode;
          if (parent && parent.removeChild) parent.removeChild(picker);
        } catch (e0) {}
        if (!file) return;
        if (file.size > MP3_IMPORT_LIMIT) {
          setStatus(
            "导入失败：文件太大（" + Math.round((file.size / 1024 / 1024) * 10) / 10 + " MB），上限 10 MB。请先压缩或裁短。",
            "error"
          );
          return;
        }
        setStatus("正在导入「" + label + "」的音频…");
        // 原生 fetch：body 直接放 File（浏览器发原始字节），content-type 声明 mp3。
        fetch(BASE + "/audio/import?kind=" + encodeURIComponent(kind), {
          method: "POST",
          headers: { "content-type": "audio/mpeg" },
          body: file
        })
          .then(function (response) {
            return response.json().then(
              function (json) {
                return { status: response.status, json: json };
              },
              function () {
                return { status: response.status, json: null };
              }
            );
          })
          .then(
            function (res) {
              var data = res.json || {};
              if (res.status === 200 && data.ok) {
                // 就地记下「这条已导入」，动作组立刻变成「⬆ 换一个」+「↩ 撤销导入」，
                // 不用等下一次 loadSettings 才知道状态。
                if (!cache.imported) cache.imported = { complete: false, fail: false, approval: false };
                cache.imported[kind] = true;
                try {
                  refreshActionGroup(kind);
                } catch (e) {}
                setStatus("✅ 已导入，点试听即可听到你导入的音频（下次播报就播这一条）。", "ok");
                // 导入后立刻试听，让用户当场确认是不是他要的声音。
                // preview() 自己也会往状态行写「试听 完成（…）」，会把这句成功提示盖掉，
                // 所以在它 resolve 之后再把「已导入」这条结论补回去（含已自动试听一次）。
                var played = preview(kind);
                if (played && typeof played.then === "function") {
                  played.then(
                    function () {
                      setStatus("✅ 已导入，并已自动试听一次（下次播报就播你导入的这一条）。", "ok");
                    },
                    function () {}
                  );
                }
                return;
              }
              // 宿主失败时 data.reason 是英文常量（"not an mp3" / "body too large" …），
              // 交给 humanReason 翻成「下一步该干什么」的中文；未知原因保留原文兜底。
              var rawReason = data && (data.reason || data.error);
              var friendly = humanReason(rawReason, kind);
              if (friendly) {
                setStatus("导入失败：" + friendly, "error");
                return;
              }
              setStatus("导入失败：后台没有给出具体原因（HTTP " + String(res.status) + "），请刷新页面重试。", "error");
            },
            function () {
              setStatus("导入失败：连不上插件后台（宿主路由不可达）。", "error");
            }
          );
      });
      var host = document.body || document.documentElement;
      if (host && host.appendChild) host.appendChild(picker);
      picker.click();
    }

    /**
     * 撤销导入：把这条播报恢复成「自动生成的语音」。
     * 宿主删掉导入标记 + 还原被替换掉的原文件（restored 里是被还原的文件名）。
     */
    function undoImport(kind) {
      var label = LABELS[kind] || String(kind);
      setStatus("正在撤销「" + label + "」的导入…");
      return fetch(BASE + "/audio/import/undo?kind=" + encodeURIComponent(kind), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }).then(
        function (response) {
          var readJson =
            response && typeof response.json === "function"
              ? response.json().then(
                  function (json) {
                    return json || {};
                  },
                  function () {
                    return {};
                  }
                )
              : Promise.resolve({});
          return readJson.then(function (data) {
            var status = (response && response.status) || 0;
            if (status === 200 && data.ok) {
              if (!cache.imported) cache.imported = { complete: false, fail: false, approval: false };
              cache.imported[kind] = false;
              try {
                refreshActionGroup(kind);
              } catch (e) {}
              var okMessage = "✅ 已撤销导入，「" + label + "」恢复成自动生成的语音。";
              setStatus(okMessage, "ok");
              // 重新拉一遍设置：宿主标记已删，撤销按钮要随之消失。
              // loadSettings 会把 dva-status 写回空串，所以等它回来再把成功提示补上。
              var reload = null;
              try {
                reload = loadSettings();
              } catch (e) {}
              if (reload && typeof reload.then === "function") {
                reload.then(
                  function () {
                    setStatus(okMessage, "ok");
                  },
                  function () {}
                );
              }
              return;
            }
            if (status === 404 && data.reason === "no import marker") {
              setStatus("这条本来就不是导入的，不用撤销。", "error");
              return;
            }
            var friendly = humanReason(data.reason || data.error, kind);
            if (friendly) {
              setStatus("撤销失败：" + friendly, "error");
              return;
            }
            setStatus("撤销失败：后台没有给出具体原因（HTTP " + String(status) + "），请刷新页面重试。", "error");
          });
        },
        function () {
          setStatus("撤销失败：连不上插件后台（宿主路由不可达）。", "error");
        }
      );
    }

    // ---- v0.4.9 主题自适应配色（浅色 / 深色背景都能看清） ----
    //
    // WHY (real bug, 2026-10-10): v0.3.2 起这里的颜色是**写死的深色主题色**——
    // 正文用 rgba(255,255,255,.xx) 的白字、标题 #e6edf3、次要文字 #8b93a8，
    // 容器底用 rgba(255,255,255,.xx) 的半透明白。深色背景下白字亮底正常，
    // **浅色背景下白字落在白底上 = 完全看不见**（用户报"浅色背景看不清"）。
    //
    // 修法不是"再来一套写死的浅色"，而是改用**宿主的设计令牌**（design token）：
    // DSH 的主题服务（@deepseek-ai/dsh-client-ui-theme）在浅/深两套调色板上
    // 重绑 --dsw-alias-* 变量（深色经 body[data-ds-dark-theme] 选择器切换，
    // 不是 .dark 类）。令牌随主题自动反转，插件只要引用变量即可两端都清楚，
    // 也不会在换肤 / 跟随系统时失配（生态规范：组合优先，不假设宿主实现）。
    //
    // 变量名取自本机安装目录实证（非记忆）：
    //   resources/app/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
    // 兜底值写在 var() 第二参：万一宿主未加载令牌，退回一套中性的灰阶，
    // 保证"至少能看清"，而不是白底白字。
    var TOKEN = {
      text: "var(--dsw-alias-label-primary, #1f2328)",            // 正文/标题：浅色→近黑，深色→近白
      textStrong: "var(--dsw-alias-label-primary, #1f2328)",      // 大标题（同主文字，语义留名便于以后分档）
      textDim: "var(--dsw-alias-label-secondary, #6a737d)",       // 次要说明文字
      textTertiary: "var(--dsw-alias-label-secondary, #6a737d)",   // 更弱的三级文字（仍用 secondary：
                                                                    // tertiary 在浅色下对比度仅 3.7，11px 小字偏灰，宁可比宿主略稳）
      bgInput: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))",   // 输入框底
      bgCard: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))",    // 卡片底
      bgCardSoft: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.09))",// 稍深一档的卡片底（总控卡）
      bgControl: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))", // 次按钮/勾选标签底
      bgControlHover: "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.22))",
      borderSoft: "var(--dsw-alias-border-l2, rgba(127,127,127,.28))",  // 卡片边框
      border: "var(--dsw-alias-border-l3, rgba(127,127,127,.38))",      // 控件边框
      accent: "var(--dsw-alias-brand-primary, #1f6feb)",          // 主色（主按钮底）
      accentHover: "var(--dsw-alias-button-primary-hover, #388bfd)",
      accentText: "var(--dsw-alias-label-primary-foreground, #fff)", // 主色按钮上的字
      // 成功色：宿主的 --dsw-alias-state-success-primary 绑 green-500 (#22c55e)，
      // 该静态色两套主题同值、且在白卡片上对比度仅 2.28（小字不可读）。
      // 这里改用**成功语义的文字色**：浅色主题走较深的绿（green-900 系），
      // 深色主题走较亮的绿；用 color-mix 从主题令牌派生，避免写死两套。
      success: "color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a7f37) 72%, var(--dsw-alias-label-primary, #1f2328))",
      danger: "var(--dsw-alias-state-error-primary, #cf222e)",
      // 警告色：宿主 --dsw-alias-state-warn-primary 绑的是 amber-500 (#f59e0b)，
      // 而该静态色**浅/深两套主题同值**（不随主题反转），落在浅色卡片上
      // 对比度只有 2.15 —— 正是本次"浅色背景看不清"的同类问题。
      // 故文案类警告改用**文字语义令牌** label-primary（浅→近黑 / 深→近白），
      // 保证两端都能读；需要色相时再用 state-warn-label。
      warn: "var(--dsw-alias-label-primary, #9a6700)",
      link: "var(--dsw-alias-brand-primary, #0969da)",
      // 卡片阴影：从文字令牌派生一层极淡的投影（不写死黑色，深浅主题都能用），
      // 用来把三张卡片「抬」起来一点点，视觉上比纯描边更有层次。
      shadow: "0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary, #1f2328) 10%, transparent)",
      // 实色卡片底：悬浮气泡必须不透明，否则浮在下层文字上会糊成一片。
      // 宿主令牌全是半透明层，这里用 mix-blend 方式从宿主实底派生：
      // 浅色主题 → 接近白，深色主题 → 接近深灰，两套主题都能自适应。
      bgSolid: "color-mix(in srgb, var(--dsw-alias-bg-layer-1, #ffffff) 100%, transparent)",
      // 浮层要加强投影，否则和卡片贴在一起分不清边界。
      shadowPop: "0 4px 14px color-mix(in srgb, var(--dsw-alias-label-primary, #1f2328) 22%, transparent)"
    };

    // ================= requirement A: voice library =================
    /**
     * 当前选中的音色到底能不能合成。
     * WHY：旧版只看火山克隆 Key（`!cache.apiKeyPresent` 就禁用「生成语音」），
     * 于是选了**免费音色**（不需要任何 Key）的用户按钮永远是灰的 —— 正好违背
     * 用户要免费音色的初衷「安装上直接体验语音提醒」。
     */
    function currentVoiceReady() {
      if (String(cache.selectedVoiceId || "").indexOf("free:") === 0) return true;
      var st = cache.voicesStatuses[cache.selectedVoiceId];
      if (st) return Boolean(st.keyPresent);
      return Boolean(cache.apiKeyPresent);
    }

    /**
     * 「🎙 生成语音」按钮的可用性 + 对应提示，统一从这里出。
     * WHY：这个判据要在多个地方刷（/settings 回来、/voices 回来、切音色、跑完），
     * 每处各写一遍 `!cache.apiKeyPresent` 迟早漂移（本次三个 bug 之一就是这种漂移）。
     */
    /**
     * 当前选中音色的显示名（本地算，不依赖宿主回传）。
     * WHY：/voices/save 的返回里不带 label，切完音色如果等宿主给文案，界面就停在
     * 旧音色名上（用户会以为没切换成功）。本地缓存里本来就有两份目录，够用。
     */
    function voiceLabelFor(id) {
      var want = String(id || "");
      if (!want) return "";
      var free = (cache.freeVoices || []).filter(function (v) { return v.id === want; })[0];
      if (free) return String(free.label || free.id);
      var mine = (cache.voices || []).filter(function (v) { return v.id === want; })[0];
      if (mine) return String(mine.note || mine.id);
      return want;
    }

    function voiceKindFor(id) {
      var want = String(id || "");
      if (want.indexOf("free:") === 0) return "free";
      var st = cache.voicesStatuses[want];
      if (st && st.kind) return st.kind;
      var mine = (cache.voices || []).filter(function (v) { return v.id === want; })[0];
      return mine ? String(mine.kind || "clone") : "clone";
    }

    function refreshGenerateGate(data) {
      var ready = currentVoiceReady();
      setDisabled("dva-generate", !ready || cache.busy);
      // 旧代码在「有克隆 Key」时把状态行清空、「没 Key」时写「未配置 TTS API Key」。
      // 现在判据换成「当前音色能不能合成」：选了免费音色就不该再喊缺 Key。
      // 只在「缺 Key」时覆盖状态行，其余情况不碰（否则会抹掉生成进度/结果文案）。
      if (!ready) {
        setText("dva-status", String((data && data.apiKeyHint) || "未配置 TTS API Key"));
      }
      // 「音色：…」那行以前永远显示历史固定 ID，选了库/免费音色后是误导信息。
      var label = voiceLabelFor(cache.selectedVoiceId);
      if (label) {
        var kind = voiceKindFor(cache.selectedVoiceId);
        var kindText = kind === "free" ? "免费音色" : kind === "preset" ? "预设音色" : "克隆音色";
        setText("dva-voice", "当前音色：" + label + "（" + kindText + "）");
      }
      return ready;
    }

    // 这些行用 cssText 字符串拼样式，令牌同样以 var() 形式内联，随主题反转。
    function tint(token, alphaPercent) {
      // 用 color-mix 在令牌色上直接调透明度（现代 Chromium 均支持）；
      // 不支持时回退到原样令牌色（可见性优先于透明感）。
      return "color-mix(in srgb, " + token + " " + alphaPercent + "%, transparent)";
    }
    // WHY flex:0 0 auto + white-space:nowrap（用户反馈 2026-10：「这按钮都出去了」）：
    // 行内其余单元格原先都是 flex:0 0 固定px（不可收缩），窄面板下总宽超出卡片，
    // 排在最后的按钮被挤到卡片外面；按钮又能换行，于是「设为当前」被压成
    // 一列竖排单字。按钮必须既不缩也不折 —— 该收缩的是中间的文本列。
    var btnMini = "flex:0 0 auto;white-space:nowrap;background:" + TOKEN.bgControl + ";border:1px solid " + TOKEN.border + ";border-radius:6px;color:" + TOKEN.text + ";font-size:11px;padding:2px 8px;cursor:pointer";
    var btnMiniDisabled = "flex:0 0 auto;white-space:nowrap;background:" + TOKEN.bgCard + ";border:1px solid " + TOKEN.borderSoft + ";border-radius:6px;color:" + TOKEN.textTertiary + ";font-size:11px;padding:2px 8px";

    // ---- 音色库行的三个小构件（音色卡太长，分组标题 + 徽标 + 提示行都复用这里） ----
    function badge(text, bg) {
      var span = document.createElement("span");
      span.textContent = text;
      span.style.cssText = "flex:0 0 34px;text-align:center;font-size:11px;border-radius:4px;padding:1px 4px;color:" + TOKEN.accentText + ";background:" + bg;
      return span;
    }
    function groupHeader(text) {
      var div = document.createElement("div");
      div.textContent = text;
      div.style.cssText = "font-size:11.5px;color:" + TOKEN.textDim + ";padding:6px 0 2px;line-height:1.4";
      return div;
    }
    function hintRow(text) {
      var div = document.createElement("div");
      div.textContent = text;
      div.style.cssText = "font-size:11px;color:" + TOKEN.warn + ";padding:2px 0 4px;line-height:1.45";
      return div;
    }

    /** Rebuild the voice-library rows into the React-rendered container (DOM, id-based). */
    function renderVoiceRows() {
      // 先把「槽位出生」看门狗挂上：即便这次连槽位都还没有（React 还没挂载），
      // 等它一出现也能立刻补画，不用等下一帧的 setTimeout 自愈。
      ensureSlotGuard();
      var box = el("dva-voice-rows");
      if (!box || typeof box.replaceChildren !== "function") return; // DOM-stub guard
      var rows = [];
      // ---- 🆓 免费内置音色（edge-tts，无需 Key） ----------------------------
      // 用户 2026-10-24 的需求：「安装上直接体验语音提醒」+「甜美得女生声音台湾腔」。
      // 这组是**服务端目录**（cache.freeVoices），不在 voices 数组里、不可删除、
      // 不写进 config.json，所以它绝不会影响用户自己配好的 key 音色（切换即回退）。
      rows.push(groupHeader("🆓 免费内置音色 · 无需 Key（点「设为当前」立即生效）"));
      if (cache.freeVoices.length === 0) {
        rows.push(hintRow("免费音色列表读取中…（若长时间不出现，刷新本页）"));
      }
      if (cache.freeRuntime && !cache.freeRuntime.edgeTts) {
        rows.push(
          hintRow(
            cache.freeRuntime.python
              ? "⚠ 本机已装 Python，但缺 edge-tts 模块：在终端执行  pip install edge-tts  后即可试听。"
              : "⚠ 找不到可用的 Python：免费音色需要 Python + edge-tts（pip install edge-tts）。不想装的话用「音效」模式或自己的 Key 音色。"
          )
        );
      }
      cache.freeVoices.forEach(function (voice) {
        var isCurrent = voice.id === cache.selectedVoiceId;
        var row = document.createElement("div");
        // 每行必须**一行放下**（用户 2026-10：能一行就别拐行）。做法：行不换行、
        // 行自身 min-width:0，中间可变的文本列改成「可收缩」而不是固定 px，
        // 右侧按钮由 btnMini 保证不缩不折 —— 挤压只会发生在文本列上。
        row.style.cssText = "display:flex;flex-wrap:nowrap;min-width:0;align-items:center;gap:6px;font-size:12px;padding:3px 0;border-bottom:1px solid " + TOKEN.borderSoft;
        row.appendChild(badge("免费", TOKEN.success));
        var cur = document.createElement("span");
        cur.textContent = isCurrent ? "●当前" : "○";
        cur.style.cssText = "flex:0 0 40px;font-size:11px;color:" + (isCurrent ? TOKEN.success : TOKEN.textTertiary);
        row.appendChild(cur);
        var nameLabel = document.createElement("span");
        nameLabel.textContent = voice.label || voice.id;
        nameLabel.title = voice.edgeVoice + " · pitch " + voice.pitch + " · rate " + voice.rate;
        // flex:0 1 210px = 空间够就保持 210px，不够就收缩到省略号，绝不把按钮顶出去。
        nameLabel.style.cssText = "flex:0 1 210px;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:" + TOKEN.text;
        row.appendChild(nameLabel);
        var avail = document.createElement("span");
        // 免费音色永远不缺 Key；唯一的前提是 python + edge-tts 存在（宿主已探过）。
        avail.textContent = !cache.freeRuntime ? "✓可用" : cache.freeRuntime.edgeTts ? "✓可用" : "缺edge-tts";
        // nowrap + 省略号：原先没加 white-space:nowrap，「缺edge-tts」正好等于盒宽会折成两行、
        // 把整行撑高（独立复核实测）。现在宁可省略也绝不让这一行变高。
        avail.style.cssText = "flex:0 0 68px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:" + (!cache.freeRuntime || cache.freeRuntime.edgeTts ? TOKEN.success : TOKEN.warn);
        row.appendChild(avail);
        var spacer = document.createElement("span");
        spacer.style.cssText = "flex:1 1 0;min-width:0";
        row.appendChild(spacer);
        var setBtn = document.createElement("button");
        setBtn.textContent = isCurrent ? "使用中" : "设为当前";
        setBtn.type = "button";
        setBtn.style.cssText = isCurrent ? btnMiniDisabled : btnMini;
        setBtn.disabled = isCurrent;
        setBtn.addEventListener("click", function () {
          // 立即持久化：免费音色的意义就是「装上就能用」，不该再逼用户点一遍
          // 「保存音色库」。这里只提交 selectedVoiceId，voices 原样不动。
          cache.selectedVoiceId = voice.id;
          renderVoiceRows();
          freePick(voice);
        });
        row.appendChild(setBtn);
        var auditionBtn = document.createElement("button");
        auditionBtn.textContent = "▶ 试听";
        auditionBtn.type = "button";
        auditionBtn.style.cssText = btnMini;
        auditionBtn.addEventListener("click", function () {
          freeAudition(voice, row);
        });
        row.appendChild(auditionBtn);
        rows.push(row);
      });
      // ---- 🔑 用户自己的音色库（克隆 / 预设，需要 Key） ----------------------
      rows.push(groupHeader("🔑 我的音色库 · 需要 Key（改完点下方「保存音色库」）"));
      if (cache.voices.length === 0) {
        rows.push(hintRow("（空）填自己的火山音色 ID，或到控制台「声音复刻」做一个 S_ 开头的克隆音色。"));
      }
      cache.voices.forEach(function (voice, i) {
        var status = cache.voicesStatuses[voice.id] || { kind: voice.kind, keyPresent: false, keyError: null };
        var isCurrent = voice.id === cache.selectedVoiceId;
        var inUse = voice.kind === "clone" && isCurrent;
        var kindLabel = voice.kind === "preset" ? "预设" : voice.kind === "free" ? "免费" : "克隆";
        // 徽标：主色底 + 前景字（原先写死的 #c9a86a/#6aa8c9 是深色主题专用色）。
        var kindColor = voice.kind === "preset" ? TOKEN.accent : TOKEN.success;
        var kindTextColor = voice.kind === "preset" ? TOKEN.accentText : TOKEN.accentText;
        var row = document.createElement("div");
        // 同免费行：一行放下、不换行、可收缩的只有文本列（用户 2026-10 反馈按钮被挤出卡片）。
        row.style.cssText = "display:flex;flex-wrap:nowrap;min-width:0;align-items:center;gap:6px;font-size:12px;padding:4px 0;border-bottom:1px solid " + TOKEN.borderSoft;
        // 左栏（固定节奏，与免费行对齐）：徽标 + 音色 ID + 可用状态
        var libLeft = document.createElement("span");
        libLeft.style.cssText = "display:flex;align-items:center;gap:6px;flex:0 0 auto;min-width:0";
        // 右栏（弹性）：备注框 + 设为当前 + 删除 —— 必须 append 到 row 才看得见
        var libRight = document.createElement("span");
        libRight.style.cssText = "display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0";
        var badge0 = document.createElement("span");
        badge0.textContent = kindLabel;
        badge0.style.cssText = "flex:0 0 34px;text-align:center;font-size:11px;border-radius:4px;padding:1px 4px;color:" + kindTextColor + ";background:" + kindColor;
        row.appendChild(badge0);
        var cur = document.createElement("span");
        cur.textContent = isCurrent ? "●当前" : "○";
        cur.id = "dva-voice-cur-" + i;
        cur.style.cssText = "flex:0 0 40px;font-size:11px;color:" + (isCurrent ? TOKEN.success : TOKEN.textTertiary);
        row.appendChild(cur);
        var idSpan = document.createElement("span");
        idSpan.textContent = voice.id;
        idSpan.title = voice.id;
        // 长 ID（如 zh_female_vv_uranus_bigtts）用省略号，不再用固定 220px 把按钮顶出去。
        idSpan.style.cssText = "flex:0 1 200px;min-width:0;font-family:Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:" + TOKEN.text;
        libLeft.appendChild(idSpan);
        var avail = document.createElement("span");
        avail.textContent = status.keyPresent ? "✓可用" : (status.keyError === "preset-key-missing" ? "缺ark-key" : "缺key");
        avail.id = "dva-voice-avail-" + i;
        // 同免费行：不可收缩列也必须 nowrap，否则「缺ark-key」折行把行撑高。
        avail.style.cssText = "flex:0 0 62px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:" + (status.keyPresent ? TOKEN.success : TOKEN.danger);
        libLeft.appendChild(avail);
        row.appendChild(libLeft);
        var noteInput = document.createElement("input");
        noteInput.type = "text";
        noteInput.value = voice.note || "";
        noteInput.placeholder = "备注";
        // min-width:0 是关键：原先 min-width:110px 让备注框成为「不可收缩」的硬底，
        // 窄面板下它拒绝让位，于是右侧三个按钮被推出卡片。
        noteInput.style.cssText = "flex:1 1 110px;min-width:0;background:" + TOKEN.bgInput + ";border:1px solid " + TOKEN.border + ";border-radius:6px;color:" + TOKEN.text + ";font-size:12px;padding:3px 6px;outline:none";
        noteInput.addEventListener("input", function () {
          voice.note = noteInput.value;
          cache.voicesDirty = true;
        });
        // 第十六轮：音色库行与免费行**同构两栏**（左栏固定 / 右栏弹性）。
        // 2026-10-26 修：libLeft/libRight 必须在行首创建、且 libRight 最后必须
        // append 到 row —— 原先 libRight 从未挂到 row 上，导致备注框、probe 输出、
        // **「删除」按钮**全是游离节点，用户实测「音色库没有删除按钮」。
        libRight.appendChild(noteInput);
        var setBtn = document.createElement("button");
        setBtn.textContent = isCurrent ? "使用中" : "设为当前";
        setBtn.type = "button";
        setBtn.style.cssText = isCurrent ? btnMiniDisabled : btnMini;
        setBtn.disabled = isCurrent;
        setBtn.addEventListener("click", function () {
          // BUG 修复（用户 2026-10-25）：「设为当前」原先只改 cache + voicesDirty，
          // **从不落盘**；而 generateAll() 的 saveSettings() 也不提交 selectedVoiceId，
          // 于是点「设为当前」再点生成，宿主用的还是旧音色（用户：「我原来得 api 得
          // 火山音色改成设为当前，再重新生成，还是原来得音色不是火山设置得音色」）。
          // 现在与免费音色 freePick 同口径：点完即存（只提交 selectedVoiceId）。
          cache.selectedVoiceId = voice.id;
          cache.voicesDirty = true;
          renderVoiceRows();
          setText("dva-voice-status", "正在切换到「" + (voice.note || voice.id) + "」…");
          request("/voices/save", {
            method: "POST",
            body: JSON.stringify({ selectedVoiceId: voice.id })
          }).then(function (res) {
            var data = res.json || {};
            if (res.status === 200 && data.ok) {
              cache.selectedVoiceId = data.selectedVoiceId || voice.id;
              cache.voices = data.list || cache.voices;
              cache.voicesStatuses = data.statuses || cache.voicesStatuses;
              cache.voicesDirty = false;
              renderVoiceRows();
              refreshGenerateGate();
              setText("dva-voice-status", "已切换为「" + (voice.note || voice.id) + "」。下一步点「🎙 生成语音」把三条播报换成这个声音。");
            } else {
              setText("dva-voice-status", "切换失败：" + String((data && data.reason) || ("HTTP " + res.status)));
            }
          }, function () {
            setText("dva-voice-status", "切换失败：宿主路由不可达");
          });
        });
        libRight.appendChild(setBtn);
        // 「试合」按钮已删（用户 2026-10-25：「不要再音色库中加入按钮再合…我直接
        // 在固定得那个统一得按钮合成就行了」）—— 统一走底部「🎙 生成语音」。
        var probeOut = document.createElement("span");
        probeOut.id = "dva-voice-probe-" + i;
        probeOut.style.cssText = "flex:0 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:" + TOKEN.textDim;
        libRight.appendChild(probeOut);
        var delBtn = document.createElement("button");
        delBtn.textContent = "删除";
        delBtn.type = "button";
        // 2026-10-26：删除按钮**任何行都可用**（原先「正在使用的克隆音色」被禁用，
        // 用户库里只有一个克隆音色时等于永远删不掉，又变成「没有删除按钮」）。
        // 删掉当前正在用的音色由宿主 /voices/save 的 D2 归位兜底：选择悬空就自动
        // 落到剩下的第一个音色（删空则置空），不会留下指向不存在 id 的悬空选择。
        delBtn.style.cssText = btnMini;
        delBtn.disabled = false;
        delBtn.title = inUse ? "当前正在使用；删除后会自动切到库里第一个音色" : "从音色库删除并立即写入 config.json";
        delBtn.addEventListener("click", function () {
          // 2026-10-26 用户要求「音色库要有删除按钮」。原先只改 cache + voicesDirty，
          // 必须再点一次「保存音色库」才落盘 —— 用户很容易以为删了其实没删（重载
          // 又回来）。现在与「设为当前」同口径：点完即存（POST /voices/save 全量库）。
          var removed = voice.note || voice.id;
          cache.voices = cache.voices.filter(function (v) { return v.id !== voice.id; });
          cache.voicesDirty = true;
          renderVoiceRows();
          setText("dva-voice-status", "正在删除「" + removed + "」…");
          request("/voices/save", {
            method: "POST",
            body: JSON.stringify({
              voices: cache.voices.filter(function (v) { return String(v.id || "").indexOf("free:") !== 0; }),
              selectedVoiceId: cache.selectedVoiceId
            })
          }).then(function (res) {
            var data = res.json || {};
            if (res.status === 200 && data.ok) {
              cache.voices = data.list || cache.voices;
              cache.voicesStatuses = data.statuses || cache.voicesStatuses;
              // 用 !== undefined 判：删的正好是当前音色、且库被删空时宿主会回
              // selectedVoiceId=""（合法值），用 || 会把已删的旧 id 又留回来。
              cache.selectedVoiceId = data.selectedVoiceId !== undefined ? data.selectedVoiceId : cache.selectedVoiceId;
              cache.voicesDirty = false;
              renderVoiceRows();
              renderPresetKeyState();
              refreshGenerateGate(data);
              setText("dva-voice-status", "已删除「" + removed + "」（已写入 config.json）");
            } else {
              setText("dva-voice-status", "删除失败：" + String((data && data.reason) || ("HTTP " + res.status)));
            }
          }, function () {
            setText("dva-voice-status", "删除失败：宿主路由不可达");
          });
        });
        libRight.appendChild(delBtn);
        row.appendChild(libRight);
        rows.push(row);
      });
      // rowsRendering：我们自己的写入不算「被 React 抹掉」，否则观察器会递归重画。
      cache.rowsRendering = true;
      try {
        box.replaceChildren.apply(box, rows);
      } finally {
        cache.rowsRendering = false;
      }
      // 每次重画后顺手确认观察器挂在这个容器上（React 重建容器后对象就换了）。
      watchRowsContainer();
    }

    /**
     * 音色库容器「防抹」观察器（2026-10-26，用户原话：「不要出现有时候不显示的
     * 音色库内容的情况」）。
     *
     * WHY 需要它：`renderVoiceRows()` 是命令式写 DOM，而 `#dva-voice-rows` 是
     * React 渲染出来的槽位。宿主重渲染时 React 会把这个 div 的 children 清空
     * （reconciliation 只认自己的 vdom，不认我们塞进去的行）。上一版靠
     * `SettingsSection` 里 setTimeout(0) 自愈 —— 但那是**下一帧**才补，中间那一帧
     * 界面上就是空的，用户看到的就是「有时候不显示」。
     *
     * 这里改成 MutationObserver：React 一清空，观察器回调**同步**在同一轮微任务里
     * 重画，肉眼看不到空档，也不发任何网络请求（纯内存重放 cache）。`rowsRendering`
     * 挡住自己 replaceChildren 触发的递归。
     */
    function watchRowsContainer() {
      var box = el("dva-voice-rows");
      if (!box || cache.rowsWatched === box) return;
      // 容器换了（React 重建）→ 旧观察器跟着旧节点一起作废，重新挂新的。
      if (cache.rowsObserver) {
        try { cache.rowsObserver.disconnect(); } catch (e) {}
        cache.rowsObserver = null;
      }
      cache.rowsWatched = box;
      var MO = null;
      try { MO = window.MutationObserver || (typeof MutationObserver === "function" ? MutationObserver : null); } catch (e) { MO = null; }
      if (!MO) return; // 老环境 / DOM stub：退回 setTimeout 自愈那条路
      try {
        cache.rowsObserver = new MO(function () { healVoiceRows(); });
        // 双目标观察：
        //  1) 容器自身 childList —— React 清空我们塞进去的行时补画；
        //  2) 容器的父节点 childList —— React 把整个槽位 div **换成新节点**时，
        //     旧观察器会跟着旧节点一起失效，只有盯住父节点才能在同一个微任务里
        //     发现「槽位被替换」，立刻把观察器挂到新节点上并补画（否则要等
        //     setTimeout(0) 下一帧，又是一帧空白）。
        cache.rowsObserver.observe(box, { childList: true });
        if (box.parentElement) cache.rowsObserver.observe(box.parentElement, { childList: true });
      } catch (e) {
        cache.rowsObserver = null;
      }
    }

    /**
     * 槽位「出生/重建」看门狗（2026-10-26，第二道保险）。
     *
     * WHY 还要它：上面那个观察器只能挂在**已存在的** `#dva-voice-rows` 上。可设置
     * 面板是 React 按需挂载的 —— 用户切走再切回来时，React 会先把整棵 section
     * 卸掉（槽位节点没了），再重新挂一棵新的（新的空 div）。这中间我们既没有槽位
     * 可观察、也没有任何回调被触发，只能等 `SettingsSection` 的 setTimeout(0) ——
     * 又是「下一帧才补」，就是用户说的「有时候不显示」。
     *
     * 做法：在 `document.body` 上挂一个 `childList + subtree` 的观察器（全插件只挂
     * 一个）。MutationObserver 天然按微任务批次回调，一批 DOM 变动只跑一次，成本
     * 就是一次 `getElementById` + 一次 `children.length` 判断。发现槽位存在但空、
     * 且 cache 里已有数据 → 立刻补画。
     */
    function ensureSlotGuard() {
      if (cache.slotGuard) return;
      var MO = null;
      try { MO = window.MutationObserver || (typeof MutationObserver === "function" ? MutationObserver : null); } catch (e) { MO = null; }
      if (!MO) return;
      var root = null;
      try { root = document.body || document.documentElement; } catch (e) { root = null; }
      if (!root) return;
      try {
        cache.slotGuard = new MO(function () { healVoiceRows(); });
        cache.slotGuard.observe(root, { childList: true, subtree: true });
      } catch (e) {
        cache.slotGuard = null;
      }
    }

    /**
     * 「槽位被抹掉就立刻补画」的唯一入口（观察器回调 + 自愈分支共用）。
     *
     * 只做三件事：重新按 id 找当前槽位（React 可能已经换成新节点）→ 槽位空了
     * 且 cache 里有数据才重画 → 重画会顺带 `watchRowsContainer()` 把观察器挂到
     * 新节点上。全程纯内存，不发网络请求。
     */
    function healVoiceRows() {
      if (cache.rowsRendering) return;
      var node = el("dva-voice-rows");
      if (!node) return;
      // 槽位换了新节点 → 观察器要跟过去（这一步纯本地，先做掉）。
      if (cache.rowsWatched !== node) watchRowsContainer();
      var empty = !node.children || node.children.length === 0;
      // 只有「被清空」才补画；我们自己写进去的行不触发。
      // 空 cache（首装还没读到）不补 —— 那时本来就该显示「读取中…」。
      if (!empty) return;
      if (cache.voices.length === 0 && cache.freeVoices.length === 0) return;
      renderVoiceRows();
    }

    /**
     * 免费音色「设为当前」：只提交 selectedVoiceId。
     * WHY 单独一条路：免费音色不在 voices 数组里，走 voiceSave() 会把整个库
     * 重新提交一遍（多此一举，还可能带上输入框里的备注改动）。这里最小化提交，
     * 用户自己的 key 音色与 Key 字段完全不经过这次请求。
     */
    function freePick(voice) {
      setText("dva-voice-status", "正在切换到免费音色「" + (voice.label || voice.id) + "」…");
      return request("/voices/save", {
        method: "POST",
        body: JSON.stringify({ selectedVoiceId: voice.id }),
      }).then(function (res) {
        var data = res.json || {};
        if (res.status === 200 && data.ok) {
          cache.selectedVoiceId = data.selectedVoiceId || voice.id;
          cache.voices = data.list || cache.voices;
          cache.voicesStatuses = data.statuses || cache.voicesStatuses;
          renderVoiceRows();
          // 选了免费音色，「生成语音」立刻可点（不需要任何 Key）—— 这是这次改动的
          // 核心体验，不刷一下按钮就还是灰的，用户会以为没生效。
          refreshGenerateGate();
          setText("dva-voice-status", "已切换为「" + (voice.label || voice.id) + "」。下一步点「🎙 生成语音」把三条播报换成这个声音。");
        } else {
          setText("dva-voice-status", "切换失败：" + String((data && data.reason) || "HTTP " + res.status));
        }
      });
    }

    /** 免费音色一键试听（宿主合成一句试音并播放；同音色第二次秒回缓存）。 */
    function freeAudition(voice, row) {
      var buttons = row ? row.querySelectorAll("button") : [];
      var btn = null;
      for (var i = 0; i < buttons.length; i += 1) {
        if (buttons[i].textContent && buttons[i].textContent.indexOf("试听") >= 0) btn = buttons[i];
      }
      if (btn) {
        btn.disabled = true;
        btn.textContent = "合成中…";
      }
      setText("dva-voice-status", "正在用「" + (voice.label || voice.id) + "」合成试听…（首次需要联网，几秒）");
      return request("/free/audition", { method: "POST", body: JSON.stringify({ speakerId: voice.id }) }).then(function (res) {
        var data = res.json || {};
        var ok = res.status === 200 && data.ok;
        if (btn) {
          btn.disabled = false;
          btn.textContent = ok ? "✓ 已播" : "▶ 试听";
        }
        if (ok) {
          // 合成成功就是 edge-tts 存在的硬证据：把探测缓存就地修正。
          // 否则按提示刚 `pip install edge-tts` 装完的用户，会一边听得到声音、
          // 一边看见徽标还写着「缺edge-tts」（探测结果有 TTL、客户端只在首屏拉一次），
          // 像插件没认出来，只能刷新页面——这个反差很容易被当成新 bug。
          if (cache.freeRuntime && !cache.freeRuntime.edgeTts) {
            cache.freeRuntime = { python: true, edgeTts: true };
            renderVoiceRows();
          }
          // 合成成功也代表「宿主这条链路是通的」，顺手重算一次生成按钮，
          // 免得用户刚验证完能合成、回头看「生成语音」还是灰的。
          refreshGenerateGate();
          setText(
            "dva-voice-status",
            "试听：" + (data.label || voice.id) + "（" + String(data.bytes) + " B" + (data.reused ? "，用缓存" : "，新合成") + "）。没听到声音？先确认系统音量与右上角总开关。"
          );
        } else if (data.muted) {
          setText("dva-voice-status", "已静音（音量 0），所以没出声——把音量拖上去再试听。");
        } else {
          setText(
            "dva-voice-status",
            "试听失败：" + String((data && (data.error || data.reason || data.hint)) || "HTTP " + res.status) +
              (data && data.reason === "edge-tts-not-installed" ? "（装一下：pip install edge-tts）" : "")
          );
        }
      });
    }

    function renderPresetKeyState() {
      setText(
        "dva-preset-key-state",
        cache.presetApiKeyPresent
          ? "已配置（" + cache.presetApiKeyMask + "）· 留空表示不修改"
          : "未配置（预设音色需 Agent Plan Key ark-…，可在下方填入）"
      );
    }

    function voiceProbe(voice, index) {
      var out = el("dva-voice-probe-" + index);
      if (out) out.textContent = "试合中…";
      return request("/voices/probe", { method: "POST", body: JSON.stringify({ speakerId: voice.id }) }).then(function (res) {
        var data = res.json || {};
        var node = el("dva-voice-probe-" + index);
        if (!node) return;
        var ok = res.status === 200 && data.ok;
        node.textContent = ok ? "✓ " + String(data.bytes) + "B" : "✗ " + String((data && (data.error || data.reason)) || ("HTTP " + res.status));
        node.style.color = ok ? TOKEN.success : TOKEN.danger;
        setText("dva-voice-status", ok ? "试合成功（" + voice.id + "）" : "试合失败：" + String((data && data.error) || ""));
      });
    }

    function voiceAdd() {
      var id = String(valueOf("dva-vadd-id", "") || "").trim();
      var note = String(valueOf("dva-vadd-note", "") || "").trim();
      if (!id) { setText("dva-voice-status", "请先填写音色 ID"); return; }
      if (cache.voices.some(function (v) { return v.id === id; })) { setText("dva-voice-status", "音色已存在：" + id); return; }
      cache.voices.push({ id: id, note: note, kind: id.indexOf("S_") === 0 ? "clone" : "preset", enabled: true });
      cache.voicesDirty = true;
      var idNode = el("dva-vadd-id"); if (idNode) idNode.value = "";
      var noteNode = el("dva-vadd-note"); if (noteNode) noteNode.value = "";
      renderVoiceRows();
      // 新增音色后「当前选中」可能随之变化（新增的若被自动设为当前），
      // 生成按钮的可用性要立刻重算一次，不能等下次加载设置。
      refreshGenerateGate();
      setText("dva-voice-status", "已添加「" + id + "」，记得点「保存音色库」");
    }

    function voiceImportExec() {
      var text = String(valueOf("dva-vimport-text", "") || "");
      if (!text.trim()) { setText("dva-voice-status", "粘贴内容为空"); return; }
      setText("dva-voice-status", "正在导入…");
      return request("/voices/import", { method: "POST", body: JSON.stringify({ text: text }) }).then(function (res) {
        var data = res.json || {};
        if (res.status === 200 && data.ok) {
          cache.voices = data.list || cache.voices;
          cache.voicesStatuses = data.statuses || {};
          cache.selectedVoiceId = data.selectedVoiceId || cache.selectedVoiceId;
          renderVoiceRows();
          // 导入可能带回新的 keyPresent / 选中音色，生成按钮要跟着重算。
          refreshGenerateGate(data);
          var area = el("dva-vimport-text"); if (area) area.value = "";
          setText("dva-voice-status", "导入完成：解析 " + String(data.parsed) + " 条，新增 " + String(data.added) + " 条，跳过重复 " + String(data.skipped) + " 条");
        } else {
          setText("dva-voice-status", "导入失败：" + String((data && data.reason) || ("HTTP " + res.status)));
        }
      });
    }

    function voiceSave() {
      setText("dva-voice-status", "正在保存音色库…");
      // 守卫（v0.4.15）：Key 输入框平时是空的（占位文案「留空表示不修改」），
      // 旧代码无条件把空串一起提交 → 每次保存音色库都会把已存 key 抹掉。
      // 现在留空时**根本不带这个字段**，宿主也就不会去动它。
      var presetKeyInput = String(valueOf("dva-preset-key", "") || "").trim();
      // 免费音色是服务端目录，绝不提交进 voices。**唯一闸门在宿主**
      // （config.js normalizeVoices → isVoicesLibraryId）；这里的前缀过滤只是顺手
      // 少发几个字节，不再充当规则——两处各写一套判据时曾经互相打架。
      var payload = {
        voices: cache.voices.filter(function (v) { return String(v.id || "").indexOf("free:") !== 0; }),
        selectedVoiceId: cache.selectedVoiceId
      };
      if (presetKeyInput.length > 0) payload.presetApiKey = presetKeyInput;
      return request("/voices/save", { method: "POST", body: JSON.stringify(payload) }).then(function (res) {
        var data = res.json || {};
        if (res.status === 200 && data.ok) {
          cache.voices = data.list || cache.voices;
          cache.voicesStatuses = data.statuses || {};
          cache.selectedVoiceId = data.selectedVoiceId || cache.selectedVoiceId;
          cache.presetApiKeyPresent = Boolean(data.presetApiKeyPresent);
          cache.presetApiKeyMask = String(data.presetApiKeyMask || "");
          cache.voicesDirty = false;
          // 保存成功后清空输入框：key 已进 config.json，输入框再留着反而是隐患。
          var keyBox = el("dva-preset-key");
          if (keyBox) keyBox.value = "";
          renderVoiceRows();
          renderPresetKeyState();
          // 保存成功后宿主回包带最新的 keyPresent —— 生成按钮必须按它重算。
          // 否则用户刚补完 Key 看到「已保存」，按钮却还是灰的（要等下次加载设置才亮）。
          refreshGenerateGate(data);
          setText("dva-voice-status", "音色库已保存（" + String(cache.voices.length) + " 个音色）" + (data.persisted && data.persisted.skipped ? "（仅内存）" : "（已写入 config.json）"));
        } else {
          setText("dva-voice-status", "保存失败：" + String((data && data.reason) || ("HTTP " + res.status)));
        }
      });
    }

    function loadVoices() {
      return request("/voices", { method: "GET", headers: {} }).then(function (res) {
        var data = res.json || {};
        if (!data.ok) return;
        cache.voices = data.list || [];
        cache.voicesStatuses = data.statuses || {};
        cache.selectedVoiceId = data.selectedVoiceId || "";
        cache.presetApiKeyPresent = Boolean(data.presetApiKeyPresent);
        cache.presetApiKeyMask = String(data.presetApiKeyMask || "");
        cache.freeVoices = Array.isArray(data.freeVoices) ? data.freeVoices : [];
        renderVoiceRows();
        renderPresetKeyState();
        // 探测只做一次：python/edge-tts 装没装在同一会话里基本不变，宿主虽然有
        // 30s TTL，但每次开面板仍要多一次请求 + 一轮音色库重渲染。已经有结论
        // 就直接用；真出问题时点试听会拿到准确错误，不该为此拖慢首屏。
        if (cache.freeRuntime === null) return loadFreeRuntime();
      });
    }

    /**
     * 免费音色可用性（python + edge-tts 是否装好）。宿主自己有 30s TTL 缓存，
     * 所以这里每次开面板都可以放心问一次；失败就当未知，不影响主流程。
     */
    function loadFreeRuntime() {
      return request("/free/runtime", { method: "GET", headers: {} }).then(function (res) {
        var data = res.json || {};
        if (!data.ok) return;
        cache.freeRuntime = { python: Boolean(data.python), edgeTts: Boolean(data.edgeTts) };
        renderVoiceRows();
      });
    }

    function toggleKeyVisibility() {
      var node = el("dva-tts-key");
      if (!node) return;
      var show = node.type === "password";
      node.type = show ? "text" : "password";
      var button = el("dva-key-toggle");
      if (button) button.textContent = show ? "隐藏" : "显示";
    }

    // ---- v0.4.9 主题自适应配色（浅色 / 深色背景都能看清） ----
    //
    // WHY (real bug, 2026-10-10): v0.3.2 起这里的颜色是**写死的深色主题色**——
    // 正文用 rgba(255,255,255,.xx) 的白字、标题 #e6edf3、次要文字 #8b93a8，
    // 容器底用 rgba(255,255,255,.xx) 的半透明白。深色背景下白字亮底正常，
    // **浅色背景下白字落在白底上 = 完全看不见**（用户报"浅色背景看不清"）。
    //
    // 修法不是"再来一套写死的浅色"，而是改用**宿主的设计令牌**（design token）：
    // DSH 的主题服务（@deepseek-ai/dsh-client-ui-theme）在浅/深两套调色板上
    // 重绑 --dsw-alias-* 变量（深色经 body[data-ds-dark-theme] 选择器切换，
    // 不是 .dark 类）。令牌随主题自动反转，插件只要引用变量即可两端都清楚，
    // 也不会在换肤 / 跟随系统时失配（生态规范：组合优先，不假设宿主实现）。
    //
    // 变量名取自本机安装目录实证（非记忆）：
    //   resources/app/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
    // TOKEN 表定义在文件上方（语音库那段之前）——cssText 字符串拼样式的地方
    // 也要用同一张表，故提前定义，避免出现两份互相漂移的色值。
    var FONT = '"Microsoft YaHei","微软雅黑",system-ui,-apple-system,"Segoe UI",sans-serif';
    var inputStyle = {
      flex: "1 1 200px",
      minWidth: "0",
      // maxWidth 防止在超宽面板里被拉得过长；boxSizing 保证内边距算进宽度，
      // 否则 border-box 之外的 padding 会把输入框顶出容器（窄面板溢出的经典成因）。
      maxWidth: "100%",
      boxSizing: "border-box",
      background: TOKEN.bgInput,
      border: "1px solid " + TOKEN.border,
      borderRadius: "8px",
      color: "inherit",
      fontFamily: "inherit",
      fontSize: "12.5px",
      lineHeight: "1.45",
      padding: "5px 8px",
      outline: "none"
    };
    // 数字框（语速/音调/音量）：固定小宽度，但仍可收缩，绝不撑破卡片。
    // 2026-10 用户要求「输入栏紧凑整齐一点，能一行就不要拐行」：84→72px 收窄。
    // 2026-10-25 用户第三次要求「改成一行」：72→64px、下限 48→40px ——
    // 因为「备注 + 语速 + 音调 + 音量」现在真的挤在同一行里，数字框必须让得出宽度。
    function numberInputStyle() {
      return Object.assign({}, inputStyle, {
        flex: "0 1 64px",
        minWidth: "40px",
        maxWidth: "76px",
        boxSizing: "border-box"
      });
    }
    var rowStyle = { display: "flex", alignItems: "center", gap: "8px", fontSize: "12.5px", lineHeight: "1.45" };
    // 会换行的行：窄面板里宁可折成两行，也不要横向溢出卡片。
    // WHY (用户反馈 2026-10-10)：这一行现在的宽度是
    // 3×标签(31.2) + 3×输入框(72) + 5×间距(8) = 349.6px，而 400px 设置面板的卡片内容宽
    // 约 368px —— 刚好放得下（余量 ≈18px，门限 ≈382px）。修之前是
    // 3×标签(60) + 3×输入框(88) + 5×间距(10) = 494px，且每个 flex 项都带 min-width
    // （锁住不可收缩），窄面板下**整行从卡片右边缘溢出**（第三个输入框跑到卡片外面）。
    // 修法：①整行允许换行 ②标签 min-width 收窄 ③输入框 min-width 收窄到 72px。
    var rowWrapStyle = Object.assign({}, rowStyle, { flexWrap: "wrap" });
    // 绝不换行的行：里面只有「标签 + 短输入框」这种一望即知、不需要折行的东西。
    // 窄面板下宁可让可收缩项（输入框）变窄，也不要折成第二行白占一行高度
    //（用户 2026-10-25 反馈「声音设置」卡：说明文字被挤到第二行，「这没必要拐行」）。
    var rowNowrapStyle = Object.assign({}, rowStyle, { flexWrap: "nowrap", minWidth: "0" });
    var fieldLabel = { flex: "0 0 auto", minWidth: "2.6em", color: TOKEN.textDim, fontSize: "12px" };
    // 更瘦的标签：「声音设置」卡要把四组标签 + 三个数字框塞进同一行，
    // 2.6em 的硬底太占地方，收到 1.8em（用户 2026-10-25 要求「改成一行」）。
    var fieldLabelTight = Object.assign({}, fieldLabel, { minWidth: "1.8em" });
    var cardStyle = {
      background: TOKEN.bgCard,
      border: "1px solid " + TOKEN.borderSoft,
      borderRadius: "12px",
      padding: "11px 13px",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      // 统一的轻投影：三张卡看起来是同一套卡片，而不是三块拼在一起的 div。
      boxShadow: TOKEN.shadow,
      // 卡片自己也要能被压缩：父级 flex 容器里默认 min-width:auto 会按
      // 内容最小宽度撑开，导致卡片连同内部控件一起溢出面板。
      minWidth: "0",
      boxSizing: "border-box",
      maxWidth: "100%"
    };
    // 总控卡：稍深一档的底 + 主色描边，一眼就是最显眼那张（不再靠"更亮的白"）。
    var cardPrimaryStyle = Object.assign({}, cardStyle, {
      background: TOKEN.bgCardSoft,
      border: "1px solid " + TOKEN.accent
    });
    // 卡片标题：13.5px（原 15px）。15px 是整页唯一跳出 11.5~12.5 一档的字号，
    // 三张卡一起用会显得「题目大、内容小」，也是用户说「字体太大太稀疏」的一部分。
    var cardTitle = { fontSize: "13.5px", fontWeight: 700, color: TOKEN.textStrong, letterSpacing: ".2px", lineHeight: "1.3" };
    var subText = { fontSize: "11.5px", color: TOKEN.textDim, lineHeight: "1.45" };
    // ---- 傻瓜化排版零件（用户 2026-10 要求：分区标题 + 一句话说明 + 动作分组）----
    // 卡片头：图标标题 + 右侧附加控件（总开关）同一行，可换行不溢出。
    // 2026-10-25 用户截图反馈「同理这个也弄成一行」：标题行也并入一条 nowrap 行。
    var cardHead = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "nowrap", minWidth: "0" };
    // 卡片标题下的一句话说明：比正文小一档、次要色，读起来像「副标题」。
    var cardDesc = { fontSize: "11.5px", color: TOKEN.textDim, lineHeight: "1.45" };
    // 卡片内部的二级分区标题（例如「三条播报文案」「音色与语速」）。
    var sectionTitle = { fontSize: "12.5px", fontWeight: 600, color: TOKEN.textStrong, display: "flex", alignItems: "center", gap: "5px", marginTop: "0" };
    // 分区之间的细分隔线（令牌色，不写死）。
    var dividerStyle = { height: "1px", background: TOKEN.borderSoft, margin: "0", border: "0" };
    // 动作组：试听 / 下载 / 导入 收进一个「胶囊」里，gap 一致、主次分明，
    // 不再是一排同级按钮平铺。flexShrink:0 保证这一组不被输入框挤变形。
    var actionGroup = {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      flexShrink: 0,
      flexWrap: "wrap",
      padding: "3px",
      borderRadius: "10px",
      background: TOKEN.bgCardSoft,
      border: "1px solid " + TOKEN.borderSoft,
      boxSizing: "border-box"
    };
    // 动作组里的小按钮（试听 / 下载 / 导入 共用同一档尺寸）。
    var actionBtn = {
      background: TOKEN.bgControl,
      border: "1px solid " + TOKEN.border,
      borderRadius: "7px",
      color: TOKEN.text,
      fontFamily: "inherit",
      fontSize: "11.5px",
      padding: "3px 8px",
      cursor: "pointer",
      whiteSpace: "nowrap"
    };
    // 每个事件一行的「小块」：事件名（带色点）+ 输入框 + 右侧动作组。
    var eventBlock = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      flexWrap: "wrap",
      padding: "6px 8px",
      borderRadius: "9px",
      background: TOKEN.bgInput,
      border: "1px solid " + TOKEN.borderSoft,
      minWidth: "0",
      boxSizing: "border-box",
      maxWidth: "100%"
    };
    // 事件名：色点 + 文字，一眼分清是「完成 / 失败 / 审批」哪一条。
    var eventName = {
      flex: "0 0 auto",
      display: "flex",
      alignItems: "center",
      gap: "5px",
      fontSize: "12.5px",
      fontWeight: 600,
      color: TOKEN.text,
      minWidth: "0"
    };
    /** 事件色点：完成=绿、失败=红、审批=主色（全部走 TOKEN，随主题反转）。 */
    function eventDotStyle(kind) {
      var color = kind === "complete" ? TOKEN.success : kind === "fail" ? TOKEN.danger : TOKEN.accent;
      return { width: "9px", height: "9px", borderRadius: "50%", background: color, flex: "0 0 auto", display: "inline-block" };
    }
    // 主按钮：大号、圆角、主色，带 hover/active 反馈（自测 DOM 无事件，反馈函数只服务真实浏览器）。
    var btnPrimary = {
      background: TOKEN.accent,
      border: "1px solid " + TOKEN.accent,
      borderRadius: "9px",
      color: TOKEN.accentText,
      fontFamily: "inherit",
      fontSize: "13px",
      fontWeight: 600,
      padding: "6px 15px",
      cursor: "pointer"
    };
    // 次按钮：中性底 + 描边，视觉上比主按钮安静一档。
    var btnSecondary = {
      background: TOKEN.bgControl,
      border: "1px solid " + TOKEN.border,
      borderRadius: "8px",
      color: TOKEN.text,
      fontFamily: "inherit",
      fontSize: "12.5px",
      padding: "6px 12px",
      cursor: "pointer"
    };
    var buttonStyle = btnSecondary; // 旧名字沿用为次级按钮（文案试听/显隐 Key/音色库操作等）
    // 紧凑主色按钮：给「▶ 试听」这类顶栏动作按钮用。
    // WHY（用户 2026-10 截图箭头）：原来用 btnPrimary（13px / 6px 15px padding），
    // 一个按钮就占了顶栏大半宽度、还把「音色：…」挤到下一行，看着又大又空。
    // 这里压到 11.5px / 3px 10px，高度和行内文字齐平，整行只占一行。
    var btnCompact = {
      background: TOKEN.accent,
      border: "1px solid " + TOKEN.accent,
      borderRadius: "7px",
      color: TOKEN.accentText,
      fontFamily: "inherit",
      fontSize: "11.5px",
      fontWeight: 600,
      padding: "3px 10px",
      lineHeight: "1.5",
      cursor: "pointer",
      flex: "0 0 auto",
      whiteSpace: "nowrap"
    };
    // hover / active 反馈：inline style 无法写伪类，用手势事件改背景色（仅在真实浏览器触发）。
    function hoverIn(e) { try { e.currentTarget.style.background = TOKEN.accentHover; } catch (err) {} }
    function hoverOut(e) { try { e.currentTarget.style.background = TOKEN.accent; } catch (err) {} }
    function pressIn(e) { try { e.currentTarget.style.background = TOKEN.accentHover; } catch (err) {} }
    function pressOut(e) { try { e.currentTarget.style.background = TOKEN.accent; } catch (err) {} }
    function hoverIn2(e) { try { e.currentTarget.style.background = TOKEN.bgControlHover; } catch (err) {} }
    function hoverOut2(e) { try { e.currentTarget.style.background = TOKEN.bgControl; } catch (err) {} }
    function pressIn2(e) { try { e.currentTarget.style.background = TOKEN.bgControlHover; } catch (err) {} }
    function pressOut2(e) { try { e.currentTarget.style.background = TOKEN.bgControl; } catch (err) {} }

    // ================= 悬浮提示（用户 2026-10 要求：说明文字改成悬浮展示） =================
    // 动机：常驻的说明段落把设置面板撑得很长，用户得一直往下滑。改成「小的 ⓘ / ❓ 图标，
    // 鼠标移上去才浮出气泡」，版面立刻清爽，信息也没丢（点一下也能展开，照顾触屏）。
    //
    // 实现要点（纯 CSS hover + 绝对定位，不依赖 React 状态）：
    //  · 外层 span 是 inline-flex + position:relative，作为气泡的定位锚点；
    //  · 气泡 position:absolute、宽度受限（min(260px, 78vw)），靠 z-index 浮在卡片之上；
    //  · 显隐交给 CSS 的 :hover / :focus-within —— inline style 写不了伪类，
    //    所以这里注入一次 <style> 规则（key 前缀 dva-tip 避免污染宿主样式）。
    var TIP_STYLE_ID = "dva-tip-style";
    function ensureTipStyle() {
      try {
        if (document.getElementById(TIP_STYLE_ID)) return;
        var css =
          ".dva-tip{position:relative;display:inline-flex;align-items:center;vertical-align:middle}" +
          ".dva-tip-bubble{position:absolute;top:calc(100% + 4px);left:0;z-index:60;" +
          "min-width:180px;max-width:min(300px,78vw);width:max-content;" +
          "background:" + TOKEN.bgSolid + ";color:" + TOKEN.text + ";" +
          "border:1px solid " + TOKEN.border + ";border-radius:8px;" +
          "padding:7px 9px;font-size:11.5px;line-height:1.5;text-align:left;font-weight:400;" +
          "box-shadow:" + TOKEN.shadowPop + ";white-space:normal;pointer-events:none;" +
          "opacity:0;visibility:hidden;transform:translateY(-2px);transition:opacity .12s ease,transform .12s ease}" +
          ".dva-tip:hover>.dva-tip-bubble,.dva-tip:focus-within>.dva-tip-bubble{opacity:1;visibility:visible;transform:translateY(0)}" +
          // 气泡贴着右边缘时改为右对齐展开，避免被卡片裁掉
          ".dva-tip-right .dva-tip-bubble{left:auto;right:0}" +
          ".dva-tip-icon{display:inline-flex;align-items:center;justify-content:center;" +
          "width:14px;height:14px;border-radius:50%;border:1px solid " + TOKEN.border + ";" +
          "color:" + TOKEN.textDim + ";font-size:9px;line-height:1;cursor:help;" +
          "user-select:none;flex:0 0 auto}" +
          ".dva-tip:hover .dva-tip-icon,.dva-tip:focus-within .dva-tip-icon{color:" + TOKEN.accent + ";border-color:" + TOKEN.accent + "}";
        var style = document.createElement("style");
        style.id = TIP_STYLE_ID;
        style.textContent = css;
        (document.head || document.body).appendChild(style);
      } catch (err) {}
    }

    // ---------- 气泡不出框：实测矩形 + 夹回可见区域（2026-10-26） ----------
    // 为什么必须用 JS：气泡是 position:absolute 挂在 ⓘ 上，CSS 无法得知祖先容器的
    // overflow 裁剪边界（宿主设置页的滚动容器就是 overflow:auto），也无法得知自己
    // 展开后到底有多宽。所以纯 CSS 的 left/right 对齐只能是「猜」——一旦图标贴着
    // 面板左边缘而气泡又向右展开，300px 宽的气泡就会顶出边界被裁掉，用户看到的就是
    // 「展开消息显示不完整 / 出框」。这里在浮出的瞬间测量真实矩形，按可用空间夹紧
    // 宽度、平移水平位置，必要时翻到锚点上方展开。
    var TIP_EDGE_PAD = 8;

    /** 收集锚点到根之间所有会裁剪的祖先（overflow 非 visible），求可见区域交集。 */
    function tipClipRect(wrap) {
      var rect = { left: 0, top: 0, right: 0, bottom: 0 };
      var hasWin = typeof window !== "undefined" && window && typeof window.innerWidth === "number";
      rect.right = hasWin ? window.innerWidth : 1024;
      rect.bottom = hasWin ? window.innerHeight : 768;
      try {
        var node = wrap && wrap.parentNode;
        while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
          var cs = window.getComputedStyle(node);
          var ox = cs ? cs.overflowX : "";
          var oy = cs ? cs.overflowY : "";
          if ((ox && ox !== "visible") || (oy && oy !== "visible")) {
            var r = node.getBoundingClientRect();
            if (ox && ox !== "visible") {
              if (r.left > rect.left) rect.left = r.left;
              if (r.right < rect.right) rect.right = r.right;
            }
            if (oy && oy !== "visible") {
              if (r.top > rect.top) rect.top = r.top;
              if (r.bottom < rect.bottom) rect.bottom = r.bottom;
            }
          }
          node = node.parentNode;
        }
      } catch (err) {}
      return rect;
    }

    /**
     * 把一个 .dva-tip 的气泡摆到「完整可见」的位置。
     * 返回实测结果（供自检与排错读），任何一步失败都返回 null 而不是抛错。
     */
    function placeTip(wrap) {
      if (!wrap || !wrap.querySelector) return null;
      var bubble = wrap.querySelector(".dva-tip-bubble");
      if (!bubble || !bubble.getBoundingClientRect) return null;
      try {
        var cr = tipClipRect(wrap);
        var avail = Math.max(140, cr.right - cr.left - TIP_EDGE_PAD * 2);
        // 宽度先夹紧：可用区域比 max-width 窄时，宁可窄一点也不能溢出去。
        bubble.style.maxWidth = Math.min(300, avail) + "px";
        bubble.style.minWidth = Math.min(180, avail) + "px";
        // 复位到默认锚点再测量（上一次夹紧的结果不能参与这次计算）。
        bubble.style.left = "0px";
        bubble.style.right = "auto";
        bubble.style.top = "calc(100% + 4px)";
        bubble.style.bottom = "auto";
        var wr = wrap.getBoundingClientRect();
        var br = bubble.getBoundingClientRect();
        var left = wr.left;
        if (left + br.width > cr.right - TIP_EDGE_PAD) left = cr.right - TIP_EDGE_PAD - br.width;
        if (left < cr.left + TIP_EDGE_PAD) left = cr.left + TIP_EDGE_PAD;
        bubble.style.left = Math.round(left - wr.left) + "px";
        bubble.style.right = "auto";
        // 垂直：优先下方；下方放不下而上方更宽裕时翻到上方。
        var below = cr.bottom - wr.bottom;
        var above = wr.top - cr.top;
        var flipped = false;
        if (br.height + 6 > below && above > below) {
          bubble.style.top = "auto";
          bubble.style.bottom = "calc(100% + 4px)";
          flipped = true;
        }
        var out = {
          left: Math.round(left),
          top: Math.round(flipped ? wr.top - br.height - 4 : wr.bottom + 4),
          width: Math.round(br.width),
          height: Math.round(br.height),
          clip: { left: Math.round(cr.left), right: Math.round(cr.right), top: Math.round(cr.top), bottom: Math.round(cr.bottom) },
          flipped: flipped
        };
        out.inside = out.left >= out.clip.left && out.left + out.width <= out.clip.right;
        return out;
      } catch (err) {
        return null;
      }
    }

    /** 委托监听只挂一次：hover / 聚焦浮出时定位，滚动与缩放时重算。 */
    function ensureTipPlacement() {
      if (cache.tipPlacement) return;
      if (typeof document === "undefined" || !document.addEventListener) return;
      var wrapOf = function (target) {
        if (!target || !target.closest) return null;
        return target.closest(".dva-tip");
      };
      var onShow = function (ev) {
        var wrap = wrapOf(ev.target);
        if (!wrap) return;
        cache.tipActive = wrap;
        placeTip(wrap);
      };
      var onHide = function (ev) {
        var wrap = wrapOf(ev.target);
        if (!wrap || wrap !== cache.tipActive) return;
        var to = ev.relatedTarget;
        if (to && wrap.contains && wrap.contains(to)) return;
        cache.tipActive = null;
      };
      var onReflow = function () {
        if (cache.tipActive) placeTip(cache.tipActive);
      };
      document.addEventListener("mouseover", onShow, true);
      document.addEventListener("mouseout", onHide, true);
      document.addEventListener("focusin", onShow, true);
      document.addEventListener("focusout", onHide, true);
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("scroll", onReflow, true);
        window.addEventListener("resize", onReflow, false);
      }
      cache.tipPlacement = { onShow: onShow, onHide: onHide, onReflow: onReflow };
    }

    /**
     * 悬浮提示：一个小的 ⓘ，hover / 聚焦时浮出说明气泡。
     * @param {string} text  气泡内容（纯文本，不解析 HTML）
     * @param {object} opts  { icon: "ⓘ"|"❓"|"⏱", align: "left"|"right", key, id }
     * 注意：不改 DOM 结构顺序、不占正常文档流高度 —— 这是「省空间」的关键。
     */
    function tip(text, opts) {
      var o = opts || {};
      var wrapClass = "dva-tip" + (o.align === "right" ? " dva-tip-right" : "");
      // o.node：气泡内容给成 React 节点。用于「文字由 JS 写入、id 必须保留」的说明
      //（#dva-alert-mode-hint / #dva-voice-note-policy 这类）—— 给 node 时 id 挂在气泡
      // 内部的节点上，不再挂到 ⓘ 图标上；否则 setText 写的是图标、气泡内容永不更新。
      var hasNode = o.node !== undefined;
      return React.createElement(
        "span",
        { key: o.key, className: wrapClass, style: { marginLeft: "4px" } },
        React.createElement(
          "span",
          {
            className: "dva-tip-icon",
            id: hasNode ? undefined : o.id,
            tabIndex: 0,
            role: "note",
            "aria-label": String(o.label || text || "")
          },
          o.icon || "ⓘ"
        ),
        React.createElement("span", { className: "dva-tip-bubble", role: "tooltip" }, hasNode ? o.node : text)
      );
    }


    // ================= v0.3.3 提醒方式（语音 / 音效 / 关闭） =================
    // 傻瓜化：一个「提醒方式」三选按钮，选音效时展开三个下拉 + 试听，其余全部默认
    // 给好（完成=成功号角、失败=木鱼、审批=叮咚）。音效模式完全不调用 TTS。
    function modeBtnStyle(active) {
      return {
        background: active ? TOKEN.accent : TOKEN.bgControl,
        border: "1px solid " + (active ? TOKEN.accent : TOKEN.border),
        borderRadius: "8px",
        color: active ? TOKEN.accentText : TOKEN.text,
        fontFamily: "inherit",
        fontSize: "12.5px",
        fontWeight: active ? 600 : 400,
        padding: "6px 13px",
        cursor: "pointer"
      };
    }
    var sfxPanelStyle = {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      borderTop: "1px solid " + TOKEN.borderSoft,
      paddingTop: "7px",
      marginTop: "0"
    };
    var MODE_LABELS = { voice: "🗣 语音播报", sfx: "🎵 音效", off: "🔕 关闭" };
    var MODE_HINTS = {
      voice: "语音模式：用你自己的音色朗读三条文案。",
      sfx: "音效模式：播放内置音效，不调用 TTS、不需要 API Key。",
      off: "关闭：完成 / 失败 / 审批都不提醒。"
    };
    var SFX_GROUP_LABEL = { "提醒": "🔔 提醒音", "大自然": "🌿 大自然" };
    var sfxGroupStyle = { fontSize: "11.5px", fontWeight: 600, color: TOKEN.textDim, marginTop: "1px" };
    // 与音色库行**同源病根**（独立复核指出）：容器不换行 + 曲名不可收缩 + 按钮可折行，
    // 窄面板下按钮会被挤出卡片、文字被压成竖排。当前实测约 226~245px 还不发作，
    // 但门限只有 ≈240px，这里按同一套不变量先加固：容器 nowrap + minWidth:0、
    // 曲名改成可收缩到省略号、按钮不缩不折（与 btnMini 口径一致）。
    var sfxRowStyle = { display: "flex", alignItems: "center", flexWrap: "nowrap", minWidth: 0, gap: "8px", fontSize: "11.5px", lineHeight: "1.35", padding: "1px 0" };
    var sfxNameStyle = { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: TOKEN.text };
    var sfxCheckLabel = { display: "flex", alignItems: "center", gap: "2px", color: TOKEN.textDim, fontSize: "11px", cursor: "pointer" };
    var sfxBtnMini = {
      background: TOKEN.bgControl,
      border: "1px solid " + TOKEN.border,
      borderRadius: "6px",
      color: TOKEN.text,
      fontFamily: "inherit",
      fontSize: "11px",
      padding: "2px 8px",
      flex: "0 0 auto",
      whiteSpace: "nowrap",
      cursor: "pointer"
    };

    /** JS 样式对象 -> 逐属性写入 DOM（不用 cssText：自测的 DOM stub 只认属性名）。 */
    function applyStyle(node, style) {
      if (!node || !style) return;
      for (var key in style) {
        if (!Object.prototype.hasOwnProperty.call(style, key)) continue;
        try {
          node.style[key] = style[key];
        } catch (e) {}
      }
    }

    /**
     * 应用提醒方式：三个按钮的选中态 + 音效面板显隐 + 提示语。
     * 纯 DOM 操作，不触发 React 重渲染（否则正在输入的文案/Key 会被重置）。
     */
    function applyAlertMode(mode) {
      var wanted = mode === "sfx" || mode === "off" ? mode : "voice";
      cache.alertMode = wanted;
      ["voice", "sfx", "off"].forEach(function (key) {
        var node = el("dva-alert-mode-" + key);
        if (node) applyStyle(node, modeBtnStyle(wanted === key));
      });
      var panel = el("dva-sfx-panel");
      if (panel) panel.style.display = wanted === "sfx" ? "flex" : "none";
      setText("dva-alert-mode-hint", MODE_HINTS[wanted]);
      // 第十四轮：两条行预渲染了两套（语音套 / 音效套），这里用纯 DOM 翻转 display，
      // **零 React 重渲染** —— 切模式即时生效（用户：来回切换界面不能及时切过来）。
      KINDS.forEach(function (kind) {
        var vRow = el("dva-row-voice-" + kind);
        var sRow = el("dva-row-sfx-" + kind);
        if (vRow) vRow.style.display = wanted === "sfx" ? "none" : "flex";
        if (sRow) sRow.style.display = wanted === "sfx" ? "flex" : "none";
      });
      // 反馈行也跟着模式显隐（语音模式下不需要音效提示）
      var noteRow = el("dva-sfx-note");
      if (noteRow && noteRow.parentNode) noteRow.parentNode.style.display = wanted === "sfx" ? "block" : "none";
    }

    /** 当前生效的音效清单：宿主目录优先，未载入时用内置兜底（列表第一帧就要有内容）。 */
    function sfxList() {
      return cache.sfxCatalog && cache.sfxCatalog.length ? cache.sfxCatalog : SFX_FALLBACK;
    }

    /** 音效 key -> 显示名（找不到就原样显示 key）。 */
    function sfxNameOf(key) {
      var list = sfxList();
      for (var i = 0; i < list.length; i++) {
        if (list[i].key === key) return list[i].name;
      }
      return String(key || "（未设置）");
    }

    /** 刷新一个事件的「当前音效」文字 + 隐藏值载体（保存时读它）。 */
    function syncSfxKind(kind) {
      var key = (cache.sfxByKind && cache.sfxByKind[kind]) || "";
      setText("dva-sfx-current-" + kind, "当前：" + sfxNameOf(key));
      var hidden = el("dva-sfx-" + kind);
      if (hidden) hidden.value = key;
    }

    /**
     * 勾选：把某个事件设为某个音效（同一事件只保留一个）。
     *
     * 点完即存 —— 与总开关 / 提醒方式按钮统一口径。旧版只改 cache + DOM 不发 POST，
     * 用户换完音效没点「保存设置」时宿主仍是旧音效，回合结束听到的还是老声音；
     * 更隐蔽的是此后任何一次 persistPatch 都会用服务端回包把勾选静默退回旧值。
     */
    function setSfxFor(kind, key) {
      var before = snapshotState();
      if (!cache.sfxByKind) cache.sfxByKind = {};
      cache.sfxByKind[kind] = key;
      // 下拉形态：直接把 select 的值对齐（旧版是刷 20 个单选框）
      var sel = el("dva-sfxselect-" + kind);
      if (sel && sel.value !== key) sel.value = key;
      syncSfxKind(kind);
      setText("dva-status", "正在切换" + LABELS[kind] + "的提醒音…");
      var patch = { sfxByKind: {} };
      patch.sfxByKind[kind] = key;
      // 提示句式与「切换提醒方式」保持一致；且显示在音效面板内部（用户 2026-10-25
      // 第八轮反馈：「提醒应该显示在上方在这个第二个图得上访显示」—— 操作发生在
      // 音效面板，反馈就该贴着它出现，而不是滚去卡片顶部的状态栏）。
      // persistPatch 的 okMessage 仍作为兜底写状态栏；面板内由 onOk 回调写 #dva-sfx-note。
      persistPatch(patch, "已切换为「" + sfxNameOf(key) + "」的提醒音（立即生效）", before);
    }

    /** 回显：把三个事件的勾选状态与汇总文字刷成 config 里的值。 */
    function applySfxSelection() {
      KINDS.forEach(function (kind) {
        var key = (cache.sfxByKind && cache.sfxByKind[kind]) || "";
        var sel = el("dva-sfxselect-" + kind);
        if (sel && sel.value !== key) sel.value = key;
        syncSfxKind(kind);
      });
    }

    /** 试听一个音效（按 key；不经过引擎，绝不会影响完成/失败的判定）。 */
    function previewSfxKey(key) {
      if (!key) return;
      setText("dva-status", "正在试听音效：" + sfxNameOf(key) + "…");
      return request("/sfx/play?name=" + encodeURIComponent(key), { method: "GET", headers: {} }).then(
        function (res) {
          var data = res.json || {};
          setText(
            "dva-status",
            data.ok
              ? "▶ 正在播放：" + sfxNameOf(key) + "（若没声音请再点一次，或检查系统音量）"
              : data.muted
                ? "已静音（音量设为 0）：音效不会出声"
                // alertMode=off 是「你自己关的」，不是故障。
                : String(data.reason || "").indexOf("alertMode=off") >= 0
                  ? "提醒方式当前是「关闭」，试听不会出声。要听就先把提醒方式改成「语音」或「音效」。"
                  : "试听失败：" + String(data.reason || res.status)
          );
        },
        function () {
          setText("dva-status", "试听失败：宿主路由不可达");
        }
      );
    }

    /** 读取音效目录与当前选择（/sfx/list 是权威清单，settings 只是顺带）。 */
    function loadSfxCatalog() {
      return request("/sfx/list", { method: "GET", headers: {} }).then(
        function (res) {
          var data = res.json || {};
          if (!data.ok) return;
          cache.sfxCatalog = data.items || [];
          cache.sfxByKind = Object.assign({}, cache.sfxByKind, data.sfxByKind || {});
          // 目录到手后刷新「当前音效」汇总 + 勾选状态（列表本身由 React 直接渲染，
          // 不再用 DOM 追加 option——那会被 React 重渲染清空，正是"选了没反应"的根因）。
          applySfxSelection();
          // 第十七轮：「共 20 个内置音效…」文字按用户要求删除，不再显示。
        },
        function () {
          /* 目录读取失败：列表仍可显示内置默认名字，保存时沿用已有选择 */
        }
      );
    }

    /**
     * 一条播报（kind）右侧的动作组：▶ 试听 / ⬇ 下载 / ⬆ 导入（或 ⬆ 换一个）。
     * 该 kind 已经换成用户自己导入的 mp3 时（cache.imported[kind] === true），
     * 额外渲染「↩ 撤销导入」；未导入时不渲染，界面保持干净。
     */
    function buildActionGroup(kind) {
      var imported = Boolean(cache.imported && cache.imported[kind]);
      var children = [
        React.createElement(
          "button",
          {
            key: "preview",
            id: "dva-preview-" + kind,
            type: "button",
            style: actionBtn,
            title: "听一下这条播报（按当前提醒方式播放：语音模式放人声，音效模式放音效）",
            // 试听必须和真实提醒一致：音效模式下这里不能放人声，否则用户会认为
            // 「选了音效还在响人声」（2026-10 反馈）。分流规则与大按钮一致。
            onClick: function () {
              if ((cache.alertMode || "voice") === "sfx") {
                previewSfxKey((cache.sfxByKind || {})[kind] || "remind-tada");
              } else {
                preview(kind);
              }
            },
            onMouseEnter: hoverIn2,
            onMouseLeave: hoverOut2,
            onMouseDown: pressIn2,
            onMouseUp: pressOut2
          },
          "▶ 试听"
        ),
        React.createElement(
          "button",
          {
            key: "download",
            id: "dva-download-" + kind,
            type: "button",
            style: actionBtn,
            title: (cache.alertMode || "voice") === "sfx" ? "导出「" + LABELS[kind] + "」当前选中的提示音 mp3" : "把这条播报存成 mp3 文件",
            onClick: function () {
              if ((cache.alertMode || "voice") === "sfx") {
                // 音效模式：导出该分类**当前选中**的提示音 mp3
                //（语音模式的下载 = 这条播报的人声 mp3，键在同一个位置，语义跟模式走）
                downloadSfx((cache.sfxByKind || {})[kind]);
              } else {
                downloadMp3(kind);
              }
            },
            onMouseEnter: hoverIn2, onMouseLeave: hoverOut2
          },
          (cache.alertMode || "voice") === "sfx" ? "⬇ 导出" : "⬇ 下载"
        ),
        React.createElement(
          "button",
          {
            key: "import",
            id: "dva-import-" + kind,
            type: "button",
            style: actionBtn,
            title: imported ? "用另一个 mp3 替换这条播报" : "用你自己的 mp3 替换这条播报",
            onClick: function () {
              if ((cache.alertMode || "voice") === "sfx") {
                // 音效模式：用一个本地 mp3 换该分类当前选中的提示音
                importSfx((cache.sfxByKind || {})[kind], kind);
              } else {
                importMp3(kind);
              }
            },
            onMouseEnter: hoverIn2,
            onMouseLeave: hoverOut2
          },
          imported ? "⬆ 换一个" : "⬆ 导入"
        )
      ];
      if (imported) {
        children.push(
          React.createElement(
            "button",
            { key: "undo", id: "dva-undo-" + kind, type: "button", style: actionBtn, title: "恢复成自动生成的语音", onClick: function () { undoImport(kind); }, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 },
            "↩ 撤销导入"
          )
        );
      }
      return React.createElement("div", { key: "actions-" + kind, id: "dva-actions-" + kind, style: actionGroup }, children);
    }

    /**
     * 导入 / 撤销之后就地刷新一条播报的动作组（不重渲染整棵 React 树，
     * 否则用户正在输入的文案、Key 会被重置）。
     * 只做两件事：改「⬆ 导入 / ⬆ 换一个」的文案与 title，增删「↩ 撤销导入」。
     * 自测的 DOM stub 里 createElement 出来的节点没有 addEventListener，
     * 因此每一步都做能力判断，缺能力就静默跳过（渲染时的那份才是真相）。
     */
    function refreshActionGroup(kind) {
      var imported = Boolean(cache.imported && cache.imported[kind]);
      var importBtn = el("dva-import-" + kind);
      if (importBtn) {
        importBtn.textContent = imported ? "⬆ 换一个" : "⬆ 导入";
        importBtn.title = imported ? "用另一个 mp3 替换这条播报" : "用你自己的 mp3 替换这条播报";
      }
      var box = el("dva-actions-" + kind);
      if (!box) return;
      var existing = el("dva-undo-" + kind);
      if (imported) {
        if (existing) return;
        var btn = null;
        try {
          btn = document.createElement("button");
        } catch (e) {
          return;
        }
        if (!btn) return;
        btn.id = "dva-undo-" + kind;
        btn.type = "button";
        btn.textContent = "↩ 撤销导入";
        btn.title = "恢复成自动生成的语音";
        try {
          applyStyle(btn, actionBtn);
        } catch (e2) {}
        try {
          if (typeof btn.addEventListener === "function") {
            btn.addEventListener("click", function () {
              undoImport(kind);
            });
            if (typeof hoverIn2 === "object") {
              btn.addEventListener("mouseenter", function () {
                applyStyle(btn, hoverIn2);
              });
              btn.addEventListener("mouseleave", function () {
                applyStyle(btn, actionBtn);
              });
            }
          }
        } catch (e3) {}
        try {
          if (typeof box.appendChild === "function") box.appendChild(btn);
        } catch (e4) {}
        return;
      }
      // 未导入：撤销按钮不该存在，有就摘掉。
      if (existing) {
        var removed = false;
        try {
          if (existing.parentNode && typeof existing.parentNode.removeChild === "function") {
            existing.parentNode.removeChild(existing);
            removed = true;
          }
        } catch (e5) {}
        // 摘不掉（DOM stub / 非 React 容器）时退化成隐藏，保证用户看不到旧按钮。
        if (!removed) {
          try {
            existing.style.display = "none";
          } catch (e6) {}
        }
      }
    }

    /** 三条播报的动作组一起刷新（loadSettings / 撤销之后调用）。 */
    function refreshAllActionGroups() {
      KINDS.forEach(function (kind) {
        try {
          refreshActionGroup(kind);
        } catch (e) {}
      });
    }

    // ================= v0.3.2 傻瓜化设置页 =================
    // 布局：总控大卡（开关 + 试听 + 状态）→ 常用设置卡 →「高级设置」折叠卡。
    // 折叠只影响可见性，全部元素仍渲染进 DOM（自测依赖的 ID 一个不少）。
    function SettingsSection() {
      if (!React) return null;
      // 悬浮提示的样式规则只注入一次（inline style 写不了 :hover 伪类）。
      // 放在渲染入口而不是模块顶层：模块可能先于 document 就绪被 import。
      ensureTipStyle();
      ensureTipPlacement();
      // 槽位看门狗也在这里兜一次：section 每次挂载都会走这里，哪怕这次是首装
      // （cache 还没数据），观察器也能就位，等数据回来/槽位重建时立刻补画。
      ensureSlotGuard();
      // First render kicks the initial load (no hooks available, so results are
      // written back into the DOM by id).
      try {
        if (!cache.loaded && !cache.loading) {
          loadSettings();
        } else if (cache.loaded) {
          // 重挂载自愈：这个 section 是 React 槽位，宿主随时可能整棵重渲染（切页签、
          // 其他插件注册/刷新）。React 只认自己的 vdom —— 重渲染会把 #dva-voice-rows
          // 等容器重建成空 div，renderVoiceRows 塞进去的行、以及所有 setText 写过的
          // 文案（系统音量 / 预设 Key 状态）全部回到 JSX 初值「读取中…」；而
          // loadSettings 又被 cache.loaded 挡住不再跑 —— 界面就停在「读取中…」+
          // 空音色库（2026-10-26 用户实测：音色库每次重载都消失）。
          //
          // 关键：**只在真的被抹掉时才重放**。React 的 commit 在本函数返回之后，所以
          // 这里用 setTimeout(0) 等一帧再判定：容器空了 / 音量行还停在「读取中…」才算
          // 被抹。没被抹就什么都不做 —— 否则每次重渲染都重放 loadSettings，会把用户
          // 正在输入的音色备注冲掉。再叠 1.5s 节流，避免宿主频繁重渲染打成路由风暴。
          setTimeout(function () {
            try {
              // React 已 commit 完 → 容器可能换成了新节点，观察器要跟着换（防抹
              // 的第一道闸）。这一步不联网、纯重画，比下面的 loadSettings 快得多。
              watchRowsContainer();
              var box = el("dva-voice-rows");
              var rowsWiped = !box || (box.children && box.children.length === 0);
              var volNode = el("dva-volume");
              var volWiped = Boolean(volNode) && String(volNode.textContent || "").indexOf("读取中") >= 0;
              if (!rowsWiped && !volWiped) return;
              // 容器空但 cache 里还有数据 → 直接重画，不用再走一趟网络。
              if (rowsWiped && (cache.voices.length > 0 || cache.freeVoices.length > 0)) {
                renderVoiceRows();
              }
              if (!volWiped && !rowsWiped) return;
              var now = Date.now();
              if (!cache.lastSelfHealAt || now - cache.lastSelfHealAt > 1500) {
                cache.lastSelfHealAt = now;
                loadSettings();
              }
              try { refreshAllActionGroups(); } catch (e3) {}
            } catch (e2) {}
          }, 0);
        }
      } catch (e) {}

      var rows = [];

      // ---- 卡片 1：语音播报总控（最显眼） ----
      rows.push(
        React.createElement(
          "div",
          { key: "card-main", style: cardPrimaryStyle },
          React.createElement(
            "div",
            { style: cardHead },
            // 标题里直接内联当前状态（启用/已禁用），用户不用去猜勾选框到底生效没。
            React.createElement(
              "span",
              { style: Object.assign({}, cardTitle, { display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }) },
              "🔔 播报开关",
              React.createElement(
                "span",
                {
                  id: "dva-enabled-state",
                  style: {
                    fontSize: "11px",
                    fontWeight: 600,
                    lineHeight: 1.2,
                    padding: "1px 6px",
                    borderRadius: "8px",
                    color: cache.enabled !== false ? TOKEN.success : TOKEN.textDim,
                    background: TOKEN.bgCard,
                    border: "1px solid " + (cache.enabled !== false ? TOKEN.success : TOKEN.border)
                  }
                },
                cache.enabled !== false ? "已启用" : "已禁用"
              )
            ),
            // 卡片用途说明改为悬浮（用户 2026-10：说明文字改成悬浮展示）。
            // 原先是紧跟在标题下面的常驻一行，现在收进这个小 ⓘ 里。
            tip("平时保持勾选即可；想安静一会儿，取消右上角「总开关」。", {
              key: "tip-main",
              id: "dva-card-main-desc",
              icon: "ⓘ"
            }),
            React.createElement(
              "label",
              { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px", color: TOKEN.text, cursor: "pointer", fontWeight: 600 } },
              React.createElement("input", {
                id: "dva-enabled",
                type: "checkbox",
                // 受控复选框必须带 onChange，否则 React 会把用户点击立刻回写，
                // 表现就是「总开关点不动」（2026-10 用户反馈的根因）。
                checked: cache.enabled !== false,
                onChange: function (ev) {
                  var wanted = Boolean(ev && ev.target && ev.target.checked);
                  // 先拍下改动前的状态（失败回滚要用），再改本地态让界面立刻响应。
                  var before = snapshotState();
                  cache.enabled = wanted;
                  setText("dva-status", wanted ? "正在开启播报…" : "正在关闭播报…");
                  persistPatch(
                    { enabled: wanted },
                    wanted ? "已开启播报（立即生效）" : "已关闭播报（立即生效）",
                    before
                  );
                }
              }),
              "总开关"
            )
          ),
          // ── 顶栏 + 提醒方式合成一行 ──
          // WHY（用户 2026-10-25 截图三支红箭头 + 原话「同理这个也弄成一行」）：
          // 上一版这里还是三段：标题行 / 试听+音色 / 「怎么提醒你」+提醒方式三按钮，
          // 每段各占一行。现在合成一个 nowrap 行。
          // 音色信息 span 仍是 flex:1 1 auto + min-width:0 —— 它是这行的缓冲垫，
          // 窄面板下第一个让位（收缩后显示省略号），保证按钮永远完整可点。
          // 整行兜底 flexWrap:"wrap"：只有面板窄到 < 约 560px 才会触发换行，
          // 因为三按钮自身宽 ≈184px + 标题/徽标 ≈174px + 试听 ≈80px 的固定合计
          // 已经贴着 400px 面板的内容宽 —— 那时宁可折行也不许把「关闭」按钮
          // 截到卡片外（用户点不到关闭比拐行严重得多）。
          React.createElement(
            "div",
            { key: "main-top", style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", minWidth: "0" } },
            React.createElement(
              "button",
              {
                id: "dva-big-preview",
                type: "button",
                style: btnCompact,
                onClick: function () { if ((cache.alertMode || "voice") === "sfx") { previewSfxKey((cache.sfxByKind || {}).complete || "remind-tada"); } else { preview("complete"); } },
                onMouseEnter: hoverIn,
                onMouseLeave: hoverOut,
                onMouseDown: pressIn,
                onMouseUp: pressOut
              },
              "▶ 试听"
            ),
            // 没声音怎么办 —— 原来是一整行常驻橙字，现在缩成一个 ❓ 悬浮气泡。
            // 内容一字不删（用户 2026-09-16 要求把这句写进界面），只是不再占版面。
            tip("试听没声音？先把系统音量拖一下再点（蓝牙耳机 / 虚拟声卡空闲挂起时会吞掉第一次播放）。", {
              key: "tip-audio",
              id: "dva-audio-tip",
              icon: "🔈",
              align: "right"
            }),
            // ---- 提醒方式：语音 / 音效 / 关闭（三选一，选中态高亮）----
            React.createElement("span", { style: fieldLabel, title: "怎么提醒你：选「语音」念文案，「音效」放提示音，「关闭」完全静默" }, "提醒方式"),
            // 模式说明改为悬浮（用户 2026-10）：这个 ⓘ 的气泡里嵌的就是
            // #dva-alert-mode-hint 节点本身 —— applyAlertMode/切换模式写它的文字，
            // 气泡内容随之更新，一行常驻文字因此省掉。
            React.createElement(
              "span",
              { className: "dva-tip", style: { marginLeft: "-4px" } },
              React.createElement(
                "span",
                { className: "dva-tip-icon", tabIndex: 0, role: "note", "aria-label": "提醒方式说明" },
                "ⓘ"
              ),
              React.createElement(
                "span",
                { className: "dva-tip-bubble", role: "tooltip" },
                React.createElement("span", { id: "dva-alert-mode-hint" }, MODE_HINTS[cache.alertMode || "voice"])
              )
            ),
            // 「当前音色」已移到状态条区域（第十四轮：读取慢时占着顶栏一行很卡，
            // 且长名字把行撑宽 —— 用户：「把这个读取音色，音色显示状态这个放到，
            // 正在读取设置的旁边，弄成两个区域」）。顶栏回归窄行。
            ["voice", "sfx", "off"].map(function (mode) {
              return React.createElement(
                "button",
                {
                  key: mode,
                  id: "dva-alert-mode-" + mode,
                  type: "button",
                  style: modeBtnStyle((cache.alertMode || "voice") === mode),
                  // 点完即存：只改本地样式不发 POST 的话，宿主仍是旧模式，回合结束时
                  // 照样按旧模式出声（用户以为「选了音效没用」）。见 persistPatch 注释。
                  onClick: function () {
                    var before = snapshotState();
                    applyAlertMode(mode);
                    setText("dva-status", "正在切换提醒方式…");
                    persistPatch(
                      { alertMode: mode },
                      "已切换为「" + MODE_LABELS[mode] + "」（立即生效）",
                      before
                    );
                  }
                },
                MODE_LABELS[mode]
              );
            })
          ),
          // 音效面板已并入上面的三条行（用户第十三轮：同一张卡、两种形态，
          // 输入框 ⇄ 下拉互换，动作组同一位置），不再有独立的 sfx-panel。
          // 隐藏值载体（保存设置从这里读当前选择）保留，DOM 始终存在：
          KINDS.map(function (kind) {
            return React.createElement("input", {
              key: "carrier-" + kind,
              id: "dva-sfx-" + kind,
              type: "hidden",
              defaultValue: (cache.sfxByKind && cache.sfxByKind[kind]) || ""
            });
          }),
          // 第十七轮（用户指令）：状态盒**内部分左右两栏** ——
          //   左栏 = 合成/播放状态（setStatus 写的内容，如「▶ 正在播放：鸟鸣」）
          //   右栏 = 当前音色（dva-voice）
          // 对外契约：#dva-status 仍是左栏文字节点（所有 setStatus/setText 写它），
          // 外层盒子改叫 #dva-status-box —— 这样既有调用点与自检断言全不用改。
          React.createElement(
            "div",
            {
              key: "status",
              id: "dva-status-box",
              style: {
                display: "flex",
                alignItems: "center",
                gap: "10px",
                flexWrap: "nowrap",
                minWidth: "0",
                fontSize: "12px",
                color: TOKEN.textDim,
                lineHeight: "1.45",
                padding: "6px 9px",
                borderRadius: "9px",
                background: TOKEN.bgCard,
                border: "1px solid " + TOKEN.borderSoft,
                boxSizing: "border-box",
                maxWidth: "100%"
              }
            },
            React.createElement(
              "span",
              {
                id: "dva-status",
                style: {
                  flex: "1 1 60%",
                  minWidth: "0",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }
              },
              cache.status
            ),
            React.createElement(
              "span",
              {
                id: "dva-voice",
                style: {
                  flex: "1 1 40%",
                  minWidth: "0",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textAlign: "right"
                }
              },
              "音色：读取中…"
            )
          )
        )
      );

      // ---- 卡片 2：常用设置 ----
      var commonRows = [];
      // 2026-10-25 用户要求删掉多余说明（m05985 截图「这一句话多余了」+ m05990
      // 「删掉包括这个三条播报文案」）：这里原先有两行纯说明 ——
      //   ①小标题「✍️ 三条播报文案」（卡片标题已是「✍️ 播报内容」，同一件事说两遍）
      //   ②「改完文案点「🎙 生成语音」即可一键更新（自动保存并合成）。」
      // 两行全删，三条文案直接跟在卡片标题下面；生成按钮本身写着「一键更新」，
      // 用法不言自明，不需要再解释一遍。
      // 三条行 = **一张卡、两种形态**（用户 2026-10-25 第十三轮：「切换到音效之后，
      // 输入框变成下拉框…直接在相同的位置可以导入音效，也可以加上导出…界面要一致」）：
      //   语音模式：事件名 + 文案输入框(dva-text-<kind>) + 试听/下载/导入
      //   音效模式：事件名 + 提示音下拉(dva-sfxselect-<kind>) + 试听/导出/导入
      // 下拉/导入/导出与语音的输入框/下载/导入**占同一位置**，切模式只换中段控件，
      // 行高、间距、按钮组完全一致 —— 一页能显示完，不用再单独滚到音效面板。
      // 第十四轮（用户 2026-10-25）：「从语音播报和音效来回切换，界面不能及时
      // 切换过来…不如本来就是两个界面只不过长得像」—— 三条行**预渲染两套**
      // （语音套 dva-row-voice-<kind> / 音效套 dva-row-sfx-<kind>），display 由
      // alertMode 决定；applyAlertMode 切模式时用纯 DOM 翻转，**零 React 重渲染**，
      // 界面即时切换（不再「得关闭界面重新打开或者多等一会」）。
      KINDS.forEach(function (kind) {
        var isSfx = (cache.alertMode || "voice") === "sfx";
        var voiceForm = React.createElement(
          "div",
          {
            key: "voice-form-" + kind,
            id: "dva-row-voice-" + kind,
            style: Object.assign({}, eventBlock, { display: isSfx ? "none" : "flex" })
          },
          React.createElement(
            "span",
            { style: eventName },
            React.createElement("span", { style: eventDotStyle(kind), "aria-hidden": "true" }),
            LABELS[kind]
          ),
          React.createElement("input", {
            id: "dva-text-" + kind,
            type: "text",
            defaultValue: cache.texts[kind] || "",
            placeholder: "播报文案",
            style: inputStyle
          }),
          buildActionGroup(kind)
        );
        var sfxForm = React.createElement(
          "div",
          {
            key: "sfx-form-" + kind,
            id: "dva-row-sfx-" + kind,
            style: Object.assign({}, eventBlock, { display: isSfx ? "flex" : "none" })
          },
          React.createElement(
            "span",
            { style: eventName },
            React.createElement("span", { style: eventDotStyle(kind), "aria-hidden": "true" }),
            LABELS[kind]
          ),
          React.createElement(
            "select",
            {
              id: "dva-sfxselect-" + kind,
              defaultValue: (cache.sfxByKind && cache.sfxByKind[kind]) || "",
              title: "「" + LABELS[kind] + "」时播哪个提示音（选中即生效）",
              style: inputStyle,
              onChange: function (ev) { setSfxFor(kind, ev && ev.target ? ev.target.value : ""); }
            },
            (function () {
              var list = cache.sfxCatalog && cache.sfxCatalog.length ? cache.sfxCatalog : SFX_FALLBACK;
              var order = [];
              var byGroup = {};
              list.forEach(function (item) {
                var group = item.group || "音效";
                if (!byGroup[group]) { byGroup[group] = []; order.push(group); }
                byGroup[group].push(item);
              });
              return order.map(function (group) {
                return React.createElement(
                  "optgroup",
                  { key: "og-" + group, label: SFX_GROUP_LABEL[group] || group },
                  byGroup[group].map(function (item) {
                    return React.createElement("option", { key: item.key, value: item.key }, item.name);
                  })
                );
              });
            })()
          ),
          buildActionGroup(kind)
        );
        commonRows.push(voiceForm, sfxForm);
      });
      // 旧的单套循环（已被上面两套取代）：
      false && KINDS.forEach(function (kind) {
        var isSfx = (cache.alertMode || "voice") === "sfx";
        commonRows.push(
          React.createElement(
            "div",
            { key: "text-" + kind, style: eventBlock },
            // 左侧：色点 + 事件名（完成 / 失败 / 审批），一眼分清是哪一条。
            React.createElement(
              "span",
              { style: eventName },
              React.createElement("span", { style: eventDotStyle(kind), "aria-hidden": "true" }),
              LABELS[kind]
            ),
            isSfx
              ? // ── 音效模式：提示音下拉（替代输入框的位置）──
                React.createElement(
                  "select",
                  {
                    id: "dva-sfxselect-" + kind,
                    defaultValue: (cache.sfxByKind && cache.sfxByKind[kind]) || "",
                    title: "「" + LABELS[kind] + "」时播哪个提示音（选中即生效）",
                    style: inputStyle,
                    onChange: function (ev) { setSfxFor(kind, ev && ev.target ? ev.target.value : ""); }
                  },
                  (function () {
                    var list = cache.sfxCatalog && cache.sfxCatalog.length ? cache.sfxCatalog : SFX_FALLBACK;
                    var order = [];
                    var byGroup = {};
                    list.forEach(function (item) {
                      var group = item.group || "音效";
                      if (!byGroup[group]) { byGroup[group] = []; order.push(group); }
                      byGroup[group].push(item);
                    });
                    return order.map(function (group) {
                      return React.createElement(
                        "optgroup",
                        { key: "og-" + group, label: SFX_GROUP_LABEL[group] || group },
                        byGroup[group].map(function (item) {
                          return React.createElement("option", { key: item.key, value: item.key }, item.name);
                        })
                      );
                    });
                  })()
                )
              : // ── 语音模式：文案输入框 ──
                React.createElement("input", {
                  id: "dva-text-" + kind,
                  type: "text",
                  defaultValue: cache.texts[kind] || "",
                  placeholder: "播报文案",
                  style: inputStyle
                }),
            // 右侧动作组：两模式同一位置；音效模式的「⬇ 下载」换成「⬇ 导出」
            //（下载的是这条播报的人声 mp3，导出的是该分类当前选中的提示音 mp3 ——
            //  一个键同一个位置，语义跟着模式走，界面完全一致）。
            buildActionGroup(kind)
          )
        );
      });
      // 第十六轮：「共 20 个内置音效」已并入状态区右栏，不再单独占一行。
      // 分区标题：音色 / 语速等「声音本身」的设置。
      commonRows.push(React.createElement("hr", { key: "divider-prosody", style: dividerStyle }));
      commonRows.push(
        React.createElement(
          "div",
          { key: "voice-title", style: sectionTitle },
          "🎚 声音设置"
        )
      );
      // 备注 + 语速 + 音调 + 音量，全部压进同一行。
      // WHY（用户 2026-10-25 第二次反馈原话：「给你说了改成一行，为啥还是两行」）：
      // 上一版只做了「行内不换行」，可备注行(voice-note)和语速行(prosody)本来就是
      // 两个独立的 div —— 结构上天生两行，怎么调 flex-wrap 都不会变成一行。
      // 这里合并成一个 nowrap 行：窄面板下只让备注框和数字框按比例变窄，绝不折行。
      // 「音色备注」也缩成「备注」（完整说法挂在 title 悬浮提示里），省下的宽度给备注框。
      commonRows.push(
        React.createElement(
          "div",
          { key: "voice-settings", style: Object.assign({}, rowNowrapStyle, { gap: "5px" }) },
          React.createElement(
            "span",
            { style: fieldLabelTight, title: "音色备注：给这个音色起个你喜欢的名字，只写在本机 config.json" },
            "备注"
          ),
          React.createElement("input", {
            id: "dva-voice-note",
            type: "text",
            defaultValue: cache.voiceNote || "",
            placeholder: "给这个音色起个你喜欢的名字（只写在本机）",
            // 备注是短文本：不必横贯整卡，也不要再挂一行常驻说明（用户：这没必要拐行）。
            // 说明改走右边的 ⓘ 悬浮气泡，输入框吃掉行的剩余宽度。
            style: Object.assign({}, inputStyle, { flex: "1 1 120px", minWidth: "0", maxWidth: "260px" })
          }),
          // 说明（宿主 GET /settings 下发的 voicePolicyNote）住进悬浮气泡；节点本身
          // 仍是 #dva-voice-note-policy，宿主侧的 setText 一字不用改（client.js:309）。
          tip("", {
            key: "tip-voice-note",
            label: "音色备注说明",
            icon: "ⓘ",
            node: React.createElement("span", { id: "dva-voice-note-policy" }, "")
          }),
          React.createElement("span", { style: fieldLabelTight }, "语速"),
          React.createElement("input", { id: "dva-speed_ratio", type: "number", step: "0.01", min: "0.2", max: "4", defaultValue: String(cache.prosody.speed_ratio), style: numberInputStyle() }),
          React.createElement("span", { style: fieldLabelTight }, "音调"),
          React.createElement("input", { id: "dva-pitch_ratio", type: "number", step: "0.01", min: "0.2", max: "4", defaultValue: String(cache.prosody.pitch_ratio), style: numberInputStyle() }),
          React.createElement("span", { style: fieldLabelTight }, "音量"),
          React.createElement("input", {
            id: "dva-volume_ratio",
            type: "number",
            step: "0.01",
            // 下限 0：用户要求「音量设 0 = 静音」，所以 0 必须是可填、可保存的值。
            min: "0",
            max: "4",
            defaultValue: String(cache.prosody.volume_ratio),
            title: "0 = 静音（所有播报和试听都不出声）；1 = 原始音量；最大 4",
            style: numberInputStyle()
          })
        )
      );
      // 静音红字单独一行：它默认是空的（容器高度 0），只有音量=0 时才出现；
      // 留在上面那个 nowrap 行里会把整行撑到溢出，所以拆出来。
      commonRows.push(
        React.createElement(
          "div",
          { key: "mute-note-row" },
          React.createElement("span", { id: "dva-mute-note", style: { fontSize: "11.5px", color: TOKEN.danger } }, "")
        )
      );
      // 分区标题：改完文案 / 调完声音后，最后一步是「生成」。
      commonRows.push(React.createElement("hr", { key: "divider-actions", style: dividerStyle }));
      commonRows.push(
        React.createElement(
          "div",
          { key: "actions-title", style: sectionTitle },
          "🚀 最后一步：生成语音"
        )
      );
      commonRows.push(
        React.createElement(
          "div",
          { key: "actions", style: Object.assign({}, rowStyle, { flexWrap: "wrap" }) },
          // 主次分明：生成=主按钮（主色），保存=次按钮，两者同一组、gap 一致。
          React.createElement(
            "div",
            { style: Object.assign({}, actionGroup, { gap: "8px", padding: "4px" }) },
            React.createElement(
              "button",
              { id: "dva-generate", type: "button", style: btnPrimary, onClick: generateAll, onMouseEnter: hoverIn, onMouseLeave: hoverOut, onMouseDown: pressIn, onMouseUp: pressOut },
              "🎙 生成语音（一键更新）"
            ),
            React.createElement(
              "button",
              { id: "dva-save", type: "button", style: btnSecondary, onClick: saveSettings, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2, onMouseDown: pressIn2, onMouseUp: pressOut2 },
              "保存设置"
            )
          ),
          React.createElement(
            "label",
            { style: { display: "flex", alignItems: "center", gap: "5px", fontSize: "11.5px", color: TOKEN.textDim, cursor: "pointer" } },
            React.createElement("input", {
              id: "dva-force",
              type: "checkbox",
              title: "勾上后本次会把三条语音全部重新合成（真实调用 TTS，耗时耗额度）；提交后自动取消勾选。平时不用勾：改了文案/语速/音调只会自动重做有改动的那条。"
            }),
            "强制重新生成（仅本次）"
          ),
          React.createElement("span", { style: subText }, "（默认只重做有改动的那条；勾上「仅本次」= 三条全部重做；生成会备份旧文件并自动调好音量）")
        )
      );
      // ---- 克隆入口：想换成其他音色去哪（用户要求把网址写进界面）----
      commonRows.push(React.createElement("hr", { key: "divider-clone", style: dividerStyle }));
      commonRows.push(
        React.createElement(
          "div",
          { key: "clone-title", style: sectionTitle },
          "🎤 想换一个音色？"
        )
      );
      commonRows.push(
        React.createElement(
          "div",
          { key: "clone-entry", style: Object.assign({}, rowStyle, { flexWrap: "wrap", alignItems: "baseline" }) },
          React.createElement(
            "span",
            { id: "dva-clone-note", style: subText },
            "想换成其他音色：到火山引擎「声音复刻」上传一段录音克隆（约 5~20 秒），拿到 S_ 开头的音色 ID 后填进「高级设置」里的音色库即可。"
          ),
          React.createElement(
            "a",
            { id: "dva-clone-link", href: "https://console.volcengine.com/speech/app", target: "_blank", rel: "noreferrer", style: { color: TOKEN.link, fontSize: "13px" } },
            "打开声音复刻控制台"
          ),
          React.createElement(
            "a",
            { id: "dva-clone-link-doc", href: "https://www.volcengine.com/product/voicecloning", target: "_blank", rel: "noreferrer", style: { color: TOKEN.link, fontSize: "13px" } },
            "产品介绍/开通"
          )
        )
      );
      rows.push(
        React.createElement(
          "div",
          { key: "card-common", style: cardStyle },
          // 标题旁的 ⓘ 悬浮提示：这句「怎么写播报内容」人人都会，没必要常驻占版面
          // （用户 2026-10 反馈「这段话没必要写，或者弄成悬浮提醒」）。id 保留给自检。
          React.createElement(
            "div",
            { key: "card-common-title", style: cardHead },
            React.createElement("span", { style: cardTitle }, "✍️ 播报内容"),
            tip("写「完成 / 失败 / 审批」三种情况要念的话；每条可单独试听、下载 mp3、或换成自己录的。", {
              key: "tip-common",
              id: "dva-card-common-desc",
              icon: "ⓘ"
            })
          ),
          commonRows
        )
      );

      // ---- 卡片 3：高级设置（默认折叠，仅影响可见性） ----
      // 三条文案已移到上方「播报内容」卡（它们是最常用的操作）。
      var advancedRows = [];
      advancedRows.push(
        React.createElement(
          "div",
          { key: "key-title", style: sectionTitle },
          "🔑 语音服务的 Key"
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "key-desc", style: cardDesc },
          "语音播报要调用火山引擎的语音合成，所以需要一个 Key。已经配好就别动这里。"
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "tts-key", style: rowWrapStyle },
          React.createElement("span", { style: fieldLabel }, "API Key"),
          React.createElement("input", {
            id: "dva-tts-key",
            type: "password",
            defaultValue: "",
            placeholder: "留空则保持不变（不会回显已保存的 Key）",
            style: inputStyle
          }),
          React.createElement("button", { id: "dva-key-toggle", type: "button", style: buttonStyle, onClick: toggleKeyVisibility, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 }, "显示"),
          React.createElement("span", { id: "dva-key-state", style: subText }, "读取中…")
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "key-note", id: "dva-key-note", style: subText },
          "此 Key 只保存在本机 config.json，不会写入插件源码，也不会外传。"
        )
      );
      advancedRows.push(React.createElement("hr", { key: "divider-volume", style: dividerStyle }));
      advancedRows.push(
        React.createElement(
          "div",
          { key: "volume-title", style: sectionTitle },
          "🔊 系统音量（只读）"
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "volume", id: "dva-volume", style: subText },
          "当前系统主音量：读取中…"
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "volume-note", id: "dva-volume-note", style: subText },
          "试听无声时请先检查系统音量；本插件不会修改系统音量，也不会修改静音状态。"
        )
      );
      // ---- requirement A: voice library（收进高级设置，功能不变） ----
      advancedRows.push(React.createElement("hr", { key: "divider-voice-lib", style: dividerStyle }));
      advancedRows.push(
        React.createElement(
          "div",
          { key: "voice-lib-title", style: sectionTitle },
          "🎼 音色库"
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "voice-lib-note", style: subText },
          "克隆音色用控制台 Key，预设音色用 Agent Plan Key（ark-…）。改完点「保存音色库」写入 config.json。"
        )
      );
      advancedRows.push(
        React.createElement("div", {
          key: "voice-rows-box",
          id: "dva-voice-rows",
          style: { display: "flex", flexDirection: "column" }
        })
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "voice-add", style: rowWrapStyle },
          React.createElement("input", { id: "dva-vadd-id", type: "text", placeholder: "音色 ID（S_ 开头=克隆，其余=预设）", style: inputStyle }),
          React.createElement("input", { id: "dva-vadd-note", type: "text", placeholder: "备注", style: Object.assign({}, inputStyle, { flex: "0 1 110px", minWidth: "56px" }) }),
          React.createElement("button", { id: "dva-vadd-go", type: "button", style: buttonStyle, onClick: voiceAdd, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 }, "添加")
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "voice-import", style: rowWrapStyle },
          React.createElement(
            "button",
            { id: "dva-vimport-open", type: "button", style: buttonStyle, onClick: function () { var p = el("dva-vimport-panel"); if (p) p.style.display = p.style.display === "none" ? "flex" : "none"; }, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 },
            "批量导入"
          ),
          React.createElement("span", { style: subText }, "每行一个：ID,备注（# 开头为注释，自动识别克隆/预设）")
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "voice-import-panel", id: "dva-vimport-panel", style: { display: "none", flexDirection: "column", gap: "6px" } },
          React.createElement("textarea", {
            id: "dva-vimport-text",
            rows: 5,
            placeholder: "S_abc123,我的克隆\nzh_female_vv_uranus_bigtts,VV 女声",
            style: Object.assign({}, inputStyle, { minHeight: "80px", fontFamily: "Consolas,monospace" })
          }),
          React.createElement(
            "div",
            { style: rowWrapStyle },
            React.createElement("button", { id: "dva-vimport-go", type: "button", style: buttonStyle, onClick: voiceImportExec, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 }, "执行导入"),
            React.createElement("button", { id: "dva-vimport-close", type: "button", style: buttonStyle, onClick: function () { var p = el("dva-vimport-panel"); if (p) p.style.display = "none"; }, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 }, "收起")
          )
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "preset-key", style: rowWrapStyle },
          React.createElement("span", { style: Object.assign({}, fieldLabel, { minWidth: "6em" }) }, "预设音色 Key"),
          React.createElement("input", { id: "dva-preset-key", type: "password", defaultValue: "", placeholder: "ark-…（留空不修改）", style: inputStyle }),
          React.createElement("span", { id: "dva-preset-key-state", style: subText }, "读取中…")
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "voice-actions", style: rowWrapStyle },
          React.createElement("button", { id: "dva-voice-save", type: "button", style: buttonStyle, onClick: voiceSave, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 }, "保存音色库"),
          React.createElement("span", { id: "dva-voice-status", style: subText }, "")
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "results", id: "dva-results", style: Object.assign({}, subText, { whiteSpace: "pre-wrap" }) },
          ""
        )
      );
      rows.push(
        React.createElement(
          "details",
          { key: "card-advanced", style: cardStyle },
          React.createElement(
            "summary",
            { style: Object.assign({}, cardTitle, { cursor: "pointer", userSelect: "none" }) },
            "⚙️ 高级设置"
          ),
          React.createElement(
            "div",
            { key: "card-advanced-desc", style: cardDesc },
            "平时不用动这里。只有要换 API Key、换音色、或想知道当前系统音量时才需要展开。"
          ),
          React.createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "8px", paddingTop: "4px" } },
            advancedRows
          )
        )
      );

      return React.createElement(
        "div",
        { "data-dva-slot": "1", style: { fontFamily: FONT, display: "flex", flexDirection: "column", gap: "8px", padding: "6px 2px", lineHeight: "1.45", minWidth: "0", maxWidth: "100%", boxSizing: "border-box" } },
        rows
      );
    }
    function registerSettings(ctx) {
      if (!ctx || !ctx.slots || !React) return false;
      try {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-voice-alert",
              order: 27,
              label: function () {
                return "语音播报";
              },
              inject: function () {
                return {};
              }
            },
            SettingsSection
          );
        });
        return true;
      } catch (e) {
        try {
          console.warn("[dsh-voice-alert] settings registration failed", e);
        } catch (e2) {}
        return false;
      }
    }

    // MUST be a plain array (see the header comment).
    exports.inject = ["slots", "locale"];
    exports.apply = function (ctx) {
      try {
        registerSettings(ctx);
      } catch (e) {}
    };
    exports.__dvaTest = {
      cache: cache,
      SettingsSection: SettingsSection,
      registerSettings: registerSettings,
      loadSettings: loadSettings,
      saveSettings: saveSettings,
      generateAll: generateAll,
      preview: preview,
      renderResults: renderResults,
      // requirement A: voice library
      loadVoices: loadVoices,
      renderVoiceRows: renderVoiceRows,
      voiceProbe: voiceProbe,
      voiceAdd: voiceAdd,
      voiceImportExec: voiceImportExec,
      voiceSave: voiceSave,
      // requirement B: 音效库（列表 + 勾选）
      SFX_FALLBACK: SFX_FALLBACK,
      applyAlertMode: applyAlertMode,
      applySfxSelection: applySfxSelection,
      setSfxFor: setSfxFor,
      previewSfxKey: previewSfxKey,
      pollJob: pollJob,
      // 下载 / 导入 mp3（供自测与排错直接调用，界面上走按钮）
      downloadMp3: downloadMp3,
      importMp3: importMp3,
      saveBlobAsFile: saveBlobAsFile,
      humanReason: humanReason,
      // 撤销导入（把这条播报恢复成自动生成的语音）
      undoImport: undoImport,
      refreshActionGroup: refreshActionGroup,
      refreshAllActionGroups: refreshAllActionGroups,
      buildActionGroup: buildActionGroup,
      // 「点完即存」的统一入口：自测直接调用它验证成功回包重画与失败回滚
      persistPatch: persistPatch,
      snapshotState: snapshotState,
      applyMuteNotice: applyMuteNotice,
      // 气泡不出框（试听悬浮说明被裁）：定位器 + 裁剪矩形，供自检直接调用
      ensureTipPlacement: ensureTipPlacement,
      placeTip: placeTip,
      tipClipRect: tipClipRect
    };
    return module.exports;
  }
});
