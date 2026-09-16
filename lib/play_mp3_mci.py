"""dsh-voice-alert bundled MCI player (zero volume interference).

WHY THIS EXISTS
  A shared local player (optional, lives outside this plugin) takes only
  `--kind` and therefore always plays the ORIGINAL MP3s, which measure
  mean_volume about -20.8 dB (too quiet). The fix is a louder COPY of each file
  (built by dev-audio-loud.ps1 into <data>\\audio), and playing an arbitrary file
  needs this extended entry point.

MECHANISM - IDENTICAL TO THE SHARED PLAYER, ON PURPOSE
  winmm/MCI "open ... type mpegvideo / play" plays the file AS-IS:
    * whatever the system volume is, that is how loud it plays;
    * muted system -> silent;
    * no audio control interface is ever read or written (no volume change, no
      mute change, no per-application session volume).

🔴 2026-09-16 「有时点试听没声音」的根因与修复（实测，不是猜）
  用户反馈：刚生成语音后点试听没声音，**手动调一下系统音量就有声音了**。
  探针实测（本机一次性 MCI + Core Audio 探针脚本，不随包发布）：
    open rc=0 / play rc=0 / status position 229→482→733→983 ms / mode=playing
    → MCI 认为"正在正常播放"，音频数据确实在流。
  同时 Core Audio 探针读出**默认输出设备 = 蓝牙耳机**（三个 role 一致）。
  结论：蓝牙 A2DP 链路空闲后会挂起/断开，这段时间 Windows 仍把音频"成功"送进
  驱动，但耳机端没有真正出声；用户调节系统音量会立刻激活链路，所以"调一下音量
  之后就有声音"。对策：播放前用 **350 ms 静音预热默认端点**（见下）。
  预热只播静音：**不读写任何音量/静音接口**（上面那条硬规则不变）。

🔴 2026-09-16 延迟优化（用户要求：对话结束到出声要更快）
  实测链路：turn-end → 触发播放只差 1ms；但"出声"还要等 进程启动 + 预热 + 打开文件。
  改动：**预热与 MCI open 并行**（预热在子线程里播静音，主线程同时 open），
  省掉整个 open 的时间（约 100~200 ms），**唤醒效果不变**（预热仍是 350 ms 静音
  + 150 ms 稳定等待）。
  同时日志升级为**毫秒级 + 阶段耗时**（`+123ms play issued rc=0`），这样 host 侧
  能用同一时间轴精确算出「turn 结束 → 真正出声」到底花了多久。

另修一处旧缺陷：MCI `play` 的返回码以前被完全忽略，播放失败会被当作"播完了"
（静默误报成功）。现在检查返回码，失败重试一次，并把全过程写进 `--log-file`。

Usage: python play_mp3_mci.py --file <absolute path> [--max-seconds N]
                               [--delete-after-play] [--log-file <path>]
Exit codes: 0 = played, 2 = MCI could not open the file, 3 = file missing
"""
import argparse
import ctypes
import io
import os
import sys
import threading
import time
import wave

DEFAULT_MAX_SECONDS = 30
PREWARM_MS = 350
PREWARM_SETTLE_SECONDS = 0.15

# 进程启动时刻：所有日志都带 `+Nms`，host 日志与它对时间轴即可精确算延迟。
START_TIME = time.time()


def make_silence_wav(milliseconds, rate=44100):
    """生成一段单声道 16bit 静音 WAV（内存中，不落盘）。"""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * int(rate * milliseconds / 1000))
    return buffer.getvalue()


def stamp():
    """本地时间戳，毫秒精度。"""
    now = time.time()
    millis = int(round((now % 1) * 1000)) % 1000
    return "%s.%03d" % (time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)), millis)


def since_ms():
    """相对进程启动的毫秒数（延迟分析用）。"""
    return int(round((time.time() - START_TIME) * 1000))


def log_line(log_path, message):
    """诊断日志（只在调用方给了 --log-file 时写）；失败绝不影响播放。"""
    if not log_path:
        return
    try:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write("[%s] sfx-player: +%dms %s\n" % (stamp(), since_ms(), message))
    except OSError:
        pass


