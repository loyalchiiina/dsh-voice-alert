// dsh-voice-alert - real playback.
//
// HARD RULES (they exist because breaking them broke the DSH session before):
//   1. Never touch the system volume / mute state. The player (notify_voice_player.py)
//      uses winmm/MCI "play as-is": the user's volume is whatever it already is.
//   2. Never spawn the Python interpreter as a DIRECT child of the DSH process, and
//      never keep the launcher alive: the python player always comes from
//      powershell `Start-Process`, so its parent is powershell (which exits ~1s
//      later) and it is not part of the DSH process tree. A DSH session/job
//      teardown can only kill the already-exited launcher, never the sound.
//   3. Silent degradation: a missing python / player script / MP3 must never throw
//      into the DSH event bus. Worst case we fall back to a console beep.
//
// MEASURED, DO NOT "FIX" BACK (Windows 11, PowerShell 5.1, node 24, 2026-09-14):
//   A chain probe (test/chain-marker.py writes a marker file from the child)
//   proves which spawn shape actually reaches the child process:
//     node spawn powershell + detached:true (DETACHED_PROCESS)  -> marker NO
//     node spawn powershell + detached:true + windowsHide:false -> marker NO
//     node spawn powershell WITHOUT detached                    -> marker YES
//   powershell.exe created with DETACHED_PROCESS exits silently with code 0 and
//   runs nothing (it needs a console). "Detached" is therefore achieved at the
//   Start-Process level, not with the node DETACHED_PROCESS flag: powershell is
//   spawned hidden + unref'd (so DSH is never held open and never waits on it),
//   and the PLAYER is what detaches.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";

export const POWERSHELL_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Spawn options used for the launcher. Exported so the self-check can guard the
 * measured constraint: `detached: true` (DETACHED_PROCESS) makes powershell.exe
 * exit silently without running anything on this host.
 */
