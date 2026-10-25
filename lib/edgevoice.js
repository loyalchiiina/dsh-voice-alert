// dsh-voice-alert - free built-in voices via edge-tts (no API key required).
//
// WHY this exists (user request 2026-10-24: "内嵌免费得不需要api得字生语音，
// 安装上直接体验语音提醒"): the Volcengine voices need a personal key, so a
// fresh install cannot produce ANY speech out of the box. edge-tts (pip, MIT)
// reaches Microsoft's public Edge "Read Aloud" endpoints with zero credentials,
// and the zh-TW female voices (HsiaoChen / HsiaoYu) match the user's stated
// taste ("甜美得女生声音台湾腔"). Synthesis needs a network; the RESULT mp3 is
// cached on disk like a key-voice cue and replays offline afterwards.
//
// Contract: synthesizeEdge() returns the same shape as tts.js synthesize()
// ({ ok, bytes, error?, reason?, kind }) so callers can branch on
// voice.kind === "free" with no other changes. It NEVER throws.
//
// Safety notes:
//   - python is resolved through player.js resolvePython() (skips the Windows
//     Apps "App Execution Alias" stub that masquerades as `python`);
//   - text goes to the child process as an argv element, never through a shell;
//   - output lands in a temp file under DATA_DIR\edge-tmp and is removed on
//     every exit path;
//   - edgeRuntimeStatus() only checks the import, not the network (cheap).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.js";
import { resolvePython } from "./player.js";

/**
 * Build the edge-tts argv for one synthesis (pure function - self-checkable).
 * rate/pitch come from the FREE_VOICES catalogue entry, tuned by ear against
 * the 2026-10 sample clips (台湾腔 +25Hz 更嗲 etc.). Only well-formed values
 * are passed on; anything else keeps edge-tts' own default.
 */
export function edgeArgsFor(text, freeVoice, outFile) {
  const voice = freeVoice || {};
  const args = ["-m", "edge_tts", "--no-progress", "--voice", String(voice.edgeVoice || "")];
  const rate = String(voice.rate || "");
  const pitch = String(voice.pitch || "");
  if (/^[+-]\d+%$/u.test(rate)) args.push("--rate", rate);
  if (/^[+-]\d+Hz$/u.test(pitch)) args.push("--pitch", pitch);
  args.push("--text", String(text), "--write-media", String(outFile));
  return args;
}

/**
 * Synthesize `text` with one free catalogue voice.
 * @param {object} options { text, voice, config, log, timeoutMs?, spawnImpl? }
 *   voice - the FREE_VOICES entry (needs edgeVoice; id only names the temp file);
 *   spawnImpl - injectable child spawner for the self-check (defaults to node
 *   child_process.spawn; resolves with a fake result, never really spawns).
 * @returns {Promise<{ok:boolean, bytes?:Buffer, error?:string, reason?:string, kind:"free"}>}
 */
