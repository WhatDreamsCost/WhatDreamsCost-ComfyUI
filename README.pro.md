# Shezw ComfyUI Workflows

这个仓库是一组面向 ComfyUI / LTX 2.3 的工作流和少量本地改造节点，主要用于：

- LTX 2.3 图生视频 / 音频驱动视频
- Director Pro 时间线控制
- 关键帧、参考图、Local Prompt 分段控制
- 镜头轨道控制
- IC-LoRA 控制视频
- 视频放大
- SeedDance 2.0 API 导演台实验工作流

当前主力建议使用：

```text
pro-workflows/ltx-director-pro.json
```

它合并了原 `pro-console.json` 和 `long-auto.json`：保留 Pro Console 的关键帧、Local Prompt、参考图、固定镜头枚举、双控制视频输入、最后帧 PNG 输出，同时内置 Long Auto 分段、tail-frame 续接、Continue / Re-gen 单段重跑。

## 工作流说明

| 文件 | 用途 | 状态 |
|---|---|---|
| `pro-workflows/ltx-director-pro.json` | 主入口。Director Pro + Long Auto 合并版，双控制视频、参考图、关键帧、脚本导入导出、Meta Info、分段 Continue / Re-gen。 | 推荐 |
| `pro-workflows/ltx-director-pro-lip-sync.json` | 对口型：图 + 音频生成同长度视频，带 Meta Info 和 story script。 | 可用 |
| `pro-workflows/ltx-director-pro-upscale.json` | 视频高清放大；支持分段 upscale 后自动拼接，带 Meta Info 和 story script。 | 可用 |
旧 `long-auto.json` / `pro-console.json` 已合并为 `ltx-director-pro.json`；旧 `lip-sync.json` / `upscale.json` 已改名为带 `ltx-director-pro-` 前缀的入口；旧单路 `camera.json` 已删除，运镜/动作控制统一收敛到 `ltx-director-pro.json`。

所有新版工作流都包含一个 `Meta Info` 面板：

- 只显示全局 prefix 输入框和 `Gen` / `Apply` / `Import` / `Store` / `Export` 按钮。
- `Gen` 会生成数字 ID，格式为 `YYYYMMDDHHMM` + 4 位随机数；`Apply` 会把当前图里 `filename_prefix`、`segment_prefix`、`output_prefix` 统一改到 `video/<ID>/...`，普通 Queue 和 `Queue Chunks` 都会自动应用。
- `Import` / `Store` / `Export` 处理 `*-ss.json`。它只保存内容相关字段，例如 Director 时间线、关键帧、参考图、控制视频、音频、裁切、时长、分辨率等，不保存整个 Comfy workflow。`Import` 也能读取旧版完整 workflow JSON，例如旧 `long-auto.json`，并自动抽取/迁移这些内容字段。
- Long Auto 每段完成或重置分段记忆后，会自动把当前 story script 写回默认文件 `${GLOBAL_PREFIX}-ltx-pro-ss.json`；重新导入脚本后也会按安全 prefix 扫描 `output/video/<GLOBAL_PREFIX>/`，用已有 segment video / tail-frame 文件补全分段完成状态。
- `workflow_id`、默认文件名、`ss_struct`、脚本缓存和 export 目录都保存在 workflow JSON 的节点属性里，不在 UI 上显示。

## Long Auto

推荐打开：

```text
pro-workflows/ltx-director-pro.json
```

它是长视频分段渲染模板，配套外层工具：

```bash
python3 tools/long_auto_render.py pro-workflows/ltx-director-pro.json --plan-only
python3 tools/long_auto_render.py pro-workflows/ltx-director-pro.json --output-dir long-auto-renders/test-001
```

第一条只生成/打印切分计划，第二条会物化每段独立 workflow：

```text
long-auto-renders/test-001/
  manifest.json
  concat.txt
  segments/000/workflow.json
  segments/000/timeline.json
  segments/001/workflow.json
  ...
```

`manifest.json` 是确认 long-auto 是否真的切分的主入口。每段都会写清楚：

- `start_seconds` / `end_seconds`：本段时间范围。
- `cut_reasons`：为什么在这里切，例如 `manual_cut`、`camera_start`、`camera_end`、`ic_start`、`ic_end`；如果手动设置了最长段长，也可能出现 `max_length`。
- `first_frame_source`：本段首帧来源，可能是 `keyframe`、`previous_tail` 或 `timeline_start`。
- `previous_tail_required`：是否需要把上一段尾帧传给这一段。