export const LAUNCH_OPTIONS = { windowsHide: true, stdio: "ignore", detached: false };

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function errText(error) {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

/**
 * Loudness policy: LOUD COPY FIRST, then the untouched original, then the beep.
 *
 * The shipped poetic originals measure mean_volume ~ -20.8 dB (too quiet). The
 * fix is a louder COPY built by dev-audio-loud.ps1 into <data>\audio - the
 * originals are never modified, and the system volume / mute state is never
 * touched. `preferLoudAudio: true` (default) picks the loud copy; set it to false
 * to go back to the originals.
 */
export function loudFileFor(kind, config) {
  const dir = config.audioDir;
  const suffix = config.loudSuffix === undefined ? "-loud" : String(config.loudSuffix);
  return join(dir, "voice-alert-" + kind + "-poetic" + suffix + ".mp3");
}

/** The untouched original for one kind. */
export function originalFileFor(kind, config) {
  return join(config.originalsDir, "voice-alert-" + kind + "-poetic.mp3");
}

/** Absolute path of the bundled MCI player (can be overridden). */
export function bundledPlayerPath(config) {
  const configured = config.bundledPlayer;
  if (!configured) return null;
  return isAbsolute(configured) ? configured : join(PLUGIN_DIR, configured);
}

/**
 * Pick the audio file for one kind: loud copy -> original -> none.
 * @returns { mode: "loud"|"original"|"none", file, candidates }
 */
export function resolveAudio(kind, config) {
  const candidates = [];
  if (config.preferLoudAudio !== false) candidates.push({ mode: "loud", file: loudFileFor(kind, config) });
  candidates.push({ mode: "original", file: originalFileFor(kind, config) });
  for (const candidate of candidates) {
    if (existsSync(candidate.file)) return { mode: candidate.mode, file: candidate.file, candidates };
  }
  return { mode: "none", file: candidates[0].file, candidates };
}

/**
 * Prepare the throw-away copy the player will actually open.
 *
 * WHY (2026-09-15 EBUSY incident): MCI keeps a handle on the mp3 for the whole
 * playback, and a generation run then failed with
 * `EBUSY ... copyfile voice-alert-complete-poetic.mp3 -> ...-loud.mp3` because the
 * cue of the same kind was playing at that moment. Playing a scratch copy means
 * the production artifact is never locked, so "generate while a cue plays" is safe.
 *
 * @returns { file, copy, cleanup } - `copy` is true when `file` is a scratch copy.
 */
export function preparePlaybackFile(kind, resolvedFile, config, options) {
  const opts = options || {};
  const say = typeof opts.log === "function" ? opts.log : function () {};
  const result = { file: resolvedFile, copy: false, cleanup: null, reason: null };
  if (!config || config.playbackCopyEnabled === false) {
    result.reason = "copy-disabled";
    return result;
  }
  try {
    const dir = String(opts.tempDir || config.playbackTempDir);
    mkdirSync(dir, { recursive: true });
    const stamp = String(Date.now()) + "-" + String(opts.pid !== undefined ? opts.pid : process.pid);
    const target = join(dir, kind + "-" + stamp + ".mp3");
    copyFileSync(resolvedFile, target);
    // 🔴 Windows CopyFile preserves the SOURCE timestamps, so the brand-new copy
    // would inherit an old mtime and the stale-copy prune below would delete it in
    // the same call (measured: a copy of the production file arrived ~19.8 h old,
    // and the prune removed it instantly -> the player then found no file at all).
    // Stamp it with "now" before pruning.
    const stampTime = new Date(Date.now());
    try {
      utimesSync(target, stampTime, stampTime);
    } catch (error) {
      say("could not stamp the scratch copy mtime: " + errText(error));
    }
    result.file = target;
    result.copy = true;
    result.cleanup = function cleanup() {
      try {
        rmSync(target, { force: true });
        return true;
      } catch (_) {
        return false;
      }
    };
    prunePlaybackCopies(config, { tempDir: dir, log: say });
    return result;
  } catch (error) {
    // A failed copy must never block the cue: fall back to the real file.
    say("playback copy failed, playing the original file: " + errText(error));
    result.reason = errText(error);
    return result;
  }
}

/** Delete scratch copies older than playbackCopyMaxAgeMs (crash leftovers). */
export function prunePlaybackCopies(config, options) {
  const opts = options || {};
  const dir = String(opts.tempDir || (config && config.playbackTempDir));
  const maxAge = Number(config && config.playbackCopyMaxAgeMs) > 0 ? Number(config.playbackCopyMaxAgeMs) : 600000;
  const now = typeof opts.now === "function" ? opts.now() : Date.now();
  let removed = 0;
  try {
    if (!existsSync(dir)) return 0;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        if (now - statSync(file).mtimeMs > maxAge) {
          rmSync(file, { force: true });
          removed += 1;
        }
      } catch (_) {
        /* a file being played right now is fine to leave alone */
      }
    }
  } catch (_) {
    /* pruning is best-effort */
  }
  return removed;
}

/**
 * Build the powershell command line that starts one playback.
 * Exported so the self-check can assert the exact shape (test seam).
 *
 * Player choice: the cue is always played from a scratch copy (see
 * preparePlaybackFile), and only the bundled MCI player takes an explicit file, so
 * that is the default. The shared zero-interference player stays as the fallback
 * for a host where the bundled player is missing - it re-resolves the file from
 * `--kind` itself and therefore locks the production artifact.
 *
 * @param options.prepared - a prepared playback file (test seam); when omitted the
 *   command points at the resolved production file (shape-only use).
 */
