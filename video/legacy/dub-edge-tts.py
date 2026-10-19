#!/usr/bin/env python3
"""Sinh giong doc tieng Anh cho video demo, dat dung vao moc thoi gian tung doan.

    python3 video/legacy/dub-edge-tts.py

Video 1:42. Doan nao bat dau o giay bao nhieu thi doan do se chay dung giay
do — khong phai dem so: giong doc dai ngan hay ngan hon du khoe, va neu keo
theo so thi lan cuoi se lech khoi hinh.

Mac dinh im lang giua cac doan. Doan cuoi phai ket thuc truoc khi video het.
"""

import shutil
import subprocess
import sys
from pathlib import Path

VOICE = "en-US-AndrewNeural"
RATE = "-6%"
SR = 44100  # edge-tts xuat 24kHz; nang len 44.1k de moi player deu an

# Video goc 1:42 trong do 50 giay dau chi la go lenh. Cat xoa do, giu lai
# phan co hinh de doc: 0:50-1:12 (bang profile), 1:18-1:41. Con 46 giay.
CUTS = [(50, 22), (78, None)]
VIDEO_LEN = 46.0

# Terminal 42 dong nhung output chi 22 dong, nua duoi khung la den. Cat theo
# vung noi dung de khung hinh khong bi chay 70% mau den.
CROP = "crop=1280:430:0:0"

# (giay bat dau, noi dung). Moc thoi gian do ra tu doc video.
SEGMENTS = [
    (1, "This is oc-harness list."),
    (5, "Every profile is a set of values calibrated against one vendor's "
        "behaviour, and it tells you which one."),
    (13, "Look at the retention column. Three of these are may-train: the file "
         "is retained even though the base model is not."),
    (23, "Now the installable line. The provider you train on does not have to "
         "be the provider you ship with."),
    (29, "Now oc-harness verify. It checks your installed config against the "
         "profile, and exits non-zero on drift."),
    (37, "Config matches. Instruction resolves. Plugin linked. Eleven skills valid."),
    (43, "Install is consistent with the profile."),
]

ETTS = next(
    (p for p in (
        Path.home() / "harness/.repos/voicecare-scheduler-git/.venv/bin/edge-tts",
        Path("/Users/admin/harness/.repos/voicecare-scheduler-git/.venv/bin/edge-tts"),
    ) if p.exists()),
    None,
)
if ETTS is None:
    sys.exit("khong tim thay edge-tts. Cai: pip install edge-tts")


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path)],
        capture_output=True, text=True,
    ).stderr
    for line in out.splitlines():
        if "Duration:" in line:
            h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    raise RuntimeError(f"khong doc duoc dai {path}")


def cut_video(src: Path, work: Path) -> Path:
    """Cat phan go chu khong gi lai, giu phan co hinh de doc."""
    parts, cat = [], work / "concat.txt"
    for n, (start, dur) in enumerate(CUTS):
        part = work / f"part{n}.mp4"
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start)]
        if dur:
            cmd += ["-t", str(dur)]
        subprocess.run(cmd + ["-i", str(src), "-c:v", "libx264", "-preset", "slow",
                              "-crf", "18", "-pix_fmt", "yuv420p",
                              "-vf", CROP, str(part)], check=True)
        parts.append(part)
    cat.write_text("".join(f"file '{p}'\n" for p in parts))
    out = work / "cut.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", str(cat), "-c", "copy", str(out)], check=True)
    print(f"  video: {VIDEO_LEN:.0f}s, cat {len(CUTS)} doan")
    return out


def main() -> int:
    work = Path("/tmp/dub")
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    # Ban quay goc khong luu trong repo: no la 1:42, phan dau chi la go lenh.
    # Can hoi lai thi lay tu lich su git thay vi giu mot ban 644 KB khong ai dung:
    #     git show HEAD~1:docs/demo.mp4 > docs/demo-raw.mp4
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else \
        Path(__file__).resolve().parent / "demo-raw.mp4"
    if not src.exists():
        sys.exit(
            f"thieu ban quay goc: {src}\n"
            "  lay lai: git show HEAD~1:docs/demo.mp4 > docs/demo-raw.mp4\n"
            "  hoac truyen duong dan: python3 docs/dub.py /path/to/raw.mp4"
        )
    cut_video(src, work)

    parts = []
    for i, (at, text) in enumerate(SEGMENTS):
        seg = work / f"{i:02d}.mp3"
        subprocess.run(
            [str(ETTS), "--voice", VOICE, f"--rate={RATE}",
             "--text", text, "--write-media", str(seg)],
            check=True, capture_output=True,
        )
        d = duration(seg)
        end = at + d
        print(f"  {at:3d}s -> {end:5.1f}s  ({d:.1f}s)  {text[:52]}")
        if end > VIDEO_LEN:
            print(f"  CANH BAO: doan {i} ket thuc luc {end:.1f}s, vuot video")
        parts.append((at, seg))

    # Dat moi doan vao dung phien ban 1 giay, roi cong lai.
    final = work / "narration.wav"
    concat = work / "concat.txt"
    for at, seg in parts:
        padded = work / f"{seg.stem}-pad.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(seg),
             "-af", f"adelay={int(at * 1000)}|{int(at * 1000)},"
                    f"apad,atrim=0:{VIDEO_LEN},aresample={SR}",
             "-ac", "1", str(padded)],
            check=True,
        )
        concat.write_text(f"file '{padded}'\n")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(concat), "-ac", "1", "-ar", str(SR), str(final)],
        check=True,
    )
    print(f"\nnarration: {final}  ({duration(final):.1f}s)")

    mixed = work / "final.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(work / "cut.mp4"),
         "-i", str(final), "-c:v", "copy", "-c:a", "aoc:aac".replace("aoc:aac", "aac"),
         "-b:a", "128k", str(mixed)], check=True)
    print(f"mixed:    {mixed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())