设计用途是：

- 外层 long-auto runner 读取完整 30s/60s Director 时间线。
- 按手动切点切段；打开 `Auto Cut` 时，camera / IC-Control 边界也会参与自动切段。
- 手动切点默认有 0.25s 保护区，保护区内的 camera / IC-Control 自动切点会被忽略，避免出现很碎的相邻切段。
- cut 落在静态内容中间时，keyframe 图、local prompt、camera 文本会被裁成前后两份分别传递。
- cut 落在动态控制内容中间时，IC-Control 段会按帧裁切，并把 `trimStart` / `length` 传给后续 guide 节点。
- 时间轴交互也会在 0.25s 内吸附到 CUT 线，方便把 keyframe、local prompt、camera/control 段边界对齐到同一切点。
- Long-Auto 设置面板会记录已成功片段的视频和 tail-frame，可单条 Reset，也可从某个片段 Continue，已完成片段会默认跳过。
- 每段可以单条 `Re-gen`：先忘掉当前段记录，然后只重跑这一段；首帧仍按原规则选择 keyframe 或上一段 tail-frame。
- 每段用 `ltx-director-pro.json` 生成一个短视频和一张 tail-frame PNG。
- 如果下一段起点 0.25s 容差内有 keyframe，用 keyframe；否则使用上一段 tail-frame 作为首帧。
- 最终把所有 segment video concat，并按需要 mux 回完整原始音频。

时间轴里可以点 `Add Cut` 在播放头添加手动切点，也可以在轨道空白处右键选择 `Manual Cut`。切点会保存到：

```text
timeline_data.cutSegments
```

直接在 ComfyUI 里 queue `ltx-director-pro.json` 时，不会再硬跑完整 30s/60s。节点会读取 `timeline_data.meta.longAuto=true`，先按切点和镜头边界规划，再顺序渲染所有 segment：第 N 段完成后从 ComfyUI history 读取 tail-frame PNG，如果第 N+1 段起点没有 keyframe，就把这张 tail-frame 自动作为下一段首帧。

每个 segment 完成后，前端会立即更新 `timeline_data.meta.longAutoMemory` 并自动 Store 当前 story script；如果脚本里缺少分段记忆，导入后会根据当前 `GLOBAL_PREFIX` 扫描 `output/video/<GLOBAL_PREFIX>/` 下已有的 segment video 和 tail-frame 文件，按时间顺序恢复已完成状态。

如果只想测试某一个 segment，可以在时间线设置按钮里切换 `Render Segment`，或者关闭 `queueAllByDefault` 后只渲染当前 active segment。

## Director Pro 合并版

推荐打开：

```text
pro-workflows/ltx-director-pro.json
```

核心结构：

- `LTX DIRECTOR - Prompt Relay Timeline`
  - 最外层只放需要交互的内容。
  - 关键帧轨道只作为强帧参考。
  - Local Prompt 轨道负责动作、表情、口型、手势等分段描述。
  - Camera 轨道只允许选择固定镜头枚举。
  - Reference 通道用于最多 8 张参考图。

- `CAMERA CONTROL VIDEO / IMAGE INPUT`
  - 用于运镜、空间结构、透视、parallax、景深/深度变化。
  - 默认可空：不填视频时自动跳过，填入视频路径时自动启用。

- `MOTION / ACTION CONTROL VIDEO INPUT`
  - 用于人物动作、手势、身体姿态、动作节奏。
  - 默认可空：不填视频时自动跳过，填入视频路径时自动启用。

- `SAVE LONG-AUTO SEGMENT VIDEO`
  - 保存当前完整视频或 Long Auto 当前分段视频。

- `SAVE LAST FRAME PNG`
  - 从最终解码帧批取最后一帧，单独保存 PNG。

最后帧 PNG 输出前缀：

```text
video/<GLOBAL_PREFIX>/ltx-director-pro-tail-frame
```

## Upscale 长视频分段

推荐打开：

```text
pro-workflows/ltx-director-pro-upscale.json
```

普通短视频可以直接运行原链路。超过 60s 或内存/显存不够时，用 `CHUNKED UPSCALE CONTROLLER` 节点里的 `Queue Chunks`：

