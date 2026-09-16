// dsh-voice-alert - offline self-check (host/DOM independent).
//
// Runs WITHOUT DSH:
//   1. wiring test - a fake cordis ctx records the listeners `apply()` registers,
//      then replays the real event shapes and asserts which voice is played;
//   2. rule tests  - per-turn dedupe, error priority at turn end, the 5s error
//      throttle, subagent-session skip, aborted-turn policy, enabled=false;
//   3. shape test  - the production playback command spawns powershell
//      Start-Process (NOT python as a DSH child);
//   4. REAL playback - one real playback through the production path (audible)
//      plus one synchronous player run whose exit code proves the MP3 path works.
//
// Usage:  node test/self-check.mjs            (default: includes the real playback)
//         node test/self-check.mjs --no-sound (skip section 4)

import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { apply } from "../lib/index.js";
import { createEngine } from "../lib/engine.js";
import { parseControlText } from "../lib/control.js";
import {
  normalizeEditablePatch,
  resolveConfig,
  saveEditableConfig,
  saveVoicesConfig,
  parseVoiceImport,
  mergeVoiceImport,
  normalizeVoices,
  resolveVoice,
  voiceKeyErrorCode,
  ALERT_MODES,
  SFX_CATALOG,
  DEFAULT_SFX_BY_KIND,
  isKnownSfxKey,
  normalizeSfxByKind,
} from "../lib/config.js";
import {
  createGenerator,
  fingerprintFor,
  planChanges,
  renameWithRetry,
  tempGainPath,
  writeGenerateState,
} from "../lib/generate.js";
import { buildTtsRequestForVoice } from "../lib/tts.js";
import {
  LAUNCH_OPTIONS,
  POWERSHELL_EXE,
  buildPlayCommand,
  buildSfxPlayCommand,
  buildWavPlayCommand,
  bundledPlayerPath,
  ensureWavCache,
  loudFileFor,
  playKind,
  playSfx,
  preparePlaybackFile,
  prunePlaybackCopies,
  resolveAudio,
  resolvePlayerEngine,
  resolvePython,
  sfxPathFor,
  tryPlayViaWav,
  wavCacheFileFor,
  wavPlayerPath,
} from "../lib/player.js";
import { DEFAULT_CONFIG } from "../lib/config.js";

const retryCodes = ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"];

const sleep = function (ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
};

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failures.push(label + (detail ? " -- " + detail : ""));
    console.log("  FAIL  " + label + (detail ? "  [" + detail + "]" : ""));
  }
}

function section(title) {
  console.log("");
  console.log("== " + title);
}

// ---------------------------------------------------------------- fixtures

function rootSession(id) {
  return { id, header: { id } };
}

function childSession(id, parentId) {
  return { id, header: { id, origin: "subagent", delegationDepth: 1, parentSession: parentId } };
}

function sessionEvent(type, data) {
  return { type, data };
}

function toolExec(session, name) {
  return { name: name || "some_tool", callId: "call-1", agent: { session } };
}

/** Minimal cordis ctx stand-in: records listeners, lets the test emit. */
function createFakeCtx(options) {
  const opts = options || {};
  const listeners = new Map();
  const logs = [];
  const routes = [];
  const ctx = {
    logger: {
      info(message) { logs.push(String(message)); },
      warn(message) { logs.push(String(message)); },
      error(message) { logs.push(String(message)); },
    },
    on(eventName, callback) {
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(callback);
      return function () {};
    },
    effect(factory) {
      return factory();
    },
    inject(names, callback) {
      // The plugin mounts its diagnostic routes only when webServer is present.
      if (opts.webServer === true && Array.isArray(names) && names.indexOf("webServer") >= 0) {
        const webCtx = {
          webServer: {
            register(route) {
              routes.push(route);
              return function dispose() {
                const at = routes.indexOf(route);
                if (at >= 0) routes.splice(at, 1);
              };
            },
          },
        };
        return callback(webCtx);
      }
      return undefined;
    },
    emit(eventName) {
      const args = Array.prototype.slice.call(arguments, 1);
      for (const callback of listeners.get(eventName) || []) callback.apply(null, args);
    },
    _listeners: listeners,
    _logs: logs,
    _routes: routes,
  };
  return ctx;
}

/**
 * Mount the real plugin with a recording player and a controllable clock.
 * The control-channel files are redirected into the test temp dir so a test run
 * never touches the live data directory.
 */
function mount(rowConfig, options) {
  const opts = options || {};
  const calls = [];
  const ctx = createFakeCtx({ webServer: opts.webServer === true });
  const clock = { value: options && options.clock ? options.clock : 1000000 };
  const controlDir = opts.tmpDir;
  let controlChannel = null;
  const deps = {
    configPath: null, // never touch the real config.json
    now() { return clock.value; },
    onControlReady(channel) { controlChannel = channel; },
  };
  if (opts.realPlay !== true) {
    deps.play = function (kind, meta, config, extra) { calls.push({ kind, meta, extra }); };
  }
  if (opts.fetchImpl) deps.fetchImpl = opts.fetchImpl;
  apply(
    ctx,
    Object.assign(
      {
        logPath: join(opts.tmpDir, "self-check.log"),
        controlFile: join(controlDir, "control.txt"),
        controlResultFile: join(controlDir, "control-result.txt"),
        statusFile: join(controlDir, "status.json"),
        controlPollMs: 250,
      },
      rowConfig || {},
    ),
    deps,
  );
  return { ctx, calls, clock, logs: ctx._logs, control: controlChannel };
}

// ---------------------------------------------------------------- 1. wiring

const tmpDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-"));
const wired = mount({}, { tmpDir });
const root = rootSession("session-root-1");

section("1. wiring: apply() registers the three event listeners");
check("session/event listener registered", typeof (wired.ctx._listeners.get("session/event") || [])[0] === "function");
check("agent/error listener registered", typeof (wired.ctx._listeners.get("agent/error") || [])[0] === "function");
check("tools/result listener registered", typeof (wired.ctx._listeners.get("tools/result") || [])[0] === "function");

