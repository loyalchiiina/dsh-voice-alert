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
import { fileURLToPath } from "node:url";

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
  mutedByVolume,
  prosodyMinFor,
  FREE_VOICES,
  isFreeVoiceId,
  isMalformedFreeVoiceId,
  freeVoiceView,
  isVoicesLibraryId,
  FREE_VOICE_NAME_MAX,
} from "../lib/config.js";
import {
  edgeArgsFor,
  edgeRateFor,
  synthesizeEdge,
  edgeRuntimeStatus,
} from "../lib/edgevoice.js";
import {
  clearImportMarker,
  createGenerator,
  fingerprintFor,
  importMarkerPath,
  isImportedKind,
  planChanges,
  renameWithRetry,
  resolveFfmpeg,
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
// 此段只验证 errorMinIntervalMs 的 5s 时间窗，故显式关掉 failOncePerTurn（按轮去重），
// 否则同一 turn 内的第二次失败会被「每轮只播一次」拦掉，两个机制混在一起测不清。
const fresh = mount({ errorMinIntervalMs: 5000, failOncePerTurn: false }, { tmpDir });
const s2 = rootSession("session-root-2");
fresh.ctx.emit("session/event", s2, sessionEvent("turn/start", { turn: 1 }));
fresh.ctx.emit("tools/result", toolExec(s2, "tool_a"), { isError: true });
fresh.ctx.emit("tools/result", toolExec(s2, "tool_b"), { isError: true });
check("second error within 5s is throttled", fresh.calls.length === 1, JSON.stringify(fresh.calls));
fresh.clock.value += 5000;
fresh.ctx.emit("tools/result", toolExec(s2, "tool_c"), { isError: true });
check("error after 5s plays again", fresh.calls.length === 2, JSON.stringify(fresh.calls));

section("2d2. failOncePerTurn (default true): one fail cue per turn, however many calls fail");
// 实测缺陷（Lead 探针，errorMinIntervalMs=5000、6 次失败各隔 6s）：旧逻辑播 6 次。
// 5s 窗只限速、不去重，所以长轮次里失败间隔一超过 5s 就一次次响。failOncePerTurn 让
// 同一 "sessionId#turn" 只播第一次 fail（仍 markErrored，turn/end 不会叠 complete）。
const onceTurn = mount({}, { tmpDir });
const s5 = rootSession("session-root-once");
onceTurn.ctx.emit("session/event", s5, sessionEvent("turn/start", { turn: 1 }));
for (let i = 0; i < 6; i++) {
  onceTurn.clock.value += 6000; // 每次都越过 5s 限速窗：拦住它的必须是按轮去重，不是限速
  onceTurn.ctx.emit("tools/result", toolExec(s5, "tool_" + i), { isError: true });
}
check(
  "6 failures in one turn (6s apart) play exactly 1 fail",
  onceTurn.calls.filter((c) => c.kind === "fail").length === 1,
  JSON.stringify(onceTurn.calls),
);
onceTurn.clock.value += 6000;
onceTurn.ctx.emit("session/event", s5, sessionEvent("turn/end", { turn: 1, reason: { kind: "error" } }));
check(
  "that turn's errored turn/end stacks no second fail (and no complete)",
  onceTurn.calls.length === 1 && onceTurn.calls.filter((c) => c.kind === "complete").length === 0,
  JSON.stringify(onceTurn.calls),
);
onceTurn.clock.value += 6000;
onceTurn.ctx.emit("session/event", s5, sessionEvent("turn/start", { turn: 2 }));
onceTurn.ctx.emit("tools/result", toolExec(s5, "tool_next"), { isError: true });
check(
  "a NEW turn fails again (one cue per turn, not per session)",
  onceTurn.calls.filter((c) => c.kind === "fail").length === 2,
  JSON.stringify(onceTurn.calls),
);
const onceOff = mount({ failOncePerTurn: false }, { tmpDir });
const s6 = rootSession("session-root-once-off");
onceOff.ctx.emit("session/event", s6, sessionEvent("turn/start", { turn: 1 }));
for (let i = 0; i < 6; i++) {
  onceOff.clock.value += 6000;
  onceOff.ctx.emit("tools/result", toolExec(s6, "tool_" + i), { isError: true });
}
check(
  "failOncePerTurn=false restores 6 plays for 6 failures (control)",
  onceOff.calls.filter((c) => c.kind === "fail").length === 6,
  JSON.stringify(onceOff.calls),
);
// stats 计数 + log 一行 + playManual 豁免：直接驱动 engine（与 mount 同一条决策链）
let gateClock = 1000000;
const gateCalls = [];
const gateLogs = [];
const gated = createEngine({
  config: Object.assign({}, DEFAULT_CONFIG),
  play(kind, meta) {
    gateCalls.push({ kind, meta });
  },
  log(message) {
    gateLogs.push(String(message));
  },
  now() {
    return gateClock;
  },
});
const gs = rootSession("session-gate-1");
gated.onSessionEvent(gs, sessionEvent("turn/start", { turn: 1 }));
for (let i = 0; i < 6; i++) {
  gateClock += 6000;
  gated.onToolResult(toolExec(gs, "tool_" + i), { isError: true });
}
const gateStats = gated.snapshot().stats;
check(
  "suppressed fails are counted in stats.failSuppressedPerTurn and logged",
  gateStats.failPlaysImmediate === 1 &&
    gateStats.failSuppressedPerTurn === 5 &&
    gateStats.throttled === 0 &&
    gateLogs.some((line) => line.indexOf("fail suppressed by failOncePerTurn: session-gate-1#1") >= 0),
  JSON.stringify(gateStats) + " logs=" + JSON.stringify(gateLogs),
);
gated.playManual("fail");
gated.playManual("fail");
check(
  "playManual('fail') twice in one turn both play (manual is exempt)",
  gateCalls.filter((c) => c.kind === "fail" && c.meta && c.meta.source === "manual").length === 2 &&
    gateStats.failSuppressedPerTurn === 5,
  JSON.stringify(gateCalls),
);
gated.dispose();

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
// 注意：这里的路径必须是绝对路径（放 tmpDir 下）。用相对名 "from.mp3"/"to.mp3" 会让夹具
// 把文件写到**当前工作目录**（用户跑自检时就是仓库根目录），留下一个 7 字节的 to.mp3 垃圾文件。
const fromFixture = join(tmpDir, "rename-from.mp3");
const toFixture = join(tmpDir, "rename-to.mp3");
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
const retried = await renameWithRetry(fromFixture, toFixture, { retries: 5, delayMs: 1, fsOps: flakyFs });
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
// --- 2e. 导入的 mp3 不得被 TTS 覆盖（P0-4）------------------------------------
// 用户用「⬆ 导入 MP3」换掉某条播报后，磁盘上的音频是用户自己的文件。改文案
// 触发生成时绝不能把它冲掉（旧版会，且无备份可回滚）。导入路由写一个标记
// 文件，planChanges 见到标记就把该 kind 从 changed 里摘出去。
const importedKind = "complete";
mkdirSync(planConfig.audioOriginDir, { recursive: true });
check(
  "import marker path sits next to the origin file",
  importMarkerPath(importedKind, planConfig) === join(planConfig.audioOriginDir, "voice-alert-complete-poetic.imported.json"),
  importMarkerPath(importedKind, planConfig),
);
check("no marker yet -> kind is not imported", isImportedKind(importedKind, planConfig) === false, String(isImportedKind(importedKind, planConfig)));
writeFileSync(
  importMarkerPath(importedKind, planConfig),
  JSON.stringify({ kind: importedKind, bytes: 123, importedAt: "2026-01-01T00:00:00.000Z", backupDir: "x", sha256: "abc" }),
  "utf8",
);
check("marker present -> kind is imported", isImportedKind(importedKind, planConfig) === true, String(isImportedKind(importedKind, planConfig)));
planConfig.prosody.speed_ratio = 1.05;
planConfig.texts.complete = "A changed again";
const importPlan = planChanges(planConfig, ["complete", "fail", "approval"]);
check(
  "imported kind is skipped, not regenerated, when its text changes",
  importPlan.changed.indexOf("complete") === -1 && importPlan.skippedImported.indexOf("complete") !== -1,
  JSON.stringify(importPlan),
);
check(
  "imported kind does not pollute reused either",
  importPlan.reused.indexOf("complete") === -1,
  JSON.stringify(importPlan),
);
const importForcedPlan = planChanges(planConfig, ["complete", "fail", "approval"], { force: true });
check(
  "force may still replace imported audio (explicit user intent)",
  importForcedPlan.changed.indexOf("complete") !== -1 && importForcedPlan.skippedImported.length === 0,
  JSON.stringify(importForcedPlan),
);
clearImportMarker(importedKind, planConfig, () => {});
check("clearImportMarker removes the marker", isImportedKind(importedKind, planConfig) === false, String(isImportedKind(importedKind, planConfig)));
const afterClearPlan = planChanges(planConfig, ["complete"]);
check(
  "after the marker is gone the kind is regenerated again",
  afterClearPlan.changed.indexOf("complete") !== -1 && afterClearPlan.skippedImported.length === 0,
  JSON.stringify(afterClearPlan),
);
planConfig.texts.complete = "A";

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
// 置 true 时，下一次 POST /settings 直接 reject —— 用来验证 persistPatch 的失败回滚
// （界面必须退回宿主仍持有的旧值，不能停在用户点击后的状态）。
let clientFailNextSettings = false;
// 置 true 时，下一次 POST /settings 返回 HTTP 500 + reason（覆盖 persistPatch 的
// 「HTTP 非 200」分支 —— 它与「网络异常」是两个不同分支，原测试只覆盖了后者）。
let clientFailNextSettingsStatus = 0;
// mock 宿主的「当前状态」：POST /settings 的回包必须像真宿主一样反映它，
// 而不是用常量兜底（常量兜底会把没点名的字段重置，制造假缺陷）。
const mockHostState = {
  enabled: true,
  alertMode: "voice",
  // approval 默认值是 remind-dingdong（config.js:100），不是 remind-phone
  sfxByKind: { complete: "remind-tada", fail: "remind-muyu", approval: "remind-dingdong" },
  prosody: { speed_ratio: 1.1, pitch_ratio: 1.0, volume_ratio: 1 },
};
globalThis.fetch = function (url, init) {
  clientFetchCalls.push({ url, init });
  const respond = function (status, json) {
    return Promise.resolve({ status, json: () => Promise.resolve(json) });
  };
  if (clientFailNextSettings && url.indexOf("/settings") >= 0 && String(init && init.method).toUpperCase() === "POST") {
    clientFailNextSettings = false;
    return Promise.reject(new Error("simulated network failure"));
  }
  if (clientFailNextSettingsStatus && url.indexOf("/settings") >= 0 && String(init && init.method).toUpperCase() === "POST") {
    const code = clientFailNextSettingsStatus;
    clientFailNextSettingsStatus = 0;
    return respond(code, { ok: false, reason: "disk full" });
  }
  if (url.indexOf("/settings") >= 0 && String(init && init.method).toUpperCase() === "POST") {
    // 像真宿主一样把 patch 回显回来（宿主是权威）：persistPatch 成功分支会用回包
    // 重画界面，若这里写死 alertMode/enabled，就会把「点完即存」的结果又盖回去。
    let sent = {};
    try {
      sent = JSON.parse(String(init && init.body) || "{}");
    } catch {
      sent = {};
    }
    // 真宿主（index.js）返回的是**自己当前的完整状态**，patch 里没点名的字段不会
    // 被重置。mock 也必须这样：维护一份宿主态，否则任何 {sfxByKind:…} patch 都会
    // 把 cache.alertMode 静默打回 "voice"（假缺陷，且掩盖真缺陷）。
    mockHostState.enabled = typeof sent.enabled === "boolean" ? sent.enabled : mockHostState.enabled;
    mockHostState.alertMode = sent.alertMode || mockHostState.alertMode;
    mockHostState.sfxByKind = Object.assign({}, mockHostState.sfxByKind, sent.sfxByKind || {});
    // 关键：mock 必须像真宿主一样**先校验再接受**（真宿主走 normalizeEditablePatch）。
    // 旧写法把 sent.prosody 全量吞下，等于假装越界值也被接受，会掩盖「填 9 看着保存成功
    // 其实没生效」这类缺陷（审查 R7）。
    const acceptedPatch = normalizeEditablePatch(sent);
    mockHostState.prosody = Object.assign({}, mockHostState.prosody, acceptedPatch.prosody || {});
    return respond(200, {
      ok: true,
      enabled: mockHostState.enabled,
      alertMode: mockHostState.alertMode,
      sfxByKind: Object.assign({}, mockHostState.sfxByKind),
      texts: { complete: "c", fail: "f", approval: "a" },
      prosody: Object.assign({}, mockHostState.prosody),
      speaker: "S_TESTCLONE001",
      voiceNote: "备注X",
      apiKeyPresent: true,
      apiKeyMask: "TESTKEY0…",
      persisted: { ok: true, skipped: false },
      applied: { texts: {}, prosody: Object.assign({}, acceptedPatch.prosody || {}), tts: { apiKey: "X" }, voiceNote: "备注X" },
    });
  }
  if (url.indexOf("/settings") >= 0) {
    return respond(200, {
      ok: true,
      texts: { complete: "完成文案", fail: "失败文案", approval: "审批文案" },
      prosody: { speed_ratio: 1.05, pitch_ratio: 1.04, volume_ratio: 1 },
      speaker: "S_TESTCLONE001",
      voiceNote: "测试音色 · 示例备注",
      apiKeyPresent: true,
      apiKeyMask: "TESTKEY0…",
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
// 2026-10-25 第十三轮：三条行是「一张卡、两种形态」（语音 = 输入框，音效 = 下拉）。
// 本节（2p）测的是输入框路径，所以在挂载前把 client cache 的 alertMode 定为 voice
// —— 否则 cache 默认 "sfx"，dva-text-* 根本不渲染，后面所有 value 断言全炸。
// （下拉形态由 9j / 10c 的源码断言覆盖。）
if (clientExports.__dvaTest && clientExports.__dvaTest.cache) clientExports.__dvaTest.cache.alertMode = "voice";
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
    // 保留 React 事件回调，供第 16 节直接调用（模拟用户点击 / 勾选）。
    // 只增加这一个字段，不影响任何既有断言。
    node.__props = props;
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
    domNodes.get("dva-voice-note").value === "测试音色 · 示例备注" &&
    domNodes.get("dva-speed_ratio").value === "1.05",
  JSON.stringify({ complete: domNodes.get("dva-text-complete").value, note: domNodes.get("dva-voice-note").value, speed: domNodes.get("dva-speed_ratio").value }),
);
check("key state shows a mask, not the key", domNodes.get("dva-key-state").textContent.indexOf("TESTKEY0…") >= 0, domNodes.get("dva-key-state").textContent);
check("local-only key note rendered from the host payload", domNodes.get("dva-key-note").textContent === "KEY-NOTE", domNodes.get("dva-key-note").textContent);
check("system volume is displayed read-only", domNodes.get("dva-volume").textContent.indexOf("54%") >= 0, domNodes.get("dva-volume").textContent);
check("generate is enabled once the key is known present", domNodes.get("dva-generate").disabled === false, String(domNodes.get("dva-generate").disabled));

domNodes.get("dva-tts-key").value = "NEWKEY-42";
const postedBefore = clientFetchCalls.length;
await clientExports.__dvaTest.saveSettings();
const posted = JSON.parse(clientFetchCalls[clientFetchCalls.length - 1].init.body);
check("save posts texts + prosody + voiceNote + the new key", Boolean(posted.tts) && posted.tts.apiKey === "NEWKEY-42" && posted.voiceNote === "测试音色 · 示例备注", JSON.stringify(posted));
check("save acknowledged into config.json", String((domNodes.get("dva-status-text") || domNodes.get("dva-status") || { textContent: "" }).textContent).indexOf("已写入 config.json") >= 0, String((domNodes.get("dva-status-text") || domNodes.get("dva-status") || { textContent: "" }).textContent));
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
check("acceptance message lists changed + reused kinds", String((domNodes.get("dva-status-text") || domNodes.get("dva-status") || { textContent: "" }).textContent).indexOf("本次需合成") >= 0, String((domNodes.get("dva-status-text") || domNodes.get("dva-status") || { textContent: "" }).textContent));
clientExports.__dvaTest.cache.busy = false;
clientFetchMode = "nothing-changed";
await clientExports.__dvaTest.generateAll();
check("nothing-changed is surfaced instead of regenerating", String((domNodes.get("dva-status-text") || domNodes.get("dva-status") || { textContent: "" }).textContent).indexOf("没有需要重新合成的改动") >= 0, String((domNodes.get("dva-status-text") || domNodes.get("dva-status") || { textContent: "" }).textContent));
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

// 提醒方式「关闭」时，音效试听也必须不出声（与 /preview 同一口径）。
// 漏掉这条，「关闭」就只关掉了自动播报，用户手动点试听照样会响。
{
  const offSfx = mount({ alertMode: "off", fallbackBeep: false }, { tmpDir, webServer: true });
  const offPlayRoute = offSfx.ctx._routes.find((route) => route.path === "/dsh-voice-alert/sfx/play");
  const offRes = fakeRes();
  await offPlayRoute.handler(fakeReq("/dsh-voice-alert/sfx/play?name=remind-crisp"), offRes);
  const offBody = JSON.parse(offRes.body);
  check(
    "提醒方式关闭时 /sfx/play 不出声（reason=alertMode=off）",
    offRes.status === 200 && offBody.ok === false && offBody.reason === "alertMode=off",
    offRes.body,
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
// 2026-10-25 第十三轮：音效面板已并入「播报内容」卡的三条行（一张卡、两种形态：
// 语音 = 输入框，音效 = 下拉）。本节在 2p 已把 cache.alertMode 定为 voice，
// 所以这里渲染的是输入框形态；下拉形态用源码断言（见下一条）。
check(
  "sfx panel is merged into the three text rows (no standalone panel node)",
  !domNodes.get("dva-sfx-panel"),
  "",
);
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
// 2026-10 用户要求说明文字改悬浮展示：这句从「常驻橙字」变成「🔈 图标 + 气泡」。
// 假 DOM 里 dva-audio-tip 只有图标字符，所以改从源码断言「话还在，且被 tip() 包着」。
check(
  "「没声音就调一下系统音量」提示仍在（已改为悬浮气泡，内容不丢）",
  /tip\("试听没声音？先把系统音量拖一下再点/u.test(clientSource),
  "",
);

section("10c. 音效选择（隐藏载体 + 保存取值；下拉渲染见 9j 源码断言）");
const sfxUi = clientExports.__dvaTest;
sfxUi.applySfxSelection();
// 2p 挂载时 alertMode=voice，所以这里渲染的是输入框形态；音效选择的下拉
// 由 9j 的源码断言覆盖。本节只验「保存读的那三个隐藏载体」与「点完即存」。
check(
  "default selection lands in the hidden carriers",
  String(domNodes.get("dva-sfx-complete").value) === "remind-tada" &&
    String(domNodes.get("dva-sfx-fail").value) === "remind-muyu",
  JSON.stringify({ complete: domNodes.get("dva-sfx-complete").value, fail: domNodes.get("dva-sfx-fail").value }),
);
sfxUi.setSfxFor("complete", "nature-bird");
check(
  "picking another effect updates the carrier (save reads it)",
  String(domNodes.get("dva-sfx-complete").value) === "nature-bird",
  String(domNodes.get("dva-sfx-complete").value),
);
// 点完即存：换音效必须立刻发 POST（旧版只改界面、要用户再点保存）。
check(
  "换音效立刻发 POST（不再要求用户点保存）",
  clientFetchCalls.some((call) => {
    if (call.url.indexOf("/settings") < 0) return false;
    try {
      const body = JSON.parse(call.init.body);
      return body.sfxByKind && body.sfxByKind.complete === "nature-bird";
    } catch {
      return false;
    }
  }),
  JSON.stringify(clientFetchCalls.filter((c) => c.url.indexOf("/settings") >= 0).map((c) => c.init.body)),
);
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
// 这一段会命中真实的 /preview 与 /sfx/play 路由，而路由内部走的是**真实 playSfx**
// （不是 mount 的 deps.play stub），所以它会真的出声：preview 播完整语音、sfx/play 播音效。
// 因此整段必须放在 skipSound 守卫内 —— 否则 `--no-sound` 名不副实，跑一次自检就会在
// 用户机器上放出语音和音效（2026-09-17 实测：跑自检时用户听到鸟叫 natures-bird 6.44s）。
if (skipSound) {
  console.log("  SKIP  (--no-sound：这一段会真播放 preview 语音与 sfx 音效)");
} else {
  const serialRouted = mount({ pythonPath: "C:\\nope\\python.exe", fallbackBeep: false }, { tmpDir, webServer: true });
  const serialPreview = serialRouted.ctx._routes.find((route) => route.path === "/dsh-voice-alert/preview");
  const serialPreviewRes = fakeRes();
  await serialPreview.handler(fakeReq("/dsh-voice-alert/preview?kind=complete"), serialPreviewRes);
  check("preview route answers after serialization", serialPreviewRes.status === 200, String(serialPreviewRes.body));
  const serialSfx = serialRouted.ctx._routes.find((route) => route.path === "/dsh-voice-alert/sfx/play");
  const serialSfxRes = fakeRes();
  await serialSfx.handler(fakeReq("/dsh-voice-alert/sfx/play?name=nature-bird"), serialSfxRes);
  check("sfx play route answers after serialization", serialSfxRes.status === 200, String(serialSfxRes.body));
  await sleep(7000); // 等这两条真播放结束，别和后续测试叠音
}

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
    // 不写死本机路径：统一走 resolvePython 解析出的真实解释器（跳过 WindowsApps 存根）。
    resolvePython(sfxCfg).path,
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
  "转换成功且产物非空（本机 ffmpeg 精简构建时按环境跳过）",
check("二次调用命中缓存（不重复转换）", ensureWavCache(wavSource, wavCfg, { log: () => {} }).converted === false, "");
check(
  "wav 播放器脚本语法 OK",
  spawnSync(resolvePython(sfxCfg).path, ["-m", "py_compile", join(import.meta.dirname, "..", "lib", "play_wav_out.py")]).status === 0,
  "",
);

section("12d. 真实 wav 播放（仅完整模式）");
if (skipSound) {
  console.log("  SKIP  (--no-sound)");
} else {
  const wavLog = join(tmpDir, "wav-player.log");
  const runWav = spawnSync(
    resolvePython(sfxCfg).path,
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

// ------------------------------------------ 14. 主题自适应（浅色背景可读性）

section("14. 主题自适应：配色走宿主设计令牌，浅色背景不再白字白底");
// 真实 bug（2026-10-10 用户反馈）：v0.3.2~v0.4.8 的界面把 1 深色主题的颜色
// **写死**在源码里 —— 正文 rgba(255,255,255,.xx) 白字、标题 #e6edf3、
// 次要文字 #8b93a8、容器底 rgba(255,255,255,.xx) 半透明白 + rgba(0,0,0,.28) 深底。
// 深色背景下正常；**浅色背景下白字落在白底上 = 完全看不见**。
// 修法：改用宿主的 --dsw-alias-* 设计令牌（主题服务在浅/深两套调色板上重绑，
// 深色经 body[data-ds-dark-theme] 切换），令牌随主题自动反转。
//
// 本节把这次踩过的坑固化成回归断言，防止以后有人再写死深色专用色。
const DARK_ONLY_COLORS = [
  "#e6edf3", // GitHub 深色主题的正文白
  "#8b93a8", // 深色主题的次要文字灰
  "#c9d1d9", // 深色主题的字面量灰
  "#5b6472", // 深色主题的弱化灰
  "#7ee787", // 深色主题的成功绿
  "#f85149", // 深色主题的危险红
  "#58a6ff", // 深色主题的链接蓝
  "#e3b341", // 深色主题的警告黄
  "#c9a86a", // 深色主题的徽标金
  "#6aa8c9", // 深色主题的徽标蓝
  "#0b0e14", // 深色主题的徽标前景深色
];
// 只扫非注释行，避免把解释性注释当成违规。
const clientCodeLines = clientSource
  .split(/\r?\n/u)
  .filter((line) => !/^\s*\/\//u.test(line));
const codeText = clientCodeLines.join("\n");
for (const bad of DARK_ONLY_COLORS) {
  check(
    "代码里不再写死深色主题专用色 " + bad,
    codeText.toLowerCase().indexOf(bad) < 0,
    codeText.toLowerCase().indexOf(bad) >= 0 ? "found in code" : "",
  );
}
// 白字 / 黑底的写死写法：深色装置色，浅色背景下会直接看不见。
check(
  "不再写死白字 rgba(255,255,255,…)",
  !/rgba\(255,\s*255,\s*255/u.test(codeText),
  /rgba\(255,\s*255,\s*255/u.test(codeText) ? "found rgba(255,255,255)" : "",
);
check(
  "不再写死深色底 rgba(0,0,0,…)",
  !/rgba\(0,\s*0,\s*0/u.test(codeText),
  /rgba\(0,\s*0,\s*0/u.test(codeText) ? "found rgba(0,0,0)" : "",
);
// 正面断言：确实引用了宿主的主题令牌（否则上面可能只是"把颜色全删了"）。
check(
  "引用了宿主主题令牌 --dsw-alias-*（配色随主题反转）",
  (codeText.match(/--dsw-alias-/gu) || []).length >= 10,
  String((codeText.match(/--dsw-alias-/gu) || []).length),
);
// 令牌都带 var() 兜底值：万一宿主令牌缺失，也要退回可读的灰阶，而不是白底白字。
const tokenBlockMatch = codeText.match(/var TOKEN = \{([\s\S]*?)\n {4}\};/u);
check("TOKEN 配色表存在", Boolean(tokenBlockMatch), tokenBlockMatch ? "" : "TOKEN table not found");
if (tokenBlockMatch) {
  const tokenBody = tokenBlockMatch[1];
  const decls = tokenBody.split("\n").filter((line) => /var\(/u.test(line));
  const withFallback = decls.filter((line) => /var\([^)]*,\s*[^)]+\)/u.test(line));
  check(
    "TOKEN 每项都带 var() 兜底色（宿主令牌缺失时仍可读）",
    decls.length > 0 && withFallback.length === decls.length,
    "decls=" + decls.length + " withFallback=" + withFallback.length,
  );
}
// 渲染出来的节点必须真的用上令牌（不能只在表里定义、DOM 里还是旧色）。
const themedNodes = [
  ["dva-status", domNodes.get("dva-status")],
  ["dva-clone-link", domNodes.get("dva-clone-link")],
];
for (const [id, node] of themedNodes) {
  check(
    "DOM 节点 " + id + " 的颜色走的是主题令牌",
    Boolean(node) && String(node.style.color).indexOf("--dsw-alias-") >= 0,
    node ? String(node.style.color) : "missing node",
  );
}
check(
  "主按钮底色走的是主题令牌",
  String(domNodes.get("dva-generate").style.background).indexOf("--dsw-alias-brand-primary") >= 0,
  String(domNodes.get("dva-generate").style.background),
);
check(
  "输入框底色走的是主题令牌",
  String(domNodes.get("dva-text-complete").style.background).indexOf("--dsw-alias-") >= 0,
  String(domNodes.get("dva-text-complete").style.background),
);

// ------------------------------------------ 15. 窄面板不横向溢出（用户反馈 2026-10-10）

section("15. 布局：窄面板下不横向溢出卡片");
// 真实 bug（用户截图反馈）：语速/音调/音量 那一行的第三个输入框**跑到卡片外面**。
// 根因是这一行的 flex 项都带 min-width（标签 60px + 输入框 88px），
// 最小宽度 = 3*60 + 3*88 + 5*10 = 494px；设置面板比这窄时，因为 min-width
// 锁死了收缩，整行就溢出卡片右边缘。
// 修法：整行允许 flexWrap + 收窄 min-width + 输入框 box-sizing。
//
// 本节把这条坑固化成回归断言，防止以后有人再把 min-width 写死成大值。
const LAYOUT_SOURCE = clientSource;
// 15a. 所有"行"必须允许换行（除少数刻意不换行的），否则窄面板必溢出。
const wrapCount = (LAYOUT_SOURCE.match(/flexWrap: "wrap"/gu) || []).length;
check("存在可换行的行样式（flexWrap: wrap）", wrapCount >= 5, "count=" + wrapCount);

// 15b. 不得再出现把宽度锁死的 min-width 大值（>= 100px 视为锁死）。
//     允许：0 / em 相对单位 / 小于 100px 的控件最小宽度。
const hardMinWidths = [...LAYOUT_SOURCE.matchAll(/minWidth:\s*"(\d+)px"/gu)].map((m) => Number(m[1]));
const locked = hardMinWidths.filter((v) => v >= 100);
check(
  "不再有把宽度锁死的 minWidth >= 100px",
  locked.length === 0,
  "found=" + JSON.stringify(locked) + " all=" + JSON.stringify(hardMinWidths),
);

// 15c. prosody 行（语速/音调/音量）三只输入框必须都是可收缩的。
for (const id of ["dva-speed_ratio", "dva-pitch_ratio", "dva-volume_ratio"]) {
  const node = domNodes.get(id);
  const flex = node ? String(node.style.flex) : "";
  // flex: "0 1 84px" 收缩因子为 1 -> 可缩；若为 "0 0 88px" 则收缩因子 0 -> 锁死溢出
  const parts = flex.trim().split(/\s+/u);
  const shrink = parts.length >= 2 ? parts[1] : "1";
  check(
    "数字框 " + id + " 可收缩（flex-shrink != 0）",
    Boolean(node) && shrink !== "0",
    "flex=" + flex,
  );
  check(
    "数字框 " + id + " 用 border-box（内边距不撑破容器）",
    Boolean(node) && String(node.style.boxSizing) === "border-box",
    node ? String(node.style.boxSizing) : "missing",
  );
}

// 15d. 主文本输入框也必须可收缩（原来 minWidth:200px 同样是锁死）。
const textNode = domNodes.get("dva-text-complete");
check(
  "文本输入框可收缩且 minWidth 归零",
  Boolean(textNode) && String(textNode.style.minWidth) === "0",
  textNode ? "minWidth=" + textNode.style.minWidth + " flex=" + textNode.style.flex : "missing",
);

// 15e. 卡片与根容器都带 minWidth:0（父级 flex 不按内容最小宽度撑开）。
check(
  "卡片容器带 minWidth:0（可被压缩）",
  /cardStyle = \{[\s\S]*?minWidth:\s*"0"/u.test(LAYOUT_SOURCE),
  "",
);

// ---------------------------------------------------------------- summary

section("16a. 总开关：勾一下就落盘（不需要再按保存）");
const enabledNode = domNodes.get("dva-enabled");
check(
  "总开关是受控复选框且带 onChange（缺 onChange 会被 React 立刻回写 → 点不动）",
  Boolean(enabledNode) && enabledNode.__props.checked !== undefined && typeof enabledNode.__props.onChange === "function",
  enabledNode ? JSON.stringify({ hasOnChange: typeof enabledNode.__props.onChange }) : "missing",
);
const beforeToggle = clientFetchCalls.length;
enabledNode.checked = false;
enabledNode.__props.onChange({ target: { checked: false } });
await sleep(40);
const toggleCall = clientFetchCalls
  .slice(beforeToggle)
  .find((call) => call.url.indexOf("/settings") >= 0 && String(call.init && call.init.method).toUpperCase() === "POST");
check(
  "取消勾选立刻 POST enabled=false",
  Boolean(toggleCall) && JSON.parse(toggleCall.init.body).enabled === false,
  toggleCall ? toggleCall.init.body : "no POST",
);
check(
  "这次 POST 只带 enabled（不把界面上未保存的文案/Key 顺带写进去）",
  Boolean(toggleCall) && Object.keys(JSON.parse(toggleCall.init.body)).join(",") === "enabled",
  toggleCall ? toggleCall.init.body : "no POST",
);
// 反向：再勾回来也要落盘（不能只单方向生效）
const beforeToggle2 = clientFetchCalls.length;
enabledNode.checked = true;
enabledNode.__props.onChange({ target: { checked: true } });
await sleep(40);
const toggleCall2 = clientFetchCalls
  .slice(beforeToggle2)
  .find((call) => call.url.indexOf("/settings") >= 0 && String(call.init && call.init.method).toUpperCase() === "POST");
check(
  "重新勾选立刻 POST enabled=true（两个方向都能开/关）",
  Boolean(toggleCall2) && JSON.parse(toggleCall2.init.body).enabled === true,
  toggleCall2 ? toggleCall2.init.body : "no POST",
);

section("16b. 提醒方式：点「音效」就落盘，宿主不再按旧模式播人声");
const modeSfxBtn = domNodes.get("dva-alert-mode-sfx");
check("提醒方式按钮带 onClick", Boolean(modeSfxBtn) && typeof modeSfxBtn.__props.onClick === "function", "");
const beforeMode = clientFetchCalls.length;
modeSfxBtn.__props.onClick();
await sleep(40);
const modeCall = clientFetchCalls
  .slice(beforeMode)
  .find((call) => call.url.indexOf("/settings") >= 0 && String(call.init && call.init.method).toUpperCase() === "POST");
// 这条是 bug 2 的核心：旧版点「音效」只改本地样式不发 POST，宿主 config.alertMode
// 仍是 voice，回合结束照样合成并播放人声 —— 用户看到按钮亮了，耳朵里还是人。
check(
  "点「音效」立刻 POST alertMode=sfx（否则宿主仍按 voice 播人声）",
  Boolean(modeCall) && JSON.parse(modeCall.init.body).alertMode === "sfx",
  modeCall ? modeCall.init.body : "no POST",
);
// 第十三轮：音效面板已并入「播报内容」卡的三条行（一张卡、两种形态），
// 独立面板节点 #dva-sfx-panel 已删 —— 切到音效后由 React 渲染下拉形态。
check(
  "切到音效后布局统一（独立面板节点已删）",
  !domNodes.get("dva-sfx-panel"),
  "panel node removed",
);
// 语音模式同样要落盘，否则切回语音也失效
const modeVoiceBtn = domNodes.get("dva-alert-mode-voice");
const beforeModeVoice = clientFetchCalls.length;
modeVoiceBtn.__props.onClick();
await sleep(40);
const modeVoiceCall = clientFetchCalls
  .slice(beforeModeVoice)
  .find((call) => call.url.indexOf("/settings") >= 0 && String(call.init && call.init.method).toUpperCase() === "POST");
check(
  "点「语音」立刻 POST alertMode=voice",
  Boolean(modeVoiceCall) && JSON.parse(modeVoiceCall.init.body).alertMode === "voice",
  modeVoiceCall ? modeVoiceCall.init.body : "no POST",
);

section("16c. 音量 0 = 静音（可填、可存、可读回、真的一动不动）");
check("音量输入框 min=0（浏览器不再拦住 0）", String(domNodes.get("dva-volume_ratio").__props.min) === "0", String(domNodes.get("dva-volume_ratio").__props.min));
check("语速/音调下限仍是 0.2（0 对 TTS 无意义）", prosodyMinFor("speed_ratio") === 0.2 && prosodyMinFor("pitch_ratio") === 0.2, JSON.stringify([prosodyMinFor("speed_ratio"), prosodyMinFor("pitch_ratio")]));
check("音量下限是 0", prosodyMinFor("volume_ratio") === 0, String(prosodyMinFor("volume_ratio")));
// 宿主白名单：旧版统一写死 0.2，用户填 0 被静默丢弃 —— 这就是「0 设不了」的根因。
const zeroPatch = normalizeEditablePatch({ prosody: { volume_ratio: 0 } });
check("patch 里的 volume_ratio:0 被接受（不再被 0.2 下限丢掉）", zeroPatch.prosody.volume_ratio === 0, JSON.stringify(zeroPatch.prosody));
check("越界值仍然被拦（-1 / 5 不接受）", normalizeEditablePatch({ prosody: { volume_ratio: -1 } }).prosody.volume_ratio === undefined && normalizeEditablePatch({ prosody: { volume_ratio: 5 } }).prosody.volume_ratio === undefined, "");
// config.json 往返：手写 0 必须原样读回，不能被 resolveConfig 抬成 0.2。
const zeroDir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-zero-"));
const zeroFile = join(zeroDir, "config.json");
writeFileSync(zeroFile, JSON.stringify({ prosody: { volume_ratio: 0 } }), "utf8");
const zeroResolved = resolveConfig(undefined, { configPath: zeroFile });
check("config.json 里手写的 0 读回来还是 0", zeroResolved.prosody.volume_ratio === 0, String(zeroResolved.prosody.volume_ratio));
check("mutedByVolume 认定 0 = 静音", mutedByVolume(zeroResolved) === true, "");
check("非 0 不算静音（1 / 0.01）", mutedByVolume({ prosody: { volume_ratio: 1 } }) === false && mutedByVolume({ prosody: { volume_ratio: 0.01 } }) === false, "");
check("缺字段不算静音（旧配置不会突然变哑）", mutedByVolume({}) === false && mutedByVolume({ prosody: {} }) === false, "");
// null / 空白串同样不是静音：Number(null) 与 Number("") 都是 0，若不特判，
// config.json 里手写的 volume_ratio: null 会被读成 0 → 用户没设静音却一声不响。
check(
  "null / 空白串不算静音（Number(null)===0 的坑）",
  mutedByVolume({ prosody: { volume_ratio: null } }) === false &&
    mutedByVolume({ prosody: { volume_ratio: "" } }) === false &&
    mutedByVolume({ prosody: { volume_ratio: "   " } }) === false &&
    mutedByVolume({ prosody: { volume_ratio: undefined } }) === false,
  "",
);
// 读盘侧：手写 null 不能变成 0
const nullFile = join(zeroDir, "config-null.json");
writeFileSync(nullFile, JSON.stringify({ prosody: { volume_ratio: null } }), "utf8");
const nullResolved = resolveConfig(undefined, { configPath: nullFile });
check(
  "config.json 里手写的 null 不会被读成 0（不静音）",
  nullResolved.prosody.volume_ratio !== 0 && mutedByVolume(nullResolved) === false,
  String(nullResolved.prosody.volume_ratio),
);
// 提交侧：null 必须被当作「没提交」跳过，而不是写成 0
const nullPatch = normalizeEditablePatch({ prosody: { volume_ratio: null } });
check(
  "提交 null 不会被当成 0（不写进 patch）",
  nullPatch.prosody && nullPatch.prosody.volume_ratio === undefined,
  JSON.stringify(nullPatch.prosody),
);
// 界面保存：填 0 必须原样提交
domNodes.get("dva-volume_ratio").value = "0";
const beforeVolSave = clientFetchCalls.length;
await clientExports.__dvaTest.saveSettings();
const volSaveCall = clientFetchCalls.slice(beforeVolSave).find((call) => call.url.indexOf("/settings") >= 0);
check("点保存把 volume_ratio:0 原样提交", Boolean(volSaveCall) && JSON.parse(volSaveCall.init.body).prosody.volume_ratio === 0, volSaveCall ? volSaveCall.init.body : "no POST");
// 空框 ≠ 0：清空输入框后保存必须是「不改」，不能被当成静音。
// 注意「不改」= 退回上一次已知值，所以这里先把已知值设成一个非 0 的数（1.5），
// 才能分辨「退回 1.5」和「误当成 0」。若沿用上一步刚保存的 0，两者无法区分。
clientExports.__dvaTest.cache.prosody.volume_ratio = 1.5;
domNodes.get("dva-volume_ratio").value = "";
const beforeVolEmpty = clientFetchCalls.length;
await clientExports.__dvaTest.saveSettings();
const volEmptyCall = clientFetchCalls.slice(beforeVolEmpty).find((call) => call.url.indexOf("/settings") >= 0);
check(
  "空框退回上次值（Number(\"\")===0 的坑：空框不能变静音）",
  Boolean(volEmptyCall) && JSON.parse(volEmptyCall.init.body).prosody.volume_ratio === 1.5,
  volEmptyCall ? volEmptyCall.init.body : "no POST",
);
// 越界值被宿主静默丢弃时，界面必须点名（审查 R7）：否则「填 9 → 保存成功 →
// 仍是旧值」，用户看到的是「已保存」三个字，和静音那个 bug 同一类自嗨。
domNodes.get("dva-volume_ratio").value = "9";
const beforeVolReject = clientFetchCalls.length;
await clientExports.__dvaTest.saveSettings();
const volRejectCall = clientFetchCalls.slice(beforeVolReject).find((call) => call.url.indexOf("/settings") >= 0);
check(
  "越界音量仍照原样提交（由宿主裁决，不在前端偷偷改）",
  Boolean(volRejectCall) && JSON.parse(volRejectCall.init.body).prosody.volume_ratio === 9,
  volRejectCall ? volRejectCall.init.body : "no POST",
);
const volRejectText = String(domNodes.get("dva-status").textContent);
check(
  "越界音量保存后状态行点名「未生效：音量 9」",
  volRejectText.indexOf("未生效") >= 0 && volRejectText.indexOf("音量") >= 0,
  volRejectText,
);
// 反向断言：合法值不许出现「未生效」，否则提示会变成狼来了
domNodes.get("dva-volume_ratio").value = "1.5";
const beforeVolOk = clientFetchCalls.length;
await clientExports.__dvaTest.saveSettings();
const volOkText = String(domNodes.get("dva-status").textContent);
check(
  "合法音量保存后不出现「未生效」提示",
  clientFetchCalls.length > beforeVolOk && volOkText.indexOf("未生效") < 0,
  volOkText,
);

section("16d. 宿主闸门：音量 0 对语音和音效一视同仁地哑");
const mutedVoiceMode = mount({ alertMode: "voice", prosody: { volume_ratio: 0 } }, { tmpDir });
const mvSession = rootSession("session-muted-voice");
mutedVoiceMode.ctx.emit("session/event", mvSession, sessionEvent("turn/start", { turn: 1 }));
mutedVoiceMode.ctx.emit("session/event", mvSession, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
mutedVoiceMode.ctx.emit("tools/result", toolExec(mvSession, "tool_boom"), { isError: true });
check("语音模式 + 音量 0 -> 一声不响（连 TTS 都不合成）", mutedVoiceMode.calls.length === 0, JSON.stringify(mutedVoiceMode.calls));

const mutedSfxMode = mount({ alertMode: "sfx", prosody: { volume_ratio: 0 } }, { tmpDir });
const msSession = rootSession("session-muted-sfx");
mutedSfxMode.ctx.emit("session/event", msSession, sessionEvent("turn/start", { turn: 1 }));
mutedSfxMode.ctx.emit("session/event", msSession, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
check("音效模式 + 音量 0 -> 一声不响", mutedSfxMode.calls.length === 0, JSON.stringify(mutedSfxMode.calls));

// 音量 1 照常出声（别把静音做成「永远静音」）
const loudMode = mount({ alertMode: "sfx", prosody: { volume_ratio: 1 } }, { tmpDir });
const ldSession = rootSession("session-loud-sfx");
loudMode.ctx.emit("session/event", ldSession, sessionEvent("turn/start", { turn: 1 }));
loudMode.ctx.emit("session/event", ldSession, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
check("音量 1 -> 正常出声", loudMode.calls.length === 1, JSON.stringify(loudMode.calls));

section("16e. 音效模式走的是音效，绝不合成人声");
const pureSfxMode = mount({ alertMode: "sfx" }, { tmpDir });
const psSession = rootSession("session-pure-sfx");
pureSfxMode.ctx.emit("session/event", psSession, sessionEvent("turn/start", { turn: 1 }));
pureSfxMode.ctx.emit("session/event", psSession, sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }));
const pureSfxCall = pureSfxMode.calls[0] || {};
check(
  "回合结束在音效模式下只走 sfx（mode=sfx + 有 sfxKey + 无 ttsKind）",
  pureSfxCall.extra &&
    pureSfxCall.extra.mode === "sfx" &&
    String(pureSfxCall.extra.sfxKey || "").length > 0 &&
    pureSfxCall.extra.ttsKind === undefined,
  JSON.stringify(pureSfxCall.extra || null),
);

// ---------------------------------------------------------------- 16f. 同类坑排查

section("16f. 同类坑：音效选择也点完即存 / 失败要回滚 / 蜂鸣也受静音闸门");

// (1) 换音效发的 POST 必须是「最小 patch」——只带 sfxByKind 一个键，不能顺手把整份
//     config 回写（那会用界面上可能过期的其它字段覆盖用户磁盘上的真实设置）。
//     注意 saveSettings 也会带 sfxByKind（隐藏载体），所以这里按「只有 sfxByKind
//     这一个键」来认 setSfxFor 那一次。至于「确实发了 POST」已在 §10c 就近断言。
{
  const minimal = clientFetchCalls
    .filter((call) => call.url.indexOf("/settings") >= 0)
    .map((call) => {
      try {
        return JSON.parse(call.init.body);
      } catch {
        return {};
      }
    })
    .filter((body) => body.sfxByKind && Object.keys(body).length === 1);
  check(
    "换音效只提交 sfxByKind 最小 patch（不整体回写 config）",
    minimal.some((body) => body.sfxByKind.complete === "nature-bird"),
    JSON.stringify(minimal),
  );
}

// (2) persistPatch 失败必须把界面回滚到宿主仍持有的旧值 —— 否则用户看到
//     「已关闭」而宿主还在播报，状态漂移比报错更难排查（审查发现的 R2）。
//
//     关键：必须走**真实入口**（onChange / onClick），不能直接调 persistPatch。
//     三个调用方都是「先改 cache 再落盘」，直接调就绕过了这次预改，断言会退化成
//     恒等式（删掉 rollback 也照样通过 —— 2026-10 审查实测证明过）。
{
  const ui = clientExports.__dvaTest;
  const box = domNodes.get("dva-enabled");
  const beforeEnabled = box.checked;
  const beforeCacheEnabled = ui.cache.enabled;
  // 让下一次 /settings 请求直接失败（网络层 reject）
  clientFailNextSettings = true;
  box.checked = !beforeEnabled;
  box.__props.onChange({ target: { checked: !beforeEnabled } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  clientFailNextSettings = false;
  check(
    "保存失败时总开关的界面回滚到原值（不与宿主漂移）",
    box.checked === beforeEnabled,
    JSON.stringify({ before: beforeEnabled, after: box.checked }),
  );
  check(
    "保存失败时 cache.enabled 也回滚（界面自嗨的另一半）",
    ui.cache.enabled === beforeCacheEnabled,
    JSON.stringify({ before: beforeCacheEnabled, after: ui.cache.enabled }),
  );
  check("保存失败时状态行是红字报错", String(domNodes.get("dva-status").textContent).indexOf("保存失败") >= 0, String(domNodes.get("dva-status").textContent));
}

// (2b) 提醒方式按钮失败也要回滚（同一根因，三个调用方都要覆盖）
{
  const ui = clientExports.__dvaTest;
  const beforeMode = ui.cache.alertMode;
  const otherMode = beforeMode === "sfx" ? "off" : "sfx";
  const btn = domNodes.get("dva-alert-mode-" + otherMode);
  clientFailNextSettings = true;
  btn.__props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  clientFailNextSettings = false;
  check(
    "提醒方式保存失败时 cache.alertMode 回滚到原值",
    ui.cache.alertMode === beforeMode,
    JSON.stringify({ before: beforeMode, after: ui.cache.alertMode }),
  );
}

// (2c) 音效勾选失败也要回滚（第三个调用方）
{
  const ui = clientExports.__dvaTest;
  const beforeKind = String((ui.cache.sfxByKind || {}).complete || "");
  const otherKey = beforeKind === "nature-bird" ? "remind-tada" : "nature-bird";
  clientFailNextSettings = true;
  ui.setSfxFor("complete", otherKey);
  await new Promise((resolve) => setTimeout(resolve, 20));
  clientFailNextSettings = false;
  check(
    "音效勾选保存失败时 cache.sfxByKind 回滚到原值",
    String((ui.cache.sfxByKind || {}).complete || "") === beforeKind,
    JSON.stringify({ before: beforeKind, after: (ui.cache.sfxByKind || {}).complete }),
  );
}

// (2d) HTTP 非 200（不是网络异常）也必须回滚 —— 这是 persistPatch 的另一个分支。
{
  const ui = clientExports.__dvaTest;
  const box = domNodes.get("dva-enabled");
  const beforeEnabled = box.checked;
  const beforeCache = ui.cache.enabled;
  clientFailNextSettingsStatus = 500;
  box.checked = !beforeEnabled;
  box.__props.onChange({ target: { checked: !beforeEnabled } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  clientFailNextSettingsStatus = 0;
  check(
    "HTTP 500 时总开关同样回滚（不只网络异常才回滚）",
    box.checked === beforeEnabled && ui.cache.enabled === beforeCache,
    JSON.stringify({ before: beforeEnabled, after: box.checked, cache: ui.cache.enabled }),
  );
  check(
    "HTTP 500 时状态行带上宿主给的原因",
    String(domNodes.get("dva-status").textContent).indexOf("disk full") >= 0,
    String(domNodes.get("dva-status").textContent),
  );
}

// (2e) 静音提示（dva-mute-note）必须跟着回滚一起复原 —— 否则「🔕 静音」
//      会和真实状态脱节（首轮审查 R10 遗留项）。
{
  const ui = clientExports.__dvaTest;
  const noteNode = domNodes.get("dva-mute-note");
  check("静音提示节点存在", Boolean(noteNode), noteNode ? "ok" : "missing");
  ui.applyMuteNotice(true);
  const shownText = String(noteNode.textContent);
  ui.applyMuteNotice(false);
  const hiddenText = String(noteNode.textContent);
  check(
    "静音时提示可见、取消静音后提示消失",
    shownText.length > 0 && shownText !== hiddenText,
    JSON.stringify({ shown: shownText, hidden: hiddenText }),
  );
  check("静音提示内容点明「静音」二字", shownText.indexOf("静音") >= 0, shownText);
}

// (3) 蜂鸣降级自己也受静音闸门 —— 不能只依赖调用方 index.js 的前置 return，
//     否则将来新增一条直接调 beepFallback 的路径就会在音量 0 时「叮」一声（R3）。
{
  const mutedCfg = Object.assign({}, nothingConfig, { fallbackBeep: true, prosody: { volume_ratio: 0 } });
  const mutedBeep = playKind("complete", mutedCfg, function () {});
  check(
    "音量 0 时蜂鸣降级也不响（beep=false + muted=true）",
    mutedBeep.beep === false && mutedBeep.muted === true,
    JSON.stringify(mutedBeep),
  );
  const loudCfg = Object.assign({}, nothingConfig, { fallbackBeep: true, prosody: { volume_ratio: 1 } });
  const loudBeep = playKind("complete", loudCfg, function () {});
  check("音量正常时蜂鸣降级照旧可用（未被误伤）", loudBeep.beep === true, JSON.stringify(loudBeep));
}

// (4) 手写负音量不能变成静音：num() 会把 -1 钳到下限 0，而 0 就是静音 ——
//     多打一个负号导致整机一声不响，比「值被拒绝」难排查得多（审查发现的 R6）。
{
  const negFile = join(zeroDir, "config-negative.json");
  writeFileSync(negFile, JSON.stringify({ prosody: { volume_ratio: -1 } }), "utf8");
  const negResolved = resolveConfig(undefined, { configPath: negFile });
  check(
    "手写负音量回退默认值，而不是被钳成 0（静音）",
    negResolved.prosody.volume_ratio !== 0 && mutedByVolume(negResolved) === false,
    String(negResolved.prosody.volume_ratio),
  );
}

// ------------------------------------------ 17. 免费内置音色（edge-tts，无需 Key）

section("17. 免费内置音色：目录 / 判定放行 / 命令行拼装 / 失败分类");
// 用户 2026-10-24 需求（m02835）：「内嵌免费得不需要api得字生语音…安装上直接体验语音提醒」，
// 且（m02930）「这影响我自己得提供得key得音色切换吗」—— 绝不影响。
// 本节把两件事钉住：①免费音色在任何判据里都不需要 Key；②它不改变 key 音色的判据。
{
  check("免费音色目录 7 条（用户要求「这几个都可以保留」）", FREE_VOICES.length === 7, String(FREE_VOICES.length));
  check("每条 id 都以 free: 开头", FREE_VOICES.every(function (v) { return String(v.id).indexOf("free:") === 0; }));
  check("首条是台湾腔甜美（用户点名 HsiaoChen）", FREE_VOICES[0].id === "free:tw-chen", FREE_VOICES[0].id);
  check("每条都带 edgeVoice / pitch / rate", FREE_VOICES.every(function (v) {
    return Boolean(v.edgeVoice) && /^[+-]\d+Hz$/.test(String(v.pitch)) && /^[+-]\d+%$/.test(String(v.rate));
  }));
  check("isFreeVoiceId 认目录内 id", isFreeVoiceId("free:tw-yu") === true);
  check("isFreeVoiceId 认手写合法 edge 名", isFreeVoiceId("free:zh-TW-HsiaoChenNeural") === true);
  check("isFreeVoiceId 拒绝杂串（防注入 python 参数）", isFreeVoiceId("free:../../etc") === false);
  check("freeVoiceView 目录外也能回一个可用视图", (function () {
    const view = freeVoiceView("free:zh-CN-XiaoxiaoNeural");
    return Boolean(view) && view.kind === "free" && view.edgeVoice === "zh-CN-XiaoxiaoNeural";
  })());

  // 隔离配置：configPath:null + env:{} —— 否则会读到用户真实 config.json 里的 Key，
  // 测出来的是配置而不是代码（上一版单元测试就栽在这里）。
  const isoFree = resolveConfig({ selectedVoiceId: "free:tw-chen-cute" }, { configPath: null, env: {} });
  check("选中免费音色时不被顶回 voices[0]", isoFree.selectedVoiceId === "free:tw-chen-cute", isoFree.selectedVoiceId);
  const selFree = resolveVoice(isoFree);
  check("resolveVoice 把免费 id 判为 free（不是 preset）", selFree.kind === "free" && selFree.source === "free", JSON.stringify(selFree));
  check("免费音色在「一个 Key 都没有」时也判可用", voiceKeyErrorCode(isoFree, selFree.voice) === null, String(voiceKeyErrorCode(isoFree, selFree.voice)));

  // key 音色一侧完全不动
  const isoClone = resolveConfig({ voices: [{ id: "S_me", kind: "clone", note: "我的", enabled: true }], selectedVoiceId: "S_me" }, { configPath: null, env: {} });
  check("克隆音色仍然是 clone", resolveVoice(isoClone).kind === "clone");
  check("克隆音色缺 Key 仍然被拒（免费没放水到付费侧）", voiceKeyErrorCode(isoClone, resolveVoice(isoClone).voice) === "api-key-missing");
  const isoPreset = resolveConfig({ voices: [{ id: "V-1", kind: "preset" }], selectedVoiceId: "V-1" }, { configPath: null, env: {} });
  check("预设音色缺 Plan Key 仍然被拒", voiceKeyErrorCode(isoPreset, resolveVoice(isoPreset).voice) === "preset-key-missing");
  const handFree = normalizeVoices([{ id: "free:zh-TW-HsiaoYuNeural", kind: "free", note: "手写", enabled: true }]);
  check("normalizeVoices 把 free 家族整体挡在音色库外（唯一闸门）", handFree && handFree.length === 0, JSON.stringify(handFree));
  check("目录 id 同样被挡（不再「服务端只比 7 条 / 客户端比前缀」两套打架）", (function () {
    const mixed = normalizeVoices(FREE_VOICES.map(function (v) { return { id: v.id, kind: "free" }; }).concat([{ id: "S_ok", kind: "clone" }]));
    return Boolean(mixed) && mixed.length === 1 && mixed[0].id === "S_ok";
  })(), "voices 只留 key 音色");
  check("被挡在库外的 free id 仍然能合成（走 selectedVoiceId，不依赖库）", (function () {
    const stillOk = resolveVoice(isoFree, "free:zh-CN-XiaoxiaoNeural");
    return stillOk.kind === "free" && voiceKeyErrorCode(isoFree, stillOk.voice) === null;
  })());
  check("mergeVoiceImport 也不吃 free（导入粘一行不会变成红色「缺ark-key」）", (function () {
    const merged2 = mergeVoiceImport([{ id: "S_keep", kind: "clone" }], [{ id: "free:zh-CN-XiaoxiaoNeural", kind: "free" }]);
    return merged2.length === 1 && merged2[0].id === "S_keep";
  })(), JSON.stringify(mergeVoiceImport([{ id: "S_keep", kind: "clone" }], [{ id: "free:zh-CN-XiaoxiaoNeural", kind: "free" }])));
  check("isVoicesLibraryId：key 音色放行 / free 家族拒绝", isVoicesLibraryId("S_DEMOCLONE9") === true && isVoicesLibraryId("V-1") === true
    && isVoicesLibraryId("free:tw-chen") === false && isVoicesLibraryId("free:zh-TW-HsiaoChenNeural") === false);
  // NTFS 交替数据流(ADS)泄漏：voice.id 含冒号，直接拼文件名会被解析成
  // "宿主文件:数据流"，rmSync 删掉的是流、留下 0 字节宿主文件（每次合成漏一个）。
  let adsSeen = "";
  {
    const captureSpawn = function (_py, argv) {
      adsSeen = String(argv[argv.indexOf("--write-media") + 1] || "");
      const dataHandlers = [];
      const stream = { setEncoding: function () {}, on: function (ev, fn) { if (ev === "data") dataHandlers.push(fn); } };
      const child = {
        listeners: {},
        stderr: stream,
        stdout: stream,
        on: function (ev, fn) { (child.listeners[ev] = child.listeners[ev] || []).push(fn); },
        kill: function () {},
        fire: function (ev) {
          const a = Array.prototype.slice.call(arguments, 1);
          (child.listeners[ev] || []).forEach(function (fn) { fn.apply(null, a); });
        },
      };
      // 监听器是 executor 同步跑完之后才注册的，所以必须等一个 tick 再收场，
      // 否则这个 await 永远不 resolve，整段自检卡死（写测试时踩过）。
      setTimeout(function () { child.fire("close", 1); }, 0);
      return child;
    };
    await synthesizeEdge({ text: "hi", voice: FREE_VOICES[1], config: isoFree, spawnImpl: captureSpawn });
  }
  const adsBase = adsSeen.split(/[\\/]/).pop();
  check("免费音色临时文件名不含冒号（ADS 泄漏已堵）", adsSeen.length > 0 && adsBase.indexOf(":") < 0, adsSeen);
  check("临时文件名仍带音色标识（出了问题认得出是谁的声音）", /^edge-\d+-free_tw-chen-cute\.mp3$/.test(adsBase), adsBase);

  // 命令行拼装：参数只能是目录里的形状，异常值一律丢弃
  const argsOk = edgeArgsFor("你好", { edgeVoice: "zh-TW-HsiaoChenNeural", pitch: "+25Hz", rate: "+8%" }, "C:/x/o.mp3");
  check("edgeArgsFor 用 -m edge_tts 而非任意脚本", argsOk[0] === "-m" && argsOk[1] === "edge_tts", argsOk.join(" "));
  check("edgeArgsFor 带 --no-progress（避免进度条写脏 stderr）", argsOk.indexOf("--no-progress") >= 0);
  check("edgeArgsFor 正确带出 voice/pitch/rate/输出路径", argsOk[argsOk.indexOf("--voice") + 1] === "zh-TW-HsiaoChenNeural"
    && argsOk[argsOk.indexOf("--pitch") + 1] === "+25Hz"
    && argsOk[argsOk.indexOf("--rate") + 1] === "+8%"
    && argsOk[argsOk.indexOf("--write-media") + 1] === "C:/x/o.mp3");
  const argsBad = edgeArgsFor("你好", { edgeVoice: "V", pitch: "25Hz", rate: "8%" }, "o.mp3");
  check("非 +NHz / +N% 形状的 pitch 被丢弃", argsBad.indexOf("--pitch") < 0, argsBad.join(" "));
  check("非 +N% 形状的 rate 被丢弃", argsBad.indexOf("--rate") < 0);

  // 语速滑块必须对免费音色同样生效（否则同一套 UI 两种行为）
  check("edgeRateFor：语速 1.2 → +20%", edgeRateFor({ rate: "+0%" }, { speed_ratio: 1.2 }) === "+20%", edgeRateFor({ rate: "+0%" }, { speed_ratio: 1.2 }));
  check("edgeRateFor：目录 rate 为基准叠加", edgeRateFor({ rate: "+8%" }, { speed_ratio: 0.5 }) === "-42%", edgeRateFor({ rate: "+8%" }, { speed_ratio: 0.5 }));
  check("edgeRateFor：下限钳位", edgeRateFor({ rate: "+0%" }, { speed_ratio: 0.01 }) === "-90%");
  check("edgeRateFor：上限钳位", edgeRateFor({ rate: "+0%" }, { speed_ratio: 9 }) === "+200%");
  check("edgeRateFor：非法语速忽略而不是崩", edgeRateFor({ rate: "+8%" }, { speed_ratio: "abc" }) === "+8%");

  // 前置闸门：这些路径必须在起进程之前就返回（不能误弹黑框、不能 reject）
  const gated = await synthesizeEdge({ text: "   ", voice: FREE_VOICES[0], config: isoFree, spawnImpl: function () { throw new Error("must not spawn"); } });
  check("空文本 → edge-empty-text（不起进程）", gated.ok === false && gated.reason === "edge-empty-text", JSON.stringify(gated));
  const notFree = await synthesizeEdge({ text: "hi", voice: { id: "S_1", kind: "clone" }, config: isoFree, spawnImpl: function () { throw new Error("must not spawn"); } });
  check("非 free 音色走 edge 口 → edge-not-free", notFree.ok === false && notFree.reason === "edge-not-free", JSON.stringify(notFree));

  // 失败分类（假 child 必须带 stderr/stdout 流，否则测不到真实分类路径）
  function fakeSpawn(prepare) {
    return function () {
      const dataHandlers = [];
      const stream = { setEncoding: function () {}, on: function (ev, fn) { if (ev === "data") dataHandlers.push(fn); } };
      const child = {
        listeners: {}, stderr: stream, stdout: stream,
        on: function (ev, fn) { (child.listeners[ev] = child.listeners[ev] || []).push(fn); },
        kill: function () { child.killed = true; },
        exitCode: null,
        fire: function (ev) { const a = Array.prototype.slice.call(arguments, 1); (child.listeners[ev] || []).forEach(function (fn) { fn.apply(null, a); }); },
        emitData: function (text) { dataHandlers.forEach(function (fn) { fn(text); }); },
      };
      prepare(child);
      return child;
    };
  }
  const modMissing = await synthesizeEdge({
    text: "hi", voice: FREE_VOICES[0], config: isoFree,
    spawnImpl: fakeSpawn(function (c) { setTimeout(function () { c.emitData("No module named 'edge_tts'"); c.fire("close", 1); }, 0); }),
  });
  check("stderr 含 No module named edge_tts → edge-tts-not-installed", modMissing.ok === false && modMissing.reason === "edge-tts-not-installed", JSON.stringify(modMissing));
  const offline = await synthesizeEdge({
    text: "hi", voice: FREE_VOICES[0], config: isoFree,
    spawnImpl: fakeSpawn(function (c) { setTimeout(function () { c.emitData("getaddrinfo failed"); c.fire("close", 1); }, 0); }),
  });
  check("网络类 stderr → edge-offline（文案要告诉用户是网不通）", offline.ok === false && offline.reason === "edge-offline", JSON.stringify(offline));
  const generic = await synthesizeEdge({
    text: "hi", voice: FREE_VOICES[0], config: isoFree,
    spawnImpl: fakeSpawn(function (c) { setTimeout(function () { c.emitData("KeyboardInterrupt"); c.fire("close", 2); }, 0); }),
  });
  check("未知失败 → edge-failed（不谎报成缺模块）", generic.ok === false && generic.reason === "edge-failed", JSON.stringify(generic));
  const noOutput = await synthesizeEdge({
    text: "hi", voice: FREE_VOICES[0], config: isoFree,
    spawnImpl: fakeSpawn(function (c) { setTimeout(function () { c.fire("close", 0); }, 0); }),
  });
  check("退出码 0 但没产出文件 → 判失败（不返回空音频）", noOutput.ok === false, JSON.stringify(noOutput));
  const threw = await synthesizeEdge({ text: "hi", voice: FREE_VOICES[0], config: isoFree, spawnImpl: function () { throw new Error("boom"); } });
  check("spawn 抛异常 → 变成返回值而不是 reject", threw.ok === false && threw.reason === "edge-spawn-failed", JSON.stringify(threw));
  const errEvent = await synthesizeEdge({
    text: "hi", voice: FREE_VOICES[0], config: isoFree,
    spawnImpl: fakeSpawn(function (c) { setTimeout(function () { c.fire("error", new Error("ENOENT")); }, 0); }),
  });
  check("child error 事件被接住（不炸宿主 web server）", errEvent.ok === false, JSON.stringify(errEvent));

  // 可用性探测：只读判据，绝不合成、绝不播放
  const rt = edgeRuntimeStatus(isoFree, { spawnSyncImpl: function () { return { status: 0 }; } });
  check("edgeRuntimeStatus 报告 python+edgeTts 双真", rt.python === true && rt.edgeTts === true, JSON.stringify(rt));
  const rtNo = edgeRuntimeStatus(isoFree, { spawnSyncImpl: function () { return { status: 1 }; } });
  check("import 失败时 edgeTts=false（界面据此提示 pip install）", rtNo.python === true && rtNo.edgeTts === false, JSON.stringify(rtNo));
}

// ------------------------------------------------- 18. v0.4.17 e2e 缺陷回归（D1~D6）

section("18. v0.4.17 端到端复核发现的缺陷已修（当前选择/悬空归位/伪造 free id/指纹音色/探测缓存）");

// 一个能当 POST body 用的假请求：路由里的 readJsonBody 靠 data/end 事件取体。
function postReq(url, bodyValue, remoteAddress) {
  const raw = JSON.stringify(bodyValue);
  const handlers = {};
  return {
    url,
    method: "POST",
    socket: { remoteAddress: remoteAddress || "127.0.0.1" },
    on(event, callback) {
      handlers[event] = callback;
      if (event === "data") setTimeout(function () { callback(Buffer.from(raw, "utf8")); }, 0);
      if (event === "end") setTimeout(function () { callback(); }, 1);
    },
    destroy() {},
  };
}

const d18Dir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-d18-"));
const d18Ctx = mount(
  {
    voices: [
      { id: "S_A", note: "A", kind: "clone", enabled: true },
      { id: "S_B", note: "B", kind: "clone", enabled: true },
    ],
    selectedVoiceId: "S_B",
    tts: { apiKey: "D18-CLONE-KEY", speaker: "S_A" },
  },
  { tmpDir: d18Dir, webServer: true },
);
const saveRoute = d18Ctx.ctx._routes.find((r) => r.path === "/dsh-voice-alert/voices/save");

// D1：当前选择有效时，一个乱串绝不能把它换掉（旧版会顺手归位到 voices[0]）。
{
  const res = fakeRes();
  await saveRoute.handler(postReq("/dsh-voice-alert/voices/save", { selectedVoiceId: "free:../../evil garbage" }), res);
  const payload = JSON.parse(res.body);
  check(
    "D1 乱串被拒绝且**不动**当前选择（旧版会悄悄换成 S_A）",
    res.status === 200 && payload.saved.selectedVoiceId === "S_B",
    JSON.stringify(payload.saved),
  );
  check(
    "D1 拒绝要留日志（用户看得见为什么没生效）",
    d18Ctx.logs.some((line) => String(line).indexOf("ignored unknown selectedVoiceId") >= 0),
    d18Ctx.logs.slice(-3).join(" | "),
  );
}

// 合法 free id 仍然可以直接选中并立即生效（不写进 voices）。
{
  const res = fakeRes();
  await saveRoute.handler(postReq("/dsh-voice-alert/voices/save", { selectedVoiceId: "free:tw-chen" }), res);
  const payload = JSON.parse(res.body);
  check(
    "免费音色可被设为当前（保存返回即生效）",
    payload.saved.selectedVoiceId === "free:tw-chen" && payload.freeVoices.length === 7,
    JSON.stringify({ sel: payload.saved.selectedVoiceId, free: payload.freeVoices.length }),
  );
  check(
    "设成免费音色后 voices 一个字没多（目录不落盘）",
    payload.saved.voices === 2,
    JSON.stringify(payload.saved),
  );
}

// D2：只发 voices、把当前选中的那行删掉 → 选择不能悬空，必须归位到剩下第一个。
{
  const seed = fakeRes();
  await saveRoute.handler(postReq("/dsh-voice-alert/voices/save", { selectedVoiceId: "S_B" }), seed);
  check("D2 前置：先把当前选择设成库里的 S_B", JSON.parse(seed.body).saved.selectedVoiceId === "S_B", seed.body.slice(0, 120));
  const res = fakeRes();
  await saveRoute.handler(postReq("/dsh-voice-alert/voices/save", { voices: [{ id: "S_A", note: "A", kind: "clone", enabled: true }] }), res);
  const payload = JSON.parse(res.body);
  check(
    "D2 删掉当前选中的音色后不再悬空（归位到 S_A）",
    payload.saved.selectedVoiceId === "S_A",
    JSON.stringify(payload.saved),
  );
  check(
    "D2 归位要留日志",
    d18Ctx.logs.some((line) => String(line).indexOf("selection fell back to") >= 0),
    d18Ctx.logs.slice(-3).join(" | "),
  );
  // 反向：选择是合法 free id 时，删掉某个库音色**不能**把它顶走（free 不在库里也仍有效）。
  const seedFree = fakeRes();
  await saveRoute.handler(postReq("/dsh-voice-alert/voices/save", { selectedVoiceId: "free:tw-yu" }), seedFree);
  const resKeep = fakeRes();
  await saveRoute.handler(postReq("/dsh-voice-alert/voices/save", { voices: [{ id: "S_A", note: "A", kind: "clone", enabled: true }] }), resKeep);
  check(
    "D2 反向：当前是免费音色时，保存音色库绝不能把它顶走",
    JSON.parse(resKeep.body).saved.selectedVoiceId === "free:tw-yu",
    resKeep.body.slice(0, 160),
  );
}

// D4：/voices/probe 对畸形 free id 必须 400，而不是当 preset 转给上游。
{
  let upstreamCalls = 0;
  const probeMount = mount(
    {
      voices: [{ id: "S_A", note: "A", kind: "clone", enabled: true }],
      selectedVoiceId: "S_A",
      presetApiKey: "D18-ARK-KEY", // 故意配上 key：旧版会把恶意串一路发出去
      tts: { apiKey: "D18-CLONE-KEY", speaker: "S_A" },
    },
    {
      tmpDir: mkdtempSync(join(tmpdir(), "dsh-voice-alert-d4-")),
      webServer: true,
      fetchImpl: function () {
        upstreamCalls++;
        return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve("{}\n"); } });
      },
    },
  );
  const probeR = probeMount.ctx._routes.find((r) => r.path === "/dsh-voice-alert/voices/probe");
  const badRes = fakeRes();
  await probeR.handler(postReq("/dsh-voice-alert/voices/probe", { speakerId: "free:../../etc/passwd" }), badRes);
  const badPayload = JSON.parse(badRes.body);
  check(
    "D4 畸形 free id → 400 unknown-free-voice（不再冒充 preset 发给厂商）",
    badRes.status === 400 && badPayload.reason === "unknown-free-voice",
    JSON.stringify({ status: badRes.status, payload: badPayload }),
  );
  check("D4 且一次上游调用都没发出", upstreamCalls === 0, String(upstreamCalls));
}

// D3：指纹必须记「本次真正用的音色」，否则覆盖合成后换音色会被判没变。
{
  const fpCfg = Object.assign({}, shapeConfig, { selectedVoiceId: "free:tw-chen" });
  const baseFp = fingerprintFor("complete", fpCfg);
  const overFp = fingerprintFor("complete", fpCfg, "free:tw-chen-cute");
  check(
    "D3 指纹默认取 selectedVoiceId",
    baseFp.speaker === "free:tw-chen",
    JSON.stringify(baseFp.speaker),
  );
  check(
    "D3 传入覆盖音色时指纹跟着变（关键：旧版永远记 selectedVoiceId）",
    overFp.speaker === "free:tw-chen-cute" && overFp.text === baseFp.text,
    JSON.stringify(overFp.speaker),
  );
  const d3Dir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-d3-"));
  const d3Cfg = Object.assign({}, planConfig, {
    audioDir: d3Dir,
    audioOriginDir: join(d3Dir, "origin"),
    audioBackupsDir: join(d3Dir, "backups"),
    generateStateFile: join(d3Dir, "state.json"),
    selectedVoiceId: "free:tw-chen",
  });
  for (const kind of ["complete", "fail", "approval"]) writeFileSync(loudFileFor(kind, d3Cfg), "x", "utf8");
  writeGenerateState(d3Cfg, {
    complete: fingerprintFor("complete", d3Cfg, "free:tw-chen-cute"),
    fail: fingerprintFor("fail", d3Cfg, "free:tw-chen-cute"),
    approval: fingerprintFor("approval", d3Cfg, "free:tw-chen-cute"),
  });
  const d3Plain = planChanges(d3Cfg, ["complete"]);
  const d3Override = planChanges(d3Cfg, ["complete"], { speakerId: "free:tw-yu" });
  const d3SameOverride = planChanges(d3Cfg, ["complete"], { speakerId: "free:tw-chen-cute" });
  check(
    "D3 磁盘上录的是覆盖音色时，换成别的覆盖音色必须判脏（不再 nothing-changed）",
    d3Override.changed.length === 1,
    JSON.stringify({ override: d3Override.changed, reused: d3Override.reused }),
  );
  check(
    "D3 用回当初那个覆盖音色才允许复用",
    d3SameOverride.reused.length === 1 && d3SameOverride.changed.length === 0,
    JSON.stringify({ changed: d3SameOverride.changed, reused: d3SameOverride.reused }),
  );
  check(
    "D3 不带覆盖（按 selectedVoiceId）与「录的是覆盖音色」的状态不一致 → 判脏重录",
    d3Plain.changed.length === 1,
    JSON.stringify({ plainChanged: d3Plain.changed, plainReused: d3Plain.reused }),
  );
}

// D6：ffmpeg 探测要缓存（省内存/减少面板首屏等待）。
{
  const probeOnce = resolveFfmpeg(sfxCfg);
  const probeTwice = resolveFfmpeg(sfxCfg);
  check(
    "D6 第二次探测命中缓存（返回同一对象，不再 spawnSync）",
    probeOnce === probeTwice,
    JSON.stringify(probeTwice),
  );
  const probeFresh = resolveFfmpeg(sfxCfg, { noCache: true });
  check(
    "D6 noCache 仍可强制重探（装了 ffmpeg 不用重启）",
    probeFresh !== probeOnce && (typeof probeFresh.path === "string" || probeFresh.path === null),
    JSON.stringify(probeFresh),
  );
}

// D5：edge 两个目录必须是可配置键（换不了盘 / 多实例共用缓存是实测踩出来的）。
{
  const d5Dir = mkdtempSync(join(tmpdir(), "dsh-voice-alert-d5-"));
  const d5Cfg = Object.assign({}, DEFAULT_CONFIG, {
    edgeCacheDir: join(d5Dir, "my-cache"),
    edgeTmpDir: join(d5Dir, "my-tmp"),
  });
  check("D5 edgeCacheDir 走配置键", d5Cfg.edgeCacheDir === join(d5Dir, "my-cache"), String(d5Cfg.edgeCacheDir));
  check("D5 edgeTmpDir 走配置键", d5Cfg.edgeTmpDir === join(d5Dir, "my-tmp"), String(d5Cfg.edgeTmpDir));
  let d5TmpArg = "";
  // §17 的 isoFree 在它自己的块作用域里，这里另建一份同等夹具（绝不读用户真实 config.json）。
  const d5Iso = resolveConfig(undefined, { configPath: null, env: {} });
  await synthesizeEdge({
    text: "hi",
    voice: FREE_VOICES[0],
    config: Object.assign({}, d5Iso, { edgeTmpDir: d5Dir }),
    spawnImpl: function (_file, args) {
      const at = args.indexOf("--write-media");
      d5TmpArg = at >= 0 ? String(args[at + 1]) : "";
      const listeners = {};
      const stream = { setEncoding: function () {}, on: function () {} };
      const child = {
        stderr: stream,
        stdout: stream,
        on: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        kill: function () {},
        exitCode: null,
      };
      // 必须异步 close：不 fire 的话这个 await 会一直挂到 90s 超时（自检曾经就是这么卡住的）。
      setTimeout(function () { (listeners.close || []).forEach(function (fn) { fn(1); }); }, 0);
      return child;
    },
  });
  check(
    "D5 合成临时文件确实落在配置指定的目录",
    d5TmpArg.indexOf(String(d5Dir)) === 0,
    d5TmpArg,
  );
  const d5Defaults = resolveConfig(undefined, { configPath: null, env: {} });
  check(
    "D5 默认值仍在插件数据目录内（不配也不坏）",
    typeof d5Defaults.edgeCacheDir === "string" && d5Defaults.edgeCacheDir.indexOf("edge-cache") >= 0 &&
      typeof d5Defaults.edgeTmpDir === "string" && d5Defaults.edgeTmpDir.indexOf("edge-tmp") >= 0,
    JSON.stringify({ cache: d5Defaults.edgeCacheDir, tmp: d5Defaults.edgeTmpDir }),
  );
}


section("19. 第三轮 e2e 复核发现的缺陷已修（/generate 闸门 + free 名长度上限）");

// D7：畸形 free id 的闸门以前只加在 /voices/probe，/generate 照收不误 →
// resolveVoice 当 inline preset，配了 Agent Plan Key 的机器真打上游白烧额度。
{
  let genUpstream = 0;
  const genMount = mount(
    {
      voices: [{ id: "S_A", note: "A", kind: "clone", enabled: true }],
      selectedVoiceId: "S_A",
      presetApiKey: "D19-ARK-KEY",
      tts: { apiKey: "D19-CLONE-KEY", speaker: "S_A" },
    },
    {
      tmpDir: mkdtempSync(join(tmpdir(), "dsh-voice-alert-d7-")),
      webServer: true,
      fetchImpl: function () {
        genUpstream++;
        return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve("{}\n"); } });
      },
    },
  );
  const genRoute = genMount.ctx._routes.find((r) => r.path === "/dsh-voice-alert/generate");
  const genRes = fakeRes();
  await genRoute.handler(
    postReq("/dsh-voice-alert/generate", { kinds: ["complete"], force: true, speakerId: "free:../../etc/passwd" }),
    genRes,
  );
  const genPayload = JSON.parse(genRes.body);
  check(
    "D7 /generate 对畸形 free id 直接 400（不再返回半个失败的 202）",
    genRes.status === 400 && genPayload.reason === "unknown-free-voice",
    JSON.stringify({ status: genRes.status, payload: genPayload }),
  );
  check("D7 且一次上游调用都没发出（额度没白烧）", genUpstream === 0, String(genUpstream));
  check(
    "D7 拒绝要留日志",
    genMount.logs.some((line) => String(line).indexOf("generate refused: malformed free voice id") >= 0),
    genMount.logs.slice(-3).join(" | "),
  );

  // 合法 free id 不能被这道闸误伤（否则功能被自己锁死）。
  const okRes = fakeRes();
  const okMountRoute = genMount.ctx._routes.find((r) => r.path === "/dsh-voice-alert/voices/probe");
  await okMountRoute.handler(postReq("/dsh-voice-alert/voices/probe", { speakerId: "free:tw-chen" }), okRes);
  check(
    "D7 合法 free id 不被闸门误伤（probe 走到真合成分支，状态码不是 400 unknown-free-voice）",
    JSON.parse(okRes.body).reason !== "unknown-free-voice",
    okRes.body.slice(0, 160),
  );
}

// D8：自定义 free 名字必须有长度上限，否则试听缓存文件名会超 MAX_PATH，
// 写盘 ENOENT 只记日志 → 每次试听都悄悄重新联网合成。
{
  const longName = "free:zh-CN-" + "a".repeat(300);
  check(
    "D8 超长自定义 free 名不再被当成合法音色（否则缓存文件名炸 MAX_PATH）",
    isFreeVoiceId(longName) === false,
    String(isFreeVoiceId(longName)),
  );
  check("D8 超长名字被认成「畸形 free id」→ 各路由 400", isMalformedFreeVoiceId(longName) === true, String(isMalformedFreeVoiceId(longName)));
  const fit = "free:zh-CN-" + "a".repeat(FREE_VOICE_NAME_MAX - 6);
  const overflow = "free:zh-CN-" + "a".repeat(FREE_VOICE_NAME_MAX - 5);
  check(
    "D8 边界：恰好 " + FREE_VOICE_NAME_MAX + " 字符仍合法、多一个就拒",
    isFreeVoiceId(fit) === true && isFreeVoiceId(overflow) === false,
    JSON.stringify({ fit: isFreeVoiceId(fit), overflow: isFreeVoiceId(overflow) }),
  );
  // 面板只发 7 条目录 id，这条是 API 面：路由必须当场拒绝，而不是 200 后静默重合成。
  const audMount = mount(
    { voices: [{ id: "S_A", note: "A", kind: "clone", enabled: true }], selectedVoiceId: "S_A", tts: { apiKey: "D19-CLONE-KEY", speaker: "S_A" } },
    { tmpDir: mkdtempSync(join(tmpdir(), "dsh-voice-alert-d8-")), webServer: true },
  );
  const audRoute = audMount.ctx._routes.find((r) => r.path === "/dsh-voice-alert/free/audition");
  const audRes = fakeRes();
  await audRoute.handler(postReq("/dsh-voice-alert/free/audition", { speakerId: longName }), audRes);
  check(
    "D8 /free/audition 对超长 free 名直接 400（不再 200 假装成功）",
    audRes.status === 400,
    JSON.stringify({ status: audRes.status, body: audRes.body.slice(0, 140) }),
  );
}

section("20. 客户端界面静态一致性（悬浮提示 / 一行放下 / 主题令牌 / 字号档位）");
{
check(
  "hidden carriers still rendered (save reads them; DOM always present)",
  ["complete", "fail", "approval"].every(
    (kind) => Boolean(domNodes.get("dva-sfx-" + kind)),
  ),
  "",
);
  // 插件根目录（本轮误删过，补回）。
  const pluginDir = fileURLToPath(new URL("..", import.meta.url));
  // §20 的源码基底（块内多处断言要用）。
  const client = readFileSync(join(pluginDir, "lib", "client.js"), "utf8");
  // 「怎么提醒你」卡真·一行（用户 2026-10-25 截图三支红箭头 + 「同理这个也弄成一行」）。
  // 旧结构 title-row / top-row / divider-mode / mode-title / alert-mode 是五个独立块，
  // 天生三行以上；合并后这四个 key 必须不再出现，四个控件必须同住 key: "main-top"。
  check(
    "20p 「播报开关」卡顶栏 + 提醒方式真·一行（四控件同 div，旧独立块已删，点完即存仍在）",
    (() => {
      const i = client.indexOf('key: "main-top"');
      if (i < 0) return false;
      // 块尾锚点：音效面板已删（第十三轮），改取下一段（dva-status）。
      const j = client.indexOf('id: "dva-status-box"', i);
      if (j < 0) return false;
      const blk = client.slice(i, j);
      return (
        blk.indexOf('id: "dva-big-preview"') > 0 &&
        blk.indexOf('id: "dva-audio-tip"') > 0 &&
        // 模式按钮 id 是运行时拼接的（"dva-alert-mode-" + mode），块内只出现前缀：
        !/key: "top-row"/u.test(client) &&
        !/key: "mode-title"/u.test(client) &&
        !/key: "alert-mode"/u.test(client) &&
        !/key: "divider-mode"/u.test(client) &&
        blk.indexOf("persistPatch(") > 0 &&
        /flexWrap: "wrap", minWidth: "0"/u.test(blk) &&
        // 第十七轮：状态盒内部左右两栏（status-text 左 / dva-voice 右），
        // 顶栏不再有音色 span
        j > 0 &&
        /var cardHead = \{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "nowrap", minWidth: "0" \}/u.test(client)
      );
    })(),
    "",
  );
  // 音效的导出/导入**并入三条行的动作组**（第十三轮：音效模式下「⬇ 下载」变
  // 「⬇ 导出」、「⬆ 导入」换成提示音；独立面板已删 —— 界面与语音模式完全一致）。
  const hostIndexSrc = readFileSync(join(pluginDir, "lib", "index.js"), "utf8");
  check(
    "20q 音效导出/导入并入三条行动作组（宿主两条路由 + 面板内提示 + 独立面板已删）",
    /\/sfx\/download/u.test(hostIndexSrc) &&
      /\/sfx\/import/u.test(hostIndexSrc) &&
      /function downloadSfx\(/u.test(client) &&
      /function importSfx\(key, kind\)/u.test(client) &&
      /function sfxIoFailReason\(/u.test(client) &&
      /function sfxNote\(/u.test(client) &&
      !/key: "sfx-panel"/u.test(client) &&
      !/id: "dva-sfx-io-pick"/u.test(client) &&
      /downloadSfx\(\(cache\.sfxByKind \|\| \{\}\)\[kind\]\)/u.test(client) &&
      /importSfx\(\(cache\.sfxByKind \|\| \{\}\)\[kind\], kind\)/u.test(client) &&
      /\(cache\.alertMode \|\| "voice"\) === "sfx" \? "⬇ 导出" : "⬇ 下载"/u.test(client) &&
      !/id: "dva-sfx-note"/u.test(client) &&
      /persistPatch\(patch, "已切换为「" \+ sfxNameOf\(key\) \+ "」的提醒音（立即生效）"/u.test(client) &&
      /function persistPatch\(patch, okMessage, before, onOk\)/u.test(client),
    "",
  );
  // 音效面板行与音色库行同源，按同一套不变量加固（独立复核指出它是同类潜伏隐患）。
  check(
    "20l3 音效面板行同源加固（容器 nowrap + 曲名可收缩 + 按钮不缩不折）",
    /var sfxRowStyle = \{[^}]*flexWrap: "nowrap"[^}]*minWidth: 0/u.test(client) &&
      /var sfxNameStyle = \{ flex: "0 1 auto", minWidth: 0/u.test(client) &&
      /var sfxBtnMini = \{[\s\S]{0,400}?flex: "0 0 auto",[\s\S]{0,200}?whiteSpace: "nowrap"/u.test(client),
    "",
  );

  check(
    "20a 总开关存在状态徽标 dva-enabled-state，并有 applyEnabledBadge() 负责刷新",
    /dva-enabled-state/.test(client) && /function applyEnabledBadge\(\)/.test(client),
    "",
  );
  // persistPatch 的失败回滚 + 保存设置成功分支都必须刷徽标，
  // 否则「勾了勾选框、徽标仍写已禁用」会让人以为开关没生效。
  const badgeRefs = (client.match(/applyEnabledBadge\(\)/g) || []).length;
  check("20b 徽标刷新点 >= 3（定义处 + 回滚 + 保存成功）", badgeRefs >= 4, "refs=" + badgeRefs);

  // 「生成语音」按钮的禁用只能由 currentVoiceReady() 决定：任何一处漏改，
  // 免费音色用户都会看到按钮永久置灰。合法形态有三种：
  //   ① 直接 !currentVoiceReady()；② 提交中置灰 true；③ refreshGenerateGate 内部用 ready。
  const gateLines = client.split("\n").filter((l) => /setDisabled\("dva-generate"/.test(l));
  const badGates = gateLines.filter(
    (l) => !/currentVoiceReady\(\)/.test(l) && !/!ready\b/.test(l) && !/, true\)/.test(l),
  );
  check(
    "20c dva-generate 的每处禁用都走 currentVoiceReady()",
    gateLines.length > 0 && badGates.length === 0,
    JSON.stringify({ total: gateLines.length, bad: badGates.map((l) => l.trim()) }),
  );

  // 同一张面板里字号只允许 11 / 11.5 / 12 / 12.5 / 13 / 13.5 这几档。
  // 15px 曾被用户点名为「字体太大太稀疏」，固化成断言防止回潮。
  check(
    "20d 设置面板无 15px 及以上的字号（用户反馈字体过大）",
    !/fontSize:\s*"1[5-9]px"|fontSize:\s*"[2-9]\dpx"/.test(client),
    String(((client.match(/fontSize:\s*"[0-9.]+px"/g) || []).sort())),
  );

  // 顶部大按钮组已按用户要求移除，只剩卡片内的单条动作组。
  check(
    "20e 顶部「下载/导入 MP3」大按钮组与 mp3-tip 已移除",
    !/dva-big-download|dva-big-import|mp3-tip/.test(client),
    "",
  );

  // persistPatch 是命令式改 DOM、不触发 React 重渲染 —— 凡是由 cache 渲染的
  // 生成按钮，在改完音色库/新增音色/试听成功之后都必须手动刷一次。
  check(
    "20f 音色库保存/新增/试听成功后都刷新了生成按钮",
    /refreshGenerateGate/.test(client) && (client.match(/refreshGenerateGate\(/g) || []).length >= 8,
    "refs=" + ((client.match(/refreshGenerateGate\(/g) || []).length),
  );

  // 2026-10-26 用户实测「音色库每次重载都消失」：section 是 React 槽位，宿主重渲染
  // 会把 #dva-voice-rows 重建为空 div，命令式塞进去的行全部丢失，而 loadSettings
  // 被 cache.loaded 挡住不再跑，界面停在「读取中…」+ 空库。修复 = 重挂载时
  // cache.loaded 已真就重放 loadVoices()（幂等 GET）+ refreshAllActionGroups()。
  check(
    "20r 重挂载自愈：cache.loaded 时 SettingsSection 重放 loadSettings（自带 loadVoices），带 1.5s 节流",
    client.includes("} else if (cache.loaded) {") &&
      /else if \(cache\.loaded\) \{[\s\S]*?cache\.lastSelfHealAt[\s\S]*?loadSettings\(\);/.test(client),
    "remount self-heal branch present in SettingsSection"
  );
  check(
    "20r2 重挂载自愈分支在 loadSettings 守卫的同一 try 内（首装路径不受影响）",
    /if \(!cache\.loaded && !cache\.loading\) \{[\s\S]*?loadSettings\(\);[\s\S]*?\} else if \(cache\.loaded\) \{/.test(client),
    "first-mount path intact, self-heal in same try"
  );

  // 2026-10-26 用户实测「音色库需要 key 的那几行没有删除按钮」：根因是 libRight
  // 容器创建了却从未 append 到 row —— 备注框 / probe 输出 / 「删除」按钮全成了
  // 游离节点。断言必须锁住「右栏挂回 row」这一条，光查按钮字面量还在测不到复发。
  check(
    "20s 音色库行的右栏容器 libRight 必须 append 到 row（否则删除按钮看不见）",
    /libRight\.appendChild\(delBtn\);[\s\S]{0,120}?row\.appendChild\(libRight\);/.test(client) &&
      /var libRight = document\.createElement\("span"\);/.test(client),
    "libRight mounted back onto row"
  );
  check(
    "20s2 音色库行左栏 libLeft 承载 idSpan + avail 并挂回 row（两栏同构）",
    /libLeft\.appendChild\(idSpan\);/.test(client) &&
      /libLeft\.appendChild\(avail\);[\s\S]{0,80}?row\.appendChild\(libLeft\);/.test(client),
    "libLeft carries idSpan+avail and is mounted"
  );
  check(
    "20s3 我的音色库行内不再有游离的 row.appendChild(avail/setBtn) 旧写法（免费行不算：它不分两栏）",
    (function () {
      var at = client.indexOf("我的音色库");
      if (at < 0) return false;
      var tail = client.slice(at, at + 20000);
      var end = tail.indexOf("box.replaceChildren");
      var seg = end > 0 ? tail.slice(0, end) : tail;
      return !/^\s+row\.appendChild\((avail|setBtn|idSpan)\);$/m.test(seg);
    })(),
    "library-row segment free of orphan appends"
  );

  // 2026-10-26 用户要求删除按钮真的能删：原先只改 cache，必须再点「保存音色库」
  // 才落盘，重载又回来。现在点完即存。
  check(
    "20t 删除按钮点完即存（POST /voices/save），不是只改 cache 等下次保存",
    /var removed = voice\.note \|\| voice\.id;[\s\S]{0,900}?request\("\/voices\/save"[\s\S]{0,1600}?已删除/.test(client),
    "delete persists immediately"
  );

  // 自愈必须「只在真被抹掉时」才重放，否则每次重渲染都 loadSettings 会把用户正在
  // 输入的音色备注冲掉。判定 = 等一帧后看 #dva-voice-rows 是否空 / 音量行是否还在
  // 「读取中…」。
  check(
    "20u 自愈只在真被抹掉时触发（rows 空 或 音量行仍「读取中」），不是无条件重放",
    /setTimeout\(function \(\) \{[\s\S]{0,400}?var rowsWiped[\s\S]{0,200}?var volWiped[\s\S]{0,200}?if \(!rowsWiped && !volWiped\) return;/.test(client),
    "wiped-detection guard present"
  );
  check(
    "20u2 自愈走 setTimeout(0) 延后一帧判定（React commit 在组件函数返回之后）",
    /setTimeout\(function \(\) \{[\s\S]{0,400}?watchRowsContainer\(\);[\s\S]{0,900}?loadSettings\(\);[\s\S]{0,400}?\}, 0\);/.test(client),
    "deferred to next tick"
  );

  // ---- 20v：音色库容器防抹（用户 2026-10-26：「不要出现有时候不显示的音色库内容」）
  // 光靠 setTimeout 自愈是「下一帧才补」，中间那一帧界面是空的 —— 用户看到的就是
  // 「有时候不显示」。必须用 MutationObserver 在 React 清空的同一轮里同步重画。
  check(
    "20v 音色库容器挂了 MutationObserver（React 清空时同步重画，不留空帧）",
    /function watchRowsContainer\(\)[\s\S]{0,2000}?new MO\(function \(\) \{ healVoiceRows\(\); \}\)/.test(client),
    "observer installed"
  );
  check(
    "20v2 观察器只观察 childList 且在「被清空」时才补画（自己写入不递归）",
    /observe\(box, \{ childList: true \}\);/.test(client) &&
      /var empty = !node\.children \|\| node\.children\.length === 0;/.test(client) &&
      /if \(!empty\) return;/.test(client),
    "childList + empty-only guard"
  );
  // 槽位被 React 整个换成新节点时，旧观察器跟着旧节点一起失效 —— 只盯容器自身
  // 会漏掉这种「换节点」式抹除，必须同时盯父节点，并在回调里发现节点换了就重挂。
  check(
    "20v2b 观察器同时盯槽位父节点（React 换节点式抹除也能在同一轮发现）",
    /observe\(box\.parentElement, \{ childList: true \}\);/.test(client),
    "parent observed"
  );
  check(
    "20v2c 补画入口发现槽位换了新节点就先重挂观察器",
    /if \(cache\.rowsWatched !== node\) watchRowsContainer\(\);/.test(client),
    "re-watch on node swap"
  );
  check(
    "20v3 renderVoiceRows 用 rowsRendering 闸门包住 replaceChildren，并每次重挂观察器",
    /cache\.rowsRendering = true;[\s\S]{0,200}?box\.replaceChildren\.apply\(box, rows\);[\s\S]{0,200}?cache\.rowsRendering = false;[\s\S]{0,200}?watchRowsContainer\(\);/.test(client),
    "recursion gate + re-watch"
  );
  check(
    "20v4 容器空但 cache 有数据时直接重画，不再走一趟网络",
    /if \(rowsWiped && \(cache\.voices\.length > 0 \|\| cache\.freeVoices\.length > 0\)\) \{[\s\S]{0,120}?renderVoiceRows\(\);/.test(client),
    "cache-only repaint"
  );
  check(
    "20v5 空 cache（首装未读到）不补画，保留「读取中…」提示",
    /if \(cache\.voices\.length === 0 && cache\.freeVoices\.length === 0\) return;/.test(client),
    "no repaint on empty cache"
  );
  // React 会把整棵 section 卸掉再挂一棵新的 —— 那时槽位节点根本不存在，挂在容器
  // 上的观察器无从下手。必须在 body 上留一个「槽位出生」看门狗。
  check(
    "20v6 body 上挂了槽位出生看门狗（subtree 观察，发现槽位空就补画）",
    /function ensureSlotGuard\(\)[\s\S]{0,1200}?cache\.slotGuard = new MO\(function \(\) \{ healVoiceRows\(\); \}\)[\s\S]{0,200}?observe\(root, \{ childList: true, subtree: true \}\)/.test(client),
    "body-level guard installed"
  );
  check(
    "20v7 看门狗只挂一个（cache.slotGuard 已存在就直接返回）",
    /function ensureSlotGuard\(\) \{[\s\S]{0,120}?if \(cache\.slotGuard\) return;/.test(client),
    "single guard"
  );
  check(
    "20v8 renderVoiceRows 与 SettingsSection 都先 ensureSlotGuard（首装与重挂都覆盖）",
    (client.match(/ensureSlotGuard\(\);/g) || []).length >= 2 &&
      /function renderVoiceRows\(\) \{[\s\S]{0,200}?ensureSlotGuard\(\);/.test(client) &&
      /function SettingsSection\(\) \{[\s\S]{0,400}?ensureSlotGuard\(\);/.test(client),
    "guard armed at both entry points"
  );

  // ---- 20w：删除按钮不得因「正在使用」而禁用（用户 2026-10-26 再次反馈
  // 「音色库需要 key 没有删除的按钮」）。库里只有一个克隆音色时，被禁用的删除
  // 按钮等于「没有删除按钮」。删掉当前音色由宿主 D2 归位兜底。
  check(
    "20w 删除按钮恒可用（不再因 inUse 被禁用）",
    /delBtn\.style\.cssText = btnMini;[\s\S]{0,120}?delBtn\.disabled = false;/.test(client),
    "delete always enabled"
  );
  check(
    "20w2 删除按钮不再出现「不可删除」的禁用文案",
    !/正在使用的克隆音色不可删除/.test(client),
    "no disabled tooltip"
  );
  check(
    "20w3 删除当前音色时给出归位提示（不会留下悬空选择）",
    /当前正在使用；删除后会自动切到库里第一个音色/.test(client),
    "fallback hint present"
  );
  check(
    "20w4 宿主 /voices/save 在选中项悬空时归位到第一个音色",
    /currentStillValid[\s\S]{0,300}?config\.selectedVoiceId = fallbackVoice;/.test(hostIndexSrc),
    "host D2 fallback present"
  );
  check(
    "20w5 客户端回填 selectedVoiceId 用 !== undefined 判（删空时空串是合法值）",
    /cache\.selectedVoiceId = data\.selectedVoiceId !== undefined \? data\.selectedVoiceId : cache\.selectedVoiceId;/.test(client),
    "empty selection honored"
  );
  // ---- 20x：试听悬浮气泡「出框 / 显示不完整」（用户 2026-10-26：
  // 「试听的展开消息显示不完整出框了」）----
  // 为什么只能这么测：假 DOM 的 style 是空对象、没有布局引擎，CSS 里
  // position:absolute + overflow 裁剪完全测不出来。所以分两层——
  //  ① 源码静态断言：定位器存在、只挂一次、宽度/位置确实被夹紧、滚动缩放会重算；
  //  ② 桩几何功能测试：给 placeTip 喂假矩形，断言它真的把气泡夹回可见区域内。
  // 缺了第②层，第①层就只是「函数名写了」的自嗨（本项目已踩过多次同类坑）。
  check(
    "20x 悬浮气泡定位器三件套齐备（placeTip / tipClipRect / ensureTipPlacement）",
    /function tipClipRect\(wrap\)/.test(client) &&
      /function placeTip\(wrap\)/.test(client) &&
      /function ensureTipPlacement\(\)/.test(client),
    "tip placement helpers present",
  );
  check(
    "20x2 定位器只挂一次（cache.tipPlacement 闸门）+ 面板入口武装 + 测试面导出",
    /function ensureTipPlacement\(\) \{[\s\S]{0,120}?if \(cache\.tipPlacement\) return;/.test(client) &&
      (client.match(/ensureTipPlacement\(\);/g) || []).length >= 1 &&
      /function SettingsSection\(\) \{[\s\S]{0,600}?ensureTipPlacement\(\);/.test(client) &&
      /placeTip: placeTip/.test(client),
    "single placement listener",
  );
  check(
    "20x3 浮出时按可用宽度夹紧 maxWidth/minWidth（不再写死 300px 撞出边界）",
    /bubble\.style\.maxWidth = Math\.min\(300, avail\) \+ "px"/.test(client) &&
      /bubble\.style\.minWidth = Math\.min\(180, avail\) \+ "px"/.test(client),
    "width clamped to available space",
  );
  check(
    "20x4 水平位置夹回可见区 + 下方不够高时翻到上方展开",
    /if \(left \+ br\.width > cr\.right - TIP_EDGE_PAD\) left = cr\.right - TIP_EDGE_PAD - br\.width;/.test(client) &&
      /if \(left < cr\.left \+ TIP_EDGE_PAD\) left = cr\.left \+ TIP_EDGE_PAD;/.test(client) &&
      /bubble\.style\.bottom = "calc\(100% \+ 4px\)"/.test(client),
    "clamped horizontally + vertical flip",
  );
  check(
    "20x5 滚动 / 窗口缩放时按新位置重算（不是只在 hover 那一刻算一次）",
    /window\.addEventListener\("scroll", onReflow, true\)/.test(client) &&
      /window\.addEventListener\("resize", onReflow, false\)/.test(client) &&
      /if \(cache\.tipActive\) placeTip\(cache\.tipActive\);/.test(client),
    "reflow on scroll/resize",
  );
  // 桩几何功能测试：把 placeTip 当成纯函数喂假矩形，验证它真的会夹。
  (() => {
    const ui = clientExports.__dvaTest;
    const savedWindow = globalThis.window;
    const savedBody = globalThis.document && globalThis.document.body;
    // 造一个「锚点 + 气泡 + 一个带 overflow:auto 的祖先容器」的假 DOM。
    function makeTip(opts) {
      const wrapStyle = {};
      const bubbleStyle = {};
      const bubble = {
        style: bubbleStyle,
        getBoundingClientRect() {
          const w = Math.min(opts.bubbleW, parseFloat(bubbleStyle.maxWidth) || opts.bubbleW);
          const l = opts.anchorLeft + (parseFloat(bubbleStyle.left) || 0);
          return { left: l, right: l + w, top: 0, bottom: opts.bubbleH, width: w, height: opts.bubbleH };
        },
      };
      const wrap = {
        style: wrapStyle,
        parentNode: opts.clip
          ? {
              nodeType: 1,
              parentNode: null,
              getBoundingClientRect() {
                return { left: opts.clip.left, right: opts.clip.right, top: opts.clip.top, bottom: opts.clip.bottom, width: opts.clip.right - opts.clip.left, height: opts.clip.bottom - opts.clip.top };
              },
            }
          : null,
        querySelector(sel) {
          return sel === ".dva-tip-bubble" ? bubble : null;
        },
        getBoundingClientRect() {
          return { left: opts.anchorLeft, right: opts.anchorLeft + opts.anchorW, top: opts.anchorTop, bottom: opts.anchorTop + opts.anchorH, width: opts.anchorW, height: opts.anchorH };
        },
      };
      return { wrap, bubble };
    }
    globalThis.window = {
      innerWidth: 1024,
      innerHeight: 768,
      getComputedStyle() {
        return { overflowX: "auto", overflowY: "auto" };
      },
    };
    try {
      // ① 窄容器：可用宽度 200px，气泡想占 300px —— 必须夹到 184px（200 - 8*2）。
      const narrow = makeTip({ anchorLeft: 12, anchorTop: 10, anchorW: 14, anchorH: 14, bubbleW: 300, bubbleH: 60, clip: { left: 12, right: 212, top: 0, bottom: 768 } });
      const r1 = ui.placeTip(narrow.wrap);
      check(
        "20x6 窄面板下气泡宽度被夹到可用宽度内（300 → 184），且整体落在可见区",
        r1 && r1.width === 184 && r1.inside === true,
        JSON.stringify(r1),
      );
      // ② 锚点贴右边缘：气泡整体左移，不能顶出右边。
      const rightEdge = makeTip({ anchorLeft: 390, anchorTop: 10, anchorW: 14, anchorH: 14, bubbleW: 300, bubbleH: 60, clip: { left: 12, right: 412, top: 0, bottom: 768 } });
      const r2 = ui.placeTip(rightEdge.wrap);
      check(
        "20x7 锚点贴右边缘时气泡整体左移，右边界不越界",
        r2 && r2.inside === true && r2.left + r2.width <= 412,
        JSON.stringify(r2),
      );
      // ③ 下方只剩 54px、气泡高 100px → 翻到锚点上方。
      const bottom = makeTip({ anchorLeft: 100, anchorTop: 700, anchorW: 14, anchorH: 14, bubbleW: 200, bubbleH: 100, clip: { left: 12, right: 412, top: 0, bottom: 768 } });
      const r3 = ui.placeTip(bottom.wrap);
      check(
        "20x8 下方空间不够时气泡翻到锚点上方展开",
        r3 && r3.flipped === true,
        JSON.stringify(r3),
      );
      // ④ 没有裁剪祖先时退化为视口，且不抛错（旧行为不能因为加固而挂掉）。
      const plain = makeTip({ anchorLeft: 100, anchorTop: 100, anchorW: 14, anchorH: 14, bubbleW: 200, bubbleH: 60, clip: null });
      const r4 = ui.placeTip(plain.wrap);
      check(
        "20x9 无裁剪祖先时退化为视口边界，仍返回结果不抛错",
        r4 && r4.inside === true && r4.clip.right === 1024,
        JSON.stringify(r4),
      );
    } finally {
      globalThis.window = savedWindow;
      if (globalThis.document && savedBody === undefined) {
        // 假 document 本来就没有 body，保持原状
      }
    }
  })();
}

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
