#!/usr/bin/env python3
"""Plan and materialize segmented LTX Director Pro renders.

This is intentionally workflow-level orchestration. ComfyUI workflows are acyclic
graphs, so the "render segment N, read its tail PNG, feed segment N+1" loop must
live outside the graph.
"""

from __future__ import annotations

import argparse
import copy
import datetime as _dt
import json
import math
from pathlib import Path
from typing import Any


DIRECTOR_WIDGETS = {
    "global_prompt": 0,
    "duration_frames": 1,
    "duration_seconds": 2,
    "timeline_data": 3,
    "local_prompts": 4,
    "segment_lengths": 5,
    "epsilon": 6,
    "guide_strength": 7,
    "use_custom_audio": 8,
    "frame_rate": 9,
}

NEUTRAL_GAP_PROMPT = "maintain the global scene and current visual continuity"


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _dump_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _director_node(workflow: dict[str, Any]) -> dict[str, Any]:
    for node in workflow.get("nodes", []):
        if node.get("type") == "LTXDirector":
            return node
    raise ValueError("Workflow does not contain an LTXDirector node.")


def _widget(node: dict[str, Any], name: str, default: Any = None) -> Any:
    values = node.get("widgets_values") or []
    idx = DIRECTOR_WIDGETS[name]
    return values[idx] if idx < len(values) else default


def _set_widget(node: dict[str, Any], name: str, value: Any) -> None:
    values = node.setdefault("widgets_values", [])
    idx = DIRECTOR_WIDGETS[name]
    while len(values) <= idx:
        values.append(None)
    values[idx] = value


def _timeline_from_node(node: dict[str, Any]) -> dict[str, Any]:
    raw = _widget(node, "timeline_data", "{}")
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"LTXDirector timeline_data is not valid JSON: {exc}") from exc

    for key in (
        "segments",
        "promptSegments",
        "referenceImages",
        "cameraSegments",
        "controlSegments",
        "audioSegments",
        "cutSegments",
    ):
        data.setdefault(key, [])
    return data


def _fps(node: dict[str, Any]) -> int:
    try:
        return max(1, int(round(float(_widget(node, "frame_rate", 24)))))
    except (TypeError, ValueError):
        return 24


def _duration_frames(node: dict[str, Any]) -> int:
    try:
        return max(1, int(round(float(_widget(node, "duration_frames", 1)))))
    except (TypeError, ValueError):
        return 1


def _seg_start(seg: dict[str, Any]) -> int:
    return max(0, int(round(float(seg.get("start", seg.get("frame", 0)) or 0))))


def _seg_end(seg: dict[str, Any]) -> int:
    return _seg_start(seg) + max(0, int(round(float(seg.get("length", 0) or 0))))


def _add_boundary(boundaries: dict[int, set[str]], frame: int, reason: str, duration: int) -> None:
    frame = max(0, min(duration, int(round(frame))))
    if frame <= 0 or frame >= duration:
        return
    boundaries.setdefault(frame, set()).add(reason)


def _manual_cut_frames(timeline: dict[str, Any], duration: int) -> dict[int, set[str]]:
    boundaries: dict[int, set[str]] = {}
    for seg in timeline.get("cutSegments", []):
        _add_boundary(boundaries, _seg_start(seg), "manual_cut", duration)
    return boundaries


def _auto_boundary_frames(timeline: dict[str, Any], duration: int) -> dict[int, set[str]]:
    boundaries: dict[int, set[str]] = {}
    for seg in timeline.get("cameraSegments", []):
        _add_boundary(boundaries, _seg_start(seg), "camera_start", duration)
        _add_boundary(boundaries, _seg_end(seg), "camera_end", duration)
    for seg in timeline.get("controlSegments", []):
        _add_boundary(boundaries, _seg_start(seg), "ic_start", duration)
        _add_boundary(boundaries, _seg_end(seg), "ic_end", duration)
    return boundaries


def _near_manual_cut(frame: int, manual_frames: set[int], tolerance_frames: int) -> bool:
    return any(abs(frame - cut_frame) <= tolerance_frames for cut_frame in manual_frames)


