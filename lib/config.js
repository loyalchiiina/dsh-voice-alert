// dsh-voice-alert - configuration resolution.
//
// Precedence (lowest -> highest):
//   1. DEFAULT_CONFIG (below)
//   2. the runtime config file  <home>/.dsh/data/dsh-voice-alert/config.json
//   3. the cordis bundle row `config` (the plugin's own cordis.patch.yml, or a
//      profile-level patch row)
//   4. environment overrides (DSH_VOICE_ALERT_PYTHON / _PLAYER / _LOG / _DISABLED)
//
// Every read/write is wrapped in try/catch: a broken or missing config file must
// never stop the voice alerts or the DSH host.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const PLUGIN_ID = "dsh-voice-alert";

/** Runtime data directory: survives plugin upgrades (it lives outside the plugin). */
export const DATA_DIR = join(homedir(), ".dsh", "data", PLUGIN_ID);
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const DEFAULT_LOG_PATH = join(DATA_DIR, "voice-alert.log");

/**
 * Credential-free local control channel (see lib/control.js).
 *
 * WHY IT EXISTS: on DSH Desktop EVERY HTTP route (ours included) is wrapped by
 * the desktop shell's browser-access fence, so an ordinary local request without
 * the Electron renderer's capability header is answered 403 "forbidden":
 *   DSH Desktop Beta resources/app/lib/webserver.js:42-53 (DesktopWebServer.permits
 *   -> rejectBrowserRequest) and desktop-browser-access-5-Ph3Uv7.js:47-51
 *   (decideDesktopBrowserAccess -> "denied" when ordinaryBrowserEnabled is false).
 * Dropping a file into the user's own data directory is the only local trigger
 * that needs no credential, so /play and /status have a file twin here.
 */
export const CONTROL_FILE = join(DATA_DIR, "control.txt");
export const CONTROL_RESULT_FILE = join(DATA_DIR, "control-result.txt");
export const STATUS_FILE = join(DATA_DIR, "status.json");

/**
 * Playback scratch directory. The player NEVER opens the production mp3 directly:
 * every cue is played from a throw-away copy here, so a "generate while a cue is
 * playing" can never hit EBUSY on the real artifact (2026-09-15 root cause).
 */
export const PLAY_COPY_DIR = join(tmpdir(), PLUGIN_ID, "play");

/** Snapshot of the last successful generation (drives "only regenerate changes"). */
export const GENERATE_STATE_FILE = join(DATA_DIR, "generate-state.json");

export const PLAY_KINDS = ["complete", "fail", "approval"];

/**
 * Alert mode (requirement B, 2026-09-16): ONE global switch decides what a cue is.
 *   voice -> the user's cloned-voice TTS lines (the original behaviour)
 *   sfx   -> a built-in sound effect (nature / reminder), no TTS call at all
 *   off   -> silence
 */
export const ALERT_MODES = ["voice", "sfx", "off"];

/** Directory holding the 20 built-in sound effects (shipped outside the plugin). */
export const SFX_DIR = join(DATA_DIR, "sfx");

/**
 * The built-in sound-effect catalogue. `key` is the file stem inside SFX_DIR
 * (<key>.mp3); `name` is what the settings section shows.
 *
 * Provenance (2026-09-16): the ten `remind-*` cues are Windows system sounds
 * converted to mp3 (plus one synthesized wooden-fish knock); the ten `nature-*`
 * cues come from pacdv.com and mixkit.co free sound-effect libraries. All were
 * re-encoded to mono 44.1 kHz mp3 (libmp3lame 128k) with a loudness pass, so the
 * whole set sits at a comparable level.
 */
export const SFX_CATALOG = [
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
  { key: "nature-forest", name: "森林", group: "大自然" },
];

/** Which effect each event plays while alertMode === "sfx". */
export const DEFAULT_SFX_BY_KIND = {
  complete: "remind-tada",
  fail: "remind-muyu",
  approval: "remind-dingdong",
};

/** True when `key` names a catalogue entry (and therefore a legal file stem). */
export function isKnownSfxKey(key) {
  return SFX_CATALOG.some(function (item) {
    return item.key === key;
  });
}

/**
 * Coerce a raw sfxByKind patch into {complete, fail, approval}. Unknown keys are
 * dropped (they would name a file that is not in the catalogue), so a hand-edited
 * config.json can never point the player at an arbitrary path.
 * @returns { complete?, fail?, approval? } - only the keys that were valid.
 */
export function normalizeSfxByKind(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const kind of PLAY_KINDS) {
    const raw = value[kind];
    if (typeof raw === "string" && isKnownSfxKey(raw.trim())) out[kind] = raw.trim();
  }
  return out;
}

/** Directory holding the generated LOUD copies (built by dev-audio-loud.ps1). */
export const AUDIO_DIR = join(DATA_DIR, "audio");

/** Raw TTS output lands here (before the loudness gain). */
export const AUDIO_ORIGIN_DIR = join(AUDIO_DIR, "origin");

