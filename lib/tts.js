// dsh-voice-alert - ByteDance/Volcengine TTS (豆包 cloned + Agent-Plan preset) client.
//
// CONTRACT (taken from a working reference implementation, so the request shapes are
// the proven ones rather than guesses):
//   cloned voice  -> POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
//                    headers: X-Api-Key (console key), X-Api-Resource-Id: seed-icl-2.0,
//                    body req_params: { text, speaker, model, audio_params {...} }
//   preset voice  -> POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional
//                    headers: X-Api-Key (Agent-Plan ark-… key), X-Api-Resource-Id: seed-tts-2.0,
//                    body req_params: { text, speaker, audio_params {...} }  // NO model field
//   stream: one JSON object per line; code 0 carries base64 audio in `data`,
//           code 20000000 ends the stream, anything else with a `message` is an error.
//
// 🔴 The keys come from the RUNTIME config (config.json / env) and are never baked
// into this file: the plugin is meant to be publishable later. Every synthesis is
// routed by the voice's `kind` (clone|preset) - mixing endpoints/resources/keys
// across kinds is exactly what 403/401s on the vendor side.

import { randomUUID } from "node:crypto";
import { VOICE_KIND_ROUTES } from "./config.js";

export const TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
export const TTS_PRESET_ENDPOINT = "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional";
export const END_CODE = 20000000;

function errText(error) {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

/**
 * Build the exact request for one synthesis, routed by the voice's kind.
 * Pure - the self-check asserts the endpoint/key/resource/speaker selection.
 * @param text - the sentence to speak.
 * @param config - resolved config (tts.* / presetApiKey / prosody / voices).
 * @param voice - { id, kind: "clone"|"preset" }; when omitted, the legacy
 *   behavior applies (clone route with config.tts.speaker).
 * @param options - { requestId } uuid override (test seam).
 * @returns { url, headers, body, kind }
 */
export function buildTtsRequestForVoice(text, config, voice, options) {
  const opts = options || {};
  const tts = config.tts || {};
  const prosody = config.prosody || {};
  const kind = voice && voice.kind === "preset" ? "preset" : "clone";
  const route = kind === "preset" ? VOICE_KIND_ROUTES.preset : VOICE_KIND_ROUTES.clone;

  const endpoint =
    kind === "preset"
      ? String((route && route.endpoint) || TTS_PRESET_ENDPOINT)
      : String(tts.endpoint || TTS_ENDPOINT);
  const resourceId = kind === "preset" ? String((route && route.resourceId) || "seed-tts-2.0") : String(tts.resourceId || "seed-icl-2.0");
  const apiKey = kind === "preset" ? String(config.presetApiKey || "") : String(tts.apiKey || "");
  const speaker = voice && voice.id ? String(voice.id) : String(tts.speaker || "");

  const body = {
    req_params: {
      text: String(text),
      speaker,
      audio_params: {
        format: String(tts.format || "mp3"),
        sample_rate: Number(tts.sampleRate) > 0 ? Number(tts.sampleRate) : 24000,
        speed_ratio: Number(prosody.speed_ratio) > 0 ? Number(prosody.speed_ratio) : 1.0,
        pitch_ratio: Number(prosody.pitch_ratio) > 0 ? Number(prosody.pitch_ratio) : 1.0,
        volume_ratio: Number(prosody.volume_ratio) > 0 ? Number(prosody.volume_ratio) : 1.0,
      },
    },
  };
  // The cloned-voice endpoint takes a `model`; the Agent-Plan preset endpoint does
  // NOT (the official sample omits it there), so it is only attached for clone.
  if (kind !== "preset") body.req_params.model = String(tts.model || "seed-tts-2.0-standard");

  return {
    url: endpoint,
    headers: {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": opts.requestId || randomUUID(),
      "Content-Type": "application/json",
      Connection: "keep-alive",
    },
    body: JSON.stringify(body),
    kind,
  };
}

/**
 * Legacy single-kind builder (kept for the existing self-check and tooling):
 * the cloned route with config.tts.speaker.
 */
export function buildTtsRequest(text, config, requestId) {
  return buildTtsRequestForVoice(
    text,
    config,
    { id: String((config.tts && config.tts.speaker) || ""), kind: "clone" },
    { requestId },
  );
}

/**
 * Parse one NDJSON line of the stream.
 * @returns { kind: "audio"|"end"|"error"|"ignore", bytes?, message?, code? }
 */
export function parseTtsLine(line) {
  const trimmed = String(line || "").trim();
  if (trimmed.length === 0) return { kind: "ignore" };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    return { kind: "ignore" };
  }
  if (parsed === null || typeof parsed !== "object") return { kind: "ignore" };
  const code = parsed.code;
  if (code === 0 && typeof parsed.data === "string" && parsed.data.length > 0) {
    return { kind: "audio", bytes: Buffer.from(parsed.data, "base64"), code };
  }
  if (code === END_CODE) return { kind: "end", code };
  if (typeof parsed.message === "string" && parsed.message.length > 0) {
    return { kind: "error", code, message: parsed.message };
  }
  return { kind: "ignore", code };
}

