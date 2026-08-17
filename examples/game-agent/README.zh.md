# game-agent example

[English](README.md) | 中文

游戏运行时 seam 的可运行演示：一个游戏工程 agent，经 `game_build` / `game_run` / `game_read_log` 构建、运行并读取 Godot 项目日志，经 `game_query_scene` / `game_query_asset` 查看场景树与资产元数据，再用 `read` / `edit` 真实修改 `.tscn`/脚本 —— 完整的检查与重构回路，最后经 `game_capture_frame` 捕获一帧并用 `read_image` 查看，构成观察回路。

## Composition

`cordis.yml` 挂载最小编码 agent 核心（DeepSeek 适配器、本地 subprocess seam、`agent-spine-demo` 组合、JSONL 持久化），外加游戏行 —— 运行时注册表（`defaultEngine: godot`）、Godot 后端与工具 consumer —— 闭合重构回路的文件系统行（`fs-local`、观察策略、`tool-fs`），以及 `read_image` 呈现捕获帧所需的持久附件存储。

## 运行

PATH 上有真实 Godot 时：

```sh
node --import tsx tests/fixtures/game-driver.ts cordis.yml "inspect the main scene of ./my-game and tweak the player node"
```

测试夹具 `tests/fixtures/cli.cordis.yml` 把真实适配器替换为脚本化 mock LLM，并经真实组合同样读取的环境 seam 把 Godot 后端指向 Node 运行的引擎 shim：

| 变量 | 含义 |
| --- | --- |
| `DSH_GODOT_EXECUTABLE` | Godot 可执行文件（默认 `godot`）。 |
| `DSH_GODOT_PREFIX` | 逗号分隔、插入在可执行文件之后的包装参数（如 `run,org.godotengine.Godot`）。 |

keyless smoke（`tests/keyless-smoke.e2e.ts`）在临时 cwd 中启动真实 Loader 树，针对 shim 与真实场景文件驱动一个脚本化回合走完整个回路 —— `game_build` → `game_run` → `game_read_log` → `game_query_scene` → `game_query_asset` → `read` → `edit` → `game_capture_frame` → `read_image` —— 并断言编辑标记确实落进了文件、捕获的 PNG 是合法图片、会话已持久化。
