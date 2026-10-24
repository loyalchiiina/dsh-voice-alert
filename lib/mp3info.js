/**
 * Minimal MP3 duration reader - no dependencies, no ffmpeg.
 *
 * Why this exists (2026-10-24): both `notePlayback` (index.js) and
 * `estimatePlayMs` (index.js) used to guess playback length from the file size
 * divided by a hard-coded bitrate (192 kbps / 160 kbps). The real cue files are
 * 64 kbps CBR, so every estimate came out ~67% too short: a 21.4s cue was
 * treated as 7.1s. The playback slot was released ~14s early, the next cue
 * grabbed the sound card while the first was still playing, and the second
 * process failed silently (this is the "sometimes 试听 makes no sound" report).
 * Sound effects are 128 kbps VBR, so a single constant could never be right.
 *
 * The "导入 MP3" feature makes a fixed constant even less viable: the user can
 * import anything from 32 kbps voice memos to 320 kbps music.
 *
 * So: parse the actual frame headers. Handles ID3v2 skip, ID3v1 tail, CBR and
 * VBR (Xing/Info) streams, MPEG 1 / 2 / 2.5 Layer III. Returns null when the
 * buffer is not a recognisable MP3, and callers fall back to the old estimate.
 */

const BITRATE_TABLE = {
  // MPEG 1 Layer III, kbps
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  // MPEG 2 / 2.5 Layer III, kbps
  v2l3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATE_TABLE = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
};

function readSyncSafeInt(buffer, at) {
  return (
    ((buffer[at] & 0x7f) << 21) |
    ((buffer[at + 1] & 0x7f) << 14) |
    ((buffer[at + 2] & 0x7f) << 7) |
    (buffer[at + 3] & 0x7f)
  );
}