export function buildPlayCommand(kind, config, options) {
  const opts = options || {};
  const resolved = resolveAudio(kind, config);
  const prepared = opts.prepared || null;
  const target = prepared && prepared.file ? prepared.file : resolved.file;
  const bundled = bundledPlayerPath(config);
  const bundledAvailable = Boolean(bundled) && existsSync(String(bundled));
  const sharedAvailable = Boolean(config.playerScript) && existsSync(config.playerScript);
  // The scratch copy is only playable through the bundled `--file` player; without
  // it we fall back to the shared player, which re-resolves the file from `--kind`.
  const useBundled = bundledAvailable && (prepared && prepared.copy ? true : resolved.mode === "loud" || !sharedAvailable);
  const playerPath = useBundled ? bundled : config.playerScript;
  const playerArgs = useBundled
    ? ["--file", target]
        .concat(prepared ? ["--delete-after-play"] : [])
        // 诊断日志（open/play 返回码、预热结果、position 采样）：无声投诉的唯一客观线索。
        .concat(config.logPath ? ["--log-file", String(config.logPath)] : [])
    : ["--kind", kind];
  const argumentList = [psQuote("-u"), psQuote(playerPath)]
    .concat(playerArgs.map(psQuote))
    .join(",");
  const inner = [
    "Start-Process",
    "-FilePath " + psQuote(config.pythonPath),
    "-ArgumentList @(" + argumentList + ")",
    "-WindowStyle Hidden",
    "-PassThru",
    "| Out-Null",
  ].join(" ");
  return {
    file: POWERSHELL_EXE,
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-Command",
      inner,
    ],
    inner,
    audioMode: resolved.mode,
    audioFile: resolved.file,
    playFile: target,
    isScratchCopy: Boolean(prepared && prepared.copy),
    playerPath,
    playerKind: useBundled ? "bundled-mci" : "shared-notify",
  };
}

/** Build the console-beep fallback command line. */export function buildBeepCommand() {
  return {
    file: POWERSHELL_EXE,
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "[console]::beep(880,180)",
    ],
  };
}

/**
 * Spawn the launcher: hidden, no pipes (nobody may wait on it), unref'd so the
 * DSH host is never held open. NOT detached - see the MEASURED note above.
 */
function spawnLauncher(command) {
  const child = spawn(command.file, command.args, LAUNCH_OPTIONS);
  try {
    child.unref();
  } catch (_) {
    /* unref is best-effort */
  }
  return child;
}

function beepFallback(config, say, reason) {
  if (config && config.fallbackBeep === false) return { ok: false, reason, beep: false };
  try {
    spawnLauncher(buildBeepCommand());
    say("fallback beep spawned (reason: " + reason + ")");
    return { ok: false, reason, beep: true };
  } catch (error) {
    say("fallback beep failed: " + errText(error));
    return { ok: false, reason, beep: false };
  }
}

/**
 * Play one voice cue through powershell -> Start-Process -> python.
 * Resolution order: loud copy -> original -> beep. Never throws.
 */
