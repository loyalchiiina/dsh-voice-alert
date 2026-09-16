// dsh-voice-alert - credential-free local control channel.
//
// WHY THIS EXISTS (measured on this machine, 2026-09-15):
//   Every HTTP route of a DSH Desktop host - ours included - is wrapped by the
//   desktop shell's browser-access fence, so an ordinary local request without
//   the Electron renderer's capability header is answered 403 "forbidden":
//     * DSH Desktop Beta resources/app/lib/webserver.js:42-53
//       (DesktopWebServer.permits -> rejectBrowserRequest, 403 "forbidden")
//     * DSH Desktop Beta resources/app/lib/desktop-browser-access-*.js:47-51
//       (decideDesktopBrowserAccess -> "denied" while ordinaryBrowserEnabled is false)
//   The capability header (`x-dsh-desktop-renderer`) is a per-generation secret
//   held by the renderer; it is deliberately not persisted anywhere. So the
//   plugin needs a second, credential-free way for the OWNER OF THIS MACHINE to
//   trigger a real playback and to read the plugin's status.
//
// The channel: a file in the user's own data directory.
//   trigger : drop <controlFile> containing "kind=complete" (or just "complete",
//             "fail", "approval") -> the plugin plays it and deletes the file
//   result  : <controlResultFile> records the last accepted request
//   status  : <statusFile> is the JSON snapshot (same payload as /status)
//
// This weakens nothing: file access in the user's own profile is the same
// authority that already runs the plugin and the player.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VALID_KINDS = ["complete", "fail", "approval"];

function errText(error) {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

/**
 * Parse one control-file body into a play kind.
 * Accepts "kind=complete", "complete", "play fail", "+---+" banners or a
 * comment-prefixed line (the LAST valid kind token wins).
 * @returns the kind, or null when the text names no valid kind.
 */
export function parseControlText(text) {
  if (typeof text !== "string") return null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("//")) continue;
    const value = line.includes("=") ? line.slice(line.indexOf("=") + 1).trim() : line;
    const tokens = value
      .split(/\s+/u)
      .map(function (token) {
        return token.toLowerCase().replace(/^["']+|["']+$/gu, "");
      })
      .filter(function (token) {
        return token.length > 0;
      });
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      if (VALID_KINDS.indexOf(tokens[index]) >= 0) return tokens[index];
    }
  }
  return null;
}

/**
 * Build the file control channel.
 * @param options.config - resolved config (controlFile/controlResultFile/statusFile).
 * @param options.log - logger.
 * @param options.playManual - (kind) => result, the engine's manual trigger.
 * @param options.statusPayload - () => object, the /status JSON payload.
 */
export function createControlChannel(options) {
  const config = options.config;
  const log = typeof options.log === "function" ? options.log : function () {};
  const playManual = typeof options.playManual === "function" ? options.playManual : function () { return { ok: false }; };
  const statusPayload = typeof options.statusPayload === "function" ? options.statusPayload : function () { return {}; };

  let timer = null;
  const state = { polls: 0, triggers: 0, rejected: 0, lastTriggerKind: null, lastTriggerAt: null, lastStatusAt: null };

  function writeFileEnsured(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { encoding: "utf8" }); // utf8 -> no BOM
  }

  /** Write the JSON status snapshot. Never throws. */
  function writeStatus() {
    try {
      const payload = Object.assign({ at: new Date().toISOString(), channel: state }, statusPayload());
      writeFileEnsured(config.statusFile, JSON.stringify(payload, null, 2) + "\n");
      state.lastStatusAt = payload.at;
      return { ok: true, path: config.statusFile };
    } catch (error) {
      log("status write failed (" + String(config.statusFile) + "): " + errText(error));
      return { ok: false, reason: errText(error) };
    }
  }

  function writeResult(extra) {
    try {
      writeFileEnsured(
        config.controlResultFile,
        JSON.stringify(Object.assign({ at: new Date().toISOString() }, extra), null, 2) + "\n",
      );
    } catch (error) {
      log("control result write failed: " + errText(error));
    }
  }

  /** One non-blocking check of the control file. Returns the played kind or null. */
  function poll() {
    state.polls++;
    try {
      if (!existsSync(config.controlFile)) return null;
      let raw = "";
      try {
        raw = readFileSync(config.controlFile, "utf8");
      } catch (error) {
        log("control file unreadable: " + errText(error));
        return null;
      }
      // Consume the request first: a malformed or crashed run must not replay it.
      try {
        rmSync(config.controlFile, { force: true });
      } catch (error) {
        log("control file could not be consumed: " + errText(error));
      }
      const kind = parseControlText(raw);
      if (kind === null) {
        state.rejected++;
        log("control file request rejected (no valid kind): " + JSON.stringify(raw.slice(0, 80)));
        writeResult({ ok: false, reason: "no-valid-kind", raw: raw.slice(0, 200) });
        return null;
      }
      state.triggers++;
      state.lastTriggerKind = kind;
      state.lastTriggerAt = new Date().toISOString();
      log("control file request accepted: kind=" + kind);
      const result = playManual(kind);
      writeResult({ ok: true, kind, result });
      writeStatus();
      return kind;
    } catch (error) {
      log("control poll failed: " + errText(error));
      return null;
    }
  }

  /** Start the polling loop; returns the disposer. */
  function start() {
    const interval = Number(config.controlPollMs) > 0 ? Number(config.controlPollMs) : 2000;
    timer = setInterval(poll, interval);
    if (timer && typeof timer.unref === "function") timer.unref();
    log("control channel armed: file=" + config.controlFile + " every " + interval + "ms");
    return function stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
  }

  return { poll, writeStatus, writeResult, start, state };
}