/** One timestamped backup set per generation run. */
export const AUDIO_BACKUPS_DIR = join(AUDIO_DIR, "backups");

/**
 * 未做响度增益的原始语音放在哪（开源版不假设任何本机路径，放插件自己的数据目录；
 * 已有 config.json 的 originalsDir 优先级更高，老用户不受影响）。
 */
export const ORIGINALS_DIR = join(DATA_DIR, "originals");

/** ffmpeg 用于响度增益；默认让系统在 PATH 里找（resolveFfmpeg 会探测），也可在 config.json 写绝对路径。 */
export const FFMPEG_PATH = "ffmpeg";

/**
 * FIXED DEFAULT VOICE. The settings section deliberately offers no voice picker for
 * the DEFAULT voice: it is whatever clone the user installed (id read from config.json),
 * and the display name is the user's own note — the plugin ships no person/character
 * name of its own, because it is meant to be handed to other people (2026-09-16).
 */
export const TTS_SPEAKER = "";

/** Editable-by-UI fractions of the config (the settings section writes only these). */
export const EDITABLE_TEXT_KEYS = ["complete", "fail", "approval"];
export const EDITABLE_PROSODY_KEYS = ["speed_ratio", "pitch_ratio", "volume_ratio"];

/** Default copy for the three cues (the poem-reading lines the user approved). */
export const DEFAULT_TEXTS = {
  complete: "美美的完成啦，你来看一看好不好。",
  fail: "好像有点小情况，劳烦你来看一看哦。",
  approval: "有一件事，想请你拿个主意呢。",
};

/** Default reading prosody (same ratios the shipped poetic files were made with). */
export const DEFAULT_PROSODY = { speed_ratio: 1.05, pitch_ratio: 1.04, volume_ratio: 1.0 };

/**
 * Human note shown next to the voice id. EMPTY by default: the plugin never invents a
 * voice name (the旧默认值带了具体人名，2026-09-16 用户要求去掉——别人装插件时不该看到
 * 某个人/角色的名字)。使用者自己填想要的称呼，只存在本机 config.json。
 */
export const DEFAULT_VOICE_NOTE = "";

/**
 * 在哪里克隆自己的音色（设置页会显示这两个入口）。
 * 已查证 2026-09-16：火山引擎语音技术控制台 → 声音复刻；产品页用于了解/开通。
 */
export const VOICE_CLONE_CONSOLE_URL = "https://console.volcengine.com/speech/app";
export const VOICE_CLONE_PRODUCT_URL = "https://www.volcengine.com/product/voicecloning";
export const VOICE_CLONE_NOTE =
  "想换成其他音色：到火山引擎「声音复刻」上传一段录音克隆音色（约 5 秒~20 秒音频），拿到 S_ 开头的音色 ID，填进下面的音色库即可使用。";

/**
 * 默认音色库：**空**（2026-09-16 开源决定）。
 *
 * 插件不内置任何具体音色：克隆音色是各人自己的（在火山「声音复刻」做），预设音色要自己的
 * Agent Plan Key。使用者按 README 填自己的音色即可；不想折腾就用「音效」提醒模式（零配置）。
 * 老用户的 config.json 里已有 voices 数组，优先级更高，不受这里影响。
 */
export const DEFAULT_VOICES = [];

/** Which endpoint/resource each voice kind uses. */
export const VOICE_KIND_ROUTES = {
  clone: {
    endpoint: "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    resourceId: "seed-icl-2.0",
    keyField: "apiKey",
    label: "克隆音色",
  },
  preset: {
    endpoint: "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional",
    resourceId: "seed-tts-2.0",
    keyField: "presetApiKey",
    label: "预设音色（需 Agent Plan Key）",
  },
};

/** Text used by the "试合验证" button (must stay short: <= 20 chars). */
export const VOICE_PROBE_TEXT = "你好，这是一句试音。";

/** Voice availability marks (kept out of config.json so hand edits stay clean). */
export const VOICE_STATE_FILE = join(DATA_DIR, "voice-state.json");

