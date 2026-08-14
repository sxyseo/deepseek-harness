# @deepseek-ai/dsh-game-runtime

[English](README.md) | 中文

DeepSeek Harness 的多引擎游戏运行时能力 seam（`ctx.gameRuntimes`）：按名注册的引擎后端注册表（Godot、Unity、Unreal……），提供与注册顺序无关的引擎解析、运行中进程跟踪，以及所有 provider 与 consumer 共享的构建/运行/观察/输入词汇。重复的引擎名会被拒绝。执行时显式指定 `engine` 必须已注册；未指定时要求恰好注册了一个引擎，因此选择结果永不依赖注册顺序。

## Service

`GameRuntimeRegistry` 以 `ctx.gameRuntimes` 注册（每个 context 一个实例）。Provider 实现 `EngineRuntime` 并按引擎名注册；consumer 只调用注册表表面。

### 引擎解析

- 显式调用参数 `engine` 已注册 → 该引擎。
- 显式调用参数 `engine` 未注册 → `GAME_ENGINE_UNKNOWN`。
- 未传 `engine`，配置的 `defaultEngine` 已注册 → 该引擎。
- 未传 `engine`，配置的 `defaultEngine` 未注册 → `GAME_ENGINE_UNKNOWN`。
- 未传调用参数或配置，恰好注册了一个引擎 → 该引擎。
- 未传调用参数或配置，注册了多个引擎 → `GAME_ENGINE_AMBIGUOUS`。
- 未注册任何引擎 → `GAME_ENGINE_UNAVAILABLE`。

### 注册表 API

| 成员 | 契约 |
| --- | --- |
| `register(engine, runtime)` | 以引擎 id 注册一个 `EngineRuntime`。重复 id 抛 `GAME_DUPLICATE_RUNTIME`。返回 disposer（带 stale-disposer 守卫）；随调用方 fiber 一并销毁。 |
| `names()` | 已注册的引擎 id，按注册顺序。 |
| `resolve({ engine? })` | 按上述选择规则解析 runtime。 |
| `build(request)` | 经选定引擎执行一次构建；引擎非零退出以 `ok: false` 返回。 |
| `start(request)` | 经选定引擎启动一个游戏进程，并为其 `readLog`/销毁而跟踪。 |
| `process(processId)` | 已跟踪的进程记录，或 `undefined`。 |
| `readLog({ processId, engine? })` | 读取已跟踪进程的引擎日志；已退出进程的最终崩溃日志仍可读。 |
| `stop(processId)` | 终止一个已跟踪进程树（幂等）；其记录保留以便最后一次读日志。 |
| `queryScene({ project, scenePath?, engine? })` | 经选定引擎查询一个场景树快照。 |
| `queryAsset({ project, assetPath, engine? })` | 查询一个项目资产的元数据；缺失资产以 `exists: false` 返回。 |

### 生命周期

注册表销毁会终止所有仍在运行的受管游戏进程树。注册随其所属 fiber 一并销毁（HMR 安全）。已退出进程的记录为退出后读日志保留至 `MAX_RETAINED_EXITED_PROCESSES`（32）条；超出上限时淘汰最早的退出记录。

## EngineRuntime

Provider 需要实现的抽象后端契约；它本身不是 Cordis service —— 注册表拥有其生命周期。`start` 是异步的，因为 provider 必须在 spawn 前解析引擎可执行文件。`captureFrame` / `sendInput` 是 M3–M4 的观察/输入表面；尚未实现某能力的 provider 必须抛出 `GameError` `GAME_CAPABILITY_UNAVAILABLE`，而不是伪造结果。

```ts
export abstract class EngineRuntime {
  abstract resolve(request: GameRunRequest): GameRunSpec
  abstract resolveBuild(request: GameBuildRequest): GameBuildSpec
  abstract resolveSceneQuery(request: SceneQueryRequest): SceneQuerySpec
  abstract resolveAssetQuery(request: AssetQueryRequest): AssetQuerySpec
  abstract build(spec: GameBuildSpec): Promise<GameBuildResult>
  abstract start(spec: GameRunSpec): Promise<GameProcess>
  abstract captureFrame(spec: CaptureSpec): Promise<GameFrame>
  abstract queryScene(spec: SceneQuerySpec): Promise<SceneInfo>
  abstract queryAsset(spec: AssetQuerySpec): Promise<AssetInfo>
  abstract sendInput(spec: InputSpec): Promise<InputResult>
}
```

## Errors

`GameError` 继承 `HarnessError`，带机器可路由的 code。共享 code：`GAME_DUPLICATE_RUNTIME`、`GAME_ENGINE_UNKNOWN`、`GAME_ENGINE_AMBIGUOUS`、`GAME_ENGINE_UNAVAILABLE`、`GAME_INVALID_REQUEST`、`GAME_EXECUTABLE_MISSING`、`GAME_PROCESS_UNKNOWN`、`GAME_CAPABILITY_UNAVAILABLE`、`GAME_QUERY_FAILED`。Provider 可添加自有 code；consumer 必须容忍它们。

## Model Experience

间接，经由模型可见的游戏工具（`dsh-tool-game`），它们拥有构建、运行、引擎日志与场景/资产查询的全部模型可见渲染；注册表自身不注册任何 prompt、schema 或结果文本。

#### KV Cache effect

无直接失效；上述具名 consumer 拥有任何请求前缀变更。

## Known Limitations and Deferred Work

- **帧捕获与输入投递已声明但未实现** — `captureFrame` / `sendInput` 存在于 seam 上以便 provider 逐步长入；尚无 Godot 实现或模型可见工具（M3–M4 里程碑）。尚不存在的工具：`game_capture_frame`、`game_send_input`。
- **没有面向模型的停止工具** — 已启动的进程一直运行到会话/注册表销毁或后端将其终止；`registry.stop()` 仅是宿主 API。`game_stop` 工具推迟到试玩里程碑。
- **资产查询由 provider 定义** — seam 规范化了种类与结构（`tscn` 骨架、`script` 头），但提取机制是每个 provider 自己文档化的选择；对特殊资产，各 provider 能报告的内容可能不同。
- **引擎可用性是部署方的职责** — seam 通过 `ctx.subprocess` 解析可执行文件；未安装引擎二进制的部署在每次构建/运行/查询时以 `GAME_EXECUTABLE_MISSING` 失败。