export function playKind(kind, config, log) {
  const say = typeof log === "function" ? log : function () {};
  if (kind !== "complete" && kind !== "fail" && kind !== "approval") {
    say("play skipped: unknown kind " + String(kind));
    return { ok: false, reason: "unknown-kind" };
  }
  try {
    const resolved = resolveAudio(kind, config);
    if (resolved.mode === "none") {
      const missing = resolved.candidates
        .map(function (candidate) {
          return candidate.mode + "=" + candidate.file;
        })
        .join(", ");
      say("play skipped: no audio file for kind=" + kind + " (" + missing + ")");
      return beepFallback(config, say, "audio-missing");
    }
    if (!existsSync(config.pythonPath)) {
      say("play skipped: python not found: " + config.pythonPath);
      return beepFallback(config, say, "python-missing");
    }
    // 备选内核（config.playerEngine="wav"）：先试 waveOut 播 WAV；不可用/失败就继续
    // 走下面的 MCI 路径（保证一定有声，绝不因为换内核而静音）。
    const viaWav = tryPlayViaWav(resolved.file, config, say);
    if (viaWav.ok) {
      return {
        ok: true,
        reason: "launched",
        kind,
        audioMode: resolved.mode,
        audioFile: resolved.file,
        playFile: viaWav.file,
        scratchCopy: false,
        engine: "wav",
      };
    }
    if (viaWav.reason !== "engine-is-mci") {
      say("wav engine unavailable (" + String(viaWav.reason) + "), falling back to MCI");
    }
    // Never hand the production artifact to the player: a cue playing from the
    // real file would block a concurrent regeneration (EBUSY, 2026-09-15).
    const prepared = preparePlaybackFile(kind, resolved.file, config, { log: say });
    const command = buildPlayCommand(kind, config, { prepared });
    if (!command.playerPath || !existsSync(command.playerPath)) {
      say("play skipped: player not found: " + String(command.playerPath));
      if (prepared.cleanup) prepared.cleanup();
      return beepFallback(config, say, "player-missing");
    }
    if (!command.isScratchCopy && prepared.cleanup) {
      // The shared-player fallback re-resolves the production file itself, so the
      // prepared copy would only leak.
      prepared.cleanup();
    }
    spawnLauncher(command);
    say(
      "play launched (hidden powershell -> Start-Process): kind=" +
        kind +
        " audio=" +
        command.audioMode +
        " file=" +
        command.playFile +
        " scratchCopy=" +
        String(command.isScratchCopy) +
        " player=" +
        command.playerKind,
    );
    return {
      ok: true,
      reason: "launched",
      kind,
      audioMode: command.audioMode,
      audioFile: command.audioFile,
      playFile: command.playFile,
      scratchCopy: command.isScratchCopy,
    };
  } catch (error) {
    say("play failed to launch (kind=" + kind + "): " + errText(error));
    return beepFallback(config, say, "launch-failed: " + errText(error));
  }
}

// ---------------------------------------------------------------- sound effects

/**
 * Absolute path of one catalogue sound effect (requirement B).
 *
 * The stem is re-checked here even though config.js already validated it: this is
 * the last gate before a path reaches the player, and a path must never be built
 * from raw input (a `../` stem would otherwise escape the sfx directory).
 * @returns { string|null } null when the stem is not a plain [a-z0-9-] token.
 */
export function sfxPathFor(key, config) {
  const stem = String(key === undefined || key === null ? "" : key);
  if (!/^[a-z0-9-]+$/u.test(stem)) return null;
  return join(String(config.sfxDir), stem + ".mp3");
}

/**
 * Launch command for one sound effect.
 *
 * Unlike buildPlayCommand (which re-resolves a voice cue from `kind` through the
 * loud/original policy), an effect is one known file, so the bundled `--file`
 * player is the only correct choice: the shared player resolves `--kind` itself
 * and would play a voice line instead of the effect. No bundled player => the
 * caller falls back to the beep, because the wrong cue is worse than a short beep.
 */
export function buildSfxPlayCommand(key, file, config, options) {
  const opts = options || {};
  const prepared = opts.prepared || null;
  const target = prepared && prepared.file ? prepared.file : file;
  const bundled = bundledPlayerPath(config);
  const bundledAvailable = Boolean(bundled) && existsSync(String(bundled));
  const playerPath = bundledAvailable ? bundled : null;
  const playerArgs = playerPath
    ? ["--file", target]
        .concat(prepared ? ["--delete-after-play"] : [])
        .concat(config.logPath ? ["--log-file", String(config.logPath)] : [])
    : [];
  const argumentList = [psQuote("-u"), psQuote(playerPath)]
    .concat(playerArgs.map(psQuote))
    .join(",");
  const inner = [
    "Start-Process",
    "-FilePath " + psQuote(config.pythonPath),
    "-ArgumentList @(" + argumentList + ")",
    "-WindowStyle Hidden",
    "-PassThru",
    "| Out-Null",
  ].join(" ");
  return {
    file: POWERSHELL_EXE,
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-Command",
      inner,
    ],
    inner,
    sfxKey: String(key),
    audioFile: file,
    playFile: target,
    isScratchCopy: Boolean(prepared && prepared.copy),
    playerPath,
    playerKind: bundledAvailable ? "bundled-mci" : "none",
  };
}