/** Machine defaults. Every one of them is overridable from config.json. */
export const DEFAULT_CONFIG = {
  _readme:
    "dsh-voice-alert config. enabled=false turns every alert off. complete/fail are the two wired events; approval is reachable only through the manual /play route. Loudness: the ORIGINAL poetic mp3s measure mean_volume about -20.8 dB and the system master volume is only 9% (the user will NOT change it), so louder copies (volume=+26dB + alimiter 0.98, mean about -8.7 dB, peak <= 0.0 dB) are generated into audioDir and preferred by default - the originals are never modified and system volume/mute are never touched. Set preferLoudAudio=false to play the originals.",
  enabled: true,
  // ---- what a cue IS (requirement B, 2026-09-16) ----
  // voice -> the user's cloned-voice TTS lines, sfx -> a built-in sound effect, off -> silence.
  // One global switch for all three events; sfxByKind picks the effect per event.
  // 开源默认：音效模式 —— 装完即用，不需要任何 Key / 音频文件。
  // （语音模式需要使用者自己配火山 Key 并生成语音；老用户 config.json 里是 voice，不受影响。）
  alertMode: "sfx",
  sfxDir: SFX_DIR,
  sfxByKind: DEFAULT_SFX_BY_KIND,
  playOnTurnEnd: true,
  playFailOnError: true,
  turnEndPlaysFailWhenErrored: true,
  skipSubagentSessions: true,
  countSubagentErrors: false,
  errorMinIntervalMs: 5000,
  suppressCompleteAfterFailMs: 3000,
  abortPlays: "none",
  // python 解释器：默认交给 PATH 探测（player.js 的 resolvePython 会验证并跳过
  // WindowsApps 存根、取 sys.executable 真实路径）。使用者也可在 config.json 写绝对路径。
  pythonPath: "python",
  // 可选的共享播放器路径；留空则只用插件自带的 lib/play_mp3_mci.py（开源默认）。
  playerScript: "",
  preferLoudAudio: true,
  loudSuffix: "-loud",
  audioDir: AUDIO_DIR,
  originalsDir: ORIGINALS_DIR,
  bundledPlayer: "lib\\play_mp3_mci.py",
  fallbackBeep: true,
  logPath: DEFAULT_LOG_PATH,
  logMaxBytes: 1048576,
  dedupeCacheSize: 500,
  controlFile: CONTROL_FILE,
  controlResultFile: CONTROL_RESULT_FILE,
  statusFile: STATUS_FILE,
  controlPollMs: 2000,
  writeStatusOnStart: true,
  writeDefaultConfigOnStart: true,
  // ---- custom copy + one-click generation (settings section) ----
  texts: DEFAULT_TEXTS,
  prosody: DEFAULT_PROSODY,
  tts: {
    // 🔴 apiKey lives ONLY in the runtime config file (or DSH_VOICE_ALERT_TTS_KEY);
    // it must never be committed into the plugin source (publish red line).
    apiKey: "",
    endpoint: "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    resourceId: "seed-icl-2.0",
    model: "seed-tts-2.0-standard",
    speaker: TTS_SPEAKER,
    format: "mp3",
    sampleRate: 24000,
    timeoutMs: 120000,
  },
  audioOriginDir: AUDIO_ORIGIN_DIR,
  audioBackupsDir: AUDIO_BACKUPS_DIR,
  keepBackupSets: 10,
  gainFilter: "volume=+26dB,alimiter=limit=0.95:level=disabled",
  ffmpegPath: FFMPEG_PATH,
  // volumedetect acceptance window for the loud copy (the shipped files sit at
  // mean about -8.5 dB / peak <= -0.5 dB, which is what "loud enough" means here).
  gainMinMeanDb: -11.0,
  gainMaxMeanDb: -6.0,
  gainMaxPeakDb: -0.4,
  // Generation hardening (2026-09-15 EBUSY incident):
  gainRetryCount: 5,
  gainRetryDelayMs: 400,
  reuseUnchanged: true,
  generateStateFile: GENERATE_STATE_FILE,
  voiceNote: DEFAULT_VOICE_NOTE,
  // ---- voice library (requirement A) ----
  // The FULL library array, replaceable in one go by POST /voices/save and
  // persisted into config.json so hand-added voices survive restarts.
  voices: DEFAULT_VOICES,
  // Agent-Plan key (ark-…) used by every `preset` voice. Lives in the runtime
  // config only, exactly like tts.apiKey. Empty => preset synthesis is refused
  // with preset-key-missing instead of silently using the wrong key.
  presetApiKey: "",
  // The voice the one-click generation synthesizes with by default.
  selectedVoiceId: "",
  // Playback scratch copy: never hand the production file to the player.
  playbackCopyEnabled: true,
  playbackTempDir: PLAY_COPY_DIR,
  playbackCopyMaxAgeMs: 600000,
  // 预热静音毫秒数：**0 = 不预热（默认）**。
  // 教训（2026-09-16 用户实测）：v0.3.5 为修「蓝牙耳机第一声没声音」加了 350ms 静音预热，
  // 但它让蓝牙链路在播报前**多开关一次音频端点**，于是**打断正在播放的音乐**；去掉预热后立即恢复正常。
  // 而"首声没声音"的真因通常是**默认音频设备没正确登记**（见 README §5.1）。
  // 万一某些设备确实需要唤醒链路，把它设成 350 即可恢复旧行为。
  prewarmMs: 0,
  // 播放内核（2026-09-16 实测后定默认）：
  //   "wav"（默认）= winsound/waveOut 播 WAV（由 ffmpeg 一次性转好并缓存）；
  //   "mci"        = winmm/MCI "type mpegvideo"（DirectShow），旧行为，保留为可选。
  // 为什么默认 wav：同一台机器 + 同一副蓝牙耳机（EDIFIER Lolli Pro 5）实测对比 ——
  //   MCI/DirectShow：经常第一声没声音、且会把正在播的音乐打断；
  //   waveOut：3 声全部正常、音乐不被打断。
  // 原因：MCI 走 DirectShow 会创建播放图并打开/枚举音频端点，蓝牙链路会重协商；
  // waveOut 是 Windows 最基础的播放路径，不启 DirectShow、不枚举设备、不改端点格式。
  // 代价：首次播放每个音频转一次 wav（实测 ~60ms、200~300KB，之后命中缓存）。
  playerEngine: "wav",
  wavCacheDir: join(DATA_DIR, "wav-cache"),
  // Read-only system volume probe (never changes volume/mute).
  // 可选的系统音量探测脚本；留空时设置页显示「未配置」（只是少一个提示，不影响播报）。
  volumeProbeScript: "",
  volumeProbeCacheMs: 10000,
  volumeProbeTimeoutMs: 8000,
};