/**
 * Synthesize one sentence, routed by the voice kind.
 * @param options.text - the sentence.
 * @param options.config - resolved config.
 * @param options.voice - { id, kind }; omitted = legacy clone route.
 * @param options.log - logger.
 * @param options.fetchImpl - fetch override (self-check mock).
 * @param options.requestId - uuid override (test seam).
 * @returns { ok, bytes?, code?, error?, reason?, requestId? } (never throws)
 */
export async function synthesize(options) {
  const opts = options || {};
  const config = opts.config || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const request = buildTtsRequestForVoice(opts.text, config, opts.voice || null, { requestId: opts.requestId });

  if (!request.headers["X-Api-Key"]) {
    // Refuse loudly with a dedicated code: silently using the WRONG key (e.g. the
    // console key against the preset endpoint) is exactly the 403/401 trap.
    if (request.kind === "preset") {
      return {
        ok: false,
        reason: "preset-key-missing",
        error:
          "预设音色需要 Agent Plan Key（ark-…）：请在 config.json 的 presetApiKey 或设置页「音色库 → 预设音色 Key」填入。",
      };
    }
    return {
      ok: false,
      reason: "api-key-missing",
      error: "TTS API key missing: set tts.apiKey in config.json (or DSH_VOICE_ALERT_TTS_KEY)",
    };
  }
  if (typeof doFetch !== "function") {
    return { ok: false, error: "global fetch unavailable in this Node runtime" };
  }

  const timeoutMs = Number(config.tts && config.tts.timeoutMs) > 0 ? Number(config.tts.timeoutMs) : 120000;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller === null ? null : setTimeout(function () {
    try {
      controller.abort();
    } catch (_) {
      /* already settled */
    }
  }, timeoutMs);
  if (timer && typeof timer.unref === "function") timer.unref();

  try {
    const response = await doFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller ? controller.signal : undefined,
    });
    if (!response || !response.ok) {
      const status = response ? response.status : "(no response)";
      return { ok: false, error: "TTS HTTP " + String(status) };
    }
    const chunks = [];
    const decoder = new TextDecoder();
    let buffered = "";
    let endCode = null;
    let streamError = null;

    const consume = function (text) {
      buffered += text;
      let at = buffered.indexOf("\n");
      while (at >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        const parsed = parseTtsLine(line);
        if (parsed.kind === "audio") chunks.push(parsed.bytes);
        else if (parsed.kind === "end") endCode = parsed.code;
        else if (parsed.kind === "error") streamError = "TTS error " + String(parsed.code) + ": " + parsed.message;
        at = buffered.indexOf("\n");
      }
    };

    const body = response.body;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        consume(decoder.decode(step.value, { stream: true }));
        if (endCode !== null || streamError !== null) {
          try {
            await reader.cancel();
          } catch (_) {
            /* stream already closing */
          }
          break;
        }
      }
    } else if (typeof response.text === "function") {
      consume(await response.text());
    }
    if (buffered.trim().length > 0) {
      const parsed = parseTtsLine(buffered);
      if (parsed.kind === "audio") chunks.push(parsed.bytes);
      else if (parsed.kind === "end") endCode = parsed.code;
      else if (parsed.kind === "error") streamError = "TTS error " + String(parsed.code) + ": " + parsed.message;
    }

    if (streamError !== null) return { ok: false, error: streamError };
    if (chunks.length === 0) return { ok: false, error: "TTS returned no audio" };
    const bytes = Buffer.concat(chunks);
    log("tts: synthesized " + bytes.length + " bytes (end code " + String(endCode) + ")");
    return { ok: true, bytes, code: endCode, kind: request.kind, requestId: request.headers["X-Api-Request-Id"] };
  } catch (error) {
    return { ok: false, error: "TTS request failed: " + errText(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
