"""Persistent MegaDetector worker used by the camera-trap reviewer.

The process speaks newline-delimited JSON on stdout.  All library logging is
redirected to stderr so protocol messages remain machine-readable.  This
worker intentionally imports MegaDetector only; fast mode never imports or
runs SpeciesNet and rejects video inputs.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import pathlib
import sys
import time
import traceback


PROTOCOL_OUT = sys.stdout
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXTENSIONS = {".avi", ".mp4", ".mov", ".mkv"}


def emit(payload: dict) -> None:
    PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    PROTOCOL_OUT.flush()


def choose_batch_size(torch_module, requested: int) -> tuple[int, str, list[str]]:
    cuda_available = bool(torch_module.cuda.is_available())
    cuda_devices = [torch_module.cuda.get_device_name(i) for i in range(torch_module.cuda.device_count())]
    if requested > 0:
        return (requested if cuda_available else 1), ("cuda:0" if cuda_available else "cpu"), cuda_devices
    if not cuda_available:
        return 1, "cpu", cuda_devices
    total_memory = int(torch_module.cuda.get_device_properties(0).total_memory)
    gib = total_memory / (1024 ** 3)
    if gib >= 12:
        return 16, "cuda:0", cuda_devices
    if gib >= 6:
        return 8, "cuda:0", cuda_devices
    return 4, "cuda:0", cuda_devices


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--threshold", type=float, default=0.01)
    parser.add_argument("--batch-size", type=int, default=0)
    args = parser.parse_args()

    import_started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from megadetector.detection.run_detector import load_detector
        from megadetector.visualization import visualization_utils as vis_utils
    import_seconds = time.perf_counter() - import_started

    batch_size, device, cuda_devices = choose_batch_size(torch, args.batch_size)
    load_started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        detector = load_detector(args.model)
    model_load_seconds = time.perf_counter() - load_started
    model_load_count = 1

    emit({
        "type": "ready",
        "pid": os.getpid(),
        "device": device,
        "batchSize": batch_size,
        "torchVersion": torch.__version__,
        "cudaAvailable": bool(torch.cuda.is_available()),
        "cudaVersion": torch.version.cuda,
        "cudaDeviceCount": int(torch.cuda.device_count()),
        "cudaDevices": cuda_devices,
        "modelLoadCount": model_load_count,
        "importSeconds": round(import_seconds, 4),
        "modelLoadSeconds": round(model_load_seconds, 4),
        "speciesNetLoaded": any(name == "speciesnet" or name.startswith("speciesnet.") for name in sys.modules),
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("requestId", ""))
            if request.get("command") == "shutdown":
                emit({"type": "shutdown", "requestId": request_id})
                return 0
            if request.get("command") != "detect":
                raise ValueError("unsupported worker command")
            items = request.get("images")
            if not isinstance(items, list) or not items:
                raise ValueError("detect requires at least one image")

            paths: list[str] = []
            tokens: list[str] = []
            thumbnail_paths: list[str] = []
            for item in items:
                image_path = pathlib.Path(str(item.get("path", ""))).resolve()
                extension = image_path.suffix.lower()
                if extension in VIDEO_EXTENSIONS:
                    raise ValueError(f"video input rejected in fast worker: {image_path.name}")
                if extension not in IMAGE_EXTENSIONS:
                    raise ValueError(f"unsupported image input: {image_path.name}")
                if not image_path.is_file():
                    raise FileNotFoundError(str(image_path))
                paths.append(str(image_path))
                tokens.append(str(item.get("token", image_path)))
                thumbnail_paths.append(str(item.get("thumbnailPath", "")))

            request_started = time.perf_counter()
            decode_seconds = 0.0
            inference_seconds = 0.0
            thumbnail_seconds = 0.0
            thumbnails_created = 0
            results: list[dict] = []
            batches = 0
            for offset in range(0, len(paths), batch_size):
                current_paths = paths[offset:offset + batch_size]
                current_tokens = tokens[offset:offset + batch_size]
                current_thumbnail_paths = thumbnail_paths[offset:offset + batch_size]
                decode_started = time.perf_counter()
                with contextlib.redirect_stdout(sys.stderr):
                    images = [vis_utils.load_image(image_path) for image_path in current_paths]
                decode_seconds += time.perf_counter() - decode_started

                thumbnail_started = time.perf_counter()
                for image, thumbnail_name in zip(images, current_thumbnail_paths):
                    if not thumbnail_name:
                        continue
                    thumbnail_path = pathlib.Path(thumbnail_name)
                    if thumbnail_path.exists():
                        continue
                    thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
                    temporary = thumbnail_path.with_suffix(f".tmp-{os.getpid()}.jpg")
                    thumbnail = image.copy()
                    thumbnail.thumbnail((480, 480))
                    if thumbnail.mode != "RGB":
                        thumbnail = thumbnail.convert("RGB")
                    thumbnail.save(temporary, format="JPEG", quality=82, optimize=True)
                    temporary.replace(thumbnail_path)
                    thumbnails_created += 1
                thumbnail_seconds += time.perf_counter() - thumbnail_started

                inference_started = time.perf_counter()
                with contextlib.redirect_stdout(sys.stderr):
                    batch_results = detector.generate_detections_one_batch(
                        images,
                        current_tokens,
                        detection_threshold=args.threshold,
                    )
                inference_seconds += time.perf_counter() - inference_started
                results.extend(batch_results)
                batches += 1

            emit({
                "type": "result",
                "requestId": request_id,
                "results": results,
                "metrics": {
                    "photos": len(paths),
                    "batches": batches,
                    "batchSize": batch_size,
                    "device": device,
                    "decodeSeconds": round(decode_seconds, 4),
                    "thumbnailSeconds": round(thumbnail_seconds, 4),
                    "thumbnailsCreated": thumbnails_created,
                    "inferenceSeconds": round(inference_seconds, 4),
                    "workerSeconds": round(time.perf_counter() - request_started, 4),
                    "modelLoadCount": model_load_count,
                    "speciesNetLoaded": any(name == "speciesnet" or name.startswith("speciesnet.") for name in sys.modules),
                    "videoFramesDecoded": 0,
                },
            })
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({
                "type": "error",
                "requestId": request_id,
                "error": str(error),
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
