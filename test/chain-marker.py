"""dsh-voice-alert - launch-chain probe helper (test only).

Proves WHICH spawn shape really reaches the child process on this machine, and
that the `--kind` argument survives the whole chain:

    node -> powershell.exe -> Start-Process -> python <this file> --kind <kind>

A marker file is written from inside that child process. Counting python
processes cannot be used as evidence here - other tools on this box spawn python
constantly (7 were already running) - so the chain test needs a side effect only
our own launch can produce.

Marker path:        env DSH_VOICE_ALERT_CHAIN_MARKER (else %TEMP%\\va-chain-marker.txt)
Optional busy stay: env DSH_VOICE_ALERT_CHAIN_STAY seconds (default 0)
Exit code is always 0 so the launcher sees a clean run.
"""
import os
import sys
import time


def main():
    marker = os.environ.get("DSH_VOICE_ALERT_CHAIN_MARKER") or os.path.join(
        os.environ.get("TEMP", "."), "va-chain-marker.txt"
    )
    kind = None
    if "--kind" in sys.argv:
        index = sys.argv.index("--kind")
        if index + 1 < len(sys.argv):
            kind = sys.argv[index + 1]
    audio_file = None
    if "--file" in sys.argv:
        index = sys.argv.index("--file")
        if index + 1 < len(sys.argv):
            audio_file = sys.argv[index + 1]
    try:
        with open(marker, "w", encoding="utf-8") as handle:
            handle.write("kind=%s\n" % kind)
            handle.write("file=%s\n" % audio_file)
            handle.write("argv=%r\n" % (sys.argv,))
            handle.write("pid=%d\n" % os.getpid())
    except OSError:
        return 0
    try:
        stay = float(os.environ.get("DSH_VOICE_ALERT_CHAIN_STAY", "0") or 0)
    except ValueError:
        stay = 0.0
    if stay > 0:
        time.sleep(stay)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