- 自动读取 `VHS_LoadVideo` 的输入视频、真实 fps 和总帧数。
- 每次只设置 `skip_first_frames + frame_load_cap` 加载一个小段。
- 每段仍然走原来的 `UpscaleModelLoader -> ImageUpscaleWithModel -> ImageScale -> VHS_VideoCombine`。
- 分段输出前缀默认是 `video/<GLOBAL_PREFIX>/ltx-director-pro-upscale-segment_00000...`。
- 全部分段完成后用 ffmpeg 拼接成 `video/<GLOBAL_PREFIX>/ltx-director-pro-upscale-merged_*.mp4`。

分段秒数可以在 `Shezw Upscale Chunker` 节点的 `chunk_seconds` 里改。

### Upscale 分段内存释放记录

长视频 upscale 的主要内存压力来自每段解码后的大批量 `IMAGE` tensor，以及 upscaler / video combine 链路留下的中间结果。只调用 ComfyUI 的 `/free` 不一定能马上释放这些对象，因为上一段 prompt 的 executor output/object cache 仍可能持有引用。

当前处理策略：

- `Queue Chunks` 提交每个分段 prompt 时会额外标记 `shezw_upscale_chunk=true`。
- 只有带这个标记的分段 prompt 才会临时禁用 ComfyUI executor output cache，避免大批量 `IMAGE` tensor 进入跨节点/跨 prompt 的 RAM cache。
- 分段 prompt 完成后，后端会恢复原 cache 类型，并重建空的 `PromptExecutor` output/object cache。
- 每段完成后会主动 `unload_models`、触发 ComfyUI model cleanup、`torch.cuda.empty_cache()` 和 Python `gc.collect()`。
- 前端会先读取该分段的 history 输出并记录视频文件，再删除该 prompt history 并继续下一段。

2026-06-19 现场日志确认：分段清理钩子已经安装并执行，`CacheType.NONE` 生效。加入 Windows native trim 后，`_heapmin`、`HeapCompact`、`SetProcessWorkingSetSize` 和 `EmptyWorkingSet` 都能执行，`rss/uss` 会明显下降；但 Windows 原生 `GetProcessMemoryInfo` 显示 `win_private_mb/PagefileUsage` 仍随每段增加，说明是 ComfyUI 进程私有提交内存没有释放，不是单纯 working set 显示问题。后端继续用 weakref 追踪 upscale chunk 执行期间各节点输出 tensor，日志字段 `tracked_tensors_after` 会列出清理后仍存活的大 tensor 来源节点、shape、大小和 referrer 摘要；同时记录 `comfy_pinned_mb` 以确认是否是 Comfy/PyTorch pinned host memory 池在增长。如果没有大 tensor 存活且 pinned memory 不增长，但 `win_private_mb` 仍增长，则问题更偏向 PyTorch/CRT/native allocator 内部保留。

## 镜头控制

Camera 轨道目前使用 LTX 官方明确暴露的固定镜头用法，不再允许自由输入镜头文本：

| 英文字段 | 中文 |
|---|---|
| `none` | 无指定 |
| `static` | 固定镜头 |
| `dolly_in` | 推镜 |
| `dolly_out` | 拉镜 |
| `dolly_left` | 向左横移 |
| `dolly_right` | 向右横移 |
| `jib_up` | 升镜 |
| `jib_down` | 降镜 |
| `focus_shift` | 焦点转移 / 拉焦 |

注意：`dolly_in` 是摄像机向前推，不等同于 `zoom in` 变焦。

## 参考图和关键帧

当前设计里要区分三类图像输入：

| 类型 | 用途 |
|---|---|
| Keyframe / 关键帧 | 指定某个时间点的强画面锚点。 |
| Reference / 参考图 | 给角色、服装、材质、场景等提供低强度视觉参考。 |
| Control Video / 控制视频 | 给 IC-LoRA 提供连续帧控制。 |

关键帧不再绑定动作提示词。动作提示词应该放进 Local Prompt 轨道。

## 控制视频说明

`pro-workflows/ltx-director-pro.json` 已把控制视频拆成两路，但默认仍使用 Union Control IC-LoRA：

```text
ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
```

这意味着：

