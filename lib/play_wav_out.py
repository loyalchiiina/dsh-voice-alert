"""dsh-voice-alert WAV/waveOut player (备选播放内核, 2026-09-16).

为什么存在
  主内核用 MCI `open ... type mpegvideo`，它走 DirectShow：会创建播放图、枚举/打开
  音频端点。在蓝牙耳机上，这类操作可能触发链路重协商，从而打断其他正在播放的音乐
  （用户 2026-09-16 反馈"播报后音乐显示在播但没声音"）。
  waveOut（winsound）是 Windows 最基础的播放路径：不启 DirectShow 图、不枚举设备、
  不改端点格式，对链路和其他播放器冲击最小。代价是需要 WAV（由 host 侧用 ffmpeg
  一次性转好并缓存）。

与主内核一致的安全规则
  * 只播音频，**绝不读写音量/静音/会话音量**；
  * 播放前仍用 350ms 静音预热端点（蓝牙链路挂起时首播会被静默吞掉）；
  * 🔴 winsound 的 PlaySound 是**进程级独占**：同一进程里第二次调用会打断第一次，
    所以预热与正式播放必须**串行**（不像主内核那样能并行）。

用法: python play_wav_out.py --file <wav 绝对路径> [--log-file <path>] [--no-prewarm]
退出码: 0 = 播放完成, 2 = 无法播放, 3 = 文件缺失
"""
import argparse
import io
import os
import sys
import time
import wave

PREWARM_MS = 350
PREWARM_SETTLE_SECONDS = 0.15
START_TIME = time.time()

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


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
    now = time.time()
    millis = int(round((now % 1) * 1000)) % 1000
    return "%s.%03d" % (time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)), millis)


def since_ms():
    return int(round((time.time() - START_TIME) * 1000))


def log_line(log_path, message):
    if not log_path:
        return
    try:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write("[%s] wav-player: +%dms %s\n" % (stamp(), since_ms(), message))
    except OSError:
        pass


def prewarm_silence(log_path):
    """350ms 静音预热（串行执行，见文件头说明）。"""
    try:
        import winsound

        log_line(log_path, "prewarm start (%d ms silence)" % PREWARM_MS)
        winsound.PlaySound(make_silence_wav(PREWARM_MS), winsound.SND_MEMORY)
        log_line(log_path, "prewarm ok")
        return True
    except Exception as error:
        log_line(log_path, "prewarm failed: %r" % (error,))
        return False


def wav_duration(path):
    try:
        with wave.open(path, "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate() or 1
            return frames / float(rate)
    except Exception:
        return 0.0


def play_wav(path, log_path):
    import winsound

    duration = wav_duration(path)
    if duration <= 0:
        log_line(log_path, "wav unreadable: " + path)
        return 2
    log_line(log_path, "wav open ok duration=%.2fs" % duration)
    try:
        # 同步播放：函数返回即播放结束（进程生命周期 = 播放时长，退出前设备已释放）。
        winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_NODEFAULT)
    except Exception as error:
        log_line(log_path, "PlaySound failed: %r" % (error,))
        return 2
    log_line(log_path, "played (waveOut, synchronous) file=" + path)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, help="absolute path of the WAV to play")
    parser.add_argument("--log-file", default="", help="optional diagnostics log")
    parser.add_argument("--no-prewarm", action="store_true", help="skip the silence prewarm (diagnosis)")
    args = parser.parse_args()
    log_line(args.log_file, "boot (wav engine)")
    if not os.path.exists(args.file):
        log_line(args.log_file, "file missing: " + args.file)
        print("WAV_MISSING " + args.file, file=sys.stderr)
        return 3
    if not args.no_prewarm:
        prewarm_silence(args.log_file)
        time.sleep(PREWARM_SETTLE_SECONDS)
    return play_wav(args.file, args.log_file)


if __name__ == "__main__":
    raise SystemExit(main())