def _filter_near_manual(
    boundaries: dict[int, set[str]],
    manual_frames: set[int],
    tolerance_frames: int,
) -> dict[int, set[str]]:
    if not manual_frames or tolerance_frames <= 0:
        return boundaries
    return {
        frame: reasons
        for frame, reasons in boundaries.items()
        if not _near_manual_cut(frame, manual_frames, tolerance_frames)
    }


def _soft_boundary_frames(timeline: dict[str, Any], duration: int) -> dict[int, set[str]]:
    boundaries: dict[int, set[str]] = {}
    for key, reason_start, reason_end in (
        ("promptSegments", "prompt_start", "prompt_end"),
        ("controlSegments", "control_start", "control_end"),
        ("audioSegments", "audio_start", "audio_end"),
        ("segments", "keyframe_start", "keyframe_end"),
    ):
        for seg in timeline.get(key, []):
            _add_boundary(boundaries, _seg_start(seg), reason_start, duration)
            if seg.get("length"):
                _add_boundary(boundaries, _seg_end(seg), reason_end, duration)
    return boundaries


def _merge_reasons(target: dict[int, set[str]], source: dict[int, set[str]]) -> None:
    for frame, reasons in source.items():
        target.setdefault(frame, set()).update(reasons)


def _choose_soft_cut(
    start: int,
    limit: int,
    soft: dict[int, set[str]],
    min_frames: int,
) -> tuple[int | None, set[str]]:
    candidates = [
        frame
        for frame in soft
        if start + min_frames <= frame <= limit
    ]
    if not candidates:
        return None, set()
    frame = max(candidates)
    return frame, soft.get(frame, set())


def _keyframe_at_start(timeline: dict[str, Any], start: int, tolerance_frames: int) -> dict[str, Any] | None:
    matches = [
        seg
        for seg in timeline.get("segments", [])
        if start <= _seg_start(seg) <= start + tolerance_frames
    ]
    if not matches:
        return None
    return min(matches, key=lambda seg: _seg_start(seg) - start)


def plan_segments(
    workflow: dict[str, Any],
    max_segment_seconds: float = 15.0,
    keyframe_tolerance_seconds: float = 0.25,
    manual_cut_tolerance_seconds: float = 0.25,
    min_segment_seconds: float = 1.0,
    auto_cut: bool | None = None,
) -> dict[str, Any]:
    node = _director_node(workflow)
    timeline = _timeline_from_node(node)
    if auto_cut is None:
        auto_cut = bool((timeline.get("meta") or {}).get("autoCut", True))
    fps = _fps(node)
    duration = _duration_frames(node)
    max_frames = max(1, int(math.floor(max_segment_seconds * fps)))
    tolerance_frames = max(0, int(round(keyframe_tolerance_seconds * fps)))
    manual_tolerance_frames = max(0, int(round(manual_cut_tolerance_seconds * fps)))
    min_frames = max(1, int(round(min_segment_seconds * fps)))

    hard = _manual_cut_frames(timeline, duration)
    manual_frames = set(hard)
    if auto_cut:
        _merge_reasons(hard, _filter_near_manual(_auto_boundary_frames(timeline, duration), manual_frames, manual_tolerance_frames))
    soft = _filter_near_manual(_soft_boundary_frames(timeline, duration), manual_frames, manual_tolerance_frames)

    hard_points = [0, *sorted(hard), duration]
    cuts: list[tuple[int, set[str]]] = [(0, {"timeline_start"})]

    for left, right in zip(hard_points, hard_points[1:]):
      cursor = left
      while right - cursor > max_frames:
          limit = cursor + max_frames
          if _near_manual_cut(right, manual_frames, manual_tolerance_frames) and right - limit <= manual_tolerance_frames:
              break
          soft_cut, soft_reasons = _choose_soft_cut(cursor, limit, soft, min_frames)
          if soft_cut is not None:
              cuts.append((soft_cut, set(soft_reasons) | {"max_length_soft_boundary"}))
              cursor = soft_cut
          else:
              cuts.append((limit, {"max_length"}))
              cursor = limit
      if right != duration:
          cuts.append((right, hard.get(right, {"hard_boundary"})))

    cuts.append((duration, {"timeline_end"}))

    dedup: dict[int, set[str]] = {}
    for frame, reasons in cuts:
        dedup.setdefault(frame, set()).update(reasons)
    ordered = sorted(dedup)

    segments = []
    for idx, (start, end) in enumerate(zip(ordered, ordered[1:])):
        if end <= start:
            continue
        keyframe = _keyframe_at_start(timeline, start, tolerance_frames)
        if idx == 0:
            first_frame_source = "keyframe" if keyframe else "timeline_start"
        else:
            first_frame_source = "keyframe" if keyframe else "previous_tail"
        segments.append(
            {
                "index": len(segments),
                "start_frame": start,
                "end_frame": end,
                "length_frames": end - start,
                "start_seconds": round(start / fps, 3),
                "end_seconds": round(end / fps, 3),
                "length_seconds": round((end - start) / fps, 3),
                "cut_reasons": sorted(dedup.get(start, set())) if start else ["timeline_start"],
                "first_frame_source": first_frame_source,
                "start_keyframe_id": keyframe.get("id") if keyframe else None,
                "keyframe_tolerance_frames": tolerance_frames,
                "previous_tail_required": first_frame_source == "previous_tail",
                "tail_frame_output": f"segments/{len(segments):03d}/tail_frame.png",
                "video_output": f"segments/{len(segments):03d}/video.mp4",
            }
        )

    return {
        "schema": "shezw.long_auto.manifest.v1",
        "created_at": _dt.datetime.now().isoformat(timespec="seconds"),
        "source_duration_frames": duration,
        "source_duration_seconds": round(duration / fps, 3),
        "frame_rate": fps,
        "max_segment_seconds": max_segment_seconds,
        "max_segment_frames": max_frames,
        "keyframe_tolerance_seconds": keyframe_tolerance_seconds,
        "keyframe_tolerance_frames": tolerance_frames,
        "manual_cut_tolerance_seconds": manual_cut_tolerance_seconds,
        "manual_cut_tolerance_frames": manual_tolerance_frames,
        "auto_cut": auto_cut,
        "segments": segments,
    }


