"""Create a browser-compatible, silent WebM preview without changing the source."""

from __future__ import annotations

import math
import os
import sys
from pathlib import Path

import cv2


def even(value: float) -> int:
    return max(2, int(value) // 2 * 2)


def main() -> int:
    if len(sys.argv) != 5:
        print("usage: transcode-video-preview.py INPUT OUTPUT MAX_WIDTH MAX_FPS", file=sys.stderr)
        return 2

    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    max_width = max(320, int(sys.argv[3]))
    max_fps = max(1.0, float(sys.argv[4]))
    temporary = destination.with_name(f".{destination.stem}-{os.getpid()}.tmp.webm")
    destination.parent.mkdir(parents=True, exist_ok=True)

    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        print(f"cannot open source video: {source}", file=sys.stderr)
        return 3

    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0) or 20.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if width <= 0 or height <= 0:
        capture.release()
        print("source video has invalid dimensions", file=sys.stderr)
        return 4

    scale = min(1.0, max_width / width)
    output_size = (even(width * scale), even(height * scale))
    sample_step = max(1, math.ceil(source_fps / max_fps))
    output_fps = source_fps / sample_step
    writer = cv2.VideoWriter(
        str(temporary),
        cv2.VideoWriter_fourcc(*"VP80"),
        output_fps,
        output_size,
    )
    if not writer.isOpened():
        capture.release()
        print("OpenCV cannot create a VP8 WebM preview", file=sys.stderr)
        return 5

    source_index = 0
    output_frames = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if source_index % sample_step == 0:
                if (frame.shape[1], frame.shape[0]) != output_size:
                    frame = cv2.resize(frame, output_size, interpolation=cv2.INTER_AREA)
                writer.write(frame)
                output_frames += 1
            source_index += 1
    finally:
        capture.release()
        writer.release()

    if output_frames == 0 or not temporary.exists() or temporary.stat().st_size == 0:
        temporary.unlink(missing_ok=True)
        print("source video did not yield any preview frames", file=sys.stderr)
        return 6

    os.replace(temporary, destination)
    print(
        f"preview ready: frames={output_frames} fps={output_fps:.3f} "
        f"size={output_size[0]}x{output_size[1]} bytes={destination.stat().st_size}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
