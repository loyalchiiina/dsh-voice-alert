// dsh-voice-alert - one-click voice generation (TTS -> raw file -> loud copy).
//
// Pipeline for each kind (complete / fail / approval):
//   1. decide what actually CHANGED: the text + prosody ratios are compared with
//      the snapshot written by the last successful run (<data>\generate-state.json),
//      and unchanged kinds reuse the existing mp3 instead of spending a TTS call
//      (user request 2026-09-15: "别每次播放/生成都重新合成"). All unchanged ->
//      the run reports `nothing-changed` and does nothing else;
//   2. backup the CURRENT -poetic.mp3 and -poetic-loud.mp3 into
//      <data>\audio\backups\<yyyyMMdd-HHmmss>\ (rotated to keepBackupSets sets,
//      older sets go to the RECYCLE BIN - never a permanent delete);
//   3. synthesize the changed sentences with the user's fixed cloned voice;
//   4. write the raw result to <data>\audio\origin\voice-alert-<kind>-poetic.mp3;
//   5. loudness gain into a TEMP name, retry the replace 5x/400ms on
//      EBUSY/EPERM/EACCES (2026-09-15: a cue playing the same kind used to make the
//      whole generation fail), then volumedetect; a corrective pass guarantees the
//      "within target" window instead of reporting a near-miss.
//
// The gain step degrades gracefully: without ffmpeg the raw file is copied to the
// loud path and the result carries gainSkipped + the reason, which the settings
// section surfaces as "当前未做响度增益".

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";

import { synthesize } from "./tts.js";
import { resolveVoice, voiceKeyErrorCode } from "./config.js";

const LOUD_SUFFIX_DEFAULT = "-loud";
const RETRYABLE_RENAME_CODES = ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"];

