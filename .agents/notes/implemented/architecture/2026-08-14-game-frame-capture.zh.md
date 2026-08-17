# Agent Note：帧捕获闭合观察回路（M3）

Status: implemented

[English](2026-08-14-game-frame-capture.md) | 中文

## Problem

一个能构建、运行、读日志、查询场景的游戏 agent 仍然无法**看见**正在运行的游戏。M3 的目标是观察回路：捕获一帧、呈现给模型、让模型决策。`EngineRuntime.captureFrame` 在 M1 就已声明并抛 `GAME_CAPABILITY_UNAVAILABLE`；它需要一个真实的 Godot 机制、一个模型可见工具，以及一条让模型真正拿到像素的通道。

## Decision

**捕获与场景查询一样走引擎。** Godot 后端随包提供第二个探针（`assets/capture-frame.gd`）并运行 `godot --headless --path <project> --script <probe> -- <outputPath> [scenePath] [width] [height]`：探针成为 SceneTree 主循环，实例化场景、等待一帧、把视口存为 PNG，并打印一行 `CAPTURE_RESULT <json>`。provider 只解析这一行；缺行或 stderr 出现 `CAPTURE_ERROR` 时抛新增共享码 `GAME_CAPTURE_FAILED` 并附上引擎侧细节。`resolveCapture` 校验输出路径并把相对路径解析到**项目目录**（探针的 cwd），因此返回的 `imagePath` 恒为绝对路径。

**观察回路复用 `read_image`。** `game_capture_frame` 写 PNG 并只返回 `{ imagePath, width, height }`；模型随后调用既有的 `read_image` 工具（tool-fs，挂载附件 seam 时注册）以接收图片块。这让游戏工具保持与附件无关 —— 捕获工具从不导入附件 seam —— 并让每个引擎帧都走与任何其他 PNG 相同的图片输入管线，附带其单图上限与路由能力门禁。

**e2e 长成回路并证明像素真的流动。** mock 适配器现在声明 `inputModalities: ['text', 'image']`（让 `read_image` 的图片能力路由门禁通过）并驱动 `game_capture_frame` → `read_image`；示例挂载 `dsh-attachment-local`，smoke 的 `inspect` 断言磁盘上捕获 PNG 的魔数字节。

## Testing

`packages/game/game-runtime-godot/tests/godot-runtime.spec.ts` 经 Node shim 跑捕获探针（shim 写真实 1×1 PNG 并打印 `CAPTURE_RESULT`；`SHIM_CAPTURE_FAIL` 覆盖错误分支），断言返回帧与 PNG 魔数，并对 `resolveCapture` 做单测（相对路径规范化与空路径拒绝）。`packages/game/game-runtime/tests/game-runtime.spec.ts` 让 `captureFrame` 走过选择矩阵。`packages/game/tool-game/tests/tool-game.spec.ts` 断言 `game_capture_frame` 的 schema 与输出。keyless smoke 断言全部九次工具调用与磁盘上的 PNG。

## Alternatives considered

**捕获直接返回图片块。** 一次调用即显示帧，但会把 `tool-game` 与附件 seam 耦合，并重复 `read_image` 的校验与存储。否决：捕获写文件；`read_image` 是久经考验的既定图片输入路径，两次调用的回路让每个工具的契约保持最小。

**movie-maker 模式（`--write-movie`）。** 产出帧序列而非单张 PNG，且需要额外的 AVI/PNG 序列处理。否决：单帧探针正是回路的实际单位。

**每个引擎一个截图工具。** seam 已命名 `captureFrame`；按引擎分工具会分叉工具集。否决。

## Consequences

- `assets/capture-frame.gd` 与 `assets/scene-query.gd` 一起进入 provider 随包发布的 `assets/`（constraints 已白名单）；两个探针共享 `--script` 探针契约，只是结果前缀不同。
- seam 词汇新增 `CaptureRequest` 与 `GAME_CAPTURE_FAILED`；`CaptureSpec` 增加 `scenePath`/`env`。M4 的 provider 可零成本实现 `resolveCapture` + `captureFrame`。
- 示例现在依赖附件 seam；mock 必须声明图片输入，这也正是「此部署可观察」的诚实信号。
- headless 帧捕获仍取决于宿主（渲染驱动），记入 provider 的 Known Limitations 而非掩盖。
