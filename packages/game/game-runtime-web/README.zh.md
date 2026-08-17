# @deepseek-ai/dsh-game-runtime-web

[English](README.md) | 中文

DeepSeek Harness 游戏运行时 seam（`ctx.gameRuntimes`）的 Web 引擎后端。provider 是项目自带本地 Vite 安装与 Chromium 系浏览器之上的门面，二者都经 `ctx.subprocess` spawn —— 它不 fork 任何引擎代码。Vite 形态的 npm 项目（Vite/PixiJS、Phaser、纯 canvas……）经 `node <project>/node_modules/vite/bin/vite.js` 构建与预览，帧捕获用浏览器的 headless `--screenshot` 模式对构建产物截图。

## 注册

插件把 `{ engine: 'web', runtime: WebRuntime }` 注册进 `ctx.gameRuntimes`；销毁即注销（并经注册表终止此后端启动的全部进程）。可与 Godot 后端并列（或替代）组合；每个模型可见的游戏工具随后以 `engine: "web"` 触达 web 引擎（或由部署将 `defaultEngine` 固定为 `web`）。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `nodeExecutable` | 本进程的 node | 驱动 Vite 与 serve 探针；绝对路径。 |
| `browserExecutable` | `'chrome'` | 帧捕获浏览器：绝对路径或裸 PATH 名；spawn 时经 `ctx.subprocess.resolveExecutable` 解析。 |
| `browserArgvPrefix` | `[]` | 紧跟在浏览器可执行文件之后、捕获旗标之前插入的参数（测试中的 Node 浏览器 shim）。 |
| `browserExtraArgs` | `[]` | 追加在捕获 URL 之前的额外浏览器参数（如 `--virtual-time-budget=3000` 让游戏渲染过首帧）。 |
| `outputDir` | `'dist'` | 项目内的构建产物目录；也是捕获的 serving 根。 |
| `previewPort` | `4173` | `game_run` 预览服务器端口（`--port`、`--strictPort`）。 |
| `captureWidth` / `captureHeight` | `1280` / `720` | 默认捕获视口；逐调用 `width`/`height` 优先。 |
| `graceMs` | `5000` | spawn 进程树的终止宽限期。 |
| `maxLogBytes` | `262144` | 每流内存日志上限（超出保留尾部）。 |

运维覆盖从组合层喂进这些同名字段，没有隐藏的优先级链。

## Web 项目契约

- **引擎二进制**：`node <project>/node_modules/vite/bin/vite.js` —— 项目自带的本地 Vite。provider 从不 spawn 包管理器 CLI（避开 Windows 的 `.cmd` 坑）；没有本地 Vite 的项目每次构建/运行都以 `GAME_EXECUTABLE_MISSING` 失败（先安装）。
- **运行**：`vite preview --port <port> --strictPort [args...]` —— 服务构建产物；进程持续运行直至被终止。
- **构建**：`vite build [args...]`（默认产物 `<project>/<outputDir>`）。`exportPreset` 被拒绝（`GAME_INVALID_REQUEST`）：构建脚本拥有产物；额外目标以 Vite mode 经 args 接入。
- **场景查询**：基于文件系统、不 spawn 引擎 —— HTML 文档（默认 `index.html`）按文本解析为 `Document` 根，`script`（src）、`stylesheet`（href）与带 `id` 的结构元素（`canvas`/`div`……）为子节点。这是覆盖**声明**标记的、文档化的文本启发式，不是运行时 DOM。
- **资产查询**：基于文件系统、不 spawn 引擎 —— 存在性/大小、按扩展名派生的 `kind`（`html`→`scene`、`ts/js/...`→`script`、图片→`texture`、`glsl/vert/frag/wgsl`→`shader`……），以及从模块文本解析的 `export class X extends Y` 头。
- **帧捕获**：随包提供的 `assets/web-serve.mjs` 探针在临时回环端口上服务 `<outputDir>` 并打印一行 `WEB_SERVE_URL <origin>`；浏览器随后运行 `--headless --disable-gpu --hide-scrollbars --window-size=WxH --screenshot=<path> <origin>/<scenePath>`。provider 校验 PNG 并从 IHDR 块读取尺寸；输出目录缺失时创建。失败以 `GAME_CAPTURE_FAILED` 呈现。
- 项目路径必须指向已存在的目录（否则 `GAME_INVALID_REQUEST`）。引擎非零退出是构建结果（`ok: false`），不是 rejection。

## Model Experience

间接，经由模型可见的游戏工具（`dsh-tool-game`），它们渲染此后端的构建、运行、引擎日志、场景/资产查询与帧捕获；provider 自身不注册任何 prompt、schema 或结果文本。

#### KV Cache effect

无直接失效；具名 consumer 拥有任何请求前缀变更。

## Known Limitations and Deferred Work

- **捕获需要 Chromium 系浏览器** —— `--headless --screenshot` 即捕获机制；未安装（或未配置）浏览器时以 `GAME_EXECUTABLE_MISSING` 失败。
- **捕获是首帧** —— 默认截图不带预热预算；异步渲染的游戏应设置 `browserExtraArgs: ['--virtual-time-budget=3000']` 之类。
- **输入投递未实现** —— `sendInput` 抛出 `GAME_CAPABILITY_UNAVAILABLE`；它随 M4 里程碑落地。
- **项目必须是 Vite 形态** —— 引擎是项目的本地 `node_modules/vite/bin/vite.js`；非 Vite 的 web 项目（纯静态站、webpack）无法构建或运行，但资产/场景查询仍可用。
- **没有导出预设** —— `exportPreset` 被拒绝；构建脚本与 Vite mode 拥有产物。
- **场景查询是文本启发式** —— 解析器按文本读取 HTML；页面运行时创建的标记不可见，特殊属性顺序可能只被部分解析。
- **预览端口由配置固定** —— `game_run` 以 `--strictPort` 使用 `previewPort`；端口被占时运行响亮失败而非迁移。
