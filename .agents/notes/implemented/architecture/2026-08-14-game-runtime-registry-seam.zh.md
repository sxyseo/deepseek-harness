# Agent Note：游戏运行时注册表 seam（ctx.gameRuntimes）

Status: implemented

[English](2026-08-14-game-runtime-registry-seam.md) | 中文

## Problem

一个交付游戏的编码 agent 不能只写源文件：它必须驱动真实的引擎工具链（构建、运行、观察、迭代）。每个引擎都是独立的 CLI 世界 —— Godot 的 `--headless --import/--export-release`、Unity 的 batchmode、Unreal 的 automation tool —— 可执行文件、参数与失败形态各不相同。把某个引擎硬编码进模型工具会按引擎分叉整个工具集，并使「在 Godot vs Unity 里试玩这个游戏」从参数选择变成组合层重写。

web seam 已经为搜索/抓取 provider 解决了同类问题（`ctx.web`，带顺序无关选择的注册表），而 `docs/cookbook/adding-a-package.md` 的角色表精确命名了这种形态：复数 `ctx` key 表示拥有命名成员、生命周期与销毁的注册表。

## Decision

**复数注册表 seam，而非每 context 单运行时。** `@deepseek-ai/dsh-game-runtime` 提供 `GameRuntimeRegistry`（`ctx.gameRuntimes`），一个仿照 `WebRuntime` 的具体 `Service`：`register(engine, runtime)` 带重复拒绝与 stale-disposer 守卫（`BackendRegistry` 的守卫：重新注册之后才触发的 disposer 不得删除后继）；`resolve({ engine? })` 采用显式 id 优先 / 配置默认 / 恰好一个自动选 / 歧义 / 不可用的语义；进程跟踪带保留上限（`MAX_RETAINED_EXITED_PROCESSES = 32`），使已退出游戏的最终崩溃日志仍可读。注册表销毁终止所有受跟踪进程树。

**引擎后端是非 Service 的抽象实现**，对应 `LlmAdapter` 之于 `LlmRuntime` 的地位：`EngineRuntime` 声明 `resolve`/`resolveBuild`/`build`/`start`/`captureFrame`/`queryScene`/`sendInput`。`start` 是异步的，因为 provider 必须在 spawn 前经 `ctx.subprocess.resolveExecutable` 解析引擎可执行文件 —— 这是对原同步签名的一处有意偏离，由 subprocess seam 的异步解析契约所迫。

**Provider 是引擎 CLI 的门面。** `@deepseek-ai/dsh-game-runtime-godot` 不 fork 任何 Godot 代码：它经 `ctx.subprocess` spawn `godot --headless --path <project> [--import] [--export-release <preset> <output>]`，输出有界收集。`argvPrefix`（配置）把包装参数插在可执行文件之后 —— 即 flatpak/snap/脚本启动器形态，也是测试与示例无需安装 Godot 即可驱动 Node 运行引擎 shim 的挂点。项目路径必须指向已存在目录：缺失的 cwd 在 Windows 上表现为 `spawn ENOENT`，因此 provider 在 resolve 阶段就以 `GAME_INVALID_REQUEST` 响亮失败。M2–M4 的观察/输入方法抛 `GAME_CAPABILITY_UNAVAILABLE`，而不是伪造结果。

**Consumer 保持薄。** `@deepseek-ai/dsh-tool-game` 注册 `game_build`/`game_run`/`game_read_log`；每个 schema 都带可选 `engine` 字段（单引擎部署可省略 —— 「显式 > 隐式」的默认值规则），execute() 只经注册表路由。引擎非零退出是一次**成功**的构建结果（`ok: false`）—— 由模型依据值判断，工具只补充叙述。

**profile bundle 复用 headless runner。** `@deepseek-ai/dsh-game` 是纯补丁 bundle（`export {}`，同 `dsh-base`）：它在 `dsh-base` 之上插入三行游戏行以及 `dsh-headless/startup`、`dsh-headless` 行，且 `PROFILE_TEMPLATES` 新增 `game: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-game']`，于是 `dsh --profile game "<task>"` 就是一个零新增 runner 代码的一次性游戏 agent。

## Testing

`packages/game/game-runtime/tests/game-runtime.spec.ts` 覆盖注册（重复、disposer、HMR fiber 销毁）、完整选择矩阵、进程跟踪（readLog、stop、引擎不匹配、注册表销毁终止、保留上限淘汰）。`packages/game/game-runtime-godot/tests/godot-runtime.spec.ts` 经 `argvPrefix` 用 Node 运行 shim 驱动**真实** subprocess seam：spec 形态、零/非零退出构建、导出产物、`GAME_EXECUTABLE_MISSING` 与运行中进程的日志/终止循环。`packages/game/tool-game/tests/tool-game.spec.ts` 挂载真实 `ToolRuntime` 并断言 schema 形态（`engine` 可选、`project`/`processId` 必填）与错误码透传。keyless smoke（`examples/game-agent/tests/keyless-smoke.e2e.ts`）启动真实 Loader 树，脚本化 mock LLM 驱动一次真实 `game_build` → `game_run` → `game_read_log`（带上限重试直到引擎启动行出现）往返，断言持久化会话字节与最终输出。

## Alternatives considered

**每 context 单运行时（`ctx.gameRuntime`，同 `codeRuntime`）。** 与代码执行 seam 一致，但无法表达「一个部署里 Godot 与 Unity 并存」；切换引擎变成组合层变更。否决：注册表角色正是为拥有命名成员的生命周期与销毁而存在。

**Provider 自持引擎 id 的通用 `GameRuntime` 服务。** 省一个注册表类，但把选择语义分散到每个 provider。否决：`WebRuntime` 表明选择、歧义错误与重复策略应归于同一个 seam 所有者。

**构建/运行用裸 `tool-bash` 指导。** 对单引擎单机可用，但使 agent 依赖 shell 语义、平台引用与它无法推理的输出上限。否决：seam 给模型跨引擎的稳定 schema、类型化错误与受跟踪进程句柄。

**M1 就做 GUI 模式的 Godot 捕获后端。** 真实帧捕获需要 Godot 的 headless 渲染或 movie-maker 路径加探针脚本 —— 这是 M2/M3 的工作。因 M1 范围否决：诚实的 `GAME_CAPABILITY_UNAVAILABLE` 错误让 seam 在能力落地前保持真实。

**在 game bundle 里写新 runner。** 复制 `dsh-headless` 的 startup/driver 而无能力收益。否决：game 补丁复用 headless 行，game profile 仅由 base+game 补丁组成。

## Consequences

- `game` 包分组已登记进 `tsconfig.base.json` 的两个 `@deepseek-ai/dsh-*` paths 通配符与 `tsconfig.host.json` references；未来的游戏包（`game-runtime-unity`、`game-runtime-unreal`）落入同一分组，只需加一行 references。
- `dsh-tool-game` 已由 `scripts/gen-tool-catalog.ts` 收录（启动清单 + 完备性 glob），任何未来的 `packages/*/tool-*` 工具包都自动受门禁约束。
- 引擎后端永远看不到模型身份：它们经 `ctx.subprocess` 以请求/spec 词汇通信，因此 seam 能在未装任何引擎的机器上用 Node 运行的 shim 测试。
- game profile 与 headless startup 共用硬编码用法文本（`--help` 显示 `dsh --profile headless`）——纯外观问题，已记入 bundle README 的 Known Limitations，待 profile 长出自身参数后替换。