- 两路视频输入已经在工作流里分开。
- 两路有独立的 `controlType` 和强度。
- 视频 IC-Control 默认是可选的：使用 `Shezw Optional Control Video Frames` 读取输入。
- 视频路径为空时，节点输出空哨兵帧，`ShezwDirectorICLoRAGuide` 会自动跳过对应 IC guide。
- 视频路径有效时，节点解码帧并自动接入采样子图，不需要手动改线。
- 是否实际应用、应用时间和强度仍由 Director 的 IC-Control 轨道决定。
- 不接视频时，主生成链路照常运行，不会因为缺少 control video 阻断。
- 但底层默认仍是 Union Control，不是 Motion Track 专用 LoRA，也不是官方 API 的 `camera_motion` 参数。

如果要真正使用 Motion Track 专用能力，需要切换到对应 Motion Track IC-LoRA 和匹配的轨迹视频/annotator 链路。
`ltx-director-pro.json` 使用两路 `camera_control_image` 和 `motion_control_image`。旧单路 `ic_control_image` 的 `camera.json` 已删除；后续运镜/动作控制统一在主工作流里维护。

## 安装

1. 安装或更新 ComfyUI。

2. 安装依赖 custom nodes：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Lightricks/ComfyUI-LTXVideo
git clone https://github.com/kijai/ComfyUI-KJNodes
git clone https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI
```

其中 `LTXICLoRALoaderModelOnly` 来自：

```text
Lightricks/ComfyUI-LTXVideo
```

如果 ComfyUI 打开工作流时提示 `LTXICLoRALoaderModelOnly` 未知、unknown node、unknown package，通常就是没有安装 `ComfyUI-LTXVideo`，或者版本太旧。更新方式：

```bash
cd ComfyUI/custom_nodes/ComfyUI-LTXVideo
git pull
```

如果目录不存在，则先 clone：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Lightricks/ComfyUI-LTXVideo
```

安装或更新后必须重启 ComfyUI。

3. 将本仓库作为一个 custom node 放进 ComfyUI：

```bash
cd ComfyUI/custom_nodes
git clone <this-repo-url> ltx-director-pro
```

这个仓库里对 WhatDreamsCost 的 Director 节点做了本地改造，包括：

- Keyframe 与 Local Prompt 拆分。
- Camera 轨道固定枚举选择器。
- Reference 图进入 IC-LoRA guide。
- `ShezwDirectorICLoRAGuide` 支持拆分的 camera/action control image。

4. 重启 ComfyUI。

如果已经打开 ComfyUI，改过 Python 节点 schema 后必须重启，否则新输入口不会出现。

## 模型

常用模型和 LoRA 包括：

```text
models/checkpoints/ltx-2.3-22b-dev-fp8.safetensors
models/vae/LTX23_video_vae_bf16.safetensors
models/vae/LTX23_audio_vae_bf16.safetensors
models/loras/ltx2/ltx-2.3-22b-distilled-lora-dynamic_fro09_avg_rank_105_bf16.safetensors
models/loras/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
```

实际模型路径以你的 ComfyUI 模型目录为准。如果节点报找不到模型，优先检查文件名和子目录是否与 workflow 里一致。

IC-LoRA 默认模型对应工作流中的 `LTXICLoRALoaderModelOnly`：

```text
ComfyUI/models/loras/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
```

这里故意不使用 `ltxv/ltx2/` 子目录。ComfyUI 的模型下拉值会在 Windows 上显示为反斜杠、在 macOS 上显示为正斜杠，workflow 保存其中一种都会让另一种系统变红。把 IC-LoRA 放在 `models/loras/` 根目录并使用纯文件名，是最稳的跨平台方式。

注意：不要把 `LTXICLoRALoaderModelOnly` 直接替换成普通 `LoraLoaderModelOnly`。IC-LoRA loader 除了加载 LoRA，还会提供后续 guide 链路需要的 IC-Control 相关信息，例如 `latent_downscale_factor`。换成普通 LoRA loader 会让控制视频/参考图链路不完整。

## 使用建议

如果目标是稳定地做一个人物说话视频：

1. 用 Keyframe 轨道放首帧、关键构图帧、尾帧。
2. 用 Reference 放角色图、服装图、场景图、材质图。
3. 用 Local Prompt 分段写动作：

