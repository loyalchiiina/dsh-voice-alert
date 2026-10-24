// dsh-voice-alert - host half.
//
// What it does
//   Deterministically plays a fixed MP3 (the user's cloned voice) on two events of a
//   DSH conversation, WITHOUT depending on the model remembering to call a skill:
//     * one turn finished              -> voice-alert-complete-poetic-loud.mp3
//     * an error / failed tool call    -> voice-alert-fail-poetic-loud.mp3
//   The files are played through the shared zero-interference python player or the
//   bundled MCI player (both winmm/MCI "play as-is": they never touch the system
//   volume or the mute state), launched through the hidden-powershell ->
//   Start-Process chain described in player.js.
//
//   Since v0.2.0 it also ships a CLIENT half (lib/client.js): a DSH settings
//   section where the three sentences and the prosody ratios can be edited and the
//   MP3s regenerated on the spot (TTS -> raw file -> loudness gain -> backup).
//
// Event sources - all verified in the installed official bundles, see engine.js
// for the file/line evidence: `session/event` (turn/start, turn/end),
// `agent/error`, `tools/result` (result.isError).
//
// Config lives in <home>/.dsh/data/dsh-voice-alert/config.json (created with
// defaults on first run). The cordis bundle row `config` overrides the file.
// 🔴 The TTS api key lives ONLY in that runtime file (or DSH_VOICE_ALERT_TTS_KEY).
//
// HTTP routes (loopback only). NOTE for DSH Desktop: the desktop shell wraps every
// route with its browser-access fence, so an ordinary local request without the
// renderer capability header is answered 403 "forbidden" (see lib/control.js) -
// the renderer (settings section) passes, curl does not. The credential-free twin
// of the routes is the file control channel:
//   trigger : write "kind=complete|fail|approval" into <data>\control.txt
//   status  : read <data>\status.json
//   GET  /status            -> resolved config + counters
//   GET  /play?kind=...     -> real playback, for post-restart checks
//   GET  /reload            -> re-read config.json without restart
//   GET  /settings          -> copy + prosody + generate state (settings section)
//   POST /settings          -> save copy + prosody
//   POST /generate          -> 202 + async TTS/gain run
//   GET  /generate-status   -> poll the run
//   POST /preview?kind=...  -> audition the current file for one kind

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  resolveConfig,
  ensureConfigFile,
  saveEditableConfig,
  saveVoicesConfig,
  normalizeEditablePatch,
  normalizeVoices,
  parseVoiceImport,
  mergeVoiceImport,
  resolveVoice,
  voiceKeyErrorCode,
  DEFAULT_CONFIG,
  VOICE_KIND_ROUTES,
  VOICE_PROBE_TEXT,
  VOICE_CLONE_CONSOLE_URL,
  VOICE_CLONE_PRODUCT_URL,
  VOICE_CLONE_NOTE,
  DATA_DIR,
  PLAY_KINDS,
  ALERT_MODES,
  SFX_CATALOG,
  DEFAULT_SFX_BY_KIND,
  isKnownSfxKey,
} from "./config.js";
import { createControlChannel } from "./control.js";
import { createEngine } from "./engine.js";
import { createGenerator, importMarkerPath, resolveFfmpeg } from "./generate.js";
import { readMp3DurationMsFromFile } from "./mp3info.js";
import { bundledPlayerPath, loudFileFor, originalFileFor, playKind, playSfx, resolveAudio, resolvePython, sfxPathFor } from "./player.js";
import { synthesize } from "./tts.js";

const ROUTE_PREFIX = "/dsh-voice-alert";

// Version read from package.json so it can never drift from the release.
const PKG_VERSION = (function () {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
  } catch (_) {
    return "unknown";
  }
})();

export const name = "dsh-voice-alert";