export function synthesizeEdge(options) {
  const opts = options || {};
  const text = String(opts.text || "").trim();
  const voice = opts.voice || null;
  const config = opts.config || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 90000;

  if (text.length === 0) {
    return Promise.resolve({ ok: false, error: "empty text", reason: "edge-empty-text", kind: "free" });
  }
  if (!voice || !voice.edgeVoice) {
    return Promise.resolve({ ok: false, error: "not a free voice", reason: "edge-not-free", kind: "free" });
  }
  const py = resolvePython(config);
  if (!py || !py.path || !existsSync(py.path)) {
    return Promise.resolve({
      ok: false,
      error: "找不到可用的 Python（免费音色用 edge-tts 合成，需要 python + pip install edge-tts）",
      reason: "edge-python-missing",
      kind: "free",
    });
  }

  // v0.4.17 e2e 实测 D5：以前这里回退到写死的 DATA_DIR，试听缓存换不了盘、也会被
  // 同一台机器上的第二个实例共用。现在统一读 config.edgeTmpDir（默认仍是 DATA_DIR\edge-tmp）。
  const tmpDir = String(config.edgeTmpDir || join(DATA_DIR, "edge-tmp")).trim() || join(DATA_DIR, "edge-tmp");
  // voice.id 形如 "free:tw-chen"，冒号在 NTFS 上是交替数据流(ADS)分隔符：
  // 直接拼进文件名，rmSync 删掉的是数据流、留下 0 字节的宿主文件（每次合成泄漏
  // 一个，实测见 edge-tmp\edge-1792...-free）。这里先把 id 洗成纯文件名安全字符。
  const safeId = String(voice.id || "free").replace(/[^a-z0-9_-]+/giu, "_").slice(0, 60) || "free";
  const outFile = join(tmpDir, "edge-" + String(Date.now()) + "-" + safeId + ".mp3");
  const spawnImpl = typeof opts.spawnImpl === "function" ? opts.spawnImpl : spawn;
  // 用户的语速滑块要生效（否则免费音色会忽略「语速」，行为与火山音色不一致）。
  const effectiveVoice = {
    id: voice.id,
    edgeVoice: voice.edgeVoice,
    pitch: voice.pitch,
    rate: edgeRateFor(voice, opts.prosody || config.prosody),
  };

  return new Promise(function (resolve) {
    let child = null;
    try {
      mkdirSync(tmpDir, { recursive: true });
      child = spawnImpl(py.path, edgeArgsFor(text, effectiveVoice, outFile), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, error: String((error && error.message) || error), reason: "edge-spawn-failed", kind: "free" });
      return;
    }

    let stderr = "";
    let settled = false;
    const collect = function (chunk) {
      stderr = (stderr + String(chunk)).slice(-4000);
    };
    const finish = function (result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child && child.exitCode === null && !child.killed) child.kill();
      } catch (_) {
        /* already gone */
      }
      try {
        if (existsSync(outFile)) rmSync(outFile, { force: true });
      } catch (_) {
        /* best effort */
      }
      resolve(result);
    };
    const timer = setTimeout(function () {
      finish({ ok: false, error: "edge-tts 合成超时（" + String(Math.round(timeoutMs / 1000)) + "s，网络可能不通）", reason: "edge-timeout", kind: "free" });
    }, timeoutMs);
    // 挂流监听整体包在 try 里：本函数的契约是「永不 reject、永不 throw」，
    // 自检注入的假 child 若没有可用的 stream（没有 .on / .setEncoding），也必须
    // 走正常的失败分支返回，而不是把 Promise 变成 rejected。
    const attach = function (stream) {
      if (!stream) return;
      try {
        if (typeof stream.setEncoding === "function") stream.setEncoding("utf8");
        if (typeof stream.on === "function") stream.on("data", collect);
      } catch (_) {
        /* fake / exotic stream: keep going, stderr just stays empty */
      }
    };
    attach(child && child.stderr);
    attach(child && child.stdout);
    if (!child || typeof child.on !== "function") {
      finish({ ok: false, error: "edge-tts 进程未能启动", reason: "edge-spawn-failed", kind: "free" });
      return;
    }
    child.on("error", function (error) {
      finish({ ok: false, error: String((error && error.message) || error), reason: "edge-spawn-error", kind: "free" });
    });
    child.on("close", function (code) {
      if (Number(code) === 0 && existsSync(outFile)) {
        let bytes = null;
        try {
          bytes = readFileSync(outFile);
        } catch (error) {
          finish({ ok: false, error: "读取合成结果失败: " + String((error && error.message) || error), reason: "edge-read-failed", kind: "free" });
          return;
        }
        if (bytes && bytes.length > 200) {
          log("edge-tts ok: voice=" + String(voice.edgeVoice) + " bytes=" + String(bytes.length));
          finish({ ok: true, bytes: bytes, kind: "free" });
          return;
        }
        finish({ ok: false, error: "edge-tts 产出的文件太小（可能网络中断）", reason: "edge-empty-output", kind: "free" });
        return;
      }
      const lower = stderr.toLowerCase();
      let reason = "edge-failed";
      if (lower.indexOf("no module named") >= 0 && lower.indexOf("edge_tts") >= 0) reason = "edge-tts-not-installed";
      else if (lower.indexOf("network") >= 0 || lower.indexOf("getaddrinfo") >= 0 || lower.indexOf("timed out") >= 0 || lower.indexOf("certificate") >= 0) reason = "edge-offline";
      const tail = stderr.split(/\r?\n/u).filter(Boolean).slice(-2).join(" | ");
      log("edge-tts failed: code=" + String(code) + " reason=" + reason + " stderr=" + tail);
      finish({
        ok: false,
        error: "edge-tts 合成失败（" + reason + "）" + (tail ? "：" + String(tail).slice(0, 200) : "，退出码 " + String(code)),
        reason: reason,
        kind: "free",
      });
    });
  });
}