def prewarm_silence(log_path, prewarm_ms=PREWARM_MS):
    """用一段静音唤醒默认输出端点（在子线程里跑，与 MCI open 并行）。

    同步播放（winsound 不带 SND_ASYNC）= 阻塞 prewarm_ms 毫秒，正好给链路建立的时间。
    只播静音：不触碰任何音量/静音设置。
    """
    try:
        import winsound

        log_line(log_path, "prewarm start (%d ms silence)" % prewarm_ms)
        winsound.PlaySound(make_silence_wav(prewarm_ms), winsound.SND_MEMORY)
        log_line(log_path, "prewarm ok")
        return True
    except Exception as error:  # 预热失败也必须继续播（只是回到旧行为）
        log_line(log_path, "prewarm failed: %r" % (error,))
        return False


def play_mp3(path, max_seconds, log_path, prewarm, prewarm_ms=PREWARM_MS):
    winmm = ctypes.windll.winmm
    buffer = ctypes.create_unicode_buffer(256)
    alias = "dshvoice%d" % (os.getpid() % 100000)

    # 1) 预热先在子线程里起（并行），主线程立刻去打开文件 —— 两件事重叠，省掉 open 的时间。
    warm = None
    if prewarm:
        warm = threading.Thread(target=prewarm_silence, args=(log_path, prewarm_ms), daemon=True)
        warm.start()

    # 2) 打开文件（与预热并行进行）
    open_command = 'open "%s" type mpegvideo alias %s' % (path, alias)
    rc_open = winmm.mciSendStringW(open_command, buffer, 255, 0)
    log_line(log_path, "mci open rc=%d" % rc_open)
    if rc_open != 0:
        log_line(log_path, "open failed rc=%d err=%s file=%s" % (rc_open, buffer.value, path))
        if warm is not None:
            warm.join(timeout=2.0)
        return 2

    try:
        # 3) 等预热放完（open 已经在这段时间里做完了），再让出一点点给链路稳定
        if warm is not None:
            warm.join(timeout=2.0)
        if prewarm:
            time.sleep(PREWARM_SETTLE_SECONDS)

        rc_play = winmm.mciSendStringW("play %s" % alias, None, 0, 0)
        log_line(log_path, "play issued rc=%d" % rc_play)
        if rc_play != 0:
            # 旧版本忽略了这个返回码 → 播放失败被当成"播完了"（静默误报成功）。
            log_line(log_path, "play rc=%d, retrying once" % rc_play)
            time.sleep(0.3)
            rc_play = winmm.mciSendStringW("play %s" % alias, None, 0, 0)
            log_line(log_path, "play retry rc=%d" % rc_play)

        positions = []
        last_mode = ""
        deadline = time.time() + max(1.0, float(max_seconds))
        while time.time() < deadline:
            time.sleep(0.2)
            if winmm.mciSendStringW("status %s position" % alias, buffer, 255, 0) == 0:
                positions.append(buffer.value)
            if winmm.mciSendStringW("status %s mode" % alias, buffer, 255, 0) != 0:
                break
            last_mode = buffer.value
            if last_mode == "stopped":
                break
        log_line(
            log_path,
            "played play_rc=%d mode=%s positions=%s file=%s"
            % (rc_play, last_mode or "?", ",".join(positions[:6]) or "-", path),
        )
    finally:
        winmm.mciSendStringW("close %s" % alias, None, 0, 0)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, help="absolute path of the mp3 to play")
    parser.add_argument("--max-seconds", type=float, default=DEFAULT_MAX_SECONDS)
    parser.add_argument(
        "--delete-after-play",
        action="store_true",
        help="remove the file once playback ended (used for the scratch playback copy)",
    )
    parser.add_argument(
        "--log-file",
        default="",
        help="optional diagnostics log (open/play return codes, prewarm, position samples)",
    )
    parser.add_argument(
        "--no-prewarm",
        action="store_true",
        help="skip the silence prewarm (diagnosis only; the prewarm is the fix for muted first plays)",
    )
    parser.add_argument(
        "--prewarm-ms",
        type=int,
        default=PREWARM_MS,
        help="prewarm silence length in ms (default %d); longer = safer wake-up on Bluetooth" % PREWARM_MS,
    )
    args = parser.parse_args()
    log_line(args.log_file, "boot")
    if not os.path.exists(args.file):
        log_line(args.log_file, "file missing: " + args.file)
        print("MP3_MISSING " + args.file, file=sys.stderr)
        return 3
    code = play_mp3(args.file, args.max_seconds, args.log_file, not args.no_prewarm, args.prewarm_ms)
    if args.delete_after_play:
        # Best effort: the plugin also prunes stale copies, so a failure here is fine.
        try:
            os.remove(args.file)
        except OSError:
            pass
    return code


if __name__ == "__main__":
    raise SystemExit(main())
