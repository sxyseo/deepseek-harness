# @deepseek-ai/dsh-game-runtime-godot

[English](README.md) | 中文

DeepSeek Harness 游戏运行时 seam（`ctx.gameRuntimes`）的 Godot 引擎后端。该 provider 是通过 `ctx.subprocess` 启动的 Godot CLI 的门面 —— 不 fork 任何 Godot 代码；它以 headless 模式驱动引擎二进制完成构建（导入/导出）与运行，并跟踪每个运行中进程，提供有界日志读取与树级终止。

## Registration

插件向 `ctx.gameRuntimes` 注册 `{ engine: 'godot', runtime: GodotRuntime }`；销毁即注销（并经注册表终止此后端启动的任何进程）。

## Config

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `godotExecutable` | `'godot'` | 绝对路径或裸 PATH 名；spawn 时经 `ctx.subprocess.resolveExecutable` 解析。 |
| `argvPrefix` | `[]` | 紧跟在可执行文件之后、引擎参数之前插入的参数 —— 包装器形态（`flatpak run org.godotengine.Godot`、测试中的 Node 运行 shim）。 |
| `graceMs` | `5000` | 被 spawn 进程树的终止宽限。 |
| `maxLogBytes` | `262144` | 每流的进程内日志上限（超出后保留尾部）。 |

运行期覆盖值从组合层喂入这同一组字段，而非隐藏的优先级链：`examples/game-agent/cordis.yml` 把 `DSH_GODOT_EXECUTABLE` / `DSH_GODOT_PREFIX` 接进该行的配置表达式。

## Godot CLI 契约

- **运行**：`godot --headless --path <project> [args...]` — 启动项目主场景；进程持续运行直到被终止。
- **构建**：`godot --headless --path <project> --import`，设置 `exportPreset` 时追加 `--export-release <preset> <output>`（默认输出 `<project>/dist/<preset>`）。
- **场景查询**：`godot --headless --path <project> --script <probe> -- [scenePath]` — 随包提供的 `assets/scene-query.gd` 探针实例化场景并把节点树打印为一行 `SCENE_QUERY_RESULT <json>` stdout。引擎侧失败（场景无法加载、负载畸形）以 `GAME_QUERY_FAILED` 携带探针 stderr 呈现。
- **资产查询**：基于文件系统、不 spawn 引擎 —— 存在性/大小、按扩展名派生的 `kind`、从 `.tscn` 节点行解析的声明骨架，以及从 GDScript 文本解析的 `extends`/`class_name`/`@tool` 头。这些是覆盖**声明**文件内容的、文档化的文本启发式，不是引擎语义（不展开继承场景）。
- **帧捕获**：`godot --headless --path <project> --script <probe> -- <outputPath> [scenePath] [width] [height]` — 随包提供的 `assets/capture-frame.gd` 探针实例化场景、等待一帧、把视口存为 PNG，并打印一行 `CAPTURE_RESULT <json>`。相对输出路径按项目目录解析；返回的 `imagePath` 恒为绝对路径。引擎侧失败以 `GAME_CAPTURE_FAILED` 呈现。
- 项目路径必须指向已存在的目录（否则 `GAME_INVALID_REQUEST`）。引擎非零退出是构建结果（`ok: false`），不是 rejection。

## Model Experience

间接，经由模型可见的游戏工具（`dsh-tool-game`），它们渲染此后端的构建、运行、引擎日志、场景/资产查询与帧捕获；provider 自身不注册任何 prompt、schema 或结果文本。

#### KV Cache effect

无直接失效；上述具名 consumer 拥有任何请求前缀变更。

## Known Limitations and Deferred Work

- **输入投递未实现** — `sendInput` 抛出 `GAME_CAPABILITY_UNAVAILABLE`；它随 M4 里程碑落地。
- **场景查询与帧捕获需要真实 Godot** — 两个探针都经引擎二进制运行；未安装 Godot（或未配置 `argvPrefix` 包装器）时以 `GAME_EXECUTABLE_MISSING` 失败。
- **headless 渲染取决于宿主** — 帧捕获在 headless 模式下回读视口；在没有可用渲染驱动的宿主上，探针报告 `GAME_CAPTURE_FAILED`。
- **场景探针只实例化、不运行** — 场景查询探针报告实例化后的节点树但不跑帧，因此运行时新增的子节点不可见；要 `.tscn` 的声明结构请用 `game_query_asset`。
- **资产查询是文本启发式** — 节点/脚本解析按文本读取；特殊 `.tscn` 属性顺序或脚本语法可能只被部分解析。
- **不做 project.godot 校验** — 后端只检查目录存在，不校验其是否为合法 Godot 项目；引擎自身的错误会出现在构建/运行/查询输出中。
- **导出预设必须预先存在** — `exportPreset` 必须指向项目 `export_presets.cfg` 中的预设；后端不负责编写预设。
