# Agent Note: 基于项目自带 Vite 的 web 引擎后端（M6）

Status: implemented

[English](2026-08-17-game-runtime-web.md) | 中文

## Problem

game seam 此前唯一的后端是 Godot，而本 fork 的主要消费方构建的是 web 游戏（Vite 形态的 npm 项目：PixiJS、Phaser、纯 canvas）。它们需要同一套注册表面 —— 构建、运行、读日志、查询场景/资产、捕获帧 —— 且不依赖原生引擎二进制，也不让 provider 背上一整套浏览器自动化依赖树（Playwright、puppeteer）。

## Decision

**引擎二进制是项目自带的本地 Vite。** 构建与预览经 `ctx.subprocess` spawn `node <project>/node_modules/vite/bin/vite.js build|preview --port N --strictPort`。这是刻意绕开包管理器 CLI：在 Windows 上 npm/pnpm 的 shim 是 `.cmd` 文件，现代 Node 不带 shell 无法 spawn，其失败形态就是「消费方的开发平台上 provider 直接坏掉」。没有本地 Vite 的项目每次构建/运行都以 `GAME_EXECUTABLE_MISSING` 失败 —— 与 Godot 对其引擎二进制的诚实契约一致。

**帧捕获走浏览器 CLI，而非驱动库。** 随包发布的 `assets/web-serve.mjs` 探针（Godot `.gd` 探针的 web 对应物）在临时回环端口上服务构建产物并打印一行 `WEB_SERVE_URL <origin>`；provider 轮询到它后，spawn 配置好的 Chromium 系浏览器执行 `--headless --disable-gpu --hide-scrollbars --window-size=WxH --screenshot=<path> <origin>/<scenePath>`，随后拆掉服务器、校验 PNG magic 与 IHDR 块、报告从文件本身读出的像素尺寸。零驱动依赖、在测试里与 Godot shim 完全同构地可 shim 化，`browserArgvPrefix`/`browserExtraArgs` 配置让包装器形态与预热预算（`--virtual-time-budget`）保持声明式。

**场景/资产查询是文本启发式，与 Godot 后端同等诚实。** HTML 文档解析为 `Document` 根加 script/stylesheet/带 id 元素子节点（只看声明标记，绝不是运行时 DOM）；资产按扩展名归入共享 kind 词汇表，模块解析 `export class X extends Y` 头。`exportPreset` 被直接拒绝 —— 构建脚本与 Vite mode 拥有产物 —— 而不是静默忽略。

## Testing

`packages/game/game-runtime-web/tests/web-runtime.spec.ts`（19 个测试）经真实 subprocess seam 驱动真实运行时：spec 解析形态（run/build argv、默认值、拒绝分支）、经伪造的项目本地 Vite 入口的真实构建（零退出结果、非零退出结果、缺 Vite 的 `GAME_EXECUTABLE_MISSING`）、预览进程生命周期（日志标记、terminate、exited 状态）、HTML 场景解析及其失败 code、资产分类/头/缺失/越界用例，以及「真实 serve 探针 + 浏览器 shim」的捕获回路（1x1 PNG magic、相对路径解析、浏览器失败与无构建产物分支、空路径拒绝），加上插件接线（以 `web` 注册、经注册表可解析）。

## Alternatives considered

**spawn `npm run build`。** 地道的 npm 手势，但它在 Windows 上解析到 `.cmd` shim，Node 无法直接 spawn；包一层 `cmd.exe /c` 又把引号规则拖进 spec。否决：驱动 `node vite.js` 无 shell 且跨平台。

**Playwright/puppeteer 做捕获（以及之后的输入）。** 控制力更强（等选择器、CDP 输入），也是 M4 的自然实现基底 —— 但那会让 harness 替每个部署持有一张浏览器下载依赖图。M6 否决：CLI 截图已覆盖观察回路；若试玩回路需要等选择器或事件注入，M4 再评估驱动 seam。

**对运行中的预览服务器截图。** 复用 `game_run` 的进程，但 `CaptureSpec` 不携带进程关联，且把捕获耦合到存活运行上会让观察回路变成两段式。否决：自包含的临时 serve 让 `game_capture_frame` 保持单发，与 Godot 探针对齐。

## Consequences

- web 游戏以 `engine: "web"` 加入注册表，模型可见表面零新增：既有六个工具原样触达。
- `web` 引擎除 node 与（捕获时的）Chromium 系浏览器外无需全局安装；工程工具链留在工程内。
- 首帧捕获与无输入投递记录为 Known Limitations 而非意外；`browserExtraArgs` 是文档化的预热杠杆。
- serve 探针加入 `assets/`，与 Godot 探针并列 —— 相同的探针契约形态（`<PREFIX>_RESULT` 式 stdout 行）、相同的 files 白名单待遇。