/**
 * Play one built-in sound effect. Same launch chain (hidden powershell ->
 * Start-Process -> python MCI player), same scratch-copy rule and the same silent
 * degradation as playKind; only the file source differs (a catalogue stem instead
 * of the per-kind voice cue). Never throws.
 */
export function playSfx(key, config, log) {
  const say = typeof log === "function" ? log : function () {};
  try {
    const file = sfxPathFor(key, config);
    if (!file) {
      say("sfx skipped: unsafe key " + String(key));
      return { ok: false, reason: "unsafe-key" };
    }
    if (!existsSync(file)) {
      say("sfx skipped: file not found: " + file);
      return beepFallback(config, say, "sfx-missing");
    }
    if (!existsSync(config.pythonPath)) {
      say("play skipped: python not found: " + config.pythonPath);
      return beepFallback(config, say, "python-missing");
    }
    // Same EBUSY rule as the voice cues: the player opens a scratch copy, never the
    // library file, so a future "edit the effect library" can never be blocked by a
    // cue that happens to be playing.
    const viaWav = tryPlayViaWav(file, config, say);
    if (viaWav.ok) {
      return {
        ok: true,
        reason: "launched",
        sfxKey: String(key),
        audioFile: file,
        playFile: viaWav.file,
        scratchCopy: false,
        engine: "wav",
      };
    }
    if (viaWav.reason !== "engine-is-mci") {
      say("wav engine unavailable (" + String(viaWav.reason) + "), falling back to MCI");
    }
    const prepared = preparePlaybackFile(key, file, config, { log: say });
    const command = buildSfxPlayCommand(key, file, config, { prepared });
    if (!command.playerPath || !existsSync(command.playerPath)) {
      say("sfx skipped: bundled player not found: " + String(command.playerPath));
      if (prepared.cleanup) prepared.cleanup();
      return beepFallback(config, say, "player-missing");
    }
    spawnLauncher(command);
    say(
      "sfx launched: key=" +
        String(key) +
        " file=" +
        command.playFile +
        " scratchCopy=" +
        String(command.isScratchCopy),
    );
    return {
      ok: true,
      reason: "launched",
      sfxKey: String(key),
      audioFile: file,
      playFile: command.playFile,
      scratchCopy: command.isScratchCopy,
    };
  } catch (error) {
    say("sfx failed to launch (key=" + String(key) + "): " + errText(error));
    return beepFallback(config, say, "launch-failed: " + errText(error));
  }
}

// ------------------------------------------------- 备选播放内核：waveOut / WAV
//
// 默认内核是 MCI（"type mpegvideo" → DirectShow）。DirectShow 会创建播放图并打开音频
// 端点，在蓝牙耳机上可能触发链路重协商，打断其他正在播放的音乐（用户 2026-09-16 反馈
// "播报后音乐显示在播但没声音"）。waveOut（winsound）是 Windows 最基础的播放路径，
// 不启 DirectShow、不枚举设备，对链路和其他播放器冲击最小。
// 通过 config.playerEngine = "wav" 启用；任何失败都自动回退 MCI，保证一定有声。

/** 当前播放内核：只认 "wav"，其它一律 mci。 */
export function resolvePlayerEngine(config) {
  return String(config && config.playerEngine) === "wav" ? "wav" : "mci";
}

/** WAV 播放器脚本路径（不存在则返回 null）。 */
export function wavPlayerPath() {
  const candidate = join(PLUGIN_DIR, "lib", "play_wav_out.py");
  return existsSync(candidate) ? candidate : null;
}