function errText(error) {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

/** File + host logger. Every write is best-effort: logging may never break alerts. */
function makeLogger(config, ctx) {
  let state = { bytes: 0, checked: false };
  return function log(message) {
    const line = "[" + new Date().toISOString() + "] " + message;
    try {
      if (ctx && ctx.logger && typeof ctx.logger.info === "function") ctx.logger.info("dsh-voice-alert: " + message);
    } catch (_) {
      /* logger gone during unload */
    }
    try {
      mkdirSync(dirname(config.logPath), { recursive: true });
      if (!state.checked) {
        state.checked = true;
        if (existsSync(config.logPath)) state.bytes = statSync(config.logPath).size;
      }
      if (state.bytes > config.logMaxBytes) {
        try {
          renameSync(config.logPath, config.logPath + ".1");
        } catch (_) {
          /* rotation is best-effort */
        }
        state.bytes = 0;
      }
      appendFileSync(config.logPath, line + "\n", { encoding: "utf8" });
      state.bytes += Buffer.byteLength(line, "utf8") + 1;
    } catch (_) {
      /* silent degradation */
    }
  };
}

function isLoopback(req) {
  const address = (req.socket && req.socket.remoteAddress) || "";
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return normalized.slice(7).startsWith("127.");
  return normalized.startsWith("127.");
}

function sendJson(res, code, payload) {
  try {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  } catch (error) {
    try {
      res.end();
    } catch (_) {
      /* client gone */
    }
  }
}

/**
 * Stream one audio file to the browser as a download. Binary, so it must NOT go
 * through sendJson (JSON.stringify would mangle the bytes).
 * The filename is always a fixed ASCII name supplied by the caller, never
 * derived from the request, so Content-Disposition can never be injected.
 * @returns true when the file was written, false when it fell back to a JSON error.
 */
function sendFile(res, filePath, downloadName) {
  try {
    const buffer = readFileSync(filePath);
    res.writeHead(200, {
      "content-type": "audio/mpeg",
      "content-length": String(buffer.length),
      "content-disposition": 'attachment; filename="' + String(downloadName) + '"',
      "cache-control": "no-store",
    });
    res.end(buffer);
    return true;
  } catch (error) {
    sendJson(res, 500, { ok: false, reason: errText(error) });
    return false;
  }
}

/**
 * Import/undo helpers. The marker PATH itself comes from generate.js
 * (`importMarkerPath`): that module reads the marker to decide whether a
 * synthesis run may overwrite a user-supplied clip, so the writer here must use
 * the exact same path or the guard would silently miss.
 */

/** `-loud` unless the user configured another suffix (matches player.js). */
function loudSuffixOf(config) {
  const suffix = config.loudSuffix;
  if (suffix === undefined || suffix === null || suffix === "") return "-loud";
  return String(suffix);
}

/** The origin / loud pair for one kind, in that order, as {name, path} pairs. */
function audioPairFor(kind, config) {
  const suffix = loudSuffixOf(config);
  const originName = "voice-alert-" + kind + "-poetic.mp3";
  const loudName = "voice-alert-" + kind + "-poetic" + suffix + ".mp3";
  return [
    { name: originName, path: join(String(config.audioOriginDir), originName) },
    { name: loudName, path: join(String(config.audioDir), loudName) },
  ];
}

/**
 * Mount the plugin.
 * @param ctx - cordis context.
 * @param configRow - bundle row config from cordis.patch.yml (optional).
 * @param deps - test seam: { play, configPath, now, env } (cordis never passes it).
 */
export function apply(ctx, configRow, deps) {
  const seams = deps || {};
  const options = {};
  if (seams.configPath !== undefined) options.configPath = seams.configPath;
  if (seams.env) options.env = seams.env;

  // Placeholder logger for the config resolution phase (real one needs the config).
  let log = function () {};

  const config = resolveConfig(configRow, Object.assign({ log: function (message) { log("config: " + message); } }, options));
  log = makeLogger(config, ctx);

  if (config.writeDefaultConfigOnStart !== false && options.configPath === undefined) {
    ensureConfigFile(undefined, log);
  }

  log("host half mounting: version=" + PKG_VERSION + " config=" + config._meta.configState + " enabled=" + String(config.enabled) + " dataDir=" + DATA_DIR);

  // 解析**真实可用**的 python 并写回内存 config（下游播放/生成/音量探测全用它）。
  // 为什么必须有这一步（2026-09-16 开源发现）：默认值若是本机路径，开源版在别人机器上直接播不出声；
  // 若简单改成 "python"，又会命中 Windows 的 WindowsApps 应用执行别名存根（返回 9009，什么都不做）。
  try {
    const python = resolvePython(config);
    if (python.source === "fallback") {
      log(
        "WARNING: no usable python interpreter found (tried config / where python / py) - playback will fail; set pythonPath in config.json",
      );
    } else if (python.path !== config.pythonPath) {
      log("python resolved: " + String(config.pythonPath) + " -> " + python.path + " (via " + python.source + ")");
    }
    config.pythonPath = python.path;
  } catch (error) {
    log("python resolution failed: " + errText(error));
  }

  // Status-file refresh is throttled: a burst of cues must not rewrite the file
  // once per cue, but a reader must never see a snapshot older than ~1s.
  let lastStatusFlush = 0;
  function refreshStatus(force) {
    const at = Date.now();
    if (!force && at - lastStatusFlush < 1000) return;
    lastStatusFlush = at;
    control.writeStatus();
  }

  /**
   * Playback bookkeeping. `playingUntil` lets the generator wait instead of
   * fighting a cue of the same kind for the file (2026-09-15 EBUSY incident), and
   * `lastPlayed` feeds the settings section.
   */
  const playingUntil = new Map();

  // ---- 真实 MP3 时长（2026-10-24）--------------------------------------------
  // 旧实现按固定码率（192k / 160k）从字节数反推时长。实测本机 cue 是 64 kbps CBR：
  // 21.43s 的台词只算成 7.15s（−67%），播放槽位提前 14s 释放 → 下一个试听抢声卡
  // → 静默无声（「有时点试听没声音」的根因），生成器也误判空闲而撞 EBUSY。音效还是
  // 128k VBR，单一常量永远不准；导入功能又允许用户放整首歌进来，更无「典型码率」可言。
  // 所以改成解析 MP3 帧头拿真实时长；旧公式保留作 fallback，只给坏文件/非 mp3 兜底。
  function audioSizeOf(p) {
    return statSync(p).size;
  }
  function audioReadRange(p, start, end) {
    const length = end - start;
    const buffer = Buffer.alloc(length);
    const fd = openSync(p, "r");
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    return buffer;
  }
  /** 真实时长（ms）；解析不出来就返回 null，让调用方兜底。只读头部 64KB，不整文件入内存。 */
  function realPlayMs(file) {
    if (!file) return null;
    return readMp3DurationMsFromFile(file, audioSizeOf, audioReadRange);
  }

  function notePlayback(kind) {
    try {
      const file = resolveAudio(kind, config).file;
      // 先问 MP3 帧头要真实时长（64 kbps 的台词按 192k 折算只有 7.1s，实际 21.4s）；
      // 解析不出来才退回旧的按字节估算。上限 120s：导入功能允许整首歌当提示音。
      const real = realPlayMs(file);
      let estimatedMs;
      if (real !== null) {
        estimatedMs = Math.min(120000, Math.max(1500, real));
      } else {
        const bytes = file && existsSync(file) ? statSync(file).size : 0;
        estimatedMs = bytes > 0 ? Math.min(120000, Math.max(1500, Math.round((bytes * 8 * 1000) / 192000))) : 6000;
      }
      playingUntil.set(kind, Date.now() + estimatedMs);
    } catch (_) {
      playingUntil.set(kind, Date.now() + 6000);
    }
  }
  function isPlayingNow(kind) {
    const until = playingUntil.get(kind);
    return typeof until === "number" && Date.now() < until;
  }
  async function waitWhilePlaying(kind, timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000);
    while (Date.now() < deadline) {
      if (!isPlayingNow(kind)) return true;
      await new Promise(function (resolve) { setTimeout(resolve, 200); });
    }
    return !isPlayingNow(kind);
  }

  /**
   * 试听/播报串行化（2026-09-16 用户报告「有时点试听没声音」）。
   *
   * 每次播放都是一个独立的 python + MCI 进程；两个进程同时抢声卡时，后一个会**静默
   * 失败**——不报错，就是没声音。所以所有播放入口先排队：等上一个放完（按时长估算）
   * 再开新的。真机用 Date.now()；测试环境（注入了 now seam）直接放行，保持确定性。
   */
  const deterministicClock = typeof seams.now === "function";
  let playbackBusyUntil = 0;
  /** 估算音频播放时长（ms）：优先解析 MP3 帧头拿真实时长，坏文件才按 160 kbps 折算兜底。 */
  function estimatePlayMs(file) {
    try {
      // 同上：真实解析优先（实测 cue 是 64 kbps，按 160k 折算会把 21.4s 算成 8.6s，
      // 槽位提前释放就抢声卡）；旧公式留作兜底，上限 120s 以容纳导入的整首歌。
      const real = realPlayMs(file);
      if (real !== null) return Math.min(120000, Math.max(1200, real));
      const bytes = file && existsSync(file) ? statSync(file).size : 0;
      return bytes > 0 ? Math.min(120000, Math.max(1200, Math.round((bytes * 8 * 1000) / 160000))) : 5000;
    } catch (_) {
      return 5000;
    }
  }
  function playbackBusy() {
    return Date.now() < playbackBusyUntil;
  }
  function occupyPlaybackSlot(ms) {
    playbackBusyUntil = Date.now() + (Number(ms) > 0 ? Number(ms) : 5000) + 300; // +300ms 让出设备
  }
  /** 试听路由用：等到设备空闲，返回前已经占用下一个槽位。 */
  async function acquirePlaybackSlot(file) {
    const ms = estimatePlayMs(file);
    if (!deterministicClock) {
      // 等待上限必须跟着「当前占着设备的音频有多长」走，不能用固定次数：
      // 导入 MP3 允许整首歌（clamp 上限 120s），固定 200×120ms=24s 的 guard 会在
      // 长音频还没放完时就放弃等待 → 新进程照样抢声卡 → 静默无声。
      // 所以改成「剩余占用时长 + 5s 余量」的截止时间；pollMs 保持 120ms 的轮询节奏。
      const pollMs = 120;
      const deadline = Date.now() + Math.max(0, playbackBusyUntil - Date.now()) + 5000;
      while (playbackBusy() && Date.now() < deadline) {
        await new Promise(function (resolve) { setTimeout(resolve, pollMs); });
      }
    }
    occupyPlaybackSlot(ms);
  }

  /**
   * The one and only "a cue is happening now" path.
   *
   * Gateway order matters: the master switch and the alert mode are checked BEFORE
   * the test seam, so a seam can never make a disabled plugin audible. Then the cue
   * is either a built-in sound effect (alertMode=sfx, no TTS call at all) or the
   * user's cloned-voice line (the original behaviour).
   */
  const play = function (kind, meta) {
    if (config.enabled === false) {
      log("play skipped: master switch off (kind=" + String(kind) + ")");
      return;
    }
    if (config.alertMode === "off") {
      log("play skipped: alertMode=off (kind=" + String(kind) + ")");
      return;
    }
    const mode = config.alertMode === "sfx" ? "sfx" : "voice";
    const sfxKey = mode === "sfx"
      ? String((config.sfxByKind && config.sfxByKind[kind]) || DEFAULT_SFX_BY_KIND[kind] || "")
      : "";
    if (typeof seams.play === "function") {
      seams.play(kind, meta, config, { mode, sfxKey });
      return;
    }
    const result = mode === "sfx" ? playSfx(sfxKey, config, log) : playKind(kind, config, log);
    log(
      "play(" +
        kind +
        ") mode=" +
        mode +
        (mode === "sfx" ? " key=" + sfxKey : "") +
        " source=" +
        (meta && meta.source ? meta.source : "?") +
        " -> " +
        JSON.stringify(result),
    );
  };

  const playAndRecord = function (kind, meta) {
    notePlayback(kind);
    // 设备忙（例如正在试听）时排队，避免两个 python 播放器抢声卡导致两边都没声音。
    // 只有真机排队：测试环境用假时钟，保持同步播出自测断言才稳定。
    if (!deterministicClock && playbackBusy()) {
      log("play queued: audio device busy (kind=" + String(kind) + ")");
      void acquirePlaybackSlot(resolveAudio(kind, config).file).then(function () {
        play(kind, meta);
        refreshStatus(false);
      });
      return;
    }
    occupyPlaybackSlot(estimatePlayMs(resolveAudio(kind, config).file));
    play(kind, meta);
    refreshStatus(false);
  };

  const engine = createEngine({
    config,
    play: playAndRecord,
    log,
    now: seams.now,
  });

  // One-click generation (TTS -> raw -> loudness gain -> backup) for the settings
  // section. onChanged keeps status.json fresh while a long run is in flight.
  const generator = createGenerator({
    config,
    log,
    fetchImpl: seams.fetchImpl,
    isPlaying: isPlayingNow,
    waitWhilePlaying,
    onChanged: function () {
      refreshStatus(true);
    },
  });

  /**
   * Read-only system master volume probe. It runs the shared audio_state.py WITHOUT
   * --unmute, so nothing here can change the volume or the mute state; the result is
   * cached briefly because the settings section refreshes often.
   */
  let volumeCache = { at: 0, value: null };
  function readSystemVolume() {
    const cacheMs = Number(config.volumeProbeCacheMs);
    if (volumeCache.value && cacheMs > 0 && Date.now() - volumeCache.at < cacheMs) return volumeCache.value;
    const value = { ok: false, volumePercent: null, muted: null, source: "unavailable", error: null };
    try {
      if (!config.volumeProbeScript || !existsSync(config.volumeProbeScript)) {
        value.error = "audio_state.py not found: " + String(config.volumeProbeScript);
      } else {
        const probe = spawnSync(config.pythonPath, [String(config.volumeProbeScript)], {
          windowsHide: true,
          encoding: "utf8",
          timeout: Number(config.volumeProbeTimeoutMs) > 0 ? Number(config.volumeProbeTimeoutMs) : 8000,
        });
        const output = String(probe.stdout || "");
        const volume = /VOL=([\d.]+)%/u.exec(output);
        const muted = /MUTED=(True|False)/u.exec(output);
        if (volume) {
          value.ok = true;
          value.volumePercent = Number(volume[1]);
          value.muted = muted ? muted[1] === "True" : null;
          value.source = "audio_state.py (read-only)";
        } else {
          value.error = "unexpected probe output: " + output.slice(0, 120);
        }
      }
    } catch (error) {
      value.error = errText(error);
    }
    volumeCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Which kinds currently play a user-imported MP3 instead of a synthesised one
   * (marker file present). Echoed by /settings and /status so the UI can show
   * "已导入" and offer the undo button without a second round-trip.
   */
  function importedKindsPayload() {
    const out = {};
    for (const kind of PLAY_KINDS) {
      let present = false;
      try {
        present = existsSync(importMarkerPath(kind, config));
      } catch (_) {
        present = false;
      }
      out[kind] = present;
    }
    return out;
  }

  /** Payload of GET /settings - also the shape the settings section renders. */
  function settingsPayload() {
    const volume = readSystemVolume();
    return {
      ok: true,
      plugin: name,
      version: PKG_VERSION,
      imported: importedKindsPayload(),
      texts: Object.assign({}, config.texts),
      prosody: Object.assign({}, config.prosody),
      speaker: config.tts.speaker, // FIXED voice: shown as text, never as a picker
      voiceNote: config.voiceNote,
      // Master switch + alert mode (requirement B): the settings section renders the
      // three-way mode picker from these values plus the shipped effect catalogue.
      enabled: config.enabled !== false,
      alertMode: config.alertMode,
      sfxDir: config.sfxDir,
      sfxByKind: Object.assign({}, config.sfxByKind),
      sfxCatalog: SFX_CATALOG.map(function (item) {
        return { key: item.key, name: item.name, group: item.group };
      }),
      alertModeNote:
        "语音播报 = 用你自己的音色朗读三条文案；音效 = 播放内置音效（不调用 TTS、不需要 API Key）；关闭 = 不提醒。",
      // 在哪里克隆自己的音色（用户 2026-09-16 要求把网址写进界面）。
      cloneConsoleUrl: VOICE_CLONE_CONSOLE_URL,
      cloneProductUrl: VOICE_CLONE_PRODUCT_URL,
      cloneNote: VOICE_CLONE_NOTE,
      voicePolicyNote: "音色固定为你自己克隆的音色，不可更换；备注只写在本机 config.json。",
      apiKeyPresent: Boolean(config.tts.apiKey),
      // Never echo the stored key: the UI only needs to know THAT it exists, plus a
      // short prefix so the user can tell which key is installed.
      apiKeyMask: config.tts.apiKey ? String(config.tts.apiKey).slice(0, 8) + "…" : "",
      apiKeyHint: config.tts.apiKey
        ? ""
        : "未配置 TTS API Key：请在下方填写（或写进 config.json 的 tts.apiKey / 环境变量 DSH_VOICE_ALERT_TTS_KEY）",
      keyStorageNote: "此 Key 只保存在本机 config.json（~/.dsh/data/dsh-voice-alert/config.json），不会写入插件源码，也不会外传。",
      systemVolume: volume,
      systemVolumeNote: "试听无声时请先检查系统音量；本插件不会修改系统音量，也不会修改静音状态。",
      tts: {
        endpoint: config.tts.endpoint,
        resourceId: config.tts.resourceId,
        model: config.tts.model,
        format: config.tts.format,
        sampleRate: config.tts.sampleRate,
      },
      audio: {
        audioDir: config.audioDir,
        originDir: config.audioOriginDir,
        backupsDir: config.audioBackupsDir,
        loudSuffix: config.loudSuffix,
        keepBackupSets: config.keepBackupSets,
      },
      gain: {
        filter: config.gainFilter,
        ffmpeg: resolveFfmpeg(config),
        targets: {
          meanMinDb: config.gainMinMeanDb,
          meanMaxDb: config.gainMaxMeanDb,
          maxPeakDb: config.gainMaxPeakDb,
        },
      },
      voices: voicesLibraryPayload(),
      generate: generator.snapshot(),
    };
  }

  /**
   * The voice library payload shared by /settings and GET /voices: the full
   * list with per-voice availability (which key its kind needs and whether it
   * is present) plus the current selection. Keys are NEVER echoed.
   */
  function voicesLibraryPayload() {
    const statuses = {};
    const list = (Array.isArray(config.voices) ? config.voices : []).map(function (voice) {
      const route = voice.kind === "preset" ? VOICE_KIND_ROUTES.preset : VOICE_KIND_ROUTES.clone;
      const keyPresent = voiceKeyErrorCode(config, voice) === null;
      statuses[voice.id] = {
        kind: voice.kind,
        label: route ? route.label : (voice.kind === "preset" ? "预设音色" : "克隆音色"),
        keyField: route ? route.keyField : null,
        keyPresent,
        keyError: keyPresent ? null : voiceKeyErrorCode(config, voice),
      };
      return {
        id: voice.id,
        note: String(voice.note || ""),
        kind: voice.kind,
        enabled: voice.enabled !== false,
      };
    });
    return {
      list,
      statuses,
      selectedVoiceId: config.selectedVoiceId || "",
      presetApiKeyPresent: Boolean(config.presetApiKey),
      apiKeyPresent: Boolean(config.tts && config.tts.apiKey),
      apiKeyMask: config.tts.apiKey ? String(config.tts.apiKey).slice(0, 8) + "…" : "",
      presetApiKeyMask: config.presetApiKey ? String(config.presetApiKey).slice(0, 8) + "…" : "",
      probeText: VOICE_PROBE_TEXT,
    };
  }

  /**
   * One shared status payload for BOTH faces of the plugin: the credential-free
   * status.json file and the loopback /status route. On DSH Desktop the route is
   * additionally gated by the shell's browser-access fence (see control.js), so
   * the file is the face an ordinary local script can actually read.
   */
  function statusPayload() {
    const snapshot = engine.snapshot();
    return {
      ok: true,
      plugin: name,
      version: PKG_VERSION,
      imported: importedKindsPayload(),
      enabled: snapshot.enabled,
      configPath: config._meta.configPath,
      configState: config._meta.configState,
      player: {
        pythonPath: config.pythonPath,
        pythonExists: existsSync(config.pythonPath),
        playerScript: config.playerScript,
        playerExists: existsSync(config.playerScript),
        bundledPlayer: bundledPlayerPath(config),
        bundledPlayerExists: existsSync(String(bundledPlayerPath(config))),
        fallbackBeep: config.fallbackBeep !== false,
        // Every cue plays from a scratch copy so the production mp3 is never locked.
        playbackCopyEnabled: config.playbackCopyEnabled !== false,
        playbackTempDir: config.playbackTempDir,
      },
      apiKeyPresent: Boolean(config.tts.apiKey),
      apiKeyMask: config.tts.apiKey ? String(config.tts.apiKey).slice(0, 8) + "…" : "",
      voiceNote: config.voiceNote,
      audio: {
        preferLoudAudio: config.preferLoudAudio !== false,
        audioDir: config.audioDir,
        originalsDir: config.originalsDir,
        resolved: PLAY_KINDS.map(function (kind) {
          const picked = resolveAudio(kind, config);
          return {
            kind,
            mode: picked.mode,
            file: picked.file,
            candidates: picked.candidates.map(function (candidate) {
              return { mode: candidate.mode, file: candidate.file, exists: existsSync(candidate.file) };
            }),
          };
        }),
      },
      rules: {
        playOnTurnEnd: config.playOnTurnEnd !== false,
        playFailOnError: config.playFailOnError !== false,
        turnEndPlaysFailWhenErrored: config.turnEndPlaysFailWhenErrored !== false,
        skipSubagentSessions: config.skipSubagentSessions !== false,
        countSubagentErrors: config.countSubagentErrors === true,
        errorMinIntervalMs: config.errorMinIntervalMs,
        suppressCompleteAfterFailMs: config.suppressCompleteAfterFailMs,
        failOncePerTurn: config.failOncePerTurn !== false,
        abortPlays: config.abortPlays,
      },
      control: {
        mode: "file",
        controlFile: config.controlFile,
        controlResultFile: config.controlResultFile,
        statusFile: config.statusFile,
        pollMs: config.controlPollMs,
        note:
          "On DSH Desktop every HTTP route is gated by the shell's browser-access fence " +
          "(resources/app/lib/webserver.js -> decideDesktopBrowserAccess), so an uncredentialed " +
          "curl/Invoke-WebRequest gets 403 forbidden. Use the control file instead: write " +
          "'kind=complete' into controlFile and this plugin plays it within pollMs.",
      },
      counters: snapshot.stats,
      runtime: {
        openTurns: snapshot.openTurns,
        announcedKeys: snapshot.announcedKeys,
        lastFailAt: snapshot.lastFailAt,
      },
      // Compact generation view (the settings section polls /generate-status for
      // the full record; this keeps status.json self-describing).
      generate: (function () {
        const job = generator.snapshot();
        return {
          running: job.running,
          jobId: job.jobId,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          error: job.error,
          apiKeyPresent: job.apiKeyPresent,
          backupDir: job.backupDir,
          outputs: Object.keys(job.outputs).map(function (kind) {
            const entry = job.outputs[kind];
            return {
              kind,
              ok: Boolean(entry && entry.ok),
              bytes: entry ? entry.bytes : 0,
              meanDb: entry && entry.gain ? entry.gain.mean : null,
              maxDb: entry && entry.gain ? entry.gain.max : null,
              gainSkipped: Boolean(entry && entry.gainSkipped),
              error: entry ? entry.error : null,
            };
          }),
        };
      })(),
    };
  }

  const control = createControlChannel({
    config,
    log,
    playManual: function (kind) {
      const result = engine.playManual(kind);
      log("manual play via control file: kind=" + kind);
      return result;
    },
    statusPayload,
  });

  // Test seam: the offline self-check drives poll()/writeStatus() directly.
  if (typeof seams.onControlReady === "function") {
    try {
      seams.onControlReady(control, engine);
    } catch (error) {
      log("onControlReady seam threw: " + errText(error));
    }
  }

  // Event wiring. ctx.on() disposes with the plugin fiber - no manual bookkeeping.
  try {
    ctx.on("session/event", function (session, event) {
      engine.onSessionEvent(session, event);
    });
    ctx.on("agent/error", function (payload) {
      engine.onAgentError(payload);
    });
    ctx.on("tools/result", function (exec, result) {
      engine.onToolResult(exec, result);
    });
    log("listeners armed: session/event (turn/start, turn/end), agent/error, tools/result");
  } catch (error) {
    log("could not arm listeners: " + errText(error));
  }

  // Credential-free control channel: file trigger + status snapshot.
  try {
    ctx.effect(function () {
      const stop = control.start();
      return function () {
        stop();
        log("control channel stopped");
      };
    }, "dsh-voice-alert: control channel");
    if (config.writeStatusOnStart !== false) control.writeStatus();
    // Play once at startup so an imminent status reader sees fresh data.
    control.poll();
  } catch (error) {
    log("control channel not armed: " + errText(error));
  }

  // Diagnostic routes: optional, never gate the core voice feature on webServer.
  try {
    ctx.inject(["webServer"], function (webCtx) {
      const routes = [];
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/status",
        handler: function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          sendJson(res, 200, statusPayload());
          control.writeStatus();
        },
      }));
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/play",
        handler: function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          let kind = "complete";
          try {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            kind = url.searchParams.get("kind") || "complete";
          } catch (_) {
            /* keep default */
          }
          if (PLAY_KINDS.indexOf(kind) < 0) return sendJson(res, 400, { ok: false, reason: "kind must be one of " + PLAY_KINDS.join("|") });
          log("manual play requested: kind=" + kind);
          sendJson(res, 200, engine.playManual(kind));
          control.writeStatus();
        },
      }));
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/reload",
        handler: function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          const fresh = resolveConfig(configRow, Object.assign({ log: function (m) { log("reload: " + m); } }, options));
          Object.assign(config, fresh);
          log("config reloaded from " + String(config._meta.configPath));
          sendJson(res, 200, { ok: true, configState: config._meta.configState, enabled: config.enabled });
        },
      }));

      // ---- settings section data channel -------------------------------------
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/settings",
        handler: async function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          const method = String(req.method || "GET").toUpperCase();
          if (method === "GET") return sendJson(res, 200, settingsPayload());
          if (method !== "POST") return sendJson(res, 405, { ok: false, reason: "use GET or POST" });
          const body = await readJsonBody(req, 64 * 1024);
          if (!body.ok) return sendJson(res, 400, { ok: false, reason: body.reason });
          const applied = normalizeEditablePatch(body.value);
          // Persist (production) and apply in memory (so the change is live even
          // before a reload; tests run with configPath: null and only apply).
          let persisted = { ok: true, skipped: true };
          if (options.configPath !== null) {
            persisted = saveEditableConfig(options.configPath, applied, log);
          }
          Object.assign(config.texts, applied.texts);
          Object.assign(config.prosody, applied.prosody);
          if (applied.tts && typeof applied.tts.apiKey === "string") {
            config.tts.apiKey = applied.tts.apiKey;
          }
          if (typeof applied.voiceNote === "string") {
            config.voiceNote = applied.voiceNote;
          }
          // Master switch / alert mode / per-event effect: applied live so the change
          // takes effect without a reload (and before the next cue).
          if (typeof applied.enabled === "boolean") {
            config.enabled = applied.enabled;
          }
          if (typeof applied.alertMode === "string") {
            config.alertMode = applied.alertMode;
          }
          if (applied.sfxByKind && Object.keys(applied.sfxByKind).length > 0) {
            config.sfxByKind = Object.assign({}, config.sfxByKind || {}, applied.sfxByKind);
          }
          log(
            "settings saved: texts=" +
              String(Object.keys(applied.texts).length) +
              " prosody=" +
              String(Object.keys(applied.prosody).length) +
              " apiKey=" +
              String(Boolean(applied.tts && applied.tts.apiKey)) +
              " voiceNote=" +
              String(typeof applied.voiceNote === "string") +
              " enabled=" +
              String(typeof applied.enabled === "boolean" ? applied.enabled : "(unchanged)") +
              " alertMode=" +
              String(typeof applied.alertMode === "string" ? applied.alertMode : "(unchanged)") +
              " sfxByKind=" +
              String(Object.keys(applied.sfxByKind || {}).length) +
              " persisted=" +
              String(persisted.ok),
          );
          control.writeStatus();
          sendJson(res, persisted.ok ? 200 : 500, Object.assign(settingsPayload(), {
            persisted: { ok: persisted.ok, path: persisted.path || null, skipped: Boolean(persisted.skipped), reason: persisted.reason || null },
            applied,
          }));
        },
      }));
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/generate",
        handler: async function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          if (String(req.method || "GET").toUpperCase() !== "POST") return sendJson(res, 405, { ok: false, reason: "use POST" });
          const body = await readJsonBody(req, 64 * 1024);
          const wanted = body.ok && Array.isArray(body.value && body.value.kinds) ? body.value.kinds.filter(function (kind) {
            return PLAY_KINDS.indexOf(kind) >= 0;
          }) : null;
          const force = Boolean(body.ok && body.value && body.value.force === true);
          // Optional voice override: generate with a specific speakerId instead of
          // the currently selected voice (requirement A).
          const speakerId = body.ok && body.value && typeof body.value.speakerId === "string" ? body.value.speakerId : undefined;
          const started = generator.start(wanted && wanted.length > 0 ? wanted : PLAY_KINDS, "settings", { force, speakerId });
          if (started.accepted) {
            log("generate: accepted (" + (wanted && wanted.length > 0 ? wanted.join(",") : "all") + " force=" + String(force) + ")");
            return sendJson(res, 202, Object.assign({ ok: true }, started));
          }
          if (started.reason === "nothing-changed") {
            log("generate: nothing changed - reusing existing audio, no TTS call");
            return sendJson(res, 200, Object.assign({ ok: true }, started));
          }
          const code = started.reason === "already-running" ? 409 : 400;
          log("generate: rejected (" + String(started.reason) + ")");
          sendJson(res, code, Object.assign({ ok: false }, started));
        },
      }));
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/generate-status",
        handler: function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          sendJson(res, 200, Object.assign({ ok: true }, generator.snapshot()));
        },
      }));

      // ---- voice library (requirement A) -----------------------------------
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/voices",
        handler: function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          sendJson(res, 200, { ok: true, ...voicesLibraryPayload() });
        },
      }));

      // Save the WHOLE library slice: voices array (full replace) + the current
      // selection + the preset Agent-Plan key. Persisted into config.json so
      // hand-added voices survive restarts.
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/voices/save",
        handler: async function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          if (String(req.method || "GET").toUpperCase() !== "POST") return sendJson(res, 405, { ok: false, reason: "use POST" });
          const body = await readJsonBody(req, 256 * 1024);
          if (!body.ok) return sendJson(res, 400, { ok: false, reason: body.reason });
          const value = body.value || {};
          const patch = {
            voices: Array.isArray(value.voices) ? value.voices : undefined,
            selectedVoiceId: typeof value.selectedVoiceId === "string" ? value.selectedVoiceId : undefined,
            presetApiKey: typeof value.presetApiKey === "string" ? value.presetApiKey.trim() : undefined,
            // 显式清空开关（v0.4.15）：只有明确传 true 才允许把已存的 key 清掉。
            clearPresetApiKey: value.clearPresetApiKey === true,
          };
          const normalized = normalizeVoices(patch.voices);
          if (normalized !== null) config.voices = normalized;
          if (patch.selectedVoiceId !== undefined) config.selectedVoiceId = patch.selectedVoiceId;
          // 守卫（v0.4.15）：空串 = "不改"，不是 "清空"。UI 的 Key 输入框平时是空的
          // （占位文案「留空表示不修改」），此前每次保存音色库都会提交空串把已存
          // key 抹掉。这里改成：非空才覆盖，空串只在 clearPresetApiKey===true 时清空。
          if (patch.clearPresetApiKey) {
            config.presetApiKey = "";
          } else if (patch.presetApiKey !== undefined && patch.presetApiKey.length > 0) {
            config.presetApiKey = patch.presetApiKey;
          }
          let persisted = { ok: true, skipped: true };
          if (options.configPath !== null) {
            persisted = saveVoicesConfig(options.configPath, { voices: config.voices, selectedVoiceId: config.selectedVoiceId, presetApiKey: config.presetApiKey }, log);
          }
          log("voices/save: " + String(config.voices.length) + " voice(s), selected=" + String(config.selectedVoiceId) + " presetKey=" + String(Boolean(config.presetApiKey)) + " persisted=" + String(persisted.ok));
          control.writeStatus();
          sendJson(res, persisted.ok ? 200 : 500, Object.assign({ ok: true }, voicesLibraryPayload(), {
            persisted: { ok: persisted.ok, path: persisted.path || null, skipped: Boolean(persisted.skipped), reason: persisted.reason || null },
            saved: { voices: config.voices.length, selectedVoiceId: config.selectedVoiceId, presetApiKeySet: Boolean(config.presetApiKey) },
          }));
        },
      }));

      // Batch-import voices: multi-line "ID,备注" text OR a JSON array. Kind is
      // auto-detected (S_* = clone, else preset); ids already in the library are
      // skipped, so re-importing is idempotent.
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/voices/import",
        handler: async function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          if (String(req.method || "GET").toUpperCase() !== "POST") return sendJson(res, 405, { ok: false, reason: "use POST" });
          const body = await readJsonBody(req, 256 * 1024);
          if (!body.ok) return sendJson(res, 400, { ok: false, reason: body.reason });
          const value = body.value || {};
          const raw = value.voices !== undefined ? value.voices : value.text;
          const imported = parseVoiceImport(raw);
          const before = config.voices.length;
          config.voices = mergeVoiceImport(config.voices, imported);
          const added = config.voices.length - before;
          let persisted = { ok: true, skipped: true };
          if (options.configPath !== null) {
            persisted = saveVoicesConfig(options.configPath, { voices: config.voices, selectedVoiceId: config.selectedVoiceId, presetApiKey: config.presetApiKey }, log);
          }
          log("voices/import: parsed=" + String(imported.length) + " added=" + String(added) + " total=" + String(config.voices.length));
          control.writeStatus();
          sendJson(res, persisted.ok ? 200 : 500, Object.assign({ ok: true }, voicesLibraryPayload(), {
            parsed: imported.length,
            added,
            skipped: imported.length - added,
            persisted: { ok: persisted.ok, path: persisted.path || null, skipped: Boolean(persisted.skipped), reason: persisted.reason || null },
          }));
        },
      }));

      // 试合 probe: one REAL ~20-char synthesis (no file written, no artifact
      // touched) to verify the voice+key path. The vendor error code/message is
      // echoed back on failure.
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/voices/probe",
        handler: async function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          if (String(req.method || "GET").toUpperCase() !== "POST") return sendJson(res, 405, { ok: false, reason: "use POST" });
          const body = await readJsonBody(req, 64 * 1024);
          const speakerId = body.ok && body.value && typeof body.value.speakerId === "string" ? body.value.speakerId : undefined;
          const voiceSel = resolveVoice(config, speakerId);
          const keyError = voiceKeyErrorCode(config, voiceSel.voice);
          if (keyError) {
            log("voices/probe refused: " + keyError + " (" + voiceSel.speakerId + ")");
            return sendJson(res, 400, {
              ok: false,
              reason: keyError,
              speakerId: voiceSel.speakerId,
              kind: voiceSel.kind,
              error: keyError === "preset-key-missing" ? "预设音色需要 Agent Plan Key（ark-…），请在 config.json 的 presetApiKey 或设置页填写" : "未配置 TTS API Key",
            });
          }
          const result = await synthesize({
            text: VOICE_PROBE_TEXT,
            config,
            voice: voiceSel.voice,
            log,
            fetchImpl: seams.fetchImpl,
          });
          log("voices/probe: " + voiceSel.speakerId + " ok=" + String(result.ok) + " bytes=" + String(result.bytes || 0) + " error=" + String(result.error || "-"));
          sendJson(res, result.ok ? 200 : 502, {
            ok: Boolean(result.ok),
            speakerId: voiceSel.speakerId,
            kind: voiceSel.kind,
            bytes: result.ok ? result.bytes.length : 0,
            code: result.code === undefined ? null : result.code,
            error: result.ok ? null : (result.error || "probe failed"),
            reason: result.reason || null,
          });
        },
      }));

      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/preview",
        handler: async function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          let kind = "complete";
          try {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            kind = url.searchParams.get("kind") || "complete";
          } catch (_) {
            /* keep default */
          }
          if (PLAY_KINDS.indexOf(kind) < 0) return sendJson(res, 400, { ok: false, reason: "kind must be one of " + PLAY_KINDS.join("|") });
          // Audition the CURRENT file without touching the engine's fail bookkeeping
          // (a preview must never suppress the next real "complete" cue).
          const picked = resolveAudio(kind, config);
          // 排队等设备空闲：连点试听时前一个播放还没放完，直接开第二个会静默无声。
          await acquirePlaybackSlot(picked.file);
          const result = playKind(kind, config, log);
          log("preview: kind=" + kind + " audio=" + picked.mode + " ok=" + String(result.ok));
          sendJson(res, 200, { ok: Boolean(result.ok), kind, audioMode: picked.mode, audioFile: picked.file, result });
        },
      }));
      // ---- sound effects (requirement B) --------------------------------------
      // The effect library itself. The catalogue lives in config.js, so the settings
      // section never has to ship its own copy of the 20 names; `present` reports
      // whether the mp3 is actually on disk (a user may prune the folder).
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/sfx/list",
        handler: function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          const items = SFX_CATALOG.map(function (item) {
            const file = sfxPathFor(item.key, config);
            return {
              key: item.key,
              name: item.name,
              group: item.group,
              present: Boolean(file) && existsSync(file),
            };
          });
          const present = items.filter(function (item) {
            return item.present;
          }).length;
          sendJson(res, 200, {
            ok: true,
            dir: config.sfxDir,
            alertMode: config.alertMode,
            sfxByKind: Object.assign({}, config.sfxByKind),
            present,
            total: items.length,
            items,
          });
        },
      }));
      // Audition ONE effect. Like /preview this never touches the engine's fail
      // bookkeeping, so试听 can never suppress or fake a real cue.
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/sfx/play",
        handler: async function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          let name = "";
          try {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            name = url.searchParams.get("name") || "";
          } catch (_) {
            /* keep default */
          }
          // Whitelist, not a path check: only catalogue keys may reach the player, so
          // a crafted `name` can never make the player open an arbitrary file.
          if (!isKnownSfxKey(name)) {
            log("sfx/play rejected: unknown key " + JSON.stringify(name));
            return sendJson(res, 400, { ok: false, reason: "name must be a catalogue key", key: name });
          }
          // 同样排队：连点试听时等上一个放完，否则第二个播放器抢声卡会没声音。
          await acquirePlaybackSlot(sfxPathFor(name, config));
          const result = playSfx(name, config, log);
          log("sfx/play: key=" + name + " ok=" + String(result.ok));
          sendJson(res, 200, { ok: Boolean(result.ok), key: name, result });
        },
      }));
      // ---- audio download / import (v0.4.x) -----------------------------------
      // Two binary routes so the settings section can hand the user the current
      // MP3 and take one back. Neither touches the engine, the config or the
      // generator: download is a pure read, import writes the file pair the
      // player already reads (origin + loud) and drops the stale WAV cache.
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/audio/download",
        handler: function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          let kind = "complete";
          let variant = "loud";
          try {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            kind = url.searchParams.get("kind") || "complete";
            variant = url.searchParams.get("variant") || "loud";
          } catch (_) {
            /* keep defaults */
          }
          if (PLAY_KINDS.indexOf(kind) < 0) return sendJson(res, 400, { ok: false, reason: "kind must be one of " + PLAY_KINDS.join("|") });
          if (variant !== "loud" && variant !== "origin") {
            return sendJson(res, 400, { ok: false, reason: "variant must be loud|origin" });
          }
          // resolveAudio() ranks candidates (loud first, then original); read the
          // file for the requested variant, falling back to the canonical path
          // when that variant is not in the candidate list at all
          // (preferLoudAudio=false drops the loud candidate).
          const resolved = resolveAudio(kind, config);
          const wanted = variant === "loud" ? "loud" : "original";
          let file = null;
          for (const candidate of resolved.candidates || []) {
            if (candidate.mode === wanted) file = candidate.file;
          }
          if (!file) file = variant === "loud" ? loudFileFor(kind, config) : originalFileFor(kind, config);
          if (!file || !existsSync(file)) {
            log("audio/download miss: kind=" + kind + " variant=" + variant + " file=" + String(file));
            return sendJson(res, 404, { ok: false, reason: "audio file not found", kind, variant });
          }
          const downloadName = "voice-alert-" + kind + "-" + variant + ".mp3";
          if (sendFile(res, file, downloadName)) log("audio/download: kind=" + kind + " variant=" + variant + " file=" + file);
        },
      }));
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/audio/import",
        handler: async function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          const method = String(req.method || "GET").toUpperCase();
          if (method !== "POST") return sendJson(res, 405, { ok: false, reason: "use POST" });
          let kind = "complete";
          try {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            kind = url.searchParams.get("kind") || "complete";
          } catch (_) {
            /* keep default */
          }
          if (PLAY_KINDS.indexOf(kind) < 0) return sendJson(res, 400, { ok: false, reason: "kind must be one of " + PLAY_KINDS.join("|") });
          const body = await readBinaryBody(req, 10 * 1024 * 1024);
          if (!body.ok) return sendJson(res, 400, { ok: false, reason: body.reason });
          if (!looksLikeMp3(body.buffer)) {
            log("audio/import rejected: not an mp3, kind=" + kind + " bytes=" + String(body.buffer.length));
            return sendJson(res, 400, { ok: false, reason: "not an mp3" });
          }
          try {
            const pair = audioPairFor(kind, config);
            const originPath = pair[0].path;
            const loudPath = pair[1].path;
            const markerPath = importMarkerPath(kind, config);
            // 1) fresh backup folder
            mkdirSync(config.audioBackupsDir, { recursive: true });
            const backupDir = join(String(config.audioBackupsDir), "import-" + importStamp());
            mkdirSync(backupDir, { recursive: true });
            // 2) keep the previous pair AND the previous marker, so an import can be
            // undone back to the state before it (a backup failure must never block
            // the import itself).
            const previous = pair.concat([{ name: markerPath.replace(/^.*[\\/]/u, ""), path: markerPath }]);
            for (const source of previous) {
              try {
                if (!existsSync(source.path)) continue;
                copyFileSync(source.path, join(backupDir, source.name));
              } catch (error) {
                log("audio/import backup failed: " + source.path + " -> " + errText(error));
              }
            }
            // 3) origin original, 4) loud copy (same bytes: the browser upload is
            // already the file the user wants to hear)
            mkdirSync(dirname(originPath), { recursive: true });
            writeFileSync(originPath, body.buffer);
            mkdirSync(dirname(loudPath), { recursive: true });
            writeFileSync(loudPath, body.buffer);
            // 4b) marker: "this cue plays the user's own file". lib/generate.js reads
            // it and skips the TTS overwrite; /audio/import/undo consumes it.
            const marker = {
              kind,
              bytes: body.buffer.length,
              importedAt: new Date().toISOString(),
              backupDir,
              sha256: createHash("sha256").update(body.buffer).digest("hex"),
            };
            writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", { encoding: "utf8" });
            // 5) the wav cache for this kind is now stale
            try {
              const wav = join(String(config.wavCacheDir), "voice-alert-" + kind + "-poetic-loud.wav");
              if (existsSync(wav)) unlinkSync(wav);
            } catch (error) {
              log("audio/import wav cache cleanup failed: " + errText(error));
            }
            log("audio/import: kind=" + kind + " bytes=" + String(body.buffer.length) + " backup=" + backupDir);
            sendJson(res, 200, {
              ok: true,
              kind,
              bytes: body.buffer.length,
              origin: originPath,
              loud: loudPath,
              backupDir,
              marker: markerPath,
            });
          } catch (error) {
            log("audio/import failed: kind=" + kind + " " + errText(error));
            sendJson(res, 500, { ok: false, reason: errText(error) });
          }
        },
      }));
      // Undo one import: copy the pair that the import backed up back into place,
      // drop the marker and the now-stale WAV cache. Registered after /audio/import
      // and with a longer path, so exact matching never confuses the two.
      routes.push(webCtx.webServer.register({
        kind: "exact",
        path: ROUTE_PREFIX + "/audio/import/undo",
        handler: function (req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
          const method = String(req.method || "GET").toUpperCase();
          if (method !== "POST") return sendJson(res, 405, { ok: false, reason: "use POST" });
          let kind = "complete";
          try {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            kind = url.searchParams.get("kind") || "complete";
          } catch (_) {
            /* keep default */
          }
          if (PLAY_KINDS.indexOf(kind) < 0) return sendJson(res, 400, { ok: false, reason: "kind must be one of " + PLAY_KINDS.join("|") });
          const markerPath = importMarkerPath(kind, config);
          if (!existsSync(markerPath)) return sendJson(res, 404, { ok: false, reason: "no import marker", kind });
          try {
            let backupDir = null;
            try {
              const marker = JSON.parse(readFileSync(markerPath, "utf8"));
              backupDir = marker && marker.backupDir ? String(marker.backupDir) : null;
            } catch (error) {
              log("audio/import/undo marker unreadable: " + errText(error));
              backupDir = null;
            }
            const restored = [];
            if (backupDir && existsSync(backupDir)) {
              for (const entry of audioPairFor(kind, config)) {
                const saved = join(backupDir, entry.name);
                if (!existsSync(saved)) continue;
                mkdirSync(dirname(entry.path), { recursive: true });
                copyFileSync(saved, entry.path);
                restored.push(entry.name);
              }
            }
            unlinkSync(markerPath);
            try {
              const wav = join(String(config.wavCacheDir), "voice-alert-" + kind + "-poetic-loud.wav");
              if (existsSync(wav)) unlinkSync(wav);
            } catch (error) {
              log("audio/import/undo wav cache cleanup failed: " + errText(error));
            }
            log("audio/import/undo: kind=" + kind + " restored=" + String(restored.length) + " backup=" + String(backupDir));
            sendJson(res, 200, { ok: true, kind, restored, markerDeleted: true });
          } catch (error) {
            log("audio/import/undo failed: kind=" + kind + " " + errText(error));
            sendJson(res, 500, { ok: false, reason: errText(error) });
          }
        },
      }));
      log("diagnostic routes mounted under " + ROUTE_PREFIX);
      return function () {
        for (const dispose of routes) {
          try {
            dispose();
          } catch (_) {
            /* already gone */
          }
        }
      };
    });
  } catch (error) {
    log("diagnostic routes not mounted: " + errText(error));
  }

  ctx.effect(function () {
    return function () {
      engine.dispose();
      log("host half unmounted");
    };
  }, "dsh-voice-alert: engine teardown");
}