function errText(error) {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

function pick(object, key, fallback) {
  if (object === null || object === undefined) return fallback;
  const value = object[key];
  return value === undefined ? fallback : value;
}

/** Read + parse the runtime config file. Never throws. */
export function readConfigFile(configPath) {
  const file = configPath || CONFIG_PATH;
  try {
    if (!existsSync(file)) return { ok: false, reason: "missing", path: file, data: {} };
    const raw = readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, reason: "not-an-object", path: file, data: {} };
    }
    return { ok: true, reason: "loaded", path: file, data };
  } catch (error) {
    return { ok: false, reason: "parse-failed: " + errText(error), path: file, data: {} };
  }
}

/** Write the default config file once, so the user has something to edit. */
export function ensureConfigFile(configPath, log) {
  const file = configPath || CONFIG_PATH;
  try {
    if (existsSync(file)) return { ok: true, created: false, path: file };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", { encoding: "utf8" }); // utf8 -> no BOM
    if (log) log("default config written: " + file);
    return { ok: true, created: true, path: file };
  } catch (error) {
    if (log) log("could not write default config (" + file + "): " + errText(error));
    return { ok: false, created: false, path: file, reason: errText(error) };
  }
}

function num(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Merge one nested block across three layers (defaults <- file <- row) key by key.
 * @param coerce - (value, fallback) => value, the per-key type guard.
 */
function mergeBlock(baseBlock, fileBlock, rowBlock, keys, coerce) {
  const out = {};
  for (const key of keys) {
    const fallback = baseBlock[key];
    const fromFile = fileBlock && typeof fileBlock === "object" ? fileBlock[key] : undefined;
    const fromRow = rowBlock && typeof rowBlock === "object" ? rowBlock[key] : undefined;
    out[key] = coerce(fromRow === undefined ? fromFile : fromRow, fallback);
  }
  return out;
}

/**
 * Validate a UI patch down to the editable slice (texts + prosody + tts.apiKey).
 * Non-string texts and out-of-range ratios are dropped, never coerced to junk.
 *
 * The API key rule is deliberately "empty means UNCHANGED": the settings section
 * never echoes the stored key, so an empty box must not wipe it. A supplied key
 * must be a single token (no whitespace) within a sane length.
 *
 * @returns { texts: {}, prosody: {}, tts: { apiKey? } }
 */
export function normalizeEditablePatch(patch) {
  const source = patch && typeof patch === "object" ? patch : {};
  const texts = {};
  const prosody = {};
  const sourceTexts = source.texts && typeof source.texts === "object" ? source.texts : {};
  for (const key of EDITABLE_TEXT_KEYS) {
    const value = sourceTexts[key];
    if (typeof value === "string" && value.trim().length > 0) texts[key] = value.trim();
  }
  const sourceProsody = source.prosody && typeof source.prosody === "object" ? source.prosody : {};
  for (const key of EDITABLE_PROSODY_KEYS) {
    const value = Number(sourceProsody[key]);
    if (Number.isFinite(value) && value >= 0.2 && value <= 4) prosody[key] = value;
  }
  const tts = {};
  const sourceTts = source.tts && typeof source.tts === "object" ? source.tts : {};
  if (typeof sourceTts.apiKey === "string") {
    const key = sourceTts.apiKey.trim();
    if (key.length > 0 && key.length <= 512 && !/\s/u.test(key)) tts.apiKey = key;
  }
  // voiceNote is free text: an explicit empty string is allowed (clears the note).
  const voiceNote = typeof source.voiceNote === "string" ? source.voiceNote.trim().slice(0, 200) : undefined;
  // Alert mode + master switch (requirement B): only an exact enum value / a real
  // boolean is accepted, so a broken UI patch can never leave the mode undefined.
  const enabledOut = typeof source.enabled === "boolean" ? source.enabled : undefined;
  const alertModeOut = ALERT_MODES.indexOf(source.alertMode) >= 0 ? source.alertMode : undefined;
  const sfxByKindOut = normalizeSfxByKind(source.sfxByKind);
  return { texts, prosody, tts, voiceNote, enabled: enabledOut, alertMode: alertModeOut, sfxByKind: sfxByKindOut };
}

/**
 * Persist the UI-editable slice (texts + prosody) back into config.json.
 * Reads the current file first so nothing else in it is lost, writes UTF-8 with
 * no BOM, and never throws.
 * @returns { ok, path?, reason?, applied? }
 */
export function saveEditableConfig(configPath, patch, log) {
  const file = configPath || CONFIG_PATH;
  const applied = normalizeEditablePatch(patch);
  try {
    const current = readConfigFile(file).data || {};
    const next = Object.assign({}, current);
    if (Object.keys(applied.texts).length > 0) {
      next.texts = Object.assign({}, current.texts || {}, applied.texts);
    }
    if (Object.keys(applied.prosody).length > 0) {
      next.prosody = Object.assign({}, current.prosody || {}, applied.prosody);
    }
    if (applied.tts && typeof applied.tts.apiKey === "string") {
      next.tts = Object.assign({}, current.tts || {}, { apiKey: applied.tts.apiKey });
    }
    if (typeof applied.voiceNote === "string") {
      next.voiceNote = applied.voiceNote;
    }
    // Alert mode / master switch / per-event effect (requirement B). Merged rather
    // than replaced so a patch naming one event keeps the other two.
    if (typeof applied.enabled === "boolean") {
      next.enabled = applied.enabled;
    }
    if (typeof applied.alertMode === "string") {
      next.alertMode = applied.alertMode;
    }
    if (applied.sfxByKind && Object.keys(applied.sfxByKind).length > 0) {
      // Defaults first, then whatever the file already had, then the patch: the file
      // always ends up naming all three events (readable when hand-edited), while a
      // one-event patch still cannot wipe the other two.
      next.sfxByKind = Object.assign({}, DEFAULT_SFX_BY_KIND, current.sfxByKind || {}, applied.sfxByKind);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8" }); // utf8 -> no BOM
    if (log) {
      log(
        "config.json updated (" +
          [
            Object.keys(applied.texts).length > 0 ? "texts" : null,
            Object.keys(applied.prosody).length > 0 ? "prosody" : null,
            applied.tts && applied.tts.apiKey ? "tts.apiKey" : null,
            typeof applied.voiceNote === "string" ? "voiceNote" : null,
            typeof applied.enabled === "boolean" ? "enabled" : null,
            typeof applied.alertMode === "string" ? "alertMode" : null,
            applied.sfxByKind && Object.keys(applied.sfxByKind).length > 0 ? "sfxByKind" : null,
          ]
            .filter(Boolean)
            .join(", ") +
          ") at " +
          file,
      );
    }
    return { ok: true, path: file, applied };
  } catch (error) {
    if (log) log("config.json update failed (" + file + "): " + errText(error));
    return { ok: false, path: file, reason: errText(error), applied };
  }
}

/**
 * Resolve the effective config.
 * @param rowConfig - the cordis bundle row config (may be undefined).
 * @param options - { configPath, env, log } - test seams; configPath: null skips the file.
 */
export function resolveConfig(rowConfig, options) {
  const opts = options || {};
  const configPath = opts.configPath === undefined ? CONFIG_PATH : opts.configPath;
  const env = opts.env || process.env;
  const log = opts.log;

  const file = configPath === null
    ? { ok: false, reason: "file-disabled", path: null, data: {} }
    : readConfigFile(configPath);

  const base = DEFAULT_CONFIG;
  const fromFile = file.data || {};
  const row = rowConfig && typeof rowConfig === "object" ? rowConfig : {};

  // key resolution: row config -> file -> built-in default
  const pickValue = function (key) {
    return pick(row, key, pick(fromFile, key, base[key]));
  };

  const resolved = {
    enabled: bool(pickValue("enabled"), base.enabled),
    // Alert mode: anything outside the enum (a typo in config.json) falls back to
    // the default instead of silently muting every alert.
    alertMode: (function () {
      const v = pickValue("alertMode");
      return ALERT_MODES.indexOf(v) >= 0 ? v : base.alertMode;
    })(),
    sfxDir: String(pickValue("sfxDir") || base.sfxDir),
    playOnTurnEnd: bool(pickValue("playOnTurnEnd"), base.playOnTurnEnd),
    playFailOnError: bool(pickValue("playFailOnError"), base.playFailOnError),
    turnEndPlaysFailWhenErrored: bool(pickValue("turnEndPlaysFailWhenErrored"), base.turnEndPlaysFailWhenErrored),
    skipSubagentSessions: bool(pickValue("skipSubagentSessions"), base.skipSubagentSessions),
    countSubagentErrors: bool(pickValue("countSubagentErrors"), base.countSubagentErrors),
    errorMinIntervalMs: num(pickValue("errorMinIntervalMs"), base.errorMinIntervalMs, 0, 600000),
    suppressCompleteAfterFailMs: num(
      pickValue("suppressCompleteAfterFailMs"),
      base.suppressCompleteAfterFailMs,
      0,
      600000,
    ),
    abortPlays: (function () {
      const v = pickValue("abortPlays");
      return v === "complete" || v === "fail" ? v : "none";
    })(),
    pythonPath: String(pickValue("pythonPath") || base.pythonPath),
    playerScript: String(pickValue("playerScript") || base.playerScript),
    preferLoudAudio: bool(pickValue("preferLoudAudio"), base.preferLoudAudio),
    loudSuffix: pickValue("loudSuffix") === undefined ? base.loudSuffix : String(pickValue("loudSuffix")),
    audioDir: String(pickValue("audioDir") || base.audioDir),
    originalsDir: String(pickValue("originalsDir") || base.originalsDir),
    bundledPlayer: String(pickValue("bundledPlayer") || base.bundledPlayer),
    fallbackBeep: bool(pickValue("fallbackBeep"), base.fallbackBeep),
    logPath: String(pickValue("logPath") || base.logPath),
    logMaxBytes: num(pickValue("logMaxBytes"), base.logMaxBytes, 4096, 104857600),
    dedupeCacheSize: num(pickValue("dedupeCacheSize"), base.dedupeCacheSize, 16, 100000),
    controlFile: String(pickValue("controlFile") || base.controlFile),
    controlResultFile: String(pickValue("controlResultFile") || base.controlResultFile),
    statusFile: String(pickValue("statusFile") || base.statusFile),
    controlPollMs: num(pickValue("controlPollMs"), base.controlPollMs, 250, 60000),
    writeStatusOnStart: bool(pickValue("writeStatusOnStart"), base.writeStatusOnStart),
    writeDefaultConfigOnStart: bool(pickValue("writeDefaultConfigOnStart"), base.writeDefaultConfigOnStart),
    audioOriginDir: String(pickValue("audioOriginDir") || base.audioOriginDir),
    audioBackupsDir: String(pickValue("audioBackupsDir") || base.audioBackupsDir),
    keepBackupSets: num(pickValue("keepBackupSets"), base.keepBackupSets, 1, 200),
    gainFilter: String(pickValue("gainFilter") || base.gainFilter),
    ffmpegPath: String(pickValue("ffmpegPath") || base.ffmpegPath),
    gainMinMeanDb: num(pickValue("gainMinMeanDb"), base.gainMinMeanDb, -60, 0),
    gainMaxMeanDb: num(pickValue("gainMaxMeanDb"), base.gainMaxMeanDb, -60, 0),
    gainMaxPeakDb: num(pickValue("gainMaxPeakDb"), base.gainMaxPeakDb, -60, 0),
    gainRetryCount: num(pickValue("gainRetryCount"), base.gainRetryCount, 1, 20),
    gainRetryDelayMs: num(pickValue("gainRetryDelayMs"), base.gainRetryDelayMs, 50, 5000),
    reuseUnchanged: bool(pickValue("reuseUnchanged"), base.reuseUnchanged),
    generateStateFile: String(pickValue("generateStateFile") || base.generateStateFile),
    voiceNote: String(pickValue("voiceNote") === undefined ? base.voiceNote : pickValue("voiceNote")),
    playbackCopyEnabled: bool(pickValue("playbackCopyEnabled"), base.playbackCopyEnabled),
    playbackTempDir: String(pickValue("playbackTempDir") || base.playbackTempDir),
    playbackCopyMaxAgeMs: num(pickValue("playbackCopyMaxAgeMs"), base.playbackCopyMaxAgeMs, 1000, 86400000),
    // 预热毫秒数：0 = 不预热（默认）；>0 时才让播放器先播一段静音（会打断蓝牙音乐，慎用）。
    prewarmMs: num(pickValue("prewarmMs"), base.prewarmMs, 0, 3000),
    // 播放内核：只认 "wav"，其它值（含拼错）都回落 "mci"（旧内核，永远有声），
    // 避免一个拼错的内核名把播报变成静音。
    playerEngine: String(pickValue("playerEngine")) === "wav" ? "wav" : "mci",
    wavCacheDir: String(pickValue("wavCacheDir") || base.wavCacheDir),
    volumeProbeScript: String(pickValue("volumeProbeScript") || base.volumeProbeScript),
    volumeProbeCacheMs: num(pickValue("volumeProbeCacheMs"), base.volumeProbeCacheMs, 0, 600000),
    volumeProbeTimeoutMs: num(pickValue("volumeProbeTimeoutMs"), base.volumeProbeTimeoutMs, 500, 60000),
  };

  // Nested blocks (texts / prosody / tts): merged key by key so a partial block
  // in config.json only overrides the keys it actually names.
  resolved.texts = mergeBlock(base.texts, fromFile.texts, row.texts, EDITABLE_TEXT_KEYS, function (value, fallback) {
    return typeof value === "string" && value.trim().length > 0 ? value : fallback;
  });
  resolved.prosody = mergeBlock(base.prosody, fromFile.prosody, row.prosody, EDITABLE_PROSODY_KEYS, function (value, fallback) {
    return num(value, fallback, 0.2, 4);
  });
  resolved.tts = {
    apiKey: String(pick(row.tts, "apiKey", pick(fromFile.tts, "apiKey", base.tts.apiKey)) || ""),
    endpoint: String(pick(row.tts, "endpoint", pick(fromFile.tts, "endpoint", base.tts.endpoint))),
    resourceId: String(pick(row.tts, "resourceId", pick(fromFile.tts, "resourceId", base.tts.resourceId))),
    model: String(pick(row.tts, "model", pick(fromFile.tts, "model", base.tts.model))),
    // voice is NOT user-editable in the UI, but the runtime config may pin it
    speaker: String(pick(row.tts, "speaker", pick(fromFile.tts, "speaker", base.tts.speaker))),
    format: String(pick(row.tts, "format", pick(fromFile.tts, "format", base.tts.format))),
    sampleRate: num(pick(row.tts, "sampleRate", pick(fromFile.tts, "sampleRate", base.tts.sampleRate)), base.tts.sampleRate, 8000, 48000),
    timeoutMs: num(pick(row.tts, "timeoutMs", pick(fromFile.tts, "timeoutMs", base.tts.timeoutMs)), base.tts.timeoutMs, 5000, 600000),
  };

  // Voice library (requirement A): a full-array override from config.json / the
  // bundle row, normalized so a hand edit can never poison the list. An empty
  // array is a VALID save (the user deleted every voice); a non-array falls back
  // to the built-in defaults.
  const voicesFromSource = normalizeVoices(pickValue("voices"));
  const voicesFromBase = normalizeVoices(base.voices) || [];
  resolved.voices = voicesFromSource === null ? voicesFromBase : voicesFromSource;
  const selectedRaw = String(pickValue("selectedVoiceId") || "");
  resolved.selectedVoiceId = resolved.voices.some(function (voice) {
    return voice.id === selectedRaw;
  })
    ? selectedRaw
    : resolved.voices.length > 0
      ? resolved.voices[0].id
      : "";
  resolved.presetApiKey = String(pickValue("presetApiKey") || "");

  // Sound-effect selection per event: merged key by key over the built-in defaults,
  // and every value re-validated against the catalogue (an unknown key would name a
  // file outside the shipped set, so it is dropped rather than trusted).
  resolved.sfxByKind = Object.assign(
    {},
    base.sfxByKind,
    normalizeSfxByKind(fromFile.sfxByKind),
    normalizeSfxByKind(row.sfxByKind),
  );

  // Environment overrides win over everything: the escape hatch for a moved
  // player when the user cannot restart DSH to edit config.json.
  if (env.DSH_VOICE_ALERT_PYTHON) resolved.pythonPath = String(env.DSH_VOICE_ALERT_PYTHON);
  if (env.DSH_VOICE_ALERT_PLAYER) resolved.playerScript = String(env.DSH_VOICE_ALERT_PLAYER);
  if (env.DSH_VOICE_ALERT_LOG) resolved.logPath = String(env.DSH_VOICE_ALERT_LOG);
  if (env.DSH_VOICE_ALERT_TTS_KEY) resolved.tts.apiKey = String(env.DSH_VOICE_ALERT_TTS_KEY);
  if (env.DSH_VOICE_ALERT_FFMPEG) resolved.ffmpegPath = String(env.DSH_VOICE_ALERT_FFMPEG);
  if (env.DSH_VOICE_ALERT_DISABLED === "1" || env.DSH_VOICE_ALERT_DISABLED === "true") resolved.enabled = false;

  resolved._meta = {
    configPath: file.path,
    configState: file.ok ? "loaded" : "defaults-only (" + file.reason + ")",
    rowConfigKeys: Object.keys(row).length,
  };
  if (log) log("config resolved: " + resolved._meta.configState + " path=" + String(file.path));
  return resolved;
}

// ---------------------------------------------------------------- voice library

/**
 * Normalize a raw voices array into the canonical entry shape.
 * Non-array input returns null (caller falls back to the defaults); an empty
 * array is a VALID library (the user deleted every voice).
 * @returns { {id, note, kind, enabled}[] | null }
 */
export function normalizeVoices(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim();
    if (id.length === 0) continue;
    out.push({
      id,
      note: String(item.note || "").slice(0, 200),
      kind: String(item.kind || "clone") === "preset" ? "preset" : "clone",
      enabled: item.enabled !== false,
    });
  }
  return out;
}

/**
 * Resolve which voice a synthesis will use.
 * @param config - resolved config.
 * @param speakerId - explicit override; falls back to config.selectedVoiceId.
 * @returns { voice, speakerId, kind, source: "library"|"inline" }
 */
export function resolveVoice(config, speakerId) {
  const voices = Array.isArray(config.voices) ? config.voices : [];
  const wanted =
    speakerId && String(speakerId).trim().length > 0 ? String(speakerId).trim() : String(config.selectedVoiceId || "");
  const found = voices.find(function (voice) {
    return voice.id === wanted;
  });
  if (found) return { voice: found, speakerId: found.id, kind: found.kind, source: "library" };
  // Not in the library (e.g. a speakerId passed straight from the caller):
  // derive the kind from the id shape (S_* = cloned, everything else = preset).
  const kind = String(wanted).startsWith("S_") ? "clone" : "preset";
  return { voice: { id: wanted, note: "", kind, enabled: true }, speakerId: wanted, kind, source: "inline" };
}

/** Does the key required by this voice's kind exist in the resolved config? */
export function voiceKeyPresent(config, voice) {
  const kind = voice && voice.kind === "preset" ? "preset" : "clone";
  if (kind === "preset") return Boolean(config.presetApiKey && String(config.presetApiKey).length > 0);
  return Boolean(config.tts && config.tts.apiKey);
}

/**
 * Which "key missing" code applies to this voice, or null when the key is there.
 * @returns { "api-key-missing" | "preset-key-missing" | null }
 */
export function voiceKeyErrorCode(config, voice) {
  const kind = voice && voice.kind === "preset" ? "preset" : "clone";
  if (kind === "preset") {
    return config.presetApiKey && String(config.presetApiKey).length > 0 ? null : "preset-key-missing";
  }
  return config.tts && config.tts.apiKey ? null : "api-key-missing";
}

function parseVoiceImportLine(line) {
  const comma = line.indexOf(",");
  if (comma < 0) return { id: line.trim(), note: "" };
  return { id: line.slice(0, comma).trim(), note: line.slice(comma + 1).trim() };
}

/**
 * Parse a batch-import payload into canonical voice entries.
 * Accepts multi-line text ("ID,备注" per line, # comments) or a JSON array of
 * strings / { id, note, kind }. Kind is auto-detected when omitted: `S_` = clone,
 * anything else (zh_* / BV* / ...) = preset. Duplicates within one batch are dropped.
 * @returns { {id, note, kind, enabled}[] }
 */
export function parseVoiceImport(input) {
  const source = input === undefined || input === null ? "" : input;
  const parsed = [];
  if (Array.isArray(source)) {
    for (const item of source) {
      if (typeof item === "string") parsed.push(parseVoiceImportLine(item));
      else if (item && typeof item === "object") {
        parsed.push({
          id: String(item.id || "").trim(),
          note: String(item.note || "").trim(),
          kind: String(item.kind || "").trim(),
        });
      }
    }
  } else if (typeof source === "string") {
    for (const line of String(source).split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      parsed.push(parseVoiceImportLine(trimmed));
    }
  }
  const seen = new Set();
  const out = [];
  for (const item of parsed) {
    const id = String(item.id || "").trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    let kind = String(item.kind || "").trim();
    if (kind !== "clone" && kind !== "preset") kind = id.startsWith("S_") ? "clone" : "preset";
    out.push({ id, note: String(item.note || "").slice(0, 200), kind, enabled: true });
  }
  return out;
}

/** Merge imported voices into the current library, dropping id duplicates. */
export function mergeVoiceImport(current, imported) {
  const out = (Array.isArray(current) ? current : []).map(function (voice) {
    return {
      id: voice.id,
      note: String(voice.note || ""),
      kind: voice.kind === "preset" ? "preset" : "clone",
      enabled: voice.enabled !== false,
    };
  });
  const seen = new Set(out.map(function (voice) { return voice.id; }));
  for (const item of Array.isArray(imported) ? imported : []) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({
      id: item.id,
      note: String(item.note || ""),
      kind: item.kind === "preset" ? "preset" : "clone",
      enabled: item.enabled !== false,
    });
  }
  return out;
}

/**
 * Persist the whole voice library slice (voices + selectedVoiceId + presetApiKey)
 * into config.json. Reads the current file first so nothing else in it is lost;
 * writes UTF-8 without BOM; never throws.
 * @returns { ok, path?, reason? }
 */
export function saveVoicesConfig(configPath, patch, log) {
  const file = configPath || CONFIG_PATH;
  try {
    const current = readConfigFile(file).data || {};
    const next = Object.assign({}, current);
    const normalized = normalizeVoices(patch && patch.voices);
    if (normalized !== null) next.voices = normalized;
    if (patch && typeof patch.selectedVoiceId === "string") next.selectedVoiceId = patch.selectedVoiceId;
    if (patch && typeof patch.presetApiKey === "string") next.presetApiKey = patch.presetApiKey;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8" }); // utf8 -> no BOM
    if (typeof log === "function") log("voices saved: " + String(normalized === null ? 0 : normalized.length) + " voice(s) -> " + file);
    return { ok: true, path: file };
  } catch (error) {
    if (typeof log === "function") log("voices save failed (" + file + "): " + errText(error));
    return { ok: false, path: file, reason: errText(error) };
  }
}
