// dsh-voice-alert - event -> voice decision engine (pure, host/DOM free).
//
// WHY THIS SHAPE (evidence, all from @deepseek-ai/dsh-agent-loop/lib/index.js):
//   * `session/event` firehose carries `(session, event)`; the loop appends
//     "turn/start" ({turn}) before a turn and "turn/end" ({turn, reason}) in a
//     finally block (index.js:926 and index.js:994), so turn/end is the ONE
//     signal that fires exactly once per conversation turn - including turns that
//     contain many tool calls (a long task emits turn/end per turn, never per
//     step). Constructor-seeded history does NOT re-emit on this firehose, so a
//     DSH restart / session resume cannot fake a "turn finished".
//   * `agent/error` carries {agent, turn, step, error} and is emitted BEFORE the
//     turn's own turn/end (index.js:991 emits, index.js:994 appends turn/end), so
//     an error inside the turn can be attributed to that turn.
//   * `tools/result` carries (exec, result) with `result.isError`; the executor
//     exposes exec.agent (dsh-tools/lib/types/index.js:3287 dispatches with
//     scopeTarget(this, exec.agent)).
//
// DECISION RULE (per user decision 2026-09-14):
//   每个 turn 结束都播一次。同一 turn 已出错 -> 只播「失败」，不叠加播「完成」。
//   错误播报（立即的那一次）最短间隔 errorMinIntervalMs（默认 5s）。

