// dsh-voice-alert - OPT-IN real end-to-end generation probe.
//
// This is NOT part of test/self-check.mjs: the default self-check must stay
// hermetic (no network, no quota). Run this one explicitly when you want proof
// that the real chain works end to end:
//
//     node test/real-generate.mjs            # real TTS x3 + real ffmpeg gain
//     node test/real-generate.mjs --kind fail
//
// It runs the PRODUCTION pipeline (synthesize -> raw file -> loudness gain with
// temp-file + retry -> volumedetect -> backup/rotation) inside a TEMP audio
// directory, so the live audio files in <data>\audio are never touched, then:
//   * prints the measured mean/max of all three cue files,
//   * checks the "within target" window for every one of them,
//   * runs a second time to prove the change-detection reuses everything
//     (nothing-changed, no second TTS call),
//   * prints the backup/rotation evidence.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "../lib/config.js";
import { buildGainArgs, createGenerator, readGenerateState, resolveFfmpeg } from "../lib/generate.js";
import { buildTtsRequest, synthesize } from "../lib/tts.js";

const KINDS = ["complete", "fail", "approval"];
const kindArgAt = process.argv.indexOf("--kind");
const ONLY = kindArgAt >= 0 ? String(process.argv[kindArgAt + 1] || "complete") : null;
const WANTED = ONLY ? [ONLY] : KINDS;

function log(message) {
  console.log("  " + message);
}
function pad(value, width) {
  return String(value).padEnd(width, " ");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-voice-alert-e2e-"));
const config = resolveConfig(undefined, { configPath: undefined, log: function () {} });
config.audioDir = join(tmpRoot, "audio");
config.audioOriginDir = join(tmpRoot, "audio", "origin");
config.audioBackupsDir = join(tmpRoot, "audio", "backups");
config.generateStateFile = join(tmpRoot, "generate-state.json");
config.keepBackupSets = 2;
config._meta = { configPath: tmpRoot, configState: "e2e-temp", rowConfigKeys: 0 };

console.log("== real end-to-end generation probe");
log("kinds       : " + WANTED.join(", "));
log("texts       : " + JSON.stringify(config.texts));
log("prosody     : " + JSON.stringify(config.prosody));
log("gain filter : " + config.gainFilter + "  (targets mean [" + String(config.gainMinMeanDb) + ", " + String(config.gainMaxMeanDb) + "] max <= " + String(config.gainMaxPeakDb) + ")");
log("temp audio  : " + config.audioDir);
log("api key     : " + (config.tts.apiKey ? "present (" + String(config.tts.apiKey.length) + " chars)" : "MISSING -> abort"));
log("speaker     : " + config.tts.speaker + " (fixed)");

if (!config.tts.apiKey) {
  console.log("FAIL: no TTS api key in the runtime config (tts.apiKey / DSH_VOICE_ALERT_TTS_KEY)");
  process.exit(2);
}

// ---------------------------------------------------------------- 1. request shape
const request = buildTtsRequest(config.texts[WANTED[0]], config, "e2e-probe");
const body = JSON.parse(request.body);
console.log("");
console.log("== 1. request shape");
log("url     : " + request.url);
log("resource: " + request.headers["X-Api-Resource-Id"] + "  model: " + body.req_params.model);
log("audio   : " + JSON.stringify(body.req_params.audio_params));

// ---------------------------------------------------------------- 2. live synthesis (one sentence)
console.log("");
console.log("== 2. live TTS synthesis (single sentence, timing evidence)");
const startedAt = Date.now();
const synth = await synthesize({ text: config.texts[WANTED[0]], config, log });
const synthMs = Date.now() - startedAt;
if (!synth.ok) {
  console.log("FAIL: " + synth.error);
  process.exit(1);
}
log("bytes=" + synth.bytes.length + " in " + synthMs + "ms (end code " + String(synth.code) + ")");

// ---------------------------------------------------------------- 3. full pipeline
console.log("");
console.log("== 3. production pipeline (TTS x" + String(WANTED.length) + " -> origin -> gain -> backup)");
const ffmpeg = resolveFfmpeg(config);
log("ffmpeg  : " + String(ffmpeg.path) + " (source " + ffmpeg.source + ")");
if (!ffmpeg.path) log("WARNING: ffmpeg missing - the loud copy would be the raw file");
// Seed older backup sets so the rotation has something to recycle.
for (const stamp of ["20260101-000001", "20260102-000002", "20260103-000003"]) {
  const dir = join(config.audioBackupsDir, stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.txt"), "seed", "utf8");
}

let ttsCalls = 0;
const generator = createGenerator({
  config,
  log: function (message) { log("[host] " + message); },
  fetchImpl: function (url, init) {
    ttsCalls += 1;
    return fetch(url, init);
  },
});
const started = generator.start(WANTED, "e2e");
log("start   : " + JSON.stringify(started));
await generator.whenIdle();
const job = generator.snapshot();
log("result  : " + String(job.result) + "  changed=" + JSON.stringify(job.changed) + "  reused=" + JSON.stringify(job.reused));
log("TTS calls: " + String(ttsCalls));
log("backup  : " + String(job.backupDir));
log("recycled: " + JSON.stringify(job.recycled));
log("leftovers (must show no .tmp- files): " + JSON.stringify(readdirSync(config.audioDir)));

console.log("");
console.log("== 4. measured loudness (production files from this run)");
console.log("  " + pad("kind", 10) + pad("bytes", 9) + pad("mean dB", 9) + pad("max dB", 9) + pad("withinTarget", 14) + "corrective");
const rows = [];
for (const kind of WANTED) {
  const entry = job.outputs[kind];
  rows.push(entry);
  console.log(
    "  " +
      pad(kind, 10) +
      pad(entry.bytes, 9) +
      pad(entry.gain.mean, 9) +
      pad(entry.gain.max, 9) +
      pad(String(entry.withinTarget), 14) +
      String(entry.corrective),
  );
}
const allWithin = rows.every(function (entry) {
  return entry.ok === true && entry.withinTarget === true;
});
console.log("  all three within target: " + String(allWithin));

console.log("");
console.log("== 5. second run must reuse everything (no TTS call)");
const secondStart = generator.start(WANTED, "e2e-second");
log("start   : " + JSON.stringify(secondStart));
const secondJob = generator.snapshot();
log("result  : " + String(secondJob.result));
log("TTS calls total after 2nd run: " + String(ttsCalls) + " (must equal the first run's count)");
const state = readGenerateState(config);
log("snapshot: " + String(state.updatedAt) + " kinds=" + JSON.stringify(Object.keys(state.entries)));

console.log("");
const reuseOk = secondStart.reason === "nothing-changed" && secondJob.result === "nothing-changed";
const ok = allWithin && reuseOk;
console.log("  second run reused: " + String(reuseOk));
console.log("  temp dir: " + tmpRoot);
console.log("");
if (!ok) {
  console.log("E2E FAILED (withinTarget or reuse check failed)");
  process.exit(1);
}
console.log("E2E OK");