/**
 * Read a JSON request body with a hard size cap. Never throws.
 * @returns { ok: true, value } | { ok: false, reason }
 */
export function readJsonBody(req, maxBytes) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 64 * 1024;
  return new Promise(function (resolve) {
    if (!req || typeof req.on !== "function") return resolve({ ok: true, value: {} });
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = function (result) {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > limit) {
        done({ ok: false, reason: "body too large (limit " + String(limit) + " bytes)" });
        try {
          req.destroy();
        } catch (_) {
          /* already closing */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", function (error) {
      done({ ok: false, reason: errText(error) });
    });
    req.on("end", function () {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) return done({ ok: true, value: {} });
      try {
        const parsed = JSON.parse(raw);
        done({ ok: true, value: parsed === null ? {} : parsed });
      } catch (error) {
        done({ ok: false, reason: "body is not JSON: " + errText(error) });
      }
    });
  });
}

/**
 * Read a raw (binary) request body with a hard size cap. Never throws.
 * Same contract as readJsonBody, but the bytes are kept verbatim.
 * @returns { ok: true, buffer } | { ok: false, reason }
 */
export function readBinaryBody(req, maxBytes) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 64 * 1024;
  return new Promise(function (resolve) {
    if (!req || typeof req.on !== "function") return resolve({ ok: true, buffer: Buffer.alloc(0) });
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = function (result) {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > limit) {
        done({ ok: false, reason: "body too large (limit " + String(limit) + " bytes)" });
        try {
          req.destroy();
        } catch (_) {
          /* already closing */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", function (error) {
      done({ ok: false, reason: errText(error) });
    });
    req.on("end", function () {
      done({ ok: true, buffer: Buffer.concat(chunks) });
    });
  });
}