```text
speaking naturally, clear mouth movement, subtle head nod, right hand makes a small open-palm gesture, shoulders stable
```

4. 用 Camera 轨道选择固定镜头枚举，例如 `static` 或 `dolly_in`。
5. 如果需要控制视频：
   - 运镜控制视频放 `CAMERA CONTROL VIDEO / IMAGE INPUT`。
   - 人物动作控制视频放 `MOTION / ACTION CONTROL VIDEO INPUT`。
   - 留空则自动跳过；填入视频路径后，再由 IC-Control 轨道的时间段和强度决定是否应用。

## 常见问题

### 为什么 keyframe 会提前影响画面？

LTX 的 guide/keyframe 不是简单地“只在某一帧生效”。它会作为扩散过程中的时序条件进入模型，影响范围可能向前后扩散。强度越高、间隔越近、参考越强，越容易提前影响画面。

### 为什么镜头还是没有完全按轨道走？

Camera 轨道目前最终仍是通过 Prompt Relay / 文本条件影响模型。它不是 3D 软件里的精确 camera path，也不是 SeedDance 那种更自由的镜头 API。能稳定使用的通常是固定镜头、推镜、拉镜、横移、升降、拉焦这些标准镜头。

### Reference 图怎么消费？

Reference 图会进入 `guide_data.references`，再由 `ShezwDirectorICLoRAGuide` 作为低强度 IC-LoRA visual reference guide 应用。它不是只存在 UI 里。

### 为什么改了节点但界面没变化？

重启 ComfyUI。尤其是改了 Python 节点输入输出 schema 后，热刷新通常不够。

### LTXICLoRALoaderModelOnly 未知怎么办？

安装或更新 `Lightricks/ComfyUI-LTXVideo`。这个节点不是本仓库提供的，而是 LTXVideo 官方 custom node 提供的 IC-LoRA loader：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Lightricks/ComfyUI-LTXVideo
```

如果已经安装：

```bash
cd ComfyUI/custom_nodes/ComfyUI-LTXVideo
git pull
```

然后重启 ComfyUI，并确认 IC-LoRA 模型文件存在于：

```text
ComfyUI/models/loras/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
```

如果仓库里明明有 `ComfyUI-LTXVideo/iclora.py`，但 ComfyUI 仍然显示未知节点，优先看启动日志。通常不是模型没下载，而是整个 `ComfyUI-LTXVideo` 导入失败。

已见过的报错：

```text
Cannot import ... ComfyUI-LTXVideo module for custom nodes:
cannot import name 'pad' from 'kornia.geometry.transform.pyramid'
```

这是 `ComfyUI-LTXVideo/pyramid_blending.py` 与当前 `kornia` API 不兼容导致的。临时修复方式是在 `ComfyUI-LTXVideo/pyramid_blending.py` 中把 `pad` 从 kornia import 里去掉，改用 `torch.nn.functional.pad`：

```python
import torch.nn.functional as F

from kornia.geometry.transform.pyramid import (
    PyrUp,
    build_laplacian_pyramid,
    build_pyramid,
    find_next_powerof_two,
    is_powerof_two,
)
from torch import Tensor

pad = F.pad
```

修改后重启 ComfyUI。启动日志里 `ComfyUI-LTXVideo` 不再显示 `IMPORT FAILED` 后，`LTXICLoRALoaderModelOnly` 才会出现在节点列表里。

### lora_name 是红色但下拉里有这个模型？

这是子目录路径分隔符导致的下拉值不匹配。ComfyUI 在 Windows 上经常把子目录模型显示成反斜杠：

```text
ltxv\ltx2\ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
```

如果 workflow 里保存的是正斜杠：

```text
ltxv/ltx2/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
```

节点会变红，因为 combo 的字符串必须完全匹配。当前 workflow 采用跨平台方案：把 IC-LoRA 文件放到 `models/loras/` 根目录，并让 `lora_name` 只使用文件名：

```text
ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
```

如果你之前已经放在 `models/loras/ltxv/ltx2/`，复制一份到 `models/loras/` 根目录即可。

## 当前推荐路径

继续迭代时优先从这个文件开始：

```text
pro-workflows/ltx-director-pro.json
```

旧 `long-auto.json` / `pro-console.json` 不再作为独立工作流维护，后续主线只改 `ltx-director-pro.json`。
