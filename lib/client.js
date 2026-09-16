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
    var LABELS = { complete: "完成", fail: "失败", approval: "审批" };

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
      // requirement B: alert mode + sound-effect library
      // 默认 sfx：与宿主 DEFAULT_CONFIG 一致（开源版装完即用，不需要任何 Key）。
      alertMode: "sfx",
      sfxByKind: { complete: "remind-tada", fail: "remind-muyu", approval: "remind-dingdong" },
      sfxCatalog: [],
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
      if (node) node.textContent = value;
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
        setDisabled("dva-generate", cache.apiKeyPresent === false);
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
      request("/settings", { method: "GET", headers: {} }).then(
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
          cache.apiKeyPresent = Boolean(data.apiKeyPresent);
          cache.apiKeyMask = String(data.apiKeyMask || "");
          cache.voiceNote = String(data.voiceNote || "");
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
          setText("dva-voice", "音色：" + (cache.voiceNote || "（未备注）") + " · 固定 ID " + String(data.speaker || ""));
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
          setText("dva-status", cache.apiKeyPresent ? "" : data.apiKeyHint || "未配置 TTS API Key");
          setDisabled("dva-generate", !cache.apiKeyPresent || cache.busy);
          if (data.generate) renderResults(data.generate);
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
      var payload = {
        texts: {
          complete: valueOf("dva-text-complete", cache.texts.complete),
          fail: valueOf("dva-text-fail", cache.texts.fail),
          approval: valueOf("dva-text-approval", cache.texts.approval)
        },
        prosody: {
          speed_ratio: Number(valueOf("dva-speed_ratio", cache.prosody.speed_ratio)),
          pitch_ratio: Number(valueOf("dva-pitch_ratio", cache.prosody.pitch_ratio)),
          volume_ratio: Number(valueOf("dva-volume_ratio", cache.prosody.volume_ratio))
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
          cache.texts = Object.assign({}, cache.texts, data.texts || {});
          cache.prosody = Object.assign({}, cache.prosody, data.prosody || {});
          cache.apiKeyPresent = Boolean(data.apiKeyPresent);
          cache.apiKeyMask = String(data.apiKeyMask || "");
          cache.voiceNote = String(data.voiceNote || "");
          var keyNode = el("dva-tts-key");
          if (keyNode) keyNode.value = "";
          setText("dva-key-state", cache.apiKeyPresent ? "已配置（" + cache.apiKeyMask + "）· 留空表示不修改" : "未配置");
          setText("dva-voice", "音色：" + (cache.voiceNote || "（未备注）") + " · 固定 ID " + String(data.speaker || ""));
          setDisabled("dva-generate", !cache.apiKeyPresent || cache.busy);
          setText(
            "dva-status",
            "已保存" +
              (data.persisted && data.persisted.skipped ? "（仅内存）" : "（已写入 config.json）") +
              (data.applied && data.applied.tts && data.applied.tts.apiKey ? " · API Key 已更新" : "")
          );
        } else {
          setText("dva-status", "保存失败：" + String((data && data.reason) || ("HTTP " + String(res.status))));
        }
      });
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
            setDisabled("dva-generate", !cache.apiKeyPresent);
            setText("dva-status", "没有需要重新合成的改动，已复用现有语音（未调用 TTS）。如需强制重做，请勾选「强制重新生成（仅本次）」。");
            pollJob();
            return;
          }
          // 提交失败：保留勾选状态，用户可以直接重试（仍按强制重做）。
          cache.busy = false;
          setDisabled("dva-generate", !cache.apiKeyPresent);
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
            : "试听失败：HTTP " + String(res.status)
        );
      });
    }

    // ================= requirement A: voice library =================
    var btnMini = "background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:6px;color:inherit;font-size:11px;padding:2px 8px;cursor:pointer";
    var btnMiniDisabled = "background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);border-radius:6px;color:#5b6472;font-size:11px;padding:2px 8px";

    /** Rebuild the voice-library rows into the React-rendered container (DOM, id-based). */
    function renderVoiceRows() {
      var box = el("dva-voice-rows");
      if (!box || typeof box.replaceChildren !== "function") return; // DOM-stub guard
      var rows = [];
      cache.voices.forEach(function (voice, i) {
        var status = cache.voicesStatuses[voice.id] || { kind: voice.kind, keyPresent: false, keyError: null };
        var isCurrent = voice.id === cache.selectedVoiceId;
        var inUse = voice.kind === "clone" && isCurrent;
        var kindLabel = voice.kind === "preset" ? "预设" : "克隆";
        var kindColor = voice.kind === "preset" ? "#c9a86a" : "#6aa8c9";
        var row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)";
        var badge = document.createElement("span");
        badge.textContent = kindLabel;
        badge.style.cssText = "flex:0 0 34px;text-align:center;font-size:11px;border-radius:4px;padding:1px 4px;color:#0b0e14;background:" + kindColor;
        row.appendChild(badge);
        var cur = document.createElement("span");
        cur.textContent = isCurrent ? "●当前" : "○";
        cur.id = "dva-voice-cur-" + i;
        cur.style.cssText = "flex:0 0 44px;font-size:11px;color:" + (isCurrent ? "#7ee787" : "#5b6472");
        row.appendChild(cur);
        var idSpan = document.createElement("span");
        idSpan.textContent = voice.id;
        idSpan.title = voice.id;
        idSpan.style.cssText = "flex:0 0 220px;font-family:Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d1d9";
        row.appendChild(idSpan);
        var avail = document.createElement("span");
        avail.textContent = status.keyPresent ? "✓可用" : (status.keyError === "preset-key-missing" ? "缺ark-key" : "缺key");
        avail.id = "dva-voice-avail-" + i;
        avail.style.cssText = "flex:0 0 56px;font-size:11px;color:" + (status.keyPresent ? "#7ee787" : "#f85149");
        row.appendChild(avail);
        var noteInput = document.createElement("input");
        noteInput.type = "text";
        noteInput.value = voice.note || "";
        noteInput.placeholder = "备注";
        noteInput.style.cssText = "flex:1;min-width:110px;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.14);border-radius:6px;color:inherit;font-size:12px;padding:3px 6px;outline:none";
        noteInput.addEventListener("input", function () {
          voice.note = noteInput.value;
          cache.voicesDirty = true;
        });
        row.appendChild(noteInput);
        var setBtn = document.createElement("button");
        setBtn.textContent = isCurrent ? "使用中" : "设为当前";
        setBtn.type = "button";
        setBtn.style.cssText = isCurrent ? btnMiniDisabled : btnMini;
        setBtn.disabled = isCurrent;
        setBtn.addEventListener("click", function () {
          cache.selectedVoiceId = voice.id;
          cache.voicesDirty = true;
          renderVoiceRows();
        });
        row.appendChild(setBtn);
        var probeBtn = document.createElement("button");
        probeBtn.textContent = "试合";
        probeBtn.type = "button";
        probeBtn.style.cssText = btnMini;
        probeBtn.addEventListener("click", function () {
          voiceProbe(voice, i);
        });
        row.appendChild(probeBtn);
        var probeOut = document.createElement("span");
        probeOut.id = "dva-voice-probe-" + i;
        probeOut.style.cssText = "flex:0 0 130px;font-size:11px;color:#8b93a8";
        row.appendChild(probeOut);
        var delBtn = document.createElement("button");
        delBtn.textContent = "删除";
        delBtn.type = "button";
        delBtn.style.cssText = inUse ? btnMiniDisabled : btnMini;
        delBtn.disabled = inUse;
        delBtn.title = inUse ? "正在使用的克隆音色不可删除" : "";
        delBtn.addEventListener("click", function () {
          cache.voices = cache.voices.filter(function (v) { return v.id !== voice.id; });
          cache.voicesDirty = true;
          renderVoiceRows();
        });
        row.appendChild(delBtn);
        rows.push(row);
      });
      box.replaceChildren.apply(box, rows);
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
        node.style.color = ok ? "#7ee787" : "#f85149";
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
          var area = el("dva-vimport-text"); if (area) area.value = "";
          setText("dva-voice-status", "导入完成：解析 " + String(data.parsed) + " 条，新增 " + String(data.added) + " 条，跳过重复 " + String(data.skipped) + " 条");
        } else {
          setText("dva-voice-status", "导入失败：" + String((data && data.reason) || ("HTTP " + res.status)));
        }
      });
    }

    function voiceSave() {
      setText("dva-voice-status", "正在保存音色库…");
      return request("/voices/save", { method: "POST", body: JSON.stringify({
        voices: cache.voices,
        selectedVoiceId: cache.selectedVoiceId,
        presetApiKey: String(valueOf("dva-preset-key", "") || "").trim()
      }) }).then(function (res) {
        var data = res.json || {};
        if (res.status === 200 && data.ok) {
          cache.voices = data.list || cache.voices;
          cache.voicesStatuses = data.statuses || {};
          cache.selectedVoiceId = data.selectedVoiceId || cache.selectedVoiceId;
          cache.presetApiKeyPresent = Boolean(data.presetApiKeyPresent);
          cache.presetApiKeyMask = String(data.presetApiKeyMask || "");
          cache.voicesDirty = false;
          renderVoiceRows();
          renderPresetKeyState();
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
        renderVoiceRows();
        renderPresetKeyState();
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

    // ---- v0.3.2 傻瓜化 UI 样式：中文优先字体 + 卡片式分区 + 主次分明的按钮 ----
    var FONT = '"Microsoft YaHei","微软雅黑",system-ui,-apple-system,"Segoe UI",sans-serif';
    var inputStyle = {
      flex: "1",
      minWidth: "200px",
      background: "rgba(0,0,0,.28)",
      border: "1px solid rgba(255,255,255,.14)",
      borderRadius: "8px",
      color: "inherit",
      fontFamily: "inherit",
      fontSize: "14px",
      lineHeight: "1.6",
      padding: "7px 10px",
      outline: "none"
    };
    var rowStyle = { display: "flex", alignItems: "center", gap: "10px", fontSize: "14px", lineHeight: "1.6" };
    var fieldLabel = { flex: "0 0 auto", minWidth: "60px", color: "rgba(255,255,255,.74)", fontSize: "14px" };
    var cardStyle = {
      background: "rgba(255,255,255,.035)",
      border: "1px solid rgba(255,255,255,.09)",
      borderRadius: "12px",
      padding: "14px 16px",
      display: "flex",
      flexDirection: "column",
      gap: "10px"
    };
    // 总控卡：更亮一点的主色底，一眼就是最显眼那张。
    var cardPrimaryStyle = Object.assign({}, cardStyle, {
      background: "rgba(63,128,255,.07)",
      border: "1px solid rgba(88,166,255,.30)"
    });
    var cardTitle = { fontSize: "16px", fontWeight: 700, color: "#e6edf3", letterSpacing: ".3px" };
    var subText = { fontSize: "13px", color: "#8b93a8", lineHeight: "1.6" };
    // 主按钮：大号、圆角、强调色，带 hover/active 反馈（自测 DOM 无事件，反馈函数只服务真实浏览器）。
    var btnPrimary = {
      background: "#1f6feb",
      border: "1px solid #388bfd",
      borderRadius: "9px",
      color: "#fff",
      fontFamily: "inherit",
      fontSize: "15px",
      fontWeight: 600,
      padding: "10px 22px",
      cursor: "pointer"
    };
    // 次按钮：透明底 + 描边，视觉上比主按钮安静一档。
    var btnSecondary = {
      background: "rgba(255,255,255,.10)",
      border: "1px solid rgba(255,255,255,.20)",
      borderRadius: "8px",
      color: "inherit",
      fontFamily: "inherit",
      fontSize: "14px",
      padding: "8px 16px",
      cursor: "pointer"
    };
    var buttonStyle = btnSecondary; // 旧名字沿用为次级按钮（文案试听/显隐 Key/音色库操作等）
    // hover / active 反馈：inline style 无法写伪类，用手势事件改背景色（仅在真实浏览器触发）。
    function hoverIn(e) { try { e.currentTarget.style.background = "#388bfd"; } catch (err) {} }
    function hoverOut(e) { try { e.currentTarget.style.background = "#1f6feb"; } catch (err) {} }
    function pressIn(e) { try { e.currentTarget.style.background = "#1158c7"; } catch (err) {} }
    function pressOut(e) { try { e.currentTarget.style.background = "#1f6feb"; } catch (err) {} }
    function hoverIn2(e) { try { e.currentTarget.style.background = "rgba(255,255,255,.18)"; } catch (err) {} }
    function hoverOut2(e) { try { e.currentTarget.style.background = "rgba(255,255,255,.10)"; } catch (err) {} }
    function pressIn2(e) { try { e.currentTarget.style.background = "rgba(255,255,255,.24)"; } catch (err) {} }
    function pressOut2(e) { try { e.currentTarget.style.background = "rgba(255,255,255,.10)"; } catch (err) {} }

    // ================= v0.3.3 提醒方式（语音 / 音效 / 关闭） =================
    // 傻瓜化：一个「提醒方式」三选按钮，选音效时展开三个下拉 + 试听，其余全部默认
    // 给好（完成=成功号角、失败=木鱼、审批=叮咚）。音效模式完全不调用 TTS。
    function modeBtnStyle(active) {
      return {
        background: active ? "#1f6feb" : "rgba(255,255,255,.10)",
        border: "1px solid " + (active ? "#388bfd" : "rgba(255,255,255,.20)"),
        borderRadius: "8px",
        color: "#fff",
        fontFamily: "inherit",
        fontSize: "14px",
        fontWeight: active ? 600 : 400,
        padding: "8px 18px",
        cursor: "pointer"
      };
    }
    var sfxPanelStyle = {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      borderTop: "1px solid rgba(255,255,255,.12)",
      paddingTop: "10px",
      marginTop: "2px"
    };
    var MODE_LABELS = { voice: "🗣 语音播报", sfx: "🎵 音效", off: "🔕 关闭" };
    var MODE_HINTS = {
      voice: "语音模式：用你自己的音色朗读三条文案。",
      sfx: "音效模式：播放内置音效，不调用 TTS、不需要 API Key。",
      off: "关闭：完成 / 失败 / 审批都不提醒。"
    };
    var SFX_GROUP_LABEL = { "提醒": "🔔 提醒音", "大自然": "🌿 大自然" };
    var sfxGroupStyle = { fontSize: "13px", fontWeight: 600, color: "#8b93a8", marginTop: "4px" };
    var sfxRowStyle = { display: "flex", alignItems: "center", gap: "10px", fontSize: "13px", lineHeight: "1.5", padding: "2px 0" };
    var sfxNameStyle = { flex: "0 0 84px", color: "#e6edf3" };
    var sfxCheckLabel = { display: "flex", alignItems: "center", gap: "3px", color: "rgba(255,255,255,.72)", fontSize: "12px", cursor: "pointer" };
    var sfxBtnMini = {
      background: "rgba(255,255,255,.10)",
      border: "1px solid rgba(255,255,255,.18)",
      borderRadius: "6px",
      color: "inherit",
      fontFamily: "inherit",
      fontSize: "12px",
      padding: "3px 10px",
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

    /** 勾选：把某个事件设为某个音效（同一事件只保留一个），纯 DOM 更新。 */
    function setSfxFor(kind, key) {
      if (!cache.sfxByKind) cache.sfxByKind = {};
      cache.sfxByKind[kind] = key;
      sfxList().forEach(function (item) {
        var node = el("dva-sfxpick-" + item.key + "-" + kind);
        if (node) node.checked = item.key === key;
      });
      syncSfxKind(kind);
      setText("dva-status", LABELS[kind] + "时的提醒音已改为「" + sfxNameOf(key) + "」，点「保存设置」生效。");
    }

    /** 回显：把三个事件的勾选状态与汇总文字刷成 config 里的值。 */
    function applySfxSelection() {
      KINDS.forEach(function (kind) {
        var key = (cache.sfxByKind && cache.sfxByKind[kind]) || "";
        sfxList().forEach(function (item) {
          var node = el("dva-sfxpick-" + item.key + "-" + kind);
          if (node) node.checked = item.key === key;
        });
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
          setText("dva-status", data.ok ? "▶ 正在播放：" + sfxNameOf(key) + "（若没声音请再点一次，或检查系统音量）" : "试听失败：" + String(data.reason || res.status));
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
          setText("dva-sfx-note", "共 " + String(data.total || cache.sfxCatalog.length) + " 个内置音效，已在库 " + String(data.present) + " 个。点音效名旁的「▶」即可试听。");
        },
        function () {
          /* 目录读取失败：列表仍可显示内置默认名字，保存时沿用已有选择 */
        }
      );
    }

    // ================= v0.3.2 傻瓜化设置页 =================
    // 布局：总控大卡（开关 + 试听 + 状态）→ 常用设置卡 →「高级设置」折叠卡。
    // 折叠只影响可见性，全部元素仍渲染进 DOM（自测依赖的 ID 一个不少）。
    function SettingsSection() {
      if (!React) return null;
      // First render kicks the initial load (no hooks available, so results are
      // written back into the DOM by id).
      try {
        if (!cache.loaded && !cache.loading) loadSettings();
      } catch (e) {}

      var rows = [];

      // ---- 卡片 1：语音播报总控（最显眼） ----
      rows.push(
        React.createElement(
          "div",
          { key: "card-main", style: cardPrimaryStyle },
          React.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "10px" } },
            React.createElement("span", { style: cardTitle }, "语音播报"),
            React.createElement(
              "label",
              { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "7px", fontSize: "14px", color: "rgba(255,255,255,.82)", cursor: "pointer", fontWeight: 600 } },
              React.createElement("input", { id: "dva-enabled", type: "checkbox", checked: cache.enabled }),
              "总开关"
            )
          ),
          React.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" } },
            React.createElement(
              "button",
              { id: "dva-big-preview", type: "button", style: btnPrimary, onClick: function () { if ((cache.alertMode || "voice") === "sfx") { previewSfxKey((cache.sfxByKind || {}).complete || "remind-tada"); } else { preview("complete"); } }, onMouseEnter: hoverIn, onMouseLeave: hoverOut, onMouseDown: pressIn, onMouseUp: pressOut },
              "▶ 试听一下"
            ),
            React.createElement("span", { id: "dva-voice", style: { fontSize: "14px", color: "rgba(255,255,255,.85)" } }, "音色：读取中…")
          ),
          // ---- 没声音怎么办：常驻提示（用户 2026-09-16 要求把「调一下系统音量」写进界面）----
          React.createElement(
            "div",
            { key: "audio-tip", id: "dva-audio-tip", style: { fontSize: "13px", color: "#e3b341", lineHeight: "1.6" } },
            "🔈 点了试听没声音？把系统音量拖一下（调大调小都行）再点一次就有声了 —— 蓝牙耳机 / 虚拟声卡空闲挂起时，系统会把第一次播放「吞掉」，调音量正好把它唤醒。"
          ),
          // ---- 提醒方式：语音 / 音效 / 关闭（三选一，选中态高亮）----
          React.createElement(
            "div",
            { key: "alert-mode", style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
            React.createElement("span", { style: fieldLabel }, "提醒方式"),
            ["voice", "sfx", "off"].map(function (mode) {
              return React.createElement(
                "button",
                {
                  key: mode,
                  id: "dva-alert-mode-" + mode,
                  type: "button",
                  style: modeBtnStyle((cache.alertMode || "voice") === mode),
                  onClick: function () { applyAlertMode(mode); }
                },
                MODE_LABELS[mode]
              );
            }),
            React.createElement("span", { id: "dva-alert-mode-hint", style: subText }, MODE_HINTS[cache.alertMode || "voice"])
          ),
          // ---- 音效设置面板：只在音效模式显示（display 切换，DOM 始终在）----
          React.createElement(
            "div",
            {
              key: "sfx-panel",
              id: "dva-sfx-panel",
              style: Object.assign({}, sfxPanelStyle, { display: (cache.alertMode || "voice") === "sfx" ? "flex" : "none" })
            },
            // 汇总：三个事件当前各用哪个音效
            React.createElement(
              "div",
              { style: { display: "flex", gap: "16px", flexWrap: "wrap" } },
              KINDS.map(function (kind) {
                return React.createElement(
                  "span",
                  { key: kind, id: "dva-sfx-current-" + kind, style: { fontSize: "13px", color: "rgba(255,255,255,.85)" } },
                  LABELS[kind] + "时：读取中…"
                );
              })
            ),
            React.createElement(
              "div",
              { style: subText },
              "用法：横排三个方框勾「哪一类提醒」用这个音效（同一个事件只能勾一个）；点右边的「▶ 试听」就能听到。"
            ),
            // 20 个音效列表：每行 = 三个勾选框 + 音效名 + 试听
            (function () {
              var list = cache.sfxCatalog && cache.sfxCatalog.length ? cache.sfxCatalog : SFX_FALLBACK;
              var order = [];
              var byGroup = {};
              list.forEach(function (item) {
                var group = item.group || "音效";
                if (!byGroup[group]) {
                  byGroup[group] = [];
                  order.push(group);
                }
                byGroup[group].push(item);
              });
              var blocks = [];
              order.forEach(function (group) {
                blocks.push(React.createElement("div", { key: "g-" + group, style: sfxGroupStyle }, SFX_GROUP_LABEL[group] || group));
                byGroup[group].forEach(function (item) {
                  blocks.push(
                    React.createElement(
                      "div",
                      { key: "row-" + item.key, style: sfxRowStyle },
                      KINDS.map(function (kind) {
                        return React.createElement(
                          "label",
                          { key: kind, style: sfxCheckLabel },
                          React.createElement("input", {
                            id: "dva-sfxpick-" + item.key + "-" + kind,
                            type: "radio",
                            name: "dva-sfxgroup-" + kind,
                            value: item.key,
                            defaultChecked: Boolean(cache.sfxByKind && cache.sfxByKind[kind] === item.key),
                            onChange: function () { setSfxFor(kind, item.key); }
                          }),
                          LABELS[kind]
                        );
                      }),
                      React.createElement("span", { style: sfxNameStyle }, item.name),
                      React.createElement(
                        "button",
                        { id: "dva-sfx-preview-" + item.key, type: "button", style: sfxBtnMini, onClick: function () { previewSfxKey(item.key); }, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2, onMouseDown: pressIn2, onMouseUp: pressOut2 },
                        "▶ 试听"
                      )
                    )
                  );
                });
              });
              return blocks;
            })(),
            // 隐藏值载体：保存设置时从这里读当前选择（自测也断言这三个 ID 存在）
            KINDS.map(function (kind) {
              return React.createElement("input", {
                key: "carrier-" + kind,
                id: "dva-sfx-" + kind,
                type: "hidden",
                defaultValue: (cache.sfxByKind && cache.sfxByKind[kind]) || ""
              });
            }),
            React.createElement("span", { id: "dva-sfx-note", style: subText }, "共 20 个内置音效（提醒 10 + 大自然 10）。")
          ),
          React.createElement(
            "div",
            { key: "status", id: "dva-status", style: { fontSize: "13px", color: "#8b93a8", whiteSpace: "pre-wrap", lineHeight: "1.6" } },
            cache.status
          )
        )
      );

      // ---- 卡片 2：常用设置 ----
      var commonRows = [];
      // ---- 三条播报文案（放在最前：改完文字就能点下面的「生成」）----
      commonRows.push(
        React.createElement(
          "div",
          { key: "texts-title", style: subText },
          "改下面的三条文案 → 点「🎙 生成语音」即可一键更新（会先自动保存文案，再合成新语音；完成后这里会显示「语音更新成功」）。"
        )
      );
      KINDS.forEach(function (kind) {
        commonRows.push(
          React.createElement(
            "div",
            { key: "text-" + kind, style: rowStyle },
            React.createElement("span", { style: Object.assign({}, fieldLabel, { minWidth: "72px" }) }, LABELS[kind]),
            React.createElement("input", {
              id: "dva-text-" + kind,
              type: "text",
              defaultValue: cache.texts[kind] || "",
              placeholder: "播报文案",
              style: inputStyle
            }),
            React.createElement(
              "button",
              { id: "dva-preview-" + kind, type: "button", style: buttonStyle, onClick: function () { preview(kind); }, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2, onMouseDown: pressIn2, onMouseUp: pressOut2 },
              "试听"
            )
          )
        );
      });
      commonRows.push(
        React.createElement(
          "div",
          { key: "voice-note", style: rowStyle },
          React.createElement("span", { style: fieldLabel }, "音色备注"),
          React.createElement("input", {
            id: "dva-voice-note",
            type: "text",
            defaultValue: cache.voiceNote || "",
            placeholder: "给这个音色起个你喜欢的名字（只写在本机）",
            style: inputStyle
          }),
          React.createElement("span", { id: "dva-voice-note-policy", style: subText }, "")
        )
      );
      commonRows.push(
        React.createElement(
          "div",
          { key: "prosody", style: rowStyle },
          React.createElement("span", { style: fieldLabel }, "语速"),
          React.createElement("input", { id: "dva-speed_ratio", type: "number", step: "0.01", min: "0.2", max: "4", defaultValue: String(cache.prosody.speed_ratio), style: Object.assign({}, inputStyle, { flex: "0 0 88px", minWidth: "88px" }) }),
          React.createElement("span", { style: fieldLabel }, "音调"),
          React.createElement("input", { id: "dva-pitch_ratio", type: "number", step: "0.01", min: "0.2", max: "4", defaultValue: String(cache.prosody.pitch_ratio), style: Object.assign({}, inputStyle, { flex: "0 0 88px", minWidth: "88px" }) }),
          React.createElement("span", { style: fieldLabel }, "音量"),
          React.createElement("input", { id: "dva-volume_ratio", type: "number", step: "0.01", min: "0.2", max: "4", defaultValue: String(cache.prosody.volume_ratio), style: Object.assign({}, inputStyle, { flex: "0 0 88px", minWidth: "88px" }) })
        )
      );
      commonRows.push(
        React.createElement(
          "div",
          { key: "actions", style: Object.assign({}, rowStyle, { flexWrap: "wrap" }) },
          React.createElement(
            "button",
            { id: "dva-generate", type: "button", style: btnPrimary, onClick: generateAll, onMouseEnter: hoverIn, onMouseLeave: hoverOut, onMouseDown: pressIn, onMouseUp: pressOut },
            "🎙 生成语音（一键更新）"
          ),
          React.createElement(
            "button",
            { id: "dva-save", type: "button", style: btnSecondary, onClick: saveSettings, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2, onMouseDown: pressIn2, onMouseUp: pressOut2 },
            "保存设置"
          ),
          React.createElement(
            "label",
            { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "rgba(255,255,255,.7)", cursor: "pointer" } },
            React.createElement("input", {
              id: "dva-force",
              type: "checkbox",
              title: "勾上后本次会把三条语音全部重新合成（真实调用 TTS，耗时耗额度）；提交后自动取消勾选。平时不用勾：改了文案/语速/音调只会自动重做有改动的那条。"
            }),
            "强制重新生成（仅本次）"
          ),
          React.createElement("span", { style: subText }, "（默认只重合成有改动的条目；勾上「仅本次」= 三条全部重做；生成会备份旧文件并自动做响度增益）")
        )
      );
      // ---- 克隆入口：想换成其他音色去哪（用户要求把网址写进界面）----
      commonRows.push(
        React.createElement(
          "div",
          { key: "clone-entry", style: Object.assign({}, rowStyle, { flexWrap: "wrap", alignItems: "baseline" }) },
          React.createElement("span", { style: fieldLabel }, "克隆音色"),
          React.createElement(
            "span",
            { id: "dva-clone-note", style: subText },
            "想换成其他音色：到火山引擎「声音复刻」上传一段录音克隆（约 5~20 秒），拿到 S_ 开头的音色 ID 后填进「高级设置」里的音色库即可。"
          ),
          React.createElement(
            "a",
            { id: "dva-clone-link", href: "https://console.volcengine.com/speech/app", target: "_blank", rel: "noreferrer", style: { color: "#58a6ff", fontSize: "13px" } },
            "打开声音复刻控制台"
          ),
          React.createElement(
            "a",
            { id: "dva-clone-link-doc", href: "https://www.volcengine.com/product/voicecloning", target: "_blank", rel: "noreferrer", style: { color: "#58a6ff", fontSize: "13px" } },
            "产品介绍/开通"
          )
        )
      );
      rows.push(
        React.createElement(
          "div",
          { key: "card-common", style: cardStyle },
          React.createElement("span", { style: cardTitle }, "🎙 我的音色 · 语音合成"),
          commonRows
        )
      );

      // ---- 卡片 3：高级设置（默认折叠，仅影响可见性） ----
      // 三条文案已移到上方「我的音色 · 语音合成」卡（它们是最常用的操作）。
      var advancedRows = [];
      advancedRows.push(
        React.createElement(
          "div",
          { key: "tts-key", style: rowStyle },
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
      advancedRows.push(
        React.createElement(
          "div",
          { key: "voice-lib-title", style: Object.assign({}, cardTitle, { marginTop: "4px" }) },
          "音色库"
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
          { key: "voice-add", style: rowStyle },
          React.createElement("input", { id: "dva-vadd-id", type: "text", placeholder: "音色 ID（S_ 开头=克隆，其余=预设）", style: inputStyle }),
          React.createElement("input", { id: "dva-vadd-note", type: "text", placeholder: "备注", style: Object.assign({}, inputStyle, { flex: "0 0 110px", minWidth: "110px" }) }),
          React.createElement("button", { id: "dva-vadd-go", type: "button", style: buttonStyle, onClick: voiceAdd, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 }, "添加")
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "voice-import", style: rowStyle },
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
            { style: rowStyle },
            React.createElement("button", { id: "dva-vimport-go", type: "button", style: buttonStyle, onClick: voiceImportExec, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 }, "执行导入"),
            React.createElement("button", { id: "dva-vimport-close", type: "button", style: buttonStyle, onClick: function () { var p = el("dva-vimport-panel"); if (p) p.style.display = "none"; }, onMouseEnter: hoverIn2, onMouseLeave: hoverOut2 }, "收起")
          )
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "preset-key", style: rowStyle },
          React.createElement("span", { style: Object.assign({}, fieldLabel, { minWidth: "96px" }) }, "预设音色 Key"),
          React.createElement("input", { id: "dva-preset-key", type: "password", defaultValue: "", placeholder: "ark-…（留空不修改）", style: inputStyle }),
          React.createElement("span", { id: "dva-preset-key-state", style: subText }, "读取中…")
        )
      );
      advancedRows.push(
        React.createElement(
          "div",
          { key: "voice-actions", style: rowStyle },
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
            "高级设置"
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
        { "data-dva-slot": "1", style: { fontFamily: FONT, display: "flex", flexDirection: "column", gap: "12px", padding: "10px 4px", lineHeight: "1.6" } },
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
      pollJob: pollJob
    };
    return module.exports;
  }
});
