# LTX 2.3 Video Reference / IC-LoRA Conclusion

## 中文结论

### 总结

LTX 2.3 的 IC-LoRA 视频参考在节点/conditioning 层面不是只能全片单段。官方 `LTXAddVideoICLoRAGuide` 节点的语义是：把一张图或一段多帧视频作为 guide，从指定 `frame_idx` 开始追加到 conditioning。也就是说，一个节点调用对应一个连续 guide span；多段需要多次调用/多个 guide append，而不是在一个输入框里天然表达多个分段。

当前 `ltx-director-pro` 工作流的 UI 已经能记录多个 `controlSegments`，Long Auto 也能把 control 段按分段裁切；但当前 Python 应用层 `ShezwDirectorICLoRAGuide` 对每类 control 只取第一个匹配段。因此“多段 IC-LoRA 视频参考”在模型/节点机制上可行，但本项目当前实现还没有完整落地为同类型多段循环应用。

### 1. 模型/节点层面 IC-LoRA 支持分段还是单段？

结论：支持“一个连续视频 guide 从某个帧开始”，多段通过多次 append 实现。

依据：

- 官方 `LTXAddVideoICLoRAGuide` 描述为 “Adds one or more conditioning frames starting at the specified frame index”，并支持 single images 与 multi-frame videos。
- 节点实现会把输入视频编码为 `guide_latent`，调用 `get_latent_index(...)` 定位起始帧，再调用 `append_keyframe(...)` 追加到 conditioning。
- KJNodes 的 `LTXVAddGuideMulti` 循环多个 `image_i/frame_idx_i/strength_i`，每个 guide 都调用同一个 `append_keyframe(...)`，说明多 guide append 是有效结构。

### 2. 如果只用单段，是否必须对齐时间轴？

结论：是。视频 guide 必须通过 `frame_idx` 显式指定起始时间；并且 guide 长度不能超过 latent 序列边界。

官方节点 tooltip 还说明：视频 guide 的 `frame_idx` 需要满足 LTX temporal stride 规则，普通 `LTXAddVideoICLoRAGuide` 对视频要求 `frame_idx` 为 `1 modulo 8`，否则会向下取整到最近的合法位置。当前实现里还有断言：`latent_idx + guide_latent.shape[2] <= latent_length`。

所以如果只有一段完整参考视频，最稳的方式是从 `frame_idx=0` 或合法起点开始，并让参考视频长度和目标片段长度匹配；如果参考视频短于目标，只会覆盖它所在的 span。

### 3. 如果支持多段，能否像音频一样做分段切割？

结论：可以，机制上应当这样做。

多段视频参考的合理实现方式是：

- 每个 control segment 存储 `start / length / trimStart / strength / controlType`。
- 对原始参考视频按 `trimStart + length` 切出对应帧。
- 在当前生成片段里把 segment 的本地起点映射为 `frame_idx`。
- 对每个有效 segment 调用一次 `append_keyframe`/IC-LoRA guide。

这和当前音频/Long Auto 的分段裁切思路一致。本项目已经有 `trimStart`、`length`、Long Auto materialize 裁切逻辑；缺的是 `ShezwDirectorICLoRAGuide` 对同类型多段的循环应用。

### 4. 多段视频参考和 keyframe 是什么关系？

结论：二者都进入 LTX 的 guide/conditioning 机制，但语义不同。

- Keyframe 是静态视觉锚点，通常是一帧图像，用于约束某个时间点的画面/身份/构图。
- IC-LoRA video guide 是一段连续帧，用于约束某段时间内的结构、边缘、深度、pose 或 motion-track 类信号。
- 二者可以同时存在，但重叠时会竞争 conditioning 强度。实际使用时应降低参考强度、避免同一帧上堆叠过多强约束，尤其是 keyframe、reference image、camera guide、motion guide 同时重叠时。

### 5. 镜头参考和动态参考能否同时提供？

结论：当前不能把它当作“官方已确认的双视频双语义能力”。

官方 LTX 2.3 资料明确列出两个不同 IC-LoRA 示例/模型：