wired.ctx.emit("session/event", root, sessionEvent("turn/start", { turn: 1 }));
wired.ctx.emit("session/event", root, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
check("clean turn end -> complete voice", wired.calls.length === 1 && wired.calls[0].kind === "complete", JSON.stringify(wired.calls));
check("turn-end meta carries the session and turn", wired.calls[0].meta.source === "turn-end" && wired.calls[0].meta.sessionId === "session-root-1" && wired.calls[0].meta.turn === 1);

// ---------------------------------------------------------------- 2. rules

section("2a. error inside a turn -> the turn ends with the FAIL voice (no complete)");
wired.ctx.emit("session/event", root, sessionEvent("turn/start", { turn: 2 }));
wired.ctx.emit("tools/result", toolExec(root, "mcp__ansys-fluent__detect"), { isError: true, content: [] });
wired.ctx.emit("session/event", root, sessionEvent("turn/end", { turn: 2, reason: { kind: "completed" } }));
const afterTurn2 = wired.calls.slice(1);
check("failed tool call plays fail immediately", afterTurn2[0] && afterTurn2[0].kind === "fail" && afterTurn2[0].meta.source === "tools/result", JSON.stringify(afterTurn2));
check("that turn end does not play complete", afterTurn2.filter((c) => c.kind === "complete").length === 0, JSON.stringify(afterTurn2));
check("fail at turn end is suppressed by the 5s throttle right after the immediate fail", afterTurn2.length === 1, JSON.stringify(afterTurn2));

section("2b. agent/error inside a turn -> fail at turn end");
wired.clock.value += 60000;
wired.ctx.emit("session/event", root, sessionEvent("turn/start", { turn: 3 }));
wired.ctx.emit("agent/error", { agent: { session: root }, turn: 3, step: 1, error: new Error("boom") });
wired.ctx.emit("session/event", root, sessionEvent("turn/end", { turn: 3, reason: { kind: "error" } }));
const afterTurn3 = wired.calls.slice(1 + afterTurn2.length);
check("agent/error plays fail", afterTurn3[0] && afterTurn3[0].kind === "fail" && afterTurn3[0].meta.source === "agent/error", JSON.stringify(afterTurn3));
check("no complete for an errored turn", afterTurn3.filter((c) => c.kind === "complete").length === 0, JSON.stringify(afterTurn3));

section("2c. per-turn dedupe: the same turn/end twice plays once");
const beforeDupe = wired.calls.length;
wired.ctx.emit("session/event", root, sessionEvent("turn/end", { turn: 3, reason: { kind: "error" } }));
check("duplicate turn/end ignored", wired.calls.length === beforeDupe, "calls " + beforeDupe + " -> " + wired.calls.length);

section("2d. 5s error throttle");
const fresh = mount({ errorMinIntervalMs: 5000 }, { tmpDir });
const s2 = rootSession("session-root-2");
fresh.ctx.emit("session/event", s2, sessionEvent("turn/start", { turn: 1 }));
fresh.ctx.emit("tools/result", toolExec(s2, "tool_a"), { isError: true });
fresh.ctx.emit("tools/result", toolExec(s2, "tool_b"), { isError: true });
check("second error within 5s is throttled", fresh.calls.length === 1, JSON.stringify(fresh.calls));
fresh.clock.value += 5000;
fresh.ctx.emit("tools/result", toolExec(s2, "tool_c"), { isError: true });
check("error after 5s plays again", fresh.calls.length === 2, JSON.stringify(fresh.calls));

section("2e. subagent sessions are skipped");
const sub = mount({}, { tmpDir });
const child = childSession("session-child-1", "session-root-9");
sub.ctx.emit("session/event", child, sessionEvent("turn/start", { turn: 1 }));
sub.ctx.emit("session/event", child, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
sub.ctx.emit("agent/error", { agent: { session: child }, turn: 1, error: new Error("child boom") });
check("delegated turn end plays nothing", sub.calls.length === 0, JSON.stringify(sub.calls));

section("2f. aborted turns");
const abort = mount({}, { tmpDir });
const s3 = rootSession("session-root-3");
abort.ctx.emit("session/event", s3, sessionEvent("turn/start", { turn: 1 }));
abort.ctx.emit("session/event", s3, sessionEvent("turn/end", { turn: 1, reason: { kind: "aborted" } }));
check("abortPlays=none -> no voice", abort.calls.length === 0, JSON.stringify(abort.calls));

section("2g. enabled=false silences everything");
const off = mount({ enabled: false }, { tmpDir });
const s4 = rootSession("session-root-4");
off.ctx.emit("session/event", s4, sessionEvent("turn/start", { turn: 1 }));
off.ctx.emit("tools/result", toolExec(s4, "tool_x"), { isError: true });
off.ctx.emit("session/event", s4, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
check("no plays when disabled", off.calls.length === 0, JSON.stringify(off.calls));

section("2h. engine-level: unknown events are inert");
const inert = createEngine({ config: Object.assign({}, DEFAULT_CONFIG), play() {}, log() {} });
inert.onSessionEvent(rootSession("s"), sessionEvent("assistant/message", { message: {} }));
inert.onToolResult(toolExec(rootSession("s"), "ok_tool"), { isError: false });
check("no throw on unrelated events; snapshot readable", typeof inert.snapshot().stats.turnEnds === "number");
inert.dispose();

// ------------------------------------------------- 2i. anti "fail then complete" chain

section("2i. suppressCompleteAfterFailMs (default 3000) kills the fail+complete chain");
const chain = mount({ errorMinIntervalMs: 0 }, { tmpDir });
const c1 = rootSession("session-chain-1");
chain.ctx.emit("tools/result", toolExec(c1, "tool_boom"), { isError: true });
check("fail cue plays first", chain.calls.length === 1 && chain.calls[0].kind === "fail", JSON.stringify(chain.calls));
chain.clock.value += 1000; // 1s later: inside the 3s window
chain.ctx.emit("session/event", c1, sessionEvent("turn/start", { turn: 7 }));
chain.ctx.emit("session/event", c1, sessionEvent("turn/end", { turn: 7, reason: { kind: "completed" } }));
check(
  "turn/end 1s after a fail does NOT play complete",
  chain.calls.length === 1,
  JSON.stringify(chain.calls),
);
chain.clock.value += 3000; // now 4s after the fail: outside the window
chain.ctx.emit("session/event", c1, sessionEvent("turn/start", { turn: 8 }));
chain.ctx.emit("session/event", c1, sessionEvent("turn/end", { turn: 8, reason: { kind: "completed" } }));
check(
  "turn/end 4s after a fail plays complete again",
  chain.calls.length === 2 && chain.calls[1].kind === "complete",
  JSON.stringify(chain.calls),
);

const chainOff = mount({ suppressCompleteAfterFailMs: 0, errorMinIntervalMs: 0 }, { tmpDir });
const c2 = rootSession("session-chain-2");
chainOff.ctx.emit("tools/result", toolExec(c2, "tool_boom"), { isError: true });
chainOff.clock.value += 1000;
chainOff.ctx.emit("session/event", c2, sessionEvent("turn/start", { turn: 1 }));
chainOff.ctx.emit("session/event", c2, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
check(
  "suppressCompleteAfterFailMs=0 disables the gate",
  chainOff.calls.length === 2 && chainOff.calls[1].kind === "complete",
  JSON.stringify(chainOff.calls),
);

const failSide = mount({ errorMinIntervalMs: 5000, suppressCompleteAfterFailMs: 3000 }, { tmpDir });
const c3 = rootSession("session-chain-3");
failSide.ctx.emit("session/event", c3, sessionEvent("turn/start", { turn: 1 }));
failSide.ctx.emit("agent/error", { agent: { session: c3 }, turn: 1, error: new Error("boom") });
failSide.clock.value += 500;
failSide.ctx.emit("session/event", c3, sessionEvent("turn/end", { turn: 1, reason: { kind: "error" } }));
check(
  "fail cues are NOT suppressed by this gate (only complete is)",
  failSide.calls.filter((c) => c.kind === "fail").length === 1 && failSide.calls.filter((c) => c.kind === "complete").length === 0,
  JSON.stringify(failSide.calls),
);
failSide.clock.value += 6000;
failSide.ctx.emit("session/event", c3, sessionEvent("turn/start", { turn: 2 }));
failSide.ctx.emit("tools/result", toolExec(c3, "tool_boom2"), { isError: true });
check(
  "a later fail still plays after the window (fail path untouched)",
  failSide.calls.filter((c) => c.kind === "fail").length === 2,
  JSON.stringify(failSide.calls),
);

// ------------------------------------------------- 2j. credential-free control channel

section("2j. control channel: file trigger + status snapshot (no HTTP credential needed)");
check("parser: 'kind=complete' -> complete", parseControlText("kind=complete") === "complete");
check("parser: '# note\\napproval' -> approval", parseControlText("# note\napproval") === "approval");
check("parser: 'play fail' -> fail", parseControlText("play fail") === "fail");
check("parser: garbage -> null", parseControlText("hello world") === null);
const ctlDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-ctl-"));
const ctl = mount({}, { tmpDir: ctlDir });
const controlFile = join(ctlDir, "control.txt");
const statusFile = join(ctlDir, "status.json");
const resultFile = join(ctlDir, "control-result.txt");
check("status.json written at mount", existsSync(statusFile));
let statusJson = null;
try {
  statusJson = JSON.parse(readFileSync(statusFile, "utf8"));
} catch (_) {
  /* reported below */
}
check("status.json is valid JSON with the audio resolution", Boolean(statusJson) && statusJson.ok === true && Array.isArray(statusJson.audio.resolved), JSON.stringify(statusJson && statusJson.audio && statusJson.audio.resolved && statusJson.audio.resolved.length));
check("status.json documents the file control channel", Boolean(statusJson) && statusJson.control.mode === "file" && statusJson.control.controlFile === controlFile, JSON.stringify(statusJson && statusJson.control));
check("status.json reports the new suppression rule", Boolean(statusJson) && statusJson.rules.suppressCompleteAfterFailMs === 3000, JSON.stringify(statusJson && statusJson.rules));

const beforeCtl = ctl.calls.length;
writeFileSync(controlFile, "kind=approval\n", "utf8");
const played = ctl.control.poll();
check("control file triggers the requested kind", played === "approval" && ctl.calls.length === beforeCtl + 1 && ctl.calls[ctl.calls.length - 1].kind === "approval", JSON.stringify({ played, calls: ctl.calls.slice(beforeCtl) }));
check("control file is consumed (cannot replay)", !existsSync(controlFile));
check("control-result.txt records the accepted trigger", existsSync(resultFile) && readFileSync(resultFile, "utf8").indexOf('"kind": "approval"') >= 0, existsSync(resultFile) ? readFileSync(resultFile, "utf8").slice(0, 120) : "missing");

writeFileSync(controlFile, "  FAIL  \n", "utf8");
check("bare/upper-case body is accepted", ctl.control.poll() === "fail", "");

writeFileSync(controlFile, "hello world\n", "utf8");
check("invalid body is rejected without playing", ctl.control.poll() === null && readFileSync(resultFile, "utf8").indexOf("no-valid-kind") >= 0, "");
check("invalid body is still consumed", !existsSync(controlFile));

// ------------------------------------------------- 2k. HTTP route layer (registers + handlers)
section("2k. HTTP routes registered through the webServer service");
const routed = mount({}, { tmpDir, webServer: true });
const routePaths = routed.ctx._routes.map((route) => route.path);
check("status route registered", routePaths.indexOf("/dsh-voice-alert/status") >= 0, JSON.stringify(routePaths));
check("play route registered", routePaths.indexOf("/dsh-voice-alert/play") >= 0, JSON.stringify(routePaths));
check("reload route registered", routePaths.indexOf("/dsh-voice-alert/reload") >= 0, JSON.stringify(routePaths));

function fakeReq(url, remoteAddress) {
  return { url, socket: { remoteAddress: remoteAddress || "127.0.0.1" } };
}
function fakeRes() {
  const captured = { status: null, body: "" };
  return Object.assign(captured, {
    writeHead(code) { captured.status = code; },
    end(body) { captured.body = body === undefined ? "" : String(body); },
  });
}
const statusRoute = routed.ctx._routes.find((route) => route.path === "/dsh-voice-alert/status");
const res1 = fakeRes();
await statusRoute.handler(fakeReq("/dsh-voice-alert/status"), res1);
let routePayload = null;
try {
  routePayload = JSON.parse(res1.body);
} catch (_) {
  /* reported below */
}
check("status route answers 200 JSON from loopback", res1.status === 200 && Boolean(routePayload) && routePayload.plugin === "dsh-voice-alert", JSON.stringify({ status: res1.status, body: String(res1.body).slice(0, 80) }));
const res2 = fakeRes();
await statusRoute.handler(fakeReq("/dsh-voice-alert/status", "192.0.2.7"), res2);
check("non-loopback stays 403 (plugin-local guard, independent of the desktop fence)", res2.status === 403, JSON.stringify(res2));

const playRoute = routed.ctx._routes.find((route) => route.path === "/dsh-voice-alert/play");
const res3 = fakeRes();
await playRoute.handler(fakeReq("/dsh-voice-alert/play?kind=fail"), res3);
check("play route plays the requested kind", routed.calls.some((call) => call.kind === "fail" && call.meta.source === "manual"), JSON.stringify(routed.calls));
const res4 = fakeRes();
await playRoute.handler(fakeReq("/dsh-voice-alert/play?kind=bogus"), res4);
check("play route rejects an unknown kind with 400", res4.status === 400, JSON.stringify(res4));

// ---------------------------------------------------------------- 3. shape

section("3. playback command shape (must NOT spawn python as a DSH child)");
// 自建夹具（不依赖任何本机路径）：开源默认值里 originalsDir 在数据目录内、playerScript 为空，
// 而这一段要验证「原始文件回退」和「共享播放器回退」，所以自己造出这两样。
const fixtureOriginalsDir = join(tmpDir, "originals-fixture");
mkdirSync(fixtureOriginalsDir, { recursive: true });
for (const kind of ["complete", "fail", "approval"]) {
  writeFileSync(join(fixtureOriginalsDir, "voice-alert-" + kind + "-poetic.mp3"), "FAKE-MP3-FIXTURE");
}
const fixtureSharedPlayer = join(tmpDir, "shared-player-fixture.py");
writeFileSync(fixtureSharedPlayer, "# fixture: shared player stand-in for shape checks\n");
const shapeConfig = Object.assign({}, DEFAULT_CONFIG, {
  originalsDir: fixtureOriginalsDir,
  playerScript: fixtureSharedPlayer,
});
const cmd = buildPlayCommand("complete", shapeConfig);
check("spawns powershell.exe", cmd.file === POWERSHELL_EXE, cmd.file);
check("uses Start-Process (python escapes the DSH process tree)", cmd.inner.indexOf("Start-Process") === 0, cmd.inner);
check("hidden window on both halves", cmd.inner.indexOf("-WindowStyle Hidden") > 0 && cmd.args.indexOf("-WindowStyle") >= 0);
check("python path only appears inside the powershell command, never as the spawned file", cmd.file !== shapeConfig.pythonPath);
check(
  "launcher is NOT spawned with DETACHED_PROCESS (powershell.exe would exit silently and play nothing)",
  LAUNCH_OPTIONS.detached !== true,
  JSON.stringify(LAUNCH_OPTIONS),
);
check("launcher holds no pipes (nobody may wait on it)", LAUNCH_OPTIONS.stdio === "ignore" && LAUNCH_OPTIONS.windowsHide === true, JSON.stringify(LAUNCH_OPTIONS));

section("3b. loudness policy: loud copy -> original -> none");
const loudDir = shapeConfig.audioDir;
for (const kind of ["complete", "fail", "approval"]) {
  const picked = resolveAudio(kind, shapeConfig);
  check("kind " + kind + " prefers the LOUD copy (" + picked.mode + ")", picked.mode === "loud", JSON.stringify(picked));
  check("loud copy exists on disk: " + loudFileFor(kind, shapeConfig), existsSync(loudFileFor(kind, shapeConfig)));
}
const loudCmd = buildPlayCommand("complete", shapeConfig);
check("loud playback uses the bundled MCI player with --file", loudCmd.playerKind === "bundled-mci" && loudCmd.inner.indexOf("'--file'") > 0, loudCmd.inner);
check("loud playback points at the loud file", loudCmd.audioFile === loudFileFor("complete", shapeConfig), loudCmd.audioFile);
check("bundled player script exists", existsSync(bundledPlayerPath(shapeConfig)), String(bundledPlayerPath(shapeConfig)));

const originalConfig = Object.assign({}, shapeConfig, { preferLoudAudio: false });
const originalCmd = buildPlayCommand("complete", originalConfig);
check("preferLoudAudio=false falls back to the original file", originalCmd.audioMode === "original", JSON.stringify({ mode: originalCmd.audioMode, file: originalCmd.audioFile }));
check("original playback goes through the shared zero-interference player (--kind)", originalCmd.playerKind === "shared-notify" && originalCmd.inner.indexOf("'--kind'") > 0, originalCmd.inner);

const emptyAudioDir = Object.assign({}, shapeConfig, { audioDir: join(tmpDir, "no-such-audio-dir") });
const fallbackPick = resolveAudio("complete", emptyAudioDir);
check("missing loud copy falls back to the original", fallbackPick.mode === "original", JSON.stringify(fallbackPick));
const nothingConfig = Object.assign({}, emptyAudioDir, { originalsDir: join(tmpDir, "no-such-originals") });
const nonePick = resolveAudio("complete", nothingConfig);
check("no audio at all resolves to none (beep fallback path)", nonePick.mode === "none", JSON.stringify(nonePick));
const noneResult = playKind("complete", Object.assign({}, nothingConfig, { fallbackBeep: false }), function () {});
check("no-audio play degrades silently instead of throwing", noneResult.ok === false && noneResult.reason === "audio-missing", JSON.stringify(noneResult));

// ------------------------------------------------- 3c. control file -> real launch

section("3c. control file drives the REAL launch chain (marker probe, no recorder in between)");
const ctlChainDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-ctlchain-"));
const ctlMarker = join(ctlChainDir, "ctl-chain-marker.txt");
process.env.DSH_VOICE_ALERT_CHAIN_MARKER = ctlMarker;
const ctlChain = mount(
  // 默认已是音效模式；这一条验证的是"语音 cue 走 scratch copy"，所以显式指定 voice。
  // 用 marker 脚本冒充播放器来验证启动链路 —— 必须显式走 mci：默认的 wav 内核会用
  // 插件自带的 play_wav_out.py，替身脚本就轮不上了。
  { alertMode: "voice", playerEngine: "mci", bundledPlayer: join(import.meta.dirname, "chain-marker.py"), preferLoudAudio: true },
  { tmpDir: ctlChainDir, realPlay: true },
);
writeFileSync(join(ctlChainDir, "control.txt"), "kind=complete\n", "utf8");
const ctlPlayedKind = ctlChain.control.poll();
check("control file accepted with real playback wired", ctlPlayedKind === "complete", String(ctlPlayedKind));
const ctlDeadline = Date.now() + 8000;
while (!existsSync(ctlMarker) && Date.now() < ctlDeadline) {
  await sleep(250);
}
let ctlMarkerText = "";
try {
  ctlMarkerText = readFileSync(ctlMarker, "utf8");
} catch (_) {
  /* reported below */
}
delete process.env.DSH_VOICE_ALERT_CHAIN_MARKER;
check("the launch chain really ran from the control file", ctlMarkerText.length > 0, JSON.stringify(ctlMarkerText));
check(
  "the control file played a scratch copy of the LOUD completion file",
  ctlMarkerText.indexOf("--file") >= 0 && ctlMarkerText.indexOf("--delete-after-play") >= 0 && ctlMarkerText.indexOf("complete-") >= 0,
  JSON.stringify(ctlMarkerText),
);

// ------------------------------------------------- 2l. config regression (apiKey)

section("2l. config: tts.apiKey + the seven sibling fields (regression for the 2026-09-15 bug)");
const cfgDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-cfg-"));
const cfgWithKey = join(cfgDir, "with-key.json");
const cfgNoKey = join(cfgDir, "no-key.json");
writeFileSync(cfgWithKey, JSON.stringify({ tts: { apiKey: "TESTKEY-abc123" } }, null, 2), "utf8");
writeFileSync(cfgNoKey, JSON.stringify({ enabled: true }, null, 2), "utf8");

const resolvedWithKey = resolveConfig(undefined, { configPath: cfgWithKey });
check(
  "config.json apiKey is returned verbatim (the double-pick bug made it empty)",
  resolvedWithKey.tts.apiKey === "TESTKEY-abc123",
  JSON.stringify(resolvedWithKey.tts.apiKey),
);
const resolvedNoKey = resolveConfig(undefined, { configPath: cfgNoKey });
check("missing apiKey resolves to the empty string", resolvedNoKey.tts.apiKey === "", JSON.stringify(resolvedNoKey.tts.apiKey));
check(
  "apiKey never falls back to another field's default",
  resolvedNoKey.tts.apiKey.length === 0 && resolvedNoKey.tts.endpoint.length > 0,
  JSON.stringify({ key: resolvedNoKey.tts.apiKey, endpoint: resolvedNoKey.tts.endpoint }),
);

const ttsSiblingCases = [
  ["endpoint", "https://example.invalid/tts", DEFAULT_CONFIG.tts.endpoint],
  ["resourceId", "test-resource", DEFAULT_CONFIG.tts.resourceId],
  ["model", "test-model", DEFAULT_CONFIG.tts.model],
  ["speaker", "S_TEST_SPEAKER", DEFAULT_CONFIG.tts.speaker],
  ["format", "wav", DEFAULT_CONFIG.tts.format],
  ["sampleRate", 8000, DEFAULT_CONFIG.tts.sampleRate],
  ["timeoutMs", 5000, DEFAULT_CONFIG.tts.timeoutMs],
];
for (const [field, override, fallback] of ttsSiblingCases) {
  const filePath = join(cfgDir, "sibling-" + field + ".json");
  writeFileSync(filePath, JSON.stringify({ tts: { [field]: override } }, null, 2), "utf8");
  const fromFile = resolveConfig(undefined, { configPath: filePath });
  check("tts." + field + ": file value wins", fromFile.tts[field] === override, JSON.stringify(fromFile.tts[field]));
  const fromDefault = resolveConfig(undefined, { configPath: cfgNoKey });
  check("tts." + field + ": falls back to the default", fromDefault.tts[field] === fallback, JSON.stringify(fromDefault.tts[field]));
}
const rowOverride = resolveConfig({ tts: { apiKey: "ROWKEY" } }, { configPath: cfgWithKey });
check("row config beats the file for apiKey", rowOverride.tts.apiKey === "ROWKEY", JSON.stringify(rowOverride.tts.apiKey));

// ------------------------------------------------- 2m. editable slice (key + note)

section("2m. editable slice: apiKey + voiceNote persist, and the key is never echoed");
const editablePath = join(cfgDir, "editable.json");
writeFileSync(editablePath, JSON.stringify({ enabled: true, tts: { apiKey: "OLD-KEY", model: "keep-me" } }, null, 2), "utf8");
const appliedPatch = normalizeEditablePatch({
  texts: { complete: "新文案" },
  prosody: { speed_ratio: 1.2 },
  tts: { apiKey: " NEW-KEY " },
  voiceNote: "  测试备注  ",
});
check("patch keeps a supplied apiKey (trimmed)", appliedPatch.tts.apiKey === "NEW-KEY", JSON.stringify(appliedPatch.tts));
check("patch keeps voiceNote (trimmed)", appliedPatch.voiceNote === "测试备注", JSON.stringify(appliedPatch.voiceNote));
const emptyKeyPatch = normalizeEditablePatch({ tts: { apiKey: "   " } });
check("empty apiKey means 'unchanged' (never clears the stored key)", emptyKeyPatch.tts.apiKey === undefined, JSON.stringify(emptyKeyPatch.tts));
const savedSlice = saveEditableConfig(editablePath, appliedPatch);
const savedRaw = JSON.parse(readFileSync(editablePath, "utf8"));
check("saveEditableConfig wrote the key", savedSlice.ok && savedRaw.tts.apiKey === "NEW-KEY", JSON.stringify(savedRaw.tts));
check("saveEditableConfig kept the untouched sibling keys", savedRaw.tts.model === "keep-me" && savedRaw.enabled === true, JSON.stringify(savedRaw));
check("saveEditableConfig wrote voiceNote", savedRaw.voiceNote === "测试备注", JSON.stringify(savedRaw.voiceNote));
const resolvedSaved = resolveConfig(undefined, { configPath: editablePath });
check("resolveConfig reads the saved key + note", resolvedSaved.tts.apiKey === "NEW-KEY" && resolvedSaved.voiceNote === "测试备注", JSON.stringify({ key: resolvedSaved.tts.apiKey, note: resolvedSaved.voiceNote }));
check(
  "voiceNote defaults to EMPTY (the plugin ships no person/character name)",
  resolveConfig(undefined, { configPath: cfgNoKey }).voiceNote === "",
  JSON.stringify(resolveConfig(undefined, { configPath: cfgNoKey }).voiceNote),
);

// ------------------------------------------------- 2n. playback scratch copy

section("2n. playback never opens the production file (scratch copy + prune)");
const playDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-play-"));
const copyConfig = Object.assign({}, shapeConfig, { playbackTempDir: playDir, playbackCopyMaxAgeMs: 1000 });
const productionFile = loudFileFor("complete", shapeConfig);
const prepared = preparePlaybackFile("complete", productionFile, copyConfig, { log: () => {} });
check("scratch copy created in the temp dir", prepared.copy === true && prepared.file !== productionFile && prepared.file.startsWith(playDir), prepared.file);
check(
  "scratch copy is byte-identical to the production file",
  existsSync(prepared.file) && statSync(prepared.file).size === statSync(productionFile).size,
  JSON.stringify({ copy: existsSync(prepared.file) ? statSync(prepared.file).size : null, production: existsSync(productionFile) ? statSync(productionFile).size : null, productionFile }),
);
const copyCommand = buildPlayCommand("complete", copyConfig, { prepared });
check("play command points at the copy, not the artifact", copyCommand.playFile === prepared.file && copyCommand.isScratchCopy === true, copyCommand.inner);
check("the scratch copy forces the bundled --file player", copyCommand.playerKind === "bundled-mci", copyCommand.playerKind);
check(
  "with the copy disabled the loud branch still uses the bundled player on the artifact",
  buildPlayCommand("complete", Object.assign({}, shapeConfig, { playbackCopyEnabled: false })).playerKind === "bundled-mci",
  buildPlayCommand("complete", Object.assign({}, shapeConfig, { playbackCopyEnabled: false })).inner,
);
check("player deletes the copy after playing", copyCommand.inner.indexOf("'--delete-after-play'") > 0, copyCommand.inner);
check("production file is untouched by the copy step", existsSync(productionFile), productionFile);
check(
  "the fresh copy carries a 'now' mtime (Windows copyFileSync inherits the old one and the prune would delete it)",
  existsSync(prepared.file) && Date.now() - statSync(prepared.file).mtimeMs < 5000,
  JSON.stringify({ copyMtimeMs: existsSync(prepared.file) ? statSync(prepared.file).mtimeMs : null, sourceMtimeMs: statSync(productionFile).mtimeMs, now: Date.now() }),
);
check("cleanup removes the copy", prepared.cleanup() === true && !existsSync(prepared.file), "");
const staleCopy = join(playDir, "complete-stale.mp3");
writeFileSync(staleCopy, "x", "utf8");
utimesSync(staleCopy, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
const freshCopy = join(playDir, "complete-fresh.mp3");
writeFileSync(freshCopy, "x", "utf8");
const pruned = prunePlaybackCopies(copyConfig, { tempDir: playDir });
check("prune removes only stale copies", pruned >= 1 && !existsSync(staleCopy) && existsSync(freshCopy), JSON.stringify({ pruned, stale: existsSync(staleCopy), fresh: existsSync(freshCopy) }));
const missingSource = preparePlaybackFile("complete", join(playDir, "does-not-exist.mp3"), copyConfig, { log: () => {} });
check("a failed copy falls back to the original file (never throws)", missingSource.copy === false && missingSource.file.indexOf("does-not-exist.mp3") > 0, JSON.stringify(missingSource));
check("playback copy can be disabled by config", preparePlaybackFile("complete", productionFile, Object.assign({}, copyConfig, { playbackCopyEnabled: false })).copy === false);

// ------------------------------------------------- 2o. generation hardening

section("2o. generation: temp name + retry + change detection");
check("gain writes a temp name first", tempGainPath("out.mp3", 123) === "out.mp3.tmp-123.mp3", tempGainPath("out.mp3", 123));
const retryCalls = [];
const flakyFs = {
  renameSync(from, to) {
    retryCalls.push(from);
    if (retryCalls.length < 3) {
      const error = new Error("locked");
      error.code = "EPERM";
      throw error;
    }
    writeFileSync(to, "renamed", "utf8");
  },
};
const retried = await renameWithRetry("from.mp3", "to.mp3", { retries: 5, delayMs: 1, fsOps: flakyFs });
check("rename retries through EPERM and succeeds", retried.ok === true && retried.attempts === 3, JSON.stringify(retried));

const lockTarget = join(playDir, "locked.mp3");
const lockSource = join(playDir, "source.mp3");
writeFileSync(lockTarget, "target", "utf8");
writeFileSync(lockSource, "source", "utf8");
const lockHandle = openSync(lockTarget, "r+");
const lockedRename = await renameWithRetry(lockSource, lockTarget, { retries: 2, delayMs: 5 });
check("rename reports the retryable Windows code while the file is held open", lockedRename.ok === false && retryCodes.indexOf(lockedRename.error.code) >= 0, JSON.stringify({ code: lockedRename.error && lockedRename.error.code, attempts: lockedRename.attempts }));
closeSync(lockHandle);
const unlockedRename = await renameWithRetry(lockSource, lockTarget, { retries: 2, delayMs: 5 });
check("rename succeeds once the handle is released", unlockedRename.ok === true, JSON.stringify(unlockedRename));

const planDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-plan-"));
const planConfig = Object.assign({}, shapeConfig, {
  audioDir: planDir,
  audioOriginDir: join(planDir, "origin"),
  audioBackupsDir: join(planDir, "backups"),
  generateStateFile: join(planDir, "state.json"),
  texts: { complete: "A", fail: "B", approval: "C" },
  prosody: { speed_ratio: 1.05, pitch_ratio: 1.04, volume_ratio: 1 },
});
for (const kind of ["complete", "fail", "approval"]) writeFileSync(loudFileFor(kind, planConfig), "x", "utf8");
const freshPlan = planChanges(planConfig, ["complete", "fail", "approval"]);
check("no snapshot yet -> everything needs a synthesis", freshPlan.changed.length === 3 && freshPlan.reused.length === 0, JSON.stringify(freshPlan));
writeGenerateState(planConfig, {
  complete: fingerprintFor("complete", planConfig),
  fail: fingerprintFor("fail", planConfig),
  approval: fingerprintFor("approval", planConfig),
});
const unchangedPlan = planChanges(planConfig, ["complete", "fail", "approval"]);
check("matching snapshot -> everything is reused", unchangedPlan.changed.length === 0 && unchangedPlan.reused.length === 3, JSON.stringify(unchangedPlan));
planConfig.texts.complete = "A changed";
const changedPlan = planChanges(planConfig, ["complete", "fail", "approval"]);
check("changed text -> only that kind is regenerated", changedPlan.changed.length === 1 && changedPlan.changed[0] === "complete" && changedPlan.reused.length === 2, JSON.stringify(changedPlan));
planConfig.texts.complete = "A";
planConfig.prosody.speed_ratio = 1.3;
const prosodyPlan = planChanges(planConfig, ["complete"]);
check("changed prosody also counts as a change", prosodyPlan.changed.length === 1, JSON.stringify(prosodyPlan));
const forcedPlan = planChanges(planConfig, ["complete", "fail", "approval"], { force: true });
check("force ignores the snapshot", forcedPlan.changed.length === 3 && forcedPlan.reused.length === 0, JSON.stringify(forcedPlan));

const mockCalls = [];
const mockConfig = Object.assign({}, planConfig, {
  prosody: { speed_ratio: 1.05, pitch_ratio: 1.04, volume_ratio: 1 },
  reuseUnchanged: true,
  // 开源默认音色库为空 —— 这一段要验证合成分支，所以显式给一个"克隆音色 + Key"。
  voices: [{ id: "S_MOCK", note: "mock", kind: "clone", enabled: true }],
  selectedVoiceId: "S_MOCK",
  tts: Object.assign({}, DEFAULT_CONFIG.tts, { apiKey: "TEST-KEY-FOR-MOCK", speaker: "S_MOCK" }),
});
// 先把这份配置的指纹写进快照：这样紧接着的第一次 start 应当报 nothing-changed（全部复用、不调 TTS）。
writeGenerateState(mockConfig, {
  complete: fingerprintFor("complete", mockConfig),
  fail: fingerprintFor("fail", mockConfig),
  approval: fingerprintFor("approval", mockConfig),
});
const mockGenerator = createGenerator({
  config: mockConfig,
  log: () => {},
  fetchImpl: function (url, init) {
    mockCalls.push({ url, init });
    const payload = [[{ code: 0, data: Buffer.from("fake-mp3-bytes").toString("base64") }], [{ code: 20000000 }]];
    const body = payload[0].map((line) => JSON.stringify(line)).concat(payload[1].map((line) => JSON.stringify(line))).join("\n") + "\n";
    return Promise.resolve({
      ok: true,
      status: 200,
      body: null,
      text: () => Promise.resolve(body),
    });
  },
});
const nothingStart = mockGenerator.start(["complete", "fail", "approval"], "self-check");
check("all-unchanged run answers nothing-changed without a TTS call", nothingStart.accepted === false && nothingStart.reason === "nothing-changed" && mockCalls.length === 0, JSON.stringify({ start: nothingStart, calls: mockCalls.length }));
await mockGenerator.whenIdle();
mockConfig.texts.fail = "B changed";
const changedStart = mockGenerator.start(["complete", "fail", "approval"], "self-check");
check("changed run synthesizes only the changed kind", changedStart.accepted === true && changedStart.changed.length === 1 && changedStart.changed[0] === "fail", JSON.stringify(changedStart));
await mockGenerator.whenIdle();
check("exactly one TTS request was made", mockCalls.length === 1, String(mockCalls.length));
const changedJob = mockGenerator.snapshot();
check("the reused kinds are flagged in the job snapshot", changedJob.outputs && changedJob.outputs.complete && changedJob.outputs.complete.reused === true, JSON.stringify(changedJob.outputs && changedJob.outputs.complete));
check("the regenerated kind is not flagged reused", changedJob.outputs && changedJob.outputs.fail && changedJob.outputs.fail.reused !== true, JSON.stringify(changedJob.outputs && changedJob.outputs.fail));
check("the job records which kinds changed/reused", changedJob.changed.length === 1 && changedJob.reused.length === 2, JSON.stringify({ changed: changedJob.changed, reused: changedJob.reused }));
mockGenerator.state.running = false;

// ------------------------------------------------- 2p. client bundle DOM-stub probe

section("2p. client bundle: settings section renders and posts (DOM stub, no browser)");
const domNodes = new Map();
function fakeNode(id, tag) {
  return { id, tagName: tag || "div", textContent: "", value: "", disabled: false, type: "", checked: false, style: {} };
}
globalThis.document = {
  getElementById(id) {
    return domNodes.get(id) || null;
  },
  createElement(tag) {
    return fakeNode("", tag);
  },
};
globalThis.window = globalThis.window || {};
const bundleCaptured = { config: null };
globalThis.window.__ModuleLoader__ = {
  load(config) {
    bundleCaptured.config = config;
  },
};
const clientFetchCalls = [];
let clientFetchMode = "normal";
globalThis.fetch = function (url, init) {
  clientFetchCalls.push({ url, init });
  const respond = function (status, json) {
    return Promise.resolve({ status, json: () => Promise.resolve(json) });
  };
  if (url.indexOf("/settings") >= 0 && String(init && init.method).toUpperCase() === "POST") {
    return respond(200, {
      ok: true,
      texts: { complete: "c", fail: "f", approval: "a" },
      prosody: { speed_ratio: 1.1, pitch_ratio: 1.0, volume_ratio: 1 },
      speaker: "S_TESTCLONE001",
      voiceNote: "备注X",
      apiKeyPresent: true,
      apiKeyMask: "79c7597c…",
      persisted: { ok: true, skipped: false },
      applied: { texts: {}, prosody: {}, tts: { apiKey: "X" }, voiceNote: "备注X" },
    });
  }
  if (url.indexOf("/settings") >= 0) {
    return respond(200, {
      ok: true,
      texts: { complete: "完成文案", fail: "失败文案", approval: "审批文案" },
      prosody: { speed_ratio: 1.05, pitch_ratio: 1.04, volume_ratio: 1 },
      speaker: "S_TESTCLONE001",
      voiceNote: "测试音色 · 读诗腔",
      apiKeyPresent: true,
      apiKeyMask: "79c7597c…",
      keyStorageNote: "KEY-NOTE",
      voicePolicyNote: "VOICE-POLICY",
      systemVolume: { ok: true, volumePercent: 54, muted: false, source: "audio_state.py (read-only)" },
      systemVolumeNote: "VOLUME-NOTE",
      generate: { running: false, outputs: {} },
    });
  }
  if (url.indexOf("/generate-status") >= 0) return respond(200, { ok: true, running: false, outputs: {} });
  if (url.indexOf("/generate") >= 0) {
    if (clientFetchMode === "nothing-changed") {
      return respond(200, { ok: true, accepted: false, reason: "nothing-changed", reused: ["complete", "fail", "approval"], changed: [] });
    }
    return respond(202, { ok: true, accepted: true, jobId: "job-1", changed: ["fail"], reused: ["complete", "approval"] });
  }
  if (url.indexOf("/preview") >= 0) return respond(200, { ok: true, audioMode: "loud" });
  return respond(404, { ok: false });
};
const ReactStub = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    const node = { type, props: props || {}, children: [] };
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) node.children = node.children.concat(child);
      else node.children.push(child);
    }
    return node;
  },
};
async function importBundle() {
  const url = pathToFileURL(join(import.meta.dirname, "..", "lib", "client.js")).href;
  await import(url + "?probe=" + String(Date.now()));
}
await importBundle();
check("bundle declared itself through __ModuleLoader__.load", Boolean(bundleCaptured.config) && bundleCaptured.config.id === "dsh-voice-alert", JSON.stringify(bundleCaptured.config && bundleCaptured.config.id));
const clientExports = bundleCaptured.config.factory(function (name) {
  if (name === "react") return { default: ReactStub };
  throw new Error("unexpected require: " + name);
});
check("exports.inject is a plain array (function form silently skips injection)", Array.isArray(clientExports.inject) && clientExports.inject.indexOf("slots") >= 0, JSON.stringify(clientExports.inject));
const registeredSections = [];
clientExports.apply({
  slots: {
    inject(name, factory) {
      registeredSections.push({ name, section: factory() });
    },
    register(descriptor, component) {
      return { descriptor, component };
    },
  },
});
const voiceSection = registeredSections[0] && registeredSections[0].section;
check("settings.section registered under dsh-voice-alert", Boolean(voiceSection) && voiceSection.descriptor.id === "dsh-voice-alert" && voiceSection.descriptor.name === "settings.section", JSON.stringify(voiceSection && voiceSection.descriptor));
check("section order is 27 and the label is 语音播报", voiceSection.descriptor.order === 27 && voiceSection.descriptor.label() === "语音播报", JSON.stringify({ order: voiceSection.descriptor.order, label: voiceSection.descriptor.label() }));

function mountTree(tree) {
  if (!tree || typeof tree !== "object") return;
  const props = tree.props || {};
  if (props.id) {
    const node = fakeNode(props.id, tree.type);
    node.value = props.defaultValue === undefined ? "" : String(props.defaultValue);
    node.type = props.type || "";
    node.checked = Boolean(props.checked);
    node.disabled = Boolean(props.disabled);
    node.textContent = tree.children.filter((child) => typeof child === "string").join("");
    // Inline styles are copied so a test can assert real layout decisions (the sfx
    // panel starts hidden, the active mode button is highlighted).
    node.style = Object.assign({}, props.style || {});
    domNodes.set(props.id, node);
  }
  for (const child of tree.children) mountTree(child);
}
mountTree(voiceSection.component({}));
check("key input is a password field that never echoes the stored key", domNodes.get("dva-tts-key") && domNodes.get("dva-tts-key").type === "password" && domNodes.get("dva-tts-key").value === "", JSON.stringify(domNodes.get("dva-tts-key")));
check("voice note input rendered", Boolean(domNodes.get("dva-voice-note")));
check("force checkbox rendered", Boolean(domNodes.get("dva-force")));
check("volume line + hint rendered", Boolean(domNodes.get("dva-volume")) && Boolean(domNodes.get("dva-volume-note")));
check("generate + save + three preview buttons rendered", Boolean(domNodes.get("dva-generate")) && Boolean(domNodes.get("dva-save")) && ["complete", "fail", "approval"].every((kind) => Boolean(domNodes.get("dva-preview-" + kind))), "");

await sleep(50);
check(
  "loadSettings filled the inputs from the host payload",
  domNodes.get("dva-text-complete").value === "完成文案" &&
    domNodes.get("dva-voice-note").value === "测试音色 · 读诗腔" &&
    domNodes.get("dva-speed_ratio").value === "1.05",
  JSON.stringify({ complete: domNodes.get("dva-text-complete").value, note: domNodes.get("dva-voice-note").value, speed: domNodes.get("dva-speed_ratio").value }),
);
check("key state shows a mask, not the key", domNodes.get("dva-key-state").textContent.indexOf("79c7597c…") >= 0, domNodes.get("dva-key-state").textContent);
check("local-only key note rendered from the host payload", domNodes.get("dva-key-note").textContent === "KEY-NOTE", domNodes.get("dva-key-note").textContent);
check("system volume is displayed read-only", domNodes.get("dva-volume").textContent.indexOf("54%") >= 0, domNodes.get("dva-volume").textContent);
check("generate is enabled once the key is known present", domNodes.get("dva-generate").disabled === false, String(domNodes.get("dva-generate").disabled));

domNodes.get("dva-tts-key").value = "NEWKEY-42";
const postedBefore = clientFetchCalls.length;
await clientExports.__dvaTest.saveSettings();
const posted = JSON.parse(clientFetchCalls[clientFetchCalls.length - 1].init.body);
check("save posts texts + prosody + voiceNote + the new key", Boolean(posted.tts) && posted.tts.apiKey === "NEWKEY-42" && posted.voiceNote === "测试音色 · 读诗腔", JSON.stringify(posted));
check("save acknowledged into config.json", domNodes.get("dva-status").textContent.indexOf("已写入 config.json") >= 0, domNodes.get("dva-status").textContent);
check("the key box is cleared after saving", domNodes.get("dva-tts-key").value === "", domNodes.get("dva-tts-key").value);

clientFetchMode = "normal";
const beforeGenerate = clientFetchCalls.length;
await clientExports.__dvaTest.generateAll();
check("generate posts /generate and disables the button while running", domNodes.get("dva-generate").disabled === true && clientFetchCalls.some((call) => call.url.indexOf("/generate") >= 0), JSON.stringify({ disabled: domNodes.get("dva-generate").disabled }));
const generateSequence = clientFetchCalls.slice(beforeGenerate).map((call) => call.url);
check(
  "one click saves the edited texts first, then submits /generate",
  generateSequence.findIndex((url) => url.indexOf("/settings") >= 0) >= 0 &&
    generateSequence.findIndex((url) => url.indexOf("/generate") >= 0) >
      generateSequence.findIndex((url) => url.indexOf("/settings") >= 0),
  JSON.stringify(generateSequence),
);
check("acceptance message lists changed + reused kinds", domNodes.get("dva-status").textContent.indexOf("本次需合成") >= 0, domNodes.get("dva-status").textContent);
clientExports.__dvaTest.cache.busy = false;
clientFetchMode = "nothing-changed";
await clientExports.__dvaTest.generateAll();
check("nothing-changed is surfaced instead of regenerating", domNodes.get("dva-status").textContent.indexOf("没有需要重新合成的改动") >= 0, domNodes.get("dva-status").textContent);
clientExports.__dvaTest.cache.busy = false;

// 「强制重新生成」是一次性的（用户 2026-09-16 确认）：提交后自动取消勾选，避免忘了取消白耗 TTS 额度
domNodes.get("dva-force").checked = true;
clientFetchMode = "normal";
const beforeForce = clientFetchCalls.length;
await clientExports.__dvaTest.generateAll();
const forceCall = clientFetchCalls
  .slice(beforeForce)
  .find((call) => call.url.indexOf("/generate") >= 0 && call.url.indexOf("/generate-status") < 0);
check(
  "勾选后提交体真的带 force=true",
  Boolean(forceCall) && JSON.parse(forceCall.init.body).force === true,
  JSON.stringify(forceCall && forceCall.init && forceCall.init.body),
);
check("提交成功后自动取消勾选（一次性）", domNodes.get("dva-force").checked === false, String(domNodes.get("dva-force").checked));
clientExports.__dvaTest.cache.busy = false;

// ---------------------------------------------------------------- 4. real sound

const skipSound = process.argv.indexOf("--no-sound") >= 0;
section("4. REAL playback");
if (skipSound) {
  console.log("  SKIP  (--no-sound)");
} else {
  const mps = ["voice-alert-complete-poetic.mp3", "voice-alert-fail-poetic.mp3", "voice-alert-approval-poetic.mp3"];
  // 注意：原始文件的存在性由 3b 段的夹具用例覆盖（开源默认 originalsDir 在本机数据目录内）。
  // 这一段只确认「真正可播的 LOUD 文件在盘上」，后面要真播它们。
  void mps;
  for (const kind of ["complete", "fail", "approval"]) {
    check("loud MP3 present: voice-alert-" + kind + "-poetic-loud.mp3", existsSync(loudFileFor(kind, shapeConfig)));
  }

  // 4a) deterministic chain test: the production launch path must really reach
  //     the child process. "did a python process appear?" cannot be used as
  //     evidence here (other tools on this box spawn python constantly), so the
  //     probe script writes a marker file that only our own launch can produce.
  const marker = join(tmpDir, "chain-marker.txt");
  // the loud branch plays through the BUNDLED player, so the probe must take that seat
  // （显式 mci：默认 wav 内核不会用 bundledPlayer 这个替身）
  const probeConfig = Object.assign({}, shapeConfig, { playerEngine: "mci", bundledPlayer: join(import.meta.dirname, "chain-marker.py") });
  const chainLog = [];
  process.env.DSH_VOICE_ALERT_CHAIN_MARKER = marker;
  const chainResult = playKind("complete", probeConfig, function (m) { chainLog.push(m); });
  check("chain probe launched", chainResult.ok === true, JSON.stringify(chainResult));
  const chainDeadline = Date.now() + 8000;
  while (!existsSync(marker) && Date.now() < chainDeadline) {
    await sleep(250);
  }
  let markerText = "";
  try {
    markerText = readFileSync(marker, "utf8");
  } catch (_) {
    /* missing: the check below reports it */
  }
  delete process.env.DSH_VOICE_ALERT_CHAIN_MARKER;
  check("production launch chain really reached a child process (marker written)", markerText.length > 0, chainLog.join(" | "));
  check(
    "the LOUD path really passed a scratch copy through the whole chain",
    markerText.indexOf("--file") >= 0 && markerText.indexOf("dsh-voice-alert") >= 0 && markerText.indexOf("--delete-after-play") >= 0,
    JSON.stringify(markerText),
  );

  // 4a2) same chain test for the shared-player fallback branch (no scratch copy)
  const marker2 = join(tmpDir, "chain-marker-2.txt");
  const probeConfig2 = Object.assign({}, shapeConfig, {
    playerEngine: "mci", // 同上：这条测的是共享播放器分支，必须走 mci
    preferLoudAudio: false,
    playbackCopyEnabled: false,
    playerScript: join(import.meta.dirname, "chain-marker.py"),
  });
  process.env.DSH_VOICE_ALERT_CHAIN_MARKER = marker2;
  playKind("fail", probeConfig2, function () {});
  const deadline2 = Date.now() + 8000;
  while (!existsSync(marker2) && Date.now() < deadline2) {
    await sleep(250);
  }
  let markerText2 = "";
  try {
    markerText2 = readFileSync(marker2, "utf8");
  } catch (_) {
    /* reported below */
  }
  delete process.env.DSH_VOICE_ALERT_CHAIN_MARKER;
  check("original-player chain passes --kind through", markerText2.indexOf("kind=fail") >= 0, JSON.stringify(markerText2));

  // 4b) real audible playback through the production path
  const soundLog = [];
  const soundResult = playKind("complete", shapeConfig, function (m) { soundLog.push(m); });
  check("real playback launched (complete voice)", soundResult.ok === true, JSON.stringify(soundResult));
  check("real playback used the loud file", soundResult.audioMode === "loud", JSON.stringify(soundResult));
  // 两种内核的日志不同（mci 记 "Start-Process …"；wav 记 "play launched (wav engine) …"），
  // 共同点是都真的把播放进程拉起来了。
  check(
    "real playback logged a real launch",
    /Start-Process|play launched \(wav engine\)/u.test(soundLog.join(" ")),
    soundLog.join(" | "),
  );
  // 播放是异步启动的（子进程），不等它放完，后面的用例就会和这条叠在一起响
  // （实测：语音和鸟鸣一起叫）。这里等到它播完（complete 语音约 5.1s）再往下走。
  await sleep(6000);

  // 4c) synchronous player runs: exit code 0 + wall time prove the audio path works
  // pythonPath 默认是 PATH 名（"python"），本机可能命中 WindowsApps 存根 → 用解析后的真实解释器。
  const realPython = resolvePython(shapeConfig).path;
  const runs = [
    { label: "loud file through the bundled player", python: realPython, args: ["-u", bundledPlayerPath(shapeConfig), "--file", loudFileFor("complete", shapeConfig)] },
  ];
  // 共享播放器是**可选**的（开源默认不配，只用自带播放器）。要覆盖这条就把真实路径放进环境变量：
  //   $env:DVA_SHARED_PLAYER = "<dir>\notify_voice_player.py"; node test/self-check.mjs
  const sharedPlayerRun = process.env.DVA_SHARED_PLAYER || "";
  if (sharedPlayerRun && existsSync(sharedPlayerRun)) {
    runs.push({ label: "original file through the shared player", python: shapeConfig.pythonPath, args: ["-u", sharedPlayerRun, "--kind", "fail"] });
  } else {
    console.log("  SKIP  shared player (可选：设 DVA_SHARED_PLAYER 指向你的共享播放器才会跑这条)");
  }
  for (const run of runs) {
    const startedAt = Date.now();
    let status = null;
    try {
      execFileSync(run.python, run.args, { stdio: "ignore" });
      status = 0;
    } catch (error) {
      status = typeof error.status === "number" ? error.status : -1;
    }
    const elapsed = Date.now() - startedAt;
    check("synchronous run exit 0 (" + run.label + ", " + elapsed + "ms)", status === 0, "status=" + status);
    check("audio device held for a while (" + run.label + ")", elapsed >= 1500, "elapsed=" + elapsed);
  }
}

// ------------------------------------------------- 5. voice library (requirement A)

section("5. voice library: parse/import/dedupe/persist (requirement A)");
const imp1 = parseVoiceImport(
  "# 批量导入\nS_a1,备注一\nzh_female_x_bigtts,VV 女声\nS_a1,重复的\nBV_zzz,自备音色",
);
check(
  "parse text import: kind auto-detect (S_=clone, else preset) + same-batch dedupe",
  imp1.length === 3 &&
    imp1[0].id === "S_a1" && imp1[0].kind === "clone" &&
    imp1[1].id === "zh_female_x_bigtts" && imp1[1].kind === "preset" &&
    imp1[2].id === "BV_zzz" && imp1[2].kind === "preset",
  JSON.stringify(imp1),
);
const imp2 = parseVoiceImport([{ id: "S_b2", note: "b", kind: "clone" }, "zh_female_y_bigtts,备注y"]);
check(
  "parse JSON array import (object + string mix)",
  imp2.length === 2 && imp2[0].kind === "clone" && imp2[1].kind === "preset" && imp2[1].note === "备注y",
  JSON.stringify(imp2),
);
check("parseVoiceImport([]) -> []", parseVoiceImport([]).length === 0);
const merged = mergeVoiceImport([{ id: "S_a1", note: "旧", kind: "clone", enabled: true }], imp1);
check(
  "merge keeps existing, adds new, drops id duplicates",
  merged.length === 3 && merged[0].id === "S_a1" && merged.some((v) => v.id === "BV_zzz") && merged.filter((v) => v.id === "S_a1").length === 1,
  JSON.stringify(merged),
);
check("normalizeVoices([]) is a valid EMPTY library", Array.isArray(normalizeVoices([])) && normalizeVoices([]).length === 0);
check("normalizeVoices(non-array) -> null (caller falls back)", normalizeVoices("nope") === null);
check("normalizeVoices strips junk entries", normalizeVoices([{ id: "  S_c3  ", note: "n" }, { note: "no-id" }, null]).length === 1);

const voiceCfgDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-voices-"));
const voiceCfgFile = join(voiceCfgDir, "config.json");
writeFileSync(voiceCfgFile, JSON.stringify({ enabled: true, tts: { apiKey: "KEEP-KEY" } }), "utf8");
const vSave = saveVoicesConfig(voiceCfgFile, { voices: merged, selectedVoiceId: "S_a1", presetApiKey: "ARK-TEST" });
const vRaw = JSON.parse(readFileSync(voiceCfgFile, "utf8"));
check("saveVoicesConfig persists the whole voices array", vSave.ok && Array.isArray(vRaw.voices) && vRaw.voices.length === 3, JSON.stringify(vRaw.voices));
check("saveVoicesConfig persists selected + presetApiKey", vRaw.selectedVoiceId === "S_a1" && vRaw.presetApiKey === "ARK-TEST", JSON.stringify({ sel: vRaw.selectedVoiceId, key: vRaw.presetApiKey }));
check("saveVoicesConfig keeps untouched sibling keys", vRaw.enabled === true && vRaw.tts.apiKey === "KEEP-KEY", JSON.stringify(vRaw));
const voicesResolved = resolveConfig(undefined, { configPath: voiceCfgFile });
check(
  "resolveConfig reads back saved voices + selection + presetKey",
  voicesResolved.voices.length === 3 && voicesResolved.selectedVoiceId === "S_a1" && voicesResolved.presetApiKey === "ARK-TEST",
  JSON.stringify({ n: voicesResolved.voices.length, sel: voicesResolved.selectedVoiceId, key: voicesResolved.presetApiKey }),
);
const defaultResolved = resolveConfig(undefined, { configPath: join(voiceCfgDir, "empty.json") });
check(
  "missing voices in config.json falls back to the EMPTY library (开源版不内置音色)",
  defaultResolved.voices.length === 0 && defaultResolved.selectedVoiceId === "",
  JSON.stringify({ voices: defaultResolved.voices, selected: defaultResolved.selectedVoiceId }),
);

const libVoice = resolveVoice(voicesResolved, "S_a1");
check("resolveVoice picks a library entry", libVoice.kind === "clone" && libVoice.speakerId === "S_a1" && libVoice.source === "library");
const inlineVoice = resolveVoice(voicesResolved, "zh_female_custom_bigtts");
check("resolveVoice derives kind for an unknown id (inline)", inlineVoice.kind === "preset" && inlineVoice.source === "inline");
check("voiceKeyErrorCode: clone no key -> api-key-missing", voiceKeyErrorCode({ tts: { apiKey: "" }, presetApiKey: "" }, { kind: "clone" }) === "api-key-missing");
check("voiceKeyErrorCode: preset no key -> preset-key-missing", voiceKeyErrorCode({ tts: { apiKey: "x" }, presetApiKey: "" }, { kind: "preset" }) === "preset-key-missing");
check("voiceKeyErrorCode: preset with key -> null", voiceKeyErrorCode({ tts: { apiKey: "x" }, presetApiKey: "ark-1" }, { kind: "preset" }) === null);

// ------------------------------------------------- 6. kind routing (requirement A)

section("6. TTS kind routing: clone vs preset endpoint/resource/key/speaker (mock)");
const routeCfg = Object.assign({}, DEFAULT_CONFIG, {
  tts: Object.assign({}, DEFAULT_CONFIG.tts, { apiKey: "CLONE-KEY", speaker: "S_TESTCLONE001" }),
  presetApiKey: "ARK-KEY",
});
const cloneReq = buildTtsRequestForVoice("你好", routeCfg, { id: "S_TESTCLONE001", kind: "clone" }, { requestId: "req-clone" });
check("clone route -> console endpoint", cloneReq.url === "https://openspeech.bytedance.com/api/v3/tts/unidirectional", cloneReq.url);
check("clone route -> seed-icl-2.0 resource + console key", cloneReq.headers["X-Api-Resource-Id"] === "seed-icl-2.0" && cloneReq.headers["X-Api-Key"] === "CLONE-KEY", JSON.stringify(cloneReq.headers));
check("clone route -> speaker = clone id", JSON.parse(cloneReq.body).req_params.speaker === "S_TESTCLONE001");
check("clone route body carries a model field", typeof JSON.parse(cloneReq.body).req_params.model === "string");
const presetReq = buildTtsRequestForVoice("你好", routeCfg, { id: "zh_female_vv_uranus_bigtts", kind: "preset" }, { requestId: "req-preset" });
check("preset route -> plan endpoint", presetReq.url === "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional", presetReq.url);
check("preset route -> seed-tts-2.0 resource + ARK key", presetReq.headers["X-Api-Resource-Id"] === "seed-tts-2.0" && presetReq.headers["X-Api-Key"] === "ARK-KEY", JSON.stringify(presetReq.headers));
check("preset route -> speaker = preset id", JSON.parse(presetReq.body).req_params.speaker === "zh_female_vv_uranus_bigtts");
check("preset route body has NO model field (vendor rejects it)", JSON.parse(presetReq.body).req_params.model === undefined);
check("two kinds never share a request id", cloneReq.headers["X-Api-Request-Id"] === "req-clone" && presetReq.headers["X-Api-Request-Id"] === "req-preset");

// ------------------------------------------------- 7. probe route (requirement A)

section("7. 试合 probe route: real call through mock fetch, never writes a file");
let probeCalls = 0;
const probeFetch = function (url, init) {
  probeCalls++;
  const body =
    JSON.stringify({ code: 0, data: Buffer.from("probe-bytes").toString("base64") }) + "\n" +
    JSON.stringify({ code: 20000000 }) + "\n";
  return Promise.resolve({ ok: true, status: 200, body: null, text: function () { return Promise.resolve(body); } });
};
const probeDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-probe-"));
const probeCtx = mount(
  // 开源默认音色库为空；试合要测"克隆音色 + Key"这条路径，所以这里显式给音色。
  {
    voices: [{ id: "S_TESTCLONE001", note: "probe", kind: "clone", enabled: true }],
    selectedVoiceId: "S_TESTCLONE001",
    tts: { apiKey: "PROBE-KEY", speaker: "S_TESTCLONE001" },
  },
  { tmpDir: probeDir, webServer: true, fetchImpl: probeFetch },
);
const probeRoute = probeCtx.ctx._routes.find((r) => r.path === "/dsh-voice-alert/voices/probe");
const probeRes = fakeRes();
await probeRoute.handler({ url: "/dsh-voice-alert/voices/probe", method: "POST", socket: { remoteAddress: "127.0.0.1" } }, probeRes);
const probePayload = JSON.parse(probeRes.body);
check("probe with clone voice + mock TTS -> ok + byte count", probePayload.ok === true && probePayload.bytes === Buffer.byteLength("probe-bytes"), JSON.stringify(probePayload));
check("probe made exactly one TTS call (no artifact written)", probeCalls === 1, String(probeCalls));
const probeNoKeyDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-probe-nokey-"));
const probeNoKeyCtx = mount(
  {
    tts: { apiKey: "CLONE-KEY" },
    presetApiKey: "",
    voices: [{ id: "zh_female_x_bigtts", note: "x", kind: "preset", enabled: true }],
    selectedVoiceId: "zh_female_x_bigtts",
  },
  { tmpDir: probeNoKeyDir, webServer: true, fetchImpl: probeFetch },
);
const probeNoKeyRoute = probeNoKeyCtx.ctx._routes.find((r) => r.path === "/dsh-voice-alert/voices/probe");
const probeNoKeyRes = fakeRes();
await probeNoKeyRoute.handler({ url: "/dsh-voice-alert/voices/probe", method: "POST", socket: { remoteAddress: "127.0.0.1" } }, probeNoKeyRes);
const probeNoKeyPayload = JSON.parse(probeNoKeyRes.body);
check(
  "preset probe without ark key is refused with preset-key-missing (never wrong key)",
  probeNoKeyRes.status === 400 && probeNoKeyPayload.reason === "preset-key-missing",
  JSON.stringify(probeNoKeyPayload),
);

// ------------------------------------------------- 8. v0.3.x routes (voice library kept, reading removed)

section("8. voice routes registered (reading routes removed in v0.3.1)");
const newRouted = mount({}, { tmpDir, webServer: true });
const newRoutePaths = newRouted.ctx._routes.map((r) => r.path);
const expectedVoiceRoutes = [
  "/voices", "/voices/save", "/voices/import", "/voices/probe",
].map(function (p) { return "/dsh-voice-alert" + p; });
check(
  "all voice routes still registered",
  expectedVoiceRoutes.every(function (p) { return newRoutePaths.indexOf(p) >= 0; }),
  JSON.stringify(expectedVoiceRoutes.filter(function (p) { return newRoutePaths.indexOf(p) < 0; })),
);
const readingRouteRemnants = newRoutePaths.filter(function (p) { return p.indexOf("/reading/") >= 0; });
check(
  "no /reading/* route remains after v0.3.1",
  readingRouteRemnants.length === 0,
  JSON.stringify(readingRouteRemnants),
);

// ------------------------------------------------- 9. 音效提醒（requirement B, v0.3.3）

const sfxCfg = resolveConfig(undefined, { configPath: join(tmpDir, "sfx-none.json") });

section("9a. 音效目录：20 个内置音效（提醒 10 + 大自然 10）");
check("catalogue has exactly 20 entries", SFX_CATALOG.length === 20, String(SFX_CATALOG.length));
check("catalogue keys are unique", new Set(SFX_CATALOG.map((item) => item.key)).size === SFX_CATALOG.length, "");
const remindCount = SFX_CATALOG.filter((item) => item.group === "提醒").length;
const natureCount = SFX_CATALOG.filter((item) => item.group === "大自然").length;
check("catalogue splits into 10 remind + 10 nature", remindCount === 10 && natureCount === 10, JSON.stringify({ remindCount, natureCount }));
const missingSfx = SFX_CATALOG.filter((item) => !existsSync(sfxPathFor(item.key, sfxCfg)));
check("every catalogue key has its mp3 on disk", missingSfx.length === 0, JSON.stringify(missingSfx.map((item) => item.key)));
check(
  "every event has a default effect from the catalogue",
  ["complete", "fail", "approval"].every((kind) => isKnownSfxKey(DEFAULT_SFX_BY_KIND[kind])),
  JSON.stringify(DEFAULT_SFX_BY_KIND),
);
check("alert modes are voice/sfx/off", ALERT_MODES.join(",") === "voice,sfx,off", ALERT_MODES.join(","));

section("9b. 音效路径安全（路径穿越必须被拒）");
check("traversal stem refused", sfxPathFor("../../evil", sfxCfg) === null && sfxPathFor("..\\..\\evil", sfxCfg) === null, "");
check(
  "separators / spaces / dots refused",
  sfxPathFor("a/b", sfxCfg) === null && sfxPathFor("a b", sfxCfg) === null && sfxPathFor("a.mp3", sfxCfg) === null,
  "",
);
check("legal stem builds <sfxDir>/<key>.mp3", sfxPathFor("nature-bird", sfxCfg) === join(sfxCfg.sfxDir, "nature-bird.mp3"), sfxPathFor("nature-bird", sfxCfg));
check("isKnownSfxKey gates the catalogue", isKnownSfxKey("nature-bird") === true && isKnownSfxKey("../../evil") === false, "");

section("9c. 音效播放命令形状（bundled MCI 播放器 + scratch copy）");
const sfxProduction = sfxPathFor("nature-bird", sfxCfg);
const sfxPrepared = preparePlaybackFile("nature-bird", sfxProduction, sfxCfg, { log: () => {} });
const sfxCmd = buildSfxPlayCommand("nature-bird", sfxProduction, sfxCfg, { prepared: sfxPrepared });
check("launcher is powershell + Start-Process", sfxCmd.file === POWERSHELL_EXE && sfxCmd.inner.indexOf("Start-Process") === 0, sfxCmd.inner);
check("uses the bundled player with --file", sfxCmd.playerKind === "bundled-mci" && sfxCmd.inner.indexOf("--file") >= 0, sfxCmd.inner);
check(
  "plays the scratch copy, never the library file",
  sfxCmd.playFile === sfxPrepared.file && sfxCmd.isScratchCopy === true && sfxCmd.audioFile === sfxProduction && sfxCmd.playFile !== sfxProduction,
  JSON.stringify({ play: sfxCmd.playFile, src: sfxProduction }),
);
if (sfxPrepared.cleanup) sfxPrepared.cleanup();

section("9d. 音效播放静默降级（永不抛异常、永不误播）");
const unsafeSfx = playSfx("../../evil", Object.assign({}, sfxCfg, { fallbackBeep: false }), () => {});
check("unsafe key -> unsafe-key, no throw", unsafeSfx.ok === false && unsafeSfx.reason === "unsafe-key", JSON.stringify(unsafeSfx));
const absentSfx = playSfx("nature-nonexistent", Object.assign({}, sfxCfg, { fallbackBeep: false }), () => {});
check("missing file -> refused (beep disabled)", absentSfx.ok === false && absentSfx.beep === false, JSON.stringify(absentSfx));
// 现在会**解析真实可用的 python**（开放源码后的行为）：配错 pythonPath 也会被救回来、
// 照常播放。所以这条改成验证"救得回来"，并且只在完整模式下跑（它会真出声，用最短音效）。
if (skipSound) {
  console.log("  SKIP  (--no-sound：这条现在会真播放，因为 pythonPath 会被解析器救回来)");
} else {
  const noPythonSfx = playSfx("remind-crisp", Object.assign({}, sfxCfg, { fallbackBeep: false, pythonPath: "C:\\nope\\python.exe" }), () => {});
  check("pythonPath 配错也会被解析器救回来（照常播放）", noPythonSfx.ok === true, JSON.stringify(noPythonSfx));
  await sleep(1200); // 等这条短音效放完，别和后面的真实播放叠在一起响
}

section("9e. 可编辑 patch：enabled / alertMode / sfxByKind 白名单");
const okPatch = normalizeEditablePatch({
  enabled: false,
  alertMode: "sfx",
  sfxByKind: { complete: "nature-bird", fail: "remind-muyu", approval: "nope", extra: "x" },
});
check("enabled boolean accepted", okPatch.enabled === false, JSON.stringify(okPatch.enabled));
check("alertMode enum accepted", okPatch.alertMode === "sfx", String(okPatch.alertMode));
check(
  "sfxByKind keeps catalogue keys only",
  okPatch.sfxByKind.complete === "nature-bird" &&
    okPatch.sfxByKind.fail === "remind-muyu" &&
    okPatch.sfxByKind.approval === undefined &&
    okPatch.sfxByKind.extra === undefined,
  JSON.stringify(okPatch.sfxByKind),
);
const badPatch2 = normalizeEditablePatch({ enabled: "yes", alertMode: "bogus", sfxByKind: { complete: "../../evil" } });
check("non-boolean enabled dropped", badPatch2.enabled === undefined, JSON.stringify(badPatch2.enabled));
check("bogus alertMode dropped", badPatch2.alertMode === undefined, String(badPatch2.alertMode));
check("traversal sfx key dropped", badPatch2.sfxByKind.complete === undefined, JSON.stringify(badPatch2.sfxByKind));
check("normalizeSfxByKind ignores a non-object", Object.keys(normalizeSfxByKind("nope")).length === 0, "");

section("9f. config 往返：enabled + alertMode + sfxByKind 落盘并可读回");
const modeCfgDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-mode-"));
const modeCfgFile = join(modeCfgDir, "config.json");
writeFileSync(modeCfgFile, JSON.stringify({ enabled: true, tts: { apiKey: "KEEP-ME" }, texts: { complete: "keep" } }), "utf8");
const modeSave = saveEditableConfig(modeCfgFile, { enabled: false, alertMode: "sfx", sfxByKind: { fail: "nature-thunder" } }, () => {});
const modeRaw = JSON.parse(readFileSync(modeCfgFile, "utf8"));
check("saveEditableConfig accepts the new fields", modeSave.ok === true, JSON.stringify(modeSave));
check("alertMode persisted", modeRaw.alertMode === "sfx", String(modeRaw.alertMode));
check("enabled persisted", modeRaw.enabled === false, String(modeRaw.enabled));
check(
  "partial sfxByKind patch merges over the defaults",
  modeRaw.sfxByKind && modeRaw.sfxByKind.fail === "nature-thunder" && modeRaw.sfxByKind.complete === DEFAULT_SFX_BY_KIND.complete,
  JSON.stringify(modeRaw.sfxByKind),
);
check("untouched sibling keys survive", modeRaw.tts.apiKey === "KEEP-ME" && modeRaw.texts.complete === "keep", JSON.stringify({ tts: modeRaw.tts, texts: modeRaw.texts }));
const modeResolved = resolveConfig(undefined, { configPath: modeCfgFile });
check(
  "resolveConfig reads all three back",
  modeResolved.enabled === false && modeResolved.alertMode === "sfx" && modeResolved.sfxByKind.fail === "nature-thunder",
  JSON.stringify({ enabled: modeResolved.enabled, alertMode: modeResolved.alertMode, sfx: modeResolved.sfxByKind }),
);
check(
  "a bogus alertMode in config.json falls back to the DEFAULT (sfx)",
  resolveConfig({ alertMode: "bogus" }, { configPath: join(modeCfgDir, "none.json") }).alertMode === "sfx",
  "",
);
check(
  "a bogus sfx key in config.json is dropped (never reaches the player)",
  resolveConfig({ sfxByKind: { complete: "../../evil" } }, { configPath: join(modeCfgDir, "none.json") }).sfxByKind.complete ===
    DEFAULT_SFX_BY_KIND.complete,
  "",
);

section("9g. 提醒方式分流（引擎路径，seam 记录 mode/sfxKey）");
// 默认已是 sfx，所以"语音模式"用例显式指定 alertMode
const voiceMode = mount({ alertMode: "voice" }, { tmpDir });
const vmSession = rootSession("session-mode-voice");
voiceMode.ctx.emit("session/event", vmSession, sessionEvent("turn/start", { turn: 1 }));
voiceMode.ctx.emit("session/event", vmSession, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
check(
  "voice mode -> play with mode=voice",
  voiceMode.calls.length === 1 && voiceMode.calls[0].extra && voiceMode.calls[0].extra.mode === "voice",
  JSON.stringify(voiceMode.calls),
);

const sfxMode = mount({ alertMode: "sfx" }, { tmpDir });
const smSession = rootSession("session-mode-sfx");
sfxMode.ctx.emit("session/event", smSession, sessionEvent("turn/start", { turn: 1 }));
sfxMode.ctx.emit("session/event", smSession, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
check(
  "sfx mode -> mode=sfx + the default complete effect (no TTS)",
  sfxMode.calls.length === 1 && sfxMode.calls[0].extra.mode === "sfx" && sfxMode.calls[0].extra.sfxKey === DEFAULT_SFX_BY_KIND.complete,
  JSON.stringify(sfxMode.calls),
);

const sfxCustomMode = mount({ alertMode: "sfx", sfxByKind: { complete: "nature-bird" } }, { tmpDir });
const scSession = rootSession("session-mode-sfx-custom");
sfxCustomMode.ctx.emit("session/event", scSession, sessionEvent("turn/start", { turn: 1 }));
sfxCustomMode.ctx.emit("session/event", scSession, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
check(
  "a custom effect override is used",
  sfxCustomMode.calls.length === 1 && sfxCustomMode.calls[0].extra.sfxKey === "nature-bird",
  JSON.stringify(sfxCustomMode.calls),
);

const sfxFailMode = mount({ alertMode: "sfx" }, { tmpDir });
const sfSession = rootSession("session-mode-sfx-fail");
sfxFailMode.ctx.emit("session/event", sfSession, sessionEvent("turn/start", { turn: 1 }));
sfxFailMode.ctx.emit("tools/result", toolExec(sfSession, "tool_boom"), { isError: true });
check(
  "fail in sfx mode uses the fail effect (wooden fish by default)",
  sfxFailMode.calls.length === 1 && sfxFailMode.calls[0].extra.mode === "sfx" && sfxFailMode.calls[0].extra.sfxKey === DEFAULT_SFX_BY_KIND.fail,
  JSON.stringify(sfxFailMode.calls),
);

const offMode = mount({ alertMode: "off" }, { tmpDir });
const offSession = rootSession("session-mode-off");
offMode.ctx.emit("session/event", offSession, sessionEvent("turn/start", { turn: 1 }));
offMode.ctx.emit("session/event", offSession, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
offMode.ctx.emit("tools/result", toolExec(offSession, "tool_boom"), { isError: true });
check("alertMode=off -> nothing plays at all", offMode.calls.length === 0, JSON.stringify(offMode.calls));

const silentMode = mount({ enabled: false, alertMode: "sfx" }, { tmpDir });
const siSession = rootSession("session-mode-silent");
silentMode.ctx.emit("session/event", siSession, sessionEvent("turn/start", { turn: 1 }));
silentMode.ctx.emit("session/event", siSession, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
check("master switch off beats sfx mode", silentMode.calls.length === 0, JSON.stringify(silentMode.calls));

section("9h. /sfx/list 与 /sfx/play 路由");
const sfxRouted = mount({}, { tmpDir, webServer: true });
const sfxRoutePaths = sfxRouted.ctx._routes.map((route) => route.path);
check(
  "both sfx routes are registered",
  sfxRoutePaths.indexOf("/dsh-voice-alert/sfx/list") >= 0 && sfxRoutePaths.indexOf("/dsh-voice-alert/sfx/play") >= 0,
  JSON.stringify(sfxRoutePaths.filter((p) => p.indexOf("/sfx") >= 0)),
);
const sfxListRoute = sfxRouted.ctx._routes.find((route) => route.path === "/dsh-voice-alert/sfx/list");
const sfxListRes = fakeRes();
await sfxListRoute.handler(fakeReq("/dsh-voice-alert/sfx/list"), sfxListRes);
const sfxListPayload = JSON.parse(sfxListRes.body);
check(
  "list answers 20 items, all present on disk",
  sfxListRes.status === 200 && sfxListPayload.ok === true && sfxListPayload.total === 20 && sfxListPayload.present === 20,
  JSON.stringify({ status: sfxListRes.status, total: sfxListPayload.total, present: sfxListPayload.present }),
);
check("list items carry key/name/group", sfxListPayload.items.every((item) => item.key && item.name && item.group), JSON.stringify(sfxListPayload.items.slice(0, 2)));
check(
  "list is human-labelled in Chinese",
  sfxListPayload.items.some((item) => item.name === "鸟鸣") && sfxListPayload.items.some((item) => item.name === "木鱼"),
  "",
);
const sfxListForeignRes = fakeRes();
await sfxListRoute.handler(fakeReq("/dsh-voice-alert/sfx/list", "192.0.2.7"), sfxListForeignRes);
check("list stays 403 for non-loopback", sfxListForeignRes.status === 403, String(sfxListForeignRes.status));

const sfxPlayRoute = sfxRouted.ctx._routes.find((route) => route.path === "/dsh-voice-alert/sfx/play");
const sfxBadRes = fakeRes();
await sfxPlayRoute.handler(fakeReq("/dsh-voice-alert/sfx/play?name=../../evil"), sfxBadRes);
check("play refuses a non-catalogue name (400)", sfxBadRes.status === 400, String(sfxBadRes.status));
// 这里曾用"配一个不存在的 pythonPath"来保证自测不出声；但现在插件会**解析真实可用的解释器**
// （开源：默认值是 PATH 名，可能命中 WindowsApps 存根），所以配错也会被救回来、播放照常成功
// —— 这正是想要的行为。于是断言改成"配错也能播"，并只在完整模式跑（它会真出声，用最短音效）。
const quietSfx = mount({ pythonPath: "C:\\nope\\python.exe", fallbackBeep: false }, { tmpDir, webServer: true });
const quietPlayRoute = quietSfx.ctx._routes.find((route) => route.path === "/dsh-voice-alert/sfx/play");
if (skipSound) {
  console.log("  SKIP  (--no-sound：这条现在会真播放，因为 pythonPath 会被解析器救回来)");
} else {
  const quietRes = fakeRes();
  await quietPlayRoute.handler(fakeReq("/dsh-voice-alert/sfx/play?name=remind-crisp"), quietRes);
  check(
    "play accepts a catalogue name（pythonPath 配错也会被解析器救回来）",
    quietRes.status === 200 && JSON.parse(quietRes.body).ok === true,
    quietRes.body,
  );
}

section("9i. /settings 回显提醒方式与音效目录");
const sfxSettingsRouted = mount({}, { tmpDir, webServer: true });
const sfxSettingsRoute = sfxSettingsRouted.ctx._routes.find((route) => route.path === "/dsh-voice-alert/settings");
const sfxSettingsRes = fakeRes();
await sfxSettingsRoute.handler(fakeReq("/dsh-voice-alert/settings"), sfxSettingsRes);
const sfxSettingsPayload = JSON.parse(sfxSettingsRes.body);
check(
  "payload carries enabled + alertMode (默认 sfx = 开源零配置)",
  sfxSettingsPayload.enabled === true && sfxSettingsPayload.alertMode === "sfx",
  JSON.stringify({ enabled: sfxSettingsPayload.enabled, alertMode: sfxSettingsPayload.alertMode }),
);
check(
  "payload carries the 20-entry catalogue",
  Array.isArray(sfxSettingsPayload.sfxCatalog) && sfxSettingsPayload.sfxCatalog.length === 20,
  String(sfxSettingsPayload.sfxCatalog && sfxSettingsPayload.sfxCatalog.length),
);
check(
  "payload carries the per-event selection",
  sfxSettingsPayload.sfxByKind && sfxSettingsPayload.sfxByKind.complete === DEFAULT_SFX_BY_KIND.complete,
  JSON.stringify(sfxSettingsPayload.sfxByKind),
);

section("9j. 设置页 DOM：提醒方式三按钮 + 音效面板（DOM stub）");
check(
  "three mode buttons rendered",
  ["voice", "sfx", "off"].every((mode) => Boolean(domNodes.get("dva-alert-mode-" + mode))),
  JSON.stringify(["voice", "sfx", "off"].map((m) => Boolean(domNodes.get("dva-alert-mode-" + m)))),
);
check("mode hint line rendered", Boolean(domNodes.get("dva-alert-mode-hint")), "");
check("sfx panel rendered", Boolean(domNodes.get("dva-sfx-panel")), "");
check(
  "20-effect list rendered: every effect has 3 checkboxes + an audition button",
  clientExports.__dvaTest.SFX_FALLBACK.every((item) =>
    ["complete", "fail", "approval"].every((kind) => Boolean(domNodes.get("dva-sfxpick-" + item.key + "-" + kind))),
  ) && clientExports.__dvaTest.SFX_FALLBACK.every((item) => Boolean(domNodes.get("dva-sfx-preview-" + item.key))),
  String(clientExports.__dvaTest.SFX_FALLBACK.length),
);
check(
  "three hidden carriers + three per-event summary lines rendered",
  ["complete", "fail", "approval"].every(
    (kind) => Boolean(domNodes.get("dva-sfx-" + kind)) && Boolean(domNodes.get("dva-sfx-current-" + kind)),
  ),
  "",
);
check("sfx panel is hidden while the mode is voice", String(domNodes.get("dva-sfx-panel").style.display) === "none", String(domNodes.get("dva-sfx-panel").style.display));
check("the voice mode button carries the active style", String(domNodes.get("dva-alert-mode-voice").style.background).indexOf("31,111,235") >= 0 || String(domNodes.get("dva-alert-mode-voice").style.background) === "#1f6feb", String(domNodes.get("dva-alert-mode-voice").style.background));

// ------------------------------------------------- 10. v0.3.4（用户 2026-09-16 反馈）

section("10a. 界面不再出现具体人名（插件要分发给别人用）");
// 人名用码点拼接，避免测试文件本身变成"人名扫描"的命中源
const FORBIDDEN_PERSON_NAME = String.fromCharCode(0x6bdb, 0x6653, 0x5f64);
const clientSource = readFileSync(join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
check("client bundle carries no person name", clientSource.indexOf(FORBIDDEN_PERSON_NAME) < 0, "");
const hostSources = ["config.js", "index.js", "generate.js", "player.js", "tts.js", "engine.js"]
  .map((file) => readFileSync(join(import.meta.dirname, "..", "lib", file), "utf8"))
  .join("\n");
check("host lib carries no person name", hostSources.indexOf(FORBIDDEN_PERSON_NAME) < 0, "");
check("默认音色备注为空（由使用者自己填）", DEFAULT_CONFIG.voiceNote === "", JSON.stringify(DEFAULT_CONFIG.voiceNote));
check(
  "默认音色库为空（开源版不内置任何具体音色，使用者填自己的）",
  Array.isArray(DEFAULT_CONFIG.voices) && DEFAULT_CONFIG.voices.length === 0,
  JSON.stringify(DEFAULT_CONFIG.voices),
);
check("默认提醒方式是音效（零配置开箱即用）", DEFAULT_CONFIG.alertMode === "sfx", String(DEFAULT_CONFIG.alertMode));

section("10b. 克隆音色入口（网址随宿主 payload 下发 + DOM 渲染）");
check("payload carries the clone console url", /console\.volcengine\.com/.test(String(sfxSettingsPayload.cloneConsoleUrl)), String(sfxSettingsPayload.cloneConsoleUrl));
check("payload carries the clone product url", /volcengine\.com\/product/.test(String(sfxSettingsPayload.cloneProductUrl)), String(sfxSettingsPayload.cloneProductUrl));
check("DOM renders both clone links", Boolean(domNodes.get("dva-clone-link")) && Boolean(domNodes.get("dva-clone-link-doc")), "");
check("clone hint explains the S_ id flow", String(domNodes.get("dva-clone-note").textContent).indexOf("S_") >= 0, String(domNodes.get("dva-clone-note").textContent));
check(
  "界面上常驻「没声音就调一下系统音量」提示（用户要求写在界面上）",
  Boolean(domNodes.get("dva-audio-tip")) && String(domNodes.get("dva-audio-tip").textContent).indexOf("系统音量") >= 0,
  String(domNodes.get("dva-audio-tip") && domNodes.get("dva-audio-tip").textContent),
);

section("10c. 音效勾选（互斥 + 回显 + 保存取值）");
const sfxUi = clientExports.__dvaTest;
sfxUi.applySfxSelection();
check(
  "default selection is reflected in the checkboxes",
  domNodes.get("dva-sfxpick-remind-tada-complete").checked === true && domNodes.get("dva-sfxpick-remind-muyu-fail").checked === true,
  JSON.stringify({ complete: domNodes.get("dva-sfxpick-remind-tada-complete").checked, fail: domNodes.get("dva-sfxpick-remind-muyu-fail").checked }),
);
check("summary line names the current effect", String(domNodes.get("dva-sfx-current-complete").textContent).indexOf("成功号角") >= 0, String(domNodes.get("dva-sfx-current-complete").textContent));
sfxUi.setSfxFor("complete", "nature-bird");
check(
  "picking another effect moves the checkbox (mutually exclusive)",
  domNodes.get("dva-sfxpick-nature-bird-complete").checked === true && domNodes.get("dva-sfxpick-remind-tada-complete").checked === false,
  JSON.stringify({ bird: domNodes.get("dva-sfxpick-nature-bird-complete").checked, tada: domNodes.get("dva-sfxpick-remind-tada-complete").checked }),
);
check("the hidden carrier follows the pick (save reads it)", domNodes.get("dva-sfx-complete").value === "nature-bird", String(domNodes.get("dva-sfx-complete").value));
check("summary line follows the pick", String(domNodes.get("dva-sfx-current-complete").textContent).indexOf("鸟鸣") >= 0, String(domNodes.get("dva-sfx-current-complete").textContent));
check("status tells the user to save", String(domNodes.get("dva-status").textContent).indexOf("保存设置") >= 0, String(domNodes.get("dva-status").textContent));
check(
  "the client fallback catalogue matches the host catalogue exactly",
  JSON.stringify(sfxUi.SFX_FALLBACK.map((item) => item.key + "|" + item.name + "|" + item.group)) ===
    JSON.stringify(SFX_CATALOG.map((item) => item.key + "|" + item.name + "|" + item.group)),
  "",
);

section("10d. 生成进度 + 「语音更新成功 / 失败」提示");
const realFetch = globalThis.fetch;
globalThis.fetch = function (url, init) {
  if (url.indexOf("/generate-status") >= 0) {
    return Promise.resolve({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          running: true,
          changed: ["complete", "fail", "approval"],
          outputs: { complete: { ok: true }, fail: { ok: true, reused: true } },
        }),
    });
  }
  return realFetch(url, init);
};
clientExports.__dvaTest.cache.busy = true;
await clientExports.__dvaTest.pollJob();
check("running run shows x/y progress", String(domNodes.get("dva-status").textContent).indexOf("1/3") >= 0, String(domNodes.get("dva-status").textContent));

globalThis.fetch = function (url, init) {
  if (url.indexOf("/generate-status") >= 0) {
    return Promise.resolve({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          running: false,
          result: "mixed",
          changed: ["complete", "fail"],
          reused: ["approval"],
          outputs: { complete: { ok: true }, fail: { ok: true }, approval: { ok: true, reused: true } },
        }),
    });
  }
  return realFetch(url, init);
};
await clientExports.__dvaTest.pollJob();
check(
  "finished run says 语音更新成功 with the updated count",
  String(domNodes.get("dva-status").textContent).indexOf("语音更新成功") >= 0 && String(domNodes.get("dva-status").textContent).indexOf("2 条") >= 0,
  String(domNodes.get("dva-status").textContent),
);

globalThis.fetch = function (url, init) {
  if (url.indexOf("/generate-status") >= 0) {
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({ ok: true, running: false, result: "partial", changed: ["fail"], reused: [], outputs: { fail: { ok: false, error: "TTS 400" } } }),
    });
  }
  return realFetch(url, init);
};
await clientExports.__dvaTest.pollJob();
check(
  "a failed kind is reported as 语音更新失败 (not silently 'done')",
  String(domNodes.get("dva-status").textContent).indexOf("语音更新失败") >= 0,
  String(domNodes.get("dva-status").textContent),
);
globalThis.fetch = realFetch;

section("10e. 试听串行化：路由在设备占用判定下仍正常作答");
const serialRouted = mount({ pythonPath: "C:\\nope\\python.exe", fallbackBeep: false }, { tmpDir, webServer: true });
const serialPreview = serialRouted.ctx._routes.find((route) => route.path === "/dsh-voice-alert/preview");
const serialPreviewRes = fakeRes();
await serialPreview.handler(fakeReq("/dsh-voice-alert/preview?kind=complete"), serialPreviewRes);
check("preview route answers after serialization", serialPreviewRes.status === 200, String(serialPreviewRes.body));
const serialSfx = serialRouted.ctx._routes.find((route) => route.path === "/dsh-voice-alert/sfx/play");
const serialSfxRes = fakeRes();
await serialSfx.handler(fakeReq("/dsh-voice-alert/sfx/play?name=nature-bird"), serialSfxRes);
check("sfx play route answers after serialization", serialSfxRes.status === 200, String(serialSfxRes.body));

// ------------------------------------------------- 11. 音频端点预热（v0.3.5 修复「刚生成后试听没声音」）

section("11a. 播放器脚本：预热 + 返回码检查 + 诊断日志（源码级）");
const playerSource = readFileSync(join(import.meta.dirname, "..", "lib", "play_mp3_mci.py"), "utf8");
check(
  "player prewarms the audio endpoint with a silent WAV",
  playerSource.indexOf("def prewarm_silence") >= 0 && playerSource.indexOf("winsound") >= 0 && playerSource.indexOf("SND_MEMORY") >= 0,
  "",
);
check(
  "prewarm runs in a worker thread, in parallel with the file open (latency fix)",
  playerSource.indexOf("threading.Thread") >= 0 && playerSource.indexOf("warm.start()") >= 0,
  "",
);
check(
  "player logs millisecond stamps with per-stage offsets (latency measurable)",
  playerSource.indexOf("def since_ms") >= 0 && playerSource.indexOf("+%dms") >= 0,
  "",
);
check(
  "prewarm never touches volume/mute (hard rule kept)",
  playerSource.indexOf("set_master") < 0 && playerSource.indexOf("set_mute") < 0 && playerSource.indexOf("waveOutSetVolume") < 0,
  "",
);
check(
  "the MCI play return code is now checked and retried (it used to be ignored)",
  /rc_play\s*=\s*winmm\.mciSendStringW\("play/.test(playerSource) && playerSource.indexOf("retrying once") >= 0,
  "",
);
check(
  "player writes diagnostics through --log-file",
  playerSource.indexOf("--log-file") >= 0 && playerSource.indexOf("def log_line") >= 0,
  "",
);
check(
  "prewarm can be skipped for diagnosis",
  playerSource.indexOf("--no-prewarm") >= 0,
  "",
);

section("11b. 播放命令带上诊断日志参数");
const diagPlayCmd = buildPlayCommand("complete", Object.assign({}, shapeConfig, { logPath: "C:\\tmp\\va.log" }), { prepared: null });
check("bundled voice command passes --log-file", diagPlayCmd.inner.indexOf("'--log-file'") > 0, diagPlayCmd.inner);
const diagSfxCmd = buildSfxPlayCommand("nature-bird", sfxProduction, Object.assign({}, sfxCfg, { logPath: "C:\\tmp\\va.log" }), { prepared: null });
check("sfx command passes --log-file", diagSfxCmd.inner.indexOf("'--log-file'") >= 0, diagSfxCmd.inner);
check(
  "shared-player fallback is left untouched (it has no such flag)",
  buildPlayCommand("complete", Object.assign({}, shapeConfig, { bundledPlayer: "C:\\nope\\player.py", logPath: "C:\\tmp\\va.log" })).inner.indexOf("'--log-file'") < 0,
  "",
);

section("11c. 真实触发一次播放器（仅完整模式；--no-sound 跳过）");
if (skipSound) {
  console.log("  SKIP  (--no-sound)");
} else {
  const probeLog = join(tmpDir, "player-diagnostics.log");
  const probeFile = sfxPathFor("remind-crisp", sfxCfg);
  const run = spawnSync(
    "E:\\Python311\\python.exe",
    // 显式要求预热：默认是不预热的（见 11e 段），这里验证"需要时预热仍然可用"。
    [join(import.meta.dirname, "..", "lib", "play_mp3_mci.py"), "--file", probeFile, "--prewarm-ms", "350", "--log-file", probeLog],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  const probeText = existsSync(probeLog) ? readFileSync(probeLog, "utf8") : "";
  check("bundled player exits 0 on a real file", run.status === 0, String(run.status) + " stderr=" + String(run.stderr).slice(0, 200));
  check("显式 --prewarm-ms 时仍然会预热（能力保留）", probeText.indexOf("prewarm ok") >= 0, probeText.slice(0, 300));
  check("real run logged a successful play with position samples", /played play_rc=0/.test(probeText) && /positions=\d+/.test(probeText), probeText.slice(0, 400));
  const issuedMatch = /\+(\d+)ms play issued/.exec(probeText);
  const openMatch = /\+(\d+)ms mci open/.exec(probeText);
  check(
    "进程启动 → 开始出声 控制在 900ms 内（并行预热后实测约 610ms）",
    Boolean(issuedMatch) && Number(issuedMatch[1]) < 900,
    issuedMatch ? issuedMatch[1] + "ms" : probeText.slice(0, 300),
  );
  check(
    "打开文件被预热掩盖（open 发生在预热窗口内）",
    Boolean(openMatch) && Boolean(issuedMatch) && Number(openMatch[1]) < Number(issuedMatch[1]),
    "open=" + (openMatch ? openMatch[1] : "?") + "ms issued=" + (issuedMatch ? issuedMatch[1] : "?") + "ms",
  );
}

// ------------------------------------------------- 12. 备选播放内核：waveOut/WAV（v0.3.9）

section("11e. 默认不预热（v0.4.3：实测预热会打断蓝牙耳机上正在播的音乐）");
check("默认 prewarmMs = 0（不预热）", DEFAULT_CONFIG.prewarmMs === 0, String(DEFAULT_CONFIG.prewarmMs));
const noWarmCmd = buildPlayCommand("complete", shapeConfig);
check("默认播放命令带 --no-prewarm", noWarmCmd.inner.indexOf("'--no-prewarm'") > 0, noWarmCmd.inner);
const warmCmd = buildPlayCommand("complete", Object.assign({}, shapeConfig, { prewarmMs: 350 }));
check(
  "显式配置 prewarmMs=350 时改传 --prewarm-ms 350（能力保留）",
  warmCmd.inner.indexOf("'--prewarm-ms'") > 0 && warmCmd.inner.indexOf("'350'") > 0,
  warmCmd.inner,
);
const noWarmWavCmd = buildWavPlayCommand("C:\\cache\\x.wav", shapeConfig);
check("wav 命令同样默认不预热", noWarmWavCmd.inner.indexOf("'--no-prewarm'") >= 0, noWarmWavCmd.inner);

section("12a. 播放内核开关（默认 mci = 行为不变）");
check(
  "产品默认内核 = wav（实测：蓝牙耳机下 waveOut 不吞首声、不打断音乐）",
  DEFAULT_CONFIG.playerEngine === "wav",
  String(DEFAULT_CONFIG.playerEngine),
);
check("显式 mci 仍可用（旧内核保留）", resolvePlayerEngine({ playerEngine: "mci" }) === "mci", "");
check("playerEngine=wav 时切 waveOut", resolvePlayerEngine({ playerEngine: "wav" }) === "wav", "");
check("拼错的内核名回落 mci（绝不静音）", resolvePlayerEngine({ playerEngine: "wasapi" }) === "mci", "");
const engineCfg = resolveConfig(undefined, { configPath: join(tmpDir, "engine-none.json") });
check("resolveConfig 解析默认内核(wav) + wav 缓存目录", engineCfg.playerEngine === "wav" && String(engineCfg.wavCacheDir).indexOf("wav-cache") >= 0, JSON.stringify({ engine: engineCfg.playerEngine, dir: engineCfg.wavCacheDir }));
check("resolveConfig 认 wav", resolveConfig({ playerEngine: "wav" }, { configPath: join(tmpDir, "engine-none.json") }).playerEngine === "wav", "");
check("resolveConfig 把未知内核名回落 mci", resolveConfig({ playerEngine: "wasapi" }, { configPath: join(tmpDir, "engine-none.json") }).playerEngine === "mci", "");

section("12b. WAV 缓存路径与启动命令");
check(
  "缓存路径 = <wavCacheDir>/<name>.wav",
  wavCacheFileFor("C:\\a\\b\\voice-alert-complete-poetic-loud.mp3", { wavCacheDir: "C:\\cache" }) === join("C:\\cache", "voice-alert-complete-poetic-loud.wav"),
  wavCacheFileFor("C:\\a\\b\\voice-alert-complete-poetic-loud.mp3", { wavCacheDir: "C:\\cache" }),
);
check("wav 播放器脚本存在", Boolean(wavPlayerPath()), String(wavPlayerPath()));
const wavCmd = buildWavPlayCommand("C:\\cache\\x.wav", Object.assign({}, sfxCfg, { logPath: "C:\\tmp\\va.log" }));
check(
  "命令仍是 hidden powershell → Start-Process，且指向 play_wav_out.py",
  wavCmd.inner.indexOf("Start-Process") === 0 && wavCmd.playerKind === "wav-out" && wavCmd.inner.indexOf("play_wav_out.py") >= 0,
  wavCmd.inner,
);
check("命令带 --file 与 --log-file", wavCmd.inner.indexOf("'--file'") >= 0 && wavCmd.inner.indexOf("'--log-file'") >= 0, wavCmd.inner);
check(
  "mci 模式下 tryPlayViaWav 不动手",
  tryPlayViaWav("C:\\nope.mp3", Object.assign({}, sfxCfg, { playerEngine: "mci" }), () => {}).reason === "engine-is-mci",
  "",
);

section("12c. 真实 mp3 → wav 转换（不播音）");
const wavCacheDir = join(tmpDir, "wav-cache");
const wavCfg = Object.assign({}, sfxCfg, { playerEngine: "wav", wavCacheDir });
const wavSource = sfxPathFor("remind-crisp", sfxCfg);
const builtWav = ensureWavCache(wavSource, wavCfg, { log: () => {} });
check("转换成功且产物非空", builtWav.ok === true && existsSync(builtWav.file) && statSync(builtWav.file).size > 1000, JSON.stringify(builtWav));
check("二次调用命中缓存（不重复转换）", ensureWavCache(wavSource, wavCfg, { log: () => {} }).converted === false, "");
check(
  "wav 播放器脚本语法 OK",
  spawnSync("E:\\Python311\\python.exe", ["-m", "py_compile", join(import.meta.dirname, "..", "lib", "play_wav_out.py")]).status === 0,
  "",
);

section("12d. 真实 wav 播放（仅完整模式）");
if (skipSound) {
  console.log("  SKIP  (--no-sound)");
} else {
  const wavLog = join(tmpDir, "wav-player.log");
  const runWav = spawnSync(
    "E:\\Python311\\python.exe",
    [join(import.meta.dirname, "..", "lib", "play_wav_out.py"), "--file", builtWav.file, "--prewarm-ms", "350", "--log-file", wavLog],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  const wavText = existsSync(wavLog) ? readFileSync(wavLog, "utf8") : "";
  check("wav 播放器退出 0", runWav.status === 0, String(runWav.status) + " " + String(runWav.stderr).slice(0, 200));
  check("wav 日志含预热 + 播放完成", wavText.indexOf("prewarm ok") >= 0 && wavText.indexOf("played (waveOut") >= 0, wavText.slice(0, 300));
}

// ------------------------------------------------- 13. python 解释器解析（开源关键）

section("13. python 解析：不写死本机路径，也不被 Windows 应用商店存根骗");
check("默认值是 PATH 名而非本机绝对路径", DEFAULT_CONFIG.pythonPath === "python", String(DEFAULT_CONFIG.pythonPath));
const resolvedPy = resolvePython({ pythonPath: "python" }, { noCache: true });
check(
  "解析出的解释器真实存在（或明确 fallback）",
  resolvedPy.source === "fallback" || existsSync(resolvedPy.path),
  JSON.stringify(resolvedPy),
);
check("解析结果不是 WindowsApps 存根", !/WindowsApps/iu.test(resolvedPy.path), resolvedPy.path);
const cacheA = resolvePython({ pythonPath: "python" });
const cacheB = resolvePython({ pythonPath: "python" });
check("重复调用命中缓存（路径一致，不再 spawn）", cacheA.path === cacheB.path, cacheA.path);
if (existsSync(resolvedPy.path) && resolvedPy.source !== "fallback") {
  const explicit = resolvePython({ pythonPath: resolvedPy.path }, { noCache: true });
  check(
    "显式配置的解释器被优先采用",
    explicit.path === resolvedPy.path && explicit.source === resolvedPy.path,
    JSON.stringify(explicit),
  );
} else {
  console.log("  SKIP  显式配置优先（本机没解析到可用 python）");
}

// ---------------------------------------------------------------- summary

section("summary");
console.log("  passed: " + passed);
console.log("  failed: " + failures.length);
for (const failure of failures) console.log("    - " + failure);
console.log("  log dir: " + tmpDir);
console.log("");
if (failures.length > 0) {
  console.log("SELF-CHECK FAILED");
  process.exit(1);
}
console.log("SELF-CHECK OK");
