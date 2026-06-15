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
pro-workflows/pro-console.json
```

它包含目前最新的 Director Pro 能力：关键帧、Local Prompt、参考图、固定镜头枚举、双控制视频输入、最后帧 PNG 输出。

## 工作流说明

| 文件 | 用途 | 状态 |
|---|---|---|
| `pro-workflows/pro-console.json` | Pro Console 最新版。拆分 `CAMERA CONTROL VIDEO` 和 `MOTION / ACTION CONTROL VIDEO` 两路控制。 | 推荐 |
| `pro-workflows/camera.json` | Director Pro camera 版。单路 IC-Control 视频输入，含镜头轨道、参考图、最后帧 PNG。 | 可用 |
| `pro-workflows/lip-sync.json` | 对口型：图 + 音频生成同长度视频，自动按音频时长设置。 | 旧版 |
| `pro-workflows/upscale.json` | 单纯视频高清放大。 | 可用 |

## Pro Console 最新版

推荐打开：

```text
pro-workflows/pro-console.json
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

- `MOTION / ACTION CONTROL VIDEO INPUT`
  - 用于人物动作、手势、身体姿态、动作节奏。

- `SAVE DIRECTOR-PRO VIDEO`
  - 保存最终视频。

- `SAVE LAST FRAME PNG`
  - 从最终解码帧批取最后一帧，单独保存 PNG。

最后帧 PNG 输出前缀：

```text
video/pro-console-last-frame
```

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

`pro-workflows/pro-console.json` 已把控制视频拆成两路，但默认仍使用 Union Control IC-LoRA：

```text
ltxv/ltx2/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
```

这意味着：

- 两路视频输入已经在工作流里分开。
- 两路有独立的 `controlType` 和强度。
- 但底层默认仍是 Union Control，不是 Motion Track 专用 LoRA，也不是官方 API 的 `camera_motion` 参数。

如果要真正使用 Motion Track 专用能力，需要切换到对应 Motion Track IC-LoRA 和匹配的轨迹视频/annotator 链路。

## 安装

1. 安装或更新 ComfyUI。

2. 安装依赖 custom nodes：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Lightricks/ComfyUI-LTXVideo
git clone https://github.com/kijai/ComfyUI-KJNodes
git clone https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI
```

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
models/loras/ltxv/ltx2/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
```

实际模型路径以你的 ComfyUI 模型目录为准。如果节点报找不到模型，优先检查文件名和子目录是否与 workflow 里一致。

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

## 常见问题

### 为什么 keyframe 会提前影响画面？

LTX 的 guide/keyframe 不是简单地“只在某一帧生效”。它会作为扩散过程中的时序条件进入模型，影响范围可能向前后扩散。强度越高、间隔越近、参考越强，越容易提前影响画面。

### 为什么镜头还是没有完全按轨道走？

Camera 轨道目前最终仍是通过 Prompt Relay / 文本条件影响模型。它不是 3D 软件里的精确 camera path，也不是 SeedDance 那种更自由的镜头 API。能稳定使用的通常是固定镜头、推镜、拉镜、横移、升降、拉焦这些标准镜头。

### Reference 图怎么消费？

Reference 图会进入 `guide_data.references`，再由 `ShezwDirectorICLoRAGuide` 作为低强度 IC-LoRA visual reference guide 应用。它不是只存在 UI 里。

### 为什么改了节点但界面没变化？

重启 ComfyUI。尤其是改了 Python 节点输入输出 schema 后，热刷新通常不够。

## 当前推荐路径

继续迭代时优先从这个文件开始：

```text
pro-workflows/pro-console.json
```

旧版工作流保留用于回溯和对比，不建议再作为主线继续改。