/**
 * Loose MP3 sniffing. Only used to stop a mis-picked .wav/.zip from overwriting
 * the voice files: an ID3 tag, or an MPEG audio frame sync (0xFF Ex/Fx), or an
 * ID3v2 footer/APE-style trailer we accept as "audio the player can try".
 * Deliberately permissive - a valid file must never be rejected.
 */
export function looksLikeMp3(buffer) {
  try {
    if (!buffer || buffer.length < 2) return false;
    // ID3v2 tag ("ID3").
    if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
    // MPEG frame sync: 11 set bits, layer bits not 00, bitrate != 1111.
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
      const layer = (buffer[1] >> 1) & 0x03;
      const bitrate = (buffer[2] === undefined ? 0 : buffer[2]) >> 4;
      if (layer !== 0 && bitrate !== 0x0f) return true;
    }
    // A few encoders emit an ID3v1 trailer only; treat "TAG" at -128 as mp3.
    if (buffer.length >= 128) {
      const at = buffer.length - 128;
      if (buffer[at] === 0x54 && buffer[at + 1] === 0x41 && buffer[at + 2] === 0x47) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/** Filesystem-safe local timestamp for the import backup folder name. */
function importStamp() {
  const now = new Date();
  const pad = function (value) {
    return String(value).padStart(2, "0");
  };
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds()) +
    "-" +
    String(now.getMilliseconds()).padStart(3, "0")
  );
}

// Re-exported for the self-check / other tooling.
export { DEFAULT_CONFIG, resolveConfig, createEngine, playKind };