/** Decode one 4-byte Layer III frame header, or null if it is not one. */
function parseFrameHeader(buffer, at) {
  if (at + 4 > buffer.length) return null;
  if (buffer[at] !== 0xff || (buffer[at + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (buffer[at + 1] >> 3) & 0x03; // 0 = MPEG2.5, 2 = MPEG2, 3 = MPEG1
  const layerBits = (buffer[at + 1] >> 1) & 0x03; // 1 = Layer III
  const bitrateIndex = (buffer[at + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[at + 2] >> 2) & 0x03;
  const padding = (buffer[at + 2] >> 1) & 0x01;
  const channelMode = (buffer[at + 3] >> 6) & 0x03; // 3 = mono

  if (versionBits === 1) return null; // reserved
  if (layerBits !== 1) return null; // only Layer III
  if (bitrateIndex === 0 || bitrateIndex === 15) return null; // free-form / invalid
  if (sampleRateIndex === 3) return null;

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const table = version === 1 ? BITRATE_TABLE.v1l3 : BITRATE_TABLE.v2l3;
  const bitrate = table[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATE_TABLE[version][sampleRateIndex];
  const mono = channelMode === 3;
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const frameLength = Math.floor(((version === 1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  // Bytes between the frame header and the Xing/Info tag (or the audio payload).
  const sideInfoLength = version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;

  if (frameLength < 4) return null;

  return {
    version,
    bitrate,
    sampleRate,
    samplesPerFrame,
    frameLength,
    sideInfoLength,
  };
}

/**
 * Scan forward for a frame header whose successor header lands exactly where it
 * predicts. That two-frame agreement is what separates a real frame sync from a
 * 0xFF 0xE? byte pair that happens to appear inside tag data.
 */
function findFirstFrame(buffer, from) {
  const limit = Math.min(buffer.length - 4, from + 65536);
  for (let at = from; at <= limit; at++) {
    const header = parseFrameHeader(buffer, at);
    if (!header) continue;
    const next = parseFrameHeader(buffer, at + header.frameLength);
    if (next && next.sampleRate === header.sampleRate) return { at, header };
  }
  return null;
}

/**
 * @param {Buffer} buffer raw mp3 bytes (a head slice is enough - see totalBytes)
 * @param {number} [totalBytes] real file size when `buffer` is only a head slice.
 *   Only the first frame header and the Xing tag live in the head; the CBR byte
 *   math needs the true total, so callers that pass a slice must pass this too.
 * @returns {{seconds:number, bitrate:number, sampleRate:number, vbr:boolean}|null}
 *   null when the buffer is not a parseable MP3.
 */
export function readMp3Info(buffer, totalBytes) {
  if (!buffer || typeof buffer.length !== "number" || buffer.length < 4) return null;
  const size = Number(totalBytes) > buffer.length ? Number(totalBytes) : buffer.length;

  let start = 0;
  // ID3v2: "ID3" + version(2) + flags(1) + syncsafe size(4). The size excludes the header.
  if (buffer.length >= 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    start = 10 + readSyncSafeInt(buffer, 6);
    if (start >= buffer.length) return null;
  }

  let end = buffer.length;
  // ID3v1: 128-byte "TAG..." trailer, not audio. Only inspectable on a full read -
  // on a head slice those bytes are not the tail, so skip the check.
  if (
    size === buffer.length &&
    end - start >= 128 &&
    buffer[end - 128] === 0x54 &&
    buffer[end - 127] === 0x41 &&
    buffer[end - 126] === 0x47
  ) {
    end -= 128;
  }

  const found = findFirstFrame(buffer, start);
  if (!found) return null;
  const { at, header } = found;

  // VBR streams carry a Xing/Info header (same slot, different brand) that states
  // the exact frame count. Prefer it: byte-counting a VBR stream is wrong.
  const xingAt = at + 4 + header.sideInfoLength;
  if (xingAt + 12 <= buffer.length) {
    const tag = buffer.toString("latin1", xingAt, xingAt + 4);
    if (tag === "Xing" || tag === "Info") {
      const flags = buffer.readUInt32BE(xingAt + 4);
      if (flags & 0x01) {
        const frames = buffer.readUInt32BE(xingAt + 8);
        if (frames > 0) {
          const seconds = (frames * header.samplesPerFrame) / header.sampleRate;
          if (seconds > 0 && Number.isFinite(seconds)) {
            const audioBytes = Math.max(0, size - at);
            return {
              seconds,
              bitrate: Math.round((audioBytes * 8) / seconds),
              sampleRate: header.sampleRate,
              vbr: true,
            };
          }
        }
      }
    }
  }

  // CBR: frame length is constant, so audio bytes / bitrate is exact to one frame.
  const audioBytes = Math.max(0, size - at);
  const seconds = (audioBytes * 8) / header.bitrate;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return { seconds, bitrate: header.bitrate, sampleRate: header.sampleRate, vbr: false };
}

/**
 * Convenience wrapper: duration in milliseconds, or null when unknown.
 * Callers should keep their own fallback so a corrupt file never stalls a cue.
 */
export function readMp3DurationMs(buffer, totalBytes) {
  const info = readMp3Info(buffer, totalBytes);
  if (!info) return null;
  const ms = Math.round(info.seconds * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** How many leading bytes are enough to find the first frame + Xing tag. */
export const MP3_HEAD_BYTES = 65536;

/**
 * File-path entry point for playback bookkeeping. Reads only the head plus the
 * real size, so a 40 MB music file costs one 64 KB read per cue instead of a
 * full slurp. Returns null on any IO/parse problem - never throws, because a
 * failed duration lookup must not silence a cue.
 *
 * @param {string} filePath
 * @param {(p:string)=>number} sizeOf  size lookup (statSync wrapper from the caller)
 * @param {(p:string, start:number, end:number)=>Buffer} readRange  ranged read
 */
export function readMp3DurationMsFromFile(filePath, sizeOf, readRange) {
  try {
    const size = sizeOf(filePath);
    if (!(size > 0)) return null;
    const head = readRange(filePath, 0, Math.min(size, MP3_HEAD_BYTES));
    return readMp3DurationMs(head, size);
  } catch (_) {
    return null;
  }
}
