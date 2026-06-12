"""HTTP routes backing the LTX Director timeline *bundle* (portable zip) feature.

A bundle packages a timeline's JSON payload together with the actual media files it
references, so a timeline can be backed up or shared and restored on a fresh install.

Two routes:
  POST /ltx_director/save_bundle  -> zip {timeline.json + media/<rel>} for download
  POST /ltx_director/load_bundle  -> extract media into input/<bundleName>/ and return
                                     the manifest with media paths re-pointed there

Security note: the load route writes files from an *uploaded* zip into ComfyUI's input
directory. It therefore mirrors the hardened-route patterns already used in
load_video_ui.py — every extracted path is basename/relative-sanitised, checked against
an extension allow-list, and asserted to resolve *inside* input/<bundleName>/ (zip-slip
defence). The save route likewise refuses to read any media reference that escapes the
input directory.
"""

import io
import os
import re
import json
import zipfile

import folder_paths
from server import PromptServer
from aiohttp import web

# Media types allowed inside a bundle. Restricting extraction to known media
# extensions prevents a crafted bundle from dropping executable/script files
# (e.g. .py, .bat, .dll) into the ComfyUI input directory.
_BUNDLE_MEDIA_EXTS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif",
    ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus",
}

# Anything outside this set is collapsed to "_" when deriving a bundle subfolder name.
_BUNDLE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]")


def _safe_bundle_name(raw):
    """Reduce an uploaded filename to a single safe path segment (no separators)."""
    base = os.path.basename(raw or "")
    if base.lower().endswith(".zip"):
        base = base[:-4]
    base = _BUNDLE_NAME_RE.sub("_", base).strip("._")
    return base or "bundle"


def _input_dir():
    return os.path.realpath(folder_paths.get_input_directory())


def _contained(root, path):
    """True iff ``path`` resolves to a location inside ``root`` (symlinks/.. resolved)."""
    try:
        root = os.path.realpath(root)
        target = os.path.realpath(path)
        return os.path.commonpath([root, target]) == root
    except ValueError:
        # Different drives / mixed absolute-relative on Windows -> not contained.
        return False


def _collect_media_refs(timeline):
    """Ordered, de-duplicated input-dir-relative media references used by a timeline."""
    refs = []
    for seg in (timeline.get("segments") or []):
        f = seg.get("imageFile")
        if f:
            refs.append(f)
    for seg in (timeline.get("audioSegments") or []):
        f = seg.get("audioFile")
        if f:
            refs.append(f)
    seen = set()
    out = []
    for r in refs:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


@PromptServer.instance.routes.post("/ltx_director/save_bundle")
async def save_bundle(request):
    try:
        payload = await request.json()
    except Exception:
        return web.Response(status=400, text="Invalid JSON body")

    timeline = payload.get("timeline") or {}
    input_dir = _input_dir()

    buf = io.BytesIO()
    missing = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("timeline.json", json.dumps(payload, indent=2))
        for rel in _collect_media_refs(timeline):
            # `rel` is an input-dir-relative path; reject anything that escapes it.
            src = os.path.join(input_dir, rel)
            if not _contained(input_dir, src) or not os.path.isfile(src):
                missing.append(rel)
                continue
            arcname = "media/" + rel.replace("\\", "/")
            zf.write(src, arcname)

    buf.seek(0)
    name = _safe_bundle_name(payload.get("bundleName") or "ltx_director_bundle")
    headers = {"Content-Disposition": 'attachment; filename="%s.zip"' % name}
    if missing:
        # Surface skipped (missing/out-of-tree) media without failing the download.
        headers["X-Bundle-Missing"] = str(len(missing))
    return web.Response(body=buf.read(), content_type="application/zip", headers=headers)


@PromptServer.instance.routes.post("/ltx_director/load_bundle")
async def load_bundle(request):
    post = await request.post()
    field = post.get("bundle")
    if field is None:
        return web.Response(status=400, text="Missing bundle file")

    bundle_name = _safe_bundle_name(getattr(field, "filename", "") or "bundle.zip")

    real_dest_root = os.path.realpath(os.path.join(_input_dir(), bundle_name))
    # Defence in depth: the sanitised name must keep us inside the input directory.
    if not _contained(_input_dir(), real_dest_root):
        return web.Response(status=400, text="Invalid bundle name")

    try:
        data = field.file.read()
        zf = zipfile.ZipFile(io.BytesIO(data))
    except Exception:
        return web.Response(status=400, text="Invalid zip file")

    try:
        manifest = json.loads(zf.read("timeline.json").decode("utf-8"))
    except Exception:
        return web.Response(status=400, text="Bundle missing timeline.json")

    os.makedirs(real_dest_root, exist_ok=True)

    staged = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename.replace("\\", "/")
        if not name.startswith("media/"):
            continue
        rel = name[len("media/"):]
        if not rel:
            continue
        # Zip-slip defence: resolve under dest root and confirm containment.
        out_path = os.path.join(real_dest_root, *[p for p in rel.split("/") if p])
        if not _contained(real_dest_root, out_path):
            continue
        if os.path.splitext(out_path)[1].lower() not in _BUNDLE_MEDIA_EXTS:
            continue
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        # Always write (create-or-overwrite) per the staging contract.
        with open(out_path, "wb") as fh:
            fh.write(zf.read(info))
        staged.append(rel)

    # Re-point media references to input/<bundleName>/<rel> and drop the stale /view
    # URL so the editor rebuilds it for the staged subfolder.
    timeline = manifest.get("timeline") or {}
    for seg in (timeline.get("segments") or []):
        if seg.get("imageFile"):
            seg["imageFile"] = "%s/%s" % (bundle_name, seg["imageFile"].replace("\\", "/"))
            seg.pop("imageB64", None)
    for seg in (timeline.get("audioSegments") or []):
        if seg.get("audioFile"):
            seg["audioFile"] = "%s/%s" % (bundle_name, seg["audioFile"].replace("\\", "/"))

    manifest["bundleName"] = bundle_name
    return web.json_response({"payload": manifest, "staged": staged, "bundleName": bundle_name})
