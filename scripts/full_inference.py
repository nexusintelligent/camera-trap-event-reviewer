"""Prepare photos and sampled video frames for either full-mode AI pipeline.

Metrics describe measured wall time; library model-load counts are intentionally
not inferred. A video decode failure fails the event instead of labeling it empty.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import runpy
import shutil
import sys
import time

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXTENSIONS = {".avi", ".mp4", ".mov"}


def prepare_media(input_root, photo_root, sample_seconds, metrics):
    photo_root.mkdir(parents=True, exist_ok=True)
    for source in sorted(input_root.iterdir()):
        if source.suffix.lower() in IMAGE_EXTENSIONS:
            target = photo_root / source.name
            try:
                os.link(source, target)
            except OSError:
                shutil.copyfile(source, target)
        elif source.suffix.lower() in VIDEO_EXTENSIONS:
            import cv2
            started = time.perf_counter()
            capture = cv2.VideoCapture(str(source))
            metrics["videosOpened"] += 1
            frames = 0
            try:
                if not capture.isOpened():
                    raise RuntimeError(f"Cannot open video: {source.name}")
                fps = capture.get(cv2.CAP_PROP_FPS)
                if not math.isfinite(fps) or fps <= 0:
                    raise RuntimeError(f"Invalid video frame rate: {source.name}")
                stride = max(1, round(fps * sample_seconds))
                index = 0
                # Sequential grab avoids inaccurate keyframe seeking; only sampled
                # frames are retrieved and passed to the recognition pipeline.
                while capture.grab():
                    if index % stride == 0:
                        ok, frame = capture.retrieve()
                        if not ok:
                            raise RuntimeError(f"Cannot decode frame {index}: {source.name}")
                        target = photo_root / f"{source.stem}-frame-{index:09d}.jpg"
                        if not cv2.imwrite(str(target), frame):
                            raise RuntimeError(f"Cannot save sampled frame: {target.name}")
                        frames += 1
                        metrics["videoFramesDecoded"] += 1
                    index += 1
                if not frames:
                    raise RuntimeError(f"Video contains no readable frames: {source.name}")
            finally:
                capture.release()
                metrics["videoDecodeSeconds"] += time.perf_counter() - started
    if not any(photo_root.iterdir()):
        raise RuntimeError("No photos or video frames to recognize")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--photos", required=True)
    parser.add_argument("--metrics", required=True)
    parser.add_argument("--time-sample", type=float, default=1)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not math.isfinite(args.time_sample) or args.time_sample <= 0:
        parser.error("time-sample must be positive")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    allowed = {"megadetector.detection.run_detector_batch", "megadetector.detection.run_md_and_speciesnet"}
    if len(command) < 2 or command[0] != "-m" or command[1] not in allowed:
        parser.error("unsupported inference module")
    metrics = {"videosOpened": 0, "videoFramesDecoded": 0, "videoDecodeSeconds": 0, "inferenceSeconds": 0}
    try:
        prepare_media(Path(args.input), Path(args.photos), args.time_sample, metrics)
        started = time.perf_counter()
        try:
            sys.argv = [command[1], *command[2:]]
            # Preserve the module's __main__ identity for Windows multiprocessing.
            runpy.run_module(command[1], run_name="__main__", alter_sys=True)
        finally:
            metrics["inferenceSeconds"] = time.perf_counter() - started
    finally:
        # Hardware availability is not a claim that both models used the GPU.
        torch = sys.modules.get("torch")
        if torch:
            metrics["cudaAvailable"] = bool(torch.cuda.is_available())
        Path(args.metrics).write_text(json.dumps(metrics), encoding="utf-8")


if __name__ == "__main__":
    main()