def _clip_segment(seg: dict[str, Any], start: int, end: int, *, force_start: int | None = None) -> dict[str, Any] | None:
    seg_start = _seg_start(seg)
    seg_end = _seg_end(seg)
    if seg_end <= start or seg_start >= end:
        return None
    new = copy.deepcopy(seg)
    clipped_start = max(seg_start, start)
    clipped_end = min(seg_end, end)
    new["start"] = 0 if force_start is not None else clipped_start - start
    new["length"] = max(1, clipped_end - clipped_start)
    if "frame" in new:
        new["frame"] = new["start"]
    if seg.get("type") == "audio":
        new["trimStart"] = max(0, int(round(float(seg.get("trimStart", 0) or 0))) + clipped_start - seg_start)
    return new


def _clip_keyframe_segment(seg: dict[str, Any], start: int, end: int, tolerance_frames: int) -> dict[str, Any] | None:
    seg_start = _seg_start(seg)
    if seg_start < start or seg_start >= end:
        return None
    new = copy.deepcopy(seg)
    local_start = seg_start - start
    if local_start <= tolerance_frames:
        local_start = 0
    new["start"] = local_start
    new["frame"] = local_start
    new["length"] = 1
    return new


def _crop_timeline_for_segment(
    timeline: dict[str, Any],
    manifest_segment: dict[str, Any],
) -> dict[str, Any]:
    start = manifest_segment["start_frame"]
    end = manifest_segment["end_frame"]
    tolerance_frames = int(manifest_segment.get("keyframe_tolerance_frames", 0) or 0)
    local: dict[str, Any] = {
        "segments": [],
        "promptSegments": [],
        "referenceImages": copy.deepcopy(timeline.get("referenceImages", [])),
        "cameraSegments": [],
        "controlSegments": [],
        "audioSegments": [],
        "cutSegments": [],
        "meta": {
            **copy.deepcopy(timeline.get("meta", {})),
            "materializedSegment": True,
            "sourceStartFrame": start,
            "sourceEndFrame": end,
            "sourceSegmentIndex": manifest_segment["index"],
            "sourceCutReasons": manifest_segment.get("cut_reasons", []),
        },
    }

    for key in ("promptSegments", "cameraSegments", "controlSegments", "audioSegments"):
        for seg in timeline.get(key, []):
            clipped = _clip_segment(seg, start, end)
            if clipped:
                local[key].append(clipped)

    for seg in timeline.get("segments", []):
        clipped = _clip_keyframe_segment(seg, start, end, tolerance_frames)
        if clipped:
            if manifest_segment.get("start_keyframe_id") == seg.get("id"):
                clipped["start"] = 0
                clipped["frame"] = 0
            local["segments"].append(clipped)

    if manifest_segment.get("previous_tail_required"):
        tail_source = f"__PREVIOUS_SEGMENT_TAIL__/{manifest_segment['index'] - 1:03d}/tail_frame.png"
        local["segments"].insert(
            0,
            {
                "id": f"long-auto-tail-{manifest_segment['index']:03d}",
                "type": "image",
                "start": 0,
                "length": 1,
                "imageFile": tail_source,
                "guideStrength": 1.0,
                "source": "previous_tail_placeholder",
            },
        )

    for cut in timeline.get("cutSegments", []):
        frame = _seg_start(cut)
        if start < frame < end:
            local_cut = copy.deepcopy(cut)
            local_cut["start"] = frame - start
            local_cut["frame"] = frame - start
            local["cutSegments"].append(local_cut)

    return local