/** 某个音频文件对应的 WAV 缓存路径（同目录同名的 .wav）。 */
export function wavCacheFileFor(sourceFile, config) {
  const dir = String(config.wavCacheDir || "");
  const base = String(sourceFile).replace(/^.*[\\/]/u, "").replace(/\.[^.]+$/u, "");
  return join(dir, base + ".wav");
}

/**
 * 确保 WAV 缓存存在：ffmpeg 一次性转换，命中且不比源旧就复用。
 * 语音重新生成后源文件会更新，这里用 mtime 判断，过期就重转。
 * @returns { ok, file, converted, reason? }
 */
export function ensureWavCache(sourceFile, config, options) {
  const opts = options || {};
  const say = typeof opts.log === "function" ? opts.log : function () {};
  const target = wavCacheFileFor(sourceFile, config);
  try {
    if (existsSync(target)) {
      try {
        if (statSync(target).mtimeMs >= statSync(sourceFile).mtimeMs) {
          return { ok: true, file: target, converted: false };
        }
      } catch (_) {
        /* 比较失败就当缓存可用 */
        return { ok: true, file: target, converted: false };
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    const ffmpeg = String(config.ffmpegPath || "ffmpeg");
    const run = spawnSync(
      ffmpeg,
      ["-y", "-hide_banner", "-loglevel", "error", "-i", String(sourceFile), "-acodec", "pcm_s16le", target],
      { windowsHide: true, encoding: "utf8", timeout: 30000 },
    );
    if (run.status !== 0 || !existsSync(target)) {
      const reason = "ffmpeg exit " + String(run.status) + " " + String(run.stderr || "").slice(0, 120);
      say("wav cache build failed: " + reason);
      return { ok: false, file: target, converted: false, reason };
    }
    say("wav cache built: " + target);
    return { ok: true, file: target, converted: true };
  } catch (error) {
    return { ok: false, file: target, converted: false, reason: errText(error) };
  }
}

/** 启动命令：hidden powershell → Start-Process → python play_wav_out.py（与主内核同架构）。 */
export function buildWavPlayCommand(wavFile, config) {
  const playerPath = wavPlayerPath();
  const args = playerPath
    ? ["--file", wavFile].concat(config.logPath ? ["--log-file", String(config.logPath)] : [])
    : [];
  const argumentList = [psQuote("-u"), psQuote(playerPath)]
    .concat(args.map(psQuote))
    .join(",");
  const inner = [
    "Start-Process",
    "-FilePath " + psQuote(config.pythonPath),
    "-ArgumentList @(" + argumentList + ")",
    "-WindowStyle Hidden",
    "-PassThru",
    "| Out-Null",
  ].join(" ");
  return {
    file: POWERSHELL_EXE,
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-Command",
      inner,
    ],
    inner,
    audioFile: wavFile,
    playFile: wavFile,
    playerPath,
    playerKind: playerPath ? "wav-out" : "none",
  };
}

/**
 * 尝试用 WAV 内核启动一次播放。
 * @returns { ok, reason, file?, result? } —— ok=false 时调用方应回退 MCI。
 */
export function tryPlayViaWav(file, config, log) {
  const say = typeof log === "function" ? log : function () {};
  if (resolvePlayerEngine(config) !== "wav") return { ok: false, reason: "engine-is-mci" };
  const cached = ensureWavCache(file, config, { log: say });
  if (!cached.ok) return { ok: false, reason: cached.reason || "wav-cache-failed" };
  const command = buildWavPlayCommand(cached.file, config);
  if (!command.playerPath || !existsSync(command.playerPath)) {
    return { ok: false, reason: "wav-player-missing" };
  }
  if (!existsSync(config.pythonPath)) return { ok: false, reason: "python-missing" };
  try {
    spawnLauncher(command);
    say("play launched (wav engine): file=" + cached.file + " converted=" + String(cached.converted));
    return { ok: true, reason: "launched", file: cached.file, converted: cached.converted };
  } catch (error) {
    return { ok: false, reason: "launch-failed: " + errText(error) };
  }
}


