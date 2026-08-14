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
- 项目路径必须指向已存在的目录（否则 `GAME_INVALID_REQUEST`）。引擎非零退出是构建结果（`ok: false`），不是 rejection。

## Model Experience

间接，经由模型可见的游戏工具（`dsh-tool-game`），它们渲染此后端的构建、运行与引擎日志；provider 自身不注册任何 prompt、schema 或结果文本。

#### KV Cache effect

无直接失效；上述具名 consumer 拥有任何请求前缀变更。

## Known Limitations and Deferred Work

- **帧捕获、场景查询与输入投递未实现** — 三个观察/输入方法抛出 `GAME_CAPABILITY_UNAVAILABLE`；它们随 M2–M4 里程碑落地（场景查询与捕获经 `--script` 探针、输入经运行中桥接）。
- **仅 headless** — 后端从不打开 GUI 窗口或真实视口；视觉捕获必须走 Godot 的 headless 渲染路径。
- **不做 project.godot 校验** — 后端只检查目录存在，不校验其是否为合法 Godot 项目；引擎自身的错误会出现在构建/运行日志中。
- **导出预设必须预先存在** — `exportPreset` 必须指向项目 `export_presets.cfg` 中的预设；后端不负责编写预设。
