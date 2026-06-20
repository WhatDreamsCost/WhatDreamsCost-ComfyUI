# Test

Project: ltx-director-pro

Scene: workflow-cleanup

Target: camera-delete-ltx23-video-reference

Database ID: 2

## Preparation

- Use repository checkout at `/Volumes/disk-ultra/dev/ltx-director-pro`.
- Use local ComfyUI mounted at `/Volumes/cmfui` for official node implementation inspection.

## Steps

1. Confirm `pro-workflows/camera.json` is deleted.
2. Parse retained workflow JSON files.
3. Check README for stale active `camera.json` workflow references.
4. Run `git diff --check`.

## Boolean Rule

Pass is `true` only if `camera.json` is removed, retained workflow JSON files parse, README references are migration/cleanup context only, and diff check passes.

## Latest Result

Pass: `true`

Commands completed successfully:

- `test ! -e pro-workflows/camera.json`
- `for f in pro-workflows/*.json; do python3 -m json.tool "$f" >/dev/null || exit 1; done`
- `rg -n "pro-workflows/camera\\.json|camera\\.json" README.pro.md pro-workflows .agent/res/res-202606201602-ltx23-video-reference.md`
- `git diff --check`

The remaining `camera.json` matches are cleanup/migration notes, not active workflow entries.