def _camera_prompt(seg: dict[str, Any]) -> str:
    return (seg.get("prompt") or "").strip()


def _control_prompt(seg: dict[str, Any]) -> str:
    kind = seg.get("controlType") or "control"
    strength = float(seg.get("strength", 0.75) or 0.75)
    prompt = (seg.get("prompt") or "").strip()
    return f"IC-LoRA {kind} strength {strength:.2f}{': ' + prompt if prompt else ''}"


def _local_prompt_payload(timeline: dict[str, Any], duration: int) -> tuple[str, str]:
    cuts = {0, duration}
    for key in ("promptSegments", "cameraSegments", "controlSegments"):
        for seg in timeline.get(key, []):
            s = max(0, min(duration, _seg_start(seg)))
            e = max(0, min(duration, _seg_end(seg)))
            if e > s:
                cuts.add(s)
                cuts.add(e)
    ordered = sorted(cuts)

    reference_hints = []
    for ref in timeline.get("referenceImages", []):
        note = (ref.get("note") or "").strip()
        if note:
            reference_hints.append(f"Reference {ref.get('refName', '@Ref')}: {note}")

    prompts: list[str] = []
    lengths: list[str] = []
    for start, end in zip(ordered, ordered[1:]):
        parts = []
        parts.extend(
            (seg.get("prompt") or "").strip()
            for seg in timeline.get("promptSegments", [])
            if _seg_start(seg) < end and _seg_end(seg) > start and (seg.get("prompt") or "").strip()
        )
        parts.extend(
            f"Camera: {_camera_prompt(seg)}"
            for seg in timeline.get("cameraSegments", [])
            if _seg_start(seg) < end and _seg_end(seg) > start and _camera_prompt(seg)
        )
        parts.extend(
            _control_prompt(seg)
            for seg in timeline.get("controlSegments", [])
            if _seg_start(seg) < end and _seg_end(seg) > start
        )
        parts.extend(reference_hints)
        prompts.append(". ".join([p for p in parts if p]) or NEUTRAL_GAP_PROMPT)
        lengths.append(str(end - start))
    return " | ".join(prompts), ",".join(lengths)


def _guide_strength_payload(timeline: dict[str, Any]) -> str:
    ordered = sorted(timeline.get("segments", []), key=_seg_start)
    return ",".join(f"{float(seg.get('guideStrength', 1.0) or 1.0):.2f}" for seg in ordered)


def _set_output_prefixes(workflow: dict[str, Any], job_name: str, index: int) -> None:
    for node in workflow.get("nodes", []):
        values = node.get("widgets_values") or []
        title = (node.get("title") or "").lower()
        node_type = node.get("type")
        if node_type == "SaveVideo" and values:
            values[0] = f"long-auto/{job_name}/segments/{index:03d}/video"
        if node_type == "SaveImageKJ" and values:
            values[0] = f"long-auto/{job_name}/segments/{index:03d}/tail_frame"
        if "save long-auto segment video" in title and values:
            values[0] = f"long-auto/{job_name}/segments/{index:03d}/video"
        if "save last frame png" in title and values:
            values[0] = f"long-auto/{job_name}/segments/{index:03d}/tail_frame"