function errText(error) {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

/** Read a session's durable header without throwing. */
function headerOf(session) {
  try {
    return (session && session.header) || {};
  } catch (_) {
    return {};
  }
}

/** Session identity: `session.id` (getter over header.id). */
export function sessionIdOf(session) {
  try {
    if (session && typeof session.id === "string" && session.id.length > 0) return session.id;
  } catch (_) {
    /* fall through */
  }
  const header = headerOf(session);
  return typeof header.id === "string" && header.id.length > 0 ? header.id : "(unknown-session)";
}

/** A delegated (subagent) session - identified by its durable header, not by name. */
export function isDelegatedSession(session) {
  const header = headerOf(session);
  if (header.origin === "subagent") return true;
  if (typeof header.delegationDepth === "number" && header.delegationDepth > 0) return true;
  return false;
}

/** Parent session id of a delegated session, when it declares one. */
export function parentSessionIdOf(session) {
  const header = headerOf(session);
  return typeof header.parentSession === "string" && header.parentSession.length > 0 ? header.parentSession : null;
}

/**
 * Create the decision engine.
 * @param options.config - resolved config (see lib/config.js).
 * @param options.play   - (kind, meta) => void. Wired to the real player in
 *                         lib/index.js; the self-check injects a recorder.
 * @param options.log    - (message) => void.
 * @param options.now    - () => epoch ms (test seam for the throttle).
 */
export function createEngine(options) {
  const opts = options || {};
  const config = opts.config || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const play = typeof opts.play === "function" ? opts.play : function () {};
  const now = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };

  /** sessionId -> { turn, errored } for the turn currently open in that session. */
  const openTurns = new Map();
  /** "sessionId#turn" of already-announced turn ends (dedupe, bounded). */
  const announced = new Set();
  const announcedOrder = [];
  let lastFailAt = 0;

  const stats = {
    turnStarts: 0,
    turnEnds: 0,
    completePlays: 0,
    failPlays: 0,
    failPlaysFromTurnEnd: 0,
    failPlaysImmediate: 0,
    deduped: 0,
    throttled: 0,
    suppressedComplete: 0,
    skippedDelegated: 0,
    skippedDisabled: 0,
    skippedAborted: 0,
    errorsObserved: 0,
    lastEvent: null,
    lastPlay: null,
  };

  function rememberAnnounced(key) {
    announced.add(key);
    announcedOrder.push(key);
    const cap = Number(config.dedupeCacheSize) > 0 ? Number(config.dedupeCacheSize) : 500;
    while (announcedOrder.length > cap) {
      const oldest = announcedOrder.shift();
      announced.delete(oldest);
    }
  }

  function setOpenTurn(sessionId, turn) {
    openTurns.set(sessionId, { turn, errored: false });
    if (openTurns.size > 512) {
      // defensive: a crashed session may never deliver turn/end
      const firstKey = openTurns.keys().next();
      if (!firstKey.done) openTurns.delete(firstKey.value);
    }
  }

  function markErrored(sessionId) {
    if (!sessionId) return false;
    const entry = openTurns.get(sessionId);
    if (!entry) return false;
    entry.errored = true;
    return true;
  }

  /** The one place that gates the 5s error throttle. */
  function failAllowed() {
    const min = Number(config.errorMinIntervalMs);
    if (!(min > 0)) return true;
    return now() - lastFailAt >= min;
  }

  function stampFail() {
    lastFailAt = now();
  }

  /**
   * Anti-"fail then complete" chain gate (user decision 2026-09-15).
   *
   * A fail cue (agent/error or tools/result, or a manual fail) is followed within
   * a few hundred ms by the turn/end of THAT SAME turn - which used to play the
   * complete cue right on top of it ("连声"). Any complete cue landing within
   * suppressCompleteAfterFailMs of the last FAIL cue is therefore suppressed.
   * Independent of errorMinIntervalMs (that one throttles fail cues themselves);
   * 0 disables this gate.
   */
  function completeAllowedAfterFail() {
    const window = Number(config.suppressCompleteAfterFailMs);
    if (!(window > 0)) return true;
    if (lastFailAt === 0) return true;
    return now() - lastFailAt >= window;
  }

  function emit(kind, meta) {
    stats.lastPlay = { kind, at: now(), meta };
    if (kind === "fail") stats.failPlays++;
    else if (kind === "complete") stats.completePlays++;
    try {
      play(kind, meta);
    } catch (error) {
      log("play callback threw (kind=" + kind + "): " + errText(error));
    }
  }

  /**
   * `session/event` handler: (session, event).
   * Only turn/start and turn/end are meaningful here.
   */
  function onSessionEvent(session, event) {
    try {
      const type = event && event.type;
      if (type !== "turn/start" && type !== "turn/end") return;
      if (config.enabled === false || config.playOnTurnEnd === false) {
        stats.skippedDisabled++;
        return;
      }
      const delegated = isDelegatedSession(session);
      if (delegated && config.skipSubagentSessions !== false) {
        stats.skippedDelegated++;
        return;
      }
      const sessionId = sessionIdOf(session);
      const data = (event && event.data) || {};

      if (type === "turn/start") {
        stats.turnStarts++;
        setOpenTurn(sessionId, data.turn);
        stats.lastEvent = { type, sessionId, turn: data.turn };
        return;
      }

      stats.turnEnds++;
      const entry = openTurns.get(sessionId);
      openTurns.delete(sessionId);
      const turn = data.turn;
      const key = sessionId + "#" + String(turn);
      if (announced.has(key)) {
        stats.deduped++;
        log("turn/end already announced, skipping: " + key);
        return;
      }
      rememberAnnounced(key);

      const reasonKind = data.reason && data.reason.kind ? String(data.reason.kind) : "(none)";
      const erroredInTurn = Boolean(entry && entry.errored) || reasonKind === "error";
      stats.lastEvent = { type, sessionId, turn, reasonKind, erroredInTurn };

      let kind;
      if (erroredInTurn && config.turnEndPlaysFailWhenErrored !== false) {
        kind = "fail";
      } else if (reasonKind === "error" || reasonKind === "blocked") {
        kind = "fail";
      } else if (reasonKind === "aborted") {
        if (config.abortPlays === "complete") kind = "complete";
        else if (config.abortPlays === "fail") kind = "fail";
        else {
          stats.skippedAborted++;
          log("turn/end aborted - no voice (abortPlays=none): " + key);
          return;
        }
      } else {
        kind = "complete";
      }

      if (kind === "fail") {
        if (!failAllowed()) {
          stats.throttled++;
          log("turn/end fail suppressed by errorMinIntervalMs: " + key);
          return;
        }
        stampFail();
        stats.failPlaysFromTurnEnd++;
      } else if (kind === "complete" && !completeAllowedAfterFail()) {
        stats.suppressedComplete++;
        log(
          "turn/end complete suppressed by suppressCompleteAfterFailMs (" +
            Number(config.suppressCompleteAfterFailMs) +
            "ms since the last fail): " +
            key,
        );
        return;
      }
      emit(kind, { source: "turn-end", sessionId, turn, reasonKind, erroredInTurn });
    } catch (error) {
      log("onSessionEvent failed: " + errText(error));
    }
  }

  /** `agent/error` handler: {agent, turn, step, error}. */
  function onAgentError(payload) {
    try {
      if (config.enabled === false || config.playFailOnError === false) return;
      const agent = payload && payload.agent;
      const session = agent && agent.session;
      const delegated = isDelegatedSession(session);
      if (delegated && config.countSubagentErrors !== true) return;
      stats.errorsObserved++;
      const sessionId = delegated ? parentSessionIdOf(session) || sessionIdOf(session) : sessionIdOf(session);
      const marked = markErrored(sessionId);
      if (!failAllowed()) {
        stats.throttled++;
        log("agent/error fail suppressed by errorMinIntervalMs (turn marked errored=" + marked + ")");
        return;
      }
      stampFail();
      stats.failPlaysImmediate++;
      emit("fail", {
        source: "agent/error",
        sessionId,
        turn: payload && payload.turn,
        step: payload && payload.step,
        error: errText(payload && payload.error),
        markedOpenTurn: marked,
      });
    } catch (error) {
      log("onAgentError failed: " + errText(error));
    }
  }

  /** `tools/result` handler: (exec, result) - result.isError marks a failed tool call. */
  function onToolResult(exec, result) {
    try {
      if (config.enabled === false || config.playFailOnError === false) return;
      if (!result || result.isError !== true) return;
      const agent = exec && exec.agent;
      const session = agent && agent.session;
      const delegated = isDelegatedSession(session);
      if (delegated && config.countSubagentErrors !== true) return;
      stats.errorsObserved++;
      const sessionId = delegated ? parentSessionIdOf(session) || sessionIdOf(session) : sessionIdOf(session);
      const marked = markErrored(sessionId);
      if (!failAllowed()) {
        stats.throttled++;
        log("tools/result fail suppressed by errorMinIntervalMs (turn marked errored=" + marked + ")");
        return;
      }
      stampFail();
      stats.failPlaysImmediate++;
      emit("fail", {
        source: "tools/result",
        sessionId,
        tool: exec && exec.name,
        callId: exec && exec.callId,
        markedOpenTurn: marked,
      });
    } catch (error) {
      log("onToolResult failed: " + errText(error));
    }
  }

  /**
   * Manual trigger (diagnostic HTTP route or the credential-free control file).
   * Bypasses the turn logic but keeps the shared fail bookkeeping, so a manual
   * fail also suppresses an imminent complete cue.
   */
  function playManual(kind) {
    if (kind === "fail") {
      stampFail();
      stats.failPlaysImmediate++;
    }
    emit(kind, { source: "manual" });
    return { ok: true, kind };
  }

  function snapshot() {
    return {
      enabled: config.enabled !== false,
      stats: Object.assign({}, stats),
      openTurns: openTurns.size,
      announcedKeys: announced.size,
      lastFailAt,
    };
  }

  function dispose() {
    openTurns.clear();
    announced.clear();
    announcedOrder.length = 0;
  }

  return {
    onSessionEvent,
    onAgentError,
    onToolResult,
    playManual,
    snapshot,
    dispose,
  };
}
