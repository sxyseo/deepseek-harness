# @deepseek-ai/dsh-tool-game

[English](README.md) | 中文

游戏运行时能力 seam（`ctx.gameRuntimes`）之上的模型可见游戏工具：`game_build`、`game_run`、`game_read_log`。每个工具都带可选的 `engine` 字段，由注册表解析（显式 id 优先；否则要求恰好注册了一个引擎）。工具是薄 consumer —— 构建/运行执行、进程跟踪与日志读取都在 seam 内，因此每个引擎 provider（Godot、Unity、Unreal……）都经由同一组三个工具可达。

## Tools

| 工具 | 用途 | 关键输出 |
| --- | --- | --- |
| `game_build` | 构建引擎项目（导入资源，可选导出预设）。 | `engine`、`ok`、`exitCode`、可选 `outputPath`、有界 `log`。 |
| `game_run` | 把引擎项目作为受跟踪后台进程启动。 | `processId`（供 `game_read_log` 使用）、`engine`、`pid`。 |
| `game_read_log` | 读取运行中或刚退出进程的引擎日志。 | `state`、`exitCode`、有界 `log`。 |

引擎选择逐调用且与顺序无关：显式 `engine` 必须已注册（否则 `GAME_ENGINE_UNKNOWN`）；未传时，恰好注册了一个引擎则自动选择，注册了多个则抛 `GAME_ENGINE_AMBIGUOUS`。`engine` 字段在每个 schema 中都保持可选，单引擎部署永远不必重复传它。

## Errors

工具体把 seam 错误原样抛给调用方（未知 process id 为 `GAME_PROCESS_UNKNOWN`，解析失败为 `GAME_ENGINE_UNAVAILABLE`/`GAME_ENGINE_AMBIGUOUS`，引擎二进制缺失为 `GAME_EXECUTABLE_MISSING`）。引擎非零退出的构建是一次带 `ok: false` 与日志的**成功**工具调用 —— 由模型依据值做判断。

## Model Experience

### Tool schemas

#### What the model sees

模型看到生成的 [`game_build`、`game_run` 与 `game_read_log` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-game)。可选 `engine` 字段在运行时经注册表解析，因此 schema 在引擎后端与单引擎部署之间保持一致。

#### Token effect

三个工具注册期间，每次请求的固定 schema 开销。

#### KV Cache effect

定义与可见性不变时前缀稳定。插件生命周期或作用域工具限制可能从第一个变化的 schema token 起使复用失效。

### Build result

#### What the model sees

成功渲染为 `game_build(<engine>) succeeded` 加引擎日志（含告警），导出预设产出物时再加 `; artifact: <path>` 子句。非零退出渲染为 `game_build(<engine>) failed with exit code <code>:` 后接日志。规范值始终携带 `ok`、`exitCode` 与有界 `log`；render 只补充叙述。

#### Token effect

数据相关；引擎日志受 provider 的 `maxLogBytes` 尾部窗口约束，并在压缩前重复发送。

#### KV Cache effect

仅追加；新可见内容位于可复用请求前缀之后，不会使既有 KV-cache 条目失效。

### Run and log results

#### What the model sees

`game_run` 渲染为 `game_run(<engine>) started process <processId> (pid <pid>). Read its log with game_read_log.` —— process id 是后续每个调用都要引用的持久句柄。`game_read_log` 渲染为 `<processId> (<engine>, <state>):` 加引擎日志；引擎仍在启动时则为 `produced no log output yet.`。已退出进程的最终日志仍可读。

#### Token effect

数据相关；process id 与日志在压缩前重复发送。日志受 provider 尾部窗口约束（`truncated` 标记被丢弃的字节）。

#### KV Cache effect

仅追加；后续读取在新请求中替换先前的日志文本，不会使共享前缀失效。

## Known Limitations and Deferred Work

- **尚无观察与输入工具** — `game_query_scene` / `game_query_asset` / `game_capture_frame` / `game_send_input` 随 M2–M4 里程碑落地；在那之前模型只能构建、运行与读日志。
- **没有 `game_stop` 工具** — 已启动进程一直运行到会话或注册表销毁；停止控制仅是宿主 API。
- **未接入后台任务体系** — `game_run` 立即返回，进程由注册表跟踪而非 `ctx.jobs` 任务，因此没有任务控制与完成通知。