def materialize_segments(source_workflow: dict[str, Any], manifest: dict[str, Any], output_dir: Path) -> None:
    source_node = _director_node(source_workflow)
    source_timeline = _timeline_from_node(source_node)
    fps = manifest["frame_rate"]
    job_name = output_dir.name

    _dump_json(output_dir / "manifest.json", manifest)

    for segment in manifest["segments"]:
        workflow = copy.deepcopy(source_workflow)
        node = _director_node(workflow)
        duration = segment["length_frames"]
        local_timeline = _crop_timeline_for_segment(source_timeline, segment)
        local_prompts, segment_lengths = _local_prompt_payload(local_timeline, duration)

        _set_widget(node, "duration_frames", duration)
        _set_widget(node, "duration_seconds", round(duration / fps, 3))
        _set_widget(node, "timeline_data", json.dumps(local_timeline, ensure_ascii=False))
        _set_widget(node, "local_prompts", local_prompts)
        _set_widget(node, "segment_lengths", segment_lengths)
        _set_widget(node, "guide_strength", _guide_strength_payload(local_timeline))
        _set_output_prefixes(workflow, job_name, segment["index"])

        segment_dir = output_dir / "segments" / f"{segment['index']:03d}"
        _dump_json(segment_dir / "workflow.json", workflow)
        _dump_json(segment_dir / "timeline.json", local_timeline)

    concat_list = output_dir / "concat.txt"
    with concat_list.open("w", encoding="utf-8") as f:
        for segment in manifest["segments"]:
            f.write(f"file 'segments/{segment['index']:03d}/video.mp4'\n")


def _print_plan(manifest: dict[str, Any]) -> None:
    print(
        f"Long-auto plan: {manifest['source_duration_seconds']}s, "
        f"{len(manifest['segments'])} segment(s), fps={manifest['frame_rate']}, "
        f"max={manifest['max_segment_seconds']}s"
    )
    for seg in manifest["segments"]:
        print(
            f"  #{seg['index']:03d} "
            f"{seg['start_seconds']:>6.3f}s-{seg['end_seconds']:>6.3f}s "
            f"len={seg['length_seconds']:>5.3f}s "
            f"first={seg['first_frame_source']} "
            f"reasons={','.join(seg['cut_reasons'])}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workflow", type=Path, help="ComfyUI workflow JSON with an LTXDirector node.")
    parser.add_argument("--max-segment-seconds", type=float, default=15.0)
    parser.add_argument("--keyframe-tolerance-seconds", type=float, default=0.25)
    parser.add_argument("--manual-cut-tolerance-seconds", type=float, default=0.25)
    parser.add_argument("--min-segment-seconds", type=float, default=1.0)
    parser.add_argument("--auto-cut", dest="auto_cut", action="store_true", default=None, help="Split at camera and IC-Control boundaries.")
    parser.add_argument("--no-auto-cut", dest="auto_cut", action="store_false", help="Only split at manual cuts and max segment length.")
    parser.add_argument("--output-dir", type=Path, default=None, help="Directory for manifest and per-segment workflows.")
    parser.add_argument("--plan-only", action="store_true", help="Only print/write the manifest; do not materialize segment workflows.")
    args = parser.parse_args()

    workflow = _load_json(args.workflow)
    manifest = plan_segments(
        workflow,
        max_segment_seconds=args.max_segment_seconds,
        keyframe_tolerance_seconds=args.keyframe_tolerance_seconds,
        manual_cut_tolerance_seconds=args.manual_cut_tolerance_seconds,
        min_segment_seconds=args.min_segment_seconds,
        auto_cut=args.auto_cut,
    )
    _print_plan(manifest)

    if args.output_dir:
        output_dir = args.output_dir
    else:
        stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        output_dir = Path("long-auto-renders") / stamp

    if args.plan_only:
        _dump_json(output_dir / "manifest.json", manifest)
        print(f"Wrote manifest: {output_dir / 'manifest.json'}")
        return 0

    materialize_segments(workflow, manifest, output_dir)
    print(f"Wrote render job: {output_dir}")
    print("Each segment has its own workflow.json plus timeline.json.")
    print("Note: placeholders named __PREVIOUS_SEGMENT_TAIL__ must be replaced with the previous real tail PNG before queueing that segment.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
