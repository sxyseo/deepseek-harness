# @deepseek-ai/dsh-tool-game

[English](README.md) | 中文

游戏运行时能力 seam（`ctx.gameRuntimes`）之上的模型可见游戏工具：`game_build`、`game_run`、`game_read_log`、`game_query_scene`、`game_query_asset`、`game_capture_frame`。每个工具都带可选的 `engine` 字段，由注册表解析（显式 id 优先；否则要求恰好注册了一个引擎）。工具是薄 consumer —— 执行、进程跟踪、查询与捕获都在 seam 内，因此每个引擎 provider（Godot、Unity、Unreal……）都经由同一组工具可达。查询工具服务于重构回路（先查看，再用文件系统工具修改 `.tscn`/脚本）；`game_capture_frame` 服务于观察回路（捕获 PNG，再用 `read_image` 查看）。

## Tools

| 工具 | 用途 | 关键输出 |
| --- | --- | --- |
| `game_build` | 构建引擎项目（导入资源，可选导出预设）。 | `engine`、`ok`、`exitCode`、可选 `outputPath`、有界 `log`。 |
| `game_run` | 把引擎项目作为受跟踪后台进程启动。 | `processId`（供 `game_read_log` 使用）、`engine`、`pid`。 |
| `game_read_log` | 读取运行中或刚退出进程的引擎日志。 | `state`、`exitCode`、有界 `log`。 |
| `game_query_scene` | 查询一个场景的节点树（缺省为主场景）。 | `scenePath`、扁平 `nodes[]`（`{path, type, name}`）。 |
| `game_query_asset` | 查询一个资产：存在性、种类、大小与 `.tscn` 骨架或 GDScript 头。 | `exists`、`kind`、`bytes`、可选 `nodes[]`/`extends`/`className`/`tool`。 |
| `game_capture_frame` | 捕获一帧为 PNG（用 `read_image` 查看）。 | `imagePath`、`width`、`height`。 |

引擎选择逐调用且与顺序无关：显式 `engine` 必须已注册（否则 `GAME_ENGINE_UNKNOWN`）；未传时，恰好注册了一个引擎则自动选择，注册了多个则抛 `GAME_ENGINE_AMBIGUOUS`。`engine` 字段在每个 schema 中都保持可选，单引擎部署永远不必重复传它。

## Errors

工具体把 seam 错误原样抛给调用方（未知 process id 为 `GAME_PROCESS_UNKNOWN`，解析失败为 `GAME_ENGINE_UNAVAILABLE`/`GAME_ENGINE_AMBIGUOUS`，引擎二进制缺失为 `GAME_EXECUTABLE_MISSING`，引擎侧查询无法完成时为 `GAME_QUERY_FAILED`，帧捕获无法完成时为 `GAME_CAPTURE_FAILED`）。引擎非零退出的构建是一次带 `ok: false` 与日志的**成功**工具调用 —— 由模型依据值做判断；资产缺失同样是一次带 `exists: false` 的**成功** `game_query_asset` 调用。

## Model Experience

### Tool schemas

#### What the model sees

模型看到生成的 [`game_build`、`game_run`、`game_read_log`、`game_query_scene`、`game_query_asset` 与 `game_capture_frame` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-game)。可选 `engine` 字段在运行时经注册表解析，因此 schema 在引擎后端与单引擎部署之间保持一致。

#### Token effect

六个工具注册期间，每次请求的固定 schema 开销。

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

### Scene and asset query results

#### What the model sees

`game_query_scene` 渲染为 `game_query_scene: <scenePath>` 后接按树序排列的 `<path> (<type>)` 行 —— 引擎报告的实时结构。`game_query_asset` 渲染为 `<assetPath> is a <kind> (<bytes> bytes).`，场景文件再加声明节点清单、脚本文件再加 `extends`/`class_name`/`@tool` 事实；缺失资产渲染为 `<assetPath> does not exist.`

#### Token effect

数据相关；节点清单与资产摘要随所查询的场景/资产规模增长，并在压缩前重复发送。

#### KV Cache effect

仅追加；查询结果位于可复用请求前缀之后，不会使既有 KV-cache 条目失效。

### Frame capture result

#### What the model sees

`game_capture_frame` 渲染为 `game_capture_frame: captured <imagePath> (<width>x<height>). Read it back with read_image to inspect the frame.` PNG 写到磁盘（绝对 `imagePath`）；模型经 `read_image` 工具查看它，该工具把像素以图片块呈现。

#### Token effect

数据相关；图片路径与尺寸在压缩前重复发送，像素数据经 `read_image` 传递（受附件服务的单图上限约束）。

#### KV Cache effect

仅追加；捕获结果位于可复用请求前缀之后，图片块落在后续 `read_image` 结果里。

## Known Limitations and Deferred Work

- **尚无输入工具** — `game_send_input` 随 M4 里程碑落地；在那之前模型可以构建、运行、读日志、查询场景/资产并捕获帧。
- **查询与捕获深度由 provider 定义** — 引擎 provider 决定场景/资产查询能报告什么、headless 帧捕获是否可用（Godot 后端文档化了其探针与文本启发式）。
- **没有 `game_stop` 工具** — 已启动进程一直运行到会话或注册表销毁；停止控制仅是宿主 API。
- **未接入后台任务体系** — `game_run` 立即返回，进程由注册表跟踪而非 `ctx.jobs` 任务，因此没有任务控制与完成通知。