- Union Control：depth + edge/canny 等统一控制。
- Motion Track Control：I2V motion tracking。

但官方示例是分开的：Union Control workflow 用 union LoRA，Motion Track workflow 用 motion-track LoRA。没有看到官方示例证明“同一次采样中同时加载 union-control 视频和 motion-track-control 视频，并保证一个负责运镜、另一个负责动作迁移”。

当前 `ltx-director-pro.json` 里虽然有 `camera_control_image` 和 `motion_control_image` 两路输入，但它们仍通过同一个 Union Control IC-LoRA 路径应用。这可以作为工程实验入口，但不能宣称已经等价于“一个视频控制运镜，另一个视频控制人物动作迁移”的官方能力。

### 6. 如果第 5 条支持，两路视频能否交错录入？

结论：conditioning 结构上可以交错；当前项目实现还不完整；语义正确性未被官方示例确认。

如果未来确认/实现双路多段 guide，那么类似下面的结构在机制上是合理的：

- A：螺旋运镜，0-10s，camera/control guide。
- B：人物 A 原地转圈，0-5s，motion/action guide。
- C：人物 B 从右侧走入，5-10s，motion/action guide。

但要满足几个条件：

- 每段必须切成对应帧序列并按本地 `frame_idx` append。
- 同类型多段要循环应用，不能只取第一段。
- 重叠段需要明确强度策略，避免 camera 和 motion 互相抢约束。
- 如果使用不同 IC-LoRA 权重，必须确认同一次采样可以稳定堆叠这些 LoRA；目前官方 workflow 没有给出这个保证。

### 对本项目的建议

1. 保留 UI 里的 `camera_control` / `motion_control` 概念，但 README 里要明确：当前仍是实验性双输入，不是已验证的官方双 LoRA 能力。
2. 下一步应先实现“同一 LoRA 下多 control segment 循环 append”，这是确定可做的。
3. 再单独验证 Motion Track IC-LoRA：把 `ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors` 接入一个最小 workflow，确认输入数据形态。
4. 最后再实验“Union Control + Motion Track 同时使用”。在验证前，不建议把两路视频同时控制作为稳定能力写给用户。

## English Conclusion

### Summary

LTX 2.3 IC-LoRA video reference is not limited to a whole-generation single span at the conditioning/node level. The official `LTXAddVideoICLoRAGuide` node means: add a single image or a multi-frame video guide starting at `frame_idx`. One node invocation represents one continuous guide span; multiple spans require multiple invocations / multiple guide appends.

The current `ltx-director-pro` UI can store multiple `controlSegments`, and Long Auto can crop control segments when materializing a segment. However, the current Python application layer `ShezwDirectorICLoRAGuide` only selects the first matching segment per control type. So multi-span IC-LoRA video reference is feasible at the model/node mechanism level, but this project has not fully implemented same-type multi-span application yet.

### 1. Does IC-LoRA support segmented or single-span guides?

Conclusion: it supports one continuous video guide starting at a frame; multiple spans are represented by appending multiple guides.

Evidence:

- The official `LTXAddVideoICLoRAGuide` description says it adds one or more conditioning frames starting at a specified frame index, and supports both single images and multi-frame videos.
- The implementation encodes the input frames into `guide_latent`, resolves the start with `get_latent_index(...)`, then appends it through `append_keyframe(...)`.
- KJNodes `LTXVAddGuideMulti` loops through multiple `image_i/frame_idx_i/strength_i` inputs and calls the same `append_keyframe(...)` for each guide, which confirms that repeated guide appends are a valid structure.

### 2. If using one span only, must it align to the timeline?

Conclusion: yes. A video guide is explicitly placed by `frame_idx`, and the guide length must fit within the latent sequence.

The official node tooltip states that video `frame_idx` follows LTX temporal stride constraints: for `LTXAddVideoICLoRAGuide`, video starts should be `1 modulo 8`, otherwise they are rounded down to the nearest valid start. The implementation also asserts that the guide latent does not exceed the target latent length.