function errText(error) {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** Resolve the ffmpeg binary: configured path -> PATH probe -> null. */
export function resolveFfmpeg(config) {
  const configured = config && config.ffmpegPath ? String(config.ffmpegPath) : "";
  if (configured && existsSync(configured)) return { path: configured, source: "config" };
  const probe = spawnSync("ffmpeg", ["-version"], { windowsHide: true, stdio: "ignore" });
  if (!probe.error && probe.status === 0) return { path: "ffmpeg", source: "path" };
  return { path: null, source: "missing" };
}

/** Run ffmpeg and collect stderr (volumedetect prints there). Never rejects. */
export function runFfmpeg(ffmpegPath, args) {
  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: errText(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", function (chunk) { stdout += String(chunk); });
    if (child.stderr) child.stderr.on("data", function (chunk) { stderr += String(chunk); });
    child.on("error", function (error) {
      resolve({ code: -1, stdout, stderr: stderr + " " + errText(error) });
    });
    child.on("close", function (code) {
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

/** Parse ffmpeg volumedetect output into { mean, max } (dB). */
export function parseVolumeDetect(text) {
  const source = String(text || "");
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/u.exec(source);
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/u.exec(source);
  return {
    mean: mean ? Number(mean[1]) : null,
    max: max ? Number(max[1]) : null,
  };
}

/** Measure one file's loudness with volumedetect. */
export async function measureLoudness(ffmpegPath, file) {
  const result = await runFfmpeg(ffmpegPath, [
    "-hide_banner",
    "-i",
    file,
    "-af",
    "volumedetect",
    "-f",
    "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ]);
  const parsed = parseVolumeDetect(result.stderr + "\n" + result.stdout);
  return Object.assign(parsed, { ok: parsed.mean !== null && parsed.max !== null });
}

/** Build the gain command (pure - asserted by the self-check). */
export function buildGainArgs(input, output, filter) {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-af",
    String(filter),
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    output,
  ];
}

/** The intermediate name ffmpeg writes before the atomic replace. */
export function tempGainPath(output, stamp) {
  return output + ".tmp-" + String(stamp === undefined ? Date.now() : stamp) + ".mp3";
}

/**
 * Rename with retry. A cue playing the target file holds a Windows handle, so a
 * replace can legitimately fail with EBUSY/EPERM for a moment (2026-09-15).
 * @returns { ok, attempts, error? }
 */
export async function renameWithRetry(from, to, options) {
  const opts = options || {};
  const retries = Number(opts.retries) > 0 ? Number(opts.retries) : 1;
  const delayMs = Number(opts.delayMs) >= 0 ? Number(opts.delayMs) : 400;
  const fsOps = opts.fsOps || { renameSync };
  const log = typeof opts.log === "function" ? opts.log : function () {};
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      fsOps.renameSync(from, to);
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      const code = error && error.code ? String(error.code) : "";
      if (RETRYABLE_RENAME_CODES.indexOf(code) < 0 || attempt === retries) break;
      log(
        "replace blocked (" + code + ") on attempt " + String(attempt) + "/" + String(retries) +
          " - file is in use, retrying in " + String(delayMs) + "ms",
      );
      await sleep(delayMs);
    }
  }
  return { ok: false, attempts: retries, error: lastError };
}

/** Copy one directory tree to the recycle bin (never a permanent delete). */
export function recyclePath(target, log) {
  const say = typeof log === "function" ? log : function () {};
  if (process.platform !== "win32") {
    say("rotation: non-Windows host, skipping recycle of " + target);
    return { ok: false, reason: "non-windows" };
  }
  const script =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('" +
    String(target).replace(/'/g, "''") +
    "', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, " +
    "[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)";
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, encoding: "utf8" },
  );
  if (result.status === 0 && !existsSync(target)) {
    say("rotation: recycled " + target);
    return { ok: true };
  }
  say("rotation: could not recycle " + target + " (" + String(result.stderr || "").slice(0, 200) + ")");
  return { ok: false, reason: (result.stderr || "unknown").slice(0, 200) };
}

/**
 * Copy the current audio pair into a fresh timestamped backup set, then rotate.
 * @returns { dir, files: string[], recycled: string[] }
 */
export function backupCurrentAudio(config, options, log) {
  const opts = options || {};
  const say = typeof log === "function" ? log : function () {};
  const now = typeof opts.now === "function" ? opts.now : function () { return new Date(); };
  const stamp = String(opts.stamp || formatStamp(now()));
  const root = String(opts.backupsDir || config.audioBackupsDir);
  const dir = join(root, stamp);
  const copied = [];
  try {
    mkdirSync(dir, { recursive: true });
    const kinds = opts.kinds || ["complete", "fail", "approval"];
    for (const kind of kinds) {
      const loud = join(String(config.audioDir), "voice-alert-" + kind + "-poetic" + loudSuffix(config) + ".mp3");
      const origin = join(String(config.audioOriginDir), "voice-alert-" + kind + "-poetic.mp3");
      for (const source of [origin, loud]) {
        if (!existsSync(source)) continue;
        const target = join(dir, source.split(/[\\/]/u).pop());
        copyFileSync(source, target);
        copied.push(target);
      }
    }
    say("backup: " + copied.length + " file(s) -> " + dir);
  } catch (error) {
    say("backup failed: " + errText(error));
  }
  const recycled = rotateBackups(root, Number(config.keepBackupSets) > 0 ? Number(config.keepBackupSets) : 10, say, opts);
  return { dir: copied.length > 0 ? dir : null, files: copied, recycled };
}

/** Keep the newest N sets under root; older ones go to the recycle bin. */
export function rotateBackups(root, keep, log, options) {
  const opts = options || {};
  const say = typeof log === "function" ? log : function () {};
  const recycled = [];
  try {
    if (!existsSync(root)) return recycled;
    const sets = readdirSync(root)
      .filter(function (name) {
        try {
          return statSync(join(root, name)).isDirectory();
        } catch (_) {
          return false;
        }
      })
      .sort();
    const excess = sets.length > keep ? sets.slice(0, sets.length - keep) : [];
    for (const name of excess) {
      const target = join(root, name);
      const result = opts.recycle ? opts.recycle(target, say) : recyclePath(target, say);
      if (result && result.ok) recycled.push(target);
    }
  } catch (error) {
    say("rotation failed: " + errText(error));
  }
  return recycled;
}

function loudSuffix(config) {
  return config.loudSuffix === undefined ? LOUD_SUFFIX_DEFAULT : String(config.loudSuffix);
}

function formatStamp(date) {
  const pad = function (value) { return String(value).padStart(2, "0"); };
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/** Current text+prosody+voice fingerprint of one kind (what "unchanged" compares). */
export function fingerprintFor(kind, config) {
  const prosody = config.prosody || {};
  return {
    text: String((config.texts && config.texts[kind]) || ""),
    // A voice switch must count as a change so the MP3s are regenerated for the
    // newly selected voice instead of being silently reused (requirement A).
    speaker: String(config.selectedVoiceId || ""),
    prosody: {
      speed_ratio: Number(prosody.speed_ratio),
      pitch_ratio: Number(prosody.pitch_ratio),
      volume_ratio: Number(prosody.volume_ratio),
    },
  };
}

export function fingerprintKey(fingerprint) {
  return JSON.stringify({
    text: fingerprint.text,
    speaker: fingerprint.speaker,
    speed_ratio: fingerprint.prosody.speed_ratio,
    pitch_ratio: fingerprint.prosody.pitch_ratio,
    volume_ratio: fingerprint.prosody.volume_ratio,
  });
}

/** Read the last-generation snapshot (never throws). */
export function readGenerateState(config) {
  try {
    const file = String(config.generateStateFile);
    if (!existsSync(file)) return { updatedAt: null, entries: {} };
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") return { updatedAt: null, entries: {} };
    return { updatedAt: parsed.updatedAt || null, entries: parsed.entries || {} };
  } catch (_) {
    return { updatedAt: null, entries: {} };
  }
}

/** Persist the snapshot after a successful run (never throws). */
export function writeGenerateState(config, entries, log) {
  try {
    const file = String(config.generateStateFile);
    mkdirSync(dirname(file), { recursive: true });
    const payload = { updatedAt: new Date().toISOString(), entries };
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8" });
    return { ok: true, file };
  } catch (error) {
    if (typeof log === "function") log("generate-state write failed: " + errText(error));
    return { ok: false, reason: errText(error) };
  }
}

/** Which kinds need a TTS call (or exact regeneration) this run? */
export function planChanges(config, kinds, options) {
  const opts = options || {};
  const force = opts.force === true;
  const reuseEnabled = config.reuseUnchanged !== false && !force;
  const state = opts.state || readGenerateState(config);
  const changed = [];
  const reused = [];
  const missing = [];
  for (const kind of kinds) {
    const fingerprint = fingerprintFor(kind, config);
    const loudFile = join(String(config.audioDir), "voice-alert-" + kind + "-poetic" + loudSuffix(config) + ".mp3");
    const previous = state.entries ? state.entries[kind] : null;
    if (!existsSync(loudFile)) {
      missing.push(kind);
      changed.push(kind);
      continue;
    }
    if (reuseEnabled && previous && fingerprintKey(previous) === fingerprintKey(fingerprint)) {
      reused.push(kind);
      continue;
    }
    changed.push(kind);
  }
  return { changed, reused, missing, force, reuseEnabled };
}

/**
 * Create the generation runner.
 * @param options.config - resolved config (live object; texts/prosody read at run time).
 * @param options.log - logger.
 * @param options.fetchImpl - fetch override (self-check mock).
 * @param options.onChanged - called after each state change (status.json refresh).
 * @param options.isPlaying - (kind) => boolean, the plugin's "a cue is playing now".
 * @param options.waitWhilePlaying - async (kind, timeoutMs) => boolean (waited until free).
 */
export function createGenerator(options) {
  const opts = options || {};
  const config = opts.config || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const onChanged = typeof opts.onChanged === "function" ? opts.onChanged : function () {};
  const now = typeof opts.now === "function" ? opts.now : function () { return new Date(); };
  const isPlaying = typeof opts.isPlaying === "function" ? opts.isPlaying : function () { return false; };
  const waitWhilePlaying = typeof opts.waitWhilePlaying === "function" ? opts.waitWhilePlaying : null;

  const state = {
    running: false,
    jobId: null,
    startedAt: null,
    finishedAt: null,
    trigger: null,
    force: false,
    result: null,
    changed: [],
    reused: [],
    missing: [],
    backupDir: null,
    recycled: [],
    outputs: {},
    error: null,
    runs: 0,
    voice: null,
  };

  function snapshot() {
    return {
      running: state.running,
      jobId: state.jobId,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      trigger: state.trigger,
      force: state.force,
      result: state.result,
      changed: state.changed.slice(),
      reused: state.reused.slice(),
      missing: state.missing.slice(),
      backupDir: state.backupDir,
      recycled: state.recycled.slice(),
      outputs: Object.assign({}, state.outputs),
      error: state.error,
      runs: state.runs,
      apiKeyPresent: Boolean(config.tts && config.tts.apiKey),
      speaker: config.tts ? config.tts.speaker : null,
      selectedVoice: state.voice ? { id: state.voice.speakerId, kind: state.voice.kind, source: state.voice.source } : null,
      selectedSpeaker: state.voice ? state.voice.speakerId : String(config.selectedVoiceId || ""),
      voiceNote: config.voiceNote,
      texts: Object.assign({}, config.texts),
      prosody: Object.assign({}, config.prosody),
      gainTargets: {
        meanMinDb: config.gainMinMeanDb,
        meanMaxDb: config.gainMaxMeanDb,
        maxPeakDb: config.gainMaxPeakDb,
      },
    };
  }

  function withinTarget(measured) {
    return (
      measured.mean !== null &&
      measured.max !== null &&
      measured.mean >= Number(config.gainMinMeanDb) &&
      measured.mean <= Number(config.gainMaxMeanDb) &&
      measured.max <= Number(config.gainMaxPeakDb)
    );
  }

  /** One gain pass into a temp name; returns { ok, measured, replaced, error } */
  async function gainPass(ffmpeg, input, output, filter, stamp) {
    const temp = tempGainPath(output, stamp);
    const run = await runFfmpeg(ffmpeg.path, buildGainArgs(input, temp, filter));
    if (run.code !== 0 || !existsSync(temp)) {
      try {
        rmSync(temp, { force: true });
      } catch (_) {
        /* nothing to clean */
      }
      return { ok: false, error: "ffmpeg gain failed (code " + String(run.code) + "): " + String(run.stderr).slice(0, 200) };
    }
    const measured = await measureLoudness(ffmpeg.path, temp);
    const replaced = await renameWithRetry(temp, output, {
      retries: Number(config.gainRetryCount) > 0 ? Number(config.gainRetryCount) : 5,
      delayMs: Number(config.gainRetryDelayMs) >= 0 ? Number(config.gainRetryDelayMs) : 400,
      log,
    });
    if (!replaced.ok) {
      try {
        rmSync(temp, { force: true });
      } catch (_) {
        /* nothing to clean */
      }
      const code = replaced.error && replaced.error.code ? String(replaced.error.code) : "unknown";
      return {
        ok: false,
        measured,
        error:
          "无法替换语音文件：文件被占用（" + code + "，已重试 " + String(replaced.attempts) + " 次）。" +
          "请稍后重试；若刚在播放同一类语音，等播放结束即可。",
      };
    }
    return { ok: true, measured, replaced, temp };
  }

  async function generateOne(kind, ffmpeg, deps, stamp, voiceSel) {
    const text = (config.texts && config.texts[kind]) || "";
    const originDir = String(config.audioOriginDir);
    const audioDir = String(config.audioDir);
    const suffix = loudSuffix(config);
    const originFile = join(originDir, "voice-alert-" + kind + "-poetic.mp3");
    const loudFile = join(audioDir, "voice-alert-" + kind + "-poetic" + suffix + ".mp3");
    const result = {
      kind,
      ok: false,
      reused: false,
      text,
      originFile,
      loudFile,
      bytes: 0,
      gainSkipped: false,
      corrective: false,
      gain: { mean: null, max: null },
      withinTarget: false,
      waitedForPlayback: false,
      speaker: voiceSel ? voiceSel.speakerId : String(config.selectedVoiceId || ""),
      error: null,
    };
    try {
      // A cue of this kind may be playing right now; the scratch-copy playback
      // means the file itself is free, but ffmpeg replacing it can still race with
      // a player that just started. Wait briefly instead of failing.
      if (isPlaying(kind)) {
        result.waitedForPlayback = true;
        if (waitWhilePlaying) {
          const waited = await waitWhilePlaying(kind, 8000);
          log("generate: " + kind + " waited for the current playback to finish (waited=" + String(waited) + ")");
        } else {
          log("generate: " + kind + " is playing right now - retries will absorb it");
        }
      }

      const synth = await synthesize({
        text,
        config,
        voice: voiceSel ? voiceSel.voice : null,
        log,
        fetchImpl: deps.fetchImpl,
        requestId: deps.requestIdFactory ? deps.requestIdFactory(kind) : undefined,
      });
      if (!synth.ok) {
        result.error = synth.error;
        return result;
      }
      mkdirSync(originDir, { recursive: true });
      writeFileSync(originFile, synth.bytes);
      result.bytes = synth.bytes.length;

      mkdirSync(audioDir, { recursive: true });
      if (ffmpeg.path === null) {
        copyFileSync(originFile, loudFile);
        result.gainSkipped = true;
        result.error = "ffmpeg not found: loud copy is the raw file (no loudness gain)";
        result.ok = true;
        log("generate: " + kind + " ok WITHOUT gain (ffmpeg missing)");
        return result;
      }

      let pass = await gainPass(ffmpeg, originFile, loudFile, config.gainFilter, stamp);
      if (!pass.ok) {
        // Keep the raw file as the loud copy so the plugin still has audio, and
        // surface the explicit "file is in use" reason.
        copyFileSync(originFile, loudFile);
        result.gainSkipped = true;
        result.error = pass.error;
        log("generate: " + kind + " ok WITHOUT gain (" + pass.error + ")");
        return result;
      }

      let measured = pass.measured;
      if (measured.max !== null && measured.max > Number(config.gainMaxPeakDb)) {
        // Corrective pass: trim the peak into the window (bounded, so a broken
        // measurement can never make the file silent).
        const trimDb = Math.max(-8, Math.min(-0.1, Number(config.gainMaxPeakDb) - 0.1 - measured.max));
        const corrected = await gainPass(
          ffmpeg,
          originFile,
          loudFile,
          String(config.gainFilter) + ",volume=" + trimDb.toFixed(2) + "dB",
          stamp + "-fix",
        );
        if (corrected.ok) {
          result.corrective = true;
          measured = corrected.measured;
          log("generate: " + kind + " corrective pass " + trimDb.toFixed(2) + "dB -> max " + String(measured.max) + "dB");
        } else {
          log("generate: " + kind + " corrective pass failed: " + String(corrected.error));
        }
      }
      result.gain = { mean: measured.mean, max: measured.max };
      result.withinTarget = withinTarget(measured);
      result.ok = true;
      log(
        "generate: " +
          kind +
          " ok bytes=" +
          String(result.bytes) +
          " mean=" +
          String(measured.mean) +
          "dB max=" +
          String(measured.max) +
          "dB withinTarget=" +
          String(result.withinTarget),
      );
      return result;
    } catch (error) {
      result.error = errText(error);
      log("generate: " + kind + " failed: " + result.error);
      return result;
    }
  }

  async function run(kinds, trigger, force, voiceSel) {
    state.running = true;
    state.jobId = trigger + "-" + String(now().getTime());
    state.startedAt = now().toISOString();
    state.finishedAt = null;
    state.trigger = trigger;
    state.force = Boolean(force);
    state.voice = voiceSel || null;
    state.error = null;
    state.outputs = {};
    state.recycled = [];
    onChanged();

    const plan = planChanges(config, kinds, { force: Boolean(force) });
    state.changed = plan.changed.slice();
    state.reused = plan.reused.slice();
    state.missing = plan.missing.slice();
    for (const kind of plan.reused) {
      state.outputs[kind] = {
        kind,
        ok: true,
        reused: true,
        text: (config.texts && config.texts[kind]) || "",
        bytes: 0,
        gainSkipped: false,
        corrective: false,
        gain: { mean: null, max: null },
        withinTarget: true,
        error: null,
      };
    }

    if (plan.changed.length === 0) {
      state.result = "nothing-changed";
      state.running = false;
      state.finishedAt = now().toISOString();
      state.runs += 1;
      log("generate: nothing changed - reused " + plan.reused.join(", ") + " (no TTS call)");
      onChanged();
      return snapshot();
    }

    const ffmpeg = resolveFfmpeg(config);
    if (ffmpeg.path === null) log("generate: ffmpeg not found - loudness gain will be skipped");
    else log("generate: ffmpeg " + ffmpeg.path + " (source " + ffmpeg.source + ")");

    const backup = backupCurrentAudio(config, { kinds: plan.changed }, log);
    state.backupDir = backup.dir;
    state.recycled = backup.recycled;
    onChanged();

    const stamp = String(now().getTime());
    for (const kind of plan.changed) {
      state.outputs[kind] = await generateOne(kind, ffmpeg, opts, stamp, voiceSel);
      onChanged();
    }

    // Snapshot only what actually landed, so the next run can reuse it.
    const previousState = readGenerateState(config);
    const entries = Object.assign({}, previousState.entries);
    for (const kind of kinds) {
      const entry = state.outputs[kind];
      if (entry && entry.ok && !entry.gainSkipped) entries[kind] = fingerprintFor(kind, config);
      else if (entry && entry.reused && !entries[kind]) entries[kind] = fingerprintFor(kind, config);
    }
    writeGenerateState(config, entries, log);

    state.running = false;
    state.finishedAt = now().toISOString();
    state.runs += 1;
    const failed = plan.changed.filter(function (kind) {
      const entry = state.outputs[kind];
      return !entry || entry.ok !== true;
    });
    state.error = failed.length > 0 ? "failed kinds: " + failed.join(", ") : null;
    state.result = failed.length > 0 ? "partial" : plan.reused.length > 0 ? "mixed" : "generated";
    log(
      "generate: finished (changed=" +
        plan.changed.join(",") +
        " reused=" +
        (plan.reused.join(",") || "-") +
        " failed=" +
        (failed.join(",") || "-") +
        ")",
    );
    onChanged();
    return snapshot();
  }

  /**
   * Start one run. Returns immediately (the UI polls snapshot()).
   * @param options - { force?, speakerId? } - speakerId overrides the selected
   *   voice; when the voice's kind has no key configured the run is refused with
   *   `preset-key-missing` / `api-key-missing` instead of a wrong-key 401.
   * @returns { accepted, reason?, jobId?, startedAt?, changed?, reused?, result? }
   */
  function start(kinds, trigger, options) {
    const runOptions = options || {};
    const wanted = Array.isArray(kinds) && kinds.length > 0 ? kinds : ["complete", "fail", "approval"];
    if (state.running) return { accepted: false, reason: "already-running", jobId: state.jobId, startedAt: state.startedAt };
    const voiceSel = resolveVoice(config, runOptions.speakerId);
    const keyError = voiceKeyErrorCode(config, voiceSel.voice);
    if (keyError) {
      return {
        accepted: false,
        reason: keyError,
        voice: { id: voiceSel.speakerId, kind: voiceSel.kind },
      };
    }
    const plan = planChanges(config, wanted, { force: runOptions.force === true });
    if (plan.changed.length === 0) {
      // Nothing to synthesize: answer immediately, no TTS call, no backup.
      state.runs += 1;
      state.result = "nothing-changed";
      state.changed = [];
      state.reused = plan.reused.slice();
      state.missing = plan.missing.slice();
      state.error = null;
      state.startedAt = now().toISOString();
      state.finishedAt = state.startedAt;
      onChanged();
      log("generate: nothing changed - reusing " + (plan.reused.join(", ") || "(none)") + "; no TTS call made");
      return { accepted: false, reason: "nothing-changed", reused: plan.reused, changed: [], result: "nothing-changed" };
    }
    const runPromise = run(wanted, trigger || "settings", runOptions.force === true, voiceSel).catch(function (error) {
      state.running = false;
      state.error = errText(error);
      state.finishedAt = now().toISOString();
      onChanged();
    });
    state._promise = runPromise;
    return { accepted: true, jobId: state.jobId, startedAt: state.startedAt, kinds: wanted, changed: plan.changed, reused: plan.reused, voice: { id: voiceSel.speakerId, kind: voiceSel.kind } };
  }

  /** Await the current run (self-check + manual CLI use). */
  function whenIdle() {
    return state._promise || Promise.resolve(snapshot());
  }

  return { start, snapshot, whenIdle, state };
}
