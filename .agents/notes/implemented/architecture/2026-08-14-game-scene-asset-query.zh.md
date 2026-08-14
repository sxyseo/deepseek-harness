# Agent Note：场景与资产查询支撑游戏重构回路（M2）

Status: implemented

[English](2026-08-14-game-scene-asset-query.md) | 中文

## Problem

只会构建、运行、读日志的 agent 无法重构游戏：它改场景前看不到场景里有什么，碰资产前不知道资产是什么。M2 的目标是代码生成/重构回路 —— `game_query_scene` / `game_query_asset` 之后用文件系统工具修改 `.tscn`/脚本。seam 需要查询词汇，Godot 后端需要为每种查询找一个诚实、headless 可用、且无需安装引擎即可测试的机制。

## Decision

**查询与构建/运行一样经注册表路由。** `GameRuntimeRegistry` 新增 `queryScene(request)` / `queryAsset(request)`；`EngineRuntime` 新增 `queryAsset` 以及对称的 `resolveSceneQuery` / `resolveAssetQuery` 解析器（沿 `resolveBuild` 先例），因此每次查询都走与 seam 其余部分相同的引擎选择语义 —— 显式 id、配置默认、单引擎自动选、歧义错误。

**场景查询走引擎，资产查询走文件。** Godot 后端随包提供 GDScript 探针（`assets/scene-query.gd`）并运行 `godot --headless --path <project> --script <probe> -- [scenePath]`：探针成为 SceneTree 主循环，实例化场景、遍历实时节点树并打印一行 `SCENE_QUERY_RESULT <json>` stdout。provider 只解析这一行；缺行或 stderr 出现 `SCENE_QUERY_ERROR` 时抛 `GAME_QUERY_FAILED`（新增共享错误码）并附上引擎侧细节。资产查询从不 spawn 引擎：存在性/大小、按扩展名派生的 `kind`、从 `.tscn` 节点行解析的声明骨架，以及从 GDScript 文本解析的 `extends`/`class_name`/`@tool` 头 —— 都是覆盖**声明**内容的文档化文本启发式（不展开继承场景；运行时新增节点对文件读取不可见）。

**两种真相刻意分开。** 场景查询报告引擎**实例化**的内容（实时树）；资产查询报告文件**声明**的内容（agent 即将编辑的东西）。agent 用声明骨架规划编辑、用实时树验证编辑 —— 每个工具都写明自己返回的是哪一种真相。

**路径保持安全。** 资产路径剥掉可选的 `res://` 前缀并拒绝绝对路径、反斜杠分隔与 `..` 逃逸（`GAME_INVALID_REQUEST`），读取无法离开项目目录。

**e2e 长成完整重构回路。** `examples/game-agent` 挂载文件系统行（`fs-local`、观察策略、`tool-fs`），脚本化 mock 驱动 `game_build → game_run → game_read_log → game_query_scene → game_query_asset → read → edit` 作用于真实场景文件；smoke 的 `inspect` 断言编辑标记确实落进了文件。

## Testing

`packages/game/game-runtime/tests/game-runtime.spec.ts` 让 queryScene/queryAsset 走过完整选择矩阵。`packages/game/game-runtime-godot/tests/godot-runtime.spec.ts` 经 Node shim 跑真实探针路径（预制 `SCENE_QUERY_RESULT`、`SHIM_SCENE_FAIL` 覆盖错误分支）、经 `queryAsset` 解析真实 `.tscn`/`.gd` 夹具文件，并拒绝绝对/逃逸资产路径。`packages/game/tool-game/tests/tool-game.spec.ts` 断言两个新 schema（可选 `engine`/`scenePath`，必填 `project`/`assetPath`）、扁平化节点输出与资产摘要。keyless smoke 断言全部七次工具调用与文件内容标记。

## Alternatives considered

**单个查询方法带 `kind` 参数。** 否决：场景与资产查询返回不同词汇、需要不同解析规则（资产路径要校验、场景路径是不透明的引擎资源）；一个方法会把两个契约压成字符串类型的团块。

**引擎化资产查询（每个资产都过一遍引擎加载）。** 语义更真，但每个资产一次完整 ResourceLoader 往返会让重构回路变慢，且没有真实 Godot 就不可测。否决：声明结构文本解析恰好回答回路真正的问题 —— “我将编辑什么？” —— 且完全确定。

**场景查询也做文本解析。** 可彻底摆脱引擎依赖，但 `queryScene` 的价值正是实时树（含实例展开）；`.tscn` 骨架已作为资产查询存在。否决：两种真相分立本身就是特性。

**每个查询一个探针（场景 + 资产各一个）。** 资产查询不需要引擎，第二个探针只会扩大随包资产面。否决。

## Consequences

- `assets/scene-query.gd` 随 provider 包发布（`files` + constraints 白名单，沿 `skill-badge` 的 `assets` 先例）；`knip` 与 `publint` 视其为发布产物。
- seam 词汇增长（`SceneQueryRequest/Spec`、`AssetQueryRequest/Spec`、`AssetInfo`、`TscnSkeleton`、`ScriptHeader`、`GameAssetKind`）而不触碰 M1 的构建/运行契约；M5 的 provider 实现同样的三种解析器形态。
- `game_query_scene` / `game_query_asset` 自动出现在生成的工具目录中（同一包条目），目录完备性门禁保持绿色。
- M2 e2e 的 `edit` 腿真实演练了 fs 观察策略：写之前必须先读，与真实部署中的 agent 行为一致。