Therefore a full reference video should start at `frame_idx=0` or another valid start and match the target span length. A shorter guide only conditions its own span.

### 3. If multi-span is supported, can it be sliced like audio?

Conclusion: yes, that is the right implementation model.

The robust approach is:

- Store `start / length / trimStart / strength / controlType` per control segment.
- Slice the source reference video by `trimStart + length`.
- Map the segment start into the local generation segment as `frame_idx`.
- Apply one IC-LoRA guide append per valid segment.

This is aligned with the current audio/Long Auto slicing model. The project already has `trimStart`, `length`, and segment materialization logic; the missing piece is looping over all same-type control segments inside `ShezwDirectorICLoRAGuide`.

### 4. What is the relationship between video references and keyframes?

Conclusion: both enter LTX guide/conditioning, but with different semantics.

- A keyframe is a static visual anchor, usually one image, constraining a particular time point.
- An IC-LoRA video guide is a temporal frame sequence that constrains structure, edge/depth/pose, or motion-track-like signals over a span.
- They can coexist, but overlapping strong conditions can compete. In practice, strengths should be moderated when keyframes, reference images, camera guides, and motion guides overlap.

### 5. Can camera reference and motion/action reference be provided at the same time?

Conclusion: do not treat this as an officially confirmed dual-video, dual-semantics capability yet.

The official LTX 2.3 materials list separate IC-LoRA models/workflows:

- Union Control: depth + edge/canny style unified control.
- Motion Track Control: I2V motion tracking.

The official examples are separate: the Union Control workflow uses the union LoRA, and the Motion Track workflow uses the motion-track LoRA. I did not find an official example proving that a single sampling run can simultaneously use one video for camera movement and another video for action/motion transfer with guaranteed semantics.

The current `ltx-director-pro.json` has both `camera_control_image` and `motion_control_image` inputs, but they are applied through the same Union Control IC-LoRA path. This is useful as an engineering experiment, but it should not be documented as equivalent to a verified official “one video for camera, another video for character motion transfer” capability.

### 6. If item 5 is supported, can the two streams be interleaved?

Conclusion: the conditioning structure can represent interleaving; the project implementation is incomplete; official semantic support is not confirmed.

If dual-stream multi-span guide support is later confirmed/implemented, a structure like this is mechanically reasonable:

- A: spiral camera move, 0-10s, camera/control guide.
- B: character A spins in place, 0-5s, motion/action guide.
- C: character B enters from the right, 5-10s, motion/action guide.

Required conditions:

- Each segment must be sliced into the corresponding frame sequence and appended at its local `frame_idx`.
- Same-type multi-segment guides must be applied in a loop, not by selecting only the first segment.
- Overlaps need strength/priority rules.
- If different IC-LoRA weights are used, we must verify that they can be stably stacked in one sampling run; current official workflows do not prove that.

### Project Recommendation

1. Keep the UI concepts `camera_control` and `motion_control`, but document them as experimental dual inputs, not a verified official dual-LoRA feature.
2. First implement same-LoRA multi control segment looping. This is the part supported by the node mechanism.
3. Then validate the Motion Track IC-LoRA in a minimal workflow using `ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors`.
4. Only after that, experiment with Union Control + Motion Track in the same sampling run. Before validation, do not present dual video control as a stable capability.

## Evidence / 证据

- Local official node source: `/Volumes/cmfui/custom_nodes/ComfyUI-LTXVideo/iclora.py`, lines 27-31, 47-51, 222-230, 423-431.
- Local official README: `/Volumes/cmfui/custom_nodes/ComfyUI-LTXVideo/README.md`, lines 54-55 and 127-129.
- Local KJNodes multi-guide implementation: `/Volumes/cmfui/custom_nodes/comfyui-kjnodes/nodes/ltxv_nodes.py`, lines 21-31 and 79-103.
- Current project limitation: `shezw_iclora_params.py`, lines 13-35, 38-66, 390-430.
- Official model/workflow references:
  - https://github.com/Lightricks/ComfyUI-LTXVideo
  - https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control
  - https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Motion-Track-Control