/**
 * Availability probe for the settings UI (cheap, no synthesis): python present +
 * edge_tts importable. Network failure is NOT detected here (it surfaces at
 * synth time as edge-offline/edge-timeout with its own reason code).
 * @param {object} config
 * @param {object} options { spawnSyncImpl? } - injectable for the self-check.
 * @returns {{python:boolean, edgeTts:boolean, pythonPath:string}}
 */
export function edgeRuntimeStatus(config, options) {
  const opts = options || {};
  const py = resolvePython(config || {});
  if (!py || !py.path || !existsSync(py.path)) {
    return { python: false, edgeTts: false, pythonPath: String((py && py.path) || "") };
  }
  try {
    const runSync = typeof opts.spawnSyncImpl === "function" ? opts.spawnSyncImpl : spawnSync;
    const run = runSync(py.path, ["-c", "import edge_tts"], { windowsHide: true, timeout: 15000, encoding: "utf8" });
    return { python: true, edgeTts: Number(run && run.status) === 0, pythonPath: py.path };
  } catch (_) {
    return { python: true, edgeTts: false, pythonPath: py.path };
  }
}

/**
 * Async twin of edgeRuntimeStatus for HTTP handlers.
 *
 * WHY: the settings page asks for this on every open, and a blocked spawnSync
 * (a hung python, a cold AV scan) would stall the whole DSH web server for up to
 * its 15s timeout. A hung `import edge_tts` must never take the harness down, so
 * the route uses this non-blocking version plus a TTL cache in index.js.
 * @param {object} config
 * @param {object} options { timeoutMs?, spawnImpl? }
 * @returns {Promise<{python:boolean, edgeTts:boolean, pythonPath:string}>}
 */
export function edgeRuntimeStatusAsync(config, options) {
  const opts = options || {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 12000;
  const py = resolvePython(config || {});
  if (!py || !py.path || !existsSync(py.path)) {
    return Promise.resolve({ python: false, edgeTts: false, pythonPath: String((py && py.path) || "") });
  }
  const spawnImpl = typeof opts.spawnImpl === "function" ? opts.spawnImpl : spawn;
  return new Promise(function (resolve) {
    let child = null;
    try {
      child = spawnImpl(py.path, ["-c", "import edge_tts"], { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    } catch (_) {
      resolve({ python: true, edgeTts: false, pythonPath: py.path });
      return;
    }
    let settled = false;
    const finish = function (edgeTts) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child && child.exitCode === null && !child.killed) child.kill();
      } catch (_) {
        /* gone */
      }
      resolve({ python: true, edgeTts: Boolean(edgeTts), pythonPath: py.path });
    };
    const timer = setTimeout(function () {
      finish(false);
    }, timeoutMs);
    if (!child || typeof child.on !== "function") {
      finish(false);
      return;
    }
    child.on("error", function () {
      finish(false);
    });
    child.on("close", function (code) {
      finish(Number(code) === 0);
    });
  });
}

/**
 * Map the plugin's prosody onto the edge-tts rate argument (pure, testable).
 *
 * The catalogue carries an ear-tuned pitch per voice (the "+25Hz 嗲版" the user
 * accepted), so pitch stays untouched; only the user's own speed slider is
 * folded in additively, so「语速 1.2」speeds up a free voice as it does a
 * Volcengine one instead of being silently ignored.
 * @returns {string} edge-tts rate argument, e.g. "+15%"
 */
export function edgeRateFor(freeVoice, prosody) {
  const base = /^([+-]\d+)%$/u.exec(String((freeVoice && freeVoice.rate) || ""));
  let percent = base ? Number(base[1]) : 0;
  const speed = Number(prosody && prosody.speed_ratio);
  if (Number.isFinite(speed) && speed > 0) {
    percent += Math.round((speed - 1) * 100);
  }
  percent = Math.max(-90, Math.min(200, percent));
  return (percent >= 0 ? "+" : "-") + String(Math.abs(percent)) + "%";
}
