# @deepseek-ai/dsh-game

[English](README.md) | 中文

dsh 游戏工程 profile bundle：`dsh-base` 之上的补丁层，挂载游戏运行时注册表、Godot 引擎后端与模型可见游戏工具，并复用 `dsh-headless` 的一次性 startup/runner，使 `dsh --profile game "<task>"` 借由一个能构建、运行并读取引擎项目日志的 agent 回答一个任务。

## Composition

该包的内容物是 `cordis.patch.yml`，由 `dsh.bundle.patch` 清单字段声明、profile 组合器经该字段解析。补丁在基础层之上插入以下行：

| 行 | 插件 | 角色 |
| --- | --- | --- |
| `game-runtime` | `@deepseek-ai/dsh-game-runtime` | 引擎注册表；`defaultEngine: godot`。 |
| `game-runtime-godot` | `@deepseek-ai/dsh-game-runtime-godot` | 基于 `ctx.subprocess` 的 Godot 后端。 |
| `tool-game` | `@deepseek-ai/dsh-tool-game` | `game_build` / `game_run` / `game_read_log`。 |
| `headless-startup` / `headless-runner` | `@deepseek-ai/dsh-headless` | 复用的一次性驱动（任务位置参数、最终回答输出到 stdout、按回合结束原因决定退出码）。 |

该 profile 已登记在 `PROFILE_TEMPLATES`（`packages/boot/app-boot/src/profile.ts`），因此 `dsh --profile game` 首次使用时即自动初始化，与 `headless` 完全一致。

## Model Experience

间接，经由所挂载的行插件 —— `dsh-tool-game` 拥有工具 schema 与结果渲染，`dsh-headless` 把任务作为普通用户消息提交，部署方拥有 persona；bundle 自身不注册任何 prompt、schema 或结果文本。

#### KV Cache effect

无直接失效；上述具名行包拥有任何请求前缀变更。

## Known Limitations and Deferred Work

- **帮助文本写的是 "headless"** — 复用的 `dsh-headless/startup` 打印其硬编码用法（`Usage: dsh --profile headless`）；行为完全一致，只是外观名字被继承。profile 长出自身参数时可用 game 专属 startup 行替换。
- **仅 Godot 组合** — bundle 固定挂载 Godot 后端行；多引擎部署在自身 overlay 中挂载更多 provider 行（`game-runtime-unity`、`game-runtime-unreal` 发布后）并取舍 `defaultEngine`。
- **仅一次性 headless 形态** — 复用的 runner 每次调用创建一个 agent 并退出；交互式或长驻的游戏会话应把游戏行组合进其他 surface，而不是使用本 profile。
- **引擎二进制由部署方负责** — profile 不随附 Godot 安装；在 PATH 上有引擎（或 `godotExecutable` 指向它）之前，构建与运行会以 `GAME_EXECUTABLE_MISSING` 失败。
