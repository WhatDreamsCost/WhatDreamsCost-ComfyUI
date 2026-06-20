# Test

Project: ltx-director-pro

Scene: story-script-import

Target: legacy-workflow-import

Database ID: 4

## Steps

1. Run `node --check js/story_script.js`.
2. Run `git diff --check`.
3. Check the importer mapping extracts LTXDirector `global_prompt`, `duration_frames`, `frame_rate`, `timeline_data`, `custom_width`, `custom_height`, and `resize_method` in the correct widget order.

## Latest Result

Pass: `true`